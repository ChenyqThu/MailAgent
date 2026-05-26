"""Phase 3 / F30+F31 — 跨 calendar_sync + calendar_notion 模块共享 const + helper.

Single source of truth for:
- ``SOURCES_TRY_ORDER`` (caldav → email_ics → legacy_calendar_app fallback 顺序,
  rsvp / replay / cli 都 import 同款)
- RFC 5545 text escape + compact UTC datetime format (itip_reply 跟
  caldav_writer 都用, F31 之前是 itip_reply 私有 + caldav_writer 反向 import).

不要循环依赖 src/calendar_notion/ — 让 calendar_notion 反向 import 这里 OK
(`replay.py` 现在 from src.calendar_sync._common import SOURCES_TRY_ORDER),
但本文件 **不** import calendar_notion 任何东西.
"""
from __future__ import annotations

from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Source fallback order (F30 promote)
# ---------------------------------------------------------------------------

# CalendarEvent row.source 枚举值, 跟 SQL CHECK 约束 + 前端 CalendarEventSource
# type 一致.
#
# RSVP / replay / cli 路径 "没指定 source 时按这个顺序 fallback 找 row":
# - caldav 是 Phase 1 后的 SSoT, 90%+ row 是此
# - email_ics 是 Phase 0 邮件 .ics 派生, 少量保留
# - legacy_calendar_app 是 Phase 1 之前老 calendar_main.py 跑出来的, Phase 3
#   下线后会清
SOURCES_TRY_ORDER = ("caldav", "email_ics", "legacy_calendar_app")


# ---------------------------------------------------------------------------
# RFC 5545 helpers (F31 promote from itip_reply._escape_text / _fmt_utc)
# ---------------------------------------------------------------------------

def escape_text(s: str) -> str:
    """RFC 5545 §3.3.11 TEXT escape — backslash / semicolon / comma / newline.

    iCalendar 文本字段 (SUMMARY / DESCRIPTION / LOCATION 等) 必须 escape 这
    几个字符, 否则 parser 会把 ``;`` 当 param 分隔符 / ``,`` 当多值分隔符 /
    raw newline 直接破坏 line folding.
    """
    return (
        s.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
        .replace("\r", "")
    )


def fmt_utc_compact(dt: datetime) -> str:
    """UTC datetime → RFC 5545 form ``YYYYMMDDTHHMMSSZ``.

    DTSTART / DTEND / DTSTAMP / RECURRENCE-ID / EXDATE / RDATE 都用此格式
    (跟 ``VALUE=DATE-TIME`` 默认值兼容). naive datetime 当 UTC 处理.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y%m%dT%H%M%SZ")
