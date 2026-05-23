"""Phase 2.2/2.3 CalDAV writer 单测.

覆盖:
- ``generate_uid`` 唯一 + 后缀 @mailagent.local
- ``build_vevent``:
  · 包含 RFC 5545 必填字段 (UID/DTSTAMP/DTSTART/DTEND/SUMMARY/ORGANIZER/SEQUENCE/STATUS)
  · location / description / attendees 可选字段
  · attendees CN parameter + RSVP=TRUE
  · validation: 空 uid / 空 summary / 空 organizer / 非法 status
- ``_to_utc`` datetime tz-aware / naive / date 三态
- ``CalDAVWriter`` ops with mocked caldav lib:
  · create_event: pick_calendar + save_event 调用 + 返 ical_uid
  · update_event: event_by_uid + 改字段 + event.save() + sequence bump
  · update_event UID not found → ValueError
  · delete_event: event.delete() 调用
  · delete_event UID not found → ValueError
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from src.calendar_sync.caldav_writer import (
    CalDAVWriter,
    _to_utc,
    build_vevent,
    generate_uid,
)


# ---------------------------------------------------------------------------
# generate_uid
# ---------------------------------------------------------------------------

def test_generate_uid_unique():
    uids = [generate_uid() for _ in range(20)]
    assert len(set(uids)) == 20


def test_generate_uid_has_mailagent_suffix():
    uid = generate_uid()
    assert uid.startswith("mailagent-")
    assert uid.endswith("@mailagent.local")


def test_generate_uid_uuid_hex_in_middle():
    uid = generate_uid()
    middle = uid.removeprefix("mailagent-").removesuffix("@mailagent.local")
    assert len(middle) == 32  # uuid4 hex 是 32 字符
    int(middle, 16)  # 验证是 hex (不抛 ValueError)


# ---------------------------------------------------------------------------
# build_vevent — validation
# ---------------------------------------------------------------------------

def _base_args() -> dict:
    return dict(
        ical_uid="uid-test-123",
        summary="Team Sync",
        dtstart_utc=datetime(2026, 5, 30, 14, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 5, 30, 15, 0, tzinfo=timezone.utc),
        organizer_email="bob@example.com",
        now_utc=datetime(2026, 5, 30, 13, 59, 30, tzinfo=timezone.utc),
    )


def test_build_vevent_empty_uid_raises():
    args = _base_args()
    args["ical_uid"] = "  "
    with pytest.raises(ValueError, match="ical_uid is required"):
        build_vevent(**args)


def test_build_vevent_empty_summary_raises():
    args = _base_args()
    args["summary"] = ""
    with pytest.raises(ValueError, match="summary is required"):
        build_vevent(**args)


def test_build_vevent_empty_organizer_raises():
    args = _base_args()
    args["organizer_email"] = ""
    with pytest.raises(ValueError, match="organizer_email is required"):
        build_vevent(**args)


def test_build_vevent_invalid_status_raises():
    args = _base_args()
    args["status"] = "FOOBAR"
    with pytest.raises(ValueError, match="status must be"):
        build_vevent(**args)


# ---------------------------------------------------------------------------
# build_vevent — RFC 5545 必填字段
# ---------------------------------------------------------------------------

def test_build_vevent_required_fields():
    body = build_vevent(**_base_args())
    assert "BEGIN:VCALENDAR\r\n" in body
    assert "VERSION:2.0\r\n" in body
    assert "BEGIN:VEVENT\r\n" in body
    assert "END:VEVENT\r\n" in body
    assert "END:VCALENDAR\r\n" in body
    assert "UID:uid-test-123\r\n" in body
    assert "DTSTAMP:20260530T135930Z\r\n" in body
    assert "DTSTART:20260530T140000Z\r\n" in body
    assert "DTEND:20260530T150000Z\r\n" in body
    assert "SEQUENCE:0\r\n" in body
    assert "SUMMARY:Team Sync\r\n" in body
    assert "ORGANIZER:mailto:bob@example.com\r\n" in body
    assert "STATUS:CONFIRMED\r\n" in body


def test_build_vevent_no_method_for_caldav_put():
    """CalDAV resource PUT 不是 iTIP — 不应该有 METHOD 行 (跟 iTIP REPLY 区分)."""
    body = build_vevent(**_base_args())
    assert "METHOD:" not in body


def test_build_vevent_location_present_when_set():
    args = _base_args()
    args["location"] = "Conference Room A"
    body = build_vevent(**args)
    assert "LOCATION:Conference Room A\r\n" in body


def test_build_vevent_description_escaped():
    args = _base_args()
    args["description"] = "Q1; review,\nfollow-up"
    body = build_vevent(**args)
    assert "DESCRIPTION:Q1\\; review\\,\\nfollow-up\r\n" in body


def test_build_vevent_attendees_with_cn():
    args = _base_args()
    args["attendees"] = [
        {"email": "a@x.com", "name": "Alice"},
        {"email": "b@x.com"},  # 无 name
    ]
    body = build_vevent(**args)
    assert (
        'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="Alice":mailto:a@x.com\r\n' in body
    )
    assert "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:b@x.com\r\n" in body


def test_build_vevent_attendees_skips_no_email():
    args = _base_args()
    args["attendees"] = [{"name": "no email"}, {"email": "", "name": "empty"}]
    body = build_vevent(**args)
    assert "ATTENDEE" not in body


def test_build_vevent_sequence_pass_through():
    args = _base_args()
    args["sequence"] = 5
    body = build_vevent(**args)
    assert "SEQUENCE:5\r\n" in body


def test_build_vevent_status_tentative():
    args = _base_args()
    args["status"] = "TENTATIVE"
    body = build_vevent(**args)
    assert "STATUS:TENTATIVE\r\n" in body


def test_build_vevent_crlf_line_endings():
    body = build_vevent(**_base_args())
    # split by CRLF works (no naked \n)
    lines = body.split("\r\n")
    assert lines[0] == "BEGIN:VCALENDAR"


# ---------------------------------------------------------------------------
# _to_utc
# ---------------------------------------------------------------------------

def test_to_utc_aware_datetime_passthrough():
    dt = datetime(2026, 5, 30, 14, 0, tzinfo=timezone.utc)
    assert _to_utc(dt) == dt


def test_to_utc_naive_datetime_treated_as_utc():
    dt = datetime(2026, 5, 30, 14, 0)
    out = _to_utc(dt)
    assert out.tzinfo == timezone.utc
    assert out.replace(tzinfo=None) == dt


def test_to_utc_date_promoted_to_midnight_utc():
    d = date(2026, 5, 30)
    out = _to_utc(d)
    assert out == datetime(2026, 5, 30, 0, 0, tzinfo=timezone.utc)


def test_to_utc_unsupported_type_raises():
    with pytest.raises(TypeError):
        _to_utc("2026-05-30")


# ---------------------------------------------------------------------------
# CalDAVWriter — mock caldav lib
# ---------------------------------------------------------------------------

def _mock_cfg():
    return SimpleNamespace(
        user_email="bob@example.com",
        davmail_imap_host="127.0.0.1",
        davmail_caldav_port=1080,
        davmail_cipher_key="test-key",
        davmail_poc_mode=False,
    )


def _writer_with_mock_principal(principal_mock):
    """构造 CalDAVWriter 实例并预设 _principal (绕过 _connect)."""
    cfg = _mock_cfg()
    w = CalDAVWriter(cfg)
    w._principal = principal_mock
    return w


def test_writer_create_event_calls_save_event():
    cal = MagicMock()
    cal.name = "日历"
    cal.save_event = MagicMock()
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    result = w.create_event(
        summary="Sync",
        dtstart_utc=datetime(2026, 5, 30, 14, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 5, 30, 15, tzinfo=timezone.utc),
    )

    assert result["action"] == "created"
    assert result["ical_uid"].startswith("mailagent-")
    assert result["calendar_name"] == "日历"
    cal.save_event.assert_called_once()
    body = cal.save_event.call_args.args[0]
    assert "SUMMARY:Sync" in body
    assert "DTSTART:20260530T140000Z" in body


def test_writer_create_event_picks_named_calendar():
    cal1 = MagicMock()
    cal1.name = "Personal"
    cal2 = MagicMock()
    cal2.name = "Work"
    cal2.save_event = MagicMock()
    principal = MagicMock()
    principal.calendars.return_value = [cal1, cal2]
    w = _writer_with_mock_principal(principal)

    result = w.create_event(
        summary="x",
        dtstart_utc=datetime(2026, 5, 30, 14, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 5, 30, 15, tzinfo=timezone.utc),
        calendar_name="Work",
    )
    assert result["calendar_name"] == "Work"
    cal2.save_event.assert_called_once()
    cal1.save_event.assert_not_called()


def test_writer_create_event_named_calendar_not_found_raises():
    cal = MagicMock()
    cal.name = "Personal"
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    with pytest.raises(ValueError, match="calendar not found"):
        w.create_event(
            summary="x",
            dtstart_utc=datetime(2026, 5, 30, 14, tzinfo=timezone.utc),
            dtend_utc=datetime(2026, 5, 30, 15, tzinfo=timezone.utc),
            calendar_name="Nonexistent",
        )


def test_writer_create_event_no_calendars_raises():
    principal = MagicMock()
    principal.calendars.return_value = []
    w = _writer_with_mock_principal(principal)

    with pytest.raises(RuntimeError, match="No calendars found"):
        w.create_event(
            summary="x",
            dtstart_utc=datetime(2026, 5, 30, 14, tzinfo=timezone.utc),
            dtend_utc=datetime(2026, 5, 30, 15, tzinfo=timezone.utc),
        )


def _mock_event_with_vevent(
    *,
    summary="Original",
    dtstart=None,
    dtend=None,
    location=None,
    description=None,
    sequence=0,
    status="CONFIRMED",
):
    """构造 mock event with .vobject_instance.vevent.X.value attributes."""
    if dtstart is None:
        dtstart = datetime(2026, 5, 30, 14, tzinfo=timezone.utc)
    if dtend is None:
        dtend = datetime(2026, 5, 30, 15, tzinfo=timezone.utc)
    vevent = SimpleNamespace(
        summary=SimpleNamespace(value=summary),
        dtstart=SimpleNamespace(value=dtstart),
        dtend=SimpleNamespace(value=dtend),
        location=SimpleNamespace(value=location) if location else None,
        description=SimpleNamespace(value=description) if description else None,
        sequence=SimpleNamespace(value=sequence),
        status=SimpleNamespace(value=status),
    )
    evt = MagicMock()
    evt.vobject_instance.vevent = vevent
    evt.save = MagicMock()
    evt.delete = MagicMock()
    # data assign (writer 改 evt.data = new_body)
    evt.data = ""
    return evt


def test_writer_update_event_uid_not_found_raises():
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.side_effect = Exception("not found")
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    with pytest.raises(ValueError, match="event not found"):
        w.update_event(ical_uid="ghost", summary="x")


def test_writer_update_event_partial_keeps_original_values():
    """update 只传 summary → start/end/location 应该从原 event vobject 读出保留."""
    evt = _mock_event_with_vevent(
        summary="Old Sync",
        dtstart=datetime(2026, 5, 30, 14, tzinfo=timezone.utc),
        dtend=datetime(2026, 5, 30, 15, tzinfo=timezone.utc),
        location="Room A",
        sequence=2,
    )
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    result = w.update_event(ical_uid="uid-x", summary="New Sync")
    assert result["action"] == "updated"
    assert result["sequence"] == 3  # 默认 sequence_bump=True
    # evt.data 被设成新 body
    new_body = evt.data
    assert "SUMMARY:New Sync" in new_body
    assert "DTSTART:20260530T140000Z" in new_body  # 保留原 start
    assert "LOCATION:Room A" in new_body  # 保留原 location
    assert "SEQUENCE:3" in new_body
    evt.save.assert_called_once()


def test_writer_update_event_no_sequence_bump():
    evt = _mock_event_with_vevent(sequence=5)
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    result = w.update_event(
        ical_uid="uid-x", summary="x", sequence_bump=False,
    )
    assert result["sequence"] == 5
    assert "SEQUENCE:5" in evt.data


def test_writer_delete_event_calls_delete():
    evt = _mock_event_with_vevent()
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    result = w.delete_event(ical_uid="uid-x")
    assert result == {
        "action": "deleted", "ical_uid": "uid-x", "calendar_name": "日历",
    }
    evt.delete.assert_called_once()


def test_writer_delete_event_uid_not_found_raises():
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.side_effect = Exception("not found")
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    with pytest.raises(ValueError, match="event not found"):
        w.delete_event(ical_uid="ghost")
    cal.event_by_uid.assert_called()
