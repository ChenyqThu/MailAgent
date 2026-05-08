"""周期会议展开器：把一封带 RRULE 的会议邀请展开成多个 CalendarEvent。

核心 API:
    expand_occurrences(invite, *, since, horizon_weeks=4) -> List[CalendarEvent]
    compute_since(now, master_dtstart, last_expanded_until=None) -> datetime
    mint_event_id(uid, occurrence_start) -> str

设计原则：
- 纯函数。不读 SQLite、不调 Notion API。
- since/until 都是 tz-aware datetime；occurrence 时间继承 invite.start_time 的 tzinfo（dateutil 处理 DST）。
- 解析失败 → 返回空 list（调用方退化为单事件路径），不抛异常。
"""
from __future__ import annotations

import json
from copy import copy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from dateutil.rrule import rrulestr
from loguru import logger

from src.mail.icalendar_parser import MeetingInvite
from src.models import CalendarEvent, EventStatus

_BJ_TZ = ZoneInfo("Asia/Shanghai")


def mint_event_id(uid: str, occurrence_start: datetime) -> str:
    """生成 occurrence 的唯一 Event ID = "{uid}@{utc_iso_compact}".

    例: "evt-1@20260427T060000Z"
    """
    if occurrence_start.tzinfo is None:
        # tz-naive 视为 UTC（保守 fallback，不应发生）
        utc = occurrence_start.replace(tzinfo=timezone.utc)
    else:
        utc = occurrence_start.astimezone(timezone.utc)
    return f"{uid}@{utc.strftime('%Y%m%dT%H%M%SZ')}"


def compute_since(
    now: datetime,
    master_dtstart: datetime,
    last_expanded_until: Optional[datetime] = None,
) -> datetime:
    """计算展开的下界。

    since = max(本周一 00:00 北京时间, master_dtstart, last_expanded_until)

    含义：
    - 不展开比 master 还早的实例
    - 不重复展开已经写过的实例（last_expanded_until 高水位）
    - 但允许回填本周已发生的 occurrences（用户视角"本周"）
    """
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    now_bj = now.astimezone(_BJ_TZ)
    monday_bj = (now_bj - timedelta(days=now_bj.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    candidates: List[datetime] = [monday_bj]
    if master_dtstart is not None:
        if master_dtstart.tzinfo is None:
            master_dtstart = master_dtstart.replace(tzinfo=_BJ_TZ)
        candidates.append(master_dtstart)
    if last_expanded_until is not None:
        if last_expanded_until.tzinfo is None:
            last_expanded_until = last_expanded_until.replace(tzinfo=timezone.utc)
        candidates.append(last_expanded_until)

    return max(candidates)


def _parse_iso_to_aware(s: str, fallback_tz: ZoneInfo = _BJ_TZ) -> Optional[datetime]:
    """把 ISO-8601 字符串解析为 tz-aware datetime。"""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=fallback_tz)
    return dt


def expand_occurrences(
    invite: MeetingInvite,
    *,
    since: datetime,
    horizon_weeks: int = 4,
    until: Optional[datetime] = None,
    series_state: Optional[Dict] = None,
) -> List[CalendarEvent]:
    """按 RRULE 展开一段时间窗内的所有 occurrences。

    Args:
        invite: 主邀请（含 RRULE / EXDATE / TZID）
        since: tz-aware lower bound（含）
        horizon_weeks: 默认窗口宽度（周）。仅当 until 未指定时使用
        until: tz-aware upper bound（含）。指定时优先于 horizon_weeks
        series_state: 来自 SyncStore.recurring_series 的行，用于复现持久 EXDATE

    Returns:
        CalendarEvent 列表（不含主系列模板本身），按时间升序
        若 invite 无 RRULE 或解析失败 → 空 list
    """
    if not invite.recurrence_rule:
        return []

    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    if until is None:
        until = since + timedelta(weeks=horizon_weeks)
    elif until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)

    # 合并 invite 自带 EXDATE 与持久化的 EXDATE
    persisted_exdates: List[datetime] = []
    if series_state:
        try:
            persisted_raw = json.loads(series_state.get("exdates_json") or "[]")
        except (json.JSONDecodeError, TypeError):
            persisted_raw = []
        for s in persisted_raw if isinstance(persisted_raw, list) else []:
            dt = _parse_iso_to_aware(s)
            if dt is not None:
                persisted_exdates.append(dt)

    all_exdates: List[datetime] = list(invite.exdates) + persisted_exdates
    all_rdates: List[datetime] = list(invite.rdates)

    try:
        rule = rrulestr(
            f"RRULE:{invite.recurrence_rule}",
            dtstart=invite.start_time,  # tz-aware → rrulestr 继承 tzinfo（DST 由 ZoneInfo 处理）
            forceset=True,
        )
        for ex in all_exdates:
            rule.exdate(ex)
        for rd in all_rdates:
            rule.rdate(rd)
    except (ValueError, KeyError, TypeError) as e:
        logger.warning(
            f"[recurrence] RRULE parse failed UID={invite.uid[:60]}: {e}; "
            f"falling back to single event"
        )
        return []

    duration = invite.end_time - invite.start_time
    out: List[CalendarEvent] = []
    for occ_start in rule.between(since, until, inc=True):
        occ_end = occ_start + duration
        out.append(_clone_master_into_occurrence(invite, occ_start, occ_end))
    return out


def _clone_master_into_occurrence(
    invite: MeetingInvite,
    occ_start: datetime,
    occ_end: datetime,
) -> CalendarEvent:
    """从 master invite 克隆一个 occurrence CalendarEvent。

    继承所有字段，仅覆盖 start_time / end_time / event_id / recurrence_id / master_event_id。
    保留 _raw_description 让 Teams URL 提取每个 occurrence 都生效。
    """
    status_map = {
        "confirmed": EventStatus.CONFIRMED,
        "tentative": EventStatus.TENTATIVE,
        "cancelled": EventStatus.CANCELLED,
    }
    event_id = mint_event_id(invite.uid, occ_start)

    event = CalendarEvent(
        event_id=event_id,
        calendar_name="Email Invite",
        title=invite.summary,
        start_time=occ_start,
        end_time=occ_end,
        is_all_day=invite.is_all_day,
        location=invite.location,
        description=invite.description,
        url=invite.teams_url,
        status=status_map.get(invite.status, EventStatus.TENTATIVE),
        organizer=invite.organizer,
        organizer_email=invite.organizer_email,
        attendees=list(invite.attendees),
        is_recurring=True,
        recurrence_rule=invite.recurrence_rule,
        recurrence_id=occ_start,
        master_event_id=invite.uid,
        original_start=occ_start,
        last_modified=datetime.now(_BJ_TZ),
    )
    # 与 ICalendarParser.to_calendar_event 同模式: 保留 _raw_description
    event._raw_description = invite.description
    return event
