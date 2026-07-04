"""agent 配置面路由 — /api/agent/* (Phase -1 / 0A capability & context foundation).

Standing Context 文档（SOUL/AGENT/RULES/USER 可编辑 + MEMORY/SKILLS 投影）的读端点 +
版本历史。owner-only（本机用户的 agent 配置）→ ``Depends(verify_cf_access)``，**不**挂
Bearer（Bearer 是 ``/api/skills`` 的外部 agent 通道，agent 改自身配置不走 scoped key）。

写端点（set/rollback）+ Settings 编辑 UI + agent profile 工具在 PR6；本路由只读 + graceful。
"""

from __future__ import annotations

import json
import os
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
from src.api.auth import verify_cf_access, verify_local_token

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


@router.get("/skills/entrypoints", dependencies=[Depends(verify_cf_access)])
async def list_skill_entrypoints(request: Request):
    """Settings per-agent「自动化策略」exec 规则构造器的数据源（S5 W5b，ADR-004 D5）。

    只列**供应链 installed** skill（``files_json`` 非空 = confirm 落库事实；builtin/声明行
    无逐文件清单，构造不出 pinned-entrypoint）：``{name, dir, files}`` —— 前端据此组装
    matcher（``argv[1]`` pin = ``dir/relpath``、可选 ``cwd_scope`` pin = ``dir``），不在 TS
    手抄 skills root。flag off → 404（该面只服务 per-agent 建规，S4 纪律）。
    """
    if not _custom_agents_enabled():
        raise APIError("E_NOT_FOUND", "custom agents feature is disabled",
                       http_status=404, source="sqlite")
    from src.skills.pack_fetch import skill_dir

    out: list[dict[str, Any]] = []
    for row in get_agent_config_store().list_skills():
        if not row.files_json:
            continue
        try:
            files = json.loads(row.files_json)
        except (ValueError, TypeError):
            continue
        if not isinstance(files, dict) or not files:
            continue
        out.append({
            "name": row.skill_name,
            "dir": skill_dir(row.skill_name),
            "files": sorted(files.keys()),
        })
    out.sort(key=lambda x: x["name"])
    return success_envelope({"skills": out}, request=request, source="sqlite",
                            meta_extra={"count": len(out)})


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


def _full_uninstall(name: str) -> dict[str, Any]:
    """全清理卸载单源（W4 收口）：删 agent_skills 行 + 删 ``<skills>/<name>/`` 落盘目录 + 删
    skill_secrets 行。``POST /skills/uninstall`` 与旧 ``DELETE /skills/{name}`` 的 pack 分支共用
    —— 两条路径必须同一份清理集，否则同名重装会收养 stale secrets（W2 review P2-2）。幂等。"""
    from src.skills.pack_fetch import remove_skill_dir

    store = get_agent_config_store()
    removed_row = store.uninstall_skill(name)
    removed_dir = remove_skill_dir(name)
    removed_secrets = store.delete_skill_secrets(name)
    return {
        "name": name,
        "removed": removed_row or removed_dir,
        "removedDir": removed_dir,
        "removedSecrets": removed_secrets,
    }


@router.delete("/skills/{name}", dependencies=[Depends(verify_cf_access)])
async def uninstall_agent_skill(name: str, request: Request):
    """卸载一个 skill 行。**deprecated-for-packs**（W4 收口，W2 review P2-2）：pack 安装行
    （判据 = ``files_json`` 非空 —— 只有供应链 confirm 会写它；document/mcp 声明行与 builtin
    懒行都不写）→ 委托与 ``POST /skills/uninstall`` 相同的全清路径（行+目录+secrets），防
    「仅删行 → 同名重装收养 stale secrets/目录」。非 pack 行为不变：builtin 懒行删除 = 回退
    代码默认；document/mcp 声明行只删行（本就无目录/secrets 生命周期）。幂等。"""
    store = get_agent_config_store()
    existing = store.get_skill(name)
    if existing is not None and existing.files_json:
        return success_envelope(_full_uninstall(name), request=request, source="sqlite")
    removed = store.uninstall_skill(name)
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


