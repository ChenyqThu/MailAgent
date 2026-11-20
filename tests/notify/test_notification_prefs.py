"""Selectable notification channels, system_only delivery & meeting_prep preset tests."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from src.mail.new_watcher import NewWatcher
from src.mail.sync_store import SyncStore
from src.notify.center import NotifyCenter
from src.notify.prefs import (
    DEFAULT_NOTIFICATION_PREFS,
    MEETING_PREP_PRESET_AGENT_ID,
    load_notification_prefs,
    save_notification_prefs,
    sync_meeting_prep_preset_agent,
)
from src.reports.store import ReportStore


def _init_db(tmp_path):
    db_path = tmp_path / "sync_store.db"
    SyncStore(str(db_path))
    return str(db_path)


def test_load_and_save_prefs_roundtrip_and_validation(tmp_path):
    db_path = _init_db(tmp_path)
    assert load_notification_prefs(db_path) == DEFAULT_NOTIFICATION_PREFS

    saved = save_notification_prefs(
        db_path,
        {
            "mailDelivery": "system_only",
            "mailScope": "urgent_only",
            "meetingDelivery": "center_only",
            "meetingLeadMinutes": 15,
            "meetingPrepEnabled": True,
            "meetingPrepMode": "auto_before",
            "meetingPrepLeadMinutes": 60,
            "suppressBannerWhenFocused": False,
        },
    )
    assert saved["mailDelivery"] == "system_only"
    assert saved["mailScope"] == "urgent_only"
    assert saved["meetingLeadMinutes"] == 15
    assert saved["meetingPrepEnabled"] is True
    assert saved["meetingPrepMode"] == "auto_before"
    assert saved["meetingPrepLeadMinutes"] == 60
    assert saved["suppressBannerWhenFocused"] is False
    assert load_notification_prefs(db_path) == saved

    with pytest.raises(ValueError, match="mailDelivery"):
        save_notification_prefs(db_path, {"mailDelivery": "invalid"})


def test_notify_center_system_only_keeps_unread_zero(tmp_path):
    db_path = _init_db(tmp_path)
    center = NotifyCenter(db_path)

    res = center.publish(
        category="action_required",
        source="calendar_reminder",
        title="系统弹窗测试",
        dedupe_key="cal:sys-only",
        payload={"link": {"type": "route", "to": "/admin/calendar"}},
        system_only=True,
        emit_event=False,
    )
    assert res.created is True

    counts = center.unread_count()
    assert counts["total"] == 0
    assert counts["open_by_category"]["action_required"] == 0
    assert center.list(state="open").items == []

    all_rows = center.list(state="all").items
    assert len(all_rows) == 1
    assert all_rows[0]["state"] == "resolved"
    assert all_rows[0]["read_at"] is not None
    assert all_rows[0]["payload"]["delivery"] == "system_only"


def test_sync_meeting_prep_preset_agent_modes(tmp_path):
    db_path = _init_db(tmp_path)
    report_store = ReportStore(db_path)

    # Enabling in on_demand creates/enables preset agent with trigger disabled
    prefs_on_demand = save_notification_prefs(
        db_path,
        {"meetingPrepEnabled": True, "meetingPrepMode": "on_demand"},
    )
    agent_id = sync_meeting_prep_preset_agent(prefs_on_demand, report_store)
    assert agent_id == MEETING_PREP_PRESET_AGENT_ID
    row = report_store.get_agent(MEETING_PREP_PRESET_AGENT_ID)
    assert row is not None
    assert bool(row["enabled"]) is True
    assert '"enabled": false' in row["trigger_json"]

    # Switching to auto_before enables calendar_before_start trigger at lead_seconds
    prefs_auto = save_notification_prefs(
        db_path,
        {"meetingPrepMode": "auto_before", "meetingPrepLeadMinutes": 60},
    )
    sync_meeting_prep_preset_agent(prefs_auto, report_store)
    row = report_store.get_agent(MEETING_PREP_PRESET_AGENT_ID)
    assert '"enabled": true' in row["trigger_json"]
    assert '"lead_seconds": 3600' in row["trigger_json"]

    # Disabling turns row off without deleting history
    prefs_off = save_notification_prefs(db_path, {"meetingPrepEnabled": False})
    assert sync_meeting_prep_preset_agent(prefs_off, report_store) is None
    row = report_store.get_agent(MEETING_PREP_PRESET_AGENT_ID)
    assert row is not None and not bool(row["enabled"])


def test_watcher_respects_feishu_dedupe_and_urgent_scope(tmp_path):
    db_path = _init_db(tmp_path)
    store = SyncStore(db_path)
    watcher = object.__new__(NewWatcher)
    watcher.sync_store = store
    watcher._skip_feishu_for_folder = lambda mailbox: False
    watcher._suppress_reconcile_notify = lambda internal_id: False

    urgent = SimpleNamespace(
        subject="紧急发布确认", sender="a@example.com", sender_name="Alice", mailbox="收件箱"
    )
    important = SimpleNamespace(
        subject="周例会材料", sender="b@example.com", sender_name="Bob", mailbox="收件箱"
    )

    # feishu_sent=True + both + skipBannerWhenFeishuSent=True → downgrades to center_only
    asyncio.run(
        watcher._maybe_notify_center_reviewed(
            urgent,
            1001,
            {"priority": "🔴 紧急", "action_type": "需要回复"},
            feishu_sent=True,
        )
    )
    row1 = NotifyCenter(db_path).list(state="open").items[0]
    assert row1["payload"]["delivery"] == "center_only"

    # urgent_only + system_only skips non-urgent important mail cleanly
    save_notification_prefs(
        db_path, {"mailDelivery": "system_only", "mailScope": "urgent_only"}
    )
    asyncio.run(
        watcher._maybe_notify_center_reviewed(
            important,
            1002,
            {"priority": "🟡 重要", "action_type": "需要回复"},
            feishu_sent=False,
        )
    )
    assert len(NotifyCenter(db_path).list(state="all").items) == 1
