"""MCP 服务管理路由 —— /api/mcp-service/*（设置页「MCP 服务」的数据面）。

owner 在设置页里管理对外 ``/mcp`` 的访问密钥、查看外部 agent 能看到的工具与最近调用、检测
公网地址。密钥存储复用 ``src/security/api_keys.py``（与 ``mailagent api-key`` CLI 同一个
``api_auth.db``）。设置页按「基础档 + 额外写权限」组合 scope（``compose_scopes`` / ``decompose_scopes``），
CLI 仍用 ``KEY_PRESETS``。

鉴权：整组 ``Depends(verify_cf_access)``（本机 token / CF Access）。agent Bearer key 不走这条
依赖 → 天然 401，外部 agent 不能用自己的 key 给自己签发新 key。

明文 key 只在新建 / 轮换的响应里出现一次；列表与其它响应永不出现明文或 hash
（``ApiKeyRecord`` 本身就不带 hash）。
"""

from __future__ import annotations

import os
import re
import time
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Body, Depends, Query, Request

from src.api.agent_auth import Principal
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access, verify_local_token
from src.api.deps import get_settings
from src.security import api_keys as _api_keys

router = APIRouter(
    prefix="/api/mcp-service",
    tags=["mcp-service"],
    dependencies=[Depends(verify_cf_access)],
)

# 工具清单（``GET /tools``）里每个工具标注的「哪些预设包含它」所用的预设集合（``KEY_PRESETS`` 的
# 子集）。新建 / 修改密钥不再按预设，而是「基础档 + 额外写权限」（``KEY_BASES`` /
# ``EXTRA_WRITE_SCOPES``）。
UI_KEY_PRESETS: tuple[str, ...] = ("readonly", "handoff", "drafter")

# 额外写权限的风险档（设置页据此给警示色）：会通知其他人或不可撤回的为 high。
_HIGH_RISK_EXTRAS = frozenset({"calendar:write", "email:write"})

_AUDIT_LIMIT_MAX = 100
_PROBE_TIMEOUT_SECONDS = 5.0
_FIRST_SENTENCE_RE = re.compile(r"^(.+?[.!?])(?:\s|$)", re.S)


def _store() -> _api_keys.ApiKeyStore:
    # 经模块属性取单例（测试 monkeypatch ``api_keys.get_api_key_store``）。
    return _api_keys.get_api_key_store()


def _key_to_dict(rec: _api_keys.ApiKeyRecord) -> dict[str, Any]:
    base, extra, custom = _api_keys.decompose_scopes(rec.scopes)
    return {
        "id": rec.id,
        "label": rec.label,
        "key_prefix": rec.key_prefix,
        "scopes": list(rec.scopes),
        "preset": _api_keys.preset_for_scopes(rec.scopes),
        "base": base,
        "extra": extra,
        "custom": custom,
        "created_at": rec.created_at,
        "last_used_at": rec.last_used_at,
        "expires_at": rec.expires_at,
        "revoked_at": rec.revoked_at,
        "active": rec.is_active,
        "disabled_tools": list(getattr(rec, "disabled_tools", ()) or ()),
        "write_rpm_limit": getattr(rec, "write_rpm_limit", None),
    }


def _public_url() -> str:
    """热读 .env 的 ``MAILAGENT_MCP_PUBLIC_URL``（设置页保存即生效），缺省回落冻结单例。"""
    from dotenv import dotenv_values

    from src.api.deps import get_env_file_path

    env_path = get_env_file_path()
    if env_path:
        try:
            value = (dotenv_values(env_path).get("MAILAGENT_MCP_PUBLIC_URL") or "").strip()
        except Exception:  # noqa: BLE001 — .env 读失败不致命，回落冻结单例
            value = ""
        if value:
            return value
    return (getattr(get_settings(), "mailagent_mcp_public_url", "") or "").strip()


