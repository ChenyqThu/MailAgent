"""Matter workspace REST API."""

from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, Depends, Header, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
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
    MutationEnvelope,
    MutationOnly,
    PermanentDeleteRequest,
)
from src.matters.repository import MatterRepository
from src.matters.service import Actor, MatterError, MatterService


def require_matters_enabled(settings=Depends(get_settings)) -> None:
    if not bool(settings.matters_enabled):
        raise APIError("E_DISABLED", "Matters feature is disabled", source="sqlite")


def get_matter_service(settings=Depends(get_settings)) -> MatterService:
    return MatterService(MatterRepository(settings.sync_store_db_path))


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
        _call(service.context_snapshot, matter_id), request=request
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
    body: MatterPatchRequest,
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
