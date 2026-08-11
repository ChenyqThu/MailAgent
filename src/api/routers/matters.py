"""Matter workspace REST API."""

from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access, verify_local_token
from src.api.deps import get_settings
from src.api.schemas.matters import (
    MatterCreateRequest,
    MatterChatScopeRequest,
    MatterItemCreateRequest,
    MatterItemPatchRequest,
    MatterNoteCreateRequest,
    MatterPatchRequest,
    MatterRelationCreateRequest,
    MatterRelationPatchRequest,
    MatterResourceCreateRequest,
    MatterResourcePatchRequest,
    MatterStakeholderCreateRequest,
    MatterStakeholderPatchRequest,
    MatterUpdateAcceptRequest,
    MatterUpdateRejectRequest,
    MutationEnvelope,
    MutationOnly,
    PermanentDeleteRequest,
)
from src.matters.create_research import MatterCreateResearchService
from src.repository.email_repository import EmailRepository
from src.matters.repository import MatterRepository
from src.matters.attention import AttentionService, SNOOZE_3D_MS
from src.matters.run_service import MatterRunService
from src.matters.service import Actor, MatterError, MatterService


def require_matters_enabled(settings=Depends(get_settings)) -> None:
    if not bool(settings.matters_enabled):
        raise APIError("E_DISABLED", "Matters feature is disabled", source="sqlite")


def require_matter_agent_enabled(settings=Depends(get_settings)) -> None:
    """P4 双 flag 门的第二道（runs/propose 面）。updates/review 面**有意不挂**——
    agent flag 事后关掉时 owner 仍能评审/拒绝清账既有 pending 提案（D11）。"""
    if not bool(getattr(settings, "matter_agent_enabled", False)):
        raise APIError(
            "E_DISABLED", "Matter agent feature is disabled", source="sqlite"
        )


def get_matter_service(settings=Depends(get_settings)) -> MatterService:
    return MatterService(MatterRepository(settings.sync_store_db_path))


def get_matter_create_research_service(
    settings=Depends(get_settings),
) -> MatterCreateResearchService:
    return MatterCreateResearchService(
        EmailRepository(settings.sync_store_db_path),
        MatterService(MatterRepository(settings.sync_store_db_path)),
    )


def get_matter_run_service(settings=Depends(get_settings)) -> MatterRunService:
    return MatterRunService(MatterRepository(settings.sync_store_db_path))


def get_attention_service(settings=Depends(get_settings)) -> AttentionService:
    return AttentionService(MatterRepository(settings.sync_store_db_path))


router = APIRouter(
    prefix="/api/matters",
    tags=["matters"],
    dependencies=[Depends(verify_cf_access), Depends(require_matters_enabled)],
)


def _call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    try:
        return fn(*args, **kwargs)
    except MatterError as exc:
        raise APIError(exc.code, exc.message, hint=exc.hint, source="sqlite") from exc


def _mutation_args(
    mutation: MutationEnvelope,
    header_key: str | None,
    *,
    require_version: bool = True,
) -> dict[str, Any]:
    if header_key is not None and header_key != mutation.idempotency_key:
        raise APIError(
            "E_IDEMPOTENCY_CONFLICT",
            "Idempotency-Key header does not match mutation.idempotency_key",
            source="sqlite",
        )
    if require_version and mutation.expected_version is None:
        raise APIError(
            "E_INVALID_ARG", "mutation.expected_version is required", source="sqlite"
        )
    result = {
        "idempotency_key": mutation.idempotency_key,
        "source": mutation.source,
        "actor": Actor(kind="user", actor_id=None),
        "reason": mutation.reason,
        "reverses_event_id": mutation.reverses_event_id,
    }
    if require_version:
        result["expected_version"] = mutation.expected_version
    return result


def _decode_cursor(cursor: str | None) -> tuple[int, int] | None:
    if not cursor:
        return None
    try:
        timestamp, row_id = cursor.split(":", 1)
        return int(timestamp), int(row_id)
    except (TypeError, ValueError) as exc:
        raise APIError(
            "E_INVALID_ARG", "cursor must be '<timestamp>:<id>'", source="sqlite"
        ) from exc