@router.get("/status")
def get_status(request: Request):
    port = os.environ.get("MAILAGENT_API_PORT", "8200")
    base = f"http://127.0.0.1:{port}"
    active = sum(1 for rec in _store().list_keys(include_revoked=False) if rec.is_active)
    return success_envelope(
        {
            "local_url": f"{base}/mcp",
            "streamable_http_url": f"{base}/mcp",
            "sse_url": f"{base}/mcp/sse",
            "public_url": _public_url(),
            "active_key_count": active,
        },
        request=request,
    )


@router.get("/keys")
def list_keys(request: Request):
    keys = [_key_to_dict(rec) for rec in _store().list_keys(include_revoked=True)]
    return success_envelope({"keys": keys}, request=request, meta_extra={"count": len(keys)})


@router.get("/scope-options")
def scope_options(request: Request):
    """新建 / 修改密钥选项：兼容旧 bases+extras 的同时提供细粒度 read_scopes / write_scopes / available_tools。"""
    from src.mcp.client_config_writer import CLIENT_TARGETS
    from src.mcp.mailagent_mcp import manifest_to_mcp_tools
    from src.skills.registry import build_manifest

    all_principal = Principal(
        kind="agent", auth_method="bearer", scopes=frozenset(_api_keys.KNOWN_SCOPES)
    )
    manifest = build_manifest(all_principal)
    scopes_by_tool = {
        (s.name, t.name): list(t.auth_scopes) for s in manifest.skills for t in s.tools
    }
    available_tools = [
        {
            "name": t["name"],
            "tool": t["_tool"],
            "title": t["title"],
            "auth_scopes": scopes_by_tool[(t["_skill"], t["_tool"])],
        }
        for t in manifest_to_mcp_tools(manifest)
    ]
    return success_envelope(
        {
            "bases": [
                {"id": name, "scopes": list(scopes)} for name, scopes in _api_keys.KEY_BASES.items()
            ],
            "extras": [
                {"scope": scope, "risk": "high" if scope in _HIGH_RISK_EXTRAS else "low"}
                for scope in _api_keys.EXTRA_WRITE_SCOPES
            ],
            "read_scopes": list(_api_keys.READ_ONLY_SCOPES),
            "write_scopes": [
                {
                    "scope": scope,
                    "risk": "high" if scope in _HIGH_RISK_EXTRAS else "low",
                    "kind": "run" if scope in _api_keys.TRIGGER_RUN_SCOPES else "write",
                }
                for scope in _api_keys.ALL_WRITE_AND_RUN_SCOPES
            ],
            "available_tools": available_tools,
            "ttl_presets_days": [7, 30, 90, None],
            "client_targets": list(CLIENT_TARGETS),
        },
        request=request,
    )


def _scopes_from_body(raw: dict[str, Any]) -> tuple[str, ...]:
    """body 支持 ``{scopes: [...]}`` 直选细粒度 scope，或向后兼容 ``{base, extra}``。"""
    if "scopes" in raw and raw["scopes"] is not None:
        raw_scopes = raw["scopes"]
        if not isinstance(raw_scopes, list) or not all(isinstance(s, str) for s in raw_scopes):
            raise APIError("E_INVALID_ARG", "scopes must be an array of scope strings")
        try:
            validated = _api_keys.validate_scopes(raw_scopes)
        except ValueError as exc:
            raise APIError("E_INVALID_ARG", str(exc)) from exc
        if not validated:
            raise APIError("E_INVALID_ARG", "at least one scope must be selected")
        return validated

    base = raw.get("base")
    extra = raw.get("extra", [])
    if not isinstance(base, str):
        raise APIError("E_INVALID_ARG", f"base must be one of {' | '.join(_api_keys.KEY_BASES)}")
    if not isinstance(extra, list) or not all(isinstance(s, str) for s in extra):
        raise APIError("E_INVALID_ARG", "extra must be an array of scope strings")
    try:
        return _api_keys.compose_scopes(base, extra)
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc)) from exc


