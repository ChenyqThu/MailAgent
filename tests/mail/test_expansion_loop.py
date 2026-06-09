"""main.py 周期会议滚动展开 tick 的单测.

只测 _run_expansion_tick 的行为，不启 main.py 主循环。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock
from zoneinfo import ZoneInfo

import pytest


BJ_TZ = ZoneInfo("Asia/Shanghai")


@pytest.fixture(autouse=True)
def _stub_main_config_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """main.py 顶部 import 期会校验 config；为延迟 import 的 EmailNotionSyncApp 提供
    最小必填 env。用 monkeypatch 逐测试还原，杜绝 os.environ.setdefault 的进程级泄漏
    （旧写法会污染后续测试文件，如 tests/api 的 env-snapshot 断言）。"""
    monkeypatch.setenv("NOTION_TOKEN", "test")
    monkeypatch.setenv("EMAIL_DATABASE_ID", "test")
    monkeypatch.setenv("USER_EMAIL", "test@example.com")
    monkeypatch.setenv("MAIL_ACCOUNT_NAME", "test")


class FakeSyncStore:
    """In-memory 替代 SyncStore.recurring_series + state 方法."""

    def __init__(self, rows=None, state=None):
        self.rows: dict = dict(rows or {})
        self.state: dict = dict(state or {})
        self.expanded_until_calls: list = []

    def get_state(self, key):
        return self.state.get(key)

    def set_state(self, key, value):
        self.state[key] = value
        return True

    def iter_series_needing_expansion(self, cutoff_iso):
        for uid, row in self.rows.items():
            until = row.get("last_expanded_until")
            if until is None or until < cutoff_iso:
                yield dict(row)

    def update_expanded_until(self, uid, until_iso):
        self.expanded_until_calls.append((uid, until_iso))
        if uid in self.rows:
            self.rows[uid]["last_expanded_until"] = until_iso
        return True


def _build_app(rows, state=None):
    """构造一个 mock 的 EmailNotionSyncApp 实例（只挂 _run_expansion_tick 需要的属性）."""
    # 延迟 import 以避免顶部 main.py 加载时检查 config
    # （必填 env 由 autouse fixture _stub_main_config_env 在测试运行时提供并逐测试还原）
    from main import EmailNotionSyncApp

    app = EmailNotionSyncApp.__new__(EmailNotionSyncApp)

    fake_store = FakeSyncStore(rows=rows, state=state)
    fake_meeting_sync = MagicMock()
    fake_meeting_sync.calendar_sync = MagicMock()
    fake_meeting_sync.calendar_sync.sync_event = AsyncMock(return_value=("created", "page-x"))

    fake_watcher = MagicMock()
    fake_watcher.sync_store = fake_store
    fake_watcher.meeting_sync = fake_meeting_sync

    app.watcher = fake_watcher
    return app, fake_store, fake_meeting_sync


def test_run_expansion_tick_skips_high_water_series():
    rows = {
        "low-1": {
            "series_uid": "low-1",
            "rrule_str": "FREQ=WEEKLY",
            "master_dtstart": datetime(2026, 4, 20, 14, 0, tzinfo=BJ_TZ).isoformat(),
            "master_dtend": datetime(2026, 4, 20, 15, 0, tzinfo=BJ_TZ).isoformat(),
            "master_summary": "low",
            "master_is_all_day": 0,
            "exdates_json": "[]",
            "last_expanded_until": None,
        },
        "high-1": {
            "series_uid": "high-1",
            "rrule_str": "FREQ=WEEKLY",
            "master_dtstart": datetime(2026, 4, 20, 14, 0, tzinfo=BJ_TZ).isoformat(),
            "master_dtend": datetime(2026, 4, 20, 15, 0, tzinfo=BJ_TZ).isoformat(),
            "master_summary": "high",
            "master_is_all_day": 0,
            "exdates_json": "[]",
            # 远未来的高水位 - cutoff 一定低于它
            "last_expanded_until": "2030-01-01T00:00:00+00:00",
        },
    }
    app, store, meeting_sync = _build_app(rows)

    import asyncio
    asyncio.run(app._run_expansion_tick(horizon_weeks=4))

    # high-1 不在 iter_series_needing_expansion 结果里 → 不应被处理
    selected_uids = {uid for uid, _ in store.expanded_until_calls}
    assert "low-1" in selected_uids
    assert "high-1" not in selected_uids


def test_run_expansion_tick_pushes_high_water_mark():
    rows = {
        "to-extend": {
            "series_uid": "to-extend",
            "rrule_str": "FREQ=WEEKLY",
            "master_dtstart": datetime(2026, 4, 20, 14, 0, tzinfo=BJ_TZ).isoformat(),
            "master_dtend": datetime(2026, 4, 20, 15, 0, tzinfo=BJ_TZ).isoformat(),
            "master_summary": "test",
            "master_is_all_day": 0,
            "exdates_json": "[]",
            "last_expanded_until": None,
        },
    }
    app, store, meeting_sync = _build_app(rows)

    import asyncio
    asyncio.run(app._run_expansion_tick(horizon_weeks=4))

    # update_expanded_until 被调用，cutoff 是 now+4w
    assert len(store.expanded_until_calls) == 1
    uid, until_iso = store.expanded_until_calls[0]
    assert uid == "to-extend"
    until_dt = datetime.fromisoformat(until_iso)
    now = datetime.now(timezone.utc)
    delta = until_dt - now
    # 大约 4 周 ± 1 分钟
    assert timedelta(weeks=4) - timedelta(minutes=1) < delta < timedelta(weeks=4) + timedelta(minutes=1)


def test_run_expansion_tick_uses_high_water_as_since():
    """已有 last_expanded_until 时, since=last_until, 不重复展开过去的实例."""
    last_until_dt = datetime.now(timezone.utc) + timedelta(weeks=2)
    rows = {
        "with-water": {
            "series_uid": "with-water",
            "rrule_str": "FREQ=WEEKLY",
            "master_dtstart": (datetime.now(timezone.utc) - timedelta(weeks=8)).isoformat(),
            "master_dtend": (datetime.now(timezone.utc) - timedelta(weeks=8) + timedelta(hours=1)).isoformat(),
            "master_summary": "test",
            "master_is_all_day": 0,
            "exdates_json": "[]",
            "last_expanded_until": last_until_dt.isoformat(),
        },
    }
    app, store, meeting_sync = _build_app(rows)

    import asyncio
    asyncio.run(app._run_expansion_tick(horizon_weeks=4))

    # since=last_until=now+2w, until=cutoff=now+4w，窗口是 [now+2w, now+4w]
    # weekly RRULE → 大约 2 个 occurrences
    call_count = meeting_sync.calendar_sync.sync_event.await_count
    assert 1 <= call_count <= 3


def test_run_expansion_tick_empty_when_no_series():
    """空 recurring_series → tick 静默返回."""
    app, store, meeting_sync = _build_app({})

    import asyncio
    asyncio.run(app._run_expansion_tick(horizon_weeks=4))

    assert meeting_sync.calendar_sync.sync_event.await_count == 0
    assert store.expanded_until_calls == []


def test_reconstruct_invite_skips_invalid_dtstart():
    """master_dtstart 非法 → 返回 None, 不抛."""
    app, _, _ = _build_app({})
    bad_row = {
        "series_uid": "bad-1",
        "rrule_str": "FREQ=WEEKLY",
        "master_dtstart": "not-an-iso-string",
        "master_dtend": "also-not-iso",
    }
    invite = app._reconstruct_invite_from_series_row(bad_row)
    assert invite is None


def test_reconstruct_invite_builds_minimal_invite():
    """有效 row → MeetingInvite 正确还原."""
    app, _, _ = _build_app({})
    row = {
        "series_uid": "ok-1",
        "rrule_str": "FREQ=WEEKLY;BYDAY=MO",
        "master_dtstart": "2026-04-20T14:00:00+08:00",
        "master_dtend": "2026-04-20T15:00:00+08:00",
        "master_summary": "对齐会",
        "master_organizer": "Alice",
        "master_organizer_email": "alice@example.com",
        "master_location": "Teams",
        "master_description": "join here",
        "master_tzid": "China Standard Time",
        "master_is_all_day": 0,
        "last_sequence": 3,
        "exdates_json": '["2026-04-27T14:00:00+08:00"]',
    }
    invite = app._reconstruct_invite_from_series_row(row)
    assert invite is not None
    assert invite.uid == "ok-1"
    assert invite.recurrence_rule == "FREQ=WEEKLY;BYDAY=MO"
    assert invite.summary == "对齐会"
    assert invite.organizer == "Alice"
    assert invite.tzid == "China Standard Time"
    assert invite.sequence == 3
    assert len(invite.exdates) == 1