# ── per-skill 密钥（S2 W3 —— Settings 后端；UI 是 W4）──────────────────────────────────
# owner-only（verify_cf_access）。值经 Fernet 加密落 agent_config.db（master key 单条进 Keychain），
# **永不**回显：GET 只出名字 + updated_at；PUT 写后不返回值；脚本执行时经 exec 端点注入子进程 env
# （src/agent_config/secrets.py + src/api/routers/exec.py）。secret 名过 env-regex + reserved deny
# （防覆盖执行环境 / 冒充全局密钥），skill 存在性对齐 set_skill_enabled 的 manifest 校验。


@router.get("/skills/{name}/secrets", dependencies=[Depends(verify_cf_access)])
async def list_skill_secrets(name: str, request: Request):
    """列一个 skill 已存储的密钥 —— **只名字 + updatedAt，永无值**（Settings 抽屉 write-only 蒙版）。"""
    meta = get_agent_config_store().skill_secret_meta(name)
    data = [{"name": n, "updatedAt": ts} for n, ts in meta]
    return success_envelope(
        {"secrets": data}, request=request, source="sqlite", meta_extra={"count": len(data)}
    )


@router.put(
    "/skills/{name}/secrets/{secret_name}", dependencies=[Depends(verify_cf_access)]
)
async def set_skill_secret(
    name: str, secret_name: str, request: Request, body: Optional[dict[str, Any]] = None
):
    """写/替换一个 per-skill 密钥（Fernet 加密落库）。body = {value}（write-only，响应**不回显值**）。
    双重校验：skill 存在（manifest 名） + secret 名合法（env-regex + reserved deny）。"""
    from src.agent_config.secrets import set_secret
    from src.skills.secret_names import validate_secret_name

    if name not in _manifest_skill_names():
        raise APIError("E_NOT_FOUND", f"unknown skill: {name}", http_status=404, source="sqlite")
    reason = validate_secret_name(secret_name)
    if reason:
        raise APIError("E_INVALID_ARG", reason, http_status=400, source="sqlite")
    raw = body or {}
    value = raw.get("value")
    if not isinstance(value, str) or not value:
        raise APIError("E_INVALID_ARG", "body.value must be a non-empty string",
                       http_status=400, source="sqlite")
    set_secret(name, secret_name, value)  # 值不进响应/日志
    meta = dict(get_agent_config_store().skill_secret_meta(name))
    return success_envelope(
        {"name": name, "secretName": secret_name, "updatedAt": meta.get(secret_name)},
        request=request, source="sqlite",
    )


@router.delete(
    "/skills/{name}/secrets/{secret_name}", dependencies=[Depends(verify_cf_access)]
)
async def delete_skill_secret(name: str, secret_name: str, request: Request):
    """删一个 per-skill 密钥。幂等（无行 removed=false）。secret 名过校验（防畸形 path 触发 500）。"""
    from src.agent_config.secrets import delete_secret
    from src.skills.secret_names import validate_secret_name

    reason = validate_secret_name(secret_name)
    if reason:
        raise APIError("E_INVALID_ARG", reason, http_status=400, source="sqlite")
    removed = delete_secret(name, secret_name)
    return success_envelope(
        {"name": name, "secretName": secret_name, "removed": removed},
        request=request, source="sqlite",
    )


@router.post("/skills/uninstall", dependencies=[Depends(verify_cf_access)])
async def uninstall_agent_skill_full(request: Request, body: Optional[dict[str, Any]] = None):
    """全清理卸载（S2 W2）：删 agent_skills 行 + 删 <skills>/<name>/ 落盘目录 + 删 skill_secrets 行。
    body = {name}。密钥 Keychain master key 不动（W3 拥有加解密生命周期）。幂等。W4 起清理集
    收敛进 ``_full_uninstall``（与旧 DELETE 的 pack 分支单源）。"""
    raw = body or {}
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise APIError("E_INVALID_ARG", "body.name is required", http_status=400, source="sqlite")
    return success_envelope(_full_uninstall(name.strip()), request=request, source="sqlite")


