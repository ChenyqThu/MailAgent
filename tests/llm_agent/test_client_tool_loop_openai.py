"""run_tool_loop 的 OpenAI 协议腿单测（task 07-12 P2 决策 3；mock httpx SSE，无网络）。

覆盖：多轮 tool_calls 重放 + role:"tool" 回传 / delta 分片聚合 / 并行 tool call /
最后一轮强制 final_tool / 纯文本 nudge / 工具错误回灌 / google 过滤 / 用尽轮数。
flag off 的过滤行为由既有 tests/reports/test_reports.py::test_loop_requires_anthropic_model
零改动通过背书。
"""

from __future__ import annotations

import asyncio
import json

import pytest

import src.llm_agent.client as client_mod
from src.llm_agent.client import LLMCallError, LLMClient
from src.llm_agent.provider_routing import ProviderRoute

ROUTE = ProviderRoute(
    provider_id="dashscope",
    protocol="openai-compatible",
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    api_key="sk-x",
    model_id="qwen-max",
    model_ref="dashscope:qwen-max",
)


class _FakeResp:
    def __init__(self, lines, status=200, err=b"upstream error"):
        self._lines = lines
        self.status_code = status
        self._err = err

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def aread(self):
        return self._err

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _FakeHttp:
    def __init__(self, turns):
        self._turns = list(turns)
        self.requests = []

    def stream(self, method, path, json=None, headers=None):
        self.requests.append({"method": method, "path": path, "json": json})
        return self._turns.pop(0)


def _sse(obj) -> str:
    return "data: " + json.dumps(obj)


def _tc_delta(*tcs):
    return _sse({"choices": [{"delta": {"tool_calls": list(tcs)}}]})


def _finish(reason):
    return _sse({"choices": [{"delta": {}, "finish_reason": reason}]})


def _usage(p, c):
    return _sse({"usage": {"prompt_tokens": p, "completion_tokens": c}})


def _turn_tool_call_fragmented():
    """工具调用轮：name 整段先到，arguments 跨 3 个 delta 分片。"""
    return _FakeResp([
        _tc_delta({"index": 0, "id": "call_a", "type": "function",
                   "function": {"name": "search_emails"}}),
        _tc_delta({"index": 0, "function": {"arguments": '{"que'}}),
        _tc_delta({"index": 0, "function": {"arguments": 'ry": "re'}}),
        _tc_delta({"index": 0, "function": {"arguments": 'dis"}'}}),
        _finish("tool_calls"),
        _usage(10, 5),
        "data: [DONE]",
    ])


def _turn_final(args='{"headline": "H"}'):
    return _FakeResp([
        _tc_delta({"index": 0, "id": "call_b", "type": "function",
                   "function": {"name": "build_report", "arguments": args}}),
        _finish("tool_calls"),
        _usage(20, 8),
        "data: [DONE]",
    ])


def _client_with(turns, monkeypatch, routes=None):
    monkeypatch.setattr(client_mod.provider_routing, "registry_enabled", lambda: True)
    mapping = routes if routes is not None else {"dashscope:qwen-max": ROUTE}
    monkeypatch.setattr(
        client_mod.provider_routing, "resolve_route", lambda ref: mapping.get(ref)
    )
    client = LLMClient()
    fake = _FakeHttp(turns)
    client._http_by_provider[ROUTE.provider_id] = (client._route_sig(ROUTE), fake)
    return client, fake


def _run(client, **over):
    kwargs = dict(
        system_blocks=[{"type": "text", "text": "sys"}],
        user_content="u",
        tools=[{"name": "search_emails", "description": "d",
                "input_schema": {"type": "object", "properties": {}}},
               {"name": "build_report", "description": "d",
                "input_schema": {"type": "object", "properties": {}}}],
        tool_handlers=over.pop("tool_handlers", {}),
        final_tool="build_report",
        model_chain=["dashscope:qwen-max"],
        max_iter=5,
    )
    kwargs.update(over)
    return asyncio.run(client.run_tool_loop(**kwargs))


