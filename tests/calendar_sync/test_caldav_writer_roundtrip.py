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

from datetime import date, datetime, timezone
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


# ---------------------------------------------------------------------------
# Phase 4·#2 — all-day (VALUE=DATE, RFC 5545 §3.6.1)
# ---------------------------------------------------------------------------

def test_all_day_value_date_round_trip():
    """is_all_day → DTSTART/DTEND 用 VALUE=DATE; dtend 取原值 (exclusive)."""
    vev, text = _build_and_parse(**_common_kwargs(
        is_all_day=True,
        dtstart_utc=datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 6, 2, 0, 0, tzinfo=timezone.utc),
    ))
    assert "VALUE=DATE" in text
    assert vev.dtstart.value == date(2026, 6, 1)
    assert vev.dtend.value == date(2026, 6, 2)


def test_non_all_day_keeps_datetime():
    """is_all_day=False (默认) → DTSTART 仍是 datetime (含时间, 无 VALUE=DATE)."""
    vev, text = _build_and_parse(**_common_kwargs())
    assert "VALUE=DATE" not in text
    assert isinstance(vev.dtstart.value, datetime)


def test_update_event_preserves_all_day_when_not_passed():
    """update 全天事件不传 is_all_day → 检测 orig date 保持全天 (防破坏成定时)."""
    orig_body = build_vevent(
        ical_uid="ad@mailagent.local",
        summary="假期",
        dtstart_utc=datetime(2026, 6, 1, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 6, 2, tzinfo=timezone.utc),
        organizer_email="me@example.com",
        is_all_day=True,
    )
    real_vevent = vobject.readOne(orig_body).vevent
    mock_evt = MagicMock()
    mock_evt.vobject_instance.vevent = real_vevent
    writer = CalDAVWriter.__new__(CalDAVWriter)
    writer.user = "me@example.com"
    writer._find_event_by_uid = MagicMock(return_value=(MagicMock(), mock_evt))
    writer.update_event(ical_uid="ad@mailagent.local", summary="改名")
    new = vobject.readOne(mock_evt.data)
    assert "VALUE=DATE" in mock_evt.data
    assert new.vevent.dtstart.value == date(2026, 6, 1)
    assert new.vevent.summary.value == "改名"


# ---------------------------------------------------------------------------
# Phase 4·#4 — attendees sentinel (数据安全: 防 update 静默清空 Exchange 与会者)
# ---------------------------------------------------------------------------


def _writer_with_attendee_event(attendees_in):
    """造 CalDAVWriter (绕 __init__), _find_event_by_uid 返回带 attendees 的
    真 vobject vevent. update_event PUT body 赋给 evt.data 供测试读验证 sentinel."""
    orig_body = build_vevent(
        ical_uid="att@mailagent.local",
        summary="Team Sync",
        dtstart_utc=datetime(2026, 1, 5, 9, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 1, 5, 9, 30, tzinfo=timezone.utc),
        organizer_email="me@example.com",
        attendees=attendees_in,
    )
    real_vevent = vobject.readOne(orig_body).vevent
    mock_evt = MagicMock()
    mock_evt.vobject_instance.vevent = real_vevent
    writer = CalDAVWriter.__new__(CalDAVWriter)
    writer.user = "me@example.com"
    writer._find_event_by_uid = MagicMock(return_value=(MagicMock(), mock_evt))
    return writer, mock_evt


def test_update_event_attendees_unset_preserves():
    """不传 attendees (默认 _UNSET) → 保留原与会者 + partstat (数据安全).

    关键: 已 ACCEPTED 的 partstat 不被打回 NEEDS-ACTION (否则 Exchange 重发邀请).
    这是前端 partstat 退化问题在 writer 层的根本保护 — 只要走 _UNSET 路径就保留.
    """
    writer, mock_evt = _writer_with_attendee_event(
        [{"email": "alice@example.com", "partstat": "ACCEPTED"}]
    )
    writer.update_event(ical_uid="att@mailagent.local", summary="新标题")
    new = vobject.readOne(mock_evt.data)
    extracted = _extract_attendees_from_vevent(new.vevent)
    assert len(extracted) == 1
    assert extracted[0]["email"] == "alice@example.com"
    assert extracted[0]["partstat"] == "ACCEPTED"
    assert new.vevent.summary.value == "新标题"


def test_update_event_attendees_empty_clears():
    """显式 attendees=[] → 清空 ATTENDEE 行 (caller 明确意图)."""
    writer, mock_evt = _writer_with_attendee_event(
        [{"email": "alice@example.com"}]
    )
    writer.update_event(ical_uid="att@mailagent.local", attendees=[])
    new = vobject.readOne(mock_evt.data)
    assert _extract_attendees_from_vevent(new.vevent) == []


def test_update_event_attendees_replace():
    """显式非空 attendees → 替换原列表."""
    writer, mock_evt = _writer_with_attendee_event(
        [{"email": "alice@example.com"}]
    )
    writer.update_event(
        ical_uid="att@mailagent.local",
        attendees=[{"email": "bob@example.com", "name": "Bob"}],
    )
    new = vobject.readOne(mock_evt.data)
    extracted = _extract_attendees_from_vevent(new.vevent)
    assert len(extracted) == 1
    assert extracted[0]["email"] == "bob@example.com"


