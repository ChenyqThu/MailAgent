"""Phase 4 WP-4C — LLMClient loopback gateway routing & fail-open tests."""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx
import pytest

from src.llm_agent.client import LLMCallError, LLMClient, LLMResult
from src.llm_agent.model_cost import estimate_cache_saved_usd, estimate_cost_usd
from src.llm_agent import provider_routing


class _DummyRoute:
    def __init__(self, protocol: str, model_id: str) -> None:
        self.provider_id = "p1"
        self.protocol = protocol
        self.model_id = model_id
        self.is_default = False
        self.base_url = "https://example.invalid"
        self.api_key = "k"
        self.headers: Dict[str, str] = {}
        self.max_output = None


def _sample_schema() -> Dict[str, Any]:
    return {
        "name": "pick_category",
        "description": "Pick email category",
        "input_schema": {
            "type": "object",
            "properties": {"category": {"type": "string"}},
            "required": ["category"],
        },
    }


@pytest.mark.asyncio
async def test_classify_uses_loopback_gateway_supports_google_and_converts_uncached_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MAILAGENT_LOCAL_API_TOKEN", "tok-secret")
    monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", "18300")
    monkeypatch.setattr(provider_routing, "registry_enabled", lambda: True)
    monkeypatch.setattr(
        provider_routing, "resolve_route", lambda m: _DummyRoute("google", "gemini-2.5-pro")
    )

    seen_requests: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_requests.append(request)
        body = json.loads(request.content.decode("utf-8"))
        assert request.headers["X-MailAgent-Local-Token"] == "tok-secret"
        assert body["recordUsage"] is False
        assert body["toolChoice"] == {"type": "tool", "toolName": "pick_category"}
        return httpx.Response(
            200,
            json={
                "ok": True,
                "model": "gemini-2.5-pro",
                "providerId": "p1",
                "protocol": "google",
                "text": "",
                "toolCalls": [
                    {
                        "toolCallId": "tc1",
                        "toolName": "pick_category",
                        "input": {"category": "work"},
                    }
                ],
                "finishReason": "tool-calls",
                "usage": {
                    "inputTokens": 1000,
                    "outputTokens": 50,
                    "cacheReadTokens": 700,
                    "cacheWriteTokens": 100,
                    "noCacheTokens": 200,
                },
                "costUsd": 0.002,
                "latencyMs": 33,
            },
        )

    client = LLMClient()
    client._gateway_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        res = await client.classify(
            system_blocks=[{"text": "sys", "cache_control": {"type": "ephemeral"}}],
            user_content="hello",
            tool_schema=_sample_schema(),
            tool_name="pick_category",
            model_chain=["p1:gemini-2.5-pro"],
        )
    finally:
        await client.close()

    assert len(seen_requests) == 1
    assert res.tool_input == {"category": "work"}
    # AI SDK total inputTokens (1000) converted to Python uncached-only (200)
    assert res.input_tokens == 200
    assert res.cache_read_input_tokens == 700
    assert res.cache_creation_input_tokens == 100
    assert res.output_tokens == 50
    assert res.model == "gemini-2.5-pro"