def test_loop_tool_then_final_with_replay(monkeypatch):
    handled: list = []

    def h(inp):
        handled.append(inp)
        return "result-x"

    client, fake = _client_with(
        [_turn_tool_call_fragmented(), _turn_final()], monkeypatch
    )
    res = _run(client, tool_handlers={"search_emails": h})

    assert res.final_input == {"headline": "H"}
    assert res.iterations == 2
    assert handled == [{"query": "redis"}]  # 分片 arguments 聚合后解析
    assert res.input_tokens == 30 and res.output_tokens == 13
    assert res.cache_read_input_tokens == 0
    assert res.tool_calls and res.tool_calls[0]["name"] == "search_emails"
    assert res.tool_calls[0]["output_preview"] == "result-x"

    # 第 2 轮请求：assistant tool_calls 重放 + role:"tool" 结果回传（id 对齐）
    req2 = fake.requests[1]["json"]
    assert fake.requests[0]["path"] == "/chat/completions"
    assert req2["model"] == "qwen-max"  # wire id
    replayed = req2["messages"]
    assistant = next(m for m in replayed if m["role"] == "assistant")
    assert assistant["tool_calls"][0]["id"] == "call_a"
    assert assistant["tool_calls"][0]["function"]["name"] == "search_emails"
    assert assistant["tool_calls"][0]["function"]["arguments"] == '{"query": "redis"}'
    tool_msg = next(m for m in replayed if m["role"] == "tool")
    assert tool_msg["tool_call_id"] == "call_a"
    assert tool_msg["content"] == "result-x"
    # 第 1 轮 auto、非最后一轮不强制
    assert fake.requests[0]["json"]["tool_choice"] == "auto"


def test_loop_forced_final_on_last_iter(monkeypatch):
    client, fake = _client_with([_turn_final()], monkeypatch)
    res = _run(client, max_iter=1)
    assert res.final_input == {"headline": "H"}
    assert fake.requests[0]["json"]["tool_choice"] == {
        "type": "function", "function": {"name": "build_report"}
    }


def test_loop_text_turn_gets_nudge(monkeypatch):
    text_turn = _FakeResp([
        _sse({"choices": [{"delta": {"content": "先说两句"}}]}),
        _finish("stop"),
        _usage(5, 2),
        "data: [DONE]",
    ])
    client, fake = _client_with([text_turn, _turn_final()], monkeypatch)
    res = _run(client)
    assert res.iterations == 2
    replayed = fake.requests[1]["json"]["messages"]
    assert {"role": "assistant", "content": "先说两句"} in replayed
    assert any(
        m["role"] == "user" and "build_report" in m["content"] for m in replayed[2:]
    )