def _encode_cursor(cursor: tuple[int, int] | None) -> str | None:
    return f"{cursor[0]}:{cursor[1]}" if cursor else None


MATTER_NOTIFY_LEVELS = ("high", "all", "off")


class MatterPatchWithScheduleRequest(MatterPatchRequest):
    schedule_json: dict[str, Any] | None = None


class MatterCreateDraftRequest(BaseModel):
    internal_id: int = Field(gt=0)
    thread_id: str | None = None
    link_scope: str | None = None
    title: str | None = None
    matter_type: str | None = None
    description: str | None = None


class MatterTagStyleRequest(BaseModel):
    color: str
    shape: str
    mutation: MutationEnvelope


class MatterTagRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    mutation: MutationEnvelope


@router.get("/attention")
async def list_global_attention(
    request: Request,
    state: str | None = "open",
    kind: str | None = None,
    service: AttentionService = Depends(get_attention_service),
):
    return success_envelope(
        {"items": _call(service.list_attention, state=state, kind=kind)},
        request=request,
    )


@router.get("/notify-level")
async def get_matter_notify_level(request: Request):
    from src.agent_config.store import get_agent_config_store

    raw = get_agent_config_store().get_owner_setting("matter_notify_level")
    level = raw if raw in MATTER_NOTIFY_LEVELS else "high"
    return success_envelope({"level": level}, request=request, source="sqlite")


@router.put("/notify-level")
async def set_matter_notify_level(request: Request, body: dict[str, Any] | None = None):
    from src.agent_config.store import get_agent_config_store

    level = (body or {}).get("level")
    if level not in MATTER_NOTIFY_LEVELS:
        raise APIError(
            "E_INVALID_ARG",
            f"body.level must be one of {MATTER_NOTIFY_LEVELS}",
            source="sqlite",
        )
    get_agent_config_store().set_owner_setting("matter_notify_level", level)
    return success_envelope({"level": level}, request=request, source="sqlite")


