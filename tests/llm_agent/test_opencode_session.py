"""OpenCode 会话头（x-opencode-session）：判据、显式配置优先、分类 / tool loop / 连通性测试三处请求。

判据用例与前端 frontend/tests/shared/lib/opencodeSession.test.ts 同一组（两边要一致）。
"""

from __future__ import annotations

import asyncio
import json

import pytest

import src.llm_agent.client as client_mod
from src.api.routers import llm_providers as lp_router
from src.llm_agent.client import LLMClient
from src.llm_agent.provider_routing import (
    OPENCODE_SESSION_HEADER,
    ProviderRoute,
    is_opencode_base,
    opencode_session_headers,
)

OPENCODE = "https://opencode.ai/zen/go/v1"
OTHER = "https://api.example.test/v1"


def _tool(name: str) -> dict:
    return {"name": name, "description": name, "input_schema": {"type": "object", "properties": {}}}


@pytest.mark.parametrize(
    "url, expected",
    [
        ("https://opencode.ai/zen/go/v1", True),
        ("https://opencode.ai/zen/v1", True),
        ("https://api.opencode.ai/v1", True),
        ("https://crs.chenge.ink/api", False),
        ("https://notopencode.ai/v1", False),
        ("opencode.ai/zen", False),
        ("", False),
    ],
)
def test_is_opencode_base(url, expected):
    assert is_opencode_base(url) is expected


def test_session_headers_only_for_opencode_and_respect_explicit_config():
    assert opencode_session_headers(OPENCODE, "s1") == {OPENCODE_SESSION_HEADER: "s1"}
    assert opencode_session_headers(OTHER, "s1") == {}
    assert opencode_session_headers(OPENCODE, "s1", {"X-OpenCode-Session": "mine"}) == {}


def _route(base: str) -> ProviderRoute:
    return ProviderRoute(
        provider_id="opencode", protocol="openai-compatible", base_url=base, api_key="k",
        headers={}, model_id="deepseek-v4.1-flash", model_ref="opencode:deepseek-v4.1-flash",
        max_output=None,
    )


class _Resp:
    status_code = 200

    def __init__(self, lines):
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    async def aread(self):
        return b""

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _Http:
    def __init__(self, turns):
        self._turns = list(turns)
        self.headers: list[dict] = []

    def stream(self, method, path, json=None, headers=None):
        self.headers.append(dict(headers or {}))
        return _Resp(self._turns.pop(0))


def _tool_turn(name: str, args: str = "{}") -> list[str]:
    call = {"index": 0, "id": f"call_{name}", "function": {"name": name, "arguments": args}}
    return ["data: " + json.dumps({"choices": [{"delta": {"tool_calls": [call]}}]}), "data: [DONE]"]


def _client_with(monkeypatch, route: ProviderRoute, turns) -> tuple[LLMClient, _Http]:
    monkeypatch.setattr(client_mod.provider_routing, "resolve_route", lambda ref: route)
    client = LLMClient()
    http = _Http(turns)
    client._http_by_provider[route.provider_id] = (client._route_sig(route), http)
    return client, http


@pytest.mark.parametrize("base, expected", [(OPENCODE, True), (OTHER, False)])
def test_classify_sends_session_header_only_to_opencode(monkeypatch, base, expected):
    route = _route(base)
    client, http = _client_with(monkeypatch, route, [_tool_turn("classify_email", '{"ok": true}')])
    asyncio.run(client.classify(
        system_blocks=[{"type": "text", "text": "s"}],
        user_content="u",
        tool_schema=_tool("classify_email"),
        tool_name="classify_email",
        model_chain=[route.model_ref],
    ))
    assert (OPENCODE_SESSION_HEADER in http.headers[0]) is expected


def test_tool_loop_reuses_one_session_id_across_turns(monkeypatch):
    route = _route(OPENCODE)
    client, http = _client_with(
        monkeypatch, route, [_tool_turn("lookup"), _tool_turn("finish", '{"done": true}')]
    )
    asyncio.run(client.run_tool_loop(
        system_blocks=[{"type": "text", "text": "s"}],
        user_content="u",
        tools=[_tool("lookup"), _tool("finish")],
        tool_handlers={"lookup": lambda _input: "ok"},
        final_tool="finish",
        model_chain=[route.model_ref],
        max_iter=3,
    ))
    sessions = [h[OPENCODE_SESSION_HEADER] for h in http.headers]
    assert len(sessions) == 2 and sessions[0] == sessions[1]


def test_probe_completion_request_carries_session_header():
    _, headers, _ = lp_router._completion_request("openai-compatible", OPENCODE, "k", "m", {})
    assert OPENCODE_SESSION_HEADER in headers
    _, headers, _ = lp_router._completion_request(
        "openai-compatible", OPENCODE, "k", "m", {"X-OpenCode-Session": "mine"}
    )
    assert headers.get("X-OpenCode-Session") == "mine"
    assert OPENCODE_SESSION_HEADER not in headers
