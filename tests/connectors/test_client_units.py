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
    derive_destructive,
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


# ── crud 派生（annotations 三态 hint → read/update/write；裁决①后不产出 delete）──


def _tool(**ann) -> Tool:
    return Tool(
        name="t",
        inputSchema={"type": "object"},
        annotations=ToolAnnotations(**ann) if ann else None,
    )


def test_derive_crud_type_mapping():
    assert derive_crud_type(_tool(readOnlyHint=True)) == "read"
    # 🔴 裁决①（spike 0803）：destructiveHint 是「破坏性更新」超集、无 delete 语义位 ——
    # 不再映射 delete（旧映射让 Notion 的 update-page 结构性不可用）。
    assert derive_crud_type(_tool(destructiveHint=True)) == "write"
    assert derive_crud_type(_tool(idempotentHint=True)) == "update"
    assert derive_crud_type(_tool(readOnlyHint=False, destructiveHint=False)) == "write"
    # 完全未注解 → write（不按 spec 缺省收紧 —— 见 derive_crud_type docstring）。
    assert derive_crud_type(_tool()) == "write"
    # read 优先于其它 hint（readOnly 为真时 destructive 无意义）。
    assert derive_crud_type(_tool(readOnlyHint=True, destructiveHint=True)) == "read"
    # idempotent 优先于 destructive（Notion move-pages 型）。
    assert derive_crud_type(_tool(idempotentHint=True, destructiveHint=True)) == "update"


def test_derive_crud_type_never_produces_delete():
    """裁决①收口：当前推导对任意 hint 组合都不产出 delete（档位机制保留但不喂）。"""
    combos = [
        {},
        {"readOnlyHint": True},
        {"destructiveHint": True},
        {"idempotentHint": True},
        {"destructiveHint": True, "idempotentHint": True},
        {"readOnlyHint": False, "destructiveHint": True},
    ]
    for ann in combos:
        assert derive_crud_type(_tool(**ann)) != "delete", ann


def test_derive_destructive_flag():
    """destructive 位单独落列：只认显式 True（None / False 都算否）。"""
    assert derive_destructive(_tool(destructiveHint=True)) is True
    assert derive_destructive(_tool(destructiveHint=False)) is False
    assert derive_destructive(_tool()) is False
    assert derive_destructive(_tool(readOnlyHint=True)) is False
    # readOnly 与 destructive 并存时 crud 归 read，但 destructive 位如实保留。
    assert derive_destructive(_tool(readOnlyHint=True, destructiveHint=True)) is True


# ── call_tool 归一：文本块拼接 / structured 兜底 / 截断有界（issue #66 纪律）───────


class _FakeBlock:
    def __init__(self, text):
        self.text = text


class _FakeCallResult:
    def __init__(self, content=None, structured=None, is_error=False):
        self.content = content or []
        self.structured_content = structured
        self.is_error = is_error


def _client_with_fake_session(result):
    from contextlib import asynccontextmanager

    cc = ConnectorClient("notion", interactive=False, timeout_seconds=1.0)

    class _FakeMcpClient:
        async def call_tool(self, name, arguments):
            self.called_with = (name, arguments)
            return result

    fake = _FakeMcpClient()

    @asynccontextmanager
    async def fake_session(*, http_transport=None):
        yield fake

    cc.session = fake_session  # type: ignore[method-assign]
    return cc, fake


def test_call_tool_joins_text_blocks_and_passes_args():
    result = _FakeCallResult(content=[_FakeBlock("part1"), _FakeBlock("part2")])
    cc, fake = _client_with_fake_session(result)
    out = asyncio.run(cc.call_tool("search", {"q": "x"}))
    assert out == {"content": "part1\npart2", "is_error": False, "truncated": False}
    assert fake.called_with == ("search", {"q": "x"})


def test_call_tool_structured_fallback_and_error_bit():
    result = _FakeCallResult(structured={"rows": [1, 2]}, is_error=True)
    cc, _ = _client_with_fake_session(result)
    out = asyncio.run(cc.call_tool("query", None))
    assert out["is_error"] is True
    assert '"rows"' in out["content"] and "[1, 2]" in out["content"]


def test_call_tool_truncates_at_cap():
    from src.connectors.client import CALL_RESULT_MAX_CHARS

    result = _FakeCallResult(content=[_FakeBlock("x" * (CALL_RESULT_MAX_CHARS + 100))])
    cc, _ = _client_with_fake_session(result)
    out = asyncio.run(cc.call_tool("big", {}))
    assert out["truncated"] is True
    assert len(out["content"]) == CALL_RESULT_MAX_CHARS


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


