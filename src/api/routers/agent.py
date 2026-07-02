"""agent 配置面路由 — /api/agent/* (Phase -1 / 0A capability & context foundation).

Standing Context 文档（SOUL/AGENT/RULES/USER 可编辑 + MEMORY/SKILLS 投影）的读端点 +
版本历史。owner-only（本机用户的 agent 配置）→ ``Depends(verify_cf_access)``，**不**挂
Bearer（Bearer 是 ``/api/skills`` 的外部 agent 通道，agent 改自身配置不走 scoped key）。

写端点（set/rollback）+ Settings 编辑 UI + agent profile 工具在 PR6；本路由只读 + graceful。
"""

from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.agent_config.projections import (
    resolved_skills,
    skills_doc_projection,
)
from src.agent_config.store import (
    INSTALLABLE_SOURCE_TYPES,
    MEMORY_DOC_NAME,
    STORABLE_DOC_NAMES,
    get_agent_config_store,
)
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access

router = APIRouter(prefix="/api/agent", tags=["agent"])


def _manifest_skill_names() -> set[str]:
    """当前 manifest 里的全部 skill 名（builtin + installed），用于 enable 端点的存在性校验。"""
    from src.skills.registry import build_manifest

    return {s.name for s in build_manifest(None).skills}

# 文档展示顺序：5 个可编辑（soul/agent/rules/user/memory）+ SKILLS 投影。
# memory.md（task 07-01）是可编辑的**有界记忆**（auto-capture 自动改写 + 用户可手编），落
# agent_config.db 同一 profile-doc 存储层，但排除出 PROFILE_DOC_NAMES（不进 standing_context /
# profile_hash）——它单独经 /chat/config 的 memorySummary（MEMORY fence，untrusted 背景）注入。
_DOC_ORDER = list(STORABLE_DOC_NAMES) + ["skills"]


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


def _memory_budget() -> int:
    """memory.md 硬字符预算（config.memory_md_budget_chars，默认 5000）。lazy import 守
    chat.py 同款 lazy-config 纪律（裸 worktree / CI import self-check 不炸）。"""
    from src.config import config as cfg

    return cfg.memory_md_budget_chars


def _memory_doc_dict(doc: Any) -> dict[str, Any]:
    """memory.md doc dict = 可编辑 doc + ``budgetChars``（恒注入预算，前端显著显示长度/占比）。"""
    d = _editable_doc_dict(doc)
    d["budgetChars"] = _memory_budget()
    return d


def _skills_projection() -> str:
    """SKILLS.md 投影（manifest skills，PR3 后含 installed）。best-effort：失败 → 空占位。"""
    try:
        from src.skills.registry import build_manifest

        return skills_doc_projection(build_manifest(None).skills)
    except Exception:  # noqa: BLE001 — projection best-effort
        return skills_doc_projection([])


@router.get("/profile/docs", dependencies=[Depends(verify_cf_access)])
async def list_profile_docs(request: Request):
    """列出全部文档：4 份可信身份 + memory.md（可编辑，带预算，seed-on-read）+ SKILLS 投影。"""
    store = get_agent_config_store()
    docs = [_editable_doc_dict(d) for d in store.list_profile_docs()]  # soul/agent/rules/user
    docs.append(_memory_doc_dict(store.get_profile_doc(MEMORY_DOC_NAME)))
    docs.append(_projection_doc_dict("skills", _skills_projection()))
    return success_envelope({"docs": docs}, request=request, source="sqlite",
                            meta_extra={"count": len(docs)})


@router.get("/profile/docs/{name}", dependencies=[Depends(verify_cf_access)])
async def get_profile_doc(name: str, request: Request):
    """读单个文档。skills → 投影；soul/agent/rules/user/memory → store（seed-on-read）。"""
    if name == "skills":
        return success_envelope(_projection_doc_dict("skills", _skills_projection()),
                                request=request, source="sqlite")
    if name not in STORABLE_DOC_NAMES:
        raise APIError(
            "E_NOT_FOUND",
            f"unknown profile doc: {name} (expected one of {_DOC_ORDER})",
            http_status=404,
            source="sqlite",
        )
    doc = get_agent_config_store().get_profile_doc(name)
    if name == MEMORY_DOC_NAME:
        return success_envelope(_memory_doc_dict(doc), request=request, source="sqlite")
    return success_envelope(_editable_doc_dict(doc), request=request, source="sqlite")


