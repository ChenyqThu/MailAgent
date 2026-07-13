"""LLMClient × provider_routing 集成单测（task 07-12 P2，无网络 / 无 DB）。

路由决议经 monkeypatch `provider_routing.resolve_route` 注入（client 经模块命名空间调用，
patch 即生效）；协议腿客户端全 fake。flag off 的字节级等价由既有 test_client.py /
test_reports.py 零改动通过背书，这里只补 legacy 分发的显式断言。
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace as NS

import pytest

import src.llm_agent.client as client_mod
from src.llm_agent.client import LLMCallError, LLMClient, _leg_for
from src.llm_agent.provider_routing import ProviderRoute

TOOL_SCHEMA = {
    "name": "classify_email",
    "description": "test",
    "input_schema": {"type": "object", "properties": {}},
}


def _route(pid="dashscope", protocol="openai-compatible",
           base="https://dashscope.aliyuncs.com/compatible-mode/v1", key="sk-x",
           model_id="qwen-max", headers=None, max_output=None):
    return ProviderRoute(
        provider_id=pid, protocol=protocol, base_url=base, api_key=key,
        headers=headers or {}, model_id=model_id, model_ref=f"{pid}:{model_id}",
        max_output=max_output,
    )


def _patch_routes(monkeypatch, mapping):
    monkeypatch.setattr(
        client_mod.provider_routing, "resolve_route", lambda ref: mapping.get(ref)
    )


# ── anthropic fakes（复用 test_client.py 形状）────────────────────────────────────────


class _FakeStream:
    def __init__(self, msg):
        self._msg = msg

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration

    async def get_final_message(self):
        return self._msg


def _anthropic_msg(payload):
    return NS(
        content=[NS(type="tool_use", name="classify_email", input=payload)],
        usage=NS(input_tokens=1, output_tokens=1,
                 cache_creation_input_tokens=0, cache_read_input_tokens=0),
        model="claude-wire",
        stop_reason="tool_use",
    )


class _FakeMessages:
    def __init__(self, calls):
        self._calls = calls

    def stream(self, **kwargs):
        self._calls.append(kwargs)
        return _FakeStream(_anthropic_msg({"ok": True}))


# ── openai(httpx) fakes ───────────────────────────────────────────────────────────────


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


def _classify_lines(tool_name="classify_email", args='{"ok": true}'):
    return [
        _sse({"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "call_1", "function": {"name": tool_name}}]}}]}),
        _sse({"choices": [{"delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": args}}]}}]}),
        _sse({"usage": {"prompt_tokens": 3, "completion_tokens": 2}}),
        "data: [DONE]",
    ]


def _inject_http(client: LLMClient, route: ProviderRoute, fake: _FakeHttp) -> None:
    client._http_by_provider[route.provider_id] = (client._route_sig(route), fake)


def _classify(client, model_chain):
    return asyncio.run(client.classify(
        system_blocks=[{"type": "text", "text": "s"}],
        user_content="u",
        tool_schema=TOOL_SCHEMA,
        tool_name="classify_email",
        model_chain=model_chain,
    ))


# ── _leg_for：协议腿决策矩阵 ──────────────────────────────────────────────────────────


def test_leg_for_matrix():
    # route=None（flag off / fail-open）→ legacy 前缀路由
    assert _leg_for("gpt-5.4", None) == "openai"
    assert _leg_for("claude-sonnet-4-6", None) == "anthropic"
    # google → unsupported（v1 不支持）
    assert _leg_for("g:m", _route(pid="g", protocol="google", model_id="m")) == "unsupported"
    # default + anthropic（seed 自 env 的 CRS 双协议网关）→ 保留前缀路由（等价性 prd §10.2）
    d_gpt = _route(pid="default", protocol="anthropic", model_id="gpt-5.4")
    d_claude = _route(pid="default", protocol="anthropic", model_id="claude-opus-4-7")
    assert _leg_for("gpt-5.4", d_gpt) == "openai"
    assert _leg_for("claude-opus-4-7", d_claude) == "anthropic"
    # 非 default 严格按 protocol（kimi anthropic-compat 端点即使模型名非 claude 前缀也走 anthropic）
    kimi = _route(pid="kimi", protocol="anthropic",
                  base="https://api.moonshot.cn/anthropic", model_id="kimi-k2-thinking")
    assert _leg_for("kimi:kimi-k2-thinking", kimi) == "anthropic"
    assert _leg_for("dashscope:qwen-max", _route()) == "openai"
    for proto in ("openai", "deepseek", "openrouter"):
        assert _leg_for("p:m", _route(pid="p", protocol=proto, model_id="m")) == "openai"


# ── classify 分发 ────────────────────────────────────────────────────────────────────


def test_classify_routed_anthropic_builds_per_provider_client(monkeypatch):
    route = _route(pid="kimi", protocol="anthropic",
                   base="https://api.moonshot.cn/anthropic/", key="sk-kimi",
                   model_id="kimi-k2", headers={"X-Corp": "1"}, max_output=4000)
    _patch_routes(monkeypatch, {"kimi:kimi-k2": route})
    ctor = {}
    calls: list = []

    class FakeAnthropic:
        def __init__(self, **kw):
            ctor.update(kw)
            self.messages = _FakeMessages(calls)

    monkeypatch.setattr(client_mod, "AsyncAnthropic", FakeAnthropic)
    client = LLMClient()
    result = _classify(client, ["kimi:kimi-k2"])

    assert result.tool_input == {"ok": True}
    assert ctor["api_key"] == "sk-kimi"
    assert ctor["base_url"] == "https://api.moonshot.cn/anthropic"  # 行值原样只去尾 /
    assert ctor["default_headers"]["X-Corp"] == "1"  # 自定义头合入
    assert calls[0]["model"] == "kimi-k2"  # wire id = 冒号后段
    assert calls[0]["max_tokens"] == 4000  # min(64000, per-model max_output)


def test_classify_routed_openai_normalized_base_and_clamp(monkeypatch):
    route = _route(max_output=8000)
    _patch_routes(monkeypatch, {"dashscope:qwen-max": route})
    fake = _FakeHttp([_FakeResp(_classify_lines())])
    client = LLMClient()
    _inject_http(client, route, fake)

    result = _classify(client, ["dashscope:qwen-max"])
    assert result.tool_input == {"ok": True}
    req = fake.requests[0]
    assert req["path"] == "/chat/completions"  # base 已归一含 /vN → 路径不再重复 /v1
    assert req["json"]["model"] == "qwen-max"
    assert req["json"]["max_tokens"] == 8000


def test_classify_google_skipped_falls_back(monkeypatch):
    g = _route(pid="gem", protocol="google", model_id="gemini-3")
    _patch_routes(monkeypatch, {"gem:gemini-3": g})
    calls: list = []
    client = LLMClient()
    client._client = NS(messages=_FakeMessages(calls))  # legacy anthropic 腿 fake

    result = _classify(client, ["gem:gemini-3", "claude-sonnet-4-6"])
    assert result.tool_input == {"ok": True}
    assert len(calls) == 1 and calls[0]["model"] == "claude-sonnet-4-6"  # google 被跳过


def test_classify_unknown_provider_fail_open_prefix_routing(monkeypatch):
    _patch_routes(monkeypatch, {})  # 全部查不到 → route None
    calls: list = []
    client = LLMClient()
    client._client = NS(messages=_FakeMessages(calls))
    result = _classify(client, ["unknown:some-model"])
    # fail-open：整串按 legacy 前缀路由（非 gpt-/gemini-/codex- → anthropic 腿 + 全局配置）
    assert result.tool_input == {"ok": True}
    assert calls[0]["model"] == "unknown:some-model"


def test_classify_mixed_chain_provider_fail_then_legacy_fallback(monkeypatch):
    """混合链（providerRef + legacy 裸 id 混排）：provider 腿失败 → 走 legacy 模型兜底。"""
    route = _route()
    _patch_routes(monkeypatch, {"dashscope:qwen-max": route})
    fake = _FakeHttp([_FakeResp([], status=500)])  # dashscope 500 → LLMCallError
    calls: list = []
    client = LLMClient()
    _inject_http(client, route, fake)
    client._client = NS(messages=_FakeMessages(calls))

    result = _classify(client, ["dashscope:qwen-max", "claude-opus-4-7"])
    assert result.tool_input == {"ok": True}
    assert fake.requests and calls[0]["model"] == "claude-opus-4-7"


def test_classify_flag_off_legacy_openai_path_unchanged(monkeypatch):
    """flag off（真实 resolve_route + 默认 flag False）：legacy openai 腿路径/形状不变。"""
    fake = _FakeHttp([_FakeResp(_classify_lines())])
    client = LLMClient()
    client._http = fake  # legacy 全局 http 单例
    result = _classify(client, ["gpt-5.4"])
    assert result.tool_input == {"ok": True}
    req = fake.requests[0]
    assert req["path"] == "/v1/chat/completions"  # legacy 路径（base 不含 /vN）
    assert req["json"]["model"] == "gpt-5.4"
    assert req["json"]["max_tokens"] == client_mod.cfg.llm_max_tokens


# ── per-provider 客户端构造细节 ───────────────────────────────────────────────────────


def test_http_for_missing_base_and_keyless(monkeypatch):
    client = LLMClient()
    # openai-compatible 无 base → 配置错误（走 fallback 链，不静默打错端点）
    with pytest.raises(LLMCallError, match="no base_url"):
        client._http_for(_route(base=""))

    # key 为空 → 不发 Authorization（本地 openai-compatible 服务无鉴权场景）
    captured = {}

    class FakeAsyncClient:
        def __init__(self, **kw):
            captured.update(kw)

    monkeypatch.setattr(client_mod.httpx, "AsyncClient", FakeAsyncClient)
    keyless = _route(pid="local", base="http://127.0.0.1:11434/v1", key="")
    client._http_for(keyless)
    assert captured["base_url"] == "http://127.0.0.1:11434/v1"
    assert "Authorization" not in captured["headers"]


def test_anthropic_for_requires_key_and_rebuilds_on_sig_change(monkeypatch):
    ctors: list = []

    class FakeAnthropic:
        def __init__(self, **kw):
            ctors.append(kw)
            self.messages = None

    monkeypatch.setattr(client_mod, "AsyncAnthropic", FakeAnthropic)
    client = LLMClient()
    with pytest.raises(LLMCallError, match="no API key"):
        client._anthropic_for(_route(pid="kimi", protocol="anthropic", key=""))

    r1 = _route(pid="kimi", protocol="anthropic", base="https://a.example", key="sk-1")
    a = client._anthropic_for(r1)
    assert client._anthropic_for(r1) is a  # 同签名复用
    r2 = _route(pid="kimi", protocol="anthropic", base="https://a.example", key="sk-2")
    b = client._anthropic_for(r2)  # key 轮换（TTL 热读到新行值）→ 重建
    assert b is not a and len(ctors) == 2 and ctors[1]["api_key"] == "sk-2"
    assert client._retired == [a]  # 旧实例进 retired，close() 统一关
