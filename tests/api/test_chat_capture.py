"""task 07-01 — /chat/memory/capture 端点契约测试（memory.md 合并；mock manager，无网络/无 LLM）。

capture 端点内部 ``load_memory_md → merge_turn → save_memory_md``（函数内懒 import
``src.memory.memory_md``），故 patch 该模块的三个函数即可测端点布线，零 LLM/零 store。
undo 端点（DELETE /memory/captured）step1 未改（仍走 mem0.delete）—— 单独 mem0 mock 测。
auth bypass 默认 ON（conftest 设 MAILAGENT_API_AUTH_DISABLED=true）。
"""

from __future__ import annotations

from typing import Iterator, Tuple
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.config import config as cfg
from src.memory.memory_md import MergeResult


class _MemoryMdSpy:
    """memory.md manager 的可控 spy（load/merge/save）。测试可调 merge_result / *_raises。"""

    def __init__(self) -> None:
        self.current = ""  # 当前 memory.md（load 返回）
        self.merge_result = MergeResult(
            content="# MEMORY\n- new fact\n", changed=True, model="claude-haiku-4-5"
        )
        self.merge_raises: Exception | None = None
        self.save_raises: Exception | None = None
        self.merge_calls: list[dict] = []
        self.saved: tuple | None = None  # (content, session_id, message_id)

    def load(self) -> str:
        return self.current

    async def merge(self, *, current_md, user_text, assistant_text, budget, client=None):
        self.merge_calls.append(
            dict(current_md=current_md, user_text=user_text,
                 assistant_text=assistant_text, budget=budget)
        )
        if self.merge_raises is not None:
            raise self.merge_raises
        return self.merge_result

    def save(self, content, *, session_id=None, message_id=None) -> None:
        if self.save_raises is not None:
            raise self.save_raises
        self.saved = (content, session_id, message_id)


@pytest.fixture
def capture_client(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[Tuple[TestClient, _MemoryMdSpy]]:
    """TestClient + memory.md manager spy（端点函数内 import load/merge/save，patch 模块属性）。"""
    import src.memory.memory_md as mmd

    spy = _MemoryMdSpy()
    monkeypatch.setattr(mmd, "load_memory_md", spy.load)
    monkeypatch.setattr(mmd, "merge_turn", spy.merge)
    monkeypatch.setattr(mmd, "save_memory_md", spy.save)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, spy


def test_capture_merges_and_saves_when_changed(capture_client) -> None:
    client, spy = capture_client
    spy.current = "# MEMORY\n- old fact\n"
    r = client.post(
        "/api/chat/memory/capture",
        json={"userText": "以后中文回我，别寒暄", "assistantText": "好的，记住了"},
    )
    body = r.json()
    assert body["data"]["changed"] is True
    # captured/count 保留形状（Node fire-and-forget 返回类型），memory.md 无 per-item id → 恒空。
    assert body["data"]["captured"] == []
    assert body["data"]["count"] == 0
    assert body["meta"]["source"] == "memory"
    # merge 收到当前 memory.md + 本轮文本 + 预算（config 默认 5000）。
    assert len(spy.merge_calls) == 1
    call = spy.merge_calls[0]
    assert call["current_md"] == "# MEMORY\n- old fact\n"
    assert call["user_text"] == "以后中文回我，别寒暄"
    assert call["assistant_text"] == "好的，记住了"
    assert call["budget"] == cfg.memory_md_budget_chars
    # changed → 落库合并后的 content。
    assert spy.saved is not None
    assert spy.saved[0] == "# MEMORY\n- new fact\n"


def test_capture_no_save_when_unchanged(capture_client) -> None:
    client, spy = capture_client
    spy.merge_result = MergeResult(content="# MEMORY\n- old\n", changed=False)
    r = client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    assert r.json()["data"]["changed"] is False
    assert spy.saved is None  # 无变化 → 不落库


def test_capture_forwards_provenance_to_save(capture_client) -> None:
    client, spy = capture_client
    client.post(
        "/api/chat/memory/capture",
        json={"userText": "u", "assistantText": "a", "sessionId": 7, "messageId": 70},
    )
    assert spy.saved is not None
    _, session_id, message_id = spy.saved
    assert session_id == 7
    assert message_id == 70


def test_capture_ignores_bad_provenance_types(capture_client) -> None:
    client, spy = capture_client
    # provenance 是可选附属：坏类型静默忽略（不 400），合并仍进行。bool 是 int 子类须排除。
    r = client.post(
        "/api/chat/memory/capture",
        json={"userText": "u", "assistantText": "a", "sessionId": "x", "messageId": True},
    )
    assert r.json()["data"]["changed"] is True
    _, session_id, message_id = spy.saved
    assert session_id is None
    assert message_id is None


def test_capture_empty_turn_short_circuits(capture_client) -> None:
    client, spy = capture_client
    r = client.post("/api/chat/memory/capture", json={"userText": "   ", "assistantText": ""})
    assert r.json()["data"] == {"changed": False, "captured": [], "count": 0}
    assert spy.merge_calls == []  # 空 turn 不触发合并/模型调用


def test_capture_validation_requires_strings(capture_client) -> None:
    client, spy = capture_client
    for bad in (
        {},
        {"userText": "u"},
        {"assistantText": "a"},
        {"userText": 5, "assistantText": "a"},
    ):
        err = client.post("/api/chat/memory/capture", json=bad).json()["error"]
        assert err["code"] == "E_INVALID_ARG"
    assert spy.merge_calls == []


def test_capture_best_effort_on_merge_error(capture_client) -> None:
    client, spy = capture_client
    spy.merge_raises = RuntimeError("CRS down")
    r = client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    # 合并失败不 500 —— 调用方 fire-and-forget 不重试；返回 changed=False（turn 已正常流式）。
    assert r.status_code == 200
    assert r.json()["data"]["changed"] is False
    assert spy.saved is None


def test_capture_best_effort_on_save_error(capture_client) -> None:
    client, spy = capture_client
    spy.save_raises = RuntimeError("db locked")
    r = client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    # 落库失败也 best-effort 吞 → 报 changed=False（不 500）。
    assert r.status_code == 200
    assert r.json()["data"]["changed"] is False


# ── undo 端点（DELETE /memory/captured）—— step1 未改，仍走 mem0.delete ─────────────


@pytest.fixture
def mem0_undo_client(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[Tuple[TestClient, mock.MagicMock]]:
    """undo 端点函数内 import get_mem0_engine → patch 模块属性 mock 之（零 FAISS）。"""
    import src.memory.mem0_engine as me

    fake = mock.MagicMock()
    monkeypatch.setattr(me, "get_mem0_engine", lambda: fake)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, fake


def test_undo_deletes_captured_memory(mem0_undo_client) -> None:
    client, fake = mem0_undo_client
    r = client.delete("/api/chat/memory/captured", params={"id": "m1"})
    assert r.json()["data"] == {"deleted": True, "id": "m1"}
    fake.delete.assert_called_once_with("m1")


def test_undo_error_when_engine_fails(mem0_undo_client) -> None:
    client, fake = mem0_undo_client
    # 撤销是用户主动操作 → 失败 raise（不像 capture best-effort），前端据此提示。
    fake.delete.side_effect = RuntimeError("faiss locked")
    r = client.delete("/api/chat/memory/captured", params={"id": "m1"})
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "E_INTERNAL"
