"""Notion 可选化（task 07-12 P3b 方案 C）——本地-only 主链 + 守卫面回归。

覆盖:
  1. notion_enabled / calendar_notion_enabled 判定矩阵（注入 cfg，不碰全局单例）
  2. Config 三键缺省可构造（required→optional 后 import 不崩）
  3. _sync_single_email_v3 disabled 主链: mark_synced_local + 5 钩子照跑（page_id=""）
     + 零 Notion 调用
  4. enabled 主链现状 pin: create_email_page_v2 → mark_synced_v3 → 钩子带 page_id
     （零漂移锚点）
  5. retry 路径 disabled: mark_synced_local, 不产生 failed
  6. meeting_sync 入口守卫: 日历面未配置 → (None, invite) 且不触碰任何 handler
  7. LLM runner: disabled + 空 page_id → 分类照跑、跳过 Notion 回写腿、mark_success;
     enabled + 空 page_id → 原「email not synced yet」错误不变
"""
from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock

import pytest

from src.config import Config, calendar_notion_enabled, notion_enabled
from src.llm_agent.runner import LLMRunner
from src.mail.meeting_sync import MeetingInviteSync
from src.mail.new_watcher import NewWatcher


# ---------------------------------------------------------------------------
# 1. 判定矩阵
# ---------------------------------------------------------------------------


def _cfg(token="", email_db="", cal_db=""):
    return SimpleNamespace(
        notion_token=token, email_database_id=email_db, calendar_database_id=cal_db
    )


@pytest.mark.parametrize(
    "token,email_db,expected",
    [
        ("ntn_x", "db1", True),
        ("", "db1", False),
        ("ntn_x", "", False),
        ("", "", False),
        ("  ", "db1", False),  # 空白串 = 未配置
        ("ntn_x", "  ", False),
    ],
)
def test_notion_enabled_matrix(token, email_db, expected):
    assert notion_enabled(_cfg(token=token, email_db=email_db)) is expected


@pytest.mark.parametrize(
    "token,cal_db,expected",
    [
        ("ntn_x", "cal1", True),
        ("", "cal1", False),
        ("ntn_x", "", False),
        ("ntn_x", " ", False),
    ],
)
def test_calendar_notion_enabled_matrix(token, cal_db, expected):
    assert calendar_notion_enabled(_cfg(token=token, cal_db=cal_db)) is expected


# ---------------------------------------------------------------------------
# 2. Config 三键缺省可构造
# ---------------------------------------------------------------------------


def test_config_constructs_without_notion_keys(monkeypatch):
    for key in ("NOTION_TOKEN", "EMAIL_DATABASE_ID", "CALENDAR_DATABASE_ID"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("USER_EMAIL", "a@b.com")
    cfg = Config(_env_file=os.devnull)
    assert cfg.notion_token == ""
    assert cfg.email_database_id == ""
    assert notion_enabled(cfg) is False
    assert calendar_notion_enabled(cfg) is False


# ---------------------------------------------------------------------------
# watcher 主链 harness（NewWatcher.__new__ 绕过重构造，先例 tests/agents/test_watcher_hook.py）
# ---------------------------------------------------------------------------


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


def _build_watcher(email_obj):
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
    w.meeting_sync = SimpleNamespace(has_meeting_invite=Mock(return_value=False))
    w.notion_sync = SimpleNamespace(
        create_email_page_v2=AsyncMock(return_value="page123")
    )
    w.sync_start_date = None
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
    # 5 钩子换成录音 stub（钩子内部对空 page_id 的容忍各自有测）
    w._maybe_trigger_project_progress_hook = Mock()
    w._maybe_trigger_llm_hook = Mock()
    w._maybe_trigger_kos_hook = Mock()
    w._maybe_dispatch_island_received = Mock()
    w._maybe_trigger_custom_agents = Mock()
    return w


META = {"internal_id": 42, "mailbox": "收件箱", "subject": "hello"}


# ---------------------------------------------------------------------------
# 3. disabled 主链
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sync_single_email_disabled_local_only(monkeypatch):
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: False)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj)

    await w._sync_single_email_v3(dict(META))

    # 零 Notion 调用 + 本地 synced
    w.notion_sync.create_email_page_v2.assert_not_awaited()
    w.sync_store.mark_synced_local.assert_called_once_with(42)
    w.sync_store.mark_synced_v3.assert_not_called()
    w.sync_store.mark_failed_v3.assert_not_called()
    assert w._stats["emails_synced"] == 1
    # 5 钩子照跑, page_id=""
    w._maybe_trigger_project_progress_hook.assert_called_once_with(email_obj, 42, "")
    w._maybe_trigger_llm_hook.assert_called_once_with(email_obj, 42, "")
    w._maybe_trigger_kos_hook.assert_called_once_with(email_obj, 42, "")
    w._maybe_dispatch_island_received.assert_called_once_with(email_obj, 42, "")
    w._maybe_trigger_custom_agents.assert_called_once_with(email_obj, 42)


