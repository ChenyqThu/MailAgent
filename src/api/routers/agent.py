"""agent 配置面路由 — /api/agent/* (Phase -1 / 0A capability & context foundation).

Standing Context 文档（SOUL/AGENT/RULES/USER 可编辑 + MEMORY/SKILLS 投影）的读端点 +
版本历史。owner-only（本机用户的 agent 配置）→ ``Depends(verify_cf_access)``，**不**挂
Bearer（Bearer 是 ``/api/skills`` 的外部 agent 通道，agent 改自身配置不走 scoped key）。

写端点（set/rollback）+ Settings 编辑 UI + agent profile 工具在 PR6；本路由只读 + graceful。
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.agent_config.projections import (
    memory_doc_projection,
    resolved_skills,
    skills_doc_projection,
)
from src.agent_config.store import (
    INSTALLABLE_SOURCE_TYPES,
    PROFILE_DOC_NAMES,
    get_agent_config_store,
)
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_chat_db, get_settings

router = APIRouter(prefix="/api/agent", tags=["agent"])


def _manifest_skill_names() -> set[str]:
    """当前 manifest 里的全部 skill 名（builtin + installed），用于 enable 端点的存在性校验。"""
    from src.skills.registry import build_manifest

    return {s.name for s in build_manifest(None).skills}

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
    """MEMORY.md 投影（复用 ChatDb.memory_summary）。best-effort：库缺/锁 → 空占位。

    M5a-3：MAILAGENT_MEMORY_KV_RETIRE on → kv dump 退役 → MEMORY 段干净省略（直接返 ''）。
    🔴 不能走 ``memory_doc_projection('')`` —— 它对空 summary 返回 ``# MEMORY\\n\\n(No durable
    memory yet.)\\n`` 占位空壳（误导「还没记忆」），故 flag-on 显式跳过、直接返 ''。读侧改靠
    mem0 召回（M2）+ user.md 恒注入（M3）。flag-off → 字节级照旧（memory_doc_projection(summary)）。
    """
    if get_settings().memory_kv_retire_enabled:
        return ""
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


# ── profile 写（PR6 —— agent/用户经确认编辑 SOUL/AGENT/RULES/USER + rollback）──────────


@router.post("/profile/docs/{name}", dependencies=[Depends(verify_cf_access)])
async def write_profile_doc(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    """覆盖一个可编辑文档（SOUL/AGENT/RULES/USER）。RULES.md 过 validator（deny-list 拦截
    露骨的安全颠覆指令）。body = {content, updatedBy?, sessionId?, messageId?}。"""
    if name not in PROFILE_DOC_NAMES:
        raise APIError("E_NOT_FOUND", f"unknown or non-editable profile doc: {name}",
                       http_status=404, source="sqlite")
    raw = body or {}
    content = raw.get("content")
    if not isinstance(content, str) or not content.strip():
        raise APIError("E_INVALID_ARG", "body.content must be a non-empty string",
                       http_status=400, source="sqlite")
    updated_by = raw.get("updatedBy") if raw.get("updatedBy") in ("user", "agent_proposed") else "user"
    if name == "rules":
        # 安全 floor 结构上不可弱化（前端 prepend PRODUCT_SAFETY_FLOOR）；validator 是
        # belt-and-suspenders，拦截把「忽略前文 / 绕过确认」写进 RULES 的露骨尝试。
        from src.agent_config.validator import validate_rules_content

        reason = validate_rules_content(content)
        if reason:
            raise APIError("E_INVALID_ARG", reason, http_status=400, source="sqlite")
    doc = get_agent_config_store().set_profile_doc(
        name, content, updated_by=updated_by,
        session_id=raw.get("sessionId"), message_id=raw.get("messageId"),
    )
    return success_envelope(_editable_doc_dict(doc), request=request, source="sqlite")


@router.post("/profile/docs/{name}/rollback", dependencies=[Depends(verify_cf_access)])
async def rollback_profile_doc(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    """把文档回滚到某历史版本（按 targetHash 定位 content_snapshot）。body = {targetHash, updatedBy?}。"""
    if name not in PROFILE_DOC_NAMES:
        raise APIError("E_NOT_FOUND", f"unknown or non-editable profile doc: {name}",
                       http_status=404, source="sqlite")
    raw = body or {}
    target = raw.get("targetHash")
    if not isinstance(target, str) or not target:
        raise APIError("E_INVALID_ARG", "body.targetHash is required", http_status=400, source="sqlite")
    updated_by = raw.get("updatedBy") if raw.get("updatedBy") in ("user", "agent_proposed") else "user"
    try:
        doc = get_agent_config_store().rollback_profile_doc(
            name, target, updated_by=updated_by, session_id=raw.get("sessionId")
        )
    except KeyError as exc:
        raise APIError("E_NOT_FOUND", str(exc), http_status=404, source="sqlite") from exc
    return success_envelope(_editable_doc_dict(doc), request=request, source="sqlite")


# ── skill 管理（PR5 —— enablement 迁后端 + install/uninstall）────────────────────────


@router.get("/skills", dependencies=[Depends(verify_cf_access)])
async def list_agent_skills(request: Request):
    """Settings 面的解析后 skill 列表：manifest skill ⋈ store 启用覆盖 + source_type。"""
    from src.skills.registry import build_manifest

    store = get_agent_config_store()
    data = resolved_skills(build_manifest(None).skills, store)
    return success_envelope({"skills": data}, request=request, source="sqlite",
                            meta_extra={"count": len(data)})


@router.post("/skills/{name}/enabled", dependencies=[Depends(verify_cf_access)])
async def set_skill_enabled(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    """启用/禁用一个 skill（builtin 懒建覆盖行 / installed 更新行）。body = {enabled: bool}。"""
    raw = body or {}
    enabled = raw.get("enabled")
    if not isinstance(enabled, bool):
        raise APIError("E_INVALID_ARG", "body.enabled must be a JSON boolean",
                       http_status=400, source="sqlite")
    if name not in _manifest_skill_names():
        raise APIError("E_NOT_FOUND", f"unknown skill: {name}", http_status=404, source="sqlite")
    store = get_agent_config_store()
    # builtin skill 懒建 source_type='builtin'；installed skill 已有行 → set_enabled 只更 enabled。
    existing = store.get_skill(name)
    source_type = existing.source_type if existing else "builtin"
    store.set_enabled(name, enabled, source_type=source_type)
    return success_envelope({"name": name, "enabled": enabled}, request=request, source="sqlite")


@router.post("/skills", dependencies=[Depends(verify_cf_access)])
async def install_agent_skill(request: Request, body: Optional[dict[str, Any]] = None):
    """安装一个用户来源 skill。body = {name, sourceType, manifest, version?, sourceUri?,
    grantedScopes?, packageHash?, trusted?, enabled?}。grantedScopes 写时校验 ⊆ KNOWN_SCOPES。"""
    raw = body or {}
    name = raw.get("name")
    source_type = raw.get("sourceType")
    manifest = raw.get("manifest")
    if not isinstance(name, str) or not name.strip():
        raise APIError("E_INVALID_ARG", "body.name is required", http_status=400, source="sqlite")
    if source_type not in INSTALLABLE_SOURCE_TYPES:
        raise APIError("E_INVALID_ARG",
                       f"body.sourceType must be one of {list(INSTALLABLE_SOURCE_TYPES)}",
                       http_status=400, source="sqlite")
    if manifest is not None and not isinstance(manifest, dict):
        raise APIError("E_INVALID_ARG", "body.manifest must be an object", http_status=400,
                       source="sqlite")
    store = get_agent_config_store()
    try:
        skill = store.install_skill(
            name.strip(),
            source_type=source_type,
            manifest=manifest,
            manifest_version=raw.get("manifestVersion"),
            version=raw.get("version"),
            source_uri=raw.get("sourceUri"),
            granted_scopes=raw.get("grantedScopes"),
            package_hash=raw.get("packageHash"),
            trusted=bool(raw.get("trusted", False)),
            enabled=raw.get("enabled") if isinstance(raw.get("enabled"), bool) else None,
        )
    except ValueError as exc:  # 非法 scope / source_type
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc
    return success_envelope(
        {"name": skill.skill_name, "sourceType": skill.source_type},
        request=request, source="sqlite", status_code=201,
    )


@router.delete("/skills/{name}", dependencies=[Depends(verify_cf_access)])
async def uninstall_agent_skill(name: str, request: Request):
    """卸载一个 skill 行（installed → 卸载；builtin 懒行 → 回退代码默认）。幂等。"""
    removed = get_agent_config_store().uninstall_skill(name)
    return success_envelope({"name": name, "removed": removed}, request=request, source="sqlite")
