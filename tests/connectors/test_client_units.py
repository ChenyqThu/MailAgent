"""ConnectorClient 纯单元面：registry / crud 派生 / 非交互失败语义 / prime 懒刷新预置。

不发网络（session 级联通在 tests/api/test_connector_api.py 用 stub 盖，真连归 owner spike）。
"""

from __future__ import annotations

import asyncio

import pytest

from mcp.types import Tool, ToolAnnotations

from src.agent_config.credentials import _NAMESPACE_RE
from src.connectors.client import (
    TOKEN_REFRESH_EARLY_SECONDS,
    ConnectorClient,
    ConnectorError,
    derive_crud_type,
)
from src.connectors.registry import CONNECTORS, get_connector_def, namespace_for


# ── registry ─────────────────────────────────────────────────────────────────────


def test_registry_known_connectors():
    assert set(CONNECTORS) == {"notion", "atlassian"}
    assert get_connector_def("notion").server_url == "https://mcp.notion.com/mcp"
    assert (
        get_connector_def("atlassian").server_url
        == "https://mcp.atlassian.com/v1/mcp/authv2"
    )
    with pytest.raises(KeyError):
        get_connector_def("github")


def test_namespace_matches_credential_key_shape():
    """namespace 必须过 credentials 层的键形状闸 —— 不然凭证根本落不了库。"""
    for cid in CONNECTORS:
        assert _NAMESPACE_RE.match(namespace_for(cid)), namespace_for(cid)


def test_unknown_connector_raises_stable_code():
    with pytest.raises(ConnectorError) as ei:
        ConnectorClient("github")
    assert ei.value.code == "E_CONNECTOR_UNKNOWN"


# ── crud 派生（annotations 三态 hint → read/write/update/delete）────────────────


def _tool(**ann) -> Tool:
    return Tool(
        name="t",
        inputSchema={"type": "object"},
        annotations=ToolAnnotations(**ann) if ann else None,
    )


def test_derive_crud_type_mapping():
    assert derive_crud_type(_tool(readOnlyHint=True)) == "read"
    assert derive_crud_type(_tool(destructiveHint=True)) == "delete"
    assert derive_crud_type(_tool(idempotentHint=True)) == "update"
    assert derive_crud_type(_tool(readOnlyHint=False, destructiveHint=False)) == "write"
    # 完全未注解 → write（不按 spec 缺省推成 delete —— 见 derive_crud_type docstring）。
    assert derive_crud_type(_tool()) == "write"
    # read 优先于其它 hint（readOnly 为真时 destructive 无意义）。
    assert derive_crud_type(_tool(readOnlyHint=True, destructiveHint=True)) == "read"


# ── 非交互模式：无授权 → 立刻 E_CONNECTOR_NOT_CONNECTED，不挂浏览器 ─────────────


def test_non_interactive_handlers_fail_fast():
    cc = ConnectorClient("notion", interactive=False, timeout_seconds=1.0)
    provider = cc._build_provider()

    async def _():
        with pytest.raises(ConnectorError) as ei:
            await provider.context.redirect_handler("https://example/authorize")
        assert ei.value.code == "E_CONNECTOR_NOT_CONNECTED"
        with pytest.raises(ConnectorError) as ei2:
            await provider.context.callback_handler()
        assert ei2.value.code == "E_CONNECTOR_NOT_CONNECTED"

    asyncio.run(_())


def test_interactive_without_handlers_rejected():
    cc = ConnectorClient("notion", interactive=True, timeout_seconds=1.0)
    with pytest.raises(ConnectorError) as ei:
        cc._build_provider()
    assert ei.value.code == "E_CONNECTOR_OAUTH"


# ── prime：跨重启懒刷新预置（60s 提前量）────────────────────────────────────────


class _StubStorage:
    def __init__(self, tokens, expires_at):
        self._tokens = tokens
        self._expires_at = expires_at

    async def get_tokens(self):
        return self._tokens

    async def get_tokens_with_expiry(self):
        return self._tokens, self._expires_at

    async def set_tokens(self, tokens):  # pragma: no cover - protocol 完整性
        self._tokens = tokens

    async def get_client_info(self):
        return None

    async def set_client_info(self, client_info):  # pragma: no cover
        pass


def test_prime_sets_context_expiry_with_early_margin():
    from mcp.shared.auth import OAuthToken

    tokens = OAuthToken(access_token="a", token_type="Bearer", expires_in=100)
    cc = ConnectorClient(
        "notion", interactive=False, timeout_seconds=1.0,
        storage=_StubStorage(tokens, 1_800_000_000),
    )
    provider = cc._build_provider()
    asyncio.run(cc._prime(provider))
    assert provider.context.token_expiry_time == 1_800_000_000 - TOKEN_REFRESH_EARLY_SECONDS


def test_prime_noop_without_tokens_or_plain_storage():
    cc = ConnectorClient(
        "notion", interactive=False, timeout_seconds=1.0, storage=_StubStorage(None, None)
    )
    provider = cc._build_provider()
    asyncio.run(cc._prime(provider))
    assert provider.context.token_expiry_time is None

    class _Plain:  # 无 get_tokens_with_expiry（第三方 storage）→ prime 跳过不炸
        pass

    cc2 = ConnectorClient("notion", interactive=False, timeout_seconds=1.0, storage=_Plain())
    provider2 = cc2._build_provider()
    asyncio.run(cc2._prime(provider2))
    assert provider2.context.token_expiry_time is None