# ---------------------------------------------------------------------------
# 4. enabled 主链零漂移 pin
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sync_single_email_enabled_unchanged(monkeypatch):
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj)

    await w._sync_single_email_v3(dict(META))

    w.notion_sync.create_email_page_v2.assert_awaited_once()
    w.sync_store.mark_synced_v3.assert_called_once_with(42, "page123")
    w.sync_store.mark_synced_local.assert_not_called()
    assert w._stats["emails_synced"] == 1
    w._maybe_trigger_project_progress_hook.assert_called_once_with(
        email_obj, 42, "page123"
    )
    w._maybe_trigger_llm_hook.assert_called_once_with(email_obj, 42, "page123")
    w._maybe_trigger_kos_hook.assert_called_once_with(email_obj, 42, "page123")
    w._maybe_dispatch_island_received.assert_called_once_with(email_obj, 42, "page123")
    w._maybe_trigger_custom_agents.assert_called_once_with(email_obj, 42)


@pytest.mark.asyncio
async def test_sync_single_email_enabled_notion_none_marks_failed(monkeypatch):
    """enabled 且 create 返回 None → mark_failed_v3（现状语义 pin）。"""
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: True)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj)
    w.notion_sync.create_email_page_v2 = AsyncMock(return_value=None)

    await w._sync_single_email_v3(dict(META))

    w.sync_store.mark_failed_v3.assert_called_once()
    w.sync_store.mark_synced_local.assert_not_called()
    w._maybe_trigger_llm_hook.assert_not_called()


# ---------------------------------------------------------------------------
# 5. retry 路径 disabled
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_retry_queue_disabled_local_only(monkeypatch):
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: False)
    email_obj = _fake_email_obj()
    w = _build_watcher(email_obj)
    w.sync_store.get_ready_for_retry = Mock(
        return_value=[
            {
                "internal_id": 42,
                "sync_status": "failed",
                "retry_count": 1,
                "mailbox": "收件箱",
                "subject": "hello",
                "message_id": "<m1@x>",
            }
        ]
    )

    await w._process_retry_queue()

    w.notion_sync.create_email_page_v2.assert_not_awaited()
    w.sync_store.mark_synced_local.assert_called_once_with(42)
    w.sync_store.mark_failed_v3.assert_not_called()
    assert w._stats["retries_succeeded"] == 1


# ---------------------------------------------------------------------------
# 6. meeting_sync 入口守卫
# ---------------------------------------------------------------------------


def _fake_invite():
    return SimpleNamespace(
        uid="uid-1",
        summary="standup",
        method="REQUEST",
        recurrence_rule=None,
        recurrence_id=None,
    )


@pytest.mark.asyncio
async def test_meeting_sync_calendar_disabled_skips(monkeypatch):
    monkeypatch.setattr(
        "src.mail.meeting_sync.calendar_notion_enabled", lambda: False
    )
    sync = MeetingInviteSync()
    invite = _fake_invite()
    sync.parser = SimpleNamespace(
        extract_from_email_source=Mock(return_value=invite),
        has_calendar_invite=Mock(return_value=True),
    )
    boom = AsyncMock(side_effect=AssertionError("handler must not run"))
    sync._handle_master_request = boom
    sync._sync_single_event = boom

    page_id, returned = await sync.process_email("raw", "mid")

    assert page_id is None
    assert returned is invite  # 邮件页会议信息渲染不受影响
    assert sync._stats["invites_detected"] == 0


