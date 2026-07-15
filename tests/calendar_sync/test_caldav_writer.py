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
    attendees=None,
    rrule=None,
    exdates=None,
    rdates=None,
    recurrence_id=None,
):
    """构造 mock event with .vobject_instance.vevent.X.value attributes.

    F3 扩展: attendees / rrule / exdates / rdates / recurrence_id mocking
    覆盖透传场景.
    """
    if dtstart is None:
        dtstart = datetime(2026, 5, 30, 14, tzinfo=timezone.utc)
    if dtend is None:
        dtend = datetime(2026, 5, 30, 15, tzinfo=timezone.utc)
    # vobject ATTENDEE — value="mailto:email", params={"CN": [name]}
    attendee_nodes = []
    for a in attendees or []:
        params = {}
        if a.get("name"):
            params["CN"] = [a["name"]]
        attendee_nodes.append(
            SimpleNamespace(value=f"mailto:{a['email']}", params=params)
        )
    exdate_nodes = [SimpleNamespace(value=d) for d in (exdates or [])]
    rdate_nodes = [SimpleNamespace(value=d) for d in (rdates or [])]
    vevent_kwargs = dict(
        summary=SimpleNamespace(value=summary),
        dtstart=SimpleNamespace(value=dtstart),
        dtend=SimpleNamespace(value=dtend),
        location=SimpleNamespace(value=location) if location else None,
        description=SimpleNamespace(value=description) if description else None,
        sequence=SimpleNamespace(value=sequence),
        status=SimpleNamespace(value=status),
        attendee_list=attendee_nodes,
        rrule=SimpleNamespace(value=rrule) if rrule else None,
        exdate_list=exdate_nodes,
        rdate_list=rdate_nodes,
        recurrence_id=SimpleNamespace(value=recurrence_id) if recurrence_id else None,
    )
    vevent = SimpleNamespace(**vevent_kwargs)
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


# ---------------------------------------------------------------------------
# F3 Critical fix — update_event 保留原 attendees + RRULE/EXDATE/RDATE
# ---------------------------------------------------------------------------

def test_writer_update_event_attendees_omitted_preserved():
    """**Critical 修复**: update_event 不传 attendees → 原 attendees 保留.

    老代码默认 attendees=None → build_vevent 不输出 ATTENDEE 行 →
    PUT 全替换语义把 Exchange 端**原 attendees 全部清空** = 静默数据损坏.
    F3 用 _UNSET sentinel + _extract_attendees_from_vevent 透传原值.
    """
    evt = _mock_event_with_vevent(
        summary="Team Sync",
        attendees=[
            {"email": "alice@x.com", "name": "Alice"},
            {"email": "bob@x.com", "name": "Bob"},
        ],
    )
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    # 只改 summary, attendees 完全不传
    w.update_event(ical_uid="uid-x", summary="Team Sync v2")

    # 原 attendees 必须出现在 new body, 不能丢
    body = evt.data
    assert "mailto:alice@x.com" in body
    assert "mailto:bob@x.com" in body
    assert 'CN="Alice"' in body
    assert 'CN="Bob"' in body


def test_writer_update_event_attendees_empty_list_clears():
    """显式 attendees=[] → caller 明确要清空, 不保留."""
    evt = _mock_event_with_vevent(
        attendees=[{"email": "alice@x.com", "name": "Alice"}],
    )
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    w.update_event(ical_uid="uid-x", summary="x", attendees=[])
    assert "ATTENDEE" not in evt.data
    assert "mailto:alice@x.com" not in evt.data


def test_writer_update_event_attendees_replaces_with_new_list():
    """显式 attendees=[新人] → 替换为新列表."""
    evt = _mock_event_with_vevent(
        attendees=[{"email": "alice@x.com", "name": "Alice"}],
    )
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    w.update_event(
        ical_uid="uid-x",
        summary="x",
        attendees=[{"email": "carol@x.com", "name": "Carol"}],
    )
    body = evt.data
    assert "mailto:carol@x.com" in body
    assert "mailto:alice@x.com" not in body


