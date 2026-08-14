"""Contact Directory REST API (task 08-13 WP2).

镜像 `src/api/routers/matters.py` 的门卫/信封形状; 写操作全部走
`src/contacts/service.py` 的域函数 (写侧单源纪律, router 不裸写 UPDATE)。
列表是**一条聚合 SQL** (设计 §7 性能铁律: 行字段一次给齐, 禁逐行取数)。
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.api.schemas.contacts import (
    ContactFormerEmailRequest,
    ContactHideRequest,
    ContactKindRequest,
    ContactLockRequest,
    ContactMergeRequest,
    ContactPatchRequest,
    ContactPrimaryEmailRequest,
    ContactSelfRequest,
)
from src.contacts import service as contact_service
from src.contacts.repository import ContactRepository
from src.contacts.scanner import WATERMARK_KEY
from src.contacts.service import ContactError

VIEW_VALUES = ("known", "all")
SORT_VALUES = ("density", "recent", "name")
#: 关联邮件角色过滤 (API 契约) → 账本 role 值。
MAIL_ROLE_MAP = {"from": "sender", "to": "to", "cc": "cc"}


def require_contacts_enabled(settings=Depends(get_settings)) -> None:
    if not bool(getattr(settings, "contacts_enabled", False)):
        raise APIError(
            "E_DISABLED", "Contact directory feature is disabled", source="sqlite"
        )


def get_contact_repository(settings=Depends(get_settings)) -> ContactRepository:
    return ContactRepository(settings.sync_store_db_path)


router = APIRouter(
    prefix="/api/contacts",
    tags=["contacts"],
    dependencies=[Depends(verify_cf_access), Depends(require_contacts_enabled)],
)


def _call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    try:
        return fn(*args, **kwargs)
    except ContactError as exc:
        hint = None
        if exc.code == "E_PRIMARY_EMAIL_CANNOT_BE_FORMER":
            hint = "先把另一个地址设为主邮箱，再把这个地址标为曾用"
        raise APIError(exc.code, exc.message, hint=hint, source="sqlite") from exc


def _now_ms() -> int:
    return int(time.time() * 1000)


def _like_pattern(term: str) -> str:
    escaped = (
        term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    )
    return f"%{escaped}%"


def _json_list(raw: Any) -> list:
    try:
        data = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _json_dict(raw: Any) -> dict:
    try:
        data = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


# ---- backfill progress (🔴 必须排在 /{contact_id} 之前, 否则被 int 路径吃掉) ----


@router.get("/backfill/progress")
async def backfill_progress(
    request: Request,
    repo: ContactRepository = Depends(get_contact_repository),
):
    """扫描进度 = watermark 覆盖的 email_metadata 行数 / 总行数 (廉价查询)。"""
    conn = repo.connect()
    try:
        row = conn.execute(
            "SELECT value FROM sync_state WHERE key=?", (WATERMARK_KEY,)
        ).fetchone()
        try:
            watermark = int(row[0]) if row else 0
        except (TypeError, ValueError):
            watermark = 0
        total = int(
            conn.execute("SELECT COUNT(*) FROM email_metadata").fetchone()[0]
        )
        scanned = int(
            conn.execute(
                "SELECT COUNT(*) FROM email_metadata WHERE internal_id <= ?",
                (watermark,),
            ).fetchone()[0]
        )
    finally:
        conn.close()
    return success_envelope(
        {"scanned": scanned, "total": total, "drained": scanned >= total},
        request=request,
    )


# ---- 列表 (一条聚合 SQL) ----


@router.get("")
async def list_contacts(
    request: Request,
    view: str = Query("known"),
    q: Optional[str] = Query(None),
    sort: str = Query("density"),
    repo: ContactRepository = Depends(get_contact_repository),
):
    if view not in VIEW_VALUES:
        raise APIError(
            "E_INVALID_ARG", f"view must be one of {VIEW_VALUES}", source="sqlite"
        )
    if sort not in SORT_VALUES:
        raise APIError(
            "E_INVALID_ARG", f"sort must be one of {SORT_VALUES}", source="sqlite"
        )

    where = ["c.merged_into IS NULL"]
    params: list[Any] = []
    if view == "known":
        # 设计 §2.1 默认视图: 双向往来的人 (机器人/单向广播/自己/隐藏全排除)。
        where.append(
            "c.kind = 'person' AND c.hidden_at IS NULL "
            "AND c.is_self = 0 AND c.sent_to_count > 0"
        )
    term = (q or "").strip()
    if term:
        pattern = _like_pattern(term)
        where.append(
            "(c.display_name LIKE ? ESCAPE '\\' "
            "OR c.name_en LIKE ? ESCAPE '\\' "
            "OR c.organization LIKE ? ESCAPE '\\' "
            "OR c.name_variants_json LIKE ? ESCAPE '\\' "
            "OR EXISTS (SELECT 1 FROM contact_email qe "
            "  WHERE qe.contact_id = c.id AND qe.email_normalized LIKE ? ESCAPE '\\'))"
        )
        params.extend([pattern] * 5)

    order = {
        # SQLite DESC 天然把 NULL 排最后 (NULL 视为最小), 不需要 NULLS LAST。
        "density": "c.sent_to_count DESC, c.mail_count DESC, c.last_seen_at DESC",
        "recent": "c.last_seen_at DESC, c.mail_count DESC",
        "name": "COALESCE(c.display_name, primary_email) COLLATE NOCASE ASC, c.id ASC",
    }[sort]

    sql = (
        "SELECT c.id, c.display_name, c.name_en, c.organization, c.department, "
        "  c.role_title, c.function, c.seniority, c.kind, c.hidden_at, c.is_self, "
        "  c.mail_count, c.sent_to_count, c.first_seen_at, c.last_seen_at, "
        "  COUNT(ce.id) AS email_count, "
        "  COALESCE(MAX(CASE WHEN ce.is_primary = 1 THEN ce.email_normalized END), "
        "    MIN(ce.email_normalized)) AS primary_email "
        "FROM contact c "
        "LEFT JOIN contact_email ce ON ce.contact_id = c.id "
        f"WHERE {' AND '.join(where)} "
        "GROUP BY c.id "
        f"ORDER BY {order}"
    )
    conn = repo.connect()
    try:
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    items = [
        {
            **{key: row[key] for key in row.keys()},
            "is_self": bool(row["is_self"]),
            # WP6 画像期接真值; WP2 恒 null 占位 (行契约先钉住)。
            "profile_summary": None,
        }
        for row in rows
    ]
    return success_envelope(
        {"items": items, "total": len(items)}, request=request
    )


# ---- 详情 ----


def _load_detail(conn: sqlite3.Connection, contact_id: int) -> dict:
    row = conn.execute(
        "SELECT * FROM contact WHERE id=?", (contact_id,)
    ).fetchone()
    if row is None:
        raise ContactError("E_CONTACT_NOT_FOUND", f"contact {contact_id} not found")
    emails = [
        {
            "address": e["email_normalized"],
            "is_primary": bool(e["is_primary"]),
            "former_at": e["former_at"],
            "mail_count": e["mail_count"],
            "first_seen_at": e["first_seen_at"],
            "last_seen_at": e["last_seen_at"],
        }
        for e in conn.execute(
            "SELECT * FROM contact_email WHERE contact_id=? "
            "ORDER BY is_primary DESC, mail_count DESC, id ASC",
            (contact_id,),
        )
    ]
    contact_info = _json_dict(row["contact_info_json"])
    return {
        "id": row["id"],
        "display_name": row["display_name"],
        "name_en": row["name_en"],
        "organization": row["organization"],
        "department": row["department"],
        "role_title": row["role_title"],
        "function": row["function"],
        "seniority": row["seniority"],
        "kind": row["kind"],
        "kind_locked_at": row["kind_locked_at"],
        "is_self": bool(row["is_self"]),
        "hidden_at": row["hidden_at"],
        "merged_into": row["merged_into"],
        "notes": row["notes"],
        "phone": contact_info.get("phone"),
        "contact_info": contact_info,
        "name_variants": _json_list(row["name_variants_json"]),
        "identity_locks": contact_service.parse_identity_locks(
            row["identity_locks_json"]
        ),
        "mail_count": row["mail_count"],
        "sent_to_count": row["sent_to_count"],
        "first_seen_at": row["first_seen_at"],
        "last_seen_at": row["last_seen_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "emails": emails,
        # WP6 画像期接真值; WP2 恒 null (画像卡只有「未开启」引导态)。
        "profile": None,
    }


@router.get("/{contact_id}")
async def get_contact(
    request: Request,
    contact_id: int,
    repo: ContactRepository = Depends(get_contact_repository),
):
    conn = repo.connect()
    try:
        detail = _call(_load_detail, conn, contact_id)
    finally:
        conn.close()
    return success_envelope(detail, request=request)


# ---- 关联邮件 ----


@router.get("/{contact_id}/mails")
async def list_contact_mails(
    request: Request,
    contact_id: int,
    role: str = Query("all"),
    cursor: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    repo: ContactRepository = Depends(get_contact_repository),
):
    if role != "all" and role not in MAIL_ROLE_MAP:
        raise APIError(
            "E_INVALID_ARG",
            f"role must be 'all' or one of {tuple(MAIL_ROLE_MAP)}",
            source="sqlite",
        )
    cursor_pair: Optional[tuple[int, int]] = None
    if cursor:
        try:
            ts, row_id = cursor.split(":", 1)
            cursor_pair = (int(ts), int(row_id))
        except (TypeError, ValueError) as exc:
            raise APIError(
                "E_INVALID_ARG", "cursor must be '<timestamp>:<id>'", source="sqlite"
            ) from exc

    role_sql = ""
    params: list[Any] = [contact_id]
    if role != "all":
        role_sql = "AND l.role = ? "
        params.append(MAIL_ROLE_MAP[role])
    base = (
        "FROM contact_email_link l "
        "JOIN contact_email ce ON ce.id = l.email_id "
        "JOIN email_metadata m ON m.internal_id = l.internal_id "
        f"WHERE ce.contact_id = ? {role_sql}"
    )
    having = ""
    item_params = list(params)
    if cursor_pair:
        having = (
            "HAVING (COALESCE(MAX(l.seen_at), 0) < ? "
            "OR (COALESCE(MAX(l.seen_at), 0) = ? AND m.internal_id < ?)) "
        )
        item_params.extend([cursor_pair[0], cursor_pair[0], cursor_pair[1]])
    sql = (
        "SELECT m.internal_id, m.subject, m.sender, m.sender_name, m.mailbox, "
        "  m.date_received, m.is_read, "
        "  COALESCE(MAX(l.seen_at), 0) AS seen_at, "
        "  GROUP_CONCAT(DISTINCT l.role) AS roles "
        f"{base}"
        "GROUP BY m.internal_id "
        f"{having}"
        "ORDER BY seen_at DESC, m.internal_id DESC "
        "LIMIT ?"
    )
    item_params.append(limit + 1)
    conn = repo.connect()
    try:
        # 联系人必须存在 (404 语义, 不给空列表装没事)。
        _call(contact_service._require_contact, conn, contact_id)
        rows = conn.execute(sql, item_params).fetchall()
        total = int(
            conn.execute(
                f"SELECT COUNT(DISTINCT m.internal_id) {base}", params
            ).fetchone()[0]
        )
    finally:
        conn.close()

    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [
        {
            "internal_id": row["internal_id"],
            "subject": row["subject"],
            "sender": row["sender"],
            "sender_name": row["sender_name"],
            "mailbox": row["mailbox"],
            "date_received": row["date_received"],
            "is_read": bool(row["is_read"]),
            "seen_at": row["seen_at"] or None,
            "roles": sorted((row["roles"] or "").split(",")) if row["roles"] else [],
        }
        for row in rows
    ]
    next_cursor = (
        f"{rows[-1]['seen_at'] or 0}:{rows[-1]['internal_id']}"
        if has_more and rows else None
    )
    return success_envelope(
        {"items": items, "next_cursor": next_cursor, "total": total},
        request=request,
    )


# ---- 关联事项 ----


@router.get("/{contact_id}/matters")
async def list_contact_matters(
    request: Request,
    contact_id: int,
    repo: ContactRepository = Depends(get_contact_repository),
):
    conn = repo.connect()
    try:
        _call(contact_service._require_contact, conn, contact_id)
        rows = conn.execute(
            "SELECT ms.matter_id, ms.role, m.public_id, m.title, m.status, "
            "  m.archived_at "
            "FROM matter_stakeholder ms "
            "JOIN matter m ON m.id = ms.matter_id "
            "WHERE ms.contact_id = ? AND ms.deleted_at IS NULL "
            "  AND m.deleted_at IS NULL "
            "ORDER BY m.updated_at DESC",
            (contact_id,),
        ).fetchall()
    finally:
        conn.close()
    items = [
        {
            "matter_id": row["matter_id"],
            "public_id": row["public_id"],
            "title": row["title"],
            "status": row["status"],
            "role": row["role"],
            "archived_at": row["archived_at"],
        }
        for row in rows
    ]
    return success_envelope({"items": items}, request=request)


# ---- 身份字段编辑 + 字段级锁 ----


@router.patch("/{contact_id}")
async def patch_contact(
    request: Request,
    contact_id: int,
    body: ContactPatchRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise APIError(
            "E_INVALID_ARG", "no fields provided", source="sqlite"
        )
    now = _now_ms()
    with repo.transaction() as conn:
        result = _call(
            contact_service.update_identity_fields,
            conn, contact_id, fields, now=now,
        )
        detail = _call(_load_detail, conn, contact_id)
    return success_envelope(
        {"fields": result["fields"], "locks": result["locks"], "contact": detail},
        request=request,
    )


@router.post("/{contact_id}/locks")
async def set_contact_lock(
    request: Request,
    contact_id: int,
    body: ContactLockRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        locks = _call(
            contact_service.set_field_lock,
            conn, contact_id, body.field, locked=body.locked, now=_now_ms(),
        )
    return success_envelope({"locks": locks}, request=request)


# ---- 治理写面 (service 既有守卫的薄端点) ----


@router.post("/{contact_id}/hide")
async def hide_contact(
    request: Request,
    contact_id: int,
    body: ContactHideRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        _call(
            contact_service.hide_contact,
            conn, contact_id, hidden=body.hidden, now=_now_ms(),
        )
    return success_envelope({"hidden": body.hidden}, request=request)


@router.post("/{contact_id}/kind")
async def set_contact_kind(
    request: Request,
    contact_id: int,
    body: ContactKindRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        _call(
            contact_service.set_kind, conn, contact_id, body.kind, now=_now_ms(),
        )
    return success_envelope({"kind": body.kind}, request=request)


@router.post("/{contact_id}/self")
async def set_contact_self(
    request: Request,
    contact_id: int,
    body: ContactSelfRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        _call(
            contact_service.set_is_self,
            conn, contact_id, is_self=body.is_self, now=_now_ms(),
        )
    return success_envelope({"is_self": body.is_self}, request=request)


@router.post("/{contact_id}/merge")
async def merge_contact(
    request: Request,
    contact_id: int,
    body: ContactMergeRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    """人级合并 (WP3): contact_id = winner。邮箱锚点/stakeholder/manager 引用
    改指保留方、账本零搬、loser 落墓碑, 全在 service 一个事务里 (失败 = 两条
    记录都未改动)。成功返回 winner 详情 (前端 toast 用 emails 数)。"""
    now = _now_ms()
    with repo.transaction() as conn:
        _call(
            contact_service.merge_contacts,
            conn, contact_id, body.loser_id, now=now,
            primary_email=body.primary_email,
            former_emails=body.former_emails,
        )
        detail = _call(_load_detail, conn, contact_id)
    return success_envelope(detail, request=request)


@router.post("/{contact_id}/emails/primary")
async def set_contact_primary_email(
    request: Request,
    contact_id: int,
    body: ContactPrimaryEmailRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        _call(
            contact_service.set_primary_email,
            conn, contact_id, body.email, now=_now_ms(),
        )
    return success_envelope({"primary_email": body.email}, request=request)


@router.post("/{contact_id}/emails/former")
async def set_contact_email_former(
    request: Request,
    contact_id: int,
    body: ContactFormerEmailRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    fn = (
        contact_service.mark_email_former
        if body.former else contact_service.unmark_email_former
    )
    with repo.transaction() as conn:
        _call(fn, conn, contact_id, body.email, now=_now_ms())
    return success_envelope(
        {"email": body.email, "former": body.former}, request=request
    )