def _parse_expires_at(raw: dict[str, Any]) -> Optional[int]:
    if "ttl_days" in raw and raw["ttl_days"] is not None:
        ttl_days = raw["ttl_days"]
        if isinstance(ttl_days, bool) or not isinstance(ttl_days, int) or ttl_days <= 0:
            raise APIError("E_INVALID_ARG", "ttl_days must be a positive integer")
        return int(time.time()) + ttl_days * 86400
    if "expires_at" in raw:
        exp = raw["expires_at"]
        if exp is None:
            return None
        if isinstance(exp, bool) or not isinstance(exp, int) or exp <= int(time.time()):
            raise APIError("E_INVALID_ARG", "expires_at must be a future unix epoch timestamp or null")
        return exp
    return None


def _parse_disabled_tools(raw: Any) -> list[str]:
    if not isinstance(raw, list) or not all(isinstance(s, str) for s in raw):
        raise APIError("E_INVALID_ARG", "disabled_tools must be an array of tool name strings")
    try:
        return list(_api_keys.normalize_disabled_tools(raw))
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc)) from exc


def _parse_write_rpm_limit(raw: Any) -> Optional[int]:
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0 or raw > 10000:
        raise APIError("E_INVALID_ARG", "write_rpm_limit must be an integer in 1..10000 or null")
    return raw


@router.post("/keys")
def create_key(request: Request, body: Optional[dict[str, Any]] = Body(default=None)):
    raw = body or {}
    label = raw.get("label")
    if not isinstance(label, str) or not label.strip():
        raise APIError("E_INVALID_ARG", "label is required")
    scopes = _scopes_from_body(raw)
    expires_at = _parse_expires_at(raw) if ("ttl_days" in raw or "expires_at" in raw) else None
    disabled_tools = (
        _parse_disabled_tools(raw["disabled_tools"])
        if raw.get("disabled_tools") is not None
        else None
    )
    write_rpm_limit = (
        _parse_write_rpm_limit(raw["write_rpm_limit"])
        if "write_rpm_limit" in raw
        else None
    )
    record, plaintext = _store().create_key(
        label.strip(),
        scopes=scopes,
        expires_at=expires_at,
        disabled_tools=disabled_tools,
        write_rpm_limit=write_rpm_limit,
    )
    return success_envelope({"key": _key_to_dict(record), "plaintext": plaintext}, request=request)


@router.patch("/keys/{key_id}/scopes")
def update_key_scopes(key_id: str, request: Request, body: Optional[dict[str, Any]] = Body(default=None)):
    """改权限（明文不变，外部客户端不用换请求头）。已撤销 / 不存在 → 404。写一行审计。"""
    raw = body or {}
    scopes = _scopes_from_body(raw)
    kwargs: dict[str, Any] = {
        "scopes": scopes,
        "route": f"/api/mcp-service/keys/{key_id}/scopes",
    }
    if "disabled_tools" in raw and raw["disabled_tools"] is not None:
        kwargs["disabled_tools"] = _parse_disabled_tools(raw["disabled_tools"])
    if "write_rpm_limit" in raw:
        kwargs["write_rpm_limit"] = _parse_write_rpm_limit(raw["write_rpm_limit"])
    if "ttl_days" in raw or "expires_at" in raw:
        kwargs["expires_at"] = _parse_expires_at(raw)
    record = _store().update_key_policy(key_id, **kwargs)
    if record is None:
        raise APIError("E_NOT_FOUND", f"api key {key_id!r} not found or revoked")
    return success_envelope({"key": _key_to_dict(record)}, request=request)


@router.patch("/keys/{key_id}")
def update_key_policy_endpoint(
    key_id: str,
    request: Request,
    body: Optional[dict[str, Any]] = Body(default=None),
):
    """部分更新密钥策略（scopes / disabled_tools / write_rpm_limit / ttl_days|expires_at）。"""
    raw = body or {}
    kwargs: dict[str, Any] = {"route": f"/api/mcp-service/keys/{key_id}"}
    if "scopes" in raw or "base" in raw:
        kwargs["scopes"] = _scopes_from_body(raw)
    if "disabled_tools" in raw:
        kwargs["disabled_tools"] = (
            _parse_disabled_tools(raw["disabled_tools"])
            if raw["disabled_tools"] is not None
            else ()
        )
    if "write_rpm_limit" in raw:
        kwargs["write_rpm_limit"] = _parse_write_rpm_limit(raw["write_rpm_limit"])
    if "ttl_days" in raw or "expires_at" in raw:
        kwargs["expires_at"] = _parse_expires_at(raw)
    record = _store().update_key_policy(key_id, **kwargs)
    if record is None:
        raise APIError("E_NOT_FOUND", f"api key {key_id!r} not found or revoked")
    return success_envelope({"key": _key_to_dict(record)}, request=request)


