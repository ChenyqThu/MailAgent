"""P2g — /chat/notion-agent-once 非流式收集端点（notion_agent_chat tool 的后端面）。

task 06-18-custom-ai-harness-agent Phase 2。monkeypatch ``run_notion_agent``（真子进程
CLI 不在测试环境）→ 验证端点把语义 event 流收集成 {text, threadId, status, metadata} +
thread_id 续接（构造 assistant.metadata.thread_id 让 extract_turn 取到）+ error 路径。
auth bypass 默认 ON（conftest）。旧流式 /notion-agent 端点不动。
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict, Iterator, List

import pytest
from fastapi.testclient import TestClient

import src.api.routers.chat as chat_router
from src.api.app import app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


def _ok_stream(events: List[Dict[str, Any]], sink: Dict[str, Any]):
    async def gen(req: Dict[str, Any], **_kwargs: Any) -> AsyncIterator[Dict[str, Any]]:
        sink["req"] = req
        for ev in events:
            yield ev

    return gen


def test_collects_text_and_thread_id(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    sink: Dict[str, Any] = {}
    monkeypatch.setattr(
        chat_router,
        "run_notion_agent",
        _ok_stream(
            [
                {"type": "chunk", "delta": "Hello "},
                {"type": "chunk", "delta": "Notion"},
                {
                    "type": "usage",
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "costUsd": None,
                    "model": None,
                    "metadata": {"thread_id": "thr-123"},
                },
                {
                    "type": "done",
                    "finalContent": "Hello Notion",
                    "model": None,
                    "metadata": {"thread_id": "thr-123"},
                },
            ],
            sink,
        ),
    )
    r = client.post("/api/chat/notion-agent-once", json={"message": "what's in my roadmap?"})
    data = r.json()["data"]
    assert data["status"] == "ok"
    assert data["text"] == "Hello Notion"  # done.finalContent 优先
    assert data["threadId"] == "thr-123"
    assert data["metadata"] == {"thread_id": "thr-123"}
    # 首轮无 threadId → history 仅 user 消息。
    assert [m["role"] for m in sink["req"]["history"]] == ["user"]
    assert sink["req"]["history"][-1]["content"] == "what's in my roadmap?"


def test_thread_continuity_injects_assistant_metadata(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """续轮：传 threadId → history 注入 assistant.metadata.thread_id 让 extract_turn 续接。"""
    sink: Dict[str, Any] = {}
    monkeypatch.setattr(
        chat_router,
        "run_notion_agent",
        _ok_stream(
            [{"type": "done", "finalContent": "continued", "metadata": {"thread_id": "thr-xyz"}}],
            sink,
        ),
    )
    r = client.post(
        "/api/chat/notion-agent-once",
        json={"message": "follow up", "threadId": "thr-xyz", "model": "claude-sonnet-4-6"},
    )
    data = r.json()["data"]
    assert data["status"] == "ok"
    assert data["threadId"] == "thr-xyz"
    history = sink["req"]["history"]
    assert [m["role"] for m in history] == ["assistant", "user"]
    meta = json.loads(history[0]["metadata"])
    assert meta["thread_id"] == "thr-xyz"  # extract_turn 据此续接
    assert sink["req"]["model"] == "claude-sonnet-4-6"


def test_error_event_maps_to_error_status(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sink: Dict[str, Any] = {}
    monkeypatch.setattr(
        chat_router,
        "run_notion_agent",
        _ok_stream(
            [{"type": "error", "code": "E_NOTION_AGENT_NOT_INSTALLED", "message": "CLI not found"}],
            sink,
        ),
    )
    r = client.post("/api/chat/notion-agent-once", json={"message": "hi"})
    data = r.json()["data"]
    assert data["status"] == "error"
    assert data["errorCode"] == "E_NOTION_AGENT_NOT_INSTALLED"
    assert data["errorMessage"] == "CLI not found"


def test_missing_message_rejected(client: TestClient) -> None:
    err = client.post("/api/chat/notion-agent-once", json={}).json()["error"]
    assert err["code"] == "E_INVALID_ARG"