def test_loop_parallel_tool_calls_and_error_feedback(monkeypatch):
    parallel_turn = _FakeResp([
        _tc_delta(
            {"index": 0, "id": "c0", "function": {"name": "search_emails",
                                                  "arguments": '{"query": "a"}'}},
            {"index": 1, "id": "c1", "function": {"name": "nope",
                                                  "arguments": "{}"}},
        ),
        _finish("tool_calls"),
        "data: [DONE]",
    ])
    client, fake = _client_with([parallel_turn, _turn_final()], monkeypatch)

    def boom(_inp):
        raise RuntimeError("handler down")

    res = _run(client, tool_handlers={"search_emails": boom})
    assert res.final_input == {"headline": "H"}
    replayed = fake.requests[1]["json"]["messages"]
    tool_msgs = [m for m in replayed if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == ["c0", "c1"]
    assert tool_msgs[0]["content"].startswith("error: RuntimeError")  # 异常回灌
    assert tool_msgs[1]["content"] == "error: unknown tool 'nope'"


def test_loop_google_filtered_openai_allowed(monkeypatch):
    g = ProviderRoute(provider_id="gem", protocol="google", base_url="",
                      api_key="k", model_id="gemini-3", model_ref="gem:gemini-3")
    client, fake = _client_with(
        [_turn_final()], monkeypatch,
        routes={"gem:gemini-3": g, "dashscope:qwen-max": ROUTE},
    )
    res = _run(client, model_chain=["gem:gemini-3", "dashscope:qwen-max"])
    assert res.final_input == {"headline": "H"}
    assert len(fake.requests) == 1  # google 在链过滤阶段被跳过，未产生请求


def test_loop_all_google_chain_raises(monkeypatch):
    g = ProviderRoute(provider_id="gem", protocol="google", base_url="",
                      api_key="k", model_id="gemini-3", model_ref="gem:gemini-3")
    client, _fake = _client_with([], monkeypatch, routes={"gem:gemini-3": g})
    with pytest.raises(LLMCallError, match="no usable model"):
        _run(client, model_chain=["gem:gemini-3"])


def test_loop_exhausted_raises(monkeypatch):
    turns = [_turn_tool_call_fragmented() for _ in range(2)]
    client, _fake = _client_with(turns, monkeypatch)
    with pytest.raises(LLMCallError, match="exhausted"):
        _run(client, max_iter=2, tool_handlers={"search_emails": lambda i: "ok"})


def test_loop_http_error_redacts_provider_secrets(monkeypatch):
    """HIGH-3：loop 腿（_openai_stream_turn）的上游错误正文同样过 redactor。"""
    err = b"gateway echo Authorization: Bearer sk-x full-dump"
    client, _fake = _client_with([_FakeResp([], status=500, err=err)], monkeypatch)
    with pytest.raises(LLMCallError) as ei:
        _run(client)
    msg = str(ei.value)
    assert "sk-x" not in msg  # ROUTE.api_key
    assert "500" in msg and "***" in msg


def test_loop_explicit_ref_route_error_falls_back(monkeypatch):
    """MEDIUM-4：链里显式 ref 路由失败（provider 缺失/禁用）→ warning + 跳下一个模型，
    不静默把 missing:m 改道全局网关。"""

    def _resolve(ref):
        if ref == "missing:m":
            raise client_mod.provider_routing.ProviderRouteError(
                "provider 'missing' referenced by model 'missing:m' is not available"
            )
        return {"dashscope:qwen-max": ROUTE}.get(ref)

    monkeypatch.setattr(client_mod.provider_routing, "registry_enabled", lambda: True)
    monkeypatch.setattr(client_mod.provider_routing, "resolve_route", _resolve)
    client = LLMClient()
    fake = _FakeHttp([_turn_final()])
    client._http_by_provider[ROUTE.provider_id] = (client._route_sig(ROUTE), fake)

    res = _run(client, model_chain=["missing:m", "dashscope:qwen-max"])
    assert res.final_input == {"headline": "H"}
    assert len(fake.requests) == 1 and fake.requests[0]["json"]["model"] == "qwen-max"


DEEPSEEK_ROUTE = ProviderRoute(
    provider_id="deepseek",
    protocol="deepseek",
    base_url="https://api.deepseek.com",
    api_key="sk-d",
    model_id="deepseek-v4-pro",
    model_ref="deepseek:deepseek-v4-pro",
)


def _client_deepseek(turns, monkeypatch):
    monkeypatch.setattr(client_mod.provider_routing, "registry_enabled", lambda: True)
    monkeypatch.setattr(
        client_mod.provider_routing, "resolve_route",
        lambda ref: {"deepseek:deepseek-v4-pro": DEEPSEEK_ROUTE}.get(ref),
    )
    client = LLMClient()
    fake = _FakeHttp(turns)
    client._http_by_provider[DEEPSEEK_ROUTE.provider_id] = (
        client._route_sig(DEEPSEEK_ROUTE), fake
    )
    return client, fake


def test_loop_deepseek_forced_final_injects_thinking_disabled(monkeypatch):
    """P5 dogfood quirk：deepseek 强制轮（最后一轮 forced final_tool）body 注入
    {"thinking":{"type":"disabled"}}（thinking 下强制 tool_choice 400）。"""
    client, fake = _client_deepseek([_turn_final()], monkeypatch)
    res = _run(client, model_chain=["deepseek:deepseek-v4-pro"], max_iter=1)
    assert res.final_input == {"headline": "H"}
    body = fake.requests[0]["json"]
    assert body["tool_choice"] == {
        "type": "function", "function": {"name": "build_report"}
    }
    assert body["thinking"] == {"type": "disabled"}


def test_loop_deepseek_auto_turn_keeps_thinking(monkeypatch):
    """auto 轮不注入（保留 thinking 推理能力）；同一 loop 的最后强制轮才注入。"""
    client, fake = _client_deepseek(
        [_turn_tool_call_fragmented(), _turn_final()], monkeypatch
    )
    res = _run(
        client, model_chain=["deepseek:deepseek-v4-pro"], max_iter=2,
        tool_handlers={"search_emails": lambda i: "ok"},
    )
    assert res.final_input == {"headline": "H"}
    auto_body = fake.requests[0]["json"]
    forced_body = fake.requests[1]["json"]
    assert auto_body["tool_choice"] == "auto" and "thinking" not in auto_body
    assert forced_body["thinking"] == {"type": "disabled"}


def test_loop_non_deepseek_forced_final_no_thinking(monkeypatch):
    """非 deepseek 协议（dashscope openai-compatible）强制轮不注入 thinking 键。"""
    client, fake = _client_with([_turn_final()], monkeypatch)
    _run(client, max_iter=1)
    assert "thinking" not in fake.requests[0]["json"]


def test_loop_missing_id_backfilled_consistently(monkeypatch):
    """个别实现单 tool call 省 id → 补确定性 id，assistant 重放与 role:"tool" 对齐。"""
    no_id_turn = _FakeResp([
        _tc_delta({"index": 0, "function": {"name": "search_emails",
                                            "arguments": '{"query": "a"}'}}),
        _finish("tool_calls"),
        "data: [DONE]",
    ])
    client, fake = _client_with([no_id_turn, _turn_final()], monkeypatch)
    res = _run(client, tool_handlers={"search_emails": lambda i: "ok"})
    assert res.final_input == {"headline": "H"}
    replayed = fake.requests[1]["json"]["messages"]
    assistant = next(m for m in replayed if m["role"] == "assistant")
    tool_msg = next(m for m in replayed if m["role"] == "tool")
    generated = assistant["tool_calls"][0]["id"]
    assert generated and tool_msg["tool_call_id"] == generated
