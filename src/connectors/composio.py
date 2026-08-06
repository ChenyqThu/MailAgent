"""Composio 托管面的**裸 REST 客户端** + BYOK 凭证 + 稳定 user_id（08-05 WP-12）。

**为什么是裸 REST 而不是 `composio` Python SDK**：我们只用四个动作（建 session / 复用
session / 起 Connect Link / 查 connected account 状态），spike 实测这四个 REST 端点齐全；
引 SDK 会往 108 包的 `requirements.lock.txt` 里塞一整棵依赖树，换不到任何东西。
🔴 工具**执行**根本不走这里 —— session 只是产出一个托管 MCP endpoint，之后一律由
`ConnectorClient`（MCP 栈）说话，「Python 是执行权威」的纪律原样成立。

**BYOK**（owner 08-05 拍板）：每个用户自己注册 Composio、在设置页填自己的 API key。
key 落 `external_credential`（namespace `composio:project`，Fernet + Keychain），
**不进 .env** —— env 是明文落盘 + 第二事实来源 + 要重启，与「在设置页里填完就能用」矛盾。
🔴 key 永不进日志 / 异常 message / 报告。

**user_id**：Composio 要一个稳定的 end-user 标识（官方明说别用 `'default'`、别用 email）。
桌面单用户 App 的落法 = 首次用时生成一个 uuid4 存 `owner_settings`，全部 session 共用。
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Iterable, Mapping, Optional

import httpx

from src.connectors.composio_catalog import ComposioCatalogEntry

#: Composio v3 REST base（spike 实测：无鉴权访问返回 `code 906 Auth_NoAuthProvided`）。
COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3"

#: 凭证槽位（`external_credential`，Fernet 加密 —— 与 connector token 同一把 master key）。
CREDENTIAL_NAMESPACE = "composio:project"
CREDENTIAL_KEY = "api_key"

#: 稳定 end-user 标识落 `owner_settings`（明文非敏感，就是个随机 uuid）。
OWNER_SETTING_USER_ID = "composio.user_id"

#: REST 请求超时（秒）。建 session / 起 link 都是控制面调用，比工具调用短得多。
REQUEST_TIMEOUT_SECONDS = 20.0

#: connected account 视为「连上了」的状态值（大小写不敏感比较）。
CONNECTED_STATUSES = ("ACTIVE",)
#: 明确失败的终态（轮询遇到即停，不空等到 deadline）。
FAILED_STATUSES = ("FAILED", "EXPIRED", "REVOKED", "DELETED")


class ComposioError(Exception):
    """Composio 面的统一错误（stable code —— router / 授权流按 code 决定处置）。

        E_COMPOSIO_NO_KEY     - 没配 API key（BYOK gate：Connectors 配置台去填）
        E_COMPOSIO_AUTH       - key 无效 / 被拒（401 / 403）
        E_COMPOSIO_HTTP       - 其它 HTTP 错误（4xx/5xx，message 带 status 与截断的响应体）
        E_COMPOSIO_NETWORK    - 连不上 / 超时
        E_COMPOSIO_PROTOCOL   - 响应形状不对（缺 session_id / mcp.url / redirect_url）
    """

    def __init__(self, message: str, code: str = "E_COMPOSIO_HTTP") -> None:
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# BYOK 凭证 + user_id
# ---------------------------------------------------------------------------


def get_api_key() -> Optional[str]:
    """取明文 API key（无 / 解密失败 → None）。🔴 返回值只许直接进 header，不许落日志。"""
    from src.agent_config.credentials import get_credential

    payload = get_credential(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY)
    if not payload:
        return None
    key = payload.get("api_key")
    return key if isinstance(key, str) and key.strip() else None


def set_api_key(api_key: str) -> None:
    """写/替换 API key。空串 / 非串 → ValueError（写侧拒，不靠读侧宽容）。"""
    from src.agent_config.credentials import set_credential

    if not isinstance(api_key, str) or not api_key.strip():
        raise ValueError("composio api_key must be a non-empty string")
    set_credential(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY, {"api_key": api_key.strip()})


def clear_api_key() -> bool:
    """删掉 API key（幂等）。session id 与 connector 行**不动** —— 重新填 key 即可继续用。"""
    from src.agent_config.credentials import delete_credential

    return delete_credential(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY)


def api_key_status() -> dict[str, Any]:
    """设置页的 key 状态视图 —— 🔴 **只走 peek（不解密、不回显任何密文片段）**。

    回显只给「配了没 + 什么时候配的」：脱敏纪律（镜像 IM 凭证面），前端不需要也不该拿到
    key 的任何字符。
    """
    from src.agent_config.credentials import peek_credential

    meta = peek_credential(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY)
    return {
        "configured": meta is not None,
        "updated_at": meta.updated_at if meta is not None else None,
    }


def resolve_user_id() -> str:
    """稳定 end-user 标识（首次生成 uuid4 落 `owner_settings`，之后恒读同一个）。

    刻意**不用 email**（Composio 官方建议：不要用可变/可识别的值），也不用 `'default'`。
    """
    from src.agent_config.store import get_agent_config_store

    store = get_agent_config_store()
    existing = store.get_owner_setting(OWNER_SETTING_USER_ID)
    if existing and existing.strip():
        return existing.strip()
    generated = f"mailagent-{uuid.uuid4().hex}"
    store.set_owner_setting(OWNER_SETTING_USER_ID, generated)
    return generated


def require_api_key() -> str:
    key = get_api_key()
    if key is None:
        raise ComposioError(
            "Composio API key is not configured — add it in the Connectors console "
            "(sidebar → Connectors → Composio account) before connecting a preset service",
            code="E_COMPOSIO_NO_KEY",
        )
    return key


# ---------------------------------------------------------------------------
# 裸 REST
# ---------------------------------------------------------------------------


def _short(text: str, limit: int = 300) -> str:
    return text if len(text) <= limit else f"{text[:limit]}…"


async def _request(
    method: str,
    path: str,
    *,
    api_key: str,
    json_body: Optional[Mapping[str, Any]] = None,
    params: Optional[Mapping[str, Any]] = None,
    http_transport: Any = None,
) -> dict[str, Any]:
    """一次 Composio REST 调用 → 解出的 JSON dict。错误统一转 `ComposioError`。

    🔴 api_key 只出现在 header 里：异常 message 带的是 status + 截断响应体，绝不回显请求头。
    `http_transport` 仅供单测注入 `httpx.MockTransport`（不发真实网络）。
    """
    url = f"{COMPOSIO_API_BASE}{path}"
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT_SECONDS, transport=http_transport
        ) as client:
            resp = await client.request(
                method,
                url,
                headers={"x-api-key": api_key, "content-type": "application/json"},
                json=dict(json_body) if json_body is not None else None,
                params=dict(params) if params is not None else None,
            )
    except httpx.TimeoutException as e:
        raise ComposioError(
            f"composio {method} {path} timed out after {time.monotonic() - started:.1f}s "
            f"(limit {REQUEST_TIMEOUT_SECONDS:g}s)",
            code="E_COMPOSIO_NETWORK",
        ) from e
    except httpx.HTTPError as e:
        raise ComposioError(
            f"composio {method} {path} network error: {e}", code="E_COMPOSIO_NETWORK"
        ) from e
    if resp.status_code in (401, 403):
        raise ComposioError(
            "Composio rejected the API key (401/403) — check the key in the Connectors "
            "console (sidebar → Connectors → Composio account)",
            code="E_COMPOSIO_AUTH",
        )
    if resp.status_code >= 400:
        raise ComposioError(
            f"composio {method} {path} failed: HTTP {resp.status_code} {_short(resp.text)}",
            code="E_COMPOSIO_HTTP",
        )
    if not resp.content:
        return {}
    try:
        data = resp.json()
    except ValueError as e:
        raise ComposioError(
            f"composio {method} {path} returned a non-JSON body: {_short(resp.text)}",
            code="E_COMPOSIO_PROTOCOL",
        ) from e
    return data if isinstance(data, dict) else {"data": data}


def _dig(payload: Mapping[str, Any], *paths: Iterable[str]) -> Optional[Any]:
    """按若干候选路径取第一个命中的值（响应形状只被 spike 部分实证 → 容忍嵌套差异）。"""
    for path in paths:
        cur: Any = payload
        ok = True
        for key in path:
            if isinstance(cur, Mapping) and key in cur:
                cur = cur[key]
            else:
                ok = False
                break
        if ok and cur is not None:
            return cur
    return None


def session_create_body(entry: ComposioCatalogEntry, user_id: str) -> dict[str, Any]:
    """session 创建请求体 —— **五件套全在这里，别在调用处再拼一次**（spike 结论）：

      1. `toolkits.enable`            该 connector 用到的 toolkit（Atlassian = 两个）
      2. `tools.<toolkit>.enable`     curated 白名单（session 级第一道闸）
      3. `preload.tools`              = DIRECT_TOOLS：白名单直接出现在 tools/list，不走
                                       Composio 自己的「搜索→执行」meta 语义（那会绕开
                                       我们的 per-tool 档位与审批卡）
      4. `manage_connections.enable=false`  不给模型「自己去连别的账号」的工具
      5. 🔴 `workbench.enable=false`  **默认是开的** —— 不显式关掉就会白送一个云端代码执行
                                       沙箱工具（spike 实测），那是 exec 类能力，绝不允许经
                                       connector 面溜进来

    toolkit slug 请求里用**小写**（Composio 的 toolkit 标识是小写；工具 slug 是大写）。
    """
    toolkits = [tk.lower() for tk in entry.toolkits]
    tools_cfg = {
        tk.lower(): {"enable": list(entry.tools.get(tk, ()))} for tk in entry.toolkits
    }
    return {
        "user_id": user_id,
        "toolkits": {"enable": toolkits},
        "tools": tools_cfg,
        "preload": {"tools": list(entry.all_tools)},
        "manage_connections": {"enable": False},
        "workbench": {"enable": False},
    }


def _extract_session(payload: Mapping[str, Any]) -> dict[str, str]:
    session_id = _dig(payload, ("session_id",), ("id",), ("session", "session_id"), ("session", "id"))
    mcp_url = _dig(payload, ("mcp", "url"), ("session", "mcp", "url"), ("data", "mcp", "url"))
    if not isinstance(session_id, str) or not session_id:
        raise ComposioError(
            "composio session response carries no session id", code="E_COMPOSIO_PROTOCOL"
        )
    if not isinstance(mcp_url, str) or not mcp_url:
        raise ComposioError(
            "composio session response carries no mcp.url (the hosted MCP endpoint) — "
            "the session cannot be used as a connector",
            code="E_COMPOSIO_PROTOCOL",
        )
    return {"session_id": session_id, "mcp_url": mcp_url}


async def create_session(
    entry: ComposioCatalogEntry, user_id: str, api_key: str, *, http_transport: Any = None
) -> dict[str, str]:
    """建一个 tool-router session → `{session_id, mcp_url}`（服务端持久，之后复用）。"""
    payload = await _request(
        "POST",
        "/tool_router/session",
        api_key=api_key,
        json_body=session_create_body(entry, user_id),
        http_transport=http_transport,
    )
    return _extract_session(payload)


async def get_session(
    session_id: str, api_key: str, *, http_transport: Any = None
) -> dict[str, str]:
    """复用既有 session（再取一次 `mcp.url`）。session 不存在 → HTTP 4xx → ComposioError。"""
    payload = await _request(
        "GET", f"/tool_router/session/{session_id}", api_key=api_key, http_transport=http_transport
    )
    return _extract_session(payload)


async def create_link(
    session_id: str, toolkit: str, api_key: str, *, http_transport: Any = None
) -> dict[str, Any]:
    """为某个 toolkit 起一条 Connect Link（Composio 托管授权页）→ `{redirect_url, ...}`。

    🔴 这条**不是**我们的 loopback OAuth：授权在 Composio 侧完成、token 存它那边，我们只拿
    一个浏览器要打开的 URL，然后轮询 connected account 状态。`OAuthRendezvous` 那套只服务
    `custom_mcp` 轨。
    """
    payload = await _request(
        "POST",
        f"/tool_router/session/{session_id}/link",
        api_key=api_key,
        json_body={"toolkit": toolkit.lower()},
        http_transport=http_transport,
    )
    redirect_url = _dig(
        payload, ("redirect_url",), ("data", "redirect_url"), ("link", "redirect_url")
    )
    if not isinstance(redirect_url, str) or not redirect_url:
        raise ComposioError(
            f"composio link response for toolkit {toolkit!r} carries no redirect_url",
            code="E_COMPOSIO_PROTOCOL",
        )
    return {
        "redirect_url": redirect_url,
        "connected_account_id": _dig(
            payload, ("connected_account_id",), ("id",), ("data", "connected_account_id")
        ),
    }


def _account_toolkit(item: Mapping[str, Any]) -> str:
    raw = item.get("toolkit")
    if isinstance(raw, Mapping):
        raw = raw.get("slug") or raw.get("name")
    if not isinstance(raw, str):
        raw = item.get("toolkit_slug") if isinstance(item.get("toolkit_slug"), str) else ""
    return str(raw or "").lower()


async def list_connected_accounts(
    user_id: str, api_key: str, *, http_transport: Any = None
) -> list[dict[str, str]]:
    """该 user 的 connected account 状态（`[{toolkit, status}]`，toolkit 归一成小写）。"""
    payload = await _request(
        "GET",
        "/connected_accounts",
        api_key=api_key,
        params={"user_ids": user_id},
        http_transport=http_transport,
    )
    raw_items = _dig(payload, ("items",), ("data", "items"), ("data",)) or []
    if not isinstance(raw_items, list):
        return []
    out: list[dict[str, str]] = []
    for item in raw_items:
        if not isinstance(item, Mapping):
            continue
        out.append(
            {
                "toolkit": _account_toolkit(item),
                "status": str(item.get("status") or "").upper(),
            }
        )
    return out


def toolkit_connected(accounts: list[dict[str, str]], toolkit: str) -> Optional[bool]:
    """该 toolkit 连上了吗：True = 已连；False = 明确失败；None = 还在路上（继续轮询）。"""
    target = toolkit.lower()
    saw_failure = False
    for acc in accounts:
        if acc.get("toolkit") != target:
            continue
        status = acc.get("status") or ""
        if status in CONNECTED_STATUSES:
            return True
        if status in FAILED_STATUSES:
            saw_failure = True
    return False if saw_failure else None