def test_writer_update_event_rrule_preserved_for_recurring_event():
    """**Critical 修复**: recurring event update → RRULE 必须透传, 否则
    Exchange 把 series 降级单次, 未来 occurrences 全删."""
    evt = _mock_event_with_vevent(
        summary="Weekly Sync",
        rrule="FREQ=WEEKLY;BYDAY=MO",
    )
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    w.update_event(ical_uid="uid-x", summary="Weekly Sync (updated)")

    body = evt.data
    assert "RRULE:FREQ=WEEKLY;BYDAY=MO" in body


def test_writer_update_event_exdates_rdates_preserved():
    """recurring event update → EXDATE/RDATE 也必须透传."""
    evt = _mock_event_with_vevent(
        rrule="FREQ=WEEKLY",
        exdates=[
            datetime(2026, 6, 1, 14, tzinfo=timezone.utc),
            datetime(2026, 6, 8, 14, tzinfo=timezone.utc),
        ],
        rdates=[datetime(2026, 6, 15, 14, tzinfo=timezone.utc)],
    )
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    w.update_event(ical_uid="uid-x", summary="x")

    body = evt.data
    assert "EXDATE:20260601T140000Z" in body
    assert "EXDATE:20260608T140000Z" in body
    assert "RDATE:20260615T140000Z" in body


def test_writer_update_event_recurrence_id_preserved_for_override():
    """occurrence override event (含 RECURRENCE-ID) update → ID 透传."""
    evt = _mock_event_with_vevent(
        recurrence_id=datetime(2026, 6, 1, 14, tzinfo=timezone.utc),
    )
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    w.update_event(ical_uid="uid-x", summary="changed only this occurrence")

    assert "RECURRENCE-ID:20260601T140000Z" in evt.data


def test_build_vevent_rrule_exdate_rdate_emitted():
    """build_vevent 接 rrule/exdates/rdates/recurrence_id 时输出对应行."""
    from src.calendar_sync.caldav_writer import build_vevent

    body = build_vevent(
        ical_uid="x",
        summary="Recur",
        dtstart_utc=datetime(2026, 5, 30, 14, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 5, 30, 15, tzinfo=timezone.utc),
        organizer_email="me@x.com",
        rrule="FREQ=DAILY;COUNT=10",
        exdates=[datetime(2026, 6, 1, 14, tzinfo=timezone.utc)],
        rdates=[datetime(2026, 6, 15, 14, tzinfo=timezone.utc)],
        recurrence_id=datetime(2026, 6, 1, 14, tzinfo=timezone.utc),
    )
    assert "RRULE:FREQ=DAILY;COUNT=10" in body
    assert "EXDATE:20260601T140000Z" in body
    assert "RDATE:20260615T140000Z" in body
    assert "RECURRENCE-ID:20260601T140000Z" in body


def test_extract_attendees_from_vevent_handles_no_attendee_list():
    """vevent 无 attendee → 返回空 list, 不抛."""
    from src.calendar_sync.caldav_writer import _extract_attendees_from_vevent

    v = SimpleNamespace()  # 无 attendee_list 属性
    assert _extract_attendees_from_vevent(v) == []


def test_extract_attendees_from_vevent_skips_non_email():
    """attendee value 不像 email (e.g. room name) → 跳过."""
    from src.calendar_sync.caldav_writer import _extract_attendees_from_vevent

    v = SimpleNamespace(
        attendee_list=[
            SimpleNamespace(value="mailto:alice@x.com", params={"CN": ["Alice"]}),
            SimpleNamespace(value="Conference Room A", params={}),  # not email
            SimpleNamespace(value="mailto:", params={}),  # empty
        ],
    )
    result = _extract_attendees_from_vevent(v)
    assert len(result) == 1
    assert result[0]["email"] == "alice@x.com"
    assert result[0]["name"] == "Alice"


# ---------------------------------------------------------------------------
# F19 (Opus Medium) — PARTSTAT / ROLE / RSVP 透传, 修 F3 副作用
# ---------------------------------------------------------------------------

