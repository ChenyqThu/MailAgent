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
from src.connectors.composio_catalog import COMPOSIO_CATALOG
from src.connectors.registry import get_connector_def, namespace_for


# ── 定义解析（08-05 WP-12：registry 常量退役 → 行优先、预置目录兜底）───────────────


def test_catalog_entry_resolves_without_a_row(fresh_agent_cfg):
    """库里没行时，目录条目照样解析得出（display_name 有、server_url **空**）。

    空 server_url 是有意的：托管 MCP endpoint 要等 session 建出来才存在 —— 拿一个编出来的
    URL 去发请求才是真事故。
    """
    d = get_connector_def("gmail")
    assert d.source == "composio" and d.display_name == "Gmail" and d.server_url == ""


def test_db_row_wins_over_catalog(fresh_agent_cfg):
    """🔴 行优先：存量直连 `notion` 行（source=custom_mcp）不能被同 id 的目录条目改写装配
    路线，否则升级当天就会拿一把 Composio key 去打 Notion 的直连端点。

    🔴 行里的 endpoint 刻意**不等于**目录里那个：08-06 双轨后 `notion` 的目录条目自己就解析成
    `custom_mcp` + 官方 URL，用同一个 URL 断言这条用例就退化成恒真（把 `get_connector_def`
    的行查询整段删掉它照样绿）。用一个只可能来自行的值才真的钉住「行优先」。
    """
    fresh_agent_cfg.upsert_connector(
        "notion", server_url="https://mcp.notion.test/row-wins", display_name="Notion"
    )
    d = get_connector_def("notion")
    assert d.source == "custom_mcp" and d.server_url == "https://mcp.notion.test/row-wins"


def test_namespace_matches_credential_key_shape():
    """namespace 必须过 credentials 层的键形状闸 —— 不然凭证根本落不了库。"""
    for cid in COMPOSIO_CATALOG:
        assert _NAMESPACE_RE.match(namespace_for(cid)), namespace_for(cid)


def test_unknown_connector_raises_stable_code(fresh_agent_cfg):
    with pytest.raises(ConnectorError) as ei:
        ConnectorClient("definitely-not-a-service")
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
    # idempotent 优先于 destructive（Notion move-pages 型）。
    assert derive_crud_type(_tool(idempotentHint=True, destructiveHint=True)) == "update"


@pytest.mark.parametrize(
    ("ann", "expected"),
    [
        # readOnly 单独在场 = 唯一还能判 read 的组合。
        ({"readOnlyHint": True}, "read"),
        ({"readOnlyHint": True, "destructiveHint": False}, "read"),
        ({"readOnlyHint": True, "idempotentHint": False}, "read"),
        # 🔴 真·矛盾注解：「只读」与「破坏性」语义方向相反（一个说无副作用、一个说可能
        # 破坏性写入），信谁都不安全 ⇒ 不判 read，按 write 走保守面。
        ({"readOnlyHint": True, "destructiveHint": True}, "write"),
        ({"readOnlyHint": True, "destructiveHint": True, "idempotentHint": True}, "write"),
        # 🔴 readOnly ∧ idempotent **仍判 read** —— 有意如此，别再把它收紧回去。
        # MCP spec 对 idempotentHint 的原文是「This property is meaningful only when
        # `readOnlyHint` == false」：只读工具上标幂等**不是自相矛盾**，是按 spec 该被忽略的
        # 冗余标注，现实 manifest 里很常见。而按 write 处理的代价不成比例 —— 真·只读工具
        # 一旦掉成 write，就在天花板恒 read 的场地（matter 跟进 run / 邮件预处理）结构性
        # 不注册，owner 把 per-tool 档设成 auto 也救不回来（天花板服务端强制）；annotations
        # 又不落库 ⇒ 影响面事前查不到、事后难归因 = 静默地把用户要的能力拿掉。
        ({"readOnlyHint": True, "idempotentHint": True}, "read"),
        ({"readOnlyHint": True, "idempotentHint": True, "destructiveHint": False}, "read"),
    ],
)
def test_derive_crud_type_read_only_short_circuit_is_narrowed_to_destructive(
    ann, expected
):
    """`readOnlyHint=True` 不再无条件短路成 read —— 但**只**对 destructive 收紧。

    修的是一个真口子：同时声明 `readOnlyHint=true` **且** `destructiveHint=true` 的远端
    工具原本被归成 read ⇒ 天花板恒 'read' 的无人值守场地（matter 跟进 run / 预处理分类）
    里静默可用。destructive 位单独落列的语义不变（`derive_destructive` 照旧只认显式 True）。
    """
    assert derive_crud_type(_tool(**ann)) == expected


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
    assert out == {"content": "part1\npart2", "images": [], "is_error": False, "truncated": False}
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