# ---------------------------------------------------------------------------
# Phase 4·#3c — update_occurrence (detached occurrence, RECURRENCE-ID override)
# ---------------------------------------------------------------------------

def _writer_with_recurring_master(rrule: str = "FREQ=WEEKLY;BYDAY=MO"):
    """造 CalDAVWriter + mock evt, vobject_instance = 仅含 master VEVENT 的 vcal."""
    master_body = build_vevent(
        ical_uid="series@mailagent.local",
        summary="Standup",
        dtstart_utc=datetime(2026, 1, 5, 9, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 1, 5, 9, 30, tzinfo=timezone.utc),
        organizer_email="me@example.com",
        rrule=rrule,
    )
    vcal = vobject.readOne(master_body)
    mock_evt = MagicMock()
    mock_evt.vobject_instance = vcal
    writer = CalDAVWriter.__new__(CalDAVWriter)
    writer.user = "me@example.com"
    writer._find_event_by_uid = MagicMock(return_value=(MagicMock(), mock_evt))
    return writer, mock_evt


def test_update_occurrence_adds_recurrence_id_override():
    """改这一次: master 保留 RRULE + 加 override VEVENT (RECURRENCE-ID)."""
    writer, mock_evt = _writer_with_recurring_master("FREQ=WEEKLY;BYDAY=MO")
    result = writer.update_occurrence(
        ical_uid="series@mailagent.local",
        recurrence_id_utc=datetime(2026, 1, 12, 9, 0, tzinfo=timezone.utc),
        summary="改这一次",
    )
    assert result["action"] == "occurrence_updated"
    out = vobject.readOne(mock_evt.data)
    vevents = out.vevent_list
    overrides = [v for v in vevents if hasattr(v, "recurrence_id") and v.recurrence_id]
    masters = [v for v in vevents if not (hasattr(v, "recurrence_id") and v.recurrence_id)]
    assert len(masters) == 1
    assert len(overrides) == 1
    assert overrides[0].summary.value == "改这一次"
    assert masters[0].rrule.value == "FREQ=WEEKLY;BYDAY=MO"  # master RRULE 保留


def test_update_occurrence_inherits_master_fields_when_omitted():
    """不传字段从 master 继承; dtstart 未传 = 该 occurrence 原时间 (recurrence_id)."""
    writer, mock_evt = _writer_with_recurring_master()
    rid = datetime(2026, 1, 12, 9, 0, tzinfo=timezone.utc)
    writer.update_occurrence(ical_uid="series@mailagent.local", recurrence_id_utc=rid)
    out = vobject.readOne(mock_evt.data)
    override = [v for v in out.vevent_list if hasattr(v, "recurrence_id") and v.recurrence_id][0]
    assert override.summary.value == "Standup"  # 继承 master
    # dtstart 未传 → recurrence_id; duration 继承 master (30min)
    assert _to_utc_test(override.dtstart.value) == rid


def test_update_occurrence_replaces_existing_override():
    """已有同 recurrence_id override → 替换非追加 (防重复)."""
    writer, mock_evt = _writer_with_recurring_master("FREQ=WEEKLY")
    rid = datetime(2026, 1, 12, 9, 0, tzinfo=timezone.utc)
    writer.update_occurrence(ical_uid="series@mailagent.local", recurrence_id_utc=rid, summary="v1")
    # mock_evt.vobject_instance 仍是同 vcal (已含 v1 override), 第二次同 rid → 替换
    writer.update_occurrence(ical_uid="series@mailagent.local", recurrence_id_utc=rid, summary="v2")
    out = vobject.readOne(mock_evt.data)
    overrides = [v for v in out.vevent_list if hasattr(v, "recurrence_id") and v.recurrence_id]
    assert len(overrides) == 1  # 替换非追加
    assert overrides[0].summary.value == "v2"


def _to_utc_test(dt):
    """测试 helper: vobject dtstart.value (datetime/date) → UTC datetime."""
    from datetime import date as _d
    if isinstance(dt, datetime):
        return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    if isinstance(dt, _d):
        return datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc)
    raise TypeError(type(dt))


# ---------------------------------------------------------------------------
# Phase 4·#3d — split_series (改未来 / this and following)
# ---------------------------------------------------------------------------

def test_split_series_truncates_old_and_creates_new():
    """老 master RRULE 加 UNTIL 截断 + 新建 series (新 UID, 去 UNTIL/COUNT 继承 FREQ)."""
    writer, mock_evt = _writer_with_recurring_master("FREQ=WEEKLY;BYDAY=MO")
    mock_cal = MagicMock()
    writer._find_event_by_uid = MagicMock(return_value=(mock_cal, mock_evt))
    result = writer.split_series(
        ical_uid="series@mailagent.local",
        split_recurrence_id_utc=datetime(2026, 2, 2, 9, 0, tzinfo=timezone.utc),
        summary="新系列",
    )
    assert result["action"] == "series_split"
    assert result["new_ical_uid"] != "series@mailagent.local"
    # 老 master 截断 (RRULE 加 UNTIL)
    old = vobject.readOne(mock_evt.data)
    assert "UNTIL=" in old.vevent.rrule.value
    assert "FREQ=WEEKLY" in old.vevent.rrule.value
    # 新 series (cal.save_event 收到新 body)
    new_body = mock_cal.save_event.call_args[0][0]
    new = vobject.readOne(new_body)
    assert new.vevent.summary.value == "新系列"
    assert "FREQ=WEEKLY" in new.vevent.rrule.value
    assert "UNTIL=" not in new.vevent.rrule.value  # 新 series 去 UNTIL
    assert new.vevent.uid.value != "series@mailagent.local"