def test_extract_attendees_includes_partstat_role_rsvp():
    """F19 — _extract_attendees_from_vevent 提取 PARTSTAT/ROLE/RSVP 全 params."""
    from src.calendar_sync.caldav_writer import _extract_attendees_from_vevent

    v = SimpleNamespace(
        attendee_list=[
            SimpleNamespace(
                value="mailto:alice@x.com",
                params={
                    "CN": ["Alice"],
                    "PARTSTAT": ["ACCEPTED"],
                    "ROLE": ["REQ-PARTICIPANT"],
                    "RSVP": ["TRUE"],
                },
            ),
            SimpleNamespace(
                value="mailto:bob@x.com",
                params={"CN": ["Bob"], "PARTSTAT": ["DECLINED"]},
            ),
        ],
    )
    result = _extract_attendees_from_vevent(v)
    assert result[0] == {
        "email": "alice@x.com",
        "name": "Alice",
        "partstat": "ACCEPTED",
        "role": "REQ-PARTICIPANT",
        "rsvp": "TRUE",
    }
    assert result[1] == {
        "email": "bob@x.com",
        "name": "Bob",
        "partstat": "DECLINED",
    }


def test_build_vevent_attendee_with_explicit_partstat():
    """F19 — build_vevent 接 attendee.partstat 覆盖默认 NEEDS-ACTION."""
    from src.calendar_sync.caldav_writer import build_vevent

    body = build_vevent(
        ical_uid="x",
        summary="x",
        dtstart_utc=datetime(2026, 5, 30, 14, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 5, 30, 15, tzinfo=timezone.utc),
        organizer_email="me@x.com",
        attendees=[
            {"email": "alice@x.com", "name": "Alice", "partstat": "ACCEPTED",
             "role": "REQ-PARTICIPANT", "rsvp": "FALSE"},
        ],
    )
    line = next(L for L in body.splitlines() if L.startswith("ATTENDEE"))
    assert "PARTSTAT=ACCEPTED" in line
    assert "ROLE=REQ-PARTICIPANT" in line
    assert "RSVP=FALSE" in line
    assert 'CN="Alice"' in line


def test_build_vevent_attendee_no_partstat_defaults_needs_action():
    """F19 — 没传 partstat 走 default NEEDS-ACTION (新建 attendee 场景)."""
    from src.calendar_sync.caldav_writer import build_vevent

    body = build_vevent(
        ical_uid="x",
        summary="x",
        dtstart_utc=datetime(2026, 5, 30, 14, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 5, 30, 15, tzinfo=timezone.utc),
        organizer_email="me@x.com",
        attendees=[{"email": "alice@x.com"}],
    )
    line = next(L for L in body.splitlines() if L.startswith("ATTENDEE"))
    assert "PARTSTAT=NEEDS-ACTION" in line
    assert "RSVP=TRUE" in line


def test_writer_update_event_preserves_attendee_partstat():
    """**F19 关键场景** — 已 ACCEPTED 的 attendee, update summary 后 PARTSTAT
    仍 ACCEPTED (不被 hardcode NEEDS-ACTION 打回 → 防 Exchange 重发邀请)."""
    evt = _mock_event_with_vevent(
        attendees=[{"email": "alice@x.com", "name": "Alice"}],
    )
    # mock attendee 加 ACCEPTED PARTSTAT
    evt.vobject_instance.vevent.attendee_list[0].params = {
        "CN": ["Alice"],
        "PARTSTAT": ["ACCEPTED"],
        "RSVP": ["FALSE"],
    }
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    w.update_event(ical_uid="uid-x", summary="x updated")

    line = next(L for L in evt.data.splitlines() if L.startswith("ATTENDEE"))
    assert "PARTSTAT=ACCEPTED" in line, f"PARTSTAT lost! got: {line}"
    assert "PARTSTAT=NEEDS-ACTION" not in line


