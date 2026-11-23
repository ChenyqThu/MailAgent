"""task 07-01 — /chat/memory/capture 端点契约测试（memory.md 合并；mock manager，无网络/无 LLM）。

capture 端点内部 ``capture_turn``（真实，未 mock）编排 ``_load_memory_doc → merge_turn →
save_memory_md``（函数内懒 import ``src.memory.memory_md``），故 patch 该模块的三个函数即可测
端点布线，零 LLM/零 store。``_load_memory_doc`` 07-15 起返回完整 ``ProfileDoc``（非裸字符串）——
capture_turn 的显式编辑冷却检查需要 ``updated_by``/``updated_at``；spy 默认给 ``updated_by='mem0'``
（capture 自身作者，冷却检查恒不生效），使本文件既有用例的语义不变（见 test_memory_md.py 的
lane C 冷却专项覆盖 user/agent_proposed 场景）。
auth bypass 默认 ON（conftest 设 MAILAGENT_API_AUTH_DISABLED=true）。
"""

from __future__ import annotations

import time
from typing import Iterator, Tuple

import pytest
from fastapi.testclient import TestClient

from src.agent_config.store import MEMORY_DOC_NAME, ProfileDoc
from src.api.app import app
from src.config import config as cfg
from src.memory.memory_md import MergeResult


class _MemoryMdSpy:
    """memory.md manager 的可控 spy（load/merge/save）。测试可调 merge_result / *_raises。"""

    def __init__(self) -> None:
        self.current = ""  # 当前 memory.md（load 返回）
        self.updated_by = "mem0"  # 07-15 lane C — 默认作者不触发显式编辑冷却
        self.merge_result = MergeResult(
            content="# MEMORY\n- new fact\n", changed=True, model="claude-haiku-4-5"
        )
        self.merge_raises: Exception | None = None
        self.save_raises: Exception | None = None
        self.merge_calls: list[dict] = []
        self.saved: tuple | None = None  # (content, session_id, message_id)

    def load(self) -> ProfileDoc:
        return ProfileDoc(
            doc_name=MEMORY_DOC_NAME, content=self.current, content_hash="h",
            updated_by=self.updated_by, updated_at=int(time.time()),
        )

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
    import src.api.routers.chat_memory as chat_memory_router
    import src.memory.memory_md as mmd

    chat_memory_router._clear_completed_capture_keys()
    spy = _MemoryMdSpy()
    monkeypatch.setattr(mmd, "_load_memory_doc", spy.load)
    monkeypatch.setattr(mmd, "merge_turn", spy.merge)
    monkeypatch.setattr(mmd, "save_memory_md", spy.save)
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client, spy
    finally:
        chat_memory_router._clear_completed_capture_keys()


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


def test_capture_transient_merge_error_returns_503(capture_client) -> None:
    client, spy = capture_client
    spy.merge_raises = RuntimeError("CRS down")
    r = client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "E_UPSTREAM"
    assert spy.saved is None


def test_capture_transient_save_error_returns_503(capture_client) -> None:
    client, spy = capture_client
    spy.save_raises = RuntimeError("db locked")
    r = client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "E_UPSTREAM"


def test_capture_non_retryable_value_error_returns_400(capture_client) -> None:
    client, spy = capture_client
    spy.merge_raises = ValueError("bad memory payload")
    r = client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert spy.saved is None


def test_capture_retry_recovers_and_idempotency_dedups(capture_client) -> None:
    client, spy = capture_client
    payload = {"userText": "u", "assistantText": "a", "idempotencyKey": "42:msg-1"}

    # 1st attempt fails transiently -> 503 (must NOT be recorded as completed).
    spy.merge_raises = RuntimeError("upstream 502")
    r1 = client.post("/api/chat/memory/capture", json=payload)
    assert r1.status_code == 503
    assert len(spy.merge_calls) == 1
    assert spy.saved is None

    # 2nd attempt recovers -> 200 and records idempotency key.
    spy.merge_raises = None
    r2 = client.post("/api/chat/memory/capture", json=payload)
    assert r2.status_code == 200
    assert r2.json()["data"]["changed"] is True
    assert len(spy.merge_calls) == 2
    assert spy.saved is not None

    # 3rd attempt (duplicate POST after lost response) -> deduped without re-merging.
    r3 = client.post("/api/chat/memory/capture", json=payload)
    assert r3.status_code == 200
    assert r3.json()["data"]["changed"] is False
    assert r3.json()["meta"]["deduped"] is True
    assert len(spy.merge_calls) == 2


def test_capture_truncated_logs_loguru_warning_with_doc_length(capture_client, caplog) -> None:
    """07-15 harness-chat lane C — truncated=True 不再是纯被丢弃的 meta 字段：serve-api 侧
    loguru warning 一条，带文档长度/预算/model 上下文（stdlib logger 在 serve-api 常驻进程下
    静默不出，故断言经 loguru sink 才能可靠捕获——同 test_exec_secrets.py 的 caplog+loguru 接线）。
    """
    import logging

    from loguru import logger as _lg

    client, spy = capture_client
    truncated_content = "# MEMORY\n- " + ("x" * 100)
    spy.merge_result = MergeResult(
        content=truncated_content, changed=True, truncated=True, model="claude-haiku-4-5"
    )

    sink_id = _lg.add(caplog.handler, format="{message}", level="DEBUG")
    caplog.set_level(logging.DEBUG)
    try:
        r = client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    finally:
        _lg.remove(sink_id)

    assert r.status_code == 200
    assert r.json()["meta"]["truncated"] is True
    assert "truncated" in caplog.text.lower() or "budget" in caplog.text.lower()
    assert str(len(truncated_content)) in caplog.text
    assert str(cfg.memory_md_budget_chars) in caplog.text
    assert "claude-haiku-4-5" in caplog.text


def test_capture_not_truncated_logs_no_warning(capture_client, caplog) -> None:
    """反证：truncated=False（默认场景）不触发这条 warning。"""
    import logging

    from loguru import logger as _lg

    client, spy = capture_client
    assert spy.merge_result.truncated is False

    sink_id = _lg.add(caplog.handler, format="{message}", level="DEBUG")
    caplog.set_level(logging.DEBUG)
    try:
        r = client.post("/api/chat/memory/capture", json={"userText": "u", "assistantText": "a"})
    finally:
        _lg.remove(sink_id)

    assert r.status_code == 200
    assert "hard-truncated" not in caplog.text