@router.get("/profile/history", dependencies=[Depends(verify_cf_access)])
async def list_profile_history(
    request: Request,
    doc_name: Optional[str] = Query(None, alias="docName"),
    limit: int = Query(50, ge=1, le=500),
):
    """profile 文档版本历史（DESC，可按 docName 过滤）。供 rollback / 审计。"""
    if doc_name is not None and doc_name not in STORABLE_DOC_NAMES:
        raise APIError(
            "E_INVALID_ARG",
            f"docName must be one of {list(STORABLE_DOC_NAMES)}",
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
    """覆盖一个可编辑文档（SOUL/AGENT/RULES/USER/memory）。RULES.md 过 validator（deny-list
    拦截露骨的安全颠覆指令）；memory.md 过硬字符预算（恒注入每轮 prompt，拒超预算防撑爆）。
    body = {content, updatedBy?, sessionId?, messageId?}。"""
    if name not in STORABLE_DOC_NAMES:
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
    elif name == MEMORY_DOC_NAME:
        # memory.md 恒注入每轮 system prompt（MEMORY fence）→ enforce 硬字符预算，防用户粘贴
        # 巨文撑爆每轮 prompt。非 RULES → **不**套 validate_rules_content（那是身份约束校验）；
        # memory 作 untrusted 背景注入、结构上无法弱化 PRODUCT_SAFETY_FLOOR。
        budget = _memory_budget()
        if len(content) > budget:
            raise APIError(
                "E_INVALID_ARG",
                f"memory.md exceeds the {budget}-character budget (got {len(content)}); "
                "trim it before saving",
                http_status=400, source="sqlite",
            )
    doc = get_agent_config_store().set_profile_doc(
        name, content, updated_by=updated_by,
        session_id=raw.get("sessionId"), message_id=raw.get("messageId"),
    )
    if name == MEMORY_DOC_NAME:
        return success_envelope(_memory_doc_dict(doc), request=request, source="sqlite")
    return success_envelope(_editable_doc_dict(doc), request=request, source="sqlite")


@router.post("/profile/docs/{name}/rollback", dependencies=[Depends(verify_cf_access)])
async def rollback_profile_doc(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    """把文档回滚到某历史版本（按 targetHash 定位 content_snapshot）。body = {targetHash, updatedBy?}。

    回滚**不**重复 budget 校验：历史快照落库时已在预算内（capture 截断 / 写端点 guard），恢复
    已知良好版本是显式用户操作；即便后来调小了预算，也允许恢复历史（下轮 capture 会自动再压回）。
    RULES 例外（S1 R2）：目标快照仍过 validate_rules_content（store 层），拒把越权版本回滚复活。"""
    if name not in STORABLE_DOC_NAMES:
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
    except ValueError as exc:
        # S1 R2 — RULES 回滚目标含越权指令（store 层 validate_rules_content 拒）→ 400。
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc
    if name == MEMORY_DOC_NAME:
        return success_envelope(_memory_doc_dict(doc), request=request, source="sqlite")
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


# ── skill 供应链（S2 W2 —— 两段式安装：fetch → confirm，+ 全清理 uninstall）─────────────────
# owner-only（verify_cf_access）。gateway W4 的 skill_install/confirm/uninstall 工具经这三个端点执行；
# Settings 安装 UI 也走同一族。业务权威在 Python（下载 SSRF 硬化 / 安全解包 / hash 实算 / re-hash
# TOCTOU 校验全在此），gateway 只做 schema + 审批接线。


# SKILL.md 节选上限（preview 卡片显示；全文经 W4 skill_read 围栏读）。
_SKILL_MD_EXCERPT_MAX = 4096


@router.post("/skills/fetch", dependencies=[Depends(verify_cf_access)])
async def fetch_agent_skill(request: Request, body: Optional[dict[str, Any]] = None):
    """两段式第一段：下载（URL）/ 导入（本地 zip 或目录）skill 包 → quarantine → 安全解包 + manifest
    v2 校验 + hash。**不安装**（仅落 quarantine）。body = {sourceUrl?} 或 {localPath?}（二选一）。

    返回 preview：quarantineId + packageHash + 文件表（路径+每文件 sha256）+ manifest 摘要 + 声明的
    secret 名 + SKILL.md 节选。owner 审阅后带 quarantineId + packageHash + files 调 /confirm 真安装。"""
    from src.skills.pack_fetch import fetch_pack
    from src.skills.pack_verify import PackError

    raw = body or {}
    source_url = raw.get("sourceUrl")
    local_path = raw.get("localPath")
    if bool(source_url) == bool(local_path):
        raise APIError(
            "E_INVALID_ARG",
            "exactly one of body.sourceUrl / body.localPath is required",
            http_status=400,
            source="sqlite",
        )
    if source_url is not None and not isinstance(source_url, str):
        raise APIError("E_INVALID_ARG", "body.sourceUrl must be a string", http_status=400, source="sqlite")
    if local_path is not None and not isinstance(local_path, str):
        raise APIError("E_INVALID_ARG", "body.localPath must be a string", http_status=400, source="sqlite")

    try:
        res = fetch_pack(
            source_url=source_url if source_url else None,
            local_path=local_path if local_path else None,
        )
    except PackError as exc:
        # 结构化 code（E_PACK_* / E_UPSTREAM / E_CONTENT_TYPE …）+ 各自 http_status 透传，供 W4 壳展示。
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc

    m = res.manifest_dict
    secret_names = [
        s.get("name") for s in (m.get("secrets") or []) if isinstance(s, dict) and s.get("name")
    ]
    preview = {
        "quarantineId": res.quarantine_id,
        "sourceType": res.source_type,
        "sourceUri": res.source_uri,
        "packageHash": res.package_hash,
        "files": res.files,  # {relpath: sha256} —— confirm 时原样回传作 expectedFiles
        "manifest": {
            "name": m.get("name"),
            "type": m.get("type"),
            "version": m.get("version"),
            "title": m.get("title"),
            "description": m.get("description"),
            "entryHint": m.get("entry_hint"),
            "manifestVersion": m.get("manifest_version"),
        },
        "secretNames": secret_names,
        "skillMdExcerpt": res.skill_md[:_SKILL_MD_EXCERPT_MAX],
    }
    return success_envelope(preview, request=request, source="sqlite")


@router.post("/skills/confirm", dependencies=[Depends(verify_cf_access)])
async def confirm_agent_skill(request: Request, body: Optional[dict[str, Any]] = None):
    """两段式第二段：按 quarantineId **重算** quarantine content 的 hash 比对 owner 批准的事实
    （expectedPackageHash + expectedFiles，TOCTOU 防 preview→落盘间被替换）→ 落 agent_skills 行 →
    atomic rename content 到 <skills>/<name>。hash 不符 → 409。body = {quarantineId, expectedPackageHash,
    expectedFiles?}。"""
    from src.skills.pack_fetch import confirm_pack, promote_content
    from src.skills.pack_verify import PackError

    raw = body or {}
    qid = raw.get("quarantineId")
    expected_hash = raw.get("expectedPackageHash")
    expected_files = raw.get("expectedFiles")
    if not isinstance(qid, str) or not qid:
        raise APIError("E_INVALID_ARG", "body.quarantineId is required", http_status=400, source="sqlite")
    if not isinstance(expected_hash, str) or not expected_hash:
        raise APIError(
            "E_INVALID_ARG", "body.expectedPackageHash is required", http_status=400, source="sqlite"
        )
    if expected_files is not None and not isinstance(expected_files, dict):
        raise APIError("E_INVALID_ARG", "body.expectedFiles must be an object", http_status=400, source="sqlite")

    try:
        result = confirm_pack(qid, expected_hash, expected_files)
    except PackError as exc:
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc

    store = get_agent_config_store()
    # 先落新行数据（含 manifest/hash/files），再 atomic swap 目录（升级语义，失败不留半成品）。
    try:
        store.install_skill(
            result.name,
            source_type=result.source_type,
            manifest=result.manifest_dict,
            manifest_version=result.manifest_version,
            version=result.manifest_dict.get("version"),
            source_uri=result.source_uri,
            package_hash=result.package_hash,
            files_json=json.dumps(result.files, ensure_ascii=False, sort_keys=True),
        )
    except ValueError as exc:  # slug / manifest.name 不一致 / 非法 scope
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc

    try:
        promote_content(qid, result.name)
    except PackError as exc:
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc

    return success_envelope(
        {"name": result.name, "sourceType": result.source_type, "packageHash": result.package_hash},
        request=request,
        source="sqlite",
        status_code=201,
    )


@router.post("/skills/uninstall", dependencies=[Depends(verify_cf_access)])
async def uninstall_agent_skill_full(request: Request, body: Optional[dict[str, Any]] = None):
    """全清理卸载（S2 W2）：删 agent_skills 行 + 删 <skills>/<name>/ 落盘目录 + 删 skill_secrets 行。
    body = {name}。密钥 Keychain master key 不动（W3 拥有加解密生命周期）。幂等。"""
    from src.skills.pack_fetch import remove_skill_dir

    raw = body or {}
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise APIError("E_INVALID_ARG", "body.name is required", http_status=400, source="sqlite")
    name = name.strip()
    store = get_agent_config_store()
    removed_row = store.uninstall_skill(name)
    removed_dir = remove_skill_dir(name)
    removed_secrets = store.delete_skill_secrets(name)
    return success_envelope(
        {
            "name": name,
            "removed": removed_row or removed_dir,
            "removedDir": removed_dir,
            "removedSecrets": removed_secrets,
        },
        request=request,
        source="sqlite",
    )
