"""重试队列补同步成功后必须派发与主路径相同的后续钩子（task 11-13 R1）。

首次取正文失败（fetch_failed）的邮件经 ``_process_retry_queue`` 补同步成功后, 曾经只建
Notion 页、不派发 LLM 分类 / KOS / 事项线程关联等钩子 → 这类邮件永远没有 LLM 标签、
永远不推 KOS（2026-11 实测 85 封）。门控必须与主路径一致: 草稿箱只落本地不派发,
``history_ingest`` 邮件不触发灵动岛 / Custom Agent / 项目周报。
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock

import pytest

from src.mail.ingest_provenance import INGEST_HISTORY
from src.mail.new_watcher import NewWatcher
from src.mail.sync_store import UpdateAfterFetchResult


def _fake_email_obj(mailbox="收件箱"):
    return SimpleNamespace(
        subject="hello",
        sender="a@b.com",
        sender_name="A",
        mailbox=mailbox,
        is_flagged=False,
        is_important=False,
        attachments=[],
        date=None,
        message_id="<m1@x>",
        thread_id="",
        internal_id=None,
    )


def _build_watcher(email_obj, *, mailbox="收件箱", history=False):
    w = NewWatcher.__new__(NewWatcher)
    w.backend = SimpleNamespace(
        fetch_email_content_by_id=Mock(
            return_value={
                "message_id": "<m1@x>",
                "thread_id": "t1",
                "subject": "hello",
                "sender": "a@b.com",
                "source": "raw-mime",
            }
        )
    )
    w.sync_store = MagicMock()
    w.sync_store.update_after_fetch = Mock(return_value=UpdateAfterFetchResult.OK)
    w.sync_store.get = Mock(
        return_value={"ingest_reason": INGEST_HISTORY if history else None}
    )
    w.sync_store.get_ready_for_retry = Mock(
        return_value=[
            {
                "internal_id": 42,
                "sync_status": "fetch_failed",
                "retry_count": 1,
                "mailbox": mailbox,
                "subject": "hello",
            }
        ]
    )
    w.notion_sync = SimpleNamespace(
        create_email_page_v2=AsyncMock(return_value="page123")
    )
    w._stats = {
        "emails_synced": 0,
        "errors": 0,
        "retries_attempted": 0,
        "retries_succeeded": 0,
    }
    w._bg_tasks = set()

    async def _build(full_email, mb):
        return email_obj

    w._build_email_object = _build
    w._persist_email_metadata_after_parse = Mock()
    w._maybe_dual_write_body = Mock()
    w._maybe_link_matter_thread_subscriptions = AsyncMock()
    w._maybe_trigger_project_progress_hook = Mock()
    w._maybe_trigger_llm_hook = Mock()
    w._maybe_trigger_kos_hook = Mock()
    w._maybe_dispatch_island_received = Mock()
    w._maybe_trigger_custom_agents = Mock()
    return w


def _assert_all_hooks(w, email_obj, page_id):
    w._maybe_link_matter_thread_subscriptions.assert_awaited_once_with(email_obj, 42)
    w._maybe_trigger_project_progress_hook.assert_called_once_with(email_obj, 42, page_id)
    w._maybe_trigger_llm_hook.assert_called_once_with(email_obj, 42, page_id)
    w._maybe_trigger_kos_hook.assert_called_once_with(email_obj, 42, page_id)
    w._maybe_dispatch_island_received.assert_called_once_with(email_obj, 42, page_id)
    w._maybe_trigger_custom_agents.assert_called_once_with(email_obj, 42)


@pytest.mark.asyncio
async def test_retry_fetch_failed_notion_enabled_dispatches_hooks(monkeypatch):
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj)

    await w._process_retry_queue()

    w.sync_store.mark_synced_v3.assert_called_once_with(42, "page123")
    _assert_all_hooks(w, email_obj, "page123")


@pytest.mark.asyncio
async def test_retry_fetch_failed_notion_returns_none_dispatches_nothing(monkeypatch):
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj)
    w.notion_sync.create_email_page_v2 = AsyncMock(return_value=None)

    await w._process_retry_queue()

    w.sync_store.mark_failed_v3.assert_called_once()
    w._maybe_trigger_llm_hook.assert_not_called()
    w._maybe_trigger_kos_hook.assert_not_called()


@pytest.mark.asyncio
async def test_retry_fetch_failed_notion_disabled_dispatches_hooks(monkeypatch):
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: False)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj)

    await w._process_retry_queue()

    w.sync_store.mark_synced_local.assert_called_once_with(42)
    w.notion_sync.create_email_page_v2.assert_not_awaited()
    _assert_all_hooks(w, email_obj, "")


@pytest.mark.asyncio
async def test_retry_drafts_mailbox_dispatches_nothing(monkeypatch):
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj(mailbox="草稿箱")
    w = _build_watcher(email_obj, mailbox="草稿箱")

    await w._process_retry_queue()

    w.sync_store.mark_synced_local.assert_called_once_with(42)
    w.notion_sync.create_email_page_v2.assert_not_awaited()
    w._maybe_link_matter_thread_subscriptions.assert_not_awaited()
    w._maybe_trigger_project_progress_hook.assert_not_called()
    w._maybe_trigger_llm_hook.assert_not_called()
    w._maybe_trigger_kos_hook.assert_not_called()
    w._maybe_dispatch_island_received.assert_not_called()
    w._maybe_trigger_custom_agents.assert_not_called()


@pytest.mark.asyncio
async def test_retry_history_ingest_skips_realtime_hooks(monkeypatch):
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj, history=True)

    await w._process_retry_queue()

    w._maybe_link_matter_thread_subscriptions.assert_awaited_once_with(email_obj, 42)
    w._maybe_trigger_llm_hook.assert_called_once_with(email_obj, 42, "page123")
    w._maybe_trigger_kos_hook.assert_called_once_with(email_obj, 42, "page123")
    w._maybe_trigger_project_progress_hook.assert_not_called()
    w._maybe_dispatch_island_received.assert_not_called()
    w._maybe_trigger_custom_agents.assert_not_called()
