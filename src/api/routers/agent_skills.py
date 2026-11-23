"""Installed agent skill management, fetch/confirm, trust, secrets, and doc routes."""

from __future__ import annotations

import json
import os
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request
from starlette.concurrency import run_in_threadpool

from src.agent_config.projections import resolved_skills
from src.agent_config.store import INSTALLABLE_SOURCE_TYPES, get_agent_config_store
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.routers.agent_common import (
    _manifest_skill_names,
    _pack_api_error,
    _require_skill_creator,
)

router = APIRouter()


def _agent_facade():
    from src.api.routers import agent as m

    return m


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
    if not _agent_facade()._custom_agents_enabled():
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


@router.get("/skills/updates", dependencies=[Depends(verify_cf_access)])
async def check_agent_skill_updates(
    request: Request,
    force: bool = Query(False),
):
    """检测已安装第三方 skill 包上游是否有更新（600s TTL 缓存，force=true 强制刷新）。"""
    from src.skills.update_check import check_skill_updates

    store = get_agent_config_store()
    data = await run_in_threadpool(check_skill_updates, store, force=force)
    return success_envelope(data, request=request, source="sqlite")


def _skill_trust_dict(trust: Any, current_hash: Optional[str]) -> dict[str, Any]:
    state = (
        "revoked"
        if trust.revoked_at is not None
        else "trusted"
        if current_hash and trust.package_hash == current_hash
        else "stale"
    )
    return {
        "id": trust.id,
        "skillName": trust.skill_name,
        "packageHash": trust.package_hash,
        "entrypoint": trust.entrypoint,
        "policy": trust.policy,
        "trustedAt": trust.trusted_at,
        "revokedAt": trust.revoked_at,
        "state": state,
    }