@pytest.mark.asyncio
async def test_classify_fails_open_to_direct_leg_on_connect_error_and_records_py_usage(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv("MAILAGENT_LOCAL_API_TOKEN", "tok-secret")
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    from src.agent_config.llm_providers import (
        get_llm_provider_store,
        reset_llm_provider_store_cache,
    )

    reset_llm_provider_store_cache()
    monkeypatch.setattr(provider_routing, "registry_enabled", lambda: False)

    def fail_connect(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("gateway down", request=request)

    client = LLMClient()
    client._gateway_http = httpx.AsyncClient(transport=httpx.MockTransport(fail_connect))

    async def fake_anthropic(**kwargs: Any) -> LLMResult:
        return LLMResult(
            tool_input={"category": "direct"},
            input_tokens=120,
            output_tokens=20,
            cache_creation_input_tokens=10,
            cache_read_input_tokens=40,
            model="claude-sonnet-4-6",
            latency_ms=15,
        )

    monkeypatch.setattr(client, "_classify_anthropic", fake_anthropic)
    try:
        res = await client.classify(
            system_blocks=[{"text": "sys"}],
            user_content="hi",
            tool_schema=_sample_schema(),
            tool_name="pick_category",
            model_chain=["claude-sonnet-4-6"],
            usage_surface="memory_capture",
        )
    finally:
        await client.close()

    assert res.tool_input == {"category": "direct"}
    # Direct fallback with usage_surface records into py_llm_usage_log
    store = get_llm_provider_store()
    with store._connection() as conn:
        rows = conn.execute("SELECT surface, model, input_tokens FROM py_llm_usage_log").fetchall()
    assert len(rows) == 1
    assert rows[0]["surface"] == "memory_capture"
    assert rows[0]["input_tokens"] == 120
    reset_llm_provider_store_cache()


@pytest.mark.asyncio
async def test_classify_gateway_429_triggers_model_chain_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv("MAILAGENT_LOCAL_API_TOKEN", "tok-secret")
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    from src.agent_config.llm_providers import (
        get_llm_provider_store,
        reset_llm_provider_store_cache,
    )

    reset_llm_provider_store_cache()
    monkeypatch.setattr(provider_routing, "registry_enabled", lambda: False)

    called_models: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        called_models.append(body["model"])
        if body["model"] == "claude-primary":
            return httpx.Response(
                429,
                json={"ok": False, "error": {"code": "E_QUOTA", "message": "HTTP 429 rate limited"}},
            )
        return httpx.Response(
            200,
            json={
                "ok": True,
                "model": "claude-backup",
                "text": "",
                "toolCalls": [
                    {"toolCallId": "t1", "toolName": "pick_category", "input": {"category": "ok"}}
                ],
                "finishReason": "tool-calls",
                "usage": {"inputTokens": 30, "outputTokens": 10, "cacheReadTokens": 0, "cacheWriteTokens": 0},
                "costUsd": 0.0,
                "latencyMs": 5,
            },
        )

    client = LLMClient()
    client._gateway_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        res = await client.classify(
            system_blocks=[{"text": "sys"}],
            user_content="hi",
            tool_schema=_sample_schema(),
            tool_name="pick_category",
            model_chain=["claude-primary", "claude-backup"],
        )
    finally:
        await client.close()

    assert called_models == ["claude-primary", "claude-backup"]
    assert res.model == "claude-backup"
    # Primary failure recorded in llm_probe_log
    logs = get_llm_provider_store().list_probe_logs(limit=10)
    assert any(l["kind"] == "runtime_error" and l["model"] == "claude-primary" for l in logs)
    reset_llm_provider_store_cache()


@pytest.mark.asyncio
async def test_run_tool_loop_via_gateway_executes_local_tools_and_accumulates_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MAILAGENT_LOCAL_API_TOKEN", "tok-secret")
    monkeypatch.setattr(provider_routing, "registry_enabled", lambda: True)
    monkeypatch.setattr(
        provider_routing, "resolve_route", lambda m: _DummyRoute("google", "gemini-2.5-pro")
    )

    step = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal step
        step += 1
        body = json.loads(request.content.decode("utf-8"))
        assert body["recordUsage"] is True
        if step == 1:
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "model": "gemini-2.5-pro",
                    "text": "checking",
                    "toolCalls": [{"toolCallId": "c1", "toolName": "lookup", "input": {"id": 7}}],
                    "finishReason": "tool-calls",
                    "usage": {
                        "inputTokens": 500,
                        "outputTokens": 20,
                        "cacheReadTokens": 300,
                        "cacheWriteTokens": 0,
                        "noCacheTokens": 200,
                    },
                    "latencyMs": 10,
                },
            )
        # Step 2 must carry assistant toolCalls + tool result message
        assert any(m["role"] == "tool" for m in body["messages"])
        return httpx.Response(
            200,
            json={
                "ok": True,
                "model": "gemini-2.5-pro",
                "text": "",
                "toolCalls": [
                    {
                        "toolCallId": "c2",
                        "toolName": "finish_report",
                        "input": {"summary": "all good"},
                    }
                ],
                "finishReason": "tool-calls",
                "usage": {
                    "inputTokens": 600,
                    "outputTokens": 30,
                    "cacheReadTokens": 500,
                    "cacheWriteTokens": 50,
                    "noCacheTokens": 50,
                },
                "latencyMs": 12,
            },
        )

    client = LLMClient()
    client._gateway_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        loop_res = await client.run_tool_loop(
            system_blocks=[{"text": "sys", "cache_control": {"type": "ephemeral"}}],
            user_content="run loop",
            tools=[
                {"name": "lookup", "description": "Lookup", "input_schema": {"type": "object"}},
                {
                    "name": "finish_report",
                    "description": "Finish",
                    "input_schema": {"type": "object"},
                },
            ],
            tool_handlers={"lookup": lambda args: f"item-{args['id']}"},
            final_tool="finish_report",
            model_chain=["p1:gemini-2.5-pro"],
            max_iter=4,
            usage_surface="py_loopback",
        )
    finally:
        await client.close()

    assert loop_res.final_input == {"summary": "all good"}
    assert loop_res.iterations == 2
    assert loop_res.input_tokens == 250  # 200 + 50
    assert loop_res.cache_read_input_tokens == 800  # 300 + 500
    assert loop_res.cache_creation_input_tokens == 50
    assert loop_res.output_tokens == 50
    assert len(loop_res.tool_calls) == 1
    assert loop_res.tool_calls[0]["name"] == "lookup"
    assert loop_res.tool_calls[0]["output_preview"] == "item-7"


def test_python_model_cost_4_tier_and_cache_saved() -> None:
    cost = estimate_cost_usd(
        "claude-sonnet-4-6",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_read_tokens=1_000_000,
        cache_write_tokens=1_000_000,
        protocol="anthropic",
        input_is_uncached_only=True,
    )
    saved = estimate_cache_saved_usd(
        "claude-sonnet-4-6", cache_read_tokens=1_000_000, protocol="anthropic"
    )
    assert cost is not None and cost > 0
    assert saved is not None and saved > 0
