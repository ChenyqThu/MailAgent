"""需求 1（P0）回归闸：调用方对 update_after_fetch 结果不再静默吞掉。

幽灵行事故的第二半病根 —— sync_store 层判定了冲突, 但调用方 _sync_single_email_v3
/ _process_retry_queue 不看返回值 → DUPLICATE / FAILED 被吞 → 继续往下建 Notion 页
+ 传附件 → 无限重传。

覆盖:
    - 正向 sync：DUPLICATE → 在建 Notion 页 / 双写前中止, 零 Notion 调用, 不 mark_failed
      （否则又被拉回重试队列 = 无限 retry）
    - 正向 sync：FAILED → mark_failed_v3（不静默吞）, 零 Notion 调用
    - retry：DUPLICATE → continue, 零 Notion 调用
    - retry：FAILED → mark_failed_v3, 零 Notion 调用
    - 无冲突（OK）→ 正常同步（零漂移 pin）
"""

from __future__ import annotations

import os
import time
from types import SimpleNamespace
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, Mock

import pytest

from src.mail.new_watcher import NewWatcher
from src.mail.sync_store import UpdateAfterFetchResult


def _fake_email_obj():
    return SimpleNamespace(
        subject="hello",
        sender="a@b.com",
        sender_name="A",
        mailbox="收件箱",
        is_flagged=False,
        is_important=False,
        attachments=[],
        date=None,
        message_id="<m1@x>",
        internal_id=None,
    )


def _build_watcher(email_obj, *, update_result=UpdateAfterFetchResult.OK):
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
    w.sync_store.update_after_fetch = Mock(return_value=update_result)
    w.meeting_sync = SimpleNamespace(has_meeting_invite=Mock(return_value=False))
    w.notion_sync = SimpleNamespace(
        create_email_page_v2=AsyncMock(return_value="page123")
    )
    w._notion_date_floor = Mock(return_value=None)
    w._stats = {
        "emails_synced": 0,
        "emails_skipped": 0,
        "meeting_invites": 0,
        "errors": 0,
        "retries_attempted": 0,
        "retries_succeeded": 0,
    }
    w._bg_tasks = set()

    async def _build(full_email, mailbox):
        return email_obj

    w._build_email_object = _build
    w._persist_email_metadata_after_parse = Mock()
    w._maybe_dual_write_body = Mock()
    w._maybe_trigger_project_progress_hook = Mock()
    w._maybe_trigger_llm_hook = Mock()
    w._maybe_trigger_kos_hook = Mock()
    w._maybe_dispatch_island_received = Mock()
    w._maybe_trigger_custom_agents = Mock()
    return w


META = {"internal_id": 42, "mailbox": "收件箱", "subject": "hello"}


@pytest.mark.asyncio
async def test_old_email_keeps_fetched_local_body_without_creating_notion_page():
    email = _fake_email_obj()
    email.date = datetime(2025, 12, 20, tzinfo=timezone.utc)
    watcher = _build_watcher(email)
    watcher._notion_date_floor = Mock(
        return_value=datetime(2026, 1, 1, tzinfo=timezone.utc)
    )
    await watcher._sync_single_email_v3(dict(META))
    watcher._maybe_dual_write_body.assert_called_once_with(email, 42, 'raw-mime')
    watcher.sync_store.mark_skipped.assert_called_once_with(42, reason='notion_date_filter')
    watcher.notion_sync.create_email_page_v2.assert_not_awaited()


@pytest.mark.asyncio
async def test_naive_email_date_is_read_in_local_time_not_beijing(monkeypatch):
    """裸日期（Date 头 -0000 = 无时区）按**本机本地时区**读, 不是写死的北京。

    地板是本地午夜, 判据两边必须同一个时间系。写死 +08:00 时, 洛杉矶机器上"地板当天
    00:30"的邮件会被算成地板前一天 16:30 → 当成旧邮件只存本地, 永远不上 Notion。
    """
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    old_tz = os.environ.get("TZ")
    os.environ["TZ"] = "America/Los_Angeles"
    time.tzset()
    try:
        email = _fake_email_obj()
        email.date = datetime(2026, 8, 28, 0, 30)          # naive
        w = _build_watcher(email)
        w._notion_date_floor = Mock(
            return_value=datetime(2026, 8, 28).astimezone()  # 本地午夜
        )

        await w._sync_single_email_v3(dict(META))
    finally:
        if old_tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = old_tz
        time.tzset()

    w.sync_store.mark_skipped.assert_not_called()
    w.notion_sync.create_email_page_v2.assert_awaited_once()


# ---------------------------------------------------------------------------
# 正向 sync
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sync_duplicate_aborts_before_notion_and_attachments(monkeypatch):
    """DUPLICATE → 在建 Notion 页 / 双写附件之前中止；不 mark_failed（否则又进 retry）。"""
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj, update_result=UpdateAfterFetchResult.DUPLICATE)

    await w._sync_single_email_v3(dict(META))

    w.notion_sync.create_email_page_v2.assert_not_awaited()  # 零 Notion
    w._maybe_dual_write_body.assert_not_called()  # 零附件双写
    w.sync_store.mark_failed_v3.assert_not_called()  # 不拉回 retry 队列
    w.sync_store.mark_synced_v3.assert_not_called()
    assert w._stats["emails_skipped"] == 1


