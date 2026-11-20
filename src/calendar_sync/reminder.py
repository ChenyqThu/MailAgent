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
from typing import Any, TYPE_CHECKING, Optional
from urllib.parse import urlparse

from loguru import logger

from src.notify.prefs import (
    DEFAULT_NOTIFICATION_PREFS,
    MEETING_PREP_PRESET_AGENT_ID,
    has_saved_notification_prefs,
    load_notification_prefs,
    lookup_meeting_prep_session,
)

if TYPE_CHECKING:
    from src.calendar_sync.repository import CalendarEventRepository
    from src.notify.center import NotifyCenter

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


def _build_meeting_actions(
    *,
    prefs: dict[str, Any],
    db_path: Any,
    ical_uid: str,
    recurrence_id: Optional[str],
    occurrence_start_iso: str,
    summary_text: str,
    join_url: str,
) -> list[dict[str, Any]]:
    """Build up to 2 compact notification actions for a calendar reminder."""
    if not prefs.get("meetingActionsEnabled", True):
        return []
    actions: list[dict[str, Any]] = []
    if join_url:
        actions.append({"id": "join_meeting", "label": "一键入会", "url": join_url})
    else:
        actions.append(
            {
                "id": "open_calendar_ai",
                "label": "AI 跟进此会",
                "icalUid": ical_uid,
                "recurrenceId": recurrence_id,
                "occurrenceStartIso": occurrence_start_iso,
                "meetingSummary": summary_text,
            }
        )

    if prefs.get("meetingPrepEnabled"):
        prep = (
            lookup_meeting_prep_session(db_path, ical_uid, occurrence_start_iso)
            if db_path
            else None
        )
        if prep is not None:
            actions.append(
                {
                    "id": "meeting_prep",
                    "label": "查看会前准备",
                    "icalUid": ical_uid,
                    "recurrenceId": recurrence_id,
                    "occurrenceStartIso": occurrence_start_iso,
                    "meetingSummary": summary_text,
                    "prepSessionId": int(prep["session_id"]),
                    "agentId": str(prep.get("agent_id") or MEETING_PREP_PRESET_AGENT_ID),
                }
            )
        else:
            actions.append(
                {
                    "id": "meeting_prep",
                    "label": "立即会前准备",
                    "icalUid": ical_uid,
                    "recurrenceId": recurrence_id,
                    "occurrenceStartIso": occurrence_start_iso,
                    "meetingSummary": summary_text,
                }
            )
    elif join_url:
        actions.append(
            {
                "id": "open_calendar_ai",
                "label": "AI 跟进此会",
                "icalUid": ical_uid,
                "recurrenceId": recurrence_id,
                "occurrenceStartIso": occurrence_start_iso,
                "meetingSummary": summary_text,
            }
        )
    return actions[:2]


class MeetingReminder:
    """会前 N 分钟 (默认 10) 推 NotifyCenter 提醒, 同 occurrence 只发一次.

    跳过: 已开始 / 全天事件 (会前 10 分钟 = 半夜, 纯噪音) / CANCELLED /
    本人已 DECLINED.
    """

    def __init__(
        self,
        repo: "CalendarEventRepository",
        *,
        lead_minutes: int = 10,
        notify_center: Optional["NotifyCenter"] = None,
    ):
        self.repo = repo
        self._lead_minutes_arg = max(1, int(lead_minutes))
        self.lead = timedelta(minutes=self._lead_minutes_arg)
        # occurrence key → 开始时间 epoch (清理用). 进程级, 重启丢失 (见模块注释).
        self._center_notified: dict[str, float] = {}
        if notify_center is not None:
            self._notify_center: Optional["NotifyCenter"] = notify_center
        elif getattr(repo, "db_path", None):
            from src.notify.center import NotifyCenter

            self._notify_center = NotifyCenter(repo.db_path)
        else:
            self._notify_center = None

    def tick(self, now: Optional[datetime] = None) -> int:
        """检查 (now, now+lead] 窗口内的 occurrences, 返回本轮发布提醒数. 永不抛."""
        if self._notify_center is None:
            return 0
        db_path = getattr(self.repo, "db_path", None)
        prefs = load_notification_prefs(db_path) if db_path else dict(DEFAULT_NOTIFICATION_PREFS)
        delivery = str(prefs.get("meetingDelivery") or "both")
        if delivery == "off":
            return 0
        lead = (
            timedelta(minutes=int(prefs["meetingLeadMinutes"]))
            if db_path and has_saved_notification_prefs(db_path)
            else self.lead
        )
        now = now or datetime.now(timezone.utc)
        try:
            occs = self.repo.list_event_occurrences(now, now + lead)
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
            occ_iso = start.isoformat()
            key = f"{row.ical_uid}|{occ_iso}"
            if key in self._center_notified:
                continue
            local_start = start.astimezone()
            local_end = occ.occurrence_end_utc.astimezone()
            time_range_text = f"{local_start:%H:%M} – {local_end:%H:%M}"
            join_url = extract_join_url(row.url, row.location, row.description)
            location_text = (row.location or "").strip()
            body_text = f"{time_range_text} · {location_text}" if location_text else time_range_text
            summary_text = (row.summary or "即将开始的会议")[:120]
            search_params: dict[str, Any] = {
                "view": "today",
                "icalUid": row.ical_uid,
                "dateIso": occ_iso,
                "openDrawer": True,
            }
            if row.recurrence_id:
                search_params["recurrenceId"] = row.recurrence_id
            payload: dict[str, Any] = {
                "delivery": delivery,
                "icalUid": row.ical_uid,
                "occurrenceStartIso": occ_iso,
                "link": {"type": "route", "to": "/admin/calendar", "search": search_params},
            }
            if row.recurrence_id:
                payload["recurrenceId"] = row.recurrence_id
            if join_url:
                payload["joinUrl"] = join_url
            actions = _build_meeting_actions(
                prefs=prefs,
                db_path=db_path,
                ical_uid=row.ical_uid,
                recurrence_id=row.recurrence_id,
                occurrence_start_iso=occ_iso,
                summary_text=summary_text,
                join_url=join_url,
            )
            if actions:
                payload["actions"] = actions
            publish_kwargs: dict[str, Any] = {}
            if delivery == "system_only":
                publish_kwargs["system_only"] = True
            try:
                self._notify_center.publish(
                    category="action_required",
                    source="calendar_reminder",
                    severity="warn",
                    title=summary_text,
                    body=body_text[:240],
                    dedupe_key=f"calendar_reminder:{row.ical_uid}:{occ_iso}",
                    payload=payload,
                    **publish_kwargs,
                )
                self._center_notified[key] = start.timestamp()
                fired += 1
            except Exception as e:  # noqa: BLE001
                logger.debug(f"[calendar-reminder] NotifyCenter publish skipped: {e}")

        # 会议开始 1h 后清掉幂等标记, 防长跑进程 dict 无界增长
        cutoff = now.timestamp() - 3600
        for k in [k for k, ts in self._center_notified.items() if ts < cutoff]:
            self._center_notified.pop(k, None)
        if fired:
            logger.info(f"[calendar-reminder] dispatched {fired} meeting reminder(s)")
        return fired
