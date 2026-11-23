"""Contact Directory REST API (task 08-13 WP2).

镜像 `src/api/routers/matters.py` 的门卫/信封形状; 读写 SQLite 全经
`src/contacts/repository.py` 与 `src/contacts/service.py`（router 不写裸 SQL）。
OpenAPI 响应模型统一挂载 `SuccessEnvelope[T]`。
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, Header, Query, Request

from src.api.app import APIError, success_payload
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.api.schemas import SuccessEnvelope
from src.api.schemas.contacts import (
    ContactAgentHistoryResponse,
    ContactAgentRunResponse,
    ContactAgentStatusResponse,
    ContactBackfillProgressResponse,
    ContactDetailResponse,
    ContactFormerEmailRequest,
    ContactFormerEmailResponse,
    ContactHideRequest,
    ContactHideResponse,
    ContactKindRequest,
    ContactKindResponse,
    ContactListResponse,
    ContactLockRequest,
    ContactLocksResponse,
    ContactMailsResponse,
    ContactManagerRequest,
    ContactMattersResponse,
    ContactMergeRequest,
    ContactPatchRequest,
    ContactPatchResponse,
    ContactPrimaryEmailRequest,
    ContactPrimaryEmailResponse,
    ContactProfileDailySummaryResponse,
    ContactProfileRefreshResponse,
    ContactProfileSuggestionAdoptRequest,
    ContactProfileSuggestionIgnoreRequest,
    ContactResolveRequest,
    ContactResolveResponse,
    ContactSelfRequest,
    ContactSelfResponse,
    ContactSuggestionAdoptResponse,
    ContactSuggestionBulkRequest,
    ContactSuggestionBulkResponse,
    ContactSuggestionIgnoreResponse,
    ContactSuggestionListResponse,
)
from src.contacts import governance as contact_governance
from src.contacts import profile as contact_profile
from src.contacts import repository as contact_repository
from src.contacts import service as contact_service
from src.contacts.profile_config import get_contact_profile_agent_config
from src.contacts.repository import (
    SORT_VALUES,
    VIEW_VALUES,
    ContactRepository,
    load_contact_detail,
)
from src.contacts.service import ContactError
from src.contacts.taxonomy import strip_evidence_refs

__all__ = [
    "MAIL_DIRECTION_VALUES",
    "SORT_VALUES",
    "VIEW_VALUES",
    "get_contact_repository",
    "query_contact_list",
    "_load_detail",
]

#: 关联邮件的方向三分 (task 08-14 WP-5, API 契约; 取代 v58 前的 role 过滤)。
MAIL_DIRECTION_VALUES = ("all", "from_them", "from_me", "from_third")
PROFILE_SUGGESTION_FIELDS = ("formal_name", "department", "phone")
_profile_tasks: set = set()
#: 兼容旧导入路径 (`tests/contacts/test_org_relations.py`)。
_load_detail = load_contact_detail


def _schedule_profile_task(coro) -> None:
    task = asyncio.create_task(coro)
    _profile_tasks.add(task)
    task.add_done_callback(_profile_tasks.discard)


@lru_cache(maxsize=4)
def _build_contact_repository(db_path: str) -> ContactRepository:
    """按 db_path 缓存 repo 实例 (缓存对象不缓存连接, 与 to_thread 并发安全)。"""
    return ContactRepository(db_path)


def get_contact_repository(settings=Depends(get_settings)) -> ContactRepository:
    return _build_contact_repository(str(settings.sync_store_db_path))


router = APIRouter(
    prefix="/api/contacts",
    tags=["contacts"],
    dependencies=[Depends(verify_cf_access)],
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


def _publish_contact_changed(contact_ids: list, *, scope: str) -> None:
    """建议采纳等写点落库后广播 ``contact.changed``（事务提交后调）。"""
    try:
        from src.events.publisher import safe_publish

        safe_publish(
            "contact.changed",
            data={
                "scope": scope,
                "contact_ids": [int(i) for i in contact_ids if isinstance(i, int)],
            },
            source="contacts-api",
        )
    except Exception:
        pass


def query_contact_list(
    repo: ContactRepository,
    *,
    view: str,
    q: Optional[str],
    sort: str,
    limit: Optional[int],
    cursor: Optional[str],
) -> dict:
    """同步列表查询与投影（与 contacts skill 共享 repository SQL）。"""
    return _call(
        contact_repository.query_contact_list,
        repo,
        view=view,
        q=q,
        sort=sort,
        limit=limit,
        cursor=cursor,
    )


# ---- backfill & governance (🔴 必须排在 /{contact_id} 之前) ----


@router.get(
    "/suggestions",
    response_model=SuccessEnvelope[ContactSuggestionListResponse],
)
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

    def _query() -> Any:
        conn = repo.connect()
        try:
            return _call(
                contact_governance.list_suggestions,
                conn,
                status=status,
                limit=limit,
                cursor=cursor_pair,
            )
        finally:
            conn.close()

    result = await asyncio.to_thread(_query)
    return success_payload(result, request=request)


@router.post(
    "/suggestions/{suggestion_id}/adopt",
    response_model=SuccessEnvelope[ContactSuggestionAdoptResponse],
)
async def adopt_governance_suggestion(
    suggestion_id: int,
    request: Request,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        result = _call(
            contact_governance.adopt_suggestion, conn, suggestion_id, now_ms=_now_ms()
        )
    error = result.pop("error", None)
    if error:
        raise APIError(error["code"], error["message"], source="sqlite")
    _publish_contact_changed(
        result.get("contact_ids") or [], scope="governance_adopt"
    )
    return success_payload(result, request=request)


@router.post(
    "/suggestions/{suggestion_id}/ignore",
    response_model=SuccessEnvelope[ContactSuggestionIgnoreResponse],
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
    return success_payload(result, request=request)


@router.post(
    "/suggestions/bulk",
    response_model=SuccessEnvelope[ContactSuggestionBulkResponse],
)
async def bulk_resolve_governance_suggestions(
    request: Request,
    body: ContactSuggestionBulkRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    """整批采纳 / 忽略待审建议 —— 范围是服务端全量 pending, body 只带动作。"""
    with repo.transaction() as conn:
        result = _call(
            contact_governance.bulk_resolve_suggestions,
            conn,
            action=body.action,
            now_ms=_now_ms(),
        )
    if result["contact_ids"]:
        _publish_contact_changed(result["contact_ids"], scope="governance_bulk_adopt")
    return success_payload(result, request=request)


@router.post(
    "/agent/run",
    response_model=SuccessEnvelope[ContactAgentRunResponse],
)
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
    return success_payload(result, request=request)


@router.get(
    "/agent/status",
    response_model=SuccessEnvelope[ContactAgentStatusResponse],
)
async def contact_governance_status(
    request: Request,
    repo: ContactRepository = Depends(get_contact_repository),
):
    def _query() -> dict[str, Any]:
        conn = repo.connect()
        try:
            return contact_repository.get_governance_status(conn)
        finally:
            conn.close()

    status_payload = await asyncio.to_thread(_query)
    return success_payload(status_payload, request=request)


@router.get(
    "/agent/history",
    response_model=SuccessEnvelope[ContactAgentHistoryResponse],
)
async def contact_governance_history(
    request: Request,
    limit: int = Query(10, ge=1, le=50),
    repo: ContactRepository = Depends(get_contact_repository),
):
    def _query() -> list[dict[str, Any]]:
        conn = repo.connect()
        try:
            return contact_repository.list_governance_history(conn, limit=limit)
        finally:
            conn.close()

    items = await asyncio.to_thread(_query)
    return success_payload({"items": items}, request=request)


@router.get(
    "/profile/daily-summary",
    response_model=SuccessEnvelope[ContactProfileDailySummaryResponse],
)
async def contact_profile_daily_summary(
    request: Request,
    repo: ContactRepository = Depends(get_contact_repository),
):
    local_date = datetime.now().astimezone().date()
    start_ms = int(datetime.combine(local_date, datetime.min.time()).timestamp() * 1000)
    end_ms = int(
        datetime.combine(local_date + timedelta(days=1), datetime.min.time()).timestamp()
        * 1000
    )

    def _query() -> tuple[dict[str, Any], Any]:
        conn = repo.connect()
        try:
            summary = contact_repository.get_profile_daily_summary(
                conn, start_ms=start_ms, end_ms=end_ms
            )
        finally:
            conn.close()
        return summary, get_contact_profile_agent_config(str(repo.db_path))

    summary, cfg = await asyncio.to_thread(_query)
    return success_payload(
        {
            "date": local_date.isoformat(),
            **summary,
            "fire_hour": cfg.fire_hour,
        },
        request=request,
    )


@router.get(
    "/backfill/progress",
    response_model=SuccessEnvelope[ContactBackfillProgressResponse],
)
async def backfill_progress(
    request: Request,
    repo: ContactRepository = Depends(get_contact_repository),
):
    """扫描进度 = watermark 覆盖的 email_metadata 行数 / 总行数 (廉价查询)。"""

    def _query() -> dict[str, Any]:
        conn = repo.connect()
        try:
            return contact_repository.get_backfill_progress(conn)
        finally:
            conn.close()

    progress = await asyncio.to_thread(_query)
    return success_payload(progress, request=request)


# ---- 批量精确解析 (WP4 互链: 邮件详情头 → PersonChip) ----

#: 单次 resolve 的地址数上限 (邮件详情头一封邮件的 from/to/cc 集合远小于此)。
RESOLVE_MAX_EMAILS = 100


@router.post(
    "/resolve",
    response_model=SuccessEnvelope[ContactResolveResponse],
)
async def resolve_contacts(
    request: Request,
    body: ContactResolveRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    """按归一 email **精确**匹配 contact_email 锚点, 批量返回 chip 最小集。"""
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

        def _query() -> dict[str, dict]:
            conn = repo.connect()
            try:
                return contact_repository.resolve_by_emails(conn, wanted)
            finally:
                conn.close()

        chip_by_email = await asyncio.to_thread(_query)
    items = {
        raw: (chip_by_email.get(norm) if norm else None)
        for raw, norm in normalized_by_input.items()
    }
    return success_payload({"items": items}, request=request)


# ---- 列表 & 详情 ----


@router.get(
    "",
    response_model=SuccessEnvelope[ContactListResponse],
)
async def list_contacts(
    request: Request,
    view: str = Query("known"),
    q: Optional[str] = Query(None),
    sort: str = Query("density"),
    limit: Optional[int] = Query(None),
    cursor: Optional[str] = Query(None),
    repo: ContactRepository = Depends(get_contact_repository),
    settings=Depends(get_settings),
):
    page = await asyncio.to_thread(
        query_contact_list, repo, view=view, q=q, sort=sort, limit=limit, cursor=cursor
    )
    return success_payload(page, request=request)


@router.get(
    "/{contact_id}",
    response_model=SuccessEnvelope[ContactDetailResponse],
)
async def get_contact(
    request: Request,
    contact_id: int,
    repo: ContactRepository = Depends(get_contact_repository),
):
    def _query() -> dict:
        conn = repo.connect()
        try:
            return _call(load_contact_detail, conn, contact_id, profile_enabled=True)
        finally:
            conn.close()

    detail = await asyncio.to_thread(_query)
    return success_payload(detail, request=request)


@router.post(
    "/{contact_id}/profile/refresh",
    status_code=202,
    response_model=SuccessEnvelope[ContactProfileRefreshResponse],
)
async def refresh_contact_profile(
    request: Request,
    contact_id: int,
    repo: ContactRepository = Depends(get_contact_repository),
    settings=Depends(get_settings),
):
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
                full_refresh=True,
            )
        )
    return success_payload(
        {"contact_id": contact_id, "status": "running", "started": claimed},
        request=request,
    )


@router.post(
    "/{contact_id}/profile/suggestions/adopt",
    response_model=SuccessEnvelope[ContactDetailResponse],
)
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
            {body.field: strip_evidence_refs(str(body.value))},
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
        detail = _call(load_contact_detail, conn, contact_id)
    _publish_contact_changed([contact_id], scope="profile_suggestion")
    return success_payload(detail, request=request)


@router.post(
    "/{contact_id}/profile/suggestions/ignore",
    response_model=SuccessEnvelope[ContactDetailResponse],
)
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
        detail = _call(load_contact_detail, conn, contact_id)
    _publish_contact_changed([contact_id], scope="profile_suggestion")
    return success_payload(detail, request=request)


# ---- 关联邮件 ----


@router.get(
    "/{contact_id}/mails",
    response_model=SuccessEnvelope[ContactMailsResponse],
)
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

    def _query() -> dict:
        conn = repo.connect()
        try:
            self_addresses = contact_service.resolve_self_addresses(
                conn,
                user_email=getattr(settings, "user_email", ""),
                extra_raw=getattr(settings, "self_emails", ""),
            )
            return _call(
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

    page = await asyncio.to_thread(_query)
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
            "message_id": row["message_id"],
            "seen_at": row["seen_at"] or None,
            "roles": sorted((row["roles"] or "").split(",")) if row["roles"] else [],
            "direction": row["direction"],
        }
        for row in rows
    ]
    return success_payload(
        {"items": items, "next_cursor": page["next_cursor"], "total": page["total"]},
        request=request,
    )


# ---- 关联事项 ----


@router.get(
    "/{contact_id}/matters",
    response_model=SuccessEnvelope[ContactMattersResponse],
)
async def list_contact_matters(
    request: Request,
    contact_id: int,
    repo: ContactRepository = Depends(get_contact_repository),
):
    def _query() -> list[dict[str, Any]]:
        conn = repo.connect()
        try:
            return _call(contact_repository.list_contact_matters, conn, contact_id)
        finally:
            conn.close()

    items = await asyncio.to_thread(_query)
    return success_payload({"items": items}, request=request)


# ---- 身份字段编辑 + 字段级锁 ----


@router.patch(
    "/{contact_id}",
    response_model=SuccessEnvelope[ContactPatchResponse],
)
async def patch_contact(
    request: Request,
    contact_id: int,
    body: ContactPatchRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise APIError("E_INVALID_ARG", "no fields provided", source="sqlite")
    now = _now_ms()
    with repo.transaction() as conn:
        result = _call(
            contact_service.update_identity_fields,
            conn,
            contact_id,
            fields,
            now=now,
        )
        detail = _call(load_contact_detail, conn, contact_id)
    return success_payload(
        {"fields": result["fields"], "locks": result["locks"], "contact": detail},
        request=request,
    )


@router.post(
    "/{contact_id}/locks",
    response_model=SuccessEnvelope[ContactLocksResponse],
)
async def set_contact_lock(
    request: Request,
    contact_id: int,
    body: ContactLockRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        locks = _call(
            contact_service.set_field_lock,
            conn,
            contact_id,
            body.field,
            locked=body.locked,
            now=_now_ms(),
        )
    return success_payload({"locks": locks}, request=request)


# ---- 治理写面 (service 既有守卫的薄端点) ----


@router.post(
    "/{contact_id}/hide",
    response_model=SuccessEnvelope[ContactHideResponse],
)
async def hide_contact(
    request: Request,
    contact_id: int,
    body: ContactHideRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        _call(
            contact_service.hide_contact,
            conn,
            contact_id,
            hidden=body.hidden,
            now=_now_ms(),
        )
    return success_payload({"hidden": body.hidden}, request=request)


@router.post(
    "/{contact_id}/kind",
    response_model=SuccessEnvelope[ContactKindResponse],
)
async def set_contact_kind(
    request: Request,
    contact_id: int,
    body: ContactKindRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        _call(
            contact_service.set_kind,
            conn,
            contact_id,
            body.kind,
            now=_now_ms(),
        )
    return success_payload({"kind": body.kind}, request=request)


@router.post(
    "/{contact_id}/self",
    response_model=SuccessEnvelope[ContactSelfResponse],
)
async def set_contact_self(
    request: Request,
    contact_id: int,
    body: ContactSelfRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    """标/取消「我」。单选 (最多一条 is_self=1)。"""
    with repo.transaction() as conn:
        _call(
            contact_service.set_is_self,
            conn,
            contact_id,
            is_self=body.is_self,
            now=_now_ms(),
        )
    return success_payload({"is_self": body.is_self}, request=request)


@router.post(
    "/{contact_id}/manager",
    response_model=SuccessEnvelope[ContactDetailResponse],
)
async def set_contact_manager(
    request: Request,
    contact_id: int,
    body: ContactManagerRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    """组织关系 (WP5): 指定/解除上级，成功返回本人详情。"""
    now = _now_ms()
    with repo.transaction() as conn:
        _call(
            contact_service.set_manager,
            conn,
            contact_id,
            body.manager_contact_id,
            src="manual",
            now_ms=now,
        )
        detail = _call(load_contact_detail, conn, contact_id)
    return success_payload(detail, request=request)


@router.post(
    "/{contact_id}/merge",
    response_model=SuccessEnvelope[ContactDetailResponse],
)
async def merge_contact(
    request: Request,
    contact_id: int,
    body: ContactMergeRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    """人级合并 (WP3): contact_id = winner，成功返回 winner 详情。"""
    now = _now_ms()
    with repo.transaction() as conn:
        _call(
            contact_service.merge_contacts,
            conn,
            contact_id,
            body.loser_id,
            now=now,
            primary_email=body.primary_email,
            former_emails=body.former_emails,
        )
        detail = _call(load_contact_detail, conn, contact_id)
    return success_payload(detail, request=request)


@router.post(
    "/{contact_id}/emails/primary",
    response_model=SuccessEnvelope[ContactPrimaryEmailResponse],
)
async def set_contact_primary_email(
    request: Request,
    contact_id: int,
    body: ContactPrimaryEmailRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        _call(
            contact_service.set_primary_email,
            conn,
            contact_id,
            body.email,
            now=_now_ms(),
        )
    return success_payload({"primary_email": body.email}, request=request)


@router.post(
    "/{contact_id}/emails/former",
    response_model=SuccessEnvelope[ContactFormerEmailResponse],
)
async def set_contact_email_former(
    request: Request,
    contact_id: int,
    body: ContactFormerEmailRequest,
    repo: ContactRepository = Depends(get_contact_repository),
):
    fn = (
        contact_service.mark_email_former
        if body.former
        else contact_service.unmark_email_former
    )
    with repo.transaction() as conn:
        _call(fn, conn, contact_id, body.email, now=_now_ms())
    return success_payload(
        {"email": body.email, "former": body.former}, request=request
    )
