"""阶段 2.1 (P1-3) — 邮件 ↔ 日历 ical_uid 双向反查。

repository.get_master_by_uid (代表 master 行选取) +
service.get_email_calendar_link (方向 A) / get_event_source_email (方向 B)。
边界: uid 不存在 / 多封邮件同 uid / uid 无日历行。
"""
from __future__ import annotations

import sqlite3

import pytest

from src.calendar_sync.service import CalendarService
from src.mail.sync_store import SyncStore


def _seed_email(db_path: str, internal_id: int, *, message_id: str,
                subject: str = "Invite", date_received: str = "2026-07-01T09:00:00+08:00",
                sender: str = "boss@example.com") -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, message_id, subject, sender, "
            "sender_name, date_received, mailbox, sync_status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, 'Boss', ?, '收件箱', 'synced', 1, 1)",
            (internal_id, message_id, subject, sender, date_received),
        )
        conn.commit()
    finally:
        conn.close()


# ============================================================
# repository.get_master_by_uid
# ============================================================

def test_get_master_by_uid_prefers_master_and_caldav(repo, make_event):
    uid = "uid-multi"
    # occurrence 跳脱行 (recurrence_id 非空)
    repo.upsert_from_caldav_event(
        make_event(uid, recurrence_id="2026-05-29T09:00:00+00:00"), source="caldav"
    )
    # email_ics master 行
    repo.upsert_from_caldav_event(make_event(uid), source="email_ics")
    # caldav master 行 — 应当选中它
    repo.upsert_from_caldav_event(make_event(uid, summary="Master"), source="caldav")

    row = repo.get_master_by_uid(uid)
    assert row is not None
    assert row.recurrence_id is None
    assert row.source == "caldav"
    assert row.summary == "Master"


def test_get_master_by_uid_skips_deleted_and_missing(repo, make_event):
    repo.upsert_from_caldav_event(make_event("uid-del"), source="caldav")
    repo.soft_delete(ical_uid="uid-del", source="caldav")
    assert repo.get_master_by_uid("uid-del") is None
    assert repo.get_master_by_uid("uid-never-seen") is None


# ============================================================
# service.get_email_calendar_link (方向 A)
# ============================================================

def test_email_calendar_link_found_with_event(fresh_db, repo, make_event):
    store = SyncStore(fresh_db)
    _seed_email(fresh_db, 201, message_id="<a@x>")
    store.upsert_email_meeting(
        201, ical_uid="uid-a", method="REQUEST", sequence=1, is_recurring=True
    )
    repo.upsert_from_caldav_event(make_event("uid-a", summary="Standup"), source="caldav")

    svc = CalendarService(db_path=fresh_db)
    data = svc.get_email_calendar_link(internal_id=201)
    assert data["ical_uid"] == "uid-a"
    assert data["method"] == "REQUEST"
    assert data["is_recurring"] is True
    assert data["in_calendar"] is True
    assert data["event"]["summary"] == "Standup"
    assert data["event"]["source"] == "caldav"


def test_email_calendar_link_uid_without_calendar_row(fresh_db):
    store = SyncStore(fresh_db)
    _seed_email(fresh_db, 202, message_id="<b@x>")
    store.upsert_email_meeting(202, ical_uid="uid-no-cal", method="REQUEST")

    svc = CalendarService(db_path=fresh_db)
    data = svc.get_email_calendar_link(internal_id=202)
    assert data["in_calendar"] is False
    assert data["event"] is None


def test_email_calendar_link_not_found_raises(fresh_db):
    svc = CalendarService(db_path=fresh_db)
    with pytest.raises(ValueError, match="not found"):
        svc.get_email_calendar_link(internal_id=99999)


# ============================================================
# service.get_event_source_email (方向 B)
# ============================================================

def test_event_source_email_prefers_latest_request(fresh_db):
    store = SyncStore(fresh_db)
    uid = "uid-series"
    # 三封同 uid: 老 REQUEST / 新 CANCEL / 新 REQUEST — 应选最新 REQUEST
    _seed_email(fresh_db, 301, message_id="<old-req@x>", subject="Old request",
                date_received="2026-07-01T09:00:00+08:00")
    _seed_email(fresh_db, 302, message_id="<cancel@x>", subject="Cancelled",
                date_received="2026-07-03T09:00:00+08:00")
    _seed_email(fresh_db, 303, message_id="<new-req@x>", subject="New request",
                date_received="2026-07-02T09:00:00+08:00")
    store.upsert_email_meeting(301, ical_uid=uid, method="REQUEST")
    store.upsert_email_meeting(302, ical_uid=uid, method="CANCEL")
    store.upsert_email_meeting(303, ical_uid=uid, method="REQUEST")

    svc = CalendarService(db_path=fresh_db)
    data = svc.get_event_source_email(ical_uid=uid)
    assert data["internal_id"] == 303
    assert data["subject"] == "New request"
    assert data["method"] == "REQUEST"
    assert data["linked_email_count"] == 3


def test_event_source_email_falls_back_to_latest_any_method(fresh_db):
    store = SyncStore(fresh_db)
    uid = "uid-cancel-only"
    _seed_email(fresh_db, 311, message_id="<c1@x>",
                date_received="2026-07-01T09:00:00+08:00")
    _seed_email(fresh_db, 312, message_id="<c2@x>",
                date_received="2026-07-02T09:00:00+08:00")
    store.upsert_email_meeting(311, ical_uid=uid, method="CANCEL")
    store.upsert_email_meeting(312, ical_uid=uid, method=None)  # v34 回填行

    svc = CalendarService(db_path=fresh_db)
    data = svc.get_event_source_email(ical_uid=uid)
    assert data["internal_id"] == 312
    assert data["linked_email_count"] == 2


def test_event_source_email_not_found_raises(fresh_db):
    svc = CalendarService(db_path=fresh_db)
    with pytest.raises(ValueError, match="not found"):
        svc.get_event_source_email(ical_uid="uid-caldav-only")
