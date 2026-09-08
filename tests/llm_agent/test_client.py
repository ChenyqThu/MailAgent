"""Tests for LLMClient transport behavior (no network)."""

import asyncio
from types import SimpleNamespace as NS

import pytest

from src.llm_agent.client import LLMClient, LLMSchemaDriftError


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


def _tool_use(name: str, payload: dict):
    return NS(type="tool_use", name=name, input=payload)


def _message(blocks):
    return NS(
        content=blocks,
        usage=NS(
            input_tokens=11,
            output_tokens=7,
            cache_creation_input_tokens=0,
            cache_read_input_tokens=3,
        ),
        model="claude-test",
        stop_reason="tool_use",
    )


def test_classify_anthropic_uses_streaming_messages():
    calls: list[dict] = []

    class FakeMessages:
        def stream(self, **kwargs):
            calls.append(kwargs)
            return _FakeStream(_message([_tool_use("classify_email", {"ok": True})]))

        async def create(self, **kwargs):
            raise AssertionError("non-streaming messages.create should not be used")

    client = LLMClient()
    client._client = NS(messages=FakeMessages())

    result = asyncio.run(client.classify(
        system_blocks=[{"type": "text", "text": "s"}],
        user_content="u",
        tool_schema={
            "name": "classify_email",
            "description": "test",
            "input_schema": {"type": "object", "properties": {}},
        },
        tool_name="classify_email",
        model_chain=["claude-test"],
    ))

    assert result.tool_input == {"ok": True}
    assert result.cache_read_input_tokens == 3
    assert len(calls) == 1
    assert calls[0]["model"] == "claude-test"
    assert calls[0]["messages"] == [{"role": "user", "content": "u"}]
    assert calls[0]["tool_choice"] == {"type": "tool", "name": "classify_email"}



# --- schema drift（tool-call 格式漂移）------------------------------------
#
# 生产实测形态：模型写完 ai_summary 的值后不闭合 JSON，改用 XML 语法把剩余参数续在
# 同一个字符串里，SDK 拿到的是合法但只有一个 key 的 dict。样本取自 internal_id
# 1000016126（claude-sonnet-5，2026-09-08）。

_DRIFTED_ARGS = {
    "ai_summary": (
        "曾东彪同步 Controller H1 版本规划已基本对齐。</ai_summary>\n"
        "<category>💼 产品管理</category>\n"
        "<language>中文</language>\n"
        '<action_required">true</action_required>\n'
        "</invoke>\n"
    ),
}

_CLEAN_ARGS = {
    "ai_summary": "曾东彪同步 Controller H1 版本规划已基本对齐。",
    "category": "💼 产品管理",
    "language": "中文",
}

_SCHEMA = {
    "name": "classify_email",
    "description": "test",
    "input_schema": {
        "type": "object",
        "required": ["ai_summary", "category", "language"],
        "properties": {},
    },
}


def _client_returning(*payloads: dict) -> tuple[LLMClient, list[str]]:
    """Client whose每次 stream 调用按序吐一个 payload；返回被调用过的 model 列表。"""
    seen: list[str] = []
    queue = list(payloads)

    class FakeMessages:
        def stream(self, **kwargs):
            seen.append(kwargs["model"])
            return _FakeStream(_message([_tool_use("classify_email", queue.pop(0))]))

    client = LLMClient()
    client._client = NS(messages=FakeMessages())
    return client, seen


def _classify(client: LLMClient, chain: list[str]):
    return asyncio.run(client.classify(
        system_blocks=[{"type": "text", "text": "s"}],
        user_content="u",
        tool_schema=_SCHEMA,
        tool_name="classify_email",
        model_chain=chain,
    ))


def test_schema_drift_retries_same_model_once():
    """漂移先原模型重试，成功即返回——不该滑到 fallback 模型换掉分类口径。"""
    client, seen = _client_returning(_DRIFTED_ARGS, _CLEAN_ARGS)

    result = _classify(client, ["claude-test", "gpt-fallback"])

    assert result.tool_input == _CLEAN_ARGS
    assert seen == ["claude-test", "claude-test"]


def test_schema_drift_twice_falls_back_to_next_model():
    """同模型重试仍漂移 → 换链上的下一个模型。"""
    client, seen = _client_returning(_DRIFTED_ARGS, _DRIFTED_ARGS, _CLEAN_ARGS)

    result = _classify(client, ["claude-test", "claude-other"])

    assert result.tool_input == _CLEAN_ARGS
    assert seen == ["claude-test", "claude-test", "claude-other"]


def test_schema_drift_exhausts_chain_and_raises():
    """链走完仍漂移 → 抛错，让 runner 记账进 retry 队列，不把残缺结果落库。"""
    client, seen = _client_returning(_DRIFTED_ARGS, _DRIFTED_ARGS)

    with pytest.raises(LLMSchemaDriftError) as exc:
        _classify(client, ["claude-test"])

    assert "category" in str(exc.value)
    assert "language" in str(exc.value)
    assert seen == ["claude-test", "claude-test"]


def test_schema_without_required_still_passes_through():
    """schema 没有 required（tool loop / 自定义工具）→ 闸不介入，行为不变。"""
    client, seen = _client_returning({"anything": 1})

    result = asyncio.run(client.classify(
        system_blocks=[{"type": "text", "text": "s"}],
        user_content="u",
        tool_schema={
            "name": "classify_email",
            "description": "test",
            "input_schema": {"type": "object", "properties": {}},
        },
        tool_name="classify_email",
        model_chain=["claude-test"],
    ))

    assert result.tool_input == {"anything": 1}
    assert seen == ["claude-test"]
