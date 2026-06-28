"""M1b — mem0 auto-capture 端点契约测试（mock 引擎，无网络/无模型下载/无 FAISS）。

``POST /api/chat/memory/capture``：从一个完成的 chat turn 抽取持久记忆（mem0.add）。
与 test_chat_memory.py（agent_memory_kv 显式层）**正交** —— 这里测 M1 的 mem0 自动抽取层
（独立 FAISS store）。Mem0Engine 全程 mock（patch ``get_mem0_engine`` —— capture 端点函数内
import 它），故零网络 + 绝不加载 mem0/fastembed/faiss 重依赖。auth bypass 默认 ON（conftest
设 MAILAGENT_API_AUTH_DISABLED=true）。
"""

from __future__ import annotations

from typing import Iterator, Tuple
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.memory.mem0_engine import CAPTURE_TEXT_MAX_CHARS


@pytest.fixture
def capture_client(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[Tuple[TestClient, mock.MagicMock]]:
    """TestClient + mock Mem0Engine。

    capture 端点内部 ``from src.memory.mem0_engine import get_mem0_engine``（函数内懒
    import），故 patch 模块属性 ``me.get_mem0_engine`` 即被每次调用拿到 —— 不触发真引擎。
    """
    import src.memory.mem0_engine as me

    fake = mock.MagicMock()
    fake.add.return_value = {
        "results": [{"id": "m1", "memory": "User prefers terse Chinese", "event": "ADD"}]
    }
    monkeypatch.setattr(me, "get_mem0_engine", lambda: fake)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, fake


def test_capture_forwards_turn_to_mem0(capture_client) -> None:
    client, fake = capture_client
    r = client.post(
        "/api/chat/memory/capture",
        json={"userText": "以后中文回我，别寒暄", "assistantText": "好的，记住了"},
    )
    body = r.json()
    assert body["data"]["count"] == 1
    assert body["data"]["captured"][0]["id"] == "m1"
    assert body["data"]["captured"][0]["event"] == "ADD"
    assert body["meta"]["source"] == "memory"
    # engine.add(messages, DEFAULT_USER_ID, metadata) —— 位置参（run_in_threadpool 转发）。
    args, _ = fake.add.call_args
    messages, user_id, metadata = args
    assert messages == [
        {"role": "user", "content": "以后中文回我，别寒暄"},
        {"role": "assistant", "content": "好的，记住了"},
    ]
    assert user_id == "owner"  # DEFAULT_USER_ID（单用户固定逻辑分区）
    assert metadata["source"] == "auto_capture"


def test_capture_filters_noop_and_delete(capture_client) -> None:
    client, fake = capture_client
    fake.add.return_value = {
        "results": [
            {"id": "a", "memory": "kept", "event": "ADD"},
            {"id": "b", "memory": "updated", "event": "UPDATE"},
            {"id": "c", "memory": "noop", "event": "NOOP"},
            {"id": "d", "memory": "gone", "event": "DELETE"},
        ]
    }
    r = client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    data = r.json()["data"]
    # 只 ADD/UPDATE 当「已记住」上报；NOOP/DELETE 不弹 M1d toast。
    assert data["count"] == 2
    assert {c["id"] for c in data["captured"]} == {"a", "b"}
    # total_events 反映全部事件（可观测）。
    assert r.json()["meta"]["total_events"] == 4


def test_capture_records_provenance(capture_client) -> None:
    client, fake = capture_client
    client.post(
        "/api/chat/memory/capture",
        json={"userText": "u", "assistantText": "a", "sessionId": 7, "messageId": 70},
    )
    _, _, metadata = fake.add.call_args[0]
    assert metadata["session_id"] == 7
    assert metadata["message_id"] == 70
    assert metadata["source"] == "auto_capture"


def test_capture_ignores_bad_provenance_types(capture_client) -> None:
    client, fake = capture_client
    # provenance 是可选附属：坏类型静默忽略（不 400），抽取仍进行（best-effort 不被附属挡住）。
    # bool 是 int 子类 → messageId=True 也须被排除。
    r = client.post(
        "/api/chat/memory/capture",
        json={"userText": "u", "assistantText": "a", "sessionId": "x", "messageId": True},
    )
    assert r.json()["data"]["count"] == 1
    _, _, metadata = fake.add.call_args[0]
    assert "session_id" not in metadata
    assert "message_id" not in metadata


def test_capture_empty_turn_short_circuits(capture_client) -> None:
    client, fake = capture_client
    r = client.post("/api/chat/memory/capture", json={"userText": "   ", "assistantText": ""})
    assert r.json()["data"] == {"captured": [], "count": 0}
    fake.add.assert_not_called()  # 空 turn 不触发模型调用


def test_capture_validation_requires_strings(capture_client) -> None:
    client, fake = capture_client
    for bad in (
        {},
        {"userText": "u"},
        {"assistantText": "a"},
        {"userText": 5, "assistantText": "a"},
    ):
        err = client.post("/api/chat/memory/capture", json=bad).json()["error"]
        assert err["code"] == "E_INVALID_ARG"
    fake.add.assert_not_called()


def test_capture_best_effort_on_engine_error(capture_client) -> None:
    client, fake = capture_client
    fake.add.side_effect = RuntimeError("CRS down")
    r = client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    # 抽取失败不 500 —— 调用方 fire-and-forget 不重试；返回 captured=[]（turn 已正常流式）。
    assert r.status_code == 200
    assert r.json()["data"] == {"captured": [], "count": 0}


def test_capture_handles_non_dict_result(capture_client) -> None:
    client, fake = capture_client
    # mem0 API drift 防御：result 非 dict（如 list）→ 安全降级 captured=[]（不 AttributeError）。
    fake.add.return_value = ["weird-non-dict-shape"]
    r = client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    assert r.status_code == 200
    assert r.json()["data"] == {"captured": [], "count": 0}


def test_capture_truncates_oversized_turn(capture_client) -> None:
    client, fake = capture_client
    big = "x" * (CAPTURE_TEXT_MAX_CHARS + 5000)
    client.post("/api/chat/memory/capture", json={"userText": big, "assistantText": big})
    messages, _, _ = fake.add.call_args[0]
    # 超大 turn 被截断到 CAPTURE_TEXT_MAX_CHARS（durable facts 在前几段，省 token）。
    assert len(messages[0]["content"]) == CAPTURE_TEXT_MAX_CHARS
    assert len(messages[1]["content"]) == CAPTURE_TEXT_MAX_CHARS


# ── M1d — SSE publish + undo 端点 ────────────────────────────────────────────


def test_capture_publishes_sse_when_captured(capture_client, monkeypatch) -> None:
    client, fake = capture_client
    published: list = []
    import src.events.publisher as pub

    monkeypatch.setattr(pub, "safe_publish", lambda et, **kw: published.append((et, kw)))
    fake.add.return_value = {"results": [{"id": "m1", "memory": "x", "event": "ADD"}]}
    client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    # 真有抽取 → 推 memory.captured，data 携带 captured 条目供前端弹 toast。
    assert len(published) == 1
    event_type, kw = published[0]
    assert event_type == "memory.captured"
    assert kw["data"]["captured"][0]["id"] == "m1"
    assert kw["source"] == "memory"


def test_capture_no_sse_when_nothing_captured(capture_client, monkeypatch) -> None:
    client, fake = capture_client
    published: list = []
    import src.events.publisher as pub

    monkeypatch.setattr(pub, "safe_publish", lambda et, **kw: published.append(et))
    fake.add.return_value = {"results": [{"id": "c", "memory": "noop", "event": "NOOP"}]}
    client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    assert published == []  # NOOP-only → 不推 SSE（不打扰前端）


def test_undo_deletes_captured_memory(capture_client) -> None:
    client, fake = capture_client
    r = client.delete("/api/chat/memory/captured", params={"id": "m1"})
    assert r.json()["data"] == {"deleted": True, "id": "m1"}
    fake.delete.assert_called_once_with("m1")


def test_undo_error_when_engine_fails(capture_client) -> None:
    client, fake = capture_client
    # 撤销是用户主动操作 → 失败 raise（不像 capture best-effort），前端据此提示。
    fake.delete.side_effect = RuntimeError("faiss locked")
    r = client.delete("/api/chat/memory/captured", params={"id": "m1"})
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "E_INTERNAL"
