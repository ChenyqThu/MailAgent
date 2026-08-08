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

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from loguru import logger

if TYPE_CHECKING:
    from src.calendar_sync.caldav_reader import CalendarEvent
    from src.calendar_sync.repository import CalendarEventRepository


@dataclass
class ReconcileStats:
    """Reconcile 单次跑的统计 (worker log / sync_state 用)."""

    upserted: int = 0
    soft_deleted: int = 0
    skipped_no_uid: int = 0
    errors: int = 0
    changed: list["CalendarChange"] = field(default_factory=list)


@dataclass(frozen=True)
class CalendarChange:
    ical_uid: str
    recurrence_id: Optional[str]
    calendar_name: str
    change_kind: str
    changed_fields: list[str]
    business_hash: str


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
        track_changes: bool = False,
    ) -> ReconcileStats:
        """全窗口 reconcile.

        语义: events 是 CalDAV 端在 [window_start, window_end) 内的全量真实快照.
        - Upsert events 里每个 event.
        - 扫 SQLite 同窗口同 calendar_name 的 'caldav' rows, 把不在 events 里的 soft_delete.

        soft-delete 决策只看 ical_uid (主事件) — occurrence 跳脱(recurrence_id 非空)
        默认跟随主事件; 真要单独处理 single-occurrence 删除等 reconcile_incremental.
        """
        stats = ReconcileStats()
        track_changes = track_changes and self.repo.get_sync_state(calendar_name) is not None

        # 1. Upsert 所有 events
        seen_uids: set[str] = set()
        for ev in events:
            if not ev.ical_uid:
                stats.skipped_no_uid += 1
                continue
            try:
                previous = (
                    self.repo.get_by_ical_uid(
                        ev.ical_uid,
                        source="caldav",
                        recurrence_id=ev.recurrence_id,
                        include_deleted=True,
                    )
                    if track_changes
                    else None
                )
                self.repo.upsert_from_caldav_event(ev, source="caldav")
                stats.upserted += 1
                seen_uids.add(ev.ical_uid)
                if track_changes:
                    from src.calendar_sync.business_hash import (
                        business_content_hash,
                        changed_business_fields,
                    )

                    digest = business_content_hash(ev)
                    if previous is None:
                        stats.changed.append(CalendarChange(
                            ev.ical_uid, ev.recurrence_id, calendar_name,
                            "created", list(changed_business_fields(ev, ev)), digest,
                        ))
                    else:
                        fields = changed_business_fields(previous, ev)
                        if fields or previous.deleted_at is not None:
                            stats.changed.append(CalendarChange(
                                ev.ical_uid, ev.recurrence_id, calendar_name,
                                "updated", fields, digest,
                            ))
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
            # F10 + F23 — soft_delete 候选:
            # (a) 单次 event dtstart 在窗口内
            # (b) RRULE master event (F10): 即使 dtstart 远早于窗口, CalDAV
            #     reader 用 expand=False 列窗口 events 时会返回所有 master,
            #     不在 seen_uids 即真被删 → 漏掉 master → 前端 expander 持续
            #     展开"幽灵会议"
            # (c) occurrence override (recurrence_id 非空, F23): 用户单删
            #     一个 occurrence, Exchange 端会自动加 EXDATE 到 master, 但
            #     本地 occurrence override row 仍 stuck (dtstart 可能在窗口
            #     外没被原 in_window 判定 cover). 加 recurrence_id 非空也
            #     进入 candidate, 跟 master 平行处理.
            is_in_window = r.dtstart_utc < we and (
                r.dtend_utc is None or r.dtend_utc >= ws
            )
            is_rrule_master = bool(r.rrule)
            is_occurrence_override = r.recurrence_id is not None
            if not (is_in_window or is_rrule_master or is_occurrence_override):
                continue
            try:
                affected = self.repo.soft_delete(
                    ical_uid=r.ical_uid,
                    source="caldav",
                    recurrence_id=r.recurrence_id,
                )
                stats.soft_deleted += affected
                if track_changes and affected:
                    from src.calendar_sync.business_hash import deleted_business_content_hash

                    stats.changed.append(CalendarChange(
                        r.ical_uid, r.recurrence_id, r.calendar_name,
                        "deleted", [], deleted_business_content_hash(r),
                    ))
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
        track_changes: bool = False,
    ) -> ReconcileStats:
        """增量 reconcile — sync-collection 报告了哪些变了 / 哪些删了, 直接应用."""
        stats = ReconcileStats()
        track_changes = track_changes and self.repo.get_sync_state(calendar_name) is not None

        for ev in changed_events:
            if not ev.ical_uid:
                stats.skipped_no_uid += 1
                continue
            try:
                previous = (
                    self.repo.get_by_ical_uid(
                        ev.ical_uid,
                        source="caldav",
                        recurrence_id=ev.recurrence_id,
                        include_deleted=True,
                    )
                    if track_changes
                    else None
                )
                self.repo.upsert_from_caldav_event(ev, source="caldav")
                stats.upserted += 1
                if track_changes:
                    from src.calendar_sync.business_hash import (
                        business_content_hash,
                        changed_business_fields,
                    )

                    digest = business_content_hash(ev)
                    if previous is None:
                        stats.changed.append(CalendarChange(
                            ev.ical_uid, ev.recurrence_id, calendar_name,
                            "created", [], digest,
                        ))
                    else:
                        fields = changed_business_fields(previous, ev)
                        if fields or previous.deleted_at is not None:
                            stats.changed.append(CalendarChange(
                                ev.ical_uid, ev.recurrence_id, calendar_name,
                                "updated", fields, digest,
                            ))
            except Exception as e:
                logger.warning(
                    f"[reconciler-inc] upsert failed for uid={ev.ical_uid!r}: {e}"
                )
                stats.errors += 1

        for uid in deleted_uids:
            if not uid:
                continue
            try:
                previous = (
                    self.repo.get_by_ical_uid(
                        uid, source="caldav", recurrence_id=None, include_deleted=True
                    )
                    if track_changes
                    else None
                )
                affected = self.repo.soft_delete(
                    ical_uid=uid, source="caldav", recurrence_id=None
                )
                stats.soft_deleted += affected
                if track_changes and affected and previous is not None:
                    from src.calendar_sync.business_hash import deleted_business_content_hash

                    stats.changed.append(CalendarChange(
                        previous.ical_uid, previous.recurrence_id,
                        previous.calendar_name, "deleted", [],
                        deleted_business_content_hash(previous),
                    ))
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
