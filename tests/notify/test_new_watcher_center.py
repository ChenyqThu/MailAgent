"""Tests for NewWatcher._maybe_notify_center_reviewed (Phase 3)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from src.mail.new_watcher import NewWatcher
from src.mail.sync_store import SyncStore
from src.notify.center import NotifyCenter


def _make_watcher(tmp_path):
    db_path = tmp_path / "sync_store.db"
    store = SyncStore(str(db_path))
    watcher = object.__new__(NewWatcher)
    watcher.sync_store = store
    watcher._skip_feishu_for_folder = lambda mailbox: False
    watcher._suppress_reconcile_notify = lambda internal_id: False
    return watcher, str(db_path)


def test_urgent_actionable_email_publishes_to_notify_center(tmp_path):
    watcher, db_path = _make_watcher(tmp_path)
    email = SimpleNamespace(
        subject="请审批 Q4 预算",
        sender="alice@example.com",
        sender_name="Alice",
        mailbox="收件箱",
    )
    asyncio.run(
        watcher._maybe_notify_center_reviewed(
            email,
            101,
            {
                "priority": "🔴 紧急",
                "action_type": "需要决策",
                "ai_summary_full": "需要在今天下班前确认最终预算数字。",
            },
        )
    )

    items = NotifyCenter(db_path).list(limit=10).items
    assert len(items) == 1
    row = items[0]
    assert row["category"] == "action_required"
    assert row["source"] == "mail_urgent"
    assert row["severity"] == "critical"
    assert row["title"] == "Alice: 请审批 Q4 预算"
    assert row["payload"] == {
        "delivery": "both",
        "link": {"type": "email", "emailId": 101},
        "actions": [
            {
                "id": "open_email_ai",
                "label": "AI 拟稿 / 跟进",
                "emailId": 101,
                "emailSubject": "请审批 Q4 预算",
            },
            {"id": "snooze_1h", "label": "1小时后提醒"},
        ],
    }


def test_important_email_publishes_reviews_and_skips_sent_mailbox(tmp_path):
    watcher, db_path = _make_watcher(tmp_path)
    important_email = SimpleNamespace(
        subject="客户合同审阅意见",
        sender="bob@example.com",
        sender_name="",
        mailbox="INBOX",
    )
    sent_email = SimpleNamespace(
        subject="Re: 合同",
        sender="me@example.com",
        sender_name="Me",
        mailbox="已发送邮件",
    )
    asyncio.run(
        watcher._maybe_notify_center_reviewed(
            important_email,
            202,
            {"priority": "🟡 重要", "action_type": "需要Review", "ai_summary": "附带修订稿"},
        )
    )
    asyncio.run(
        watcher._maybe_notify_center_reviewed(
            sent_email,
            203,
            {"priority": "🔴 紧急", "action_type": "需要回复", "ai_summary": "skip sent"},
        )
    )

    items = NotifyCenter(db_path).list(limit=10).items
    assert len(items) == 1
    row = items[0]
    assert row["category"] == "reviews"
    assert row["source"] == "mail_important"
    assert row["severity"] == "warn"
    assert row["payload"] == {
        "delivery": "both",
        "link": {"type": "email", "emailId": 202},
        "actions": [
            {
                "id": "open_email_ai",
                "label": "AI 拟稿 / 跟进",
                "emailId": 202,
                "emailSubject": "客户合同审阅意见",
            },
            {"id": "snooze_1h", "label": "1小时后提醒"},
        ],
    }