def _validated_trust_policy(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise APIError("E_INVALID_ARG", "body.policy must be an object", http_status=400, source="sqlite")
    allowed = {
        "argvPattern", "cwdScope", "readScopes", "writeScopes", "networkMode", "secretNames"
    }
    unknown = set(raw) - allowed
    if unknown:
        raise APIError(
            "E_INVALID_ARG", f"unknown policy fields: {sorted(unknown)}", http_status=400, source="sqlite"
        )
    policy: dict[str, Any] = {}
    for key in ("argvPattern", "cwdScope", "readScopes", "writeScopes", "secretNames"):
        value = raw.get(key, [])
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise APIError("E_INVALID_ARG", f"policy.{key} must be a string array", http_status=400, source="sqlite")
        policy[key] = value
    network_mode = raw.get("networkMode", "off")
    if network_mode not in {"off", "gated"}:
        raise APIError("E_INVALID_ARG", "policy.networkMode must be off or gated", http_status=400, source="sqlite")
    policy["networkMode"] = network_mode
    return policy


@router.get("/skills/{name}/trust", dependencies=[Depends(verify_cf_access)])
async def list_skill_trust(name: str, request: Request):
    _require_skill_creator()
    store = get_agent_config_store()
    row = store.get_skill(name)
    if row is None:
        raise APIError("E_NOT_FOUND", f"skill not installed: {name}", http_status=404, source="sqlite")
    trusts = [_skill_trust_dict(item, row.package_hash) for item in store.list_skill_trust(name)]
    return success_envelope(
        {"skillName": name, "currentPackageHash": row.package_hash, "trusts": trusts},
        request=request,
        source="sqlite",
        meta_extra={"count": len(trusts)},
    )


@router.post("/skills/{name}/trust", dependencies=[Depends(verify_cf_access)])
async def grant_skill_trust(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    _require_skill_creator()
    raw = body or {}
    entrypoint = raw.get("entrypoint")
    if not isinstance(entrypoint, str) or not os.path.isabs(entrypoint):
        raise APIError("E_INVALID_ARG", "body.entrypoint must be an absolute path", http_status=400, source="sqlite")
    policy = _validated_trust_policy(raw.get("policy"))
    store = get_agent_config_store()
    row = store.get_skill(name)
    if row is None or not row.package_hash or not row.files_json:
        raise APIError("E_NOT_FOUND", f"supply-chain skill not installed: {name}", http_status=404, source="sqlite")
    try:
        files = json.loads(row.files_json)
    except (TypeError, ValueError):
        files = None
    if not isinstance(files, dict) or not files:
        raise APIError("E_INVALID_ARG", "skill has no file manifest", http_status=400, source="sqlite")
    from src.skills.pack_fetch import skill_dir

    root = os.path.realpath(skill_dir(name))
    rp = os.path.realpath(entrypoint)
    rel = rp[len(root) + 1:].replace(os.sep, "/") if rp.startswith(root + os.sep) else None
    if rel is None or rel not in files:
        raise APIError("E_INVALID_ARG", "entrypoint is not in the current skill file manifest", http_status=400, source="sqlite")
    trust = store.grant_skill_trust(uuid.uuid4().hex, name, row.package_hash, rp, policy)
    return success_envelope(_skill_trust_dict(trust, row.package_hash), request=request, source="sqlite")


@router.delete("/skills/{name}/trust/{trust_id}", dependencies=[Depends(verify_cf_access)])
async def revoke_skill_trust(name: str, trust_id: str, request: Request):
    _require_skill_creator()
    store = get_agent_config_store()
    if not any(item.id == trust_id for item in store.list_skill_trust(name)):
        raise APIError("E_NOT_FOUND", f"skill trust not found: {trust_id}", http_status=404, source="sqlite")
    revoked = store.revoke_skill_trust(trust_id)
    return success_envelope({"id": trust_id, "revoked": revoked}, request=request, source="sqlite")


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
    from src.skills.update_check import invalidate_skill_update_cache

    store = get_agent_config_store()
    removed_row = store.uninstall_skill(name)
    removed_dir = remove_skill_dir(name)
    removed_secrets = store.delete_skill_secrets(name)
    invalidate_skill_update_cache()
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


def _diff_skill_files(old_files_json: Optional[str], new_files: dict[str, str]) -> dict[str, list[str]]:
    old_files: dict[str, Any] = {}
    if old_files_json:
        try:
            parsed = json.loads(old_files_json)
            if isinstance(parsed, dict):
                old_files = parsed
        except (ValueError, TypeError):
            old_files = {}
    added = sorted(k for k in new_files if k not in old_files)
    removed = sorted(k for k in old_files if k not in new_files)
    modified = sorted(k for k in new_files if k in old_files and old_files[k] != new_files[k])
    return {"added": added, "modified": modified, "removed": removed}


def _build_fetch_preview(res: Any, store: Any) -> dict[str, Any]:
    m = res.manifest_dict
    secret_names = [
        s.get("name") for s in (m.get("secrets") or []) if isinstance(s, dict) and s.get("name")
    ]
    preview: dict[str, Any] = {
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
    skill_name = m.get("name")
    existing = store.get_skill(skill_name) if isinstance(skill_name, str) and skill_name else None
    if existing is not None and existing.files_json:
        preview["isUpgrade"] = True
        preview["previousVersion"] = existing.version
        preview["previousPackageHash"] = existing.package_hash
        preview["changedFiles"] = _diff_skill_files(existing.files_json, res.files)
    return preview


@router.post("/skills/fetch", dependencies=[Depends(verify_cf_access)])
async def fetch_agent_skill(request: Request, body: Optional[dict[str, Any]] = None):
    """两段式第一段：下载（GitHub/npm/URL）/ 导入（本地 zip/tgz 或目录）skill 包 → quarantine →
    manifest v2 校验 + hash。**不安装**（仅落 quarantine）。body = {sourceUrl? | localPath?, skillName?}。"""
    from src.skills.pack_fetch import fetch_pack
    from src.skills.pack_verify import PackError

    raw = body or {}
    source_url = raw.get("sourceUrl")
    local_path = raw.get("localPath")
    skill_name = raw.get("skillName")
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
    if skill_name is not None and not isinstance(skill_name, str):
        raise APIError("E_INVALID_ARG", "body.skillName must be a string", http_status=400, source="sqlite")

    try:
        res = await run_in_threadpool(
            fetch_pack,
            source_url=source_url if source_url else None,
            local_path=local_path if local_path else None,
            skill_name=skill_name.strip() if isinstance(skill_name, str) and skill_name.strip() else None,
        )
    except PackError as exc:
        raise _pack_api_error(exc) from exc

    return success_envelope(_build_fetch_preview(res, get_agent_config_store()), request=request, source="sqlite")


@router.post("/skills/confirm", dependencies=[Depends(verify_cf_access)])
async def confirm_agent_skill(request: Request, body: Optional[dict[str, Any]] = None):
    """两段式第二段：按 quarantineId **重算** quarantine content 的 hash 比对 owner 批准的事实
    （expectedPackageHash + expectedFiles，TOCTOU 防 preview→落盘间被替换）→ 落 agent_skills 行 →
    atomic rename content 到 <skills>/<name>。hash 不符 → 409。body = {quarantineId, expectedPackageHash,
    expectedFiles?}。"""
    from src.skills.pack_fetch import confirm_pack, promote_content
    from src.skills.pack_verify import PackError
    from src.skills.update_check import invalidate_skill_update_cache

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
    # 先落新行数据（含 manifest/hash/files/upstream_meta），保留既有 enabled 覆盖，再 atomic swap 目录。
    try:
        resolved_version = (
            (result.upstream_meta or {}).get("version")
            if isinstance(result.upstream_meta, dict)
            else None
        ) or result.manifest_dict.get("version")
        store.install_skill(
            result.name,
            source_type=result.source_type,
            manifest=result.manifest_dict,
            manifest_version=result.manifest_version,
            version=str(resolved_version) if resolved_version is not None else None,
            source_uri=result.source_uri,
            package_hash=result.package_hash,
            files_json=json.dumps(result.files, ensure_ascii=False, sort_keys=True),
            upstream_meta=result.upstream_meta,
            preserve_enabled=True,
        )
    except ValueError as exc:  # slug / manifest.name 不一致 / 非法 scope
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc

    try:
        promote_content(qid, result.name)
    except PackError as exc:
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc

    invalidate_skill_update_cache()
    return success_envelope(
        {"name": result.name, "sourceType": result.source_type, "packageHash": result.package_hash},
        request=request,
        source="sqlite",
        status_code=201,
    )


@router.post("/skills/{name}/update/prepare", dependencies=[Depends(verify_cf_access)])
async def prepare_agent_skill_update(name: str, request: Request):
    """按已安装 skill 存盘的 sourceUri / localPath 重新拉取到 quarantine 并返回 upgrade preview。"""
    from src.skills.pack_fetch import fetch_pack
    from src.skills.pack_verify import PackError

    store = get_agent_config_store()
    row = store.get_skill(name)
    if row is None or not row.files_json:
        raise APIError("E_NOT_FOUND", f"installed skill pack not found: {name}", http_status=404, source="sqlite")
    if not row.source_uri:
        raise APIError(
            "E_INVALID_ARG",
            f"skill {name!r} has no upstream source URI recorded",
            http_status=400,
            source="sqlite",
        )

    is_local = row.source_type == "local_folder" or (
        isinstance(row.upstream_meta, dict) and row.upstream_meta.get("provider") in ("local", "local_archive")
    )
    try:
        res = await run_in_threadpool(
            fetch_pack,
            source_url=None if is_local else row.source_uri,
            local_path=row.source_uri if is_local else None,
            skill_name=name,
        )
    except PackError as exc:
        raise _pack_api_error(exc) from exc

    return success_envelope(_build_fetch_preview(res, store), request=request, source="sqlite")


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
    不围栏（Settings 等 owner 面也读原文）。服务器侧 cap 64KB 防怪物文件。无文件 → 404。

    ``installDir``（issue #62）= 该 skill 的**绝对**安装目录。SKILL.md 普遍写「在安装目录下执行」，
    而工具此前不给绝对路径 → 模型只能推断出 ``sh -lc "cd <dir> && python3 f.py"`` 的壳包装写法，
    正是 exec 端点会 409 硬拒（且此前会静默丢掉 secret 注入）的形状。路径由 Python 权威给出，
    TS 不手抄 skills root（同 ``/skills/entrypoints`` 的 ``dir``）。

    **builtin fallback**（阶段 0.5 技能可发现性）：code-owned builtin skill 的文档在仓内
    ``src/skills/docs/<name>/SKILL.md``，此前对 ``skill_read`` 是 404 —— 6 份 builtin 说明书模型
    一个字都读不到。命中 builtin 时返回其原文，且 ``installDir=None``（builtin 没有可执行的落盘
    目录；给个假路径会污染 issue #62 的 run_hint 语义）。``source`` 字段让 TS 壳能**明确**区分
    builtin 与 installed，而不是拿 ``installDir is None`` 去反推（老服务端没有该字段时也是 None，
    两种情形长得一样）。builtin 先于 installed 判定，与 registry 的「同名 builtin 胜出」一致。"""
    from src.skills.registry import builtin_doc_file

    # 非法名（BAD..NAME）不匹配任何 builtin → None → 落到 _installed_skill_dir 抛 400（既有契约不变）。
    builtin_path = builtin_doc_file(name)
    if builtin_path is not None:
        return _skill_doc_envelope(name, builtin_path, install_dir=None, source="builtin", request=request)
    d = _installed_skill_dir(name)
    path = os.path.join(d, "SKILL.md")
    if not os.path.isfile(path):
        raise APIError("E_NOT_FOUND", f"skill doc not found: {name}", http_status=404, source="sqlite")
    return _skill_doc_envelope(name, path, install_dir=d, source="installed", request=request)


def _skill_doc_envelope(name: str, path: str, *, install_dir: Optional[str], source: str, request: Request):
    """读一份 SKILL.md（64KB cap）→ 统一 envelope。builtin / installed 两条路共用。"""
    try:
        with open(path, "rb") as f:
            raw = f.read(_SKILL_DOC_CAP_BYTES + 1)
    except OSError as exc:
        raise APIError("E_INTERNAL", f"cannot read skill doc: {exc}", http_status=500, source="sqlite") from exc
    truncated = len(raw) > _SKILL_DOC_CAP_BYTES
    content = raw[:_SKILL_DOC_CAP_BYTES].decode("utf-8", errors="replace")
    return success_envelope(
        {
            "name": name,
            "content": content,
            "truncated": truncated,
            "installDir": install_dir,
            "source": source,
        },
        request=request,
        source="sqlite",
    )


@router.get("/skills/{name}/resource", dependencies=[Depends(verify_cf_access)])
async def get_skill_resource(
    name: str,
    request: Request,
    path: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    json_path: Optional[str] = Query(None),
    offset_line: int = Query(1, ge=1),
    max_lines: int = Query(200, ge=1, le=500),
    limit: int = Query(20, ge=1, le=50),
):
    """只读读取/检索已安装或内置 skill 包内附带的参考文件（如 ``references/catalog.json``）。"""
    from src.skills.pack_verify import PackError
    from src.skills.resource_read import read_skill_resource

    try:
        payload = read_skill_resource(
            name,
            path=path,
            search=search,
            json_path=json_path,
            offset_line=offset_line,
            max_lines=max_lines,
            limit=limit,
        )
    except PackError as exc:
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc
    return success_envelope(payload, request=request, source="sqlite")


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