@router.post("/keys/{key_id}/rotate")
def rotate_key(key_id: str, request: Request):
    store = _store()
    plaintext = store.rotate(key_id)
    if plaintext is None:
        raise APIError("E_NOT_FOUND", f"api key {key_id!r} not found or revoked")
    record = store.get_key(key_id)
    return success_envelope({"key": _key_to_dict(record), "plaintext": plaintext}, request=request)


@router.post("/keys/{key_id}/revoke")
def revoke_key(key_id: str, request: Request):
    store = _store()
    if store.get_key(key_id) is None:
        raise APIError("E_NOT_FOUND", f"api key {key_id!r} not found")
    store.revoke(key_id)  # 已撤销再撤是 no-op，返回当前状态
    return success_envelope({"key": _key_to_dict(store.get_key(key_id))}, request=request)


def _first_sentence(text: str) -> str:
    text = " ".join((text or "").split())
    m = _FIRST_SENTENCE_RE.match(text)
    return m.group(1) if m else text


@router.get("/tools")
def list_tools(request: Request):
    """外部 agent 视角的工具清单：持全部 scope 的 agent principal 实际在 ``tools/list`` 里看到的。

    复用 ``build_manifest`` 的 agent 过滤（installed skill 不出现）与 MCP 投影
    （``mcp_exposed=False`` 不出现），不另写一份过滤规则。
    """
    from src.mcp.mailagent_mcp import manifest_to_mcp_tools
    from src.skills.registry import build_manifest

    principal = Principal(
        kind="agent", auth_method="bearer", scopes=frozenset(_api_keys.KNOWN_SCOPES)
    )
    manifest = build_manifest(principal)
    scopes_by_tool = {
        (s.name, t.name): list(t.auth_scopes) for s in manifest.skills for t in s.tools
    }
    tools = []
    for t in manifest_to_mcp_tools(manifest):
        auth_scopes = scopes_by_tool[(t["_skill"], t["_tool"])]
        tools.append(
            {
                "name": t["name"],
                "title": t["title"],
                "description": _first_sentence(t["description"]),
                "annotations": t["annotations"],
                "auth_scopes": auth_scopes,
                "presets": [
                    p for p in UI_KEY_PRESETS
                    if set(auth_scopes) <= set(_api_keys.KEY_PRESETS[p])
                ],
            }
        )
    return success_envelope({"tools": tools}, request=request, meta_extra={"count": len(tools)})


@router.get("/audit")
def list_audit(request: Request, limit: int = Query(20, ge=1, le=_AUDIT_LIMIT_MAX)):
    store = _store()
    labels = {rec.id: rec.label for rec in store.list_keys(include_revoked=True)}
    entries = [
        {
            "id": row["id"],
            "created_at": row["created_at"],
            "key_id": row["key_id"],
            "key_label": labels.get(row["key_id"]),
            "route": row["route"],
            "skill": row["skill"],
            "tool": row["tool"],
            "status": row["status"],
            "error_code": row["error_code"],
            "duration_ms": row["duration_ms"],
        }
        for row in store.list_audit(limit=limit)
    ]
    return success_envelope({"entries": entries}, request=request, meta_extra={"count": len(entries)})


def _validate_probe_url(url: Any) -> str:
    if not isinstance(url, str) or not url.strip():
        raise APIError("E_INVALID_ARG", "url is required")
    url = url.strip()
    try:
        parsed = urlparse(url)
    except ValueError:  # 如 "https://[::1/mcp"：urlparse 自己就抛
        raise APIError("E_INVALID_ARG", "url is not a valid URL") from None
    if not parsed.hostname:
        raise APIError("E_INVALID_ARG", "url must be an absolute http(s) URL")
    if parsed.scheme == "https":
        return url
    if parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1"):
        return url
    raise APIError("E_INVALID_ARG", "url must use https:// (http:// only for localhost / 127.0.0.1)")


