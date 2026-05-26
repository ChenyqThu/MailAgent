"""Phase 3 §P2-b — caldav_writer build_vevent + _extract_attendees_from_vevent
round-trip with real vobject lib.

F19 (Opus Medium) 早 mock 验证了 transmute (build → re-build hardcoded
extract), 但没用真 vobject parse 测试. P2-b 补 round-trip:
- build_vevent(attendees=[...]) → VCALENDAR text
- vobject.readOne(text) → parsed vEvent
- _extract_attendees_from_vevent(vevent) → list of dict
- assert 跟输入 attendees 一致 (NEEDS-ACTION default + 字段顺序差异除外)

Coverage:
- PARTSTAT 全 5 值 (NEEDS-ACTION / ACCEPTED / DECLINED / TENTATIVE / DELEGATED)
- ROLE 透传 (REQ-PARTICIPANT / OPT-PARTICIPANT / CHAIR / NON-PARTICIPANT)
- RSVP TRUE/FALSE
- CN 含特殊字符 / unicode
- Multi-attendee
- 空 attendees list (no ATTENDEE line)
- RRULE / EXDATE / RDATE / RECURRENCE-ID 透传 (F3 critical fix)
- DTSTART / DTEND / SEQUENCE / STATUS round-trip
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
import vobject

from src.calendar_sync.caldav_writer import (
    CalDAVWriter,
    _extract_attendees_from_vevent,
    _extract_datetimes_from_vevent_field,
    build_vevent,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_and_parse(**kwargs):
    """build_vevent + vobject parse + 返回 vevent 节点."""
    text = build_vevent(**kwargs)
    cal = vobject.readOne(text)
    assert hasattr(cal, "vevent"), "VCALENDAR 必须含 VEVENT"
    return cal.vevent, text


def _common_kwargs(**overrides):
    """合理默认值, override 想测的字段."""
    base = {
        "ical_uid": "rt-test@mailagent.local",
        "summary": "Round-trip test",
        "dtstart_utc": datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc),
        "dtend_utc": datetime(2026, 6, 1, 15, 0, tzinfo=timezone.utc),
        "organizer_email": "owner@example.com",
        "now_utc": datetime(2026, 5, 25, 0, 0, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# 单 attendee PARTSTAT 全 5 值 round-trip
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("partstat", [
    "NEEDS-ACTION",
    "ACCEPTED",
    "DECLINED",
    "TENTATIVE",
    "DELEGATED",
])
def test_partstat_round_trip(partstat: str):
    """每个合法 PARTSTAT 值都能 parse 回来."""
    vev, _ = _build_and_parse(**_common_kwargs(
        attendees=[{"email": "alice@example.com", "partstat": partstat}],
    ))
    extracted = _extract_attendees_from_vevent(vev)
    assert len(extracted) == 1
    assert extracted[0]["email"] == "alice@example.com"
    assert extracted[0]["partstat"] == partstat


def test_default_partstat_is_needs_action():
    """不传 partstat 时, build_vevent 默认 NEEDS-ACTION (F19 fix)."""
    vev, _ = _build_and_parse(**_common_kwargs(
        attendees=[{"email": "bob@example.com"}],  # no partstat
    ))
    extracted = _extract_attendees_from_vevent(vev)
    assert extracted[0]["partstat"] == "NEEDS-ACTION"


# ---------------------------------------------------------------------------
# ROLE 透传 (F19)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("role", [
    "REQ-PARTICIPANT",
    "OPT-PARTICIPANT",
    "CHAIR",
    "NON-PARTICIPANT",
])
def test_role_round_trip(role: str):
    vev, _ = _build_and_parse(**_common_kwargs(
        attendees=[{
            "email": "alice@example.com",
            "partstat": "ACCEPTED",
            "role": role,
        }],
    ))
    extracted = _extract_attendees_from_vevent(vev)
    assert extracted[0]["role"] == role


def test_role_optional_skips_when_unset():
    """不传 role 时不写 ROLE param, parse 出来 role key 不存在."""
    vev, _ = _build_and_parse(**_common_kwargs(
        attendees=[{"email": "alice@example.com", "partstat": "ACCEPTED"}],
    ))
    extracted = _extract_attendees_from_vevent(vev)
    assert "role" not in extracted[0]


# ---------------------------------------------------------------------------
# RSVP TRUE/FALSE
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rsvp", ["TRUE", "FALSE"])
def test_rsvp_round_trip(rsvp: str):
    vev, _ = _build_and_parse(**_common_kwargs(
        attendees=[{
            "email": "alice@example.com",
            "partstat": "NEEDS-ACTION",
            "rsvp": rsvp,
        }],
    ))
    extracted = _extract_attendees_from_vevent(vev)
    assert extracted[0]["rsvp"] == rsvp


def test_default_rsvp_is_true():
    """不传 rsvp 时, build_vevent 默认 TRUE (F19)."""
    vev, _ = _build_and_parse(**_common_kwargs(
        attendees=[{"email": "alice@example.com"}],
    ))
    extracted = _extract_attendees_from_vevent(vev)
    assert extracted[0]["rsvp"] == "TRUE"


# ---------------------------------------------------------------------------
# CN (display name)
# ---------------------------------------------------------------------------

def test_cn_round_trip_simple():
    vev, _ = _build_and_parse(**_common_kwargs(
        attendees=[{
            "email": "alice@example.com", "name": "Alice Smith",
        }],
    ))
    extracted = _extract_attendees_from_vevent(vev)
    assert extracted[0]["name"] == "Alice Smith"


def test_cn_strips_embedded_quotes():
    """CN value 不能含 raw double quote (会破 CN="..." 包装).

    build_vevent 用 replace(chr(34), '') 剥 quote — round-trip 后 CN 不含.
    """
    vev, _ = _build_and_parse(**_common_kwargs(
        attendees=[{
            "email": "evil@example.com",
            "name": 'Bad" Hacker',  # raw quote in name
        }],
    ))
    extracted = _extract_attendees_from_vevent(vev)
    assert '"' not in extracted[0]["name"]


def test_cn_unicode_chinese():
    """CN 含中文也能 round-trip."""
    vev, _ = _build_and_parse(**_common_kwargs(
        attendees=[{
            "email": "wang@example.com", "name": "王小明",
        }],
    ))
    extracted = _extract_attendees_from_vevent(vev)
    assert extracted[0]["name"] == "王小明"


# ---------------------------------------------------------------------------
# Multi-attendee
# ---------------------------------------------------------------------------

def test_multi_attendee_round_trip():
    """3 个 attendees 各种 partstat / role 组合."""
    attendees_in = [
        {
            "email": "alice@example.com", "name": "Alice",
            "partstat": "ACCEPTED", "role": "CHAIR", "rsvp": "FALSE",
        },
        {
            "email": "bob@example.com", "name": "Bob",
            "partstat": "TENTATIVE", "role": "REQ-PARTICIPANT",
        },
        {
            "email": "carol@example.com",
            "partstat": "DECLINED",
        },
    ]
    vev, _ = _build_and_parse(**_common_kwargs(attendees=attendees_in))
    extracted = _extract_attendees_from_vevent(vev)
    assert len(extracted) == 3

    # 不假设 order — 用 email 索引比对
    by_email = {a["email"]: a for a in extracted}
    assert by_email["alice@example.com"]["partstat"] == "ACCEPTED"
    assert by_email["alice@example.com"]["role"] == "CHAIR"
    assert by_email["alice@example.com"]["rsvp"] == "FALSE"
    assert by_email["alice@example.com"]["name"] == "Alice"

    assert by_email["bob@example.com"]["partstat"] == "TENTATIVE"
    assert by_email["bob@example.com"]["role"] == "REQ-PARTICIPANT"
    assert by_email["bob@example.com"]["rsvp"] == "TRUE"  # default

    assert by_email["carol@example.com"]["partstat"] == "DECLINED"
    assert "role" not in by_email["carol@example.com"]
    assert by_email["carol@example.com"]["rsvp"] == "TRUE"


def test_empty_attendees_no_attendee_line():
    """attendees=[] 不输出 ATTENDEE 行."""
    _, text = _build_and_parse(**_common_kwargs(attendees=[]))
    assert "ATTENDEE" not in text


# ---------------------------------------------------------------------------
# RRULE / EXDATE / RDATE / RECURRENCE-ID (F3 critical fix — recurring 透传)
# ---------------------------------------------------------------------------

def test_rrule_round_trip():
    """update_event 透传 RRULE — F3 fix 防 recurring 降级单次."""
    vev, _ = _build_and_parse(**_common_kwargs(
        rrule="FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10",
    ))
    assert vev.rrule.value == "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10"


def test_exdates_round_trip():
    exdates_in = [
        datetime(2026, 6, 8, 14, 0, tzinfo=timezone.utc),
        datetime(2026, 6, 15, 14, 0, tzinfo=timezone.utc),
    ]
    vev, _ = _build_and_parse(**_common_kwargs(
        rrule="FREQ=WEEKLY",
        exdates=exdates_in,
    ))
    extracted = _extract_datetimes_from_vevent_field(vev, "exdate")
    assert len(extracted) == 2
    # 比对 epoch (无视微秒差)
    assert {d.timestamp() for d in extracted} == {
        d.timestamp() for d in exdates_in
    }


def test_rdates_round_trip():
    rdates_in = [
        datetime(2026, 7, 4, 10, 0, tzinfo=timezone.utc),
    ]
    vev, _ = _build_and_parse(**_common_kwargs(
        rdates=rdates_in,
    ))
    extracted = _extract_datetimes_from_vevent_field(vev, "rdate")
    assert len(extracted) == 1
    assert extracted[0].timestamp() == rdates_in[0].timestamp()


def test_recurrence_id_round_trip():
    """跳脱 occurrence — RECURRENCE-ID 透传."""
    rec_id = datetime(2026, 6, 15, 14, 0, tzinfo=timezone.utc)
    vev, _ = _build_and_parse(**_common_kwargs(recurrence_id=rec_id))
    # vobject 把 RECURRENCE-ID 暴露为 .recurrence_id
    assert hasattr(vev, "recurrence_id")
    parsed = vev.recurrence_id.value
    # parsed 可能是 datetime, 比对 epoch
    parsed_utc = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    assert parsed_utc.timestamp() == rec_id.timestamp()


# ---------------------------------------------------------------------------
# Other core fields — DTSTART / DTEND / SEQUENCE / STATUS / SUMMARY / LOCATION
# ---------------------------------------------------------------------------

def test_summary_location_description_round_trip():
    vev, _ = _build_and_parse(**_common_kwargs(
        summary="Quarterly review",
        location="Tokyo HQ Room A",
        description="Q1 numbers; Roadmap discussion",
    ))
    assert vev.summary.value == "Quarterly review"
    assert vev.location.value == "Tokyo HQ Room A"
    assert vev.description.value == "Q1 numbers; Roadmap discussion"


def test_summary_with_special_chars_escaped():
    """SUMMARY 含 ; , \\ 时 build_vevent 应 escape (RFC 5545 §3.3.11)."""
    vev, _ = _build_and_parse(**_common_kwargs(
        summary="Project; with, special\\chars",
    ))
    # vobject parse 时自动 unescape, 我们拿到原值
    assert vev.summary.value == "Project; with, special\\chars"


@pytest.mark.parametrize("status", ["CONFIRMED", "TENTATIVE", "CANCELLED"])
def test_status_round_trip(status: str):
    vev, _ = _build_and_parse(**_common_kwargs(status=status))
    assert vev.status.value == status


def test_sequence_round_trip():
    vev, _ = _build_and_parse(**_common_kwargs(sequence=42))
    assert vev.sequence.value == "42"


def test_dtstart_dtend_round_trip():
    start = datetime(2026, 8, 15, 9, 30, tzinfo=timezone.utc)
    end = datetime(2026, 8, 15, 10, 45, tzinfo=timezone.utc)
    vev, _ = _build_and_parse(**_common_kwargs(
        dtstart_utc=start, dtend_utc=end,
    ))
    parsed_start = vev.dtstart.value
    parsed_end = vev.dtend.value
    if parsed_start.tzinfo is None:
        parsed_start = parsed_start.replace(tzinfo=timezone.utc)
    if parsed_end.tzinfo is None:
        parsed_end = parsed_end.replace(tzinfo=timezone.utc)
    assert parsed_start.timestamp() == start.timestamp()
    assert parsed_end.timestamp() == end.timestamp()


def test_uid_organizer_round_trip():
    vev, _ = _build_and_parse(**_common_kwargs(
        ical_uid="my-unique-uid@example.com",
        organizer_email="boss@example.com",
    ))
    assert vev.uid.value == "my-unique-uid@example.com"
    assert vev.organizer.value == "mailto:boss@example.com"


# ---------------------------------------------------------------------------
# Phase 4·#3 — update_event rrule sentinel (保留 / 覆盖 / 删除)
# ---------------------------------------------------------------------------

def _writer_with_recurring_event(orig_rrule: str = "FREQ=WEEKLY;BYDAY=MO"):
    """造 CalDAVWriter (绕 __init__ 不连 CalDAV), _find_event_by_uid 返回带真
    vobject vevent (含 RRULE) 的 mock event. update_event 把新 PUT body 赋给
    evt.data — 测试读它验证 sentinel 行为."""
    orig_body = build_vevent(
        ical_uid="evt-rrule@mailagent.local",
        summary="Standup",
        dtstart_utc=datetime(2026, 1, 5, 9, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 1, 5, 9, 30, tzinfo=timezone.utc),
        organizer_email="me@example.com",
        rrule=orig_rrule,
    )
    real_vevent = vobject.readOne(orig_body).vevent
    mock_evt = MagicMock()
    mock_evt.vobject_instance.vevent = real_vevent
    writer = CalDAVWriter.__new__(CalDAVWriter)
    writer.user = "me@example.com"
    writer._find_event_by_uid = MagicMock(return_value=(MagicMock(), mock_evt))
    return writer, mock_evt


def test_update_event_rrule_unset_preserves_series():
    """不传 rrule (默认 _UNSET) → 保留原 RRULE (F3 透传, 防 series 降级单次)."""
    writer, mock_evt = _writer_with_recurring_event("FREQ=WEEKLY;BYDAY=MO")
    writer.update_event(ical_uid="evt-rrule@mailagent.local", summary="新标题")
    new = vobject.readOne(mock_evt.data)
    assert new.vevent.rrule.value == "FREQ=WEEKLY;BYDAY=MO"
    assert new.vevent.summary.value == "新标题"


def test_update_event_rrule_override_changes_series():
    """显式 rrule str → 覆盖整系列规则 (改整系列)."""
    writer, mock_evt = _writer_with_recurring_event("FREQ=WEEKLY")
    writer.update_event(
        ical_uid="evt-rrule@mailagent.local", rrule="FREQ=DAILY;COUNT=5",
    )
    new = vobject.readOne(mock_evt.data)
    assert new.vevent.rrule.value == "FREQ=DAILY;COUNT=5"


def test_update_event_rrule_empty_clears_to_single():
    """显式 rrule='' → 删除 RRULE, 周期事件降级单次."""
    writer, mock_evt = _writer_with_recurring_event("FREQ=WEEKLY")
    writer.update_event(ical_uid="evt-rrule@mailagent.local", rrule="")
    new = vobject.readOne(mock_evt.data)
    assert not hasattr(new.vevent, "rrule")
