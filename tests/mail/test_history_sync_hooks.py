"""历史邮件的钩子门控 (task 09-11 §4)。

「同步历史邮件」补回来的行带 ``ingest_reason='history_sync'``。三个**实时性语义**的
去处对它一律不触发 —— 补一年前的邮件不该弹飞书 / 上灵动岛 / 起 Custom Agent run /
跑项目周报同步。而 LLM 分类 / KOS / 事项线程关联**照常**: 那是对邮件内容的加工,
与"什么时候到的"无关, 补回来的邮件同样需要。
"""
from __future__ import annotations

import os

os.environ.setdefault("USER_EMAIL", "ci@example.test")

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock

import pytest

from src.mail.ingest_provenance import (
    INGEST_HISTORY,
    INGEST_RECONCILE,
    INGEST_REALTIME,
    is_history_ingest,
    should_suppress_reconcile_notify,
)
from src.mail.new_watcher import NewWatcher


class _Store:
    """只实现 provenance 判定要用的那一个方法。"""

    def __init__(self, row):
        self._row = row

    def get(self, _internal_id):
        if isinstance(self._row, Exception):
            raise self._row
        return self._row


def _row(reason, *, hours_ago: int = 1) -> dict:
    return {
        "ingest_reason": reason,
        "date_received": (
            datetime.now(timezone.utc) - timedelta(hours=hours_ago)
        ).isoformat(),
    }


# ---------------------------------------------------------------------------
# provenance 判定
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "reason,expected",
    [
        (INGEST_HISTORY, True),
        (INGEST_REALTIME, False),
        (INGEST_RECONCILE, False),
        (None, False),                  # NULL 存量 = 普通邮件
    ],
)
def test_is_history_ingest_matrix(reason, expected):
    assert is_history_ingest(_Store(_row(reason)), 42) is expected


def test_is_history_ingest_fails_open():
    """读不到 provenance 一律按普通邮件处理 —— 宁可多跑一次钩子, 不静默降级新邮件。"""
    assert is_history_ingest(_Store(None), 42) is False
    assert is_history_ingest(_Store(RuntimeError("db gone")), 42) is False
    assert is_history_ingest(None, 42) is False
    assert is_history_ingest(_Store(_row(INGEST_HISTORY)), None) is False


def test_history_rows_never_notify_feishu_regardless_of_age():
    """🔴 与对账补抓不同, 历史补录**不看年龄**: 用户可以补"今天", 年龄阈值拦不住,
    一次几百封全推飞书就是刷屏。max_age 配成 0 (关掉年龄门) 也照样抑制。"""
    fresh = _Store(_row(INGEST_HISTORY, hours_ago=0))

    assert should_suppress_reconcile_notify(fresh, 42, 7200) is True
    assert should_suppress_reconcile_notify(fresh, 42, 0) is True


def test_reconcile_age_gate_is_unchanged():
    """对账补抓的判据仍是「补抓来源 AND 超龄」—— 本次改动不得动它。"""
    old = _Store(_row(INGEST_RECONCILE, hours_ago=10))
    fresh = _Store(_row(INGEST_RECONCILE, hours_ago=0))

    assert should_suppress_reconcile_notify(old, 42, 7200) is True
    assert should_suppress_reconcile_notify(fresh, 42, 7200) is False
    assert should_suppress_reconcile_notify(old, 42, 0) is False   # 年龄门关掉


def test_realtime_mail_still_notifies():
    assert should_suppress_reconcile_notify(_Store(_row(INGEST_REALTIME)), 42, 7200) is False


# ---------------------------------------------------------------------------
# watcher 主链: 三个钩子被门掉, 两个照跑
# ---------------------------------------------------------------------------


def _email_obj():
    return SimpleNamespace(
        subject="hello", sender="a@b.com", sender_name="A", mailbox="收件箱",
        is_flagged=False, is_important=False, attachments=[], date=None,
        message_id="<m1@x>", internal_id=None,
    )


def _watcher(ingest_reason):
    """``_sync_single_email_v3`` 的最小跑通面 (harness 同 tests/mail/test_notion_optional.py)。"""
    email_obj = _email_obj()
    w = NewWatcher.__new__(NewWatcher)
    w.backend = SimpleNamespace(
        fetch_email_content_by_id=Mock(return_value={
            "message_id": "<m1@x>", "thread_id": "t1", "subject": "hello",
            "sender": "a@b.com", "source": "raw-mime",
        })
    )
    w.sync_store = MagicMock()
    w.sync_store.get.return_value = {"ingest_reason": ingest_reason}
    w.meeting_sync = SimpleNamespace(has_meeting_invite=Mock(return_value=False))
    w.notion_sync = SimpleNamespace(create_email_page_v2=AsyncMock(return_value="page123"))
    w._notion_date_floor = Mock(return_value=None)
    w._stats = {"emails_synced": 0, "emails_skipped": 0, "meeting_invites": 0,
                "errors": 0, "retries_attempted": 0, "retries_succeeded": 0}
    w._bg_tasks = set()

    async def _build(_full_email, _mailbox):
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


META = {"internal_id": 42, "mailbox": "收件箱", "subject": "hello"}


@pytest.mark.parametrize("notion_on", [True, False])
async def test_history_mail_skips_the_realtime_hooks(monkeypatch, notion_on):
    """🔴 Notion 开 / 关是两条分支, 两条都要门掉 —— 只堵一条 = 换个配置就漏。"""
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: notion_on)
    w = _watcher(INGEST_HISTORY)

    await w._sync_single_email_v3(dict(META))

    w._maybe_dispatch_island_received.assert_not_called()
    w._maybe_trigger_custom_agents.assert_not_called()
    w._maybe_trigger_project_progress_hook.assert_not_called()
    # 内容加工照跑
    w._maybe_trigger_llm_hook.assert_called_once()
    w._maybe_trigger_kos_hook.assert_called_once()
    w._maybe_link_matter_thread_subscriptions.assert_awaited_once()


@pytest.mark.parametrize("notion_on", [True, False])
async def test_normal_mail_still_fires_every_hook(monkeypatch, notion_on):
    """对照组: 普通邮件五个钩子一个不少 (证明上面的断言不是恒绿)。"""
    monkeypatch.setattr("src.mail.new_watcher.notion_enabled", lambda: notion_on)
    w = _watcher(INGEST_REALTIME)

    await w._sync_single_email_v3(dict(META))

    w._maybe_dispatch_island_received.assert_called_once()
    w._maybe_trigger_custom_agents.assert_called_once()
    w._maybe_trigger_project_progress_hook.assert_called_once()
    w._maybe_trigger_llm_hook.assert_called_once()
    w._maybe_trigger_kos_hook.assert_called_once()
