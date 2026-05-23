"""CalendarEventRepository CRUD + 时间窗口查询测试."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest


# ============================================================
# Upsert
# ============================================================

class TestUpsert:
    def test_upsert_basic(self, repo, make_event):
        ev = make_event(uid="uid-1", summary="Initial")
        eid = repo.upsert_from_caldav_event(ev, source="caldav")
        assert eid > 0
        row = repo.get_by_id(eid)
        assert row.ical_uid == "uid-1"
        assert row.summary == "Initial"
        assert row.source == "caldav"
        assert row.deleted_at is None

    def test_upsert_idempotent_via_on_conflict(self, repo, make_event):
        """重复 upsert 同 (ical_uid, recurrence_id=NULL, source) 不增行, 仅更新字段."""
        ev = make_event(uid="uid-1", summary="V1")
        eid1 = repo.upsert_from_caldav_event(ev, source="caldav")

        ev2 = make_event(uid="uid-1", summary="V2", sequence=2)
        eid2 = repo.upsert_from_caldav_event(ev2, source="caldav")

        assert eid1 == eid2, "same key should return same id"
        rows = repo.list_event_rows(source="caldav")
        assert len(rows) == 1
        assert rows[0].summary == "V2"
        assert rows[0].sequence == 2

    def test_upsert_cross_source_coexist(self, repo, make_event):
        """同 ical_uid 在 caldav + email_ics 各存一行 (灰度共存)."""
        ev = make_event(uid="uid-1")
        repo.upsert_from_caldav_event(ev, source="caldav")
        repo.upsert_from_caldav_event(ev, source="email_ics")
        rows_all = repo.list_event_rows(source=None)
        assert len(rows_all) == 2
        sources = sorted(r.source for r in rows_all)
        assert sources == ["caldav", "email_ics"]

    def test_upsert_occurrence_distinct_from_master(self, repo, make_event):
        """主事件 + occurrence (非 NULL recurrence_id) 是两行."""
        master = make_event(uid="uid-1", rrule="FREQ=WEEKLY;COUNT=10")
        occ = make_event(
            uid="uid-1",
            recurrence_id="2026-05-29T09:00:00+00:00",
            summary="Rescheduled",
        )
        repo.upsert_from_caldav_event(master, source="caldav")
        repo.upsert_from_caldav_event(occ, source="caldav")
        rows = repo.list_event_rows(source="caldav")
        assert len(rows) == 2
        # 主 + 跳脱 各一
        masters = [r for r in rows if r.recurrence_id is None]
        occs = [r for r in rows if r.recurrence_id is not None]
        assert len(masters) == 1 and len(occs) == 1

    def test_upsert_invalid_source_raises(self, repo, make_event):
        ev = make_event(uid="uid-1")
        with pytest.raises(ValueError, match="source="):
            repo.upsert_from_caldav_event(ev, source="bogus")

    def test_upsert_no_uid_raises(self, repo, make_event):
        ev = make_event(uid="")
        with pytest.raises(ValueError, match="ical_uid"):
            repo.upsert_from_caldav_event(ev, source="caldav")

    def test_upsert_revives_soft_deleted(self, repo, make_event):
        """soft-delete 后再 upsert 同 key 会清掉 deleted_at."""
        ev = make_event(uid="uid-1")
        repo.upsert_from_caldav_event(ev, source="caldav")
        repo.soft_delete(ical_uid="uid-1", source="caldav")

        # 软删除后默认不可见
        assert len(repo.list_event_rows(source="caldav")) == 0

        # 再 upsert 同 key
        repo.upsert_from_caldav_event(ev, source="caldav")
        rows = repo.list_event_rows(source="caldav")
        assert len(rows) == 1
        assert rows[0].deleted_at is None


# ============================================================
# Soft delete
# ============================================================

class TestSoftDelete:
    def test_soft_delete_master_and_occurrences(self, repo, make_event):
        """soft_delete(recurrence_id=None) 删主+所有跳脱."""
        master = make_event(uid="uid-1", rrule="FREQ=WEEKLY")
        occ1 = make_event(uid="uid-1", recurrence_id="2026-05-29T09:00:00+00:00")
        occ2 = make_event(uid="uid-1", recurrence_id="2026-06-05T09:00:00+00:00")
        repo.upsert_from_caldav_event(master, source="caldav")
        repo.upsert_from_caldav_event(occ1, source="caldav")
        repo.upsert_from_caldav_event(occ2, source="caldav")

        affected = repo.soft_delete(ical_uid="uid-1", source="caldav")
        assert affected == 3
        assert len(repo.list_event_rows(source="caldav")) == 0
        assert len(repo.list_event_rows(source="caldav", include_deleted=True)) == 3

    def test_soft_delete_single_occurrence(self, repo, make_event):
        """recurrence_id 指定时只删那一行."""
        master = make_event(uid="uid-1", rrule="FREQ=WEEKLY")
        occ = make_event(uid="uid-1", recurrence_id="2026-05-29T09:00:00+00:00")
        repo.upsert_from_caldav_event(master, source="caldav")
        repo.upsert_from_caldav_event(occ, source="caldav")

        affected = repo.soft_delete(
            ical_uid="uid-1", source="caldav",
            recurrence_id="2026-05-29T09:00:00+00:00",
        )
        assert affected == 1
        rows = repo.list_event_rows(source="caldav")
        assert len(rows) == 1  # 主还在
        assert rows[0].recurrence_id is None

    def test_soft_delete_idempotent(self, repo, make_event):
        """对已 soft-delete 的行再调 soft_delete 返 0 (不重设)."""
        ev = make_event(uid="uid-1")
        repo.upsert_from_caldav_event(ev, source="caldav")
        first = repo.soft_delete(ical_uid="uid-1", source="caldav")
        second = repo.soft_delete(ical_uid="uid-1", source="caldav")
        assert first == 1
        assert second == 0


# ============================================================
# Notion link
# ============================================================

class TestNotionLink:
    def test_update_notion_link(self, repo, make_event):
        ev = make_event(uid="uid-1")
        eid = repo.upsert_from_caldav_event(ev, source="caldav")
        repo.update_notion_link(eid, "notion-page-abc123")
        row = repo.get_by_id(eid)
        assert row.notion_page_id == "notion-page-abc123"

    def test_clear_notion_link(self, repo, make_event):
        ev = make_event(uid="uid-1")
        eid = repo.upsert_from_caldav_event(ev, source="caldav")
        repo.update_notion_link(eid, "page-1")
        repo.update_notion_link(eid, None)
        assert repo.get_by_id(eid).notion_page_id is None


# ============================================================
# list_event_rows / get_by_ical_uid
# ============================================================

class TestQuery:
    def test_list_filters_by_source(self, repo, make_event):
        repo.upsert_from_caldav_event(make_event(uid="a"), source="caldav")
        repo.upsert_from_caldav_event(make_event(uid="b"), source="email_ics")
        repo.upsert_from_caldav_event(make_event(uid="c"), source="caldav")

        caldavs = repo.list_event_rows(source="caldav")
        email_icss = repo.list_event_rows(source="email_ics")
        all_rows = repo.list_event_rows(source=None)
        assert len(caldavs) == 2
        assert len(email_icss) == 1
        assert len(all_rows) == 3

    def test_list_filters_by_calendar(self, repo, make_event):
        repo.upsert_from_caldav_event(
            make_event(uid="a", calendar_name="Work"), source="caldav"
        )
        repo.upsert_from_caldav_event(
            make_event(uid="b", calendar_name="Personal"), source="caldav"
        )
        work = repo.list_event_rows(source="caldav", calendar_name="Work")
        assert len(work) == 1
        assert work[0].calendar_name == "Work"

    def test_list_sorted_by_dtstart(self, repo, make_event):
        base = datetime(2026, 5, 1, tzinfo=timezone.utc)
        repo.upsert_from_caldav_event(
            make_event(uid="c", start=base + timedelta(days=2)), source="caldav"
        )
        repo.upsert_from_caldav_event(
            make_event(uid="a", start=base), source="caldav"
        )
        repo.upsert_from_caldav_event(
            make_event(uid="b", start=base + timedelta(days=1)), source="caldav"
        )
        rows = repo.list_event_rows(source="caldav")
        uids = [r.ical_uid for r in rows]
        assert uids == ["a", "b", "c"]

    def test_get_by_ical_uid_master_vs_occurrence(self, repo, make_event):
        repo.upsert_from_caldav_event(
            make_event(uid="uid-1"), source="caldav"
        )
        repo.upsert_from_caldav_event(
            make_event(uid="uid-1", recurrence_id="2026-05-29T09:00:00+00:00"),
            source="caldav",
        )

        master = repo.get_by_ical_uid("uid-1", source="caldav")
        assert master.recurrence_id is None

        occ = repo.get_by_ical_uid(
            "uid-1", source="caldav",
            recurrence_id="2026-05-29T09:00:00+00:00",
        )
        assert occ.recurrence_id == "2026-05-29T09:00:00+00:00"

    def test_get_missing_returns_none(self, repo):
        assert repo.get_by_id(99999) is None
        assert repo.get_by_ical_uid("nope") is None


# ============================================================
# Time-window occurrence expansion
# ============================================================

class TestOccurrenceWindow:
    def test_single_event_in_window(self, repo, make_event):
        start = datetime(2026, 5, 22, 9, 0, tzinfo=timezone.utc)
        repo.upsert_from_caldav_event(make_event(uid="single", start=start), source="caldav")
        occs = repo.list_event_occurrences(
            start_utc=datetime(2026, 5, 1, tzinfo=timezone.utc),
            end_utc=datetime(2026, 6, 1, tzinfo=timezone.utc),
            source="caldav",
        )
        assert len(occs) == 1
        assert occs[0].is_recurrence_instance is False
        assert occs[0].occurrence_start_utc == start

    def test_single_event_outside_window(self, repo, make_event):
        # 事件在 2025, 窗口在 2026 → 不出现
        repo.upsert_from_caldav_event(
            make_event(
                uid="old",
                start=datetime(2025, 1, 1, tzinfo=timezone.utc),
            ),
            source="caldav",
        )
        occs = repo.list_event_occurrences(
            start_utc=datetime(2026, 5, 1, tzinfo=timezone.utc),
            end_utc=datetime(2026, 6, 1, tzinfo=timezone.utc),
            source="caldav",
        )
        assert len(occs) == 0

    def test_rrule_weekly_expanded(self, repo, make_event):
        start = datetime(2026, 5, 22, 9, 0, tzinfo=timezone.utc)
        repo.upsert_from_caldav_event(
            make_event(uid="recur", start=start, rrule="FREQ=WEEKLY;COUNT=4"),
            source="caldav",
        )
        occs = repo.list_event_occurrences(
            start_utc=datetime(2026, 5, 1, tzinfo=timezone.utc),
            end_utc=datetime(2026, 7, 1, tzinfo=timezone.utc),
            source="caldav",
        )
        assert len(occs) == 4
        assert all(o.is_recurrence_instance for o in occs)
        # 升序
        for i in range(1, len(occs)):
            assert occs[i].occurrence_start_utc > occs[i - 1].occurrence_start_utc

    def test_expand_recurrences_false_returns_master_only(self, repo, make_event):
        start = datetime(2026, 5, 22, 9, 0, tzinfo=timezone.utc)
        repo.upsert_from_caldav_event(
            make_event(uid="recur", start=start, rrule="FREQ=WEEKLY;COUNT=4"),
            source="caldav",
        )
        occs = repo.list_event_occurrences(
            start_utc=datetime(2026, 5, 1, tzinfo=timezone.utc),
            end_utc=datetime(2026, 7, 1, tzinfo=timezone.utc),
            source="caldav",
            expand_recurrences=False,
        )
        assert len(occs) == 1
        assert occs[0].is_recurrence_instance is False

    def test_soft_deleted_not_in_window(self, repo, make_event):
        ev = make_event(uid="uid-1")
        repo.upsert_from_caldav_event(ev, source="caldav")
        repo.soft_delete(ical_uid="uid-1", source="caldav")
        occs = repo.list_event_occurrences(
            start_utc=datetime(2026, 5, 1, tzinfo=timezone.utc),
            end_utc=datetime(2026, 6, 1, tzinfo=timezone.utc),
            source="caldav",
        )
        assert len(occs) == 0


# ============================================================
# Sync state
# ============================================================

class TestSyncState:
    def test_upsert_and_read(self, repo):
        repo.upsert_sync_state("cal-1", ctag="ctag-v1", full_sync=True)
        state = repo.get_sync_state("cal-1")
        assert state is not None
        assert state.ctag == "ctag-v1"
        assert state.last_full_sync_at is not None
        assert state.last_incremental_sync_at is not None

    def test_partial_update_preserves_ctag(self, repo):
        repo.upsert_sync_state("cal-1", ctag="ctag-v1", full_sync=True)
        # 只更新 sync_token, ctag 应保留
        repo.upsert_sync_state("cal-1", sync_token="token-1")
        state = repo.get_sync_state("cal-1")
        assert state.ctag == "ctag-v1"
        assert state.sync_token == "token-1"

    def test_error_field(self, repo):
        repo.upsert_sync_state("cal-1", last_error="probe timeout")
        state = repo.get_sync_state("cal-1")
        assert state.last_error == "probe timeout"
        # 下次成功清错
        repo.upsert_sync_state("cal-1", ctag="ctag-v1", last_error=None)
        state2 = repo.get_sync_state("cal-1")
        assert state2.last_error is None

    def test_list_sync_states_empty(self, repo):
        assert repo.list_sync_states() == []

    def test_list_sync_states(self, repo):
        repo.upsert_sync_state("b", ctag="b")
        repo.upsert_sync_state("a", ctag="a")
        states = repo.list_sync_states()
        assert [s.calendar_name for s in states] == ["a", "b"]


# ============================================================
# list_calendar_names
# ============================================================

class TestListCalendarNames:
    def test_distinct(self, repo, make_event):
        repo.upsert_from_caldav_event(make_event(uid="a", calendar_name="Work"), source="caldav")
        repo.upsert_from_caldav_event(make_event(uid="b", calendar_name="Work"), source="caldav")
        repo.upsert_from_caldav_event(make_event(uid="c", calendar_name="Personal"), source="caldav")
        names = repo.list_calendar_names()
        assert names == ["Personal", "Work"]

    def test_skips_empty(self, repo, make_event):
        repo.upsert_from_caldav_event(make_event(uid="a", calendar_name=""), source="caldav")
        repo.upsert_from_caldav_event(make_event(uid="b", calendar_name="Real"), source="caldav")
        assert repo.list_calendar_names() == ["Real"]
