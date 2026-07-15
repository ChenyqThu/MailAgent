"""#10 tzid 半步 — CalDAVReader._parse_event 的 tzid 提取/归一测试.

DavMail 实测: DTSTART;TZID=Asia/Beijing (非 tzdb 名) / America/Los_Angeles /
Europe/London 三种; 归一经 _common.normalize_tzid (Asia/Beijing→Asia/Shanghai)。
裸 Z / floating / 全天 → None。
"""
from __future__ import annotations

from types import SimpleNamespace

import vobject

from src.calendar_sync.caldav_reader import CalDAVReader


def _parse(ics: str):
    raw = SimpleNamespace(vobject_instance=vobject.readOne(ics))
    return CalDAVReader._parse_event(None, raw, calendar_name="日历", user_email="")


def _ics(dt_lines: str, vtimezone: str = "") -> str:
    return (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"
        + vtimezone
        + "BEGIN:VEVENT\r\nUID:u1\r\nDTSTAMP:20260714T000000Z\r\n"
        + dt_lines
        + "SUMMARY:t\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )


_VTZ_BEIJING = (
    "BEGIN:VTIMEZONE\r\nTZID:Asia/Beijing\r\n"
    "BEGIN:STANDARD\r\nDTSTART:16010101T000000\r\n"
    "TZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n"
)


def test_tzid_davmail_beijing_alias_normalized():
    ev = _parse(_ics(
        "DTSTART;TZID=Asia/Beijing:20260904T160000\r\n"
        "DTEND;TZID=Asia/Beijing:20260904T170000\r\n",
        vtimezone=_VTZ_BEIJING,
    ))
    assert ev is not None
    assert ev.tzid == "Asia/Shanghai"


def test_tzid_bare_z_is_none():
    ev = _parse(_ics("DTSTART:20260904T010000Z\r\nDTEND:20260904T020000Z\r\n"))
    assert ev is not None
    assert ev.tzid is None


def test_tzid_all_day_is_none():
    ev = _parse(_ics(
        "DTSTART;VALUE=DATE:20260904\r\nDTEND;VALUE=DATE:20260905\r\n"
    ))
    assert ev is not None
    assert ev.is_all_day is True
    assert ev.tzid is None