# ---------------------------------------------------------------------------
# _connect — timeout (对齐 reader task 06-10)
# ---------------------------------------------------------------------------

def test_writer_connect_passes_timeout():
    """#9 真日历验证实测: 无 timeout 的 DAVClient 在 DavMail 响应挂起时把调用
    线程永久吊死在 sock_recv (reader 在 task 06-10 已加 timeout=30, writer 漏配)."""
    w = CalDAVWriter(_mock_cfg())
    with patch("caldav.DAVClient") as client_cls:
        w._connect()
    assert client_cls.call_args.kwargs.get("timeout") == 30


# ---------------------------------------------------------------------------
# _save_existing_event — DavMail 200-OK workaround (#9 真日历验证)
# ---------------------------------------------------------------------------

def _put_error(status_line: str):
    from caldav.lib.error import PutError
    return PutError(f"{status_line}\n\n<raw body>")


def test_save_existing_event_swallows_200_puterror():
    """DavMail 更新已存在事件返 200 OK, caldav 3.2.0 只认 201/204 误抛 PutError
    — 服务端实际已应用, 必须当成功."""
    from src.calendar_sync.caldav_writer import _save_existing_event
    evt = MagicMock()
    evt.save.side_effect = _put_error("200 OK")
    _save_existing_event(evt)  # 不抛
    evt.save.assert_called_once()


def test_save_existing_event_reraises_non_200_puterror():
    from src.calendar_sync.caldav_writer import _save_existing_event
    from caldav.lib.error import PutError
    evt = MagicMock()
    evt.save.side_effect = _put_error("507 Insufficient Storage")
    with pytest.raises(PutError):
        _save_existing_event(evt)


def test_save_existing_event_normal_save_passthrough():
    from src.calendar_sync.caldav_writer import _save_existing_event
    evt = MagicMock()
    _save_existing_event(evt)
    evt.save.assert_called_once()


# ---------------------------------------------------------------------------
# update_event — VALARM 保留 (F3, #9 真日历验证)
# ---------------------------------------------------------------------------

_VALARM_TEXT = (
    "BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:reminder\r\n"
    "TRIGGER:-PT15M\r\nEND:VALARM\r\n"
)


def test_writer_update_event_preserves_valarm():
    """#9 真日历验证实测: VALARM 活过 Exchange round-trip, 但 build_vevent 白名单
    重建把它剥掉 → 改一次事件 = 用户提醒被静默删除. update_event 必须搬运原 VALARM."""
    evt = _mock_event_with_vevent(summary="有提醒的会")
    evt.vobject_instance.vevent.valarm_list = [
        SimpleNamespace(serialize=lambda: _VALARM_TEXT),
    ]
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    w.update_event(ical_uid="uid-valarm", summary="改了标题")

    assert "BEGIN:VALARM" in evt.data and "TRIGGER:-PT15M" in evt.data
    # VALARM 块必须在 VEVENT 内部 (END:VEVENT 之前)
    assert evt.data.index("END:VALARM") < evt.data.index("END:VEVENT")


def test_writer_update_event_no_valarm_body_unchanged():
    """无 VALARM 的事件 update 后 body 不含 VALARM (搬运逻辑零副作用)."""
    evt = _mock_event_with_vevent(summary="无提醒的会")
    cal = MagicMock()
    cal.name = "日历"
    cal.event_by_uid.return_value = evt
    principal = MagicMock()
    principal.calendars.return_value = [cal]
    w = _writer_with_mock_principal(principal)

    w.update_event(ical_uid="uid-novalarm", summary="改了标题")

    assert "VALARM" not in evt.data


# ---------------------------------------------------------------------------
# F1/F2 (#10 tzid 半步) — TZID 输出 + split UNTIL 本地日界
# ---------------------------------------------------------------------------

