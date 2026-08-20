"""Contact Directory REST API (task 08-13 WP2).

镜像 `src/api/routers/matters.py` 的门卫/信封形状; 写操作全部走
`src/contacts/service.py` 的域函数 (写侧单源纪律, router 不裸写 UPDATE)。
列表是**一条聚合 SQL** (设计 §7 性能铁律: 行字段一次给齐, 禁逐行取数)。
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, Header, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.api.schemas.contacts import (
    ContactFormerEmailRequest,
    ContactHideRequest,
    ContactKindRequest,
    ContactLockRequest,
    ContactManagerRequest,
    ContactMergeRequest,
    ContactPatchRequest,
    ContactPrimaryEmailRequest,
    ContactProfileSuggestionAdoptRequest,
    ContactProfileSuggestionIgnoreRequest,
    ContactResolveRequest,
    ContactSelfRequest,
)
from src.contacts import service as contact_service
from src.contacts import profile as contact_profile
from src.contacts import governance as contact_governance
from src.contacts.profile_config import get_contact_profile_agent_config
from src.contacts.repository import ContactRepository
from src.contacts.scanner import WATERMARK_KEY
from src.contacts.service import ContactError
from src.contacts.taxonomy import CONTACT_KIND_PERSON

VIEW_VALUES = ("known", "all")
SORT_VALUES = ("density", "recent", "name")
#: 关联邮件的方向三分 (task 08-14 WP-5, API 契约; 取代 v58 前的 role 过滤)。
#: 一封邮件对一个联系人**只有一个**方向, 三类互斥 —— 老 role 轴下同一封邮件可能
#: 同时出现在 to 与 cc 两个 tab, 且「对方是 to/cc」被当成「我发出的」(活库实测
#: 178,046 条第三方邮件被误标, 详情页「发至」里 98% 是错的)。
MAIL_DIRECTION_VALUES = ("all", "from_them", "from_me", "from_third")
PROFILE_SUGGESTION_FIELDS = ("formal_name", "department", "phone")
_profile_tasks: set = set()


def _schedule_profile_task(coro) -> None:
    task = asyncio.create_task(coro)
    _profile_tasks.add(task)
    task.add_done_callback(_profile_tasks.discard)


def require_contacts_enabled(settings=Depends(get_settings)) -> None:
    if not bool(getattr(settings, "contacts_enabled", False)):
        raise APIError(
            "E_DISABLED", "Contact directory feature is disabled", source="sqlite"
        )


def require_contact_agent_enabled(settings=Depends(get_settings)) -> None:
    if not bool(getattr(settings, "contact_agent_enabled", False)):
        raise APIError(
            "E_DISABLED", "Contact governance agent is disabled", source="sqlite"
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


@router.get("/suggestions", dependencies=[Depends(require_contact_agent_enabled)])
async def list_governance_suggestions(
    request: Request,
    status: str = Query("pending"),
    limit: int = Query(50, ge=1, le=100),
    cursor: Optional[str] = Query(None),
    repo: ContactRepository = Depends(get_contact_repository),
):
    cursor_pair = None
    if cursor:
        try:
            created_at, suggestion_id = cursor.split(":", 1)
            cursor_pair = (int(created_at), int(suggestion_id))
        except (TypeError, ValueError) as exc:
            raise APIError(
                "E_INVALID_ARG", "cursor must be '<timestamp>:<id>'", source="sqlite"
            ) from exc
    conn = repo.connect()
    try:
        result = _call(
            contact_governance.list_suggestions,
            conn,
            status=status,
            limit=limit,
            cursor=cursor_pair,
        )
    finally:
        conn.close()
    return success_envelope(result, request=request)


@router.post(
    "/suggestions/{suggestion_id}/adopt",
    dependencies=[Depends(require_contact_agent_enabled)],
)
async def adopt_governance_suggestion(
    suggestion_id: int,
    request: Request,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        # _call: E_NOT_FOUND / E_INVALID_STATE 这类 adopt 前置校验直抛 ContactError，
        # 不包则落 app.py 兜底 500，错误码到不了界面（blocked 路径在 governance 内部
        # catch，不经这里）。
        result = _call(
            contact_governance.adopt_suggestion, conn, suggestion_id, now_ms=_now_ms()
        )
    error = result.pop("error", None)
    if error:
        raise APIError(error["code"], error["message"], source="sqlite")
    return success_envelope(result, request=request)


@router.post(
    "/suggestions/{suggestion_id}/ignore",
    dependencies=[Depends(require_contact_agent_enabled)],
)
async def ignore_governance_suggestion(
    suggestion_id: int,
    request: Request,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        result = _call(
            contact_governance.ignore_suggestion,
            conn,
            suggestion_id,
            now_ms=_now_ms(),
        )
    return success_envelope(result, request=request)


@router.post("/agent/run", dependencies=[Depends(require_contact_agent_enabled)])
async def run_contact_governance(
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    settings=Depends(get_settings),
):
    from src.sync.async_jobs import AsyncJobRepository

    day = time.strftime("%Y-%m-%d", time.localtime())
    key = idempotency_key or f"contact_governance:manual:{day}"
    result = contact_governance.enqueue_governance_job(
        AsyncJobRepository(settings.sync_store_db_path),
        trigger_kind="manual",
        idempotency_key=key,
    )
    return success_envelope(result, request=request)


@router.get("/agent/status", dependencies=[Depends(require_contact_agent_enabled)])
async def contact_governance_status(
    request: Request,
    repo: ContactRepository = Depends(get_contact_repository),
    settings=Depends(get_settings),
):
    conn = repo.connect()
    try:
        pending = int(
            conn.execute(
                "SELECT COUNT(*) FROM contact_suggestion WHERE status='pending'"
            ).fetchone()[0]
        )
        marker = conn.execute(
            "SELECT value FROM sync_state WHERE key=?",
            (contact_governance.CONTACT_GOVERNANCE_FIRE_KEY,),
        ).fetchone()
        latest = conn.execute(
            "SELECT created_at, status, last_error FROM async_jobs WHERE job_type=? "
            "ORDER BY job_id DESC LIMIT 1",
            (contact_governance.CONTACT_GOVERNANCE_JOB_TYPE,),
        ).fetchone()
    finally:
        conn.close()
    return success_envelope(
        {
            "enabled": bool(settings.contacts_enabled and settings.contact_agent_enabled),
            "pending_count": pending,
            "last_fire_day": marker[0] if marker else None,
            "last_scan_at": latest[0] if latest else None,
            "last_scan_status": latest[1] if latest else None,
            "last_scan_error": latest[2] if latest else None,
        },
        request=request,
    )


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


# ---- 批量精确解析 (WP4 互链: 邮件详情头 → PersonChip) ----

#: 单次 resolve 的地址数上限 (邮件详情头一封邮件的 from/to/cc 集合远小于此)。
RESOLVE_MAX_EMAILS = 100


@router.post("/resolve")
async def resolve_contacts(
    request: Request,
    body: ContactResolveRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    """按归一 email **精确**匹配 contact_email 锚点, 批量返回 chip 最小集。

    - 键 = 调用方的**原输入串** (未命中/非法形状 = null); 归一走
      `contact_service.normalize_email` 单源 (禁自写 lower/strip)。
    - 不过滤 hidden/self/robot —— 「在库」判据就是 contact_email 有行
      (人物页对隐藏行也能打开, chip 跳转同理)。
    - 之所以不用 `GET /contacts?q=`: LIKE 两端通配假阳 (a@x.com 命中
      a@x.com.cn) + N 地址 N 请求 + ContactRowDto 无 emails 数组无法判等。
    """
    if len(body.emails) > RESOLVE_MAX_EMAILS:
        raise APIError(
            "E_INVALID_ARG",
            f"emails must contain at most {RESOLVE_MAX_EMAILS} entries",
            source="sqlite",
        )
    normalized_by_input = {
        raw: contact_service.normalize_email(raw) for raw in body.emails
    }
    wanted = sorted({n for n in normalized_by_input.values() if n is not None})
    chip_by_email: dict[str, dict] = {}
    if wanted:
        placeholders = ",".join("?" * len(wanted))
        sql = (
            "SELECT ce.email_normalized AS q_email, c.id, c.display_name, "
            "  c.formal_name, c.kind, "
            "  (SELECT COALESCE(MAX(CASE WHEN pe.is_primary = 1 "
            "      THEN pe.email_normalized END), MIN(pe.email_normalized)) "
            "   FROM contact_email pe WHERE pe.contact_id = c.id) AS primary_email "
            "FROM contact_email ce "
            "JOIN contact c ON c.id = ce.contact_id "
            f"WHERE ce.email_normalized IN ({placeholders})"
        )
        conn = repo.connect()
        try:
            for row in conn.execute(sql, wanted):
                chip_by_email[row["q_email"]] = {
                    "id": row["id"],
                    "display_name": row["display_name"],
                    "formal_name": row["formal_name"],
                    "kind": row["kind"],
                    "primary_email": row["primary_email"],
                }
        finally:
            conn.close()
    items = {
        raw: (chip_by_email.get(norm) if norm else None)
        for raw, norm in normalized_by_input.items()
    }
    return success_envelope({"items": items}, request=request)


# ---- 列表 (一条聚合 SQL) ----


@router.get("")
async def list_contacts(
    request: Request,
    view: str = Query("known"),
    q: Optional[str] = Query(None),
    sort: str = Query("density"),
    limit: Optional[int] = Query(None),
    repo: ContactRepository = Depends(get_contact_repository),
    settings=Depends(get_settings),
):
    if view not in VIEW_VALUES:
        raise APIError(
            "E_INVALID_ARG", f"view must be one of {VIEW_VALUES}", source="sqlite"
        )
    if sort not in SORT_VALUES:
        raise APIError(
            "E_INVALID_ARG", f"sort must be one of {SORT_VALUES}", source="sqlite"
        )
    # WP4 (⌘K 「人」组): 排序后截断 items; total 仍为全量命中数 (供「+n more」)。
    # 缺省不传 = 现行为字节级不变 (有测试断言)。
    if limit is not None and limit <= 0:
        raise APIError(
            "E_INVALID_ARG", "limit must be a positive integer", source="sqlite"
        )

    where = ["c.merged_into IS NULL"]
    params: list[Any] = []
    if view == "known":
        # 设计 §2.1 默认视图: 双向往来的人 (机器人/单向广播/隐藏/「我」排除)。
        # 🔴 task 08-14 WP-6 B: 「我」重新排除 —— WP-3 曾给它开 carve-out
        # (`is_self = 1 OR …`), 那是把 owner 的「我不希望自己从通讯录消失」误读成
        # 「每个视图都要能看到自己」。owner 复核: 这个 tab 叫「往来的人」, 自己不是
        # 往来对象; 「全部」视图天然含「我」(只过滤 merged_into), 找自己去那边。
        where.append(
            "c.hidden_at IS NULL AND c.is_self = 0 "
            "AND c.kind = 'person' AND c.sent_to_count > 0"
        )
    term = (q or "").strip()
    if term:
        pattern = _like_pattern(term)
        where.append(
            "(c.display_name LIKE ? ESCAPE '\\' "
            "OR c.formal_name LIKE ? ESCAPE '\\' "
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
        "SELECT c.id, c.display_name, c.formal_name, c.organization, c.department, "
        "  c.role_title, c.function, c.seniority, c.kind, c.hidden_at, c.is_self, "
        "  c.mail_count, c.sent_to_count, c.first_seen_at, c.last_seen_at, "
        # WP5 汇报线: manager id + self-join 显示名 (分组 label / 行菜单可用性;
        # m 对 c 是 1:1, GROUP BY c.id 下裸列取值恒定)。
        "  c.manager_contact_id, m.display_name AS manager_display_name, c.profile_json, "
        "  COUNT(ce.id) AS email_count, "
        "  COALESCE(MAX(CASE WHEN ce.is_primary = 1 THEN ce.email_normalized END), "
        "    MIN(ce.email_normalized)) AS primary_email "
        "FROM contact c "
        "LEFT JOIN contact m ON m.id = c.manager_contact_id "
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
    total = len(rows)
    if limit is not None:
        rows = rows[:limit]
    items = [
        {
            **{key: row[key] for key in row.keys() if key != "profile_json"},
            "is_self": bool(row["is_self"]),
            "profile_summary": contact_profile.profile_summary_for_list(
                row["profile_json"]
            ),
            "profile_min": contact_profile.PROFILE_MIN,
            "profile_eligible": (
                row["hidden_at"] is None
                and row["kind"] == CONTACT_KIND_PERSON
                and int(row["mail_count"] or 0) >= contact_profile.PROFILE_MIN
                and int(row["sent_to_count"] or 0) >= 1
            ),
        }
        for row in rows
    ]
    return success_envelope(
        {"items": items, "total": total}, request=request
    )


# ---- 详情 ----

#: 联系人主邮箱 (无显式主时退化最小地址) —— resolve 端点同款相关子查询。
_PRIMARY_EMAIL_SQL = (
    "(SELECT COALESCE(MAX(CASE WHEN pe.is_primary = 1 "
    "    THEN pe.email_normalized END), MIN(pe.email_normalized)) "
    " FROM contact_email pe WHERE pe.contact_id = {alias}.id)"
)

#: 组织关系投影的行字段 (裁决 4 最小集 + primary_email/kind —— Monogram 色相
#: 锚点 = 主邮箱 (D10), 分区头「写邮件并抄送上级」需要上级主邮箱)。
_REL_FIELDS = (
    "id", "display_name", "formal_name", "organization", "role_title",
    "kind", "mail_count", "primary_email",
)


def _rel_person(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in _REL_FIELDS}


def _load_org_relations(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    """WP5 组织关系投影: manager / reports / peers (设计 §2.2.1)。

    - manager: 单行 (墓碑/隐藏也如实返回 —— 人物页对隐藏行也能打开)。
    - reports: WHERE manager_contact_id=? 反查 (🔒 只存一侧), 排除墓碑/隐藏,
      按 mail_count 降序。
    - peers: 同 organization; 双方都有 department 时才要求相同 (原型
      cdata.jsx:314-317 的 `!c.dept || !x.dept || x.dept===c.dept`); 排除
      本人/非 person/hidden/墓碑; mail_count 降序前 6。无组织 = 空。
      🔴 task 08-14 WP-3 起**不再排除 is_self** —— owner 要能把自己挂进汇报线
      («上下级也无法关联我»), 同事推荐里也就得能选到自己。
    """
    contact_id = int(row["id"])
    primary_sql = _PRIMARY_EMAIL_SQL.format(alias="r")
    manager = None
    if row["manager_contact_id"] is not None:
        manager_row = conn.execute(
            "SELECT r.id, r.display_name, r.formal_name, r.organization, "
            f"  r.role_title, r.kind, r.mail_count, {primary_sql} AS primary_email "
            "FROM contact r WHERE r.id = ?",
            (row["manager_contact_id"],),
        ).fetchone()
        if manager_row is not None:
            manager = _rel_person(manager_row)
    reports = [
        _rel_person(r)
        for r in conn.execute(
            "SELECT r.id, r.display_name, r.formal_name, r.organization, "
            f"  r.role_title, r.kind, r.mail_count, {primary_sql} AS primary_email "
            "FROM contact r "
            "WHERE r.manager_contact_id = ? AND r.merged_into IS NULL "
            "  AND r.hidden_at IS NULL "
            "ORDER BY r.mail_count DESC, r.id ASC",
            (contact_id,),
        )
    ]
    peers: list = []
    if row["organization"]:
        peers = [
            _rel_person(r)
            for r in conn.execute(
                "SELECT r.id, r.display_name, r.formal_name, r.organization, "
                f"  r.role_title, r.kind, r.mail_count, {primary_sql} AS primary_email "
                "FROM contact r "
                "WHERE r.id <> ? AND r.merged_into IS NULL "
                "  AND r.kind = 'person' "
                "  AND r.hidden_at IS NULL AND r.organization = ? "
                "  AND (? IS NULL OR r.department IS NULL OR r.department = ?) "
                "ORDER BY r.mail_count DESC, r.id ASC LIMIT 6",
                (
                    contact_id, row["organization"],
                    row["department"], row["department"],
                ),
            )
        ]
    return {"manager": manager, "reports": reports, "peers": peers}


def _load_detail(
    conn: sqlite3.Connection, contact_id: int, *, profile_enabled: bool = True
) -> dict:
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
    relations = _load_org_relations(conn, row)
    configured = contact_profile.profile_feature_configured(
        conn, env_enabled=profile_enabled
    )
    return {
        "id": row["id"],
        "display_name": row["display_name"],
        "formal_name": row["formal_name"],
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
        # WP5 组织关系 (manager_src 在 UI 是 auto 标记结构位; WP5 REST 恒 manual)。
        "manager": relations["manager"],
        "manager_src": row["manager_src"],
        "reports": relations["reports"],
        "peers": relations["peers"],
        "profile": contact_profile.profile_projection(row, configured=configured),
    }


@router.get("/{contact_id}")
async def get_contact(
    request: Request,
    contact_id: int,
    repo: ContactRepository = Depends(get_contact_repository),
    settings=Depends(get_settings),
):
    conn = repo.connect()
    try:
        detail = _call(
            _load_detail,
            conn,
            contact_id,
            profile_enabled=bool(getattr(settings, "contact_profile_enabled", False)),
        )
    finally:
        conn.close()
    return success_envelope(detail, request=request)


@router.post("/{contact_id}/profile/refresh", status_code=202)
async def refresh_contact_profile(
    request: Request,
    contact_id: int,
    repo: ContactRepository = Depends(get_contact_repository),
    settings=Depends(get_settings),
):
    if not bool(getattr(settings, "contact_profile_enabled", False)):
        raise APIError(
            "E_DISABLED", "Contact profile feature is disabled", source="sqlite"
        )
    try:
        claimed = contact_profile.claim_profile_run(str(repo.db_path), contact_id)
    except ContactError as exc:
        if exc.code == "E_CONTACT_MERGED":
            raise APIError(
                exc.code, exc.message, source="sqlite", http_status=403
            ) from exc
        raise APIError(exc.code, exc.message, source="sqlite") from exc
    if claimed:
        cfg = get_contact_profile_agent_config(str(repo.db_path))
        _schedule_profile_task(
            contact_profile.generate_contact_profile(
                str(repo.db_path),
                contact_id,
                cfg=cfg,
                user_email=getattr(settings, "user_email", ""),
                self_emails=getattr(settings, "self_emails", ""),
            )
        )
    return success_envelope(
        {"contact_id": contact_id, "status": "running", "started": claimed},
        request=request,
        status_code=202,
    )


@router.post("/{contact_id}/profile/suggestions/adopt")
async def adopt_contact_profile_suggestion(
    request: Request,
    contact_id: int,
    body: ContactProfileSuggestionAdoptRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    if body.field not in PROFILE_SUGGESTION_FIELDS:
        raise APIError(
            "E_INVALID_FIELD",
            f"field must be one of {PROFILE_SUGGESTION_FIELDS}",
            source="sqlite",
        )
    now = _now_ms()
    with repo.transaction() as conn:
        _call(
            contact_service.update_identity_fields,
            conn,
            contact_id,
            {body.field: body.value},
            now=now,
        )
        _call(
            contact_service.set_field_lock,
            conn,
            contact_id,
            body.field,
            locked=True,
            now=now,
        )
        detail = _call(_load_detail, conn, contact_id)
    return success_envelope(detail, request=request)


@router.post("/{contact_id}/profile/suggestions/ignore")
async def ignore_contact_profile_suggestion(
    request: Request,
    contact_id: int,
    body: ContactProfileSuggestionIgnoreRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    if body.field not in PROFILE_SUGGESTION_FIELDS:
        raise APIError(
            "E_INVALID_FIELD",
            f"field must be one of {PROFILE_SUGGESTION_FIELDS}",
            source="sqlite",
        )
    with repo.transaction() as conn:
        _call(
            contact_profile.ignore_profile_suggestion,
            conn,
            contact_id,
            field=body.field,
            now_ms=_now_ms(),
        )
        detail = _call(_load_detail, conn, contact_id)
    return success_envelope(detail, request=request)


# ---- 关联邮件 ----


@router.get("/{contact_id}/mails")
async def list_contact_mails(
    request: Request,
    contact_id: int,
    direction: str = Query("all"),
    cursor: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    repo: ContactRepository = Depends(get_contact_repository),
    settings=Depends(get_settings),
):
    if direction not in MAIL_DIRECTION_VALUES:
        raise APIError(
            "E_INVALID_ARG",
            f"direction must be one of {MAIL_DIRECTION_VALUES}",
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

    conn = repo.connect()
    try:
        self_addresses = contact_service.resolve_self_addresses(
            conn,
            user_email=getattr(settings, "user_email", ""),
            extra_raw=getattr(settings, "self_emails", ""),
        )
        page = _call(
            contact_service.list_contact_mail_rows,
            conn,
            contact_id,
            self_addresses=self_addresses,
            direction=direction,
            cursor_pair=cursor_pair,
            limit=limit,
        )
    finally:
        conn.close()

    rows = page["rows"]
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
            # roles 保留: 方向轴之外, cc 降级为行内次要标记 (owner 拍板 A 方案 ——
            # 「谁发的」与「to/cc」是正交两维, cc 不再占 tab 轴)。
            "roles": sorted((row["roles"] or "").split(",")) if row["roles"] else [],
            "direction": row["direction"],
        }
        for row in rows
    ]
    return success_envelope(
        {"items": items, "next_cursor": page["next_cursor"], "total": page["total"]},
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
    """标/取消「我」。🔴 单选 (task 08-14 WP-3): 标新的自动清掉旧的, 库里恒最多
    一条 is_self=1 —— 引导只按 USER_EMAIL 标一次, 之后一切以「我」那条为准。"""
    with repo.transaction() as conn:
        _call(
            contact_service.set_is_self,
            conn, contact_id, is_self=body.is_self, now=_now_ms(),
        )
    return success_envelope({"is_self": body.is_self}, request=request)


@router.post("/{contact_id}/manager")
async def set_contact_manager(
    request: Request,
    contact_id: int,
    body: ContactManagerRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    """组织关系 (WP5): 指定/解除上级。🔒 只存一侧 —— 「添加下级」= 前端对下级
    那行调本端点。src 恒 'manual' (auto 是 WP6/WP7 建议采纳链路, 本面不暴露)。
    成功返回本人详情 (manager/reports/peers 投影就地刷新)。"""
    now = _now_ms()
    with repo.transaction() as conn:
        _call(
            contact_service.set_manager,
            conn, contact_id, body.manager_contact_id, src="manual", now_ms=now,
        )
        detail = _call(_load_detail, conn, contact_id)
    return success_envelope(detail, request=request)


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
