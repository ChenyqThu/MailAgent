"""expand_in_window — RRULE 展开到时间窗口内的 occurrence list.

复用思路跟 src/calendar_notion/recurrence.py 一致 (dateutil.rrule), 但接口面向
calendar_event 表的字段形态 (dtstart/dtend datetime + rrule string + exdates/rdates
ISO list), 而不是 ICalendarParser.Invite 对象.

为什么不直接用 recurrence.py:
- recurrence.py 接受 Invite (含 dtstart_tz / vTIMEZONE), 这里 calendar_event 表
  时间已经归一 UTC, 没有 tz blob 可用.
- 调用语义不同: recurrence.py 输出 dt list (无 end), expander 输出 (start, end) 元组对.

DST 处理: dateutil rrulestr 接受 tz-aware dtstart 时自动处理 DST 滚动.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

from loguru import logger


def _parse_iso(iso: str) -> Optional[datetime]:
    """ISO 字符串 → tz-aware UTC datetime; 失败 None."""
    if not iso:
        return None
    try:
        # Python 3.11+ 支持 'Z' 后缀; 兼容 +00:00 写法
        if iso.endswith("Z"):
            iso = iso[:-1] + "+00:00"
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError) as e:
        logger.debug(f"[expander] _parse_iso({iso!r}) failed: {e}")
        return None


def expand_in_window(
    *,
    dtstart: datetime,
    dtend: Optional[datetime],
    rrule: str,
    exdates_iso: List[str],
    rdates_iso: List[str],
    window_start: datetime,
    window_end: datetime,
    max_count: int = 500,
) -> List[Tuple[datetime, datetime]]:
    """展开 RRULE 在 [window_start, window_end) 内的所有 occurrences.

    Args:
        dtstart: 主事件起始 (tz-aware UTC).
        dtend: 主事件结束 (tz-aware UTC); 留空用 dtstart + 1h.
        rrule: RFC 5545 RRULE 字符串 (不含 "RRULE:" 前缀, 直接 FREQ=...).
        exdates_iso: 跳过日期 list (ISO 字符串 with tz).
        rdates_iso: 额外发生日期 list (ISO 字符串).
        window_start / window_end: 窗口边界 (tz-aware UTC).
        max_count: 安全上限 — 防 RRULE 无 UNTIL/COUNT 时无限展开撑爆内存.

    Returns:
        List of (occ_start_utc, occ_end_utc) 元组对, 按 occ_start 升序.
        每个 occurrence 持续时间 = dtend - dtstart.
    """
    # Normalize timezones
    if dtstart.tzinfo is None:
        dtstart = dtstart.replace(tzinfo=timezone.utc)
    dtstart = dtstart.astimezone(timezone.utc)
    if dtend is None:
        duration = timedelta(hours=1)
    else:
        if dtend.tzinfo is None:
            dtend = dtend.replace(tzinfo=timezone.utc)
        duration = dtend.astimezone(timezone.utc) - dtstart
    if duration <= timedelta(0):
        duration = timedelta(hours=1)

    if window_start.tzinfo is None:
        window_start = window_start.replace(tzinfo=timezone.utc)
    if window_end.tzinfo is None:
        window_end = window_end.replace(tzinfo=timezone.utc)
    window_start = window_start.astimezone(timezone.utc)
    window_end = window_end.astimezone(timezone.utc)

    if not rrule:
        # 单次 event — 落窗口判一次
        if dtstart < window_end and dtstart + duration > window_start:
            return [(dtstart, dtstart + duration)]
        return []

    # dateutil.rrule.rrulestr 接受 RRULE:... 或 FREQ=... 两种; 容忍前缀
    rrule_clean = rrule.strip()
    if rrule_clean.upper().startswith("RRULE:"):
        rrule_clean = rrule_clean[6:]
    rrule_str = f"RRULE:{rrule_clean}"

    try:
        from dateutil.rrule import rrulestr
    except ImportError as e:
        logger.error(f"[expander] dateutil not installed: {e}")
        return [(dtstart, dtstart + duration)] if (
            dtstart < window_end and dtstart + duration > window_start
        ) else []

    try:
        rule = rrulestr(rrule_str, dtstart=dtstart)
    except (ValueError, TypeError) as e:
        logger.warning(
            f"[expander] rrulestr failed for {rrule!r}: {e} — fallback to single occurrence"
        )
        if dtstart < window_end and dtstart + duration > window_start:
            return [(dtstart, dtstart + duration)]
        return []

    # 展开窗口内 — dateutil 接受 between(after, before, inc=True) 但要明确边界
    # 把 window_start 往前推 duration 防止"事件起始在窗口前但结束在窗口内"漏掉
    expand_after = window_start - duration
    try:
        candidates = list(rule.between(expand_after, window_end, inc=True))
    except Exception as e:
        logger.warning(f"[expander] rule.between failed: {e}")
        return []

    # 防御性 cap
    if len(candidates) > max_count:
        logger.warning(
            f"[expander] RRULE {rrule!r} yielded {len(candidates)} occurrences "
            f"> max_count={max_count}; truncating"
        )
        candidates = candidates[:max_count]

    # 套用 EXDATE — 跳过指定日期 (date 比较容忍秒级浮动 ±60s)
    exdate_set: set = set()
    for ex_iso in (exdates_iso or []):
        ex_dt = _parse_iso(ex_iso)
        if ex_dt is not None:
            exdate_set.add(ex_dt.replace(microsecond=0))

    # 套用 RDATE — 额外发生日期 (合并到 candidates)
    for rd_iso in (rdates_iso or []):
        rd_dt = _parse_iso(rd_iso)
        if rd_dt is not None and window_start <= rd_dt < window_end:
            candidates.append(rd_dt)

    # 去重 + 排序 + EXDATE 过滤
    seen: set = set()
    occurrences: List[Tuple[datetime, datetime]] = []
    for occ_start in sorted(candidates):
        if occ_start.tzinfo is None:
            occ_start = occ_start.replace(tzinfo=timezone.utc)
        occ_start = occ_start.astimezone(timezone.utc)
        # 跳 EXDATE
        if occ_start.replace(microsecond=0) in exdate_set:
            continue
        # 跳重复
        key = occ_start.replace(microsecond=0)
        if key in seen:
            continue
        seen.add(key)
        occ_end = occ_start + duration
        # 最终 overlap 判定 (单次)
        if occ_start < window_end and occ_end > window_start:
            occurrences.append((occ_start, occ_end))

    return occurrences
