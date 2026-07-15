"""会前灵动岛提醒 (epic 阶段2·2.5) — CalendarSyncWorker tick 顺路检查.

设计取舍 (写在前面):
- **调度不开新进程/线程族**: 挂在 CalendarSyncWorker 60s poll loop 的 ``_tick()``
  末尾顺路跑. worker 关 (CALENDAR_CALDAV_SYNC_ENABLED=false) = 无日历数据 =
  无可提醒, 语义自洽; poll 60s ≪ lead 10min, 不会漏提醒窗口.
- **幂等 = 进程级 dict** (occurrence key → 会议开始 epoch, 开始 1h 后清理).
  重启丢失可接受: island_dispatch 层还有 (session_key, event_type) 300s 持久
  去重兜底 — 重启后 5 分钟内不对同一 occurrence 重发; 超 5 分钟且会议仍未开始
  则补发一张 (提醒重于静默, 可容忍).
- **门控**: ``island_dispatch.is_enabled()`` (= PING_ISLAND_ENABLED + service
  init) off → 整条 inert 且**不标记已提醒** (运行中打开仍能补发). 无岛 (socket
  不存在 / ping-island 未跑) 由 ping_island fail-open 静默, 不需感知.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Optional
from urllib.parse import urlparse

from loguru import logger

if TYPE_CHECKING:
    from src.calendar_sync.repository import CalendarEventRepository

_URL_RE = re.compile(r"https://[^\s<>\"'`]+")
_TRAILING_PUNCT = ")]}>.,;:!?"
_ZOOM_PATH_RE = re.compile(r"^/(j|w|s|my)/")


def _is_meeting_url(url: str) -> bool:
    """镜像前端 calendar/lib/meeting-link.ts 的 classify 判定 (Teams/Zoom/Meet)."""
    try:
        u = urlparse(url)
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    path = u.path or ""
    if host in ("teams.microsoft.com", "teams.live.com") and (
        path.startswith("/l/meetup-join") or path.startswith("/meet")
    ):
        return True
    if (host == "zoom.us" or host.endswith(".zoom.us")) and _ZOOM_PATH_RE.match(path):
        return True
    if host == "meet.google.com" and len(path) > 1:
        return True
    return False


def extract_join_url(*texts: Optional[str]) -> str:
    """按传入顺序 (url → location → description) 扫第一个会议 https 链接.

    岛卡文案/metadata 用 https 原链 (卡片无按钮, msteams deeplink 的打开语义
    在前端 Join 按钮); 无命中返回空串.
    """
    for text in texts:
        if not text:
            continue
        for m in _URL_RE.findall(text):
            url = m.rstrip(_TRAILING_PUNCT)
            if _is_meeting_url(url):
                return url
    return ""


class MeetingReminder:
    """会前 N 分钟 (默认 10) 推灵动岛提醒卡, 同 occurrence 只发一次.

    跳过: 已开始 / 全天事件 (会前 10 分钟 = 半夜, 纯噪音) / CANCELLED /
    本人已 DECLINED.
    """

    def __init__(self, repo: "CalendarEventRepository", *, lead_minutes: int = 10):
        self.repo = repo
        self.lead = timedelta(minutes=max(1, int(lead_minutes)))
        # occurrence key → 开始时间 epoch (清理用). 进程级, 重启丢失 (见模块注释).
        self._notified: dict[str, float] = {}

    def tick(self, now: Optional[datetime] = None) -> int:
        """检查 (now, now+lead] 窗口内的 occurrences, 返回本轮发卡数. 永不抛."""
        from src.notify import island_dispatch

        if not island_dispatch.is_enabled():
            return 0
        now = now or datetime.now(timezone.utc)
        try:
            occs = self.repo.list_event_occurrences(now, now + self.lead)
        except Exception as e:  # noqa: BLE001
            logger.debug(f"[calendar-reminder] occurrence query failed (fail-open): {e}")
            return 0

        fired = 0
        for occ in occs:
            row = occ.row
            start = occ.occurrence_start_utc
            if start <= now:
                continue
            if row.is_all_day:
                continue
            if (row.status or "").upper() == "CANCELLED":
                continue
            if (row.response_status or "").upper() == "DECLINED":
                continue
            key = f"{row.ical_uid}|{start.isoformat()}"
            if key in self._notified:
                continue
            local_start = start.astimezone()
            local_end = occ.occurrence_end_utc.astimezone()
            island_dispatch.dispatch_meeting_reminder(
                ical_uid=row.ical_uid,
                occurrence_start_iso=start.isoformat(),
                summary=row.summary or "",
                time_range_text=f"{local_start:%H:%M} – {local_end:%H:%M}",
                join_url=extract_join_url(row.url, row.location, row.description),
                location=row.location or "",
            )
            self._notified[key] = start.timestamp()
            fired += 1

        # 会议开始 1h 后清掉幂等标记, 防长跑进程 dict 无界增长
        cutoff = now.timestamp() - 3600
        for k in [k for k, ts in self._notified.items() if ts < cutoff]:
            self._notified.pop(k, None)
        if fired:
            logger.info(f"[calendar-reminder] dispatched {fired} meeting reminder(s)")
        return fired