def _oauth_mock_transport(seen: list[str], *, resource_path: str = "/mcp"):
    """按 URL 分派的假上游：refresh 一律 400（被撤销），MCP 请求一律 401。"""
    import httpx2

    def _handler(request: "httpx2.Request") -> "httpx2.Response":
        seen.append(f"{request.method} {request.url.path}")
        path = request.url.path
        if request.method == "POST" and path.endswith("/token"):
            return httpx2.Response(400, json={"error": "invalid_grant"})
        if "oauth-protected-resource" in path:
            return httpx2.Response(
                200, json={"resource": f"{_AS}{resource_path}", "authorization_servers": [_AS]}
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
                    f'"{_AS}/.well-known/oauth-protected-resource{resource_path}"'
                )
            },
            json={"error": "unauthorized"},
        )

    return httpx2.MockTransport(_handler)


def test_revoked_refresh_token_surfaces_not_connected(fresh_agent_cfg):
    import httpx2

    # 08-05 WP-12：直连轨的行为要在**直连行**上验（行优先解析）。没有这一行的话
    # `notion` 会解析成预置目录的 composio 条目（无 endpoint）→ 根本走不到 OAuth 那段。
    fresh_agent_cfg.upsert_connector(
        "notion", server_url=f"{_AS}/mcp", display_name="Notion", source="custom_mcp"
    )
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


# ── WS-1A：Legacy HTTP+SSE 传输 + ImageContent Pillow 归一化 ──────────────────


def _encode_pil(image, fmt: str = "PNG", **save_kwargs) -> str:
    import base64
    import io

    buf = io.BytesIO()
    image.save(buf, format=fmt, **save_kwargs)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _png_b64(width: int = 16, height: int = 16, color=(12, 120, 220)) -> str:
    from PIL import Image

    return _encode_pil(Image.new("RGB", (width, height), color), fmt="PNG")


class _FakeCamelImageBlock:
    """Fake JS/dict-style image block with camelCase mimeType (without type attribute)."""

    def __init__(self, data: str, mime_type: str = "image/jpeg"):
        self.data = data
        self.mimeType = mime_type


def _sse_mock_transport(captured_headers: list[dict[str, str]], shot_b64: str):
    import json

    import httpx2

    queue: asyncio.Queue[bytes | None] = asyncio.Queue()

    class _SseStream(httpx2.AsyncByteStream):
        async def __aiter__(self):
            yield b"event: endpoint\ndata: /messages?session_id=sse-test-1\n\n"
            while True:
                chunk = await queue.get()
                if chunk is None:
                    break
                yield chunk

        async def aclose(self):
            await queue.put(None)

    def _handler(request: httpx2.Request) -> httpx2.Response:
        captured_headers.append({k.lower(): v for k, v in request.headers.items()})
        if request.method == "GET" and request.url.path == "/sse":
            return httpx2.Response(
                200,
                headers={"content-type": "text/event-stream"},
                stream=_SseStream(),
            )
        if request.method == "POST" and request.url.path == "/messages":
            body = json.loads(request.content)
            method = body.get("method")
            req_id = body.get("id")
            if method == "notifications/initialized":
                return httpx2.Response(202, json={"status": "accepted"})
            if method == "server/discover":
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": "Method not found"},
                }
            elif method == "initialize":
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "mock-sse", "version": "1.0.0"},
                    },
                }
            elif method == "tools/list":
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "tools": [
                            {
                                "name": "screenshot",
                                "description": "Take a screenshot",
                                "inputSchema": {"type": "object", "properties": {}},
                                "annotations": {"readOnlyHint": True},
                            }
                        ]
                    },
                }
            elif method == "tools/call":
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [
                            {"type": "text", "text": "captured window"},
                            {"type": "image", "data": shot_b64, "mimeType": "image/png"},
                        ]
                    },
                }
            else:
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": "unknown"},
                }
            queue.put_nowait(f"event: message\ndata: {json.dumps(resp)}\n\n".encode("utf-8"))
            return httpx2.Response(202, json={"status": "accepted"})
        return httpx2.Response(404)

    return httpx2.MockTransport(_handler)


