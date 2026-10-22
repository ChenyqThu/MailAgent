"""401 → 先强刷一次（``client._RefreshOn401Provider``）+ SDK auth 日志桥进 loguru。

只 mock httpx 传输层（不发网络），SDK 的 auth flow 是真的 —— 钉的就是「SDK 撞 401 不刷新、
直奔完整授权流」这个上游行为之上我们的补丁，SDK 升级改了形状这里会红。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx2
import pytest
from loguru import logger
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

from src.connectors.client import (
    _FORCED_EXPIRY,
    ConnectorError,
    _no_interactive_callback,
    _no_interactive_redirect,
    _RefreshOn401Provider,
)

_AS = "https://mcp.example.test"
_MCP = f"{_AS}/mcp"


class _Storage:
    def __init__(self, tokens: Optional[OAuthToken]) -> None:
        self.tokens = tokens
        self.saved: list[OAuthToken] = []
        self.client_info = OAuthClientInformationFull(
            client_id="cid-test",
            redirect_uris=["http://127.0.0.1:8765/api/connector/oauth/callback"],
        )

    async def get_tokens(self):
        return self.tokens

    async def set_tokens(self, tokens):
        self.tokens = tokens
        self.saved.append(tokens)

    async def get_client_info(self):
        return self.client_info

    async def set_client_info(self, client_info):  # pragma: no cover
        self.client_info = client_info


def _provider(storage: _Storage) -> _RefreshOn401Provider:
    return _RefreshOn401Provider(
        server_url=_MCP,
        client_metadata=OAuthClientMetadata(
            redirect_uris=["http://127.0.0.1:8765/api/connector/oauth/callback"],
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
            token_endpoint_auth_method="none",
        ),
        storage=storage,
        redirect_handler=_no_interactive_redirect,
        callback_handler=_no_interactive_callback,
        label="atlassian",
    )


def _upstream(seen: list[str], *, refresh_status: int = 200, accept: str = "Bearer fresh"):
    """假上游：MCP 请求只认 ``accept`` 这个 Authorization；token 端点按 refresh_status 回。"""

    def _handler(request: httpx2.Request) -> httpx2.Response:
        path = request.url.path
        if request.method == "POST" and path.endswith("/token"):
            seen.append("refresh")
            if refresh_status != 200:
                return httpx2.Response(
                    refresh_status,
                    json={"error": "invalid_grant", "error_description": "Grant not found"},
                )
            return httpx2.Response(
                200,
                json={
                    "access_token": "fresh",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "refresh_token": "rt-2",
                },
            )
        if "oauth-protected-resource" in path:
            seen.append("discovery")
            return httpx2.Response(200, json={"resource": _MCP, "authorization_servers": [_AS]})
        if "oauth-authorization-server" in path or "openid-configuration" in path:
            seen.append("discovery")
            return httpx2.Response(
                200,
                json={
                    "issuer": _AS,
                    "authorization_endpoint": f"{_AS}/authorize",
                    "token_endpoint": f"{_AS}/token",
                    "registration_endpoint": f"{_AS}/register",
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "code_challenge_methods_supported": ["S256"],
                },
            )
        auth = request.headers.get("Authorization")
        seen.append(f"mcp:{auth}")
        if auth == accept:
            return httpx2.Response(200, json={"ok": True})
        return httpx2.Response(
            401,
            headers={
                "WWW-Authenticate": (
                    f'Bearer resource_metadata="{_AS}/.well-known/oauth-protected-resource/mcp"'
                )
            },
        )

    return httpx2.MockTransport(_handler)


async def _post(provider, transport):
    async with httpx2.AsyncClient(auth=provider, transport=transport) as http:
        return await http.post(_MCP, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})


def _stale(expires_in: Optional[int] = None) -> OAuthToken:
    return OAuthToken(
        access_token="stale", token_type="Bearer", refresh_token="rt-1", expires_in=expires_in
    )


@pytest.fixture
def loguru_lines():
    lines: list[str] = []
    sink_id = logger.add(lambda m: lines.append(str(m)), level="DEBUG", format="{message}")
    yield lines
    logger.remove(sink_id)


def test_forced_expiry_sentinel_reads_as_expired():
    """canary：0 在 SDK 里是「无到期 = 永远有效」，所以哨兵必须是一个正的过去时刻。"""
    provider = _provider(_Storage(_stale()))
    provider.context.current_tokens = _stale()
    provider.context.token_expiry_time = 0
    assert provider.context.is_token_valid()  # 这正是不能用 0 的理由
    provider.context.token_expiry_time = _FORCED_EXPIRY
    assert not provider.context.is_token_valid()


@pytest.mark.parametrize("expires_in", [None, 3600], ids=["no-expires_in", "revoked-early"])
def test_401_forces_one_refresh_then_retries(expires_in, loguru_lines):
    """SDK 认为 token 有效（无 expires_in / 还没到期）但服务器回 401 → 强刷 → 新 token 重发成功。"""
    storage = _Storage(_stale(expires_in))
    seen: list[str] = []
    resp = asyncio.run(_post(_provider(storage), _upstream(seen)))

    assert resp.status_code == 200
    assert seen == ["mcp:Bearer stale", "refresh", "mcp:Bearer fresh"]
    assert [t.access_token for t in storage.saved] == ["fresh"]
    assert storage.saved[0].refresh_token == "rt-2"  # 轮换后的 refresh token 落库
    joined = "\n".join(loguru_lines)
    assert "forcing one refresh" in joined
    assert "token refresh (forced after 401) ok" in joined
    assert "rotated" in joined
    # 🔴 日志永不带 token 值
    for secret in ("stale", "fresh", "rt-1", "rt-2"):
        assert f"={secret}" not in joined and f'"{secret}"' not in joined


def test_rejected_forced_refresh_falls_back_to_not_connected(loguru_lines):
    """强刷被拒（轮换 refresh token 已失效）→ 照旧回落完整授权流 → 非交互 NOT_CONNECTED。"""
    storage = _Storage(_stale())
    seen: list[str] = []
    with pytest.raises(ConnectorError) as ei:
        asyncio.run(_post(_provider(storage), _upstream(seen, refresh_status=400)))

    assert ei.value.code == "E_CONNECTOR_NOT_CONNECTED"
    assert seen.count("refresh") == 1
    assert "discovery" in seen
    joined = "\n".join(loguru_lines)
    assert "rejected: HTTP 400" in joined
    assert "Grant not found" in joined  # 错误体进日志（诊断 invalid_grant 的关键）
    # SDK 自己的 stdlib warning 也经桥进了 loguru
    assert "[mcp.client.auth" in joined and "Token refresh failed" in joined
    # SDK 的 logger.exception 只落一行摘要，不带回溯（回溯的帧变量里有 token）
    assert "OAuth flow error (ConnectorError: connector is not authorized" in joined
    assert "Traceback" not in joined


def test_refreshed_token_still_401_refreshes_only_once():
    """刷出来的新 token 仍被拒 → 不再刷第二次（不多烧轮换 token），回落完整授权流。"""
    storage = _Storage(_stale())
    seen: list[str] = []
    with pytest.raises(ConnectorError) as ei:
        asyncio.run(_post(_provider(storage), _upstream(seen, accept="Bearer never")))

    assert ei.value.code == "E_CONNECTOR_NOT_CONNECTED"
    assert seen.count("refresh") == 1


def test_proactive_refresh_then_401_does_not_force_again():
    """本轮父流已主动刷过（token 过期）→ 原请求仍 401 时不再强刷。"""
    storage = _Storage(_stale())
    provider = _provider(storage)
    seen: list[str] = []

    async def _run():
        await provider._initialize()
        provider.context.token_expiry_time = _FORCED_EXPIRY  # 已过期 → 父流主动刷新
        return await _post(provider, _upstream(seen, accept="Bearer never"))

    with pytest.raises(ConnectorError):
        asyncio.run(_run())
    assert seen.count("refresh") == 1
    assert seen[0] == "refresh"


def test_no_refresh_token_keeps_sdk_behaviour():
    """没有 refresh token → 不强刷，直接走 SDK 原有的完整授权流。"""
    storage = _Storage(OAuthToken(access_token="stale", token_type="Bearer"))
    seen: list[str] = []
    with pytest.raises(ConnectorError) as ei:
        asyncio.run(_post(_provider(storage), _upstream(seen)))
    assert ei.value.code == "E_CONNECTOR_NOT_CONNECTED"
    assert "refresh" not in seen


def test_sdk_auth_logger_is_bridged_once():
    from src.connectors import client as client_mod

    sdk_logger = logging.getLogger("mcp.client.auth")
    client_mod._bridge_sdk_auth_logging()  # 重复调用不叠 handler
    bridges = [h for h in sdk_logger.handlers if isinstance(h, client_mod._LoguruBridge)]
    assert len(bridges) == 1
    assert sdk_logger.propagate is False
    assert sdk_logger.level == logging.INFO
