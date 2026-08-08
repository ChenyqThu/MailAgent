"""CalendarReconciler — CalDAV diff → SQLite upsert/soft-delete 测试."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from src.calendar_sync import CalendarReconciler


def _utc(year, month, day, hour=0, minute=0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


WINDOW_START = _utc(2026, 5, 1)
WINDOW_END = _utc(2026, 7, 1)


# ============================================================
# Full-window reconcile
# ============================================================

class TestFullWindow:
    def test_upsert_all_events(self, repo, make_event):
        recon = CalendarReconciler(repo)
        events = [
            make_event(uid="a", calendar_name="Personal", start=_utc(2026, 5, 10, 9)),
            make_event(uid="b", calendar_name="Personal", start=_utc(2026, 5, 15, 14)),
        ]
        stats = recon.reconcile_full_window(
            events, calendar_name="Personal",
            window_start=WINDOW_START, window_end=WINDOW_END,
        )
        assert stats.upserted == 2
        assert stats.soft_deleted == 0
        rows = repo.list_event_rows(source="caldav")
        assert {r.ical_uid for r in rows} == {"a", "b"}

    def test_soft_deletes_missing(self, repo, make_event):
        """CalDAV side 不再有 'a' → reconciler 应 soft-delete."""
        recon = CalendarReconciler(repo)
        # 先 seed 两个
        recon.reconcile_full_window(
            [
                make_event(uid="a", calendar_name="Personal", start=_utc(2026, 5, 10, 9)),
                make_event(uid="b", calendar_name="Personal", start=_utc(2026, 5, 15, 14)),
            ],
            calendar_name="Personal",
            window_start=WINDOW_START, window_end=WINDOW_END,
        )
        # 二次 reconcile, 只有 b
        stats = recon.reconcile_full_window(
            [make_event(uid="b", calendar_name="Personal", start=_utc(2026, 5, 15, 14))],
            calendar_name="Personal",
            window_start=WINDOW_START, window_end=WINDOW_END,
        )
        assert stats.upserted == 1
        assert stats.soft_deleted == 1
        # a 被 soft-delete, b 还在
        active = repo.list_event_rows(source="caldav")
        assert [r.ical_uid for r in active] == ["b"]
        deleted = repo.list_event_rows(source="caldav", include_deleted=True)
        assert {r.ical_uid for r in deleted} == {"a", "b"}

    def test_does_not_touch_other_sources(self, repo, make_event):
        """reconciler 只动 source='caldav', email_ics 不受影响."""
        repo.upsert_from_caldav_event(
            make_event(uid="email-only", calendar_name="Personal"),
            source="email_ics",
        )

        recon = CalendarReconciler(repo)
        stats = recon.reconcile_full_window(
            [], calendar_name="Personal",  # CalDAV 端空
            window_start=WINDOW_START, window_end=WINDOW_END,
        )
        # email_ics 不被 soft-delete
        assert stats.soft_deleted == 0
        active = repo.list_event_rows(source="email_ics")
        assert len(active) == 1

    def test_does_not_soft_delete_outside_window(self, repo, make_event):
        """窗口外的 row 不该被清 — 历史 / 未来 RRULE master 保护."""
        recon = CalendarReconciler(repo)
        # Seed 一个 2025 年的 event (在 2026 窗口外)
        repo.upsert_from_caldav_event(
            make_event(
                uid="historical", calendar_name="Personal",
                start=_utc(2025, 1, 1, 9),
            ),
            source="caldav",
        )
        # Reconcile 2026 窗口空 events
        stats = recon.reconcile_full_window(
            [], calendar_name="Personal",
            window_start=WINDOW_START, window_end=WINDOW_END,
        )
        assert stats.soft_deleted == 0
        active = repo.list_event_rows(source="caldav")
        assert [r.ical_uid for r in active] == ["historical"]

    def test_skip_events_without_uid(self, repo, make_event):
        recon = CalendarReconciler(repo)
        bad = make_event(uid="")  # 无 UID
        good = make_event(uid="good")
        stats = recon.reconcile_full_window(
            [bad, good], calendar_name="Personal",
            window_start=WINDOW_START, window_end=WINDOW_END,
        )
        assert stats.upserted == 1
        assert stats.skipped_no_uid == 1


# ============================================================
# Incremental reconcile
# ============================================================

class TestIncremental:
    def test_apply_changed_events(self, repo, make_event):
        recon = CalendarReconciler(repo)
        stats = recon.reconcile_incremental(
            changed_events=[
                make_event(uid="a", calendar_name="Personal", summary="V1"),
            ],
            deleted_uids=[],
            calendar_name="Personal",
        )
        assert stats.upserted == 1
        rows = repo.list_event_rows(source="caldav")
        assert rows[0].summary == "V1"

    def test_apply_deleted_uids(self, repo, make_event):
        # Seed
        repo.upsert_from_caldav_event(make_event(uid="a"), source="caldav")
        repo.upsert_from_caldav_event(make_event(uid="b"), source="caldav")

        recon = CalendarReconciler(repo)
        stats = recon.reconcile_incremental(
            changed_events=[],
            deleted_uids=["a"],
            calendar_name="Personal",
        )
        assert stats.soft_deleted == 1
        active = repo.list_event_rows(source="caldav")
        assert [r.ical_uid for r in active] == ["b"]

    def test_incremental_ignores_other_sources(self, repo, make_event):
        repo.upsert_from_caldav_event(
            make_event(uid="email-shared"), source="email_ics"
        )
        recon = CalendarReconciler(repo)
        stats = recon.reconcile_incremental(
            changed_events=[],
            deleted_uids=["email-shared"],
            calendar_name="Personal",
        )
        # caldav source 没匹配 → 0
        assert stats.soft_deleted == 0
        # email_ics row 还在
        assert len(repo.list_event_rows(source="email_ics")) == 1

    def test_mixed_changed_and_deleted(self, repo, make_event):
        repo.upsert_from_caldav_event(make_event(uid="old"), source="caldav")
        recon = CalendarReconciler(repo)
        stats = recon.reconcile_incremental(
            changed_events=[make_event(uid="new")],
            deleted_uids=["old"],
            calendar_name="Personal",
        )
        assert stats.upserted == 1
        assert stats.soft_deleted == 1


class TestBusinessChangeProjection:
    @pytest.mark.parametrize(
        ("field", "value", "expected"),
        [
            ("summary", "New title", "summary"),
            ("organizer", "new@example.com", "organizer"),
            ("attendees", ["new@example.com"], "attendees"),
            ("location", "Room 2", "location"),
            ("description", "New agenda", "description"),
            ("status", "CANCELLED", "status"),
        ],
    )
    def test_business_field_changes_are_reported(self, repo, make_event, field, value, expected):
        repo.upsert_sync_state("Personal", ctag="seed")
        repo.upsert_from_caldav_event(make_event(uid="tracked"), source="caldav")
        kwargs = {field: value}
        stats = CalendarReconciler(repo).reconcile_incremental(
            [make_event(uid="tracked", **kwargs)], [], calendar_name="Personal", track_changes=True
        )
        assert len(stats.changed) == 1
        assert expected in stats.changed[0].changed_fields

    def test_url_change_is_reported(self, repo, make_event):
        repo.upsert_sync_state("Personal", ctag="seed")
        repo.upsert_from_caldav_event(make_event(uid="tracked", url="https://old"), source="caldav")
        stats = CalendarReconciler(repo).reconcile_incremental(
            [make_event(uid="tracked", url="https://new")], [], calendar_name="Personal", track_changes=True
        )
        assert stats.changed[0].changed_fields == ["url"]

    def test_time_only_and_identical_upsert_are_not_reported(self, repo, make_event):
        repo.upsert_sync_state("Personal", ctag="seed")
        original = make_event(uid="tracked")
        repo.upsert_from_caldav_event(original, source="caldav")
        moved = make_event(uid="tracked", start=original.start + timedelta(hours=2))
        recon = CalendarReconciler(repo)
        assert recon.reconcile_incremental(
            [moved], [], calendar_name="Personal", track_changes=True
        ).changed == []
        assert recon.reconcile_incremental(
            [moved], [], calendar_name="Personal", track_changes=True
        ).changed == []

    def test_created_deleted_and_first_sync_guard(self, repo, make_event):
        recon = CalendarReconciler(repo)
        first = recon.reconcile_full_window(
            [make_event(uid="first")], calendar_name="Personal",
            window_start=WINDOW_START, window_end=WINDOW_END, track_changes=True,
        )
        assert first.changed == []
        repo.upsert_sync_state("Personal", ctag="seed")
        created = recon.reconcile_incremental(
            [make_event(uid="created")], [], calendar_name="Personal", track_changes=True
        )
        assert created.changed[0].change_kind == "created"
        deleted = recon.reconcile_incremental(
            [], ["created"], calendar_name="Personal", track_changes=True
        )
        assert deleted.changed[0].change_kind == "deleted"

    def test_track_changes_false_is_additive_noop(self, repo, make_event):
        stats = CalendarReconciler(repo).reconcile_incremental(
            [make_event(uid="plain")], [], calendar_name="Personal", track_changes=False
        )
        assert stats.upserted == 1
        assert stats.changed == []
