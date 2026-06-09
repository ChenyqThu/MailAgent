"""Tests for LLMClient transport behavior (no network)."""

import asyncio
from types import SimpleNamespace as NS

from src.llm_agent.client import LLMClient


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