# ── skill 供应链读面（S2 W4 —— 审批卡服务端事实渲染 + skill_read 文档 + per-skill 配置）────────


@router.get("/skills/quarantine/{qid}", dependencies=[Depends(verify_cf_access)])
async def get_quarantine_facts(qid: str, request: Request):
    """SkillInstallConfirmCard 的服务端事实源（ADR-002 §4：模型无法在卡上谎报包内容）——按
    quarantine_id **重算** ``verify_content_dir``（卡上 hash = 盘上真相，非读 meta 缓存），返回
    与 fetch preview 同形状的事实。qid 非法 → 400；quarantine 不存在 → 404。"""
    from src.skills.pack_fetch import _quarantine_dir, _read_meta
    from src.skills.pack_verify import PackError, verify_content_dir

    try:
        qdir = _quarantine_dir(qid)  # _QID_RE + realpath 含界闸（pack_fetch 单源）
    except PackError as exc:
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc
    content = os.path.join(qdir, "content")
    if not os.path.isdir(content):
        raise APIError("E_NOT_FOUND", f"quarantine not found: {qid}", http_status=404, source="sqlite")
    try:
        vp = verify_content_dir(content)  # 重算 —— 与 fetch/confirm 同一算法
    except PackError as exc:
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc

    meta = _read_meta(qdir)
    m = vp.manifest_dict
    secret_names = [
        s.get("name") for s in (m.get("secrets") or []) if isinstance(s, dict) and s.get("name")
    ]
    return success_envelope(
        {
            "quarantineId": qid,
            "sourceType": meta.get("source_type"),
            "sourceUri": meta.get("source_uri"),
            "packageHash": vp.package_hash,
            "files": vp.files,
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
            "skillMdExcerpt": vp.skill_md[:_SKILL_MD_EXCERPT_MAX],
        },
        request=request,
        source="sqlite",
    )


# SKILL.md 服务器侧读取上限（防怪物文件一口气进内存/响应；TS 进模型上下文前再截 32KB + 围栏）。
_SKILL_DOC_CAP_BYTES = 64 * 1024
# config.json 写入上限。
_SKILL_CONFIG_CAP_BYTES = 64 * 1024


def _installed_skill_dir(name: str) -> str:
    """name 过 ``_SKILL_NAME_RE`` + realpath 含界 → ``<skills>/<name>`` 绝对路径。非法名 → 400。"""
    from src.agent_config.store import _SKILL_NAME_RE
    from src.skills.pack_fetch import skill_dir, skills_data_root

    if not _SKILL_NAME_RE.match(name or ""):
        raise APIError("E_INVALID_ARG", f"invalid skill name: {name!r}", http_status=400, source="sqlite")
    d = skill_dir(name)
    root = os.path.realpath(skills_data_root())
    rd = os.path.realpath(d)
    if rd != root and not rd.startswith(root + os.sep):  # belt-and-suspenders（正则已挡 / 与 .）
        raise APIError("E_INVALID_ARG", "skill name escapes skills root", http_status=400, source="sqlite")
    return d


@router.get("/skills/{name}/doc", dependencies=[Depends(verify_cf_access)])
async def get_skill_doc(name: str, request: Request):
    """读一个已落盘 skill 的 SKILL.md **原文**（W4 ``skill_read`` 工具的数据源）。第三方文本的
    围栏（``UNTRUSTED_SKILL_DOC`` + 32KB 截断 + 警示头）是 TS 壳进模型上下文时的职责 —— 本端点
    不围栏（Settings 等 owner 面也读原文）。服务器侧 cap 64KB 防怪物文件。无文件 → 404。"""
    d = _installed_skill_dir(name)
    path = os.path.join(d, "SKILL.md")
    if not os.path.isfile(path):
        raise APIError("E_NOT_FOUND", f"skill doc not found: {name}", http_status=404, source="sqlite")
    try:
        with open(path, "rb") as f:
            raw = f.read(_SKILL_DOC_CAP_BYTES + 1)
    except OSError as exc:
        raise APIError("E_INTERNAL", f"cannot read skill doc: {exc}", http_status=500, source="sqlite") from exc
    truncated = len(raw) > _SKILL_DOC_CAP_BYTES
    content = raw[:_SKILL_DOC_CAP_BYTES].decode("utf-8", errors="replace")
    return success_envelope(
        {"name": name, "content": content, "truncated": truncated},
        request=request,
        source="sqlite",
    )


