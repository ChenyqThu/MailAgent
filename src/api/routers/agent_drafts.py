"""Skill drafts and plugin import/export routes for /api/agent."""

from __future__ import annotations

import base64
import binascii
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request, Response

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.routers.agent_common import (
    _pack_api_error,
    _require_skill_creator,
    resolve_agent_config_store as get_agent_config_store,
)

router = APIRouter()

def _require_agent_plugins() -> None:
    from src.skills.flags import agent_plugins_enabled

    if not agent_plugins_enabled():
        raise APIError(
            "E_NOT_FOUND", "agent plugins feature is disabled", http_status=404, source="sqlite"
        )


def _draft_dict(row: Any, *, include_tree: bool = False) -> dict[str, Any]:
    payload = {
        "id": row.id,
        "name": row.name,
        "status": row.status,
        "manifest": row.manifest,
        "validation": row.validation,
        "sourceSessionId": row.source_session_id,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    }
    if include_tree:
        from src.skills.draft import list_draft_tree

        payload["files"] = list_draft_tree(row.id) if row.status != "discarded" else []
        installed = get_agent_config_store().get_skill(row.name)
        payload["replacesInstalled"] = bool(installed and installed.files_json)
        payload["currentPackageHash"] = installed.package_hash if installed else None
    return payload



@router.post("/skills/plugin/import", dependencies=[Depends(verify_cf_access)])
async def import_agent_plugin(request: Request, body: Optional[dict[str, Any]] = None):
    _require_agent_plugins()
    raw = body or {}
    local_path = raw.get("localPath")
    zip_base64 = raw.get("zipBase64")
    if (isinstance(local_path, str)) == (isinstance(zip_base64, str)):
        raise APIError("E_INVALID_ARG", "provide exactly one of localPath or zipBase64", http_status=400, source="sqlite")
    try:
        zip_bytes = base64.b64decode(zip_base64, validate=True) if isinstance(zip_base64, str) else None
    except (binascii.Error, ValueError) as exc:
        raise APIError("E_INVALID_ARG", "zipBase64 is invalid", http_status=400, source="sqlite") from exc
    try:
        from src.skills.plugin_import import import_plugin

        result = import_plugin(local_path=local_path, zip_bytes=zip_bytes)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope(result, request=request, source="sqlite")


@router.get("/skills/{name}/export", dependencies=[Depends(verify_cf_access)])
async def export_agent_skill(name: str, format: str = Query("skill")):
    _require_agent_plugins()
    try:
        from src.skills.plugin_export import export_skill

        payload = export_skill(name, format=format)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    suffix = "plugin" if format == "plugin" else "skill"
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}-{suffix}.zip"'},
    )


@router.get("/skills/drafts", dependencies=[Depends(verify_cf_access)])
async def list_skill_drafts(request: Request):
    _require_skill_creator()
    drafts = [_draft_dict(row) for row in get_agent_config_store().list_skill_drafts()]
    return success_envelope(
        {"drafts": drafts}, request=request, source="sqlite", meta_extra={"count": len(drafts)}
    )


@router.post("/skills/drafts", dependencies=[Depends(verify_cf_access)])
async def create_skill_draft(request: Request, body: Optional[dict[str, Any]] = None):
    _require_skill_creator()
    raw = body or {}
    name = raw.get("name")
    manifest = raw.get("manifest")
    if not isinstance(name, str):
        raise APIError("E_INVALID_ARG", "body.name is required", http_status=400, source="sqlite")
    if manifest is not None and not isinstance(manifest, dict):
        raise APIError("E_INVALID_ARG", "body.manifest must be an object", http_status=400, source="sqlite")
    try:
        from src.skills.draft import create_draft

        row = create_draft(
            name,
            manifest=manifest,
            source_session_id=raw.get("sourceSessionId")
            if isinstance(raw.get("sourceSessionId"), int) else None,
        )
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope(_draft_dict(row, include_tree=True), request=request, source="sqlite")


@router.get("/skills/drafts/{draft_id}", dependencies=[Depends(verify_cf_access)])
async def get_skill_draft(draft_id: str, request: Request):
    _require_skill_creator()
    try:
        from src.skills.draft import draft_dir

        draft_dir(draft_id)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    row = get_agent_config_store().get_skill_draft(draft_id)
    if row is None:
        raise APIError("E_NOT_FOUND", f"skill draft not found: {draft_id}", http_status=404, source="sqlite")
    return success_envelope(_draft_dict(row, include_tree=True), request=request, source="sqlite")


@router.get("/skills/drafts/{draft_id}/file", dependencies=[Depends(verify_cf_access)])
async def get_skill_draft_file(draft_id: str, request: Request, path: str = Query(...)):
    _require_skill_creator()
    try:
        from src.skills.draft import read_draft_file

        content = read_draft_file(draft_id, path)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope({"path": path, "content": content}, request=request, source="sqlite")


@router.put("/skills/drafts/{draft_id}/file", dependencies=[Depends(verify_cf_access)])
async def put_skill_draft_file(
    draft_id: str, request: Request, body: Optional[dict[str, Any]] = None
):
    _require_skill_creator()
    raw = body or {}
    path = raw.get("path")
    content = raw.get("content")
    if not isinstance(path, str) or not isinstance(content, str):
        raise APIError("E_INVALID_ARG", "body.path and body.content must be strings", http_status=400, source="sqlite")
    try:
        from src.skills.draft import write_draft_file

        result = write_draft_file(draft_id, path, content)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope(result, request=request, source="sqlite")


@router.delete("/skills/drafts/{draft_id}/file", dependencies=[Depends(verify_cf_access)])
async def remove_skill_draft_file(draft_id: str, request: Request, path: str = Query(...)):
    _require_skill_creator()
    try:
        from src.skills.draft import delete_draft_file

        removed = delete_draft_file(draft_id, path)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope({"path": path, "removed": removed}, request=request, source="sqlite")


@router.post("/skills/drafts/{draft_id}/validate", dependencies=[Depends(verify_cf_access)])
async def validate_skill_draft(draft_id: str, request: Request):
    _require_skill_creator()
    try:
        from src.skills.draft import validate_draft

        validation = validate_draft(draft_id)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope({"draftId": draft_id, "validation": validation}, request=request, source="sqlite")


@router.post("/skills/drafts/{draft_id}/publish", dependencies=[Depends(verify_cf_access)])
async def publish_skill_draft(
    draft_id: str, request: Request, body: Optional[dict[str, Any]] = None
):
    _require_skill_creator()
    enabled = (body or {}).get("enabled", True)
    if not isinstance(enabled, bool):
        raise APIError("E_INVALID_ARG", "body.enabled must be boolean", http_status=400, source="sqlite")
    try:
        from src.skills.draft import publish_draft

        result = publish_draft(draft_id, enabled)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope(result, request=request, source="sqlite")


@router.post("/skills/drafts/{draft_id}/discard", dependencies=[Depends(verify_cf_access)])
async def discard_skill_draft(draft_id: str, request: Request):
    _require_skill_creator()
    try:
        from src.skills.draft import discard_draft

        row = discard_draft(draft_id)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope(_draft_dict(row), request=request, source="sqlite")