def test_build_vevent_tzid_emits_local_time_and_vtimezone():
    """tzid 非空: DTSTART/DTEND 以 TZID= 本地墙钟输出 + 附 VTIMEZONE;
    RECURRENCE-ID 恒 UTC Z (#9 实锤 DavMail 对 Z 的 RECURRENCE-ID 匹配正确)."""
    body = build_vevent(
        ical_uid="tz@mailagent.local",
        summary="override",
        dtstart_utc=datetime(2026, 9, 11, 3, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 9, 11, 3, 30, tzinfo=timezone.utc),
        organizer_email="me@example.com",
        recurrence_id=datetime(2026, 9, 11, 1, 0, tzinfo=timezone.utc),
        tzid="America/Los_Angeles",
    )
    # 03:00Z = 09-10 20:00 PDT
    assert "DTSTART;TZID=America/Los_Angeles:20260910T200000" in body
    assert "DTEND;TZID=America/Los_Angeles:20260910T203000" in body
    assert "BEGIN:VTIMEZONE" in body
    assert "TZID:America/Los_Angeles" in body
    assert "RECURRENCE-ID:20260911T010000Z" in body
    import vobject
    parsed = vobject.readOne(body)  # 可解析且 tz 正确
    ov = parsed.vevent
    assert ov.dtstart.value.astimezone(timezone.utc) == datetime(
        2026, 9, 11, 3, 0, tzinfo=timezone.utc
    )


def test_build_vevent_unresolvable_tzid_falls_back_to_z():
    body = build_vevent(
        ical_uid="tz@mailagent.local",
        summary="t",
        dtstart_utc=datetime(2026, 9, 11, 3, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 9, 11, 4, 0, tzinfo=timezone.utc),
        organizer_email="me@example.com",
        tzid="Fake/Zone",
    )
    assert "DTSTART:20260911T030000Z" in body
    assert "BEGIN:VTIMEZONE" not in body


def test_build_vevent_all_day_ignores_tzid():
    body = build_vevent(
        ical_uid="ad@mailagent.local",
        summary="allday",
        dtstart_utc=datetime(2026, 9, 11, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 9, 12, tzinfo=timezone.utc),
        organizer_email="me@example.com",
        is_all_day=True,
        tzid="America/Los_Angeles",
    )
    assert "DTSTART;VALUE=DATE:20260911" in body
    assert "TZID" not in body


def _writer_with_vcal(master_body: str):
    import vobject
    vcal = vobject.readOne(master_body)
    mock_evt = MagicMock()
    mock_evt.vobject_instance = vcal
    mock_cal = MagicMock()
    writer = CalDAVWriter.__new__(CalDAVWriter)
    writer.user = "me@example.com"
    writer._find_event_by_uid = MagicMock(return_value=(mock_cal, mock_evt))
    return writer, mock_evt, mock_cal


def test_update_occurrence_bare_z_master_falls_back_local_tz(monkeypatch):
    """F1: 裸 Z master → fallback 本机时区 (monkeypatch 钉 LA), override 带 TZID 本地时间."""
    monkeypatch.setattr(
        "src.calendar_sync.caldav_writer.local_olson_tzid",
        lambda: "America/Los_Angeles",
    )
    master_body = build_vevent(
        ical_uid="series@mailagent.local", summary="Standup",
        dtstart_utc=datetime(2026, 8, 28, 1, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 8, 28, 1, 30, tzinfo=timezone.utc),
        organizer_email="me@example.com", rrule="FREQ=WEEKLY;COUNT=5",
    )
    writer, mock_evt, _ = _writer_with_vcal(master_body)
    occ3 = datetime(2026, 9, 11, 1, 0, tzinfo=timezone.utc)
    writer.update_occurrence(
        ical_uid="series@mailagent.local", recurrence_id_utc=occ3,
        dtstart_utc=datetime(2026, 9, 11, 3, 0, tzinfo=timezone.utc),
    )
    out = mock_evt.data
    # override 本地墙钟 + VTIMEZONE; master 裸 Z 原样; RECURRENCE-ID 恒 Z
    assert "DTSTART;TZID=America/Los_Angeles:20260910T200000" in out
    assert "BEGIN:VTIMEZONE" in out
    assert "DTSTART:20260828T010000Z" in out
    assert "RECURRENCE-ID:20260911T010000Z" in out


