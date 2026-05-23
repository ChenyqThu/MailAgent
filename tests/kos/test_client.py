"""Tests for src.kos.client (PR-2c).

覆盖:
    - configured 属性 (3 env 都设才 True)
    - health (200 / 5xx / network)
    - /token 流: 200 / 401 / missing access_token / network
    - token cache: 命中 reuse / safety buffer 60s / 强制 refresh
    - /mcp 流: SSE / JSON response parse / 401 retry / 429 / 5xx
    - JSON-RPC envelope: result / error
    - tool result unwrap: content[0].text JSON 二次解
    - query / list_pages / put_page 便捷方法

Mock 策略: httpx.MockTransport 注入 - 不调真实网络.
"""

from __future__ import annotations

import json
import time

import httpx
import pytest

from src.kos.client import KOSClient, KOSError, KOSTokenCache


# ============================================================
# Helper - mock transport builder
# ============================================================

def _sse_envelope(payload: dict | list) -> str:
    """组 SSE response body: 'event: message\\ndata: <json>\\n\\n'."""
    return f"event: message\ndata: {json.dumps(payload)}\n\n"


def _tool_result(inner_payload: object) -> dict:
    """组 JSON-RPC result: {result:{content:[{type:'text', text:'<json>'}]}}."""
    return {
        "jsonrpc": "2.0",
        "id": "mock-1",
        "result": {
            "content": [{"type": "text", "text": json.dumps(inner_payload)}]
        },
    }


def _make_client(handler) -> KOSClient:
    """构造 KOSClient + httpx.MockTransport 注入."""
    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)
    return KOSClient(
        base_url="https://kos.test",
        client_id="cl_mock",
        client_secret="cs_mock",
        http_client=http_client,
    )


# ============================================================
# configured 属性
# ============================================================

class TestConfigured:
    def test_fully_configured(self):
        c = KOSClient(
            base_url="https://kos.test",
            client_id="cl",
            client_secret="cs",
        )
        assert c.configured is True

    def test_missing_base_url(self, monkeypatch):
        monkeypatch.delenv("KOS_MCP_BASE", raising=False)
        c = KOSClient(client_id="cl", client_secret="cs")
        assert c.configured is False

    def test_missing_client_id(self, monkeypatch):
        monkeypatch.delenv("KOS_OAUTH_CLIENT_ID", raising=False)
        c = KOSClient(base_url="https://kos.test", client_secret="cs")
        assert c.configured is False

    def test_missing_secret(self, monkeypatch):
        monkeypatch.delenv("KOS_OAUTH_CLIENT_SECRET", raising=False)
        c = KOSClient(base_url="https://kos.test", client_id="cl")
        assert c.configured is False

    def test_env_var_fallback(self, monkeypatch):
        monkeypatch.setenv("KOS_MCP_BASE", "https://from-env.test")
        monkeypatch.setenv("KOS_OAUTH_CLIENT_ID", "cl_env")
        monkeypatch.setenv("KOS_OAUTH_CLIENT_SECRET", "cs_env")
        c = KOSClient()
        assert c.configured
        assert c.base_url == "https://from-env.test"
        assert c.client_id == "cl_env"
        assert c.client_secret == "cs_env"

    def test_trailing_slash_stripped(self):
        c = KOSClient(
            base_url="https://kos.test/",
            client_id="cl",
            client_secret="cs",
        )
        assert c.base_url == "https://kos.test"


# ============================================================
# health
# ============================================================

class TestHealth:
    def test_health_ok(self):
        def handler(req: httpx.Request) -> httpx.Response:
            assert req.url.path == "/health"
            assert req.method == "GET"
            return httpx.Response(
                200,
                json={"status": "ok", "version": "0.38.2.0", "engine": "postgres"},
            )
        c = _make_client(handler)
        assert c.health() == {
            "status": "ok", "version": "0.38.2.0", "engine": "postgres",
        }

    def test_health_5xx(self):
        def handler(req):
            return httpx.Response(503, text="upstream down")
        c = _make_client(handler)
        with pytest.raises(KOSError) as exc:
            c.health()
        assert exc.value.code == "E_KOS_HEALTH"
        assert exc.value.status == 503

    def test_health_not_configured(self):
        c = KOSClient(base_url="", client_id="cl", client_secret="cs")
        with pytest.raises(KOSError) as exc:
            c.health()
        assert exc.value.code == "E_KOS_NOT_CONFIGURED"