def test_sse_transport_custom_headers_list_and_call_tool(fresh_agent_cfg):
    fresh_agent_cfg.upsert_custom_connector(
        "sse_demo",
        display_name="SSE Demo",
        transport="sse",
        server_url="https://mcp.sse.test/sse",
        custom_headers={"Authorization": "Bearer sse-secret-token"},
    )
    seen_headers: list[dict[str, str]] = []
    shot_b64 = _png_b64(32, 24)
    transport = _sse_mock_transport(seen_headers, shot_b64)
    cc = ConnectorClient("sse_demo", interactive=False, timeout_seconds=5.0)

    tools = asyncio.run(cc.list_tools_manifest(http_transport=transport))
    assert len(tools) == 1
    assert tools[0]["name"] == "screenshot"
    assert tools[0]["crud_type"] == "read"

    # Second session with a fresh stream transport for call_tool
    seen_headers_call: list[dict[str, str]] = []
    call_transport = _sse_mock_transport(seen_headers_call, shot_b64)
    res = asyncio.run(cc.call_tool("screenshot", {"window": "main"}, http_transport=call_transport))
    assert res["content"] == "captured window"
    assert res["is_error"] is False
    assert res["truncated"] is False
    assert len(res["images"]) == 1
    assert res["images"][0]["media_type"] == "image/png"

    assert seen_headers and all(
        h.get("authorization") == "Bearer sse-secret-token" for h in seen_headers
    )
    assert seen_headers_call and all(
        h.get("authorization") == "Bearer sse-secret-token" for h in seen_headers_call
    )


def test_sse_transport_revoked_refresh_token_surfaces_not_connected(fresh_agent_cfg):
    import httpx2

    fresh_agent_cfg.upsert_connector(
        "notion",
        server_url=f"{_AS}/sse",
        display_name="Notion SSE",
        transport="sse",
        source="custom_mcp",
    )
    seen: list[str] = []
    cc = ConnectorClient(
        "notion",
        interactive=False,
        timeout_seconds=5.0,
        storage=_RevokedRefreshStorage(),
    )

    async def _run():
        async with cc.session(http_transport=_oauth_mock_transport(seen, resource_path="/sse")):
            pass  # pragma: no cover

    with pytest.raises(ConnectorError) as ei:
        asyncio.run(_run())
    assert ei.value.code == "E_CONNECTOR_NOT_CONNECTED"
    assert not isinstance(ei.value, httpx2.HTTPError)
    assert any(s.endswith("/token") for s in seen), seen
    assert any("oauth-protected-resource" in s for s in seen), seen


def test_unsupported_transport_raises_protocol_error(fresh_agent_cfg):
    from src.connectors.registry import ConnectorDef

    defn = ConnectorDef(
        connector_id="weird",
        server_url="https://example.test/mcp",
        display_name="Weird",
        transport="grpc",
        source="custom_mcp",
        is_custom=True,
    )
    cc = ConnectorClient("weird", interactive=False, timeout_seconds=1.0, definition=defn)

    async def _run():
        async with cc.session():
            pass  # pragma: no cover

    with pytest.raises(ConnectorError) as ei:
        asyncio.run(_run())
    assert ei.value.code == "E_CONNECTOR_PROTOCOL"