# ── 刷新失败链（PR5）：refresh token 被撤销 → E_CONNECTOR_NOT_CONNECTED ──────────
#
# 🔴 这是 needs_reauth 落态的**真实**触发路径，也是 ExceptionGroup 拆包闸的理由：授权
# 失效发生在 streamable_http 的 anyio TaskGroup 内部（provider 回落完整授权流 → 非交互
# redirect handler 抛错），不拆包的话 session() 抛出去的是 ExceptionGroup，invoke/sync 侧
# `except ConnectorError` 认不出来 → 落态永不触发、HTTP 也退化成 500。
# 只 mock httpx 传输层（不发网络），SDK 的 auth flow / Client / transport 全是真的。


_AS = "https://mcp.notion.com"


class _RevokedRefreshStorage(_StubStorage):
    """已过期的 access token + 被撤销的 refresh token + 已注册 client_info。"""

    def __init__(self):
        from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

        super().__init__(
            OAuthToken(
                access_token="dead",
                token_type="Bearer",
                refresh_token="revoked",
                expires_in=0,
            ),
            0,
        )
        self._client_info = OAuthClientInformationFull(
            client_id="cid-test",
            redirect_uris=["http://127.0.0.1:8765/api/connector/oauth/callback"],
        )

    async def get_client_info(self):
        return self._client_info


def _oauth_mock_transport(seen: list[str]):
    """按 URL 分派的假上游：refresh 一律 400（被撤销），MCP 请求一律 401。"""
    import httpx2

    def _handler(request: "httpx2.Request") -> "httpx2.Response":
        seen.append(f"{request.method} {request.url.path}")
        path = request.url.path
        if request.method == "POST" and path.endswith("/token"):
            return httpx2.Response(400, json={"error": "invalid_grant"})
        if "oauth-protected-resource" in path:
            return httpx2.Response(
                200, json={"resource": f"{_AS}/mcp", "authorization_servers": [_AS]}
            )
        if "oauth-authorization-server" in path or "openid-configuration" in path:
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
        return httpx2.Response(
            401,
            headers={
                "WWW-Authenticate": (
                    "Bearer resource_metadata="
                    f'"{_AS}/.well-known/oauth-protected-resource/mcp"'
                )
            },
            json={"error": "unauthorized"},
        )

    return httpx2.MockTransport(_handler)


def test_revoked_refresh_token_surfaces_not_connected():
    import httpx2

    seen: list[str] = []
    cc = ConnectorClient(
        "notion",
        interactive=False,
        timeout_seconds=5.0,
        storage=_RevokedRefreshStorage(),
    )

    async def _run():
        async with cc.session(http_transport=_oauth_mock_transport(seen)):
            pass  # pragma: no cover —— 进不到这里（授权失效必抛）

    with pytest.raises(ConnectorError) as ei:
        asyncio.run(_run())
    # 🔴 抛出来的必须是 ConnectorError 本体（不是裹着它的 ExceptionGroup）：sync/invoke 侧
    # 就是靠这个类型 + code 落 needs_reauth 的。
    assert ei.value.code == "E_CONNECTOR_NOT_CONNECTED"
    assert not isinstance(ei.value, httpx2.HTTPError)
    # 链路走到位：刷新真发出去过、被拒后回落到完整授权流（发现 → 授权 URL → 非交互拒绝）。
    assert any(s.endswith("/token") for s in seen), seen
    assert any("oauth-protected-resource" in s for s in seen), seen


def test_sole_leaf_unwraps_only_single_child_groups():
    """拆包只认「只裹一个」：多子异常拆不动 → None（并发多错时挑代表都是猜）。"""
    from src.connectors.client import _sole_leaf

    group = ExceptionGroup  # noqa: F821 — 3.11 内建（ruff 按 requires-python=3.9 判未定义）
    boom = ValueError("boom")
    assert _sole_leaf(boom) is boom
    assert _sole_leaf(group("g", [boom])) is boom
    # 嵌套单子 → 一路拆到叶子（anyio 嵌套 TaskGroup 的形态）。
    assert _sole_leaf(group("outer", [group("inner", [boom])])) is boom
    assert _sole_leaf(group("g", [boom, KeyError("k")])) is None