# ============================================================
# /token flow + cache
# ============================================================

class TestToken:
    def test_token_fetched_on_first_call(self):
        token_calls = []

        def handler(req: httpx.Request) -> httpx.Response:
            if req.url.path == "/token":
                token_calls.append(req)
                return httpx.Response(
                    200,
                    json={
                        "access_token": "gbrain_at_mock_1",
                        "token_type": "bearer",
                        "expires_in": 3600,
                        "scope": "read write",
                    },
                )
            # /mcp returns dummy result
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=_sse_envelope(_tool_result([])),
            )

        c = _make_client(handler)
        c.call_tool("query", {"query": "x"})
        assert len(token_calls) == 1
        # request body form-urlencoded with grant_type
        body = token_calls[0].content.decode()
        assert "grant_type=client_credentials" in body
        assert "client_id=cl_mock" in body
        assert "client_secret=cs_mock" in body
        # scope=read+write or scope=read%20write
        assert "scope=" in body

    def test_token_cached_across_calls(self):
        token_calls = 0

        def handler(req):
            nonlocal token_calls
            if req.url.path == "/token":
                token_calls += 1
                return httpx.Response(
                    200,
                    json={"access_token": "gbrain_at_x", "expires_in": 3600},
                )
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=_sse_envelope(_tool_result([])),
            )

        c = _make_client(handler)
        c.call_tool("query", {"query": "1"})
        c.call_tool("query", {"query": "2"})
        c.call_tool("list_pages", {})
        assert token_calls == 1  # 缓存命中

    def test_token_safety_buffer_triggers_refresh(self):
        """expires_at - now < 60s → 视为 expired, 重新 fetch."""
        token_calls = 0

        def handler(req):
            nonlocal token_calls
            if req.url.path == "/token":
                token_calls += 1
                return httpx.Response(
                    200,
                    # 故意短 expires_in 让 cache 立即失效
                    json={"access_token": "tk", "expires_in": 30},
                )
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=_sse_envelope(_tool_result([])),
            )

        c = _make_client(handler)
        c.call_tool("query", {"query": "1"})
        c.call_tool("query", {"query": "2"})
        # safety buffer 60s 比 expires_in 30s 大 → 第二次也 refresh
        assert token_calls == 2

    def test_token_http_error(self):
        def handler(req):
            if req.url.path == "/token":
                return httpx.Response(401, text="invalid_client")
            return httpx.Response(200, json={})

        c = _make_client(handler)
        with pytest.raises(KOSError) as exc:
            c.call_tool("query", {"query": "x"})
        assert exc.value.code == "E_KOS_TOKEN_HTTP"
        assert exc.value.status == 401

    def test_token_missing_access_token_field(self):
        def handler(req):
            if req.url.path == "/token":
                return httpx.Response(200, json={"foo": "bar"})  # no access_token
            return httpx.Response(200, json={})

        c = _make_client(handler)
        with pytest.raises(KOSError) as exc:
            c.call_tool("query", {})
        assert exc.value.code == "E_KOS_TOKEN_INVALID"


# ============================================================
# /mcp call_tool — response shapes
# ============================================================