@pytest.mark.asyncio
async def test_sync_failed_marks_failed_not_swallowed(monkeypatch):
    """FAILED → mark_failed_v3（走既有退避/死信），不静默吞；零 Notion。"""
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj, update_result=UpdateAfterFetchResult.FAILED)

    await w._sync_single_email_v3(dict(META))

    w.sync_store.mark_failed_v3.assert_called_once()
    assert w.sync_store.mark_failed_v3.call_args.args[0] == 42
    w.notion_sync.create_email_page_v2.assert_not_awaited()
    w._maybe_dual_write_body.assert_not_called()


@pytest.mark.asyncio
async def test_sync_ok_proceeds_normally(monkeypatch):
    """OK → 正常同步（零漂移 pin）。"""
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj, update_result=UpdateAfterFetchResult.OK)

    await w._sync_single_email_v3(dict(META))

    w.notion_sync.create_email_page_v2.assert_awaited_once()
    w.sync_store.mark_synced_v3.assert_called_once_with(42, "page123")
    w.sync_store.mark_failed_v3.assert_not_called()


# ---------------------------------------------------------------------------
# retry 路径（fetch_failed 分支：refetch → update_after_fetch）
# ---------------------------------------------------------------------------


def _retry_meta(status="fetch_failed", message_id=None):
    return {
        "internal_id": 42,
        "sync_status": status,
        "retry_count": 1,
        "mailbox": "收件箱",
        "subject": "hello",
        "message_id": message_id,
    }


@pytest.mark.asyncio
async def test_retry_duplicate_continues_without_notion(monkeypatch):
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj, update_result=UpdateAfterFetchResult.DUPLICATE)
    w.sync_store.get_ready_for_retry = Mock(return_value=[_retry_meta()])

    await w._process_retry_queue()

    w.notion_sync.create_email_page_v2.assert_not_awaited()
    w._maybe_dual_write_body.assert_not_called()
    w.sync_store.mark_failed_v3.assert_not_called()
    assert w._stats["emails_skipped"] == 1


@pytest.mark.asyncio
async def test_retry_failed_marks_failed(monkeypatch):
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj, update_result=UpdateAfterFetchResult.FAILED)
    w.sync_store.get_ready_for_retry = Mock(return_value=[_retry_meta()])

    await w._process_retry_queue()

    w.sync_store.mark_failed_v3.assert_called_once()
    w.notion_sync.create_email_page_v2.assert_not_awaited()
    w._maybe_dual_write_body.assert_not_called()


# ---------------------------------------------------------------------------
# retry 第三分支（failed 状态 + 已有 message_id：refetch → update_after_fetch）
#
# 幽灵行插入时带假 @localhost message_id(非 NULL) → 恰落这个分支。修前该分支 refetch
# 后直接 _build_email_object, 绕过冲突 guard → 幽灵行每轮读空 sender → Notion 400 →
# 先灌重复附件。修后补 update_after_fetch + _abort_after_fetch, 与另两分支语义一致。
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_retry_failed_with_msgid_duplicate_aborts_before_notion(monkeypatch):
    """failed + 假 message_id 撞真身 → DUPLICATE → 在建 Notion 页 / 双写前中止。"""
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj, update_result=UpdateAfterFetchResult.DUPLICATE)
    w.sync_store.get_ready_for_retry = Mock(
        return_value=[_retry_meta(status="failed", message_id="<ghost.1.2@localhost>")]
    )

    await w._process_retry_queue()

    # refetch 拿回真实 message_id 后, update_after_fetch 必须被调用(冲突 guard 够得到)
    w.sync_store.update_after_fetch.assert_called_once()
    w.notion_sync.create_email_page_v2.assert_not_awaited()  # 零 Notion
    w._maybe_dual_write_body.assert_not_called()  # 零附件双写
    w.sync_store.mark_failed_v3.assert_not_called()  # 不拉回 retry 队列
    assert w._stats["emails_skipped"] == 1


@pytest.mark.asyncio
async def test_retry_failed_with_msgid_failed_marks_failed(monkeypatch):
    """failed + message_id 分支的 FAILED 判定同样不被静默吞 → mark_failed_v3。"""
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj, update_result=UpdateAfterFetchResult.FAILED)
    w.sync_store.get_ready_for_retry = Mock(
        return_value=[_retry_meta(status="failed", message_id="<ghost.1.2@localhost>")]
    )

    await w._process_retry_queue()

    w.sync_store.update_after_fetch.assert_called_once()
    w.sync_store.mark_failed_v3.assert_called_once()
    w.notion_sync.create_email_page_v2.assert_not_awaited()
    w._maybe_dual_write_body.assert_not_called()
