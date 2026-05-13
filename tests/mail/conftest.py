"""tests/mail conftest: iCalendar fixture builder + async test support.

通过 pytest_pyfunc_call hook 自动用 asyncio.run 包裹 async def 测试，
避免引入 pytest-asyncio 依赖。
"""
from __future__ import annotations

import asyncio
import inspect
from typing import Iterable, Optional

import pytest


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem):
    func = pyfuncitem.obj
    if not inspect.iscoroutinefunction(func):
        return None
    arg_names = pyfuncitem._fixtureinfo.argnames
    kwargs = {name: pyfuncitem.funcargs[name] for name in arg_names}
    asyncio.run(func(**kwargs))
    return True


def _vevent_block(
    *,
    uid: str,
    method: str,
    summary: str,
    dtstart: str,
    dtend: str,
    tzid: Optional[str],
    rrule: Optional[str],
    exdates: Optional[Iterable[str]],
    rdates: Optional[Iterable[str]],
    recurrence_id: Optional[str],
    sequence: int,
    all_day: bool,
    organizer_cn: str,
    organizer_email: str,
    location: Optional[str],
    description: Optional[str],
    status_value: Optional[str],
) -> str:
    """构造单个 VEVENT 块，返回完整 .ics 文本。"""
    lines = [
        "BEGIN:VCALENDAR",
        "PRODID:-//Test//Test//EN",
        "VERSION:2.0",
        f"METHOD:{method}",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"SEQUENCE:{sequence}",
        f"SUMMARY:{summary}",
    ]

    if all_day:
        lines.append(f"DTSTART;VALUE=DATE:{dtstart}")
        lines.append(f"DTEND;VALUE=DATE:{dtend}")
    elif tzid:
        lines.append(f"DTSTART;TZID={tzid}:{dtstart}")
        lines.append(f"DTEND;TZID={tzid}:{dtend}")
    else:
        lines.append(f"DTSTART:{dtstart}")
        lines.append(f"DTEND:{dtend}")

    if rrule:
        lines.append(f"RRULE:{rrule}")

    if exdates:
        if tzid and not all_day:
            lines.append(f"EXDATE;TZID={tzid}:{','.join(exdates)}")
        else:
            lines.append(f"EXDATE:{','.join(exdates)}")

    if rdates:
        if tzid and not all_day:
            lines.append(f"RDATE;TZID={tzid}:{','.join(rdates)}")
        else:
            lines.append(f"RDATE:{','.join(rdates)}")

    if recurrence_id:
        if tzid and not all_day:
            lines.append(f"RECURRENCE-ID;TZID={tzid}:{recurrence_id}")
        else:
            lines.append(f"RECURRENCE-ID:{recurrence_id}")

    lines.append(f'ORGANIZER;CN="{organizer_cn}":MAILTO:{organizer_email}')
    if location:
        lines.append(f"LOCATION:{location}")
    if description:
        lines.append(f"DESCRIPTION:{description}")
    if status_value:
        lines.append(f"STATUS:{status_value}")

    lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines)


def _wrap_in_email(ical_body: str) -> str:
    """把 .ics 包成 multipart MIME 邮件源码（让 ICalendarParser 能从中提取）。"""
    return (
        "From: organizer@example.com\r\n"
        "To: invitee@example.com\r\n"
        "Subject: Invite\r\n"
        'Content-Type: multipart/alternative; boundary="boundary42"\r\n'
        "MIME-Version: 1.0\r\n"
        "\r\n"
        "--boundary42\r\n"
        "Content-Type: text/plain; charset=UTF-8\r\n"
        "\r\n"
        "Plain text fallback.\r\n"
        "--boundary42\r\n"
        'Content-Type: text/calendar; method=REQUEST; charset=UTF-8\r\n'
        "Content-Transfer-Encoding: 8bit\r\n"
        "\r\n"
        + ical_body
        + "\r\n"
        "--boundary42--\r\n"
    )


@pytest.fixture
def make_ical():
    """返回一个 builder，可生成包含一个 VEVENT 的完整邮件源码字符串。

    DTSTART/DTEND/EXDATE/RDATE/RECURRENCE-ID 的格式：
      - all_day=True: "20260420"
      - 否则:        "20260420T140000"

    用法:
        src = make_ical(uid="evt-1", rrule="FREQ=WEEKLY;BYDAY=TU")
        invite = parser.extract_from_email_source(src)
    """

    def _make(
        *,
        uid: str = "evt-default-uid@example.com",
        method: str = "REQUEST",
        summary: str = "Test meeting",
        dtstart: str = "20260420T140000",
        dtend: str = "20260420T150000",
        tzid: Optional[str] = "China Standard Time",
        rrule: Optional[str] = None,
        exdates: Optional[Iterable[str]] = None,
        rdates: Optional[Iterable[str]] = None,
        recurrence_id: Optional[str] = None,
        sequence: int = 0,
        all_day: bool = False,
        organizer_cn: str = "Alice",
        organizer_email: str = "alice@example.com",
        location: Optional[str] = None,
        description: Optional[str] = None,
        status_value: Optional[str] = None,
        wrap_in_email: bool = True,
    ) -> str:
        ical = _vevent_block(
            uid=uid,
            method=method,
            summary=summary,
            dtstart=dtstart,
            dtend=dtend,
            tzid=tzid,
            rrule=rrule,
            exdates=exdates,
            rdates=rdates,
            recurrence_id=recurrence_id,
            sequence=sequence,
            all_day=all_day,
            organizer_cn=organizer_cn,
            organizer_email=organizer_email,
            location=location,
            description=description,
            status_value=status_value,
        )
        return _wrap_in_email(ical) if wrap_in_email else ical

    return _make