@pytest.mark.asyncio
async def test_meeting_sync_calendar_enabled_dispatches(monkeypatch):
    monkeypatch.setattr(
        "src.mail.meeting_sync.calendar_notion_enabled", lambda: True
    )
    sync = MeetingInviteSync()
    invite = _fake_invite()
    sync.parser = SimpleNamespace(
        extract_from_email_source=Mock(return_value=invite),
        has_calendar_invite=Mock(return_value=True),
    )
    sync._handle_master_request = AsyncMock(return_value=("pid", invite))

    page_id, returned = await sync.process_email("raw", "mid")

    assert page_id == "pid"
    assert sync._stats["invites_detected"] == 1


# ---------------------------------------------------------------------------
# 7. LLM runner: Notion 回写腿条件化
# ---------------------------------------------------------------------------


def _fake_labels():
    return SimpleNamespace(
        translation_segments=[],
        model="test-model",
        summary_for_log=lambda: {"priority": "🟢 普通"},
    )


def _build_runner(tmp_path, labels):
    processor = SimpleNamespace(
        process_email=AsyncMock(return_value=labels), close=AsyncMock()
    )
    writer = SimpleNamespace(
        write=AsyncMock(side_effect=AssertionError("Notion write must not run"))
    )
    store = MagicMock()
    store.get.return_value = None
    backend = SimpleNamespace(
        fetch_email_content_by_id=Mock(
            return_value={"source": "raw", "message_id": "<m1@x>"}
        )
    )
    runner = LLMRunner(
        processor=processor,
        writer=writer,
        store=store,
        db_path=str(tmp_path / "s.db"),
        backend=backend,
    )
    email_obj = _fake_email_obj()
    runner._reader = SimpleNamespace(
        parse_email_source=Mock(return_value=email_obj)
    )
    return runner, store, writer


@pytest.mark.asyncio
async def test_runner_disabled_classifies_without_notion(monkeypatch, tmp_path):
    monkeypatch.setattr("src.llm_agent.runner.notion_enabled", lambda: False)
    monkeypatch.setattr(
        "src.llm_agent.runner._lookup_by_internal_id",
        lambda iid, db_path=None: {
            "internal_id": iid,
            "message_id": "<m1@x>",
            "notion_page_id": None,
            "mailbox": "收件箱",
            "subject": "s",
            "is_read": 0,
            "is_flagged": 0,
        },
    )
    labels = _fake_labels()
    runner, store, writer = _build_runner(tmp_path, labels)

    result = await runner.run_for_internal_id(7)

    assert result["ok"] is True
    assert result["writer_summary"] == {"skipped": "notion_disabled"}
    writer.write.assert_not_awaited()
    store.mark_success.assert_called_once()
    assert store.mark_success.call_args.kwargs.get("page_id") == ""


@pytest.mark.asyncio
async def test_runner_enabled_empty_page_id_unchanged(monkeypatch, tmp_path):
    monkeypatch.setattr("src.llm_agent.runner.notion_enabled", lambda: True)
    monkeypatch.setattr(
        "src.llm_agent.runner._lookup_by_internal_id",
        lambda iid, db_path=None: {
            "internal_id": iid,
            "message_id": "<m1@x>",
            "notion_page_id": None,
            "mailbox": "收件箱",
            "subject": "s",
            "is_read": 0,
            "is_flagged": 0,
        },
    )
    labels = _fake_labels()
    runner, store, writer = _build_runner(tmp_path, labels)

    result = await runner.run_for_internal_id(7)

    assert result["ok"] is False
    assert "not synced to Notion yet" in result["error"]
    store.mark_pending.assert_not_called()