def test_call_tool_normalizes_image_content_camel_and_snake_case():
    import base64
    import io

    from mcp.types import ImageContent
    from PIL import Image

    png_b64 = _png_b64(40, 20)
    jpg_b64 = _encode_pil(Image.new("RGB", (30, 15), (200, 10, 10)), fmt="JPEG")
    result = _FakeCallResult(
        content=[
            _FakeBlock("ok"),
            ImageContent(type="image", data=png_b64, mime_type="image/png"),
            _FakeCamelImageBlock(data=jpg_b64, mime_type="image/jpeg"),
        ]
    )
    cc, _ = _client_with_fake_session(result)
    out = asyncio.run(cc.call_tool("shot", {}))
    assert out["content"] == "ok"
    assert out["truncated"] is False
    assert [img["media_type"] for img in out["images"]] == ["image/png", "image/jpeg"]
    for img, expected_size in zip(out["images"], [(40, 20), (30, 15)]):
        with Image.open(io.BytesIO(base64.b64decode(img["data"]))) as decoded:
            assert decoded.size == expected_size


def test_call_tool_transposes_exif_and_downscales_retina_image():
    import base64
    import io

    from mcp.types import ImageContent
    from PIL import Image

    # 2560x1600 Retina PNG -> downscaled proportionally to 1280x800
    retina_b64 = _png_b64(2560, 1600)
    # 100x50 JPEG with EXIF Orientation=6 -> transposed to 50x100
    exif_img = Image.new("RGB", (100, 50), (0, 255, 0))
    exif = exif_img.getexif()
    exif[274] = 6
    exif_b64 = _encode_pil(exif_img, fmt="JPEG", exif=exif)

    result = _FakeCallResult(
        content=[
            ImageContent(type="image", data=retina_b64, mime_type="image/png"),
            ImageContent(type="image", data=exif_b64, mime_type="image/jpeg"),
        ]
    )
    cc, _ = _client_with_fake_session(result)
    out = asyncio.run(cc.call_tool("shot", {}))
    assert len(out["images"]) == 2
    with Image.open(io.BytesIO(base64.b64decode(out["images"][0]["data"]))) as im0:
        assert im0.size == (1280, 800)
    with Image.open(io.BytesIO(base64.b64decode(out["images"][1]["data"]))) as im1:
        assert im1.size == (50, 100)


def test_call_tool_animated_gif_extracts_first_frame():
    import base64
    import io

    from mcp.types import ImageContent
    from PIL import Image

    f0 = Image.new("RGB", (20, 20), (255, 0, 0))
    f1 = Image.new("RGB", (20, 20), (0, 255, 0))
    buf = io.BytesIO()
    f0.save(buf, format="GIF", save_all=True, append_images=[f1])
    gif_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    result = _FakeCallResult(
        content=[ImageContent(type="image", data=gif_b64, mime_type="image/gif")]
    )
    cc, _ = _client_with_fake_session(result)
    out = asyncio.run(cc.call_tool("shot", {}))
    assert len(out["images"]) == 1
    assert out["images"][0]["media_type"] == "image/png"
    with Image.open(io.BytesIO(base64.b64decode(out["images"][0]["data"]))) as im:
        assert not getattr(im, "is_animated", False)
        assert im.convert("RGB").getpixel((0, 0)) == (255, 0, 0)


def test_call_tool_compresses_oversized_rgba_png_to_jpeg_q85():
    import base64
    import io
    import os

    from mcp.types import ImageContent
    from PIL import Image

    # Deterministic noisy RGBA image (>512 KiB as PNG) triggers JPEG q=85 fallback + white bg flatten.
    raw = os.urandom(1280 * 1280 * 4)
    im = Image.frombytes("RGBA", (1280, 1280), raw)
    png_b64 = _encode_pil(im, fmt="PNG")

    result = _FakeCallResult(
        content=[ImageContent(type="image", data=png_b64, mime_type="image/png")]
    )
    cc, _ = _client_with_fake_session(result)
    out = asyncio.run(cc.call_tool("shot", {}))
    assert len(out["images"]) == 1
    assert out["images"][0]["media_type"] == "image/jpeg"
    decoded_bytes = base64.b64decode(out["images"][0]["data"])
    assert len(decoded_bytes) < 2 * 1024 * 1024
    with Image.open(io.BytesIO(decoded_bytes)) as out_im:
        assert out_im.format == "JPEG"
        assert out_im.mode == "RGB"
        assert out_im.size == (1280, 1280)