class TestCallTool:
    def test_sse_response_parsed(self):
        hits_payload = [{"slug": "concepts/redis", "score": 0.9}]

        def handler(req):
            if req.url.path == "/token":
                return httpx.Response(
                    200, json={"access_token": "t", "expires_in": 3600}
                )
            assert req.headers["authorization"] == "Bearer t"
            assert "event-stream" in req.headers["accept"]
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=_sse_envelope(_tool_result(hits_payload)),
            )

        c = _make_client(handler)
        result = c.call_tool("query", {"query": "redis"})
        assert result == hits_payload

    def test_json_response_parsed(self):
        """server 也可能返 application/json 而不是 SSE."""
        def handler(req):
            if req.url.path == "/token":
                return httpx.Response(
                    200, json={"access_token": "t", "expires_in": 3600}
                )
            return httpx.Response(
                200,
                headers={"content-type": "application/json"},
                json=_tool_result({"slug": "x"}),
            )

        c = _make_client(handler)
        result = c.call_tool("get", {})
        assert result == {"slug": "x"}

    def test_401_triggers_refresh_and_retry(self):
        token_calls = 0
        mcp_calls = 0

        def handler(req):
            nonlocal token_calls, mcp_calls
            if req.url.path == "/token":
                token_calls += 1
                return httpx.Response(
                    200, json={"access_token": f"tk_{token_calls}", "expires_in": 3600}
                )
            mcp_calls += 1
            if mcp_calls == 1:
                return httpx.Response(401, text="expired")
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=_sse_envelope(_tool_result(["ok"])),
            )

        c = _make_client(handler)
        result = c.call_tool("query", {"query": "x"})
        assert result == ["ok"]
        assert token_calls == 2  # 一次初始 + 一次 refresh
        assert mcp_calls == 2

    def test_429_rate_limit(self):
        def handler(req):
            if req.url.path == "/token":
                return httpx.Response(
                    200, json={"access_token": "t", "expires_in": 3600}
                )
            return httpx.Response(429, text="rate-limited")

        c = _make_client(handler)
        with pytest.raises(KOSError) as exc:
            c.call_tool("query", {})
        assert exc.value.code == "E_KOS_RATE_LIMIT"
        assert exc.value.status == 429

    def test_500_http_error(self):
        def handler(req):
            if req.url.path == "/token":
                return httpx.Response(
                    200, json={"access_token": "t", "expires_in": 3600}
                )
            return httpx.Response(500, text="server error")

        c = _make_client(handler)
        with pytest.raises(KOSError) as exc:
            c.call_tool("query", {})
        assert exc.value.code == "E_KOS_HTTP"
        assert exc.value.status == 500

    def test_jsonrpc_error_envelope(self):
        def handler(req):
            if req.url.path == "/token":
                return httpx.Response(
                    200, json={"access_token": "t", "expires_in": 3600}
                )
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=_sse_envelope({
                    "jsonrpc": "2.0", "id": "1",
                    "error": {"code": -32602, "message": "invalid params"},
                }),
            )

        c = _make_client(handler)
        with pytest.raises(KOSError) as exc:
            c.call_tool("query", {})
        assert exc.value.code == "E_KOS_RPC"
        assert "invalid params" in str(exc.value)

    def test_not_configured_raises(self):
        c = KOSClient(base_url="", client_id="", client_secret="")
        with pytest.raises(KOSError) as exc:
            c.call_tool("query", {})
        assert exc.value.code == "E_KOS_NOT_CONFIGURED"


# ============================================================
# 便捷方法 query / list_pages / put_page
# ============================================================

