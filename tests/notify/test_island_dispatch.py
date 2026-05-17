"""单测：island_dispatch — 9 个事件构造 + send 路径 + island_dispatch 表记录."""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
from pathlib import Path
from typing import Any, Dict, List

import pytest

from src.notify import island_dispatch, ping_island, island_reconnect


class _FakeSyncStore:
    """轻量 stub 替代 SyncStore，仅实现 record_island_dispatch."""

    def __init__(self):
        self.rows: List[Dict[str, Any]] = []

    def record_island_dispatch(self, **kwargs):
        self.rows.append(kwargs)
        return len(self.rows)


@pytest.fixture
def fake_store():
    return _FakeSyncStore()


@pytest.fixture
def patch_send(monkeypatch):
    """所有 dispatch_* 走假 send_async, 直接捕获最后一次 envelope."""
    captured: List[Any] = []
    response_to_return: Dict[str, Any] = {}

    async def fake_send_async(envelope, **kwargs):
        captured.append(envelope)
        resp = response_to_return.get("response")
        return ping_island.SendResult(ok=True, response=resp, latency_ms=12)

    monkeypatch.setattr(ping_island, "send_async", fake_send_async)
    monkeypatch.setattr(island_dispatch.ping_island, "send_async", fake_send_async)
    return captured, response_to_return


def test_disabled_dispatcher_is_noop(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=False, sync_store=fake_store)
    island_dispatch.dispatch_mail_received(
        internal_id=1, page_id="p", subject="s", sender_email="a@b",
        sender_name="A", mailbox="收件箱",
    )
    # 没拉起 task，没记录
    assert captured == []
    assert fake_store.rows == []


def test_mail_received_emits_mail_received(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store,
                          account_name="Exchange")

    async def _scenario():
        island_dispatch.dispatch_mail_received(
            internal_id=53675, page_id="31a1-5375", subject="Hello",
            sender_email="john@example.com", sender_name="John", mailbox="收件箱",
            attach_count=2,
        )
        # 让 fire 的 background task 跑完
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert len(captured) == 1
    env = captured[0]
    assert env.event_type == "MailReceived"
    assert env.session_key == "mailagent:email:53675"
    assert env.intervention is None
    assert env.expects_response is False
    assert env.metadata["mailagent.internalId"] == "53675"
    assert env.metadata["mailagent.notionPageId"] == "31a1-5375"
    assert env.metadata["mailagent.accountName"] == "Exchange"
    assert env.metadata["mailagent.attachCount"] == "2"
    # SQLite 记录
    assert len(fake_store.rows) == 1
    assert fake_store.rows[0]["event_type"] == "MailReceived"
    assert fake_store.rows[0]["dispatched_ok"] is True


def test_llm_reviewed_urgent_attaches_5_options(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")

    async def _scenario():
        island_dispatch.dispatch_llm_reviewed(
            internal_id=7, page_id="pid", subject="S", sender_email="x@y",
            sender_name="X", mailbox="收件箱",
            priority="🔴 紧急", action="需要回复",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert len(captured) == 1
    env = captured[0]
    assert env.event_type == "LLMReviewedUrgent"
    assert env.intervention is not None
    assert len(env.intervention.options) == 5
    option_ids = {opt.id for opt in env.intervention.options}
    assert option_ids == {"create_draft", "open_mail", "open_notion",
                          "mark_done", "snooze_1h"}
    assert env.expects_response is True
    assert env.status_kind == "waitingForInput"


def test_llm_reviewed_non_urgent_has_no_intervention(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")

    async def _scenario():
        island_dispatch.dispatch_llm_reviewed(
            internal_id=8, page_id="pid", subject="S", sender_email="x@y",
            sender_name="X", mailbox="收件箱",
            priority="🟢 普通", action="仅供参考",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "LLMReviewed"
    assert env.intervention is None
    assert env.expects_response is False


def test_mail_completed_status_kind(patch_send, fake_store):
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_mail_completed(
            internal_id=42, page_id="p", subject="Done", mailbox="收件箱",
        )
        await asyncio.sleep(0.05)

    captured, _ = patch_send
    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "MailCompleted"
    assert env.status_kind == "completed"


def test_sync_failed_carries_error_in_status_detail(patch_send, fake_store):
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_sync_failed(
            internal_id=99, subject="S", error="ECONNRESET 中断",
        )
        await asyncio.sleep(0.05)

    captured, _ = patch_send
    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "SyncFailed"
    assert env.status_kind == "error"
    assert "ECONNRESET" in (env.status_detail or "")


def test_dead_letter_accum_session_key(patch_send, fake_store):
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_dead_letter_accum(count=7, threshold=5)
        await asyncio.sleep(0.05)

    captured, _ = patch_send
    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "DeadLetterAccum"
    assert env.session_key == "mailagent:system:dead_letter"
    assert env.metadata["mailagent.deadLetterCount"] == "7"


def test_failed_send_enqueues_to_reconnect_backlog(monkeypatch, fake_store):
    """ping-island 离线 → send 返回 ok=False → envelope bytes 应入 reconnect 队列."""
    island_reconnect.clear_queue()
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def fake_send_async(envelope, **kwargs):
        return ping_island.SendResult(ok=False, error="ENOENT", latency_ms=5)

    monkeypatch.setattr(ping_island, "send_async", fake_send_async)
    monkeypatch.setattr(island_dispatch.ping_island, "send_async", fake_send_async)

    async def _scenario():
        island_dispatch.dispatch_mail_received(
            internal_id=1, page_id="p", subject="s", sender_email="a@b",
            sender_name="A", mailbox="收件箱",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert island_reconnect.queue_len() == 1
    # 失败也要写 SQLite 行（dispatched_ok=False）
    assert fake_store.rows
    assert fake_store.rows[0]["dispatched_ok"] is False
    island_reconnect.clear_queue()


def test_response_with_decision_invokes_response_handler(monkeypatch, fake_store):
    """收到 BridgeResponse.decision → island_response.handle_response 被调."""
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")

    captured_meta: Dict[str, Any] = {}
    captured_choice: List[str] = []

    async def fake_handle(resp, meta):
        captured_meta.update(meta)
        choice = resp.get("decision", {}).get("answer", {}).get("choice")
        captured_choice.append(choice)

    # 让 send_async 返回带 decision 的 response
    decision_resp = {"decision": {"answer": {"choice": "open_mail"}}}

    async def fake_send_async(envelope, **kwargs):
        return ping_island.SendResult(ok=True, response=decision_resp, latency_ms=8)

    monkeypatch.setattr(ping_island, "send_async", fake_send_async)
    monkeypatch.setattr(island_dispatch.ping_island, "send_async", fake_send_async)

    # 替换 island_response.handle_response（dispatch 内 lazy import）
    import src.notify.island_response as island_response_mod
    monkeypatch.setattr(island_response_mod, "handle_response", fake_handle)

    async def _scenario():
        island_dispatch.dispatch_llm_reviewed(
            internal_id=53675, page_id="pid", subject="S", sender_email="a@b",
            sender_name="A", mailbox="收件箱",
            priority="🔴 紧急", action="需要回复",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert captured_choice == ["open_mail"]
    assert captured_meta.get("mailagent.internalId") == "53675"
    # 记录到 SQLite 的 response_decision 字段
    assert fake_store.rows[-1]["response_decision"] == "open_mail"
