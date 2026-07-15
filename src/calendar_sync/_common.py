"""Phase 3 / F30+F31 — 跨 calendar_sync + calendar_notion 模块共享 const + helper.

Single source of truth for:
- ``SOURCES_TRY_ORDER`` (caldav → email_ics → legacy_calendar_app fallback 顺序,
  rsvp / replay / cli 都 import 同款)
- RFC 5545 text escape + compact UTC datetime format (itip_reply 跟
  caldav_writer 都用, F31 之前是 itip_reply 私有 + caldav_writer 反向 import).
- tzid 归一/解析 (#10 tzid 半步, reader 落库 + expander 展开 + writer 输出共用).

不要循环依赖 src/calendar_notion/ — 让 calendar_notion 反向 import 这里 OK
(`replay.py` 现在 from src.calendar_sync._common import SOURCES_TRY_ORDER),
但本文件 **不** import calendar_notion 任何东西.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

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


# ---------------------------------------------------------------------------
# tzid 归一 / 解析 (#10 tzid 半步)
# ---------------------------------------------------------------------------

# DavMail 把 Exchange timezone 映射成非 tzdb 名 (生产 ics_raw 实测: "Asia/Beijing"
# 111 行, tzdb 只有 Asia/Shanghai)。按实测按需扩充, 不预铺整张 Windows 名映射表。
_TZID_ALIASES = {
    "Asia/Beijing": "Asia/Shanghai",
}


def normalize_tzid(raw: Optional[str]) -> Optional[str]:
    """VEVENT TZID 参数原始值 → 可被 ZoneInfo 解析的 Olson 名; 解析不了返回 None.

    None 语义 = 纯 UTC (裸 Z) / floating / 未知时区名 —— 消费方 (expander/writer)
    对 None 走现状 UTC 路径, 不猜。
    """
    if not raw:
        return None
    name = str(raw).strip().strip('"')
    if not name:
        return None
    name = _TZID_ALIASES.get(name, name)
    try:
        ZoneInfo(name)
    except Exception:
        return None
    return name


def resolve_zoneinfo(tzid: Optional[str]) -> Optional[ZoneInfo]:
    """Olson 名 → ZoneInfo; 空/解析失败返回 None."""
    if not tzid:
        return None
    try:
        return ZoneInfo(tzid)
    except Exception:
        return None


def local_olson_tzid() -> Optional[str]:
    """本机系统时区的 Olson 名 (macOS/Linux 读 /etc/localtime symlink).

    F1 fallback 用: 事件自身无 TZID (老版写入的裸 Z master) 时以本机时区近似
    邮箱时区 (owner 单机场景两者一致)。拿不到返回 None (调用方退回裸 Z 现状)。
    """
    try:
        link = os.readlink("/etc/localtime")
    except OSError:
        return None
    marker = "zoneinfo/"
    idx = link.find(marker)
    if idx == -1:
        return None
    return normalize_tzid(link[idx + len(marker):])
