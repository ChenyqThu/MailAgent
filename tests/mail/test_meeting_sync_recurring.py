"""MeetingInviteSync 4 象限 dispatch + Inline relabel + sequence-skip 测试.

全部 mock CalendarNotionSync 与 SyncStore，不打 Notion 真实 API。
async 测试用 asyncio.run 包装（与 tests/llm_agent 保持一致，不依赖 pytest-asyncio）。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock
from zoneinfo import ZoneInfo

import pytest

from src.mail.icalendar_parser import ICalendarParser
from src.mail.meeting_sync import MeetingInviteSync


BJ_TZ = ZoneInfo("Asia/Shanghai")


class FakeSyncStore:
    """In-memory replacement for SyncStore.recurring_series methods."""

    def __init__(self):
        self.rows: dict = {}
        self.exdate_calls: list = []
        self.expanded_until_calls: list = []

    def get_recurring_series(self, uid):
        return dict(self.rows[uid]) if uid in self.rows else None

    def upsert_recurring_series(self, row):
        uid = row["series_uid"]
        if uid in self.rows:
            existing = self.rows[uid]
            merged = {**existing, **row}
            self.rows[uid] = merged
        else:
            self.rows[uid] = dict(row)
        return True

    def append_exdate(self, uid, exdate_iso):
        self.exdate_calls.append((uid, exdate_iso))
        if uid not in self.rows:
            return False
        try:
            existing = json.loads(self.rows[uid].get("exdates_json") or "[]")
        except json.JSONDecodeError:
            existing = []
        if exdate_iso not in existing:
            existing.append(exdate_iso)
        self.rows[uid]["exdates_json"] = json.dumps(existing)
        return True

    def update_expanded_until(self, uid, until_iso):
        self.expanded_until_calls.append((uid, until_iso))
        if uid in self.rows:
            self.rows[uid]["last_expanded_until"] = until_iso
        return True


@pytest.fixture
def parser():
    return ICalendarParser()


@pytest.fixture
def store():
    return FakeSyncStore()


@pytest.fixture
def patched_sync(monkeypatch, store):
    """构造一个 MeetingInviteSync 实例，patch CalendarNotionSync 不调网络。"""
    # patch CalendarNotionSync 的初始化以避免读取 config.notion_token
    fake_calendar = MagicMock()
    fake_calendar.sync_event = AsyncMock(return_value=("created", "page-1"))
    fake_calendar._find_existing_event = AsyncMock(return_value=None)
    fake_calendar.find_by_event_id_prefix = AsyncMock(return_value=[])
    fake_calendar.mark_cancelled = AsyncMock(return_value=True)
    fake_calendar.relabel_event_id = AsyncMock(return_value=True)
    fake_calendar.client = MagicMock()

    sync = MeetingInviteSync.__new__(MeetingInviteSync)
    sync.parser = ICalendarParser()
    sync.calendar_sync = fake_calendar
    sync.sync_store = store
    sync._stats = {
        "invites_detected": 0, "events_created": 0, "events_updated": 0,
        "events_skipped": 0, "events_cancelled": 0, "errors": 0,
        "series_upserts": 0, "occurrences_synced": 0, "relabel_applied": 0,
        "out_of_order_skipped": 0,
    }
    return sync


# ---------- REQUEST + 无 RECURRENCE-ID ----------

async def test_master_request_new_series_expands_and_syncs(patched_sync, store, make_ical):
    """新 UID + RRULE：upsert series + 展开 + 多次 sync_event."""
    src = make_ical(
        uid="series-1",
        rrule="FREQ=WEEKLY",
        dtstart="20260420T140000",
        dtend="20260420T150000",
    )
    page_id, invite = await patched_sync.process_email(src, "msg-1")

    # series 行被 upsert
    assert "series-1" in store.rows
    assert store.rows["series-1"]["rrule_str"] == "FREQ=WEEKLY"
    # last_expanded_until 已更新
    assert any(uid == "series-1" for uid, _ in store.expanded_until_calls)
    # 多次 sync_event 被调用
    assert patched_sync.calendar_sync.sync_event.await_count >= 1
    # 返回了第一个 page_id
    assert page_id is not None
    assert invite.uid == "series-1"


async def test_master_request_sequence_lower_skipped(patched_sync, store, make_ical):
    """已存在 series + 旧 SEQUENCE → 跳过."""
    # 预填一个 last_sequence=5 的 series
    store.rows["series-2"] = {
        "series_uid": "series-2",
        "rrule_str": "FREQ=WEEKLY",
        "master_dtstart": "2026-04-20T14:00:00+08:00",
        "master_dtend": "2026-04-20T15:00:00+08:00",
        "last_sequence": 5,
        "exdates_json": "[]",
    }

    src = make_ical(
        uid="series-2",
        rrule="FREQ=WEEKLY",
        sequence=2,  # 低于已存
    )
    page_id, invite = await patched_sync.process_email(src, "msg-2")

    assert page_id is None
    assert patched_sync.calendar_sync.sync_event.await_count == 0
    assert patched_sync._stats["out_of_order_skipped"] == 1


async def test_master_request_inline_relabel_legacy_master(patched_sync, store, make_ical):
    """已存在裸 UID 页面 → relabel + 继续展开."""
    # 模拟旧版页面存在
    patched_sync.calendar_sync._find_existing_event = AsyncMock(
        return_value={"id": "legacy-page-id"}
    )

    src = make_ical(
        uid="legacy-1",
        rrule="FREQ=WEEKLY",
        dtstart="20260420T140000",
        dtend="20260420T150000",
    )
    page_id, invite = await patched_sync.process_email(src, "msg-3")

    # relabel_event_id 被调用，新 Event ID 形式 {uid}@{utc_iso}
    assert patched_sync.calendar_sync.relabel_event_id.await_count == 1
    call_args = patched_sync.calendar_sync.relabel_event_id.await_args
    assert call_args.args[0] == "legacy-page-id"
    assert call_args.args[1].startswith("legacy-1@")
    assert call_args.args[1].endswith("Z")
    assert patched_sync._stats["relabel_applied"] == 1


async def test_master_request_no_rrule_falls_back_to_single(patched_sync, store, make_ical):
    """REQUEST 但无 RRULE → 走单事件路径，不动 recurring_series."""
    src = make_ical(uid="single-1", rrule=None)
    page_id, invite = await patched_sync.process_email(src, "msg-4")

    assert "single-1" not in store.rows
    assert patched_sync.calendar_sync.sync_event.await_count == 1
    assert page_id == "page-1"


# ---------- REQUEST + 有 RECURRENCE-ID ----------

async def test_override_request_syncs_one_and_appends_exdate(patched_sync, store, make_ical):
    """单实例 override：sync 一个 + EXDATE append."""
    # 预填 series 行让 append_exdate 能 hit
    store.rows["override-1"] = {
        "series_uid": "override-1",
        "rrule_str": "FREQ=WEEKLY",
        "master_dtstart": "2026-04-20T14:00:00+08:00",
        "master_dtend": "2026-04-20T15:00:00+08:00",
        "last_sequence": 0,
        "exdates_json": "[]",
    }

    src = make_ical(
        uid="override-1",
        method="REQUEST",
        recurrence_id="20260427T140000",  # 原本第二次的时间
        rrule=None,
        dtstart="20260427T160000",  # override 移到 16:00
        dtend="20260427T170000",
    )
    page_id, invite = await patched_sync.process_email(src, "msg-5")

    # 仅 1 次 sync_event 调用
    assert patched_sync.calendar_sync.sync_event.await_count == 1
    sync_args = patched_sync.calendar_sync.sync_event.await_args.args[0]
    # event_id 应是 {uid}@{recurrence_id_utc} 形式
    assert sync_args.event_id.startswith("override-1@")
    assert sync_args.master_event_id == "override-1"
    # EXDATE 被 append（含 recurrence_id 原始时间）
    assert len(store.exdate_calls) == 1
    assert store.exdate_calls[0][0] == "override-1"


# ---------- CANCEL + 无 RECURRENCE-ID ----------

async def test_series_cancel_marks_future_pages(patched_sync, store, make_ical):
    """整系列取消：所有未来 occurrences 标记 cancelled."""
    # 模拟有 3 个未来 occurrence 页
    patched_sync.calendar_sync.find_by_event_id_prefix = AsyncMock(
        return_value=[
            {"id": "p1"},
            {"id": "p2"},
            {"id": "p3"},
        ]
    )
    # 预填 series
    store.rows["cancel-series-1"] = {
        "series_uid": "cancel-series-1",
        "rrule_str": "FREQ=WEEKLY",
        "master_dtstart": "2026-04-20T14:00:00+08:00",
        "master_dtend": "2026-04-20T15:00:00+08:00",
        "exdates_json": "[]",
    }

    src = make_ical(
        uid="cancel-series-1",
        method="CANCEL",
        rrule=None,
    )
    page_id, invite = await patched_sync.process_email(src, "msg-6")

    # find_by_event_id_prefix 被调用，prefix 是 "{uid}@"，future_only=True
    call = patched_sync.calendar_sync.find_by_event_id_prefix.await_args
    assert call.args[0] == "cancel-series-1@"
    assert call.kwargs.get("future_only") is True
    # 3 次 mark_cancelled
    assert patched_sync.calendar_sync.mark_cancelled.await_count == 3
    assert patched_sync._stats["events_cancelled"] == 3


# ---------- CANCEL + 有 RECURRENCE-ID ----------

async def test_instance_cancel_marks_one_and_appends_exdate(patched_sync, store, make_ical):
    """单实例取消：找 {uid}@{ts} 页面 → cancel + EXDATE."""
    patched_sync.calendar_sync._find_existing_event = AsyncMock(
        return_value={"id": "instance-page-id"}
    )
    store.rows["cancel-inst-1"] = {
        "series_uid": "cancel-inst-1",
        "rrule_str": "FREQ=WEEKLY",
        "master_dtstart": "2026-04-20T14:00:00+08:00",
        "master_dtend": "2026-04-20T15:00:00+08:00",
        "exdates_json": "[]",
    }

    src = make_ical(
        uid="cancel-inst-1",
        method="CANCEL",
        recurrence_id="20260504T140000",
        rrule=None,
    )
    page_id, invite = await patched_sync.process_email(src, "msg-7")

    # event_id 用于查询的是 {uid}@{utc_iso}
    call = patched_sync.calendar_sync._find_existing_event.await_args
    assert call.args[0].startswith("cancel-inst-1@")
    assert call.args[0].endswith("Z")
    # mark_cancelled 被调用 1 次
    assert patched_sync.calendar_sync.mark_cancelled.await_count == 1
    # EXDATE 被 append
    assert len(store.exdate_calls) == 1
    assert store.exdate_calls[0][0] == "cancel-inst-1"