class TestConvenienceMethods:
    def test_query_returns_list(self):
        def handler(req):
            if req.url.path == "/token":
                return httpx.Response(
                    200, json={"access_token": "t", "expires_in": 3600}
                )
            # verify params 传过去
            body = json.loads(req.content)
            assert body["params"]["name"] == "query"
            assert body["params"]["arguments"]["query"] == "test"
            assert body["params"]["arguments"]["limit"] == 5
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=_sse_envelope(_tool_result([{"slug": "x"}, {"slug": "y"}])),
            )

        c = _make_client(handler)
        hits = c.query("test", limit=5)
        assert hits == [{"slug": "x"}, {"slug": "y"}]

    def test_query_non_list_result_returns_empty(self):
        """防御: query 返了 dict 而不是 list → 返 [] 不抛."""
        def handler(req):
            if req.url.path == "/token":
                return httpx.Response(
                    200, json={"access_token": "t", "expires_in": 3600}
                )
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=_sse_envelope(_tool_result({"not": "a list"})),
            )

        c = _make_client(handler)
        assert c.query("x") == []

    def test_list_pages_caps_limit(self):
        def handler(req):
            if req.url.path == "/token":
                return httpx.Response(
                    200, json={"access_token": "t", "expires_in": 3600}
                )
            body = json.loads(req.content)
            assert body["params"]["arguments"]["limit"] == 100  # capped from 200
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=_sse_envelope(_tool_result([])),
            )

        c = _make_client(handler)
        c.list_pages(limit=200)

    def test_put_page_payload(self):
        def handler(req):
            if req.url.path == "/token":
                return httpx.Response(
                    200, json={"access_token": "t", "expires_in": 3600}
                )
            body = json.loads(req.content)
            assert body["params"]["name"] == "put_page"
            assert body["params"]["arguments"]["slug"] == "sources/mailagent-foo"
            assert "frontmatter" in body["params"]["arguments"]["content"]
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                text=_sse_envelope(_tool_result({
                    "slug": "sources/mailagent-foo",
                    "status": "created_or_updated",
                    "chunks": 3,
                })),
            )

        c = _make_client(handler)
        result = c.put_page(
            "sources/mailagent-foo",
            "---\nfrontmatter\n---\nbody",
        )
        assert result["status"] == "created_or_updated"
        assert result["chunks"] == 3


# ============================================================
# Internal helpers
# ============================================================

class TestSseExtract:
    def test_basic_data_line(self):
        body = 'event: message\ndata: {"x":1}\n\n'
        env = KOSClient._extract_sse_envelope(body)
        assert env == {"x": 1}

    def test_skips_event_lines_only(self):
        body = 'event: ping\n\nevent: message\ndata: {"y":2}\n\n'
        env = KOSClient._extract_sse_envelope(body)
        assert env == {"y": 2}

    def test_missing_data_line_raises(self):
        with pytest.raises(KOSError) as exc:
            KOSClient._extract_sse_envelope("event: foo\n\n")
        assert exc.value.code == "E_KOS_PARSE"

    def test_invalid_json_raises(self):
        body = "data: not-json\n\n"
        with pytest.raises(KOSError) as exc:
            KOSClient._extract_sse_envelope(body)
        assert exc.value.code == "E_KOS_PARSE"

    def test_done_sentinel_skipped(self):
        body = "data: [DONE]\n\ndata: {\"x\":1}\n\n"
        env = KOSClient._extract_sse_envelope(body)
        assert env == {"x": 1}


class TestUnwrapToolResult:
    def test_unwraps_text_json(self):
        result = {"content": [{"type": "text", "text": '{"slug":"a"}'}]}
        assert KOSClient._unwrap_tool_result(result) == {"slug": "a"}

    def test_returns_text_if_not_json(self):
        result = {"content": [{"type": "text", "text": "just a string"}]}
        assert KOSClient._unwrap_tool_result(result) == "just a string"

    def test_returns_result_if_no_text_content(self):
        result = {"content": [{"type": "image", "data": "..."}]}
        assert KOSClient._unwrap_tool_result(result) == result

    def test_returns_result_if_no_content(self):
        result = {"foo": "bar"}
        assert KOSClient._unwrap_tool_result(result) == {"foo": "bar"}

    def test_returns_result_if_not_dict(self):
        assert KOSClient._unwrap_tool_result("x") == "x"
        assert KOSClient._unwrap_tool_result([1, 2]) == [1, 2]


class TestTokenCacheDataclass:
    def test_invalid_when_no_token(self):
        c = KOSTokenCache()
        assert c.is_valid() is False

    def test_valid_when_far_future(self):
        c = KOSTokenCache(token="x", expires_at=time.time() + 7200)
        assert c.is_valid() is True

    def test_invalid_inside_safety_buffer(self):
        c = KOSTokenCache(token="x", expires_at=time.time() + 30)
        assert c.is_valid() is False  # < 60s 即视为 expired

    def test_invalid_in_past(self):
        c = KOSTokenCache(token="x", expires_at=time.time() - 10)
        assert c.is_valid() is False