def test_split_series_count_dropped_in_new_series():
    """COUNT-based series: 老截断保留 (转 UNTIL), 新 series 去 COUNT (近似无限)."""
    writer, mock_evt = _writer_with_recurring_master("FREQ=DAILY;COUNT=20")
    mock_cal = MagicMock()
    writer._find_event_by_uid = MagicMock(return_value=(mock_cal, mock_evt))
    writer.split_series(
        ical_uid="series@mailagent.local",
        split_recurrence_id_utc=datetime(2026, 1, 10, 9, 0, tzinfo=timezone.utc),
    )
    new = vobject.readOne(mock_cal.save_event.call_args[0][0])
    assert "COUNT=" not in new.vevent.rrule.value  # 新 series 不继承 COUNT (近似)
    assert "FREQ=DAILY" in new.vevent.rrule.value


def test_split_series_rejects_non_recurring():
    """非周期 event (master 无 RRULE) → ValueError."""
    master_body = build_vevent(
        ical_uid="single@mailagent.local",
        summary="One-off",
        dtstart_utc=datetime(2026, 1, 5, 9, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 1, 5, 10, tzinfo=timezone.utc),
        organizer_email="me@example.com",
    )
    vcal = vobject.readOne(master_body)
    mock_evt = MagicMock()
    mock_evt.vobject_instance = vcal
    writer = CalDAVWriter.__new__(CalDAVWriter)
    writer.user = "me@example.com"
    writer._find_event_by_uid = MagicMock(return_value=(MagicMock(), mock_evt))
    with pytest.raises(ValueError, match="not a recurring series"):
        writer.split_series(
            ical_uid="single@mailagent.local",
            split_recurrence_id_utc=datetime(2026, 1, 5, 9, tzinfo=timezone.utc),
        )


def test_split_series_step2_failure_rolls_back_old_master():
    """P1-2: 第 2 步 (新 series PUT) 失败 → best-effort 恢复老 master 原 RRULE
    (再 PUT 一次改前内容) + 原异常向上抛, 信息注明已回滚."""
    writer, mock_evt = _writer_with_recurring_master("FREQ=WEEKLY;BYDAY=MO")
    mock_cal = MagicMock()
    mock_cal.save_event.side_effect = RuntimeError("boom: new series PUT failed")
    writer._find_event_by_uid = MagicMock(return_value=(mock_cal, mock_evt))
    with pytest.raises(RuntimeError, match="已回滚老 master") as excinfo:
        writer.split_series(
            ical_uid="series@mailagent.local",
            split_recurrence_id_utc=datetime(2026, 2, 2, 9, 0, tzinfo=timezone.utc),
        )
    # 原异常链保留 (调用方可辨根因)
    assert "boom: new series PUT failed" in str(excinfo.value)
    # 恢复 PUT 发生: save 两次 (第 1 步截断 + 回滚), evt.data 是改前内容 (原 RRULE 无 UNTIL)
    assert mock_evt.save.call_count == 2
    restored = vobject.readOne(mock_evt.data)
    assert restored.vevent.rrule.value == "FREQ=WEEKLY;BYDAY=MO"
    assert "UNTIL=" not in restored.vevent.rrule.value


def test_split_series_step2_and_rollback_both_fail_reports_orig_rrule():
    """P1-2: 第 2 步失败 + 回滚 PUT 也失败 → 异常信息带原 RRULE 字符串
    (供人工修复) 并注明 Exchange 端处于截断态."""
    writer, mock_evt = _writer_with_recurring_master("FREQ=WEEKLY;BYDAY=MO")
    mock_cal = MagicMock()
    mock_cal.save_event.side_effect = RuntimeError("boom: new series PUT failed")
    # 第 1 次 save (截断) 成功, 第 2 次 save (回滚) 失败
    mock_evt.save.side_effect = [None, RuntimeError("restore PUT failed")]
    writer._find_event_by_uid = MagicMock(return_value=(mock_cal, mock_evt))
    with pytest.raises(RuntimeError, match="截断态") as excinfo:
        writer.split_series(
            ical_uid="series@mailagent.local",
            split_recurrence_id_utc=datetime(2026, 2, 2, 9, 0, tzinfo=timezone.utc),
        )
    msg = str(excinfo.value)
    assert "FREQ=WEEKLY;BYDAY=MO" in msg  # 原 RRULE 供人工修复
    assert "boom: new series PUT failed" in msg
    assert "restore PUT failed" in msg
