"""日历第三源 (task 08-24 L4 批次 1 · #4): 三列口径 / 建档判据 / 幂等 / 排除集。

🔴 fixture 走 `CalendarEventRepository.upsert_from_caldav_event` 而不是裸 INSERT ——
`attendees_json` 的两种真实形状 (`attendees_detail` 全字段 vs 只有 email 的兜底腿)
都是在那条写侧产生的, 自己拼 JSON 就测不到兜底腿。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from src.calendar_sync.caldav_reader import CalendarEvent
from src.calendar_sync.repository import CalendarEventRepository
from src.contacts.calendar_scan import run_calendar_scan
from src.mail.sync_store import SyncStore

UTC = timezone.utc
NOW = datetime(2026, 8, 24, 12, 0, tzinfo=UTC)
NOW_MS = int(NOW.timestamp() * 1000)


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return str(path)


def _event(
    uid: str, start: datetime, *,
    attendees_detail=None, attendees=None, organizer: str = "",
    minutes: int = 60, status: str = "CONFIRMED", rrule: str = "",
) -> CalendarEvent:
    return CalendarEvent(
        summary=uid,
        start=start,
        end=start + timedelta(minutes=minutes),
        ical_uid=uid,
        calendar_name="Work",
        organizer=organizer,
        attendees=list(attendees or []),
        attendees_detail=list(attendees_detail or []),
        status=status,
        rrule=rrule,
    )


def _seed(db, *events) -> CalendarEventRepository:
    repo = CalendarEventRepository(db, pool=False)
    for event in events:
        repo.upsert_from_caldav_event(event, source="caldav")
    return repo


def _contacts(db) -> dict:
    with sqlite3.connect(db) as conn:
        conn.row_factory = sqlite3.Row
        return {
            row["email_normalized"]: dict(row)
            for row in conn.execute(
                "SELECT ce.email_normalized, c.* FROM contact c "
                "JOIN contact_email ce ON ce.contact_id = c.id"
            )
        }


def _scan(db, **kwargs):
    return run_calendar_scan(db, now_ms=NOW_MS, **kwargs)


ALICE = {"email": "Alice@X.com", "name": "Alice", "response": "ACCEPTED", "role": "REQ-PARTICIPANT"}
BOB = {"email": "bob@y.com", "name": "Bob", "response": "NEEDS-ACTION", "role": "REQ-PARTICIPANT"}


def test_three_fields_split_past_future_and_in_progress(db):
    past = NOW - timedelta(days=3)
    future = NOW + timedelta(days=2)
    _seed(
        db,
        _event("past", past, attendees_detail=[ALICE]),
        _event("future", future, attendees_detail=[ALICE]),
        # 正在进行中: 既不算见过面, 也不是「下一场」。
        _event("running", NOW - timedelta(minutes=10), attendees_detail=[ALICE]),
    )
    stats = _scan(db)
    assert stats["participants"] == 1

    alice = _contacts(db)["alice@x.com"]  # 归一 = 小写
    assert alice["meeting_count"] == 1
    assert alice["last_met_at"] == _ms(past + timedelta(minutes=60))
    assert alice["next_meeting_at"] == _ms(future)


def test_recurring_series_counts_每次_occurrence(db):
    """周会按 occurrence 计数 (RRULE 展开), 不是一行事件算一次。"""
    start = NOW - timedelta(days=21, hours=2)
    _seed(db, _event("weekly", start, attendees_detail=[BOB], rrule="FREQ=WEEKLY;COUNT=6"))
    _scan(db)
    bob = _contacts(db)["bob@y.com"]
    # 6 次里 4 次已结束 (T-21d / T-14d / T-7d / 今天 T-2h), 剩两次在未来。
    assert bob["meeting_count"] == 4
    assert bob["last_met_at"] == _ms(start + timedelta(days=21, minutes=60))
    assert bob["next_meeting_at"] == _ms(start + timedelta(days=28))


def test_attendee_fallback_shape_and_organizer_are_counted(db):
    """兜底腿 (只有 email 的 dict) + ORGANIZER 都算参与者。"""
    _seed(
        db,
        _event(
            "fallback", NOW - timedelta(days=1),
            attendees=["carol@z.com"],  # → repository 兜底成 [{"email": …}]
            organizer="dave@w.com",
        ),
    )
    _scan(db)
    contacts = _contacts(db)
    assert contacts["carol@z.com"]["meeting_count"] == 1
    assert contacts["dave@w.com"]["meeting_count"] == 1
    # 兜底腿没有 CN, 建档时姓名留空 (不拿邮箱前缀编一个)
    assert contacts["carol@z.com"]["display_name"] is None


def test_no_email_attendee_creates_nothing(db):
    """无邮箱与会者 (只有 CN / 会议室占位串) 不产生 contact 行。"""
    _seed(
        db,
        _event(
            "no-email", NOW - timedelta(days=1),
            attendees_detail=[
                {"email": "", "name": "会议室 A"},
                {"name": "只有名字"},
                ALICE,
            ],
        ),
    )
    stats = _scan(db)
    assert stats["participants"] == 1
    assert set(_contacts(db)) == {"alice@x.com"}


def test_cancelled_and_soft_deleted_are_excluded(db):
    repo = _seed(
        db,
        _event("cancelled", NOW - timedelta(days=1), attendees_detail=[ALICE], status="CANCELLED"),
        _event("deleted", NOW - timedelta(days=2), attendees_detail=[BOB]),
    )
    repo.soft_delete(ical_uid="deleted", source="caldav")
    stats = _scan(db)
    assert stats["participants"] == 0
    assert _contacts(db) == {}


def test_events_outside_window_are_ignored(db):
    _seed(
        db,
        _event("too-old", NOW - timedelta(days=400), attendees_detail=[ALICE]),
        _event("too-far", NOW + timedelta(days=400), attendees_detail=[ALICE]),
    )
    assert _scan(db)["participants"] == 0
    assert _contacts(db) == {}


def test_existing_contact_keeps_identity_and_gets_only_three_fields(db):
    """已有联系人: 只写三列, 姓名/组织不被日历 CN 覆盖 (身份判据只有 email)。"""
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, organization, kind, mail_count, "
            "created_at, updated_at) VALUES (1,'爱丽丝','ACME','person',7,1,1)"
        )
        conn.execute(
            "INSERT INTO contact_email (contact_id, email_normalized, is_primary, created_at) "
            "VALUES (1,'alice@x.com',1,1)"
        )
        conn.commit()
    _seed(db, _event("m", NOW - timedelta(days=1), attendees_detail=[ALICE]))
    stats = _scan(db)
    assert stats["contacts_created"] == 0

    alice = _contacts(db)["alice@x.com"]
    assert (alice["display_name"], alice["organization"], alice["mail_count"]) == (
        "爱丽丝", "ACME", 7,
    )
    assert alice["meeting_count"] == 1


def test_two_anchors_of_one_person_do_not_double_count(db):
    """一人两邮箱同时在一场会里 = 见了一次, 不是两次。"""
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, kind, created_at, updated_at) "
            "VALUES (1,'Alice','person',1,1)"
        )
        for email in ("alice@x.com", "alice@old.com"):
            conn.execute(
                "INSERT INTO contact_email (contact_id, email_normalized, is_primary, "
                "created_at) VALUES (1,?,0,1)",
                (email,),
            )
        conn.commit()
    _seed(
        db,
        _event(
            "m", NOW - timedelta(days=1),
            attendees_detail=[ALICE, {"email": "alice@old.com", "name": "Alice"}],
        ),
    )
    _scan(db)
    with sqlite3.connect(db) as conn:
        assert conn.execute(
            "SELECT meeting_count FROM contact WHERE id=1"
        ).fetchone()[0] == 1


def test_rescan_is_idempotent_and_writes_nothing_second_time(db):
    _seed(db, _event("m", NOW - timedelta(days=1), attendees_detail=[ALICE, BOB]))
    first = _scan(db)
    assert (first["contacts_created"], first["contacts_updated"]) == (2, 2)

    before = _contacts(db)
    second = _scan(db)
    assert (
        second["contacts_created"], second["contacts_updated"], second["contacts_reset"]
    ) == (0, 0, 0)
    assert _contacts(db) == before  # updated_at 也不动 = 无写


def test_cancelling_a_meeting_resets_the_three_fields(db):
    """全量重算的意义: 会没了三列要退回默认值, 不能只增不减。"""
    repo = _seed(db, _event("m", NOW - timedelta(days=1), attendees_detail=[ALICE]))
    _scan(db)
    assert _contacts(db)["alice@x.com"]["meeting_count"] == 1

    repo.soft_delete(ical_uid="m", source="caldav")
    stats = _scan(db)
    assert stats["contacts_reset"] == 1
    alice = _contacts(db)["alice@x.com"]
    assert alice["meeting_count"] == 0
    assert alice["last_met_at"] is None and alice["next_meeting_at"] is None


def test_robot_address_keeps_kind_heuristic(db):
    _seed(
        db,
        _event(
            "m", NOW - timedelta(days=1),
            attendees_detail=[{"email": "noreply@x.com", "name": "Robot"}],
        ),
    )
    _scan(db)
    assert _contacts(db)["noreply@x.com"]["kind"] == "robot"