def _classify_probe(status: int, headers: Any) -> tuple[str, str]:
    """判断 ``/mcp`` 探测响应：
    - Stateful 下无鉴权/无 Session 探测 ``GET /mcp`` 会回 401/400 JSON，无状态模式回 405 + ``Allow: POST``；
    - 被 Cloudflare Access 拦截时跳登录页（3xx → ``cloudflareaccess.com``）或直接回 HTML。
    """
    location = headers.get("location") or ""
    if 300 <= status < 400 and "cloudflareaccess.com" in location:
        return "access_blocked", f"HTTP {status} → {urlparse(location).hostname or location}"
    content_type = (headers.get("content-type") or "").lower()
    if "text/html" in content_type:
        if status == 200:
            return "access_blocked", "HTTP 200 text/html"
        return "unreachable", f"HTTP {status}"
    if status == 405 and "POST" in (headers.get("allow") or "").upper():
        return "reachable", "HTTP 405"
    if status in (400, 401):
        return "reachable", f"HTTP {status}"
    return "unreachable", f"HTTP {status}"


@router.post("/probe")
async def probe(request: Request, body: Optional[dict[str, Any]] = Body(default=None)):
    import httpx

    url = _validate_probe_url((body or {}).get("url"))
    # 每次新建 client：httpx 只在构造时读系统代理，常驻进程复用 client 会一直用失效的代理。
    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=_PROBE_TIMEOUT_SECONDS) as client:
            resp = await client.get(url)
        result, detail = _classify_probe(resp.status_code, resp.headers)
    except httpx.InvalidURL:  # 不是 HTTPError 子类；urlparse 放行但 httpx 拒收的地址
        raise APIError("E_INVALID_ARG", "url is not a valid URL") from None
    except httpx.TimeoutException:
        result, detail = "unreachable", "timeout"
    except httpx.HTTPError as exc:
        result, detail = "unreachable", type(exc).__name__
    return success_envelope({"result": result, "detail": detail}, request=request)


@router.post("/client-config", dependencies=[Depends(verify_local_token)])
def write_client_config(
    request: Request,
    body: Optional[dict[str, Any]] = Body(default=None),
):
    """一键写入或预览本机 MCP 客户端配置文件（claude_desktop / claude_code / cursor / antigravity）。

    🔴 鉴权 = ``Depends(verify_local_token)``（覆盖/备份本机文件系统，严禁远程 CF JWT 调用）。
    """
    from src.mcp.client_config_writer import CLIENT_MODES, ClientConfigError, write_client_mcp_config

    raw = body or {}
    target = raw.get("target")
    if not isinstance(target, str):
        raise APIError("E_INVALID_ARG", "target is required")
    mode = raw.get("mode", "http")
    if not isinstance(mode, str):
        raise APIError("E_INVALID_ARG", f"mode must be one of {list(CLIENT_MODES)}")
    server_name = raw.get("server_name", "mailagent")
    if not isinstance(server_name, str):
        raise APIError("E_INVALID_ARG", "server_name must be a string")
    dry_run = bool(raw.get("dry_run", False))
    api_key = raw.get("api_key")
    if api_key is not None and not isinstance(api_key, str):
        raise APIError("E_INVALID_ARG", "api_key must be a string or null")
    api_base = raw.get("api_base")
    if api_base is not None and not isinstance(api_base, str):
        raise APIError("E_INVALID_ARG", "api_base must be a string or null")
    try:
        res = write_client_mcp_config(
            target,
            mode=mode,
            server_name=server_name,
            api_base=api_base,
            api_key=api_key,
            dry_run=dry_run,
        )
    except ClientConfigError as exc:
        raise APIError(exc.code, str(exc), http_status=exc.http_status) from exc
    return success_envelope(res, request=request)