def test_call_tool_enforces_max_4_images_cap():
    from mcp.types import ImageContent

    blocks = [
        ImageContent(type="image", data=_png_b64(16, 16, (i * 30, 0, 0)), mime_type="image/png")
        for i in range(6)
    ]
    cc, _ = _client_with_fake_session(_FakeCallResult(content=[_FakeBlock("shots"), *blocks]))
    out = asyncio.run(cc.call_tool("shot", {}))
    assert len(out["images"]) == 4
    assert out["truncated"] is True
    assert "[omitted 2 extra images: payload cap reached]" in out["content"]
    assert out["content"].startswith("shots\n")


def test_call_tool_enforces_2mb_total_payload_cap():
    import base64
    import os

    from mcp.types import ImageContent
    from PIL import Image

    # Each noisy 1280x1280 JPEG q=85 is ~1.2 MB -> 1st fits, 2nd exceeds 2 MiB -> stops appending.
    noisy = []
    for _ in range(3):
        im = Image.frombytes("RGB", (1280, 1280), os.urandom(1280 * 1280 * 3))
        noisy.append(ImageContent(type="image", data=_encode_pil(im, fmt="JPEG", quality=85), mime_type="image/jpeg"))

    cc, _ = _client_with_fake_session(_FakeCallResult(content=noisy))
    out = asyncio.run(cc.call_tool("shot", {}))
    assert len(out["images"]) == 1
    assert out["truncated"] is True
    assert "[omitted 2 extra images: payload cap reached]" in out["content"]
    total_bytes = sum(len(base64.b64decode(img["data"])) for img in out["images"])
    assert total_bytes <= 2 * 1024 * 1024


def test_call_tool_corrupt_and_svg_images_degrade_gracefully():
    import base64

    from mcp.types import ImageContent

    svg_b64 = base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg"></svg>').decode("ascii")
    corrupt_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\ncorrupt").decode("ascii")
    result = _FakeCallResult(
        content=[
            _FakeBlock("ok"),
            ImageContent(type="image", data="not-base64!!!", mime_type="image/png"),
            ImageContent(type="image", data=svg_b64, mime_type="image/svg+xml"),
            ImageContent(type="image", data=corrupt_b64, mime_type="image/png"),
            ImageContent(type="image", data=_png_b64(10, 10), mime_type="image/png"),
        ]
    )
    cc, _ = _client_with_fake_session(result)
    out = asyncio.run(cc.call_tool("shot", {}))
    assert out["truncated"] is False
    assert len(out["images"]) == 1
    assert out["content"].count("[invalid image omitted]") == 3
    assert out["content"].startswith("ok\n")


def test_call_tool_image_cap_note_respects_max_chars_cap():
    from mcp.types import ImageContent
    from src.connectors.client import CALL_RESULT_MAX_CHARS

    blocks = [
        ImageContent(type="image", data=_png_b64(12, 12), mime_type="image/png")
        for _ in range(5)
    ]
    result = _FakeCallResult(
        content=[_FakeBlock("a" * (CALL_RESULT_MAX_CHARS + 50)), *blocks]
    )
    cc, _ = _client_with_fake_session(result)
    out = asyncio.run(cc.call_tool("shot", {}))
    assert out["truncated"] is True
    assert len(out["images"]) == 4
    assert len(out["content"]) <= CALL_RESULT_MAX_CHARS
    assert out["content"].endswith("[omitted 1 extra images: payload cap reached]")