@router.get("")
async def list_matters(
    request: Request,
    q: str | None = None,
    status: str | None = None,
    health: str | None = None,
    priority: str | None = None,
    matter_type: str | None = Query(default=None, alias="type"),
    tag: str | None = None,
    view: str | None = None,
    archived: bool | None = None,
    deleted: bool | None = None,
    cursor: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    sort: str = Query(default="updated_at", pattern="^(updated_at|created_at)$"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.list_matters,
        filters={
            "q": q,
            "status": status,
            "health": health,
            "priority": priority,
            "type": matter_type,
            "tag": tag,
            "view": view,
            "archived": archived,
            "deleted": deleted,
        },
        cursor=_decode_cursor(cursor),
        limit=limit,
        sort=sort,
    )
    result["next_cursor"] = _encode_cursor(result["next_cursor"])
    total = result.pop("total")
    return success_envelope(
        result, request=request, meta_extra={"total": total, "limit": limit}
    )


@router.post("")
async def create_matter(
    body: MatterCreateRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    data = body.model_dump(exclude={"mutation"})
    result = _call(
        service.create_matter,
        data,
        **_mutation_args(body.mutation, idempotency_key, require_version=False),
    )
    return success_envelope(result, request=request, status_code=201)


@router.post("/duplicate-candidates")
async def find_duplicate_candidates(
    body: dict[str, Any],
    request: Request,
    service: MatterService = Depends(get_matter_service),
):
    return success_envelope(
        {"items": _call(service.duplicate_candidates, body)}, request=request
    )


@router.post("/create-draft")
async def create_matter_draft(
    body: MatterCreateDraftRequest,
    request: Request,
    service: MatterCreateResearchService = Depends(
        get_matter_create_research_service
    ),
):
    try:
        result = await service.create_draft(body.model_dump(exclude_none=True))
    except MatterError as exc:
        raise APIError(
            exc.code,
            exc.message,
            hint=exc.hint,
            source="sqlite",
        ) from exc
    return success_envelope(result, request=request)


@router.get("/links/by-resource")
async def lookup_links_by_resource(
    request: Request,
    provider: str,
    keys: str,
    service: MatterService = Depends(get_matter_service),
):
    key_values = [value.strip() for value in keys.split(",") if value.strip()]
    if not key_values or len(key_values) > 50:
        raise APIError("E_INVALID_ARG", "keys must contain 1-50 resource keys", source="sqlite")
    result = _call(service.lookup_resource_links, provider.strip().lower(), key_values)
    return success_envelope({"results": result}, request=request)


@router.get("/tags")
async def list_matter_tags(
    request: Request,
    service: MatterService = Depends(get_matter_service),
):
    return success_envelope({"items": _call(service.list_tags)}, request=request)


@router.put("/tags/{name}")
async def upsert_matter_tag_style(
    name: str,
    body: MatterTagStyleRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.upsert_tag_style,
        name,
        color=body.color,
        shape=body.shape,
        **_mutation_args(body.mutation, idempotency_key, require_version=False),
    )
    return success_envelope(result, request=request)


@router.post("/tags/{name}/rename")
async def rename_matter_tag(
    name: str,
    body: MatterTagRenameRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.rename_tag,
        name,
        body.name,
        **_mutation_args(body.mutation, idempotency_key, require_version=False),
    )
    return success_envelope(result, request=request)


@router.delete("/tags/{name}")
async def delete_matter_tag(
    name: str,
    body: MutationOnly,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.delete_tag,
        name,
        **_mutation_args(body.mutation, idempotency_key, require_version=False),
    )
    return success_envelope(result, request=request)


@router.get("/{matter_id}")
async def get_matter(
    matter_id: str,
    request: Request,
    include: str | None = None,
    service: MatterService = Depends(get_matter_service),
):
    include_values = [
        value.strip() for value in (include or "").split(",") if value.strip()
    ]
    result = _call(service.get_matter, matter_id, include=include_values)
    return success_envelope(result, request=request)


@router.get("/{matter_id}/context-snapshot")
async def get_matter_context_snapshot(
    matter_id: str,
    request: Request,
    service: MatterService = Depends(get_matter_service),
):
    return success_envelope(
        _call(service.context_snapshot, matter_id, prepare_discovery=False), request=request
    )


@router.post("/{matter_id}/chat-scope")
async def record_matter_chat_scope(
    matter_id: str,
    body: MatterChatScopeRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.record_chat_scope,
        matter_id,
        scope=body.scope,
        session_id=body.session_id,
        **_mutation_args(body.mutation, idempotency_key, require_version=False),
    )
    return success_envelope(result, request=request)


@router.patch("/{matter_id}")
async def patch_matter(
    matter_id: str,
    body: MatterPatchWithScheduleRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    patch = body.model_dump(exclude={"mutation"}, exclude_unset=True)
    result = _call(
        service.patch_matter,
        matter_id,
        patch,
        **_mutation_args(body.mutation, idempotency_key),
    )
    return success_envelope(result, request=request)


async def _transition(
    operation: str,
    matter_id: str,
    body: MutationOnly,
    request: Request,
    header_key: str | None,
    service: MatterService,
):
    result = _call(
        getattr(service, operation),
        matter_id,
        **_mutation_args(body.mutation, header_key),
    )
    return success_envelope(result, request=request)


@router.post("/{matter_id}/archive")
async def archive_matter(
    matter_id: str,
    body: MutationOnly,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    return await _transition(
        "archive", matter_id, body, request, idempotency_key, service
    )


@router.post("/{matter_id}/reopen")
async def reopen_matter(
    matter_id: str,
    body: MutationOnly,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    return await _transition(
        "reopen", matter_id, body, request, idempotency_key, service
    )


@router.post("/{matter_id}/trash")
async def trash_matter(
    matter_id: str,
    body: MutationOnly,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    return await _transition(
        "trash", matter_id, body, request, idempotency_key, service
    )


@router.post("/{matter_id}/restore")
async def restore_matter(
    matter_id: str,
    body: MutationOnly,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    return await _transition(
        "restore", matter_id, body, request, idempotency_key, service
    )


@router.delete("/{matter_id}/trash")
async def permanently_delete_matter(
    matter_id: str,
    body: PermanentDeleteRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    if body.confirmation != matter_id:
        raise APIError(
            "E_AUTH_FAILED",
            "confirmation must equal the Matter public_id",
            source="sqlite",
        )
    if not body.mutation.reason:
        raise APIError(
            "E_INVALID_ARG",
            "permanent delete requires mutation.reason",
            source="sqlite",
        )
    result = _call(
        service.permanently_delete,
        matter_id,
        **_mutation_args(body.mutation, idempotency_key),
    )
    return success_envelope(result, request=request)


@router.get("/{matter_id}/items")
async def list_items(
    matter_id: str,
    request: Request,
    kind: str | None = None,
    status: str | None = None,
    include_deleted: bool = False,
    service: MatterService = Depends(get_matter_service),
):
    items = _call(
        service.list_items,
        matter_id,
        kind=kind,
        status=status,
        include_deleted=include_deleted,
    )
    return success_envelope({"items": items}, request=request)


@router.post("/{matter_id}/items")
async def create_item(
    matter_id: str,
    body: MatterItemCreateRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.create_item,
        matter_id,
        body.model_dump(exclude={"mutation"}),
        **_mutation_args(body.mutation, idempotency_key),
    )
    return success_envelope(result, request=request, status_code=201)


@router.patch("/{matter_id}/items/{item_id}")
async def update_item(
    matter_id: str,
    item_id: int,
    body: MatterItemPatchRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    patch = body.model_dump(exclude={"mutation"}, exclude_unset=True)
    result = _call(
        service.update_item,
        matter_id,
        item_id,
        patch,
        **_mutation_args(body.mutation, idempotency_key),
    )
    return success_envelope(result, request=request)


@router.delete("/{matter_id}/items/{item_id}")
async def delete_item(
    matter_id: str,
    item_id: int,
    body: MutationOnly,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.delete_item,
        matter_id,
        item_id,
        **_mutation_args(body.mutation, idempotency_key),
    )
    return success_envelope(result, request=request)


@router.post("/{matter_id}/items/{item_id}/restore")
async def restore_item(
    matter_id: str,
    item_id: int,
    body: MutationOnly,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.restore_item,
        matter_id,
        item_id,
        **_mutation_args(body.mutation, idempotency_key),
    )
    return success_envelope(result, request=request)


@router.get("/{matter_id}/timeline")
async def get_timeline(
    matter_id: str,
    request: Request,
    cursor: int | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(service.timeline, matter_id, cursor=cursor, limit=limit)
    return success_envelope(result, request=request, meta_extra={"limit": limit})


@router.post("/{matter_id}/notes")
async def create_note(
    matter_id: str,
    body: MatterNoteCreateRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    title = (body.title or body.text or "").strip()
    data = {"title": title, "description": body.text}
    result = _call(
        service.add_note,
        matter_id,
        data,
        **_mutation_args(body.mutation, idempotency_key),
    )
    return success_envelope(result, request=request, status_code=201)


@router.get("/{matter_id}/resources")
async def list_resources(
    matter_id: str, request: Request, kind: str | None = None,
    pinned: bool | None = None, access_policy: str | None = None,
    sub_state: str | None = None, include_unavailable: bool = True,
    service: MatterService = Depends(get_matter_service),
):
    items = _call(
        service.list_resources, matter_id, kind=kind, pinned=pinned,
        access_policy=access_policy, sub_state=sub_state,
    )
    if not include_unavailable:
        items = [item for item in items if item["resource"]["available"]]
    return success_envelope({"items": items}, request=request)


@router.post("/{matter_id}/resources")
async def create_resource(
    matter_id: str, body: MatterResourceCreateRequest, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.add_resource, matter_id,
        body.model_dump(exclude={"mutation"}, exclude_none=True),
        **_mutation_args(body.mutation, idempotency_key),
    )
    return success_envelope(result, request=request, status_code=201)


@router.post("/{matter_id}/resources/{resource_id}/fetch")
async def fetch_url_resource(
    matter_id: str,
    resource_id: int,
    request: Request,
    force: bool = Query(default=False),
    service: MatterService = Depends(get_matter_service),
):
    result = await run_in_threadpool(
        _call, service.fetch_url_resource, matter_id, resource_id, force=force
    )
    return success_envelope(result, request=request)


@router.patch("/{matter_id}/resources/{resource_id}")
async def patch_resource(
    matter_id: str, resource_id: int, body: MatterResourcePatchRequest, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.patch_resource, matter_id, resource_id,
        body.model_dump(exclude={"mutation"}, exclude_unset=True),
        **_mutation_args(body.mutation, idempotency_key),
    )
    return success_envelope(result, request=request)


@router.post("/{matter_id}/resources/{resource_id}/reject-suggestion")
async def reject_resource_suggestion(
    matter_id: str, resource_id: int, body: MutationOnly, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.reject_resource_suggestion,
        matter_id,
        resource_id,
        **_mutation_args(body.mutation, idempotency_key),
    )
    return success_envelope(result, request=request)


@router.post("/{matter_id}/resource-suggestions/discover")
async def discover_resource_suggestions(
    matter_id: str,
    body: dict[str, Any] | None,
    request: Request,
    service: MatterService = Depends(get_matter_service),
):
    payload = body or {}
    result = _call(
        service.discover_resource_suggestions,
        matter_id,
        query=payload.get("query"),
        expand_reason=payload.get("expand_reason"),
        limit=payload.get("limit", 10),
    )
    return success_envelope(result, request=request)


@router.delete("/{matter_id}/resources/{resource_id}")
async def delete_resource(
    matter_id: str, resource_id: int, body: MutationOnly, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(service.unlink_resource, matter_id, resource_id, **_mutation_args(body.mutation, idempotency_key))
    return success_envelope(result, request=request)


@router.post("/{matter_id}/resources/{resource_id}/restore")
async def restore_resource(
    matter_id: str, resource_id: int, body: MutationOnly, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(service.restore_resource, matter_id, resource_id, **_mutation_args(body.mutation, idempotency_key))
    return success_envelope(result, request=request)


@router.get("/{matter_id}/stakeholders")
async def list_stakeholders(
    matter_id: str, request: Request, waiting_only: bool = False, include_deleted: bool = False,
    service: MatterService = Depends(get_matter_service),
):
    return success_envelope({"items": _call(service.list_stakeholders, matter_id, waiting_only=waiting_only, include_deleted=include_deleted)}, request=request)


@router.post("/{matter_id}/stakeholders")
async def create_stakeholder(
    matter_id: str, body: MatterStakeholderCreateRequest, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(service.create_stakeholder, matter_id, body.model_dump(exclude={"mutation"}, exclude_none=True), **_mutation_args(body.mutation, idempotency_key))
    return success_envelope(result, request=request, status_code=201)


@router.patch("/{matter_id}/stakeholders/{stakeholder_id}")
async def patch_stakeholder(
    matter_id: str, stakeholder_id: int, body: MatterStakeholderPatchRequest, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(service.update_stakeholder, matter_id, stakeholder_id, body.model_dump(exclude={"mutation"}, exclude_unset=True), **_mutation_args(body.mutation, idempotency_key))
    return success_envelope(result, request=request)


@router.delete("/{matter_id}/stakeholders/{stakeholder_id}")
async def delete_stakeholder(
    matter_id: str, stakeholder_id: int, body: MutationOnly, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(service.delete_stakeholder, matter_id, stakeholder_id, **_mutation_args(body.mutation, idempotency_key))
    return success_envelope(result, request=request)


@router.post("/{matter_id}/stakeholders/{stakeholder_id}/restore")
async def restore_stakeholder(
    matter_id: str, stakeholder_id: int, body: MutationOnly, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(service.restore_stakeholder, matter_id, stakeholder_id, **_mutation_args(body.mutation, idempotency_key))
    return success_envelope(result, request=request)


@router.get("/{matter_id}/relations")
async def list_relations(
    matter_id: str, request: Request, direction: str = "both", relation_type: str | None = Query(default=None, alias="type"),
    service: MatterService = Depends(get_matter_service),
):
    return success_envelope({"items": _call(service.list_relations, matter_id, direction=direction, relation_type=relation_type)}, request=request)


@router.post("/{matter_id}/relations")
async def create_relation(
    matter_id: str, body: MatterRelationCreateRequest, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(service.create_relation, matter_id, body.model_dump(exclude={"mutation"}), **_mutation_args(body.mutation, idempotency_key))
    return success_envelope(result, request=request, status_code=201)


@router.patch("/{matter_id}/relations/{relation_id}")
async def patch_relation(
    matter_id: str, relation_id: int, body: MatterRelationPatchRequest, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(service.patch_relation, matter_id, relation_id, body.model_dump(exclude={"mutation"}, exclude_unset=True), **_mutation_args(body.mutation, idempotency_key))
    return success_envelope(result, request=request)


@router.delete("/{matter_id}/relations/{relation_id}")
async def delete_relation(
    matter_id: str, relation_id: int, body: MutationOnly, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(service.delete_relation, matter_id, relation_id, **_mutation_args(body.mutation, idempotency_key))
    return success_envelope(result, request=request)


@router.post("/{matter_id}/relations/{relation_id}/restore")
async def restore_relation(
    matter_id: str, relation_id: int, body: MutationOnly, request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(service.restore_relation, matter_id, relation_id, **_mutation_args(body.mutation, idempotency_key))
    return success_envelope(result, request=request)


# ── P4: Updates 评审面（只挂 matters 闸 —— agent flag 关掉仍可清账，D11）──────────


@router.get("/{matter_id}/updates")
async def list_updates(
    matter_id: str,
    request: Request,
    review_status: str | None = None,
    stale: bool | None = None,
    cursor: int | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    service: MatterService = Depends(get_matter_service),
):
    result = _call(
        service.list_updates_page,
        matter_id,
        review_status=review_status,
        stale=stale,
        cursor=cursor,
        limit=limit,
    )
    return success_envelope(result, request=request, meta_extra={"limit": limit})


@router.get("/{matter_id}/updates/{update_id}")
async def get_update(
    matter_id: str,
    update_id: int,
    request: Request,
    service: MatterService = Depends(get_matter_service),
):
    return success_envelope(
        _call(service.get_update_detail, matter_id, update_id), request=request
    )


@router.post("/{matter_id}/updates/{update_id}/accept")
async def accept_update(
    matter_id: str,
    update_id: int,
    body: MatterUpdateAcceptRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    # exclude_unset：edited_changes 的 after 需要区分「未提供」与「显式 null」。
    edited = (
        [entry.model_dump(exclude_unset=True) for entry in body.edited_changes]
        if body.edited_changes is not None
        else None
    )
    result = _call(
        service.accept_update,
        matter_id,
        update_id,
        selected_change_ids=body.selected_change_ids,
        edited_changes=edited,
        edited_summary=body.edited_summary,
        **_mutation_args(body.mutation, idempotency_key),
    )
    return success_envelope(result, request=request)


@router.post("/{matter_id}/updates/{update_id}/reject")
async def reject_update(
    matter_id: str,
    update_id: int,
    body: MatterUpdateRejectRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterService = Depends(get_matter_service),
):
    args = _mutation_args(body.mutation, idempotency_key)
    args.pop("reason", None)  # reject 的 reason 权威在顶层 body.reason
    result = _call(
        service.reject_update,
        matter_id,
        update_id,
        reason=body.reason,
        **args,
    )
    return success_envelope(result, request=request)


# ── P4: Runs 面（cf_access + 双 flag 门，D10）────────────────────────────────────


@router.get(
    "/{matter_id}/runs", dependencies=[Depends(require_matter_agent_enabled)]
)
async def list_matter_runs(
    matter_id: str,
    request: Request,
    cursor: int | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    status: str | None = None,
    trigger_kind: str | None = None,
    service: MatterRunService = Depends(get_matter_run_service),
):
    result = _call(
        service.list_runs,
        matter_id,
        cursor=cursor,
        limit=limit,
        status=status,
        trigger_kind=trigger_kind,
    )
    return success_envelope(result, request=request, meta_extra={"limit": limit})


@router.get(
    "/{matter_id}/runs/{run_id}",
    dependencies=[Depends(require_matter_agent_enabled)],
)
async def get_matter_run(
    matter_id: str,
    run_id: int,
    request: Request,
    service: MatterRunService = Depends(get_matter_run_service),
):
    run = _call(service.get_run_projection, matter_id, run_id)
    return success_envelope(
        {"run": run, "lifecycle_state": run["lifecycle_state"]}, request=request
    )


@router.post(
    "/{matter_id}/runs", dependencies=[Depends(require_matter_agent_enabled)]
)
async def create_matter_run(
    matter_id: str,
    body: MutationOnly,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterRunService = Depends(get_matter_run_service),
):
    """Run Now（D3/D10）。body **无 trigger_kind**（manual 由服务端钉死，contracts §4.4）；
    ``expected_version`` 作 input anchor（可缺省 —— gateway 工具面可不带；带则不符 409）。"""
    args = _mutation_args(body.mutation, idempotency_key, require_version=False)
    result = _call(
        service.enqueue_run,
        matter_id,
        expected_version=body.mutation.expected_version,
        **args,
    )
    return success_envelope(result, request=request)


@router.post(
    "/{matter_id}/runs/{run_id}/cancel",
    dependencies=[Depends(require_matter_agent_enabled)],
)
async def cancel_matter_run(
    matter_id: str,
    run_id: int,
    body: MutationOnly,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: MatterRunService = Depends(get_matter_run_service),
):
    args = _mutation_args(body.mutation, idempotency_key, require_version=False)
    result = _call(service.cancel_run, matter_id, run_id, **args)
    return success_envelope(result, request=request)


@router.get("/{matter_id}/attention")
async def list_matter_attention(
    matter_id: str,
    request: Request,
    state: str | None = "open",
    kind: str | None = None,
    service: AttentionService = Depends(get_attention_service),
):
    return success_envelope(
        {
            "items": _call(
                service.list_attention,
                public_id=matter_id,
                state=state,
                kind=kind,
            )
        },
        request=request,
    )


def _attention_mutation(body: dict[str, Any], header_key: str | None) -> dict[str, Any]:
    try:
        mutation = MutationEnvelope.model_validate(body.get("mutation") or {})
    except Exception as exc:
        raise APIError("E_INVALID_ARG", "mutation is required", source="sqlite") from exc
    return _mutation_args(mutation, header_key, require_version=False)


@router.post("/{matter_id}/attention/{signal_id}/resolve")
async def resolve_attention(
    matter_id: str,
    signal_id: int,
    body: dict[str, Any],
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: AttentionService = Depends(get_attention_service),
):
    args = _attention_mutation(body, idempotency_key)
    return success_envelope(
        _call(
            service.triage,
            matter_id,
            signal_id,
            "resolve",
            idempotency_key=args["idempotency_key"],
            reason=args.get("reason"),
        ),
        request=request,
    )


@router.post("/{matter_id}/attention/{signal_id}/snooze")
async def snooze_attention(
    matter_id: str,
    signal_id: int,
    body: dict[str, Any],
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: AttentionService = Depends(get_attention_service),
):
    args = _attention_mutation(body, idempotency_key)
    until = body.get("until")
    if body.get("preset") == "3d":
        until = service.clock_ms() + SNOOZE_3D_MS
    return success_envelope(
        _call(
            service.triage,
            matter_id,
            signal_id,
            "snooze",
            idempotency_key=args["idempotency_key"],
            reason=args.get("reason"),
            until=until,
        ),
        request=request,
    )


@router.post("/{matter_id}/attention/{signal_id}/dismiss")
async def dismiss_attention(
    matter_id: str,
    signal_id: int,
    body: dict[str, Any],
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    service: AttentionService = Depends(get_attention_service),
):
    args = _attention_mutation(body, idempotency_key)
    return success_envelope(
        _call(
            service.triage,
            matter_id,
            signal_id,
            "dismiss",
            idempotency_key=args["idempotency_key"],
            reason=body.get("reason") or args.get("reason"),
        ),
        request=request,
    )


async def acknowledge_attention_notified(
    matter_id: str,
    signal_id: int,
    request: Request,
    service: AttentionService = Depends(get_attention_service),
):
    return success_envelope(
        _call(service.acknowledge_notified, matter_id, signal_id), request=request
    )


_internal_router = APIRouter(prefix="/api/matters", tags=["matters"])
_internal_router.add_api_route(
    "/{matter_id}/attention/{signal_id}/notified",
    acknowledge_attention_notified,
    methods=["POST"],
    dependencies=[Depends(verify_local_token), Depends(require_matters_enabled)],
)
router.routes.extend(_internal_router.routes)