def test_update_occurrence_inherits_master_tzid():
    """F1: master 自带 TZID (真 Exchange 事件) → override 直接继承, 不走本机 fallback."""
    master_body = build_vevent(
        ical_uid="cn@mailagent.local", summary="深圳周会",
        dtstart_utc=datetime(2026, 9, 4, 8, 0, tzinfo=timezone.utc),  # 16:00 CST
        dtend_utc=datetime(2026, 9, 4, 9, 0, tzinfo=timezone.utc),
        organizer_email="me@example.com", rrule="FREQ=WEEKLY;COUNT=5",
        tzid="Asia/Shanghai",
    )
    writer, mock_evt, _ = _writer_with_vcal(master_body)
    occ2 = datetime(2026, 9, 11, 8, 0, tzinfo=timezone.utc)
    writer.update_occurrence(
        ical_uid="cn@mailagent.local", recurrence_id_utc=occ2,
        dtstart_utc=datetime(2026, 9, 11, 10, 0, tzinfo=timezone.utc),  # 18:00 CST
    )
    assert "DTSTART;TZID=Asia/Shanghai:20260911T180000" in mock_evt.data


def test_split_series_until_uses_local_date_boundary(monkeypatch):
    """F2 (#9 实锤复现型): DAILY 01:00Z 系列 (LA 本地前一日 18:00), split 第 4 次 —
    UNTIL 必须写「最后保留 occurrence 的本地日期 23:59:59Z」(20260905T235959Z),
    而非 split-1s (20260907T005959Z, 会被 EWS 日期粒度 EndDate 多留 2 天)."""
    monkeypatch.setattr(
        "src.calendar_sync.caldav_writer.local_olson_tzid",
        lambda: "America/Los_Angeles",
    )
    master_body = build_vevent(
        ical_uid="split@mailagent.local", summary="daily",
        dtstart_utc=datetime(2026, 9, 4, 1, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 9, 4, 2, 0, tzinfo=timezone.utc),
        organizer_email="me@example.com", rrule="FREQ=DAILY;COUNT=8",
    )
    writer, mock_evt, mock_cal = _writer_with_vcal(master_body)
    result = writer.split_series(
        ical_uid="split@mailagent.local",
        split_recurrence_id_utc=datetime(2026, 9, 7, 1, 0, tzinfo=timezone.utc),
    )
    import vobject
    old_rrule = vobject.readOne(mock_evt.data).vevent.rrule.value
    assert "UNTIL=20260905T235959Z" in old_rrule
    assert "COUNT" not in old_rrule
    # 新系列照旧: 去 UNTIL/COUNT + 从 split 点起
    new_body = mock_cal.save_event.call_args[0][0]
    assert "UNTIL" not in vobject.readOne(new_body).vevent.rrule.value
    assert result["until_iso"] == "2026-09-05T23:59:59+00:00"


def test_split_series_until_same_local_and_utc_date():
    """F2 对照: 系列时区本地日期 == UTC 日期 (Shanghai 16:00 local = 08:00Z) 时,
    UNTIL 字面日期即最后保留 occurrence 当日."""
    master_body = build_vevent(
        ical_uid="cn-split@mailagent.local", summary="daily-cn",
        dtstart_utc=datetime(2026, 9, 4, 8, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 9, 4, 9, 0, tzinfo=timezone.utc),
        organizer_email="me@example.com", rrule="FREQ=DAILY;COUNT=8",
        tzid="Asia/Shanghai",
    )
    writer, mock_evt, _ = _writer_with_vcal(master_body)
    writer.split_series(
        ical_uid="cn-split@mailagent.local",
        split_recurrence_id_utc=datetime(2026, 9, 7, 8, 0, tzinfo=timezone.utc),
    )
    import vobject
    old_rrule = vobject.readOne(mock_evt.data).vevent.rrule.value
    assert "UNTIL=20260906T235959Z" in old_rrule