@router.get("/skills/{name}/config", dependencies=[Depends(verify_cf_access)])
async def get_skill_config(name: str, request: Request):
    """读一个已安装 skill 的非敏感配置 ``<skills>/<name>/config.json``（明文 owner 面，脚本共读；
    密钥**不在**这 —— 密钥走 W3 的 secrets 端点/Fernet）。skill 目录不存在 → 404；无 config.json
    → 空配置 ``{}``。W4b Settings 消费。"""
    d = _installed_skill_dir(name)
    if not os.path.isdir(d):
        raise APIError("E_NOT_FOUND", f"skill not installed: {name}", http_status=404, source="sqlite")
    path = os.path.join(d, "config.json")
    config: dict[str, Any] = {}
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                config = data
        except (OSError, json.JSONDecodeError):
            config = {}  # 坏文件 → 空配置（owner 可 PUT 覆盖修复）
    return success_envelope({"name": name, "config": config}, request=request, source="sqlite")


@router.put("/skills/{name}/config", dependencies=[Depends(verify_cf_access)])
async def put_skill_config(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    """写一个已安装 skill 的非敏感配置（整体覆盖 ``config.json``）。body 必须是 JSON object 且
    序列化 ≤64KB；skill 目录不存在 → 404。"""
    d = _installed_skill_dir(name)
    if not os.path.isdir(d):
        raise APIError("E_NOT_FOUND", f"skill not installed: {name}", http_status=404, source="sqlite")
    if not isinstance(body, dict):
        raise APIError("E_INVALID_ARG", "body must be a JSON object", http_status=400, source="sqlite")
    serialized = json.dumps(body, ensure_ascii=False, sort_keys=True)
    if len(serialized.encode("utf-8")) > _SKILL_CONFIG_CAP_BYTES:
        raise APIError(
            "E_INVALID_ARG",
            f"config exceeds {_SKILL_CONFIG_CAP_BYTES} bytes",
            http_status=400,
            source="sqlite",
        )
    try:
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            f.write(serialized)
    except OSError as exc:
        raise APIError("E_INTERNAL", f"cannot write config: {exc}", http_status=500, source="sqlite") from exc
    return success_envelope({"name": name, "config": body}, request=request, source="sqlite")


# ── exec 策略白名单（S2 W1 —— PolicyRule CRUD + evaluate；S5 ADR-004 扩 per-agent）──────────
# 结构化白名单规则（ADR-001 §6 D4）：owner 经审批卡「总是允许」/ Settings 管理页产生，模型**无**
# 创建通道（policy_rules 不暴露任何 gateway 工具）。evaluate 供 gateway W1b 的 needsApproval 前置调用
# 决定免卡；exec 端点内部也调它作审计透传。业务权威在 Python，评估 fail-closed（异常→ask）。
# S5 per-agent（ADR-004 §3.3/§4.3）：create 收 agentId → headless 规则分支（flag 门控 + 归属校验 +
# context_mode 从 agent trigger.kind 派生 + exec 只认 pinned-entrypoint 形状）；全局（无 agentId）
# 分支词汇与语义 S2 逐字不变。


def _custom_agents_enabled() -> bool:
    """读 ``MAILAGENT_CUSTOM_AGENTS_ENABLED``（对齐 agent_runs 路由的 lazy 读法）。异常 →
    fail-closed False。"""
    from src.api.deps import get_settings

    try:
        return bool(get_settings().custom_agents_enabled)
    except Exception:  # noqa: BLE001 — 配置读失败 → 保守当 feature off
        return False


# per-agent 规则的 capability 面（ADR-004 V1）：domain_write（D1 免卡）+ exec（D2 pinned-entrypoint）。
# file_read/file_write/web 不在 V1 headless 设计面（web 全不引入 —— D3；file 族无形状约束设计），
# 建规拒 —— 需要时随对应 grant 键另立 ADR。
_PER_AGENT_CAPABILITIES: tuple[str, ...] = ("domain_write", "exec")


def _derive_rule_context_mode(agent: dict[str, Any]) -> str:
    """per-agent 规则的 context_mode **只**从 agent trigger.kind 派生（ADR-004 §3.3：表单/请求
    不可选 —— 用户没有机会配出跨上下文规则）。与 gateway deriveContextMode 同表：
    email_filter → untrusted_trigger / cron → cron_headless。坏 trigger → ValueError（400）。"""
    from src.agents.trigger import parse_trigger

    trig = parse_trigger(agent.get("trigger_json"))  # TriggerValidationError（ValueError）on 坏配置
    return "cron_headless" if trig.kind == "cron" else "untrusted_trigger"


def _policy_rule_dict(r: Any) -> dict[str, Any]:
    from src.agent_config.policy import rule_is_dangerously_wide

    return {
        "id": r.id,
        "capability": r.capability,
        "matcher": r.matcher,
        "contextMode": r.context_mode,
        "agentId": r.agent_id,
        "enabled": r.enabled,
        "note": r.note,
        "createdAt": r.created_at,
        "lastUsedAt": r.last_used_at,
        "useCount": r.use_count,
        # 危险宽规则（危险 argv0 + {any} 通配）标红供 W1b UI 警告——入库不拒（owner 可手动放宽）。
        "dangerous": rule_is_dangerously_wide(r.matcher),
    }


@router.get("/policy/rules", dependencies=[Depends(verify_cf_access)])
async def list_policy_rules(
    request: Request,
    capability: Optional[str] = Query(default=None),
    context_mode: Optional[str] = Query(default=None, alias="contextMode"),
    agent_id: Optional[str] = Query(default=None, alias="agentId"),
):
    """列策略规则（可选按 capability / contextMode / agentId 过滤），最新在前，带 dangerous 标志。
    agentId 缺省 = 全部行（现状）；有值 = 该 agent 的 per-agent 规则（Settings per-agent 面用）。"""
    store = get_agent_config_store()
    rules = store.list_policy_rules(
        capability=capability, context_mode=context_mode, agent_id=agent_id
    )
    data = [_policy_rule_dict(r) for r in rules]
    return success_envelope(
        {"rules": data}, request=request, source="sqlite", meta_extra={"count": len(data)}
    )


@router.post("/policy/rules", dependencies=[Depends(verify_cf_access)])
async def create_policy_rule(request: Request, body: Optional[dict[str, Any]] = None):
    """建一条结构化白名单规则。body = {capability, matcher, contextMode?, note?, agentId?}。

    无 agentId（全局/manual 分支，S2 语义逐字不变）：matcher 经 parse_matcher 校验（非法 →
    422）；contextMode 默认 manual_chat；capability 限 S2 四族（domain_write 是 per-agent 专属）。

    有 agentId（per-agent headless 分支，ADR-004 §3.3/§4.3）：
      - flag ``MAILAGENT_CUSTOM_AGENTS_ENABLED`` off → 404（S4 纪律，feature 不存在）；
      - agentId 须指向 sync_store 现存 ``type='custom'`` agent（拒空串/悬空归属，codex P1-5）；
      - contextMode **从 agent trigger.kind 派生**，请求显式传 → 400（表单不可选，防跨上下文规则）；
      - capability 限 domain_write / exec；exec matcher 须过 pinned-entrypoint 形状闸
        （raw ``{any}`` / 非 installed-skill entrypoint → 400，evaluate 侧另有 skip 复核双防线）。
    """
    import json

    from src.agent_config.policy import (
        CAPABILITIES,
        CONTEXT_MODES,
        headless_exec_rule_problem,
        parse_matcher,
    )

    raw = body or {}
    capability = raw.get("capability")
    matcher = raw.get("matcher")
    note = raw.get("note")
    agent_id = raw.get("agentId")
    if capability not in CAPABILITIES:
        raise APIError("E_INVALID_ARG", f"capability must be one of {list(CAPABILITIES)}",
                       http_status=400, source="sqlite")
    if not isinstance(matcher, dict):
        raise APIError("E_INVALID_ARG", "matcher must be an object", http_status=400, source="sqlite")
    if note is not None and not isinstance(note, str):
        raise APIError("E_INVALID_ARG", "note must be a string", http_status=400, source="sqlite")

    if agent_id is not None:
        # ── per-agent headless 分支（ADR-004）────────────────────────────────
        if not _custom_agents_enabled():
            raise APIError("E_NOT_FOUND", "custom agents feature is disabled",
                           http_status=404, source="sqlite")
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise APIError("E_INVALID_ARG", "agentId must be a non-empty string",
                           http_status=400, source="sqlite")
        agent_id = agent_id.strip()
        if capability not in _PER_AGENT_CAPABILITIES:
            raise APIError(
                "E_INVALID_ARG",
                f"per-agent rules only support capabilities {list(_PER_AGENT_CAPABILITIES)}",
                http_status=400, source="sqlite",
            )
        if "contextMode" in raw:
            raise APIError(
                "E_INVALID_ARG",
                "contextMode is derived from the agent trigger for per-agent rules; do not pass it",
                http_status=400, source="sqlite",
            )
        from src.api.deps import get_report_store

        agent = get_report_store().get_agent(agent_id)
        if agent is None or (agent.get("type") or "") != "custom":
            raise APIError(
                "E_INVALID_ARG",
                f"agentId must reference an existing custom agent, got {agent_id!r}",
                http_status=400, source="sqlite",
            )
        try:
            context_mode = _derive_rule_context_mode(agent)
        except ValueError as exc:
            raise APIError(
                "E_INVALID_ARG",
                f"agent {agent_id!r} has invalid trigger_json ({exc}); fix the agent first",
                http_status=400, source="sqlite",
            ) from exc
    else:
        # ── 全局（manual）分支 —— S2 语义逐字不变 ─────────────────────────────
        if capability == "domain_write":
            raise APIError(
                "E_INVALID_ARG",
                "domain_write rules are per-agent only (agentId required)",
                http_status=400, source="sqlite",
            )
        context_mode = raw.get("contextMode", "manual_chat")
        if context_mode not in CONTEXT_MODES:
            raise APIError("E_INVALID_ARG", f"contextMode must be one of {list(CONTEXT_MODES)}",
                           http_status=400, source="sqlite")

    store = get_agent_config_store()
    try:
        parsed = parse_matcher(capability, matcher)
    except Exception as exc:  # noqa: BLE001 — pydantic ValidationError / ValueError → 422
        raise APIError("E_INVALID_ARG", f"invalid matcher: {exc}", http_status=422, source="sqlite") from exc
    if agent_id is not None and capability == "exec":
        problem = headless_exec_rule_problem(store, parsed)
        if problem is not None:
            raise APIError(
                "E_INVALID_ARG", f"invalid headless exec rule: {problem}",
                http_status=400, source="sqlite",
            )
    rule = store.create_policy_rule(
        capability,
        json.dumps(matcher, ensure_ascii=False, sort_keys=True),
        context_mode=context_mode,
        note=note,
        agent_id=agent_id,
    )
    return success_envelope(_policy_rule_dict(rule), request=request, source="sqlite", status_code=201)


@router.patch("/policy/rules/{rule_id}", dependencies=[Depends(verify_cf_access)])
async def patch_policy_rule(rule_id: int, request: Request, body: Optional[dict[str, Any]] = None):
    """启用/停用 + 改备注（matcher 不可 patch —— 放宽 = 删旧建新）。不存在 → 404。"""
    raw = body or {}
    enabled = raw.get("enabled")
    note = raw.get("note")
    if enabled is not None and not isinstance(enabled, bool):
        raise APIError("E_INVALID_ARG", "enabled must be a boolean", http_status=400, source="sqlite")
    if note is not None and not isinstance(note, str):
        raise APIError("E_INVALID_ARG", "note must be a string", http_status=400, source="sqlite")
    rule = get_agent_config_store().set_policy_rule(rule_id, enabled=enabled, note=note)
    if rule is None:
        raise APIError("E_NOT_FOUND", f"policy rule not found: {rule_id}", http_status=404, source="sqlite")
    return success_envelope(_policy_rule_dict(rule), request=request, source="sqlite")


@router.delete("/policy/rules/{rule_id}", dependencies=[Depends(verify_cf_access)])
async def delete_policy_rule(rule_id: int, request: Request):
    """删一条规则。幂等（不存在 removed=false）。"""
    removed = get_agent_config_store().delete_policy_rule(rule_id)
    return success_envelope({"id": rule_id, "removed": removed}, request=request, source="sqlite")


@router.post("/policy/evaluate", dependencies=[Depends(verify_local_token)])
async def evaluate_policy(request: Request, body: Optional[dict[str, Any]] = None):
    """评估一次动作是否命中白名单 → {decision: auto_allow|ask, ruleId}。gateway W1b 的 needsApproval
    前置调用。body = {capability, action, contextMode?, agentId?}。contextMode 缺省/非法 →
    fail-closed 到 untrusted_trigger（manual 规则不匹配 → ask）；agentId 缺省 = manual 现状，
    有值 = headless per-agent 双键候选（ADR-004 §3.3）。

    🔴 鉴权 = ``verify_local_token``（**仅**本地 token，不接受 CF JWT）——唯一调用方是 in-process
    gateway domainClient（同机 loopback，恒带 ``X-MailAgent-Local-Token``），与 exec 三端点同形状。
    收窄理由：evaluate 是执行放行判定的前置门，若挂 ``verify_cf_access`` 则远程 CF 会话可探/预热
    白名单判决。**注**：``/policy/rules`` CRUD 仍走 ``verify_cf_access``（Settings UI 远程管理规则）。"""
    from src.agent_config.policy import CAPABILITIES, CONTEXT_MODES, evaluate

    raw = body or {}
    capability = raw.get("capability")
    action = raw.get("action")
    context_mode = raw.get("contextMode")
    agent_id = raw.get("agentId")
    if capability not in CAPABILITIES:
        raise APIError("E_INVALID_ARG", f"capability must be one of {list(CAPABILITIES)}",
                       http_status=400, source="sqlite")
    if not isinstance(action, dict):
        raise APIError("E_INVALID_ARG", "action must be an object", http_status=400, source="sqlite")
    if context_mode not in CONTEXT_MODES:
        context_mode = "untrusted_trigger"
    # agentId（S5 ADR-004 §3.3）：可选；不传 = manual 现状（候选 agent_id IS NULL）。非法类型
    # → 400（gateway 调用方 bug 早暴露；空串由 store 层拒 → evaluate 兜底 ask）。
    if agent_id is not None and not isinstance(agent_id, str):
        raise APIError("E_INVALID_ARG", "agentId must be a string", http_status=400, source="sqlite")
    # 返回 {decision, rule_id}（snake）= policy 判决单一 verdict 形状，与 exec 端点响应的 policy 字段
    # 一致（W1b 一个 verdict 类型消费两处：/evaluate 前置调用 + exec 响应审计）。
    result = evaluate(get_agent_config_store(), capability, action, context_mode, agent_id=agent_id)
    return success_envelope(result, request=request, source="sqlite")
