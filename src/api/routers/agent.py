"""agent 配置面路由 — /api/agent/* (Phase -1 / 0A capability & context foundation).

Standing Context 文档（SOUL/AGENT/RULES/USER 可编辑 + MEMORY/SKILLS 投影）的读端点 +
版本历史。owner-only（本机用户的 agent 配置）→ ``Depends(verify_cf_access)``，**不**挂
Bearer（Bearer 是 ``/api/skills`` 的外部 agent 通道，agent 改自身配置不走 scoped key）。

写端点（set/rollback）+ Settings 编辑 UI + agent profile 工具在 PR6；本路由只读 + graceful。
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.agent_config.projections import memory_doc_projection, skills_doc_projection
from src.agent_config.store import PROFILE_DOC_NAMES, get_agent_config_store
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_chat_db

router = APIRouter(prefix="/api/agent", tags=["agent"])

# 文档展示顺序：4 个可编辑 + 2 个投影。
_DOC_ORDER = list(PROFILE_DOC_NAMES) + ["memory", "skills"]


def _editable_doc_dict(doc: Any) -> dict[str, Any]:
    return {
        "docName": doc.doc_name,
        "content": doc.content,
        "contentHash": doc.content_hash,
        "updatedBy": doc.updated_by,
        "updatedAt": doc.updated_at,
        "editable": True,
    }


def _projection_doc_dict(doc_name: str, content: str) -> dict[str, Any]:
    return {
        "docName": doc_name,
        "content": content,
        "contentHash": None,
        "updatedBy": "projection",
        "updatedAt": None,
        "editable": False,
    }


def _memory_projection() -> str:
    """MEMORY.md 投影（复用 ChatDb.memory_summary）。best-effort：库缺/锁 → 空占位。"""
    try:
        summary = get_chat_db().memory_summary()
    except Exception:  # noqa: BLE001 — projection best-effort
        summary = ""
    return memory_doc_projection(summary)


def _skills_projection() -> str:
    """SKILLS.md 投影（manifest skills，PR3 后含 installed）。best-effort：失败 → 空占位。"""
    try:
        from src.skills.registry import build_manifest

        return skills_doc_projection(build_manifest(None).skills)
    except Exception:  # noqa: BLE001 — projection best-effort
        return skills_doc_projection([])


@router.get("/profile/docs", dependencies=[Depends(verify_cf_access)])
async def list_profile_docs(request: Request):
    """列出 6 个 Standing Context 文档：4 可编辑（seed-on-read）+ MEMORY/SKILLS 投影。"""
    store = get_agent_config_store()
    docs = [_editable_doc_dict(d) for d in store.list_profile_docs()]
    docs.append(_projection_doc_dict("memory", _memory_projection()))
    docs.append(_projection_doc_dict("skills", _skills_projection()))
    return success_envelope({"docs": docs}, request=request, source="sqlite",
                            meta_extra={"count": len(docs)})


@router.get("/profile/docs/{name}", dependencies=[Depends(verify_cf_access)])
async def get_profile_doc(name: str, request: Request):
    """读单个文档。memory/skills → 投影；soul/agent/rules/user → store（seed-on-read）。"""
    if name == "memory":
        return success_envelope(_projection_doc_dict("memory", _memory_projection()),
                                request=request, source="sqlite")
    if name == "skills":
        return success_envelope(_projection_doc_dict("skills", _skills_projection()),
                                request=request, source="sqlite")
    if name not in PROFILE_DOC_NAMES:
        raise APIError(
            "E_NOT_FOUND",
            f"unknown profile doc: {name} (expected one of {_DOC_ORDER})",
            http_status=404,
            source="sqlite",
        )
    doc = get_agent_config_store().get_profile_doc(name)
    return success_envelope(_editable_doc_dict(doc), request=request, source="sqlite")


@router.get("/profile/history", dependencies=[Depends(verify_cf_access)])
async def list_profile_history(
    request: Request,
    doc_name: Optional[str] = Query(None, alias="docName"),
    limit: int = Query(50, ge=1, le=500),
):
    """profile 文档版本历史（DESC，可按 docName 过滤）。供 rollback / 审计。"""
    if doc_name is not None and doc_name not in PROFILE_DOC_NAMES:
        raise APIError(
            "E_INVALID_ARG",
            f"docName must be one of {list(PROFILE_DOC_NAMES)}",
            http_status=400,
            source="sqlite",
        )
    entries = get_agent_config_store().list_profile_history(doc_name, limit=limit)
    data = [
        {
            "id": e.id,
            "docName": e.doc_name,
            "oldHash": e.old_hash,
            "newHash": e.new_hash,
            "changedBy": e.changed_by,
            "sessionId": e.session_id,
            "messageId": e.message_id,
            "createdAt": e.created_at,
        }
        for e in entries
    ]
    return success_envelope({"history": data}, request=request, source="sqlite",
                            meta_extra={"count": len(data)})
