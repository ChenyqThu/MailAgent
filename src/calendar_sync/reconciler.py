"""CalendarReconciler — CalDAV diff → SQLite upsert / soft-delete.

Phase 1 (plan §1.3): 把 CalDAV reader 拿到的 CalendarEvent list 跟 SQLite
calendar_event 表当前 'caldav' source 的快照对比, 应用增量到本地表.

两种入口:
1. ``reconcile_full_window(events, calendar_name, start, end)`` — 全量 sync 后调用;
   把窗口内 CalDAV side 没出现的 local 行都 soft-delete (服务端删除检测).
2. ``reconcile_incremental(changed_events, deleted_uids, calendar_name)`` —
   RFC 6578 sync-collection 拿到 delta 后调用; 不做"哪些没出现"的扫描.

设计要点:
- 只动 source='caldav' 的行 — 不碰 email_ics / legacy_calendar_app 的 (灰度共存).
- soft_delete 是 idempotent (deleted_at 已设的行不重设).
- upsert 全部走 repository.upsert_from_caldav_event (ON CONFLICT 路径).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from loguru import logger

if TYPE_CHECKING:
    from src.calendar_notion.caldav_reader import CalendarEvent
    from src.calendar_sync.repository import CalendarEventRepository


@dataclass
class ReconcileStats:
    """Reconcile 单次跑的统计 (worker log / sync_state 用)."""

    upserted: int = 0
    soft_deleted: int = 0
    skipped_no_uid: int = 0
    errors: int = 0


class CalendarReconciler:
    """无状态的 diff 应用器. 依赖 repository 做实际 IO."""

    def __init__(self, repo: "CalendarEventRepository"):
        self.repo = repo

    # --------------------------------------------------------
    # Full-window reconcile (启动 + ctag 变化降级)
    # --------------------------------------------------------

    def reconcile_full_window(
        self,
        events: list["CalendarEvent"],
        *,
        calendar_name: str,
        window_start: datetime,
        window_end: datetime,
    ) -> ReconcileStats:
        """全窗口 reconcile.

        语义: events 是 CalDAV 端在 [window_start, window_end) 内的全量真实快照.
        - Upsert events 里每个 event.
        - 扫 SQLite 同窗口同 calendar_name 的 'caldav' rows, 把不在 events 里的 soft_delete.

        soft-delete 决策只看 ical_uid (主事件) — occurrence 跳脱(recurrence_id 非空)
        默认跟随主事件; 真要单独处理 single-occurrence 删除等 reconcile_incremental.
        """
        stats = ReconcileStats()

        # 1. Upsert 所有 events
        seen_uids: set[str] = set()
        for ev in events:
            if not ev.ical_uid:
                stats.skipped_no_uid += 1
                continue
            try:
                self.repo.upsert_from_caldav_event(ev, source="caldav")
                stats.upserted += 1
                seen_uids.add(ev.ical_uid)
            except Exception as e:
                logger.warning(
                    f"[reconciler] upsert failed for uid={ev.ical_uid!r}: {e}"
                )
                stats.errors += 1

        # 2. 扫本地 same-calendar 'caldav' rows, 找窗口内但不在 seen_uids 里的
        local_rows = self.repo.list_event_rows(
            source="caldav",
            calendar_name=calendar_name,
            include_deleted=False,
        )

        ws = window_start.astimezone(timezone.utc) if window_start.tzinfo else window_start.replace(tzinfo=timezone.utc)
        we = window_end.astimezone(timezone.utc) if window_end.tzinfo else window_end.replace(tzinfo=timezone.utc)

        for r in local_rows:
            if r.ical_uid in seen_uids:
                continue
            # 只 soft-delete 落在窗口内的, 窗外的可能是历史/未来 RRULE master 不该清
            if r.dtstart_utc < we and (r.dtend_utc is None or r.dtend_utc >= ws):
                try:
                    affected = self.repo.soft_delete(
                        ical_uid=r.ical_uid,
                        source="caldav",
                        recurrence_id=r.recurrence_id,
                    )
                    stats.soft_deleted += affected
                except Exception as e:
                    logger.warning(
                        f"[reconciler] soft_delete failed for uid={r.ical_uid!r}: {e}"
                    )
                    stats.errors += 1

        logger.info(
            f"[reconciler] full-window {calendar_name!r}: "
            f"upserted={stats.upserted} soft_deleted={stats.soft_deleted} "
            f"skipped_no_uid={stats.skipped_no_uid} errors={stats.errors}"
        )
        return stats

    # --------------------------------------------------------
    # Incremental reconcile (RFC 6578 sync-collection 路径)
    # --------------------------------------------------------

    def reconcile_incremental(
        self,
        changed_events: list["CalendarEvent"],
        deleted_uids: list[str],
        *,
        calendar_name: str,
    ) -> ReconcileStats:
        """增量 reconcile — sync-collection 报告了哪些变了 / 哪些删了, 直接应用."""
        stats = ReconcileStats()

        for ev in changed_events:
            if not ev.ical_uid:
                stats.skipped_no_uid += 1
                continue
            try:
                self.repo.upsert_from_caldav_event(ev, source="caldav")
                stats.upserted += 1
            except Exception as e:
                logger.warning(
                    f"[reconciler-inc] upsert failed for uid={ev.ical_uid!r}: {e}"
                )
                stats.errors += 1

        for uid in deleted_uids:
            if not uid:
                continue
            try:
                affected = self.repo.soft_delete(
                    ical_uid=uid, source="caldav", recurrence_id=None
                )
                stats.soft_deleted += affected
            except Exception as e:
                logger.warning(
                    f"[reconciler-inc] soft_delete failed for uid={uid!r}: {e}"
                )
                stats.errors += 1

        logger.info(
            f"[reconciler-inc] {calendar_name!r}: "
            f"upserted={stats.upserted} soft_deleted={stats.soft_deleted} "
            f"errors={stats.errors}"
        )
        return stats
