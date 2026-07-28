"""src/calendar_sync/service.py — CalendarService 业务逻辑 facade.

Phase 3 §P1-a: 13 个 CLI subcommand + 多个 IPC handler 各自直接构造
``CalendarEventRepository`` / ``CalDAVReader`` / ``CalDAVWriter`` / 调
``send_rsvp`` / ``discover_recurring`` / ``replay_calendar_event``. CLI / IPC 复用
大量 boilerplate (repo 构造, source 校验, source try-order fallback, dry-run
plan 拼装, occurrence ↔ dict 映射).

``CalendarService`` 把核心业务逻辑抽到单一 entrypoint:

- CLI 层降到 ~40 行/subcommand 做 parse args + format response
- IPC handler 后端 Python 复用同 API (前端 Electron 仍走 callCli fork CLI,
  不改 wire; 但语义对齐)
- pytest 直接测 service 不再要拼 typer Context

设计要点:
- **服务无状态**: 每个方法 input-output 纯函数. ``repo`` lazy 单例 (Phase 3
  §P1-d 后会带 connection pool).
- **返回 dict**, 跟 CLI ``emit()`` 的 data 形状一一对应 — 上层只 emit, 不
  重映射.
- **异常**: 业务层抛 ``ValueError`` (参数非法 / 不存在); CalDAV/SMTP 失败抛
  原异常 (`smtplib.SMTPException` / `requests.HTTPError` 等). 上层 (CLI) 各自
  map 到 ``CliNotFoundError`` / ``CliError``.
- **auth 不属于 service** — service 是纯 business logic, auth 是 caller 关心
  (CLI ``cli.require_auth()``; IPC ``safeIpcHandle``).

参考: ``src/notion/sync.py`` 的 ``NotionSync`` facade + ``PageOps`` /
``ThreadOps`` / ``QueryOps`` 拆法.
"""
from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from src.calendar_sync import CalendarEventRepository
from src.calendar_sync._common import SOURCES_TRY_ORDER

if TYPE_CHECKING:
    from src.calendar_sync.repository import (
        CalendarEventOccurrence,
        CalendarEventRow,
    )
    from src.config import Config
    from src.mail.sync_store import SyncStore


# ---------------------------------------------------------------------------
# Public constants (CLI / IPC 共享枚举)
# ---------------------------------------------------------------------------

# 🔴 值域单源自 src/calendar_sync/_common.SOURCES_TRY_ORDER（issue #68 —— 此前全仓
# 六处各写一份同样的三元组，加/改一个 source 漏改任一处都不报错）。tuple 的**顺序**
# 另有语义（未指定 source 时的 fallback 查找顺序），这里只用它当值域。
VALID_EVENT_SOURCES = SOURCES_TRY_ORDER
VALID_EVENT_STATUS = ("CONFIRMED", "TENTATIVE", "CANCELLED")

# P2-8 — worker 移除 CalDAV calendar 时有意不软删其历史事件行 (worker.py
# _refresh_calendars rationale: 共享日历可能临时不可访问), 这会让"幽灵日历"永久
# 占前端 chip。list_calendar_names() 按此阈值过滤: 超过这么多天没被 worker
# 摸过 (last_incremental_sync_at 冻结) 的日历名从列表隐藏。
GHOST_CALENDAR_STALE_DAYS = 30

RSVP_RESPONSE_ALIAS = {
    "accept": "ACCEPTED",
    "accepted": "ACCEPTED",
    "yes": "ACCEPTED",
    "tentative": "TENTATIVE",
    "tent": "TENTATIVE",
    "maybe": "TENTATIVE",
    "decline": "DECLINED",
    "declined": "DECLINED",
    "no": "DECLINED",
    "reject": "DECLINED",
}


# ---------------------------------------------------------------------------
# Row ↔ dict 映射 (CLI emit + IPC JSON 共用 shape)
# ---------------------------------------------------------------------------

def occurrence_to_dict(occ: "CalendarEventOccurrence") -> Dict[str, Any]:
    """CalendarEventOccurrence → JSON-serializable dict.

    给 ``list_events_in_window`` / ``list_today`` / ``list_week`` 返回 ``events``
    数组的每条用. 前端 timeline / chip 渲染拿到的就是这个 shape.
    """
    r = occ.row
    return {
        "id": r.id,
        "ical_uid": r.ical_uid,
        "recurrence_id": r.recurrence_id,
        "sequence": r.sequence,
        "summary": r.summary,
        "occurrence_start_iso": occ.occurrence_start_utc.isoformat(),
        "occurrence_end_iso": occ.occurrence_end_utc.isoformat(),
        "is_recurrence_instance": occ.is_recurrence_instance,
        "is_all_day": r.is_all_day,
        "calendar_name": r.calendar_name,
        "organizer": r.organizer,
        "attendees": r.attendees,
        "location": r.location,
        "url": r.url,
        "status": r.status,
        "response_status": r.response_status,
        "source": r.source,
        "notion_page_id": r.notion_page_id,
        "related_email_internal_id": r.related_email_internal_id,
    }


def row_to_dict(r: "CalendarEventRow") -> Dict[str, Any]:
    """CalendarEventRow → JSON-serializable dict (含原始 dtstart/dtend + ics_raw).

    给 ``get_event`` 返回完整 row 详情; 比 occurrence_to_dict 多 ics_raw /
    description / rrule 等"主事件元数据".
    """
    return {
        "id": r.id,
        "ical_uid": r.ical_uid,
        "recurrence_id": r.recurrence_id,
        "sequence": r.sequence,
        "summary": r.summary,
        "description": r.description,
        "location": r.location,
        "organizer": r.organizer,
        "attendees": r.attendees,
        "dtstart_iso": r.dtstart_utc.isoformat() if r.dtstart_utc else None,
        "dtend_iso": r.dtend_utc.isoformat() if r.dtend_utc else None,
        "is_all_day": r.is_all_day,
        "rrule": r.rrule,
        "exdates": r.exdates,
        "rdates": r.rdates,
        "status": r.status,
        "response_status": r.response_status,
        "url": r.url,
        "calendar_name": r.calendar_name,
        "source": r.source,
        "notion_page_id": r.notion_page_id,
        "related_email_internal_id": r.related_email_internal_id,
        "ics_raw": r.ics_raw,
        "last_synced_at_iso": (
            r.last_synced_at.isoformat() if r.last_synced_at else None
        ),
        "created_at_iso": r.created_at.isoformat() if r.created_at else None,
        "updated_at_iso": r.updated_at.isoformat() if r.updated_at else None,
    }


# ---------------------------------------------------------------------------
# CalendarService — 主 facade
# ---------------------------------------------------------------------------

class CalendarService:
    """日历业务逻辑 facade — CLI / IPC / 测试统一入口.

    构造便宜 (不连 DB / 不开 CalDAV session, 全 lazy). 单实例可跨多 method 复
    用 (CLI 一个 subcommand 跑一次 service.method).

    用法 (CLI):
    ::

        svc = CalendarService(db_path=cli.cli_config.sync_store_db_path, cfg=cfg)
        data = svc.list_today(calendar_name=None, source=None)
        emit(cli, data)

    用法 (pytest):
    ::

        svc = CalendarService(db_path=tmp_db_path, cfg=fake_cfg)
        out = svc.list_events_in_window(window_start=..., window_end=...)
        assert out["total"] == 3
    """

    def __init__(
        self,
        db_path: str | Path,
        cfg: Optional["Config"] = None,
    ) -> None:
        """初始化 service.

        Args:
            db_path: sync_store.db 路径. 给 ``CalendarEventRepository`` 用.
            cfg: 全局 Config 实例. 给 CalDAV writer / SMTP RSVP 等写路径用.
                  纯读 ops (events / today / sync-status 等) 可省略 (传 None).
                  写 ops 调用时若为 None 会抛 ``ValueError``.
        """
        self.db_path = str(db_path)
        self._cfg = cfg
        self._repo: Optional[CalendarEventRepository] = None

    @property
    def cfg(self) -> "Config":
        """惰性返回 cfg, 写路径需要时才检查."""
        if self._cfg is None:
            raise ValueError(
                "CalendarService cfg is None — 写路径需要 Config 实例 "
                "(传 src.config.config 进构造)"
            )
        return self._cfg

    @property
    def repo(self) -> CalendarEventRepository:
        """Lazy CalendarEventRepository (Phase 3 §P1-d 后带 connection pool)."""
        if self._repo is None:
            self._repo = CalendarEventRepository(self.db_path)
        return self._repo

    # ============================================================
    # Read ops — 直读 SQLite, 无 auth
    # ============================================================

    def list_events_in_window(
        self,
        *,
        window_start: datetime,
        window_end: datetime,
        calendar_name: Optional[str] = None,
        source: Optional[str] = None,
        limit: int = 500,
        expand_recurrences: bool = True,
    ) -> Dict[str, Any]:
        """读 calendar_event 的 occurrences 窗口 (RRULE 已展开).

        Raises:
            ValueError: limit ≤ 0 / source 非法 / window_end ≤ window_start
        """
        if limit <= 0:
            raise ValueError(f"limit must be > 0, got {limit}")
        if source and source not in VALID_EVENT_SOURCES:
            raise ValueError(
                f"source={source!r} not in {VALID_EVENT_SOURCES}"
            )
        if window_end <= window_start:
            raise ValueError(
                f"window_end ({window_end.isoformat()}) must be > "
                f"window_start ({window_start.isoformat()})"
            )

        occs = self.repo.list_event_occurrences(
            start_utc=window_start,
            end_utc=window_end,
            source=source,
            calendar_name=calendar_name,
            expand_recurrences=expand_recurrences,
        )
        if len(occs) > limit:
            occs = occs[:limit]

        return {
            "events": [occurrence_to_dict(o) for o in occs],
            "total": len(occs),
            "window": {
                "from_iso": window_start.isoformat(),
                "to_iso": window_end.isoformat(),
            },
            "filters": {
                "calendar_name": calendar_name,
                "source": source,
                "expand_recurrences": expand_recurrences,
            },
        }

    def list_today(
        self,
        *,
        calendar_name: Optional[str] = None,
        source: Optional[str] = None,
    ) -> Dict[str, Any]:
        """快捷: 拉今天 [00:00 UTC, 24:00 UTC) 内的 occurrences."""
        ws = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        we = ws + timedelta(days=1)
        return self.list_events_in_window(
            window_start=ws,
            window_end=we,
            calendar_name=calendar_name,
            source=source,
            limit=500,
            expand_recurrences=True,
        )

    def list_week(
        self,
        *,
        calendar_name: Optional[str] = None,
        source: Optional[str] = None,
    ) -> Dict[str, Any]:
        """快捷: 今天起未来 7 天 UTC."""
        ws = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        we = ws + timedelta(days=7)
        return self.list_events_in_window(
            window_start=ws,
            window_end=we,
            calendar_name=calendar_name,
            source=source,
            limit=500,
            expand_recurrences=True,
        )

    def get_event(
        self,
        *,
        ical_uid: str,
        source: str = "caldav",
        recurrence_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """按 (ical_uid, recurrence_id, source) 拿单 event 完整 row.

        Raises:
            ValueError: source 非法 / row 不存在 (caller 自己 map 成 404)
        """
        if source not in VALID_EVENT_SOURCES:
            raise ValueError(
                f"source={source!r} not in {VALID_EVENT_SOURCES}"
            )
        row = self.repo.get_by_ical_uid(
            ical_uid, source=source, recurrence_id=recurrence_id,
        )
        if row is None:
            raise ValueError(
                f"calendar_event not found: ical_uid={ical_uid!r} "
                f"recurrence_id={recurrence_id!r} source={source!r}"
            )
        return {"event": row_to_dict(row)}

    def list_sync_states(
        self,
        *,
        worker_enabled: bool = False,
    ) -> Dict[str, Any]:
        """列出所有 calendar 的 CalDAV sync 状态 (ctag / sync_token / 时间戳)."""
        states = self.repo.list_sync_states()
        calendars = [
            {
                "calendar_name": s.calendar_name,
                "ctag": s.ctag,
                "sync_token": s.sync_token,
                "last_full_sync_at_iso": (
                    s.last_full_sync_at.isoformat()
                    if s.last_full_sync_at else None
                ),
                "last_incremental_sync_at_iso": (
                    s.last_incremental_sync_at.isoformat()
                    if s.last_incremental_sync_at else None
                ),
                "last_error": s.last_error,
            }
            for s in states
        ]
        return {
            "calendars": calendars,
            "total": len(calendars),
            "worker_enabled": worker_enabled,
        }

    def list_calendar_names(self) -> List[str]:
        """SQL distinct calendar_name (历史中出现过, 非空, deleted_at IS NULL).

        给前端 toolbar chip / event-form 下拉用. 不调 CalDAV (那是 sync-now 的事).

        P2-8 — 按 calendar_sync_state 过滤幽灵日历: 超过
        ``GHOST_CALENDAR_STALE_DAYS`` 天未被 worker 摸过 (last_incremental_sync_at
        冻结, 说明该日历已从 CalDAV calendar 列表消失) 的日历名从结果隐藏。底层
        calendar_event 行不动, 数据不丢 —— 日历若恢复同步, 下次 tick 更新
        sync_state 后自动重新出现。从未进过 calendar_sync_state 的日历名 (如没
        经过 worker 的纯 email_ics 来源) 保守放行, 不参与此过滤。
        """
        conn = sqlite3.connect(self.db_path)
        try:
            cutoff_epoch = (
                datetime.now(timezone.utc) - timedelta(days=GHOST_CALENDAR_STALE_DAYS)
            ).timestamp()
            rows = conn.execute(
                """
                SELECT DISTINCT ce.calendar_name FROM calendar_event ce
                LEFT JOIN calendar_sync_state cs
                    ON cs.calendar_name = ce.calendar_name
                WHERE ce.deleted_at IS NULL AND ce.calendar_name IS NOT NULL
                    AND ce.calendar_name != ''
                    AND (
                        cs.calendar_name IS NULL
                        OR COALESCE(
                            cs.last_incremental_sync_at, cs.last_full_sync_at
                        ) >= ?
                    )
                ORDER BY ce.calendar_name
                """,
                (cutoff_epoch,),
            ).fetchall()
            return [r[0] for r in rows]
        finally:
            conn.close()

    # ============================================================
    # 阶段 2.1 (P1-3) — 邮件 ↔ 日历 ical_uid 双向反查
    # ============================================================

    def get_email_calendar_link(self, *, internal_id: int) -> Dict[str, Any]:
        """方向 A: 邮件 internal_id → 它携带的 .ics uid + 日历 master 行.

        读 email_meeting 映射 (v34, new_watcher 会议检测 hook 写入), 再按
        ical_uid 反查 calendar_event 代表 master 行 (occurrence 展开由消费方
        用既有 events 窗口查询完成)。

        Returns:
            dict — 前端 EmailCalendarLink 形状 (C7 裸对象):
            internal_id / ical_uid / method / recurrence_id / sequence /
            is_recurring / in_calendar / event (CalendarEventDetail | None)

        Raises:
            ValueError: 该邮件无会议映射 (非会议邀请 / v34 前旧邮件未回填) —
                caller map 成 404
        """
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT internal_id, ical_uid, method, recurrence_id, "
                "sequence, is_recurring FROM email_meeting WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            raise ValueError(
                f"email_meeting not found: internal_id={internal_id}"
            )

        master = self.repo.get_master_by_uid(row["ical_uid"])
        return {
            "internal_id": int(row["internal_id"]),
            "ical_uid": row["ical_uid"],
            "method": row["method"],
            "recurrence_id": row["recurrence_id"],
            "sequence": int(row["sequence"] or 0),
            "is_recurring": bool(row["is_recurring"]),
            "in_calendar": master is not None,
            "event": row_to_dict(master) if master else None,
        }

    def get_event_source_email(self, *, ical_uid: str) -> Dict[str, Any]:
        """方向 B: ical_uid → 来源邀请邮件 (drawer「关联邮件」反查).

        多封邮件携带同一 uid 时 (周期会议 update / cancel 各来一封):
        优先最新一封 METHOD:REQUEST (date_received DESC); 没有 REQUEST 时取
        最新一封任意 method (含 v34 回填的 method=NULL 行)。

        Returns:
            dict — 前端 EventSourceEmail 形状 (C7 裸对象):
            ical_uid / internal_id / subject / sender / sender_name /
            date_received / mailbox / method / linked_email_count

        Raises:
            ValueError: 该 uid 无任何映射邮件 (caldav-only 事件 / 旧邮件未回填) —
                caller map 成 404
        """
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                """
                SELECT m.ical_uid, m.internal_id, m.method,
                       e.subject, e.sender, e.sender_name,
                       e.date_received, e.mailbox
                FROM email_meeting m
                JOIN email_metadata e ON e.internal_id = m.internal_id
                WHERE m.ical_uid = ?
                ORDER BY (CASE WHEN m.method = 'REQUEST' THEN 1 ELSE 0 END) DESC,
                         e.date_received DESC
                LIMIT 1
                """,
                (ical_uid,),
            ).fetchone()
            count = conn.execute(
                "SELECT COUNT(*) FROM email_meeting WHERE ical_uid = ?",
                (ical_uid,),
            ).fetchone()[0]
        finally:
            conn.close()
        if row is None:
            raise ValueError(
                f"source email not found: ical_uid={ical_uid!r}"
            )
        return {
            "ical_uid": row["ical_uid"],
            "internal_id": int(row["internal_id"]),
            "subject": row["subject"],
            "sender": row["sender"],
            "sender_name": row["sender_name"],
            "date_received": row["date_received"],
            "mailbox": row["mailbox"],
            "method": row["method"],
            "linked_email_count": int(count),
        }

    # ============================================================
    # Recurring discover — group-by-uid + master pick
    # ============================================================

    def discover_recurring_series(
        self,
        *,
        sync_store: "SyncStore",
        since: Optional[str] = None,
        limit: int = 2000,
    ) -> Dict[str, Any]:
        """扫 calendar_event 找带 RRULE 的会议邀请, group by uid + 选 canonical master.

        Raises:
            ValueError: limit ≤ 0
        """
        if limit <= 0:
            raise ValueError(f"limit must be > 0, got {limit}")

        # Phase 1.5: discover_recurring 现走 calendar_event 表 (CalDAV worker
        # SSoT 后); 不再 IMAP fetch.
        from src.calendar_notion.recurring_invite import discover_recurring

        matches = asyncio.run(discover_recurring(
            sync_store, since=since, limit=limit,
        ))

        # 计算 scanned (SQL count) — 跟 discover_recurring 内部的 source filter
        # + dtstart filter 对齐.
        actual_scanned = self._count_rrule_rows(since=since)

        # Group by uid + pick canonical master row.
        grouped: Dict[str, List[Dict]] = {}
        for m in matches:
            uid = (m.get("uid") or "").strip() or (
                f"__no_uid_iid_{m.get('internal_id')}"
            )
            grouped.setdefault(uid, []).append(m)

        def _safe_dt(s: Optional[str]) -> Optional[str]:
            if not s:
                return None
            return s.strip() or None

        series_list: List[Dict[str, Any]] = []
        for uid, group in grouped.items():
            # 优先 method=REQUEST 中 earliest parseable dtstart 的
            request_candidates = [
                (g, _safe_dt(g.get("dtstart")))
                for g in group
                if (g.get("method") or "").upper() == "REQUEST"
            ]
            request_candidates = [
                (g, dt) for g, dt in request_candidates if dt
            ]
            if request_candidates:
                request_candidates.sort(key=lambda t: t[1])
                master = request_candidates[0][0]
            else:
                all_with_dt = [
                    (g, _safe_dt(g.get("dtstart"))) for g in group
                ]
                all_with_dt = [
                    (g, dt) for g, dt in all_with_dt if dt
                ]
                if all_with_dt:
                    all_with_dt.sort(key=lambda t: t[1])
                    master = all_with_dt[0][0]
                else:
                    master = group[0]

            series_list.append({
                "series_uid": uid,
                "master_dtstart": master.get("dtstart"),
                "summary": master.get("subject"),
                "sender": master.get("sender"),
                "organizer": master.get("sender"),  # PR-4 上 organizer
                "rrule": master.get("rrule"),
                "method": master.get("method"),
                "internal_ids": [int(g.get("internal_id")) for g in group],
            })

        return {
            "series": series_list,
            "total_series": len(series_list),
            "matches_total": len(matches),
            "scanned": actual_scanned,
            "since": since,
            "limit": limit,
        }

    def _count_rrule_rows(self, *, since: Optional[str]) -> int:
        """SQL COUNT(*) FROM calendar_event WHERE rrule != '' AND ..."""
        sql = (
            "SELECT COUNT(*) FROM calendar_event "
            "WHERE rrule != '' AND deleted_at IS NULL "
            "AND source IN ('caldav', 'email_ics')"
        )
        params: List = []
        if since:
            try:
                d = datetime.fromisoformat(since)
                if d.tzinfo is None:
                    d = d.replace(tzinfo=timezone.utc)
                params.append(d.astimezone(timezone.utc).timestamp())
                sql += " AND dtstart_utc >= ?"
            except (ValueError, TypeError):
                pass

        conn = sqlite3.connect(self.db_path)
        try:
            return int(conn.execute(sql, params).fetchone()[0])
        except Exception:
            return 0
        finally:
            conn.close()

    # ============================================================
    # Write ops — 改 Exchange / Notion / SMTP, 调用方必须 require_auth()
    # ============================================================

    def sync_now(
        self,
        *,
        full: bool = True,
        calendar_name: Optional[str] = None,
        past_days: int = 30,
        future_days: int = 180,
    ) -> Dict[str, Any]:
        """手动跑一次 CalDAV → SQLite sync (admin/debug).

        Raises:
            ValueError: past_days < 0 / future_days ≤ 0 / CalDAV connect fail
        """
        if past_days < 0 or future_days <= 0:
            raise ValueError(
                f"past_days >= 0 and future_days > 0; got "
                f"past={past_days} future={future_days}"
            )

        from src.calendar_sync.caldav_reader import CalDAVReader
        from src.calendar_sync import CalendarReconciler

        reader = CalDAVReader(self.cfg)
        repo = self.repo
        reconciler = CalendarReconciler(repo)

        now_utc = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        ws = now_utc - timedelta(days=past_days)
        we = now_utc + timedelta(days=future_days)

        used_fallback = False
        if calendar_name:
            cals = [calendar_name]
        else:
            cals = reader.list_calendar_names_for_sync()
            if not cals:
                cals = ["calendar"]
                used_fallback = True

        results: List[Dict[str, Any]] = []
        for cal in cals:
            try:
                if full:
                    events = reader.list_events_with_full_detail(
                        ws, we, calendar_name=cal,
                    )
                    stats = reconciler.reconcile_full_window(
                        events, calendar_name=cal,
                        window_start=ws, window_end=we,
                    )
                    ctag = reader.get_collection_ctag(cal)
                    repo.upsert_sync_state(
                        cal, ctag=ctag, full_sync=True, last_error=None,
                    )
                    results.append({
                        "calendar_name": cal,
                        "mode": "full",
                        "upserted": stats.upserted,
                        "soft_deleted": stats.soft_deleted,
                        "errors": stats.errors,
                        "ctag": ctag,
                    })
                else:
                    state = repo.get_sync_state(cal)
                    old_token = state.sync_token if state else None
                    changed, deleted, new_token = reader.sync_collection(
                        cal, old_token,
                    )
                    if new_token is None:
                        results.append({
                            "calendar_name": cal,
                            "mode": "incremental",
                            "status": "not_supported_by_server",
                            "hint": "DavMail sync-collection 支持有限; 改用 full",
                        })
                        continue
                    stats = reconciler.reconcile_incremental(
                        changed, deleted, calendar_name=cal,
                    )
                    ctag = reader.get_collection_ctag(cal)
                    repo.upsert_sync_state(
                        cal, ctag=ctag, sync_token=new_token, last_error=None,
                    )
                    results.append({
                        "calendar_name": cal,
                        "mode": "incremental",
                        "upserted": stats.upserted,
                        "soft_deleted": stats.soft_deleted,
                        "errors": stats.errors,
                        "ctag": ctag,
                        "sync_token": new_token,
                    })
            except Exception as e:
                repo.upsert_sync_state(cal, last_error=str(e)[:500])
                results.append({
                    "calendar_name": cal,
                    "mode": "full" if full else "incremental",
                    "error": str(e)[:500],
                })

        # 整轮成功后清孤儿错误行: 仅在「同步了全部真实日历」(未指定单日历 + 非 fallback)
        # 时清, 否则按单日历 / 假名的 active 集会误删其他真实行。端口配错期间 fallback
        # 假名 'calendar' 留下的 last_error 会永久挂着 → 前端 sync-pill 常红, 这里根治。
        if calendar_name is None and not used_fallback:
            repo.clear_stale_errors(cals)

        return {
            "results": results,
            "total_calendars": len(results),
            "window": {"from_iso": ws.isoformat(), "to_iso": we.isoformat()},
            "mode": "full" if full else "incremental",
        }

    def create_event(
        self,
        *,
        summary: str,
        dtstart_utc: datetime,
        dtend_utc: datetime,
        location: Optional[str] = None,
        description: Optional[str] = None,
        attendees: Optional[List[Dict[str, Any]]] = None,
        calendar_name: Optional[str] = None,
        status: str = "CONFIRMED",
        rrule: Optional[str] = None,
        is_all_day: bool = False,
    ) -> Dict[str, Any]:
        """CalDAV PUT 创建事件.

        Args:
            rrule: RFC 5545 RRULE 字符串 (不含 ``RRULE:`` 前缀, 如
                ``FREQ=WEEKLY;BYDAY=MO``); 留空 = 单次事件 (Phase 4·#3).

        Raises:
            ValueError: status 非法 / dtend ≤ dtstart / DavMail / writer raise
        """
        if status not in VALID_EVENT_STATUS:
            raise ValueError(
                f"status={status!r} not in {VALID_EVENT_STATUS}"
            )
        if dtend_utc <= dtstart_utc:
            raise ValueError(
                f"dtend_utc ({dtend_utc.isoformat()}) must be > "
                f"dtstart_utc ({dtstart_utc.isoformat()})"
            )

        from src.calendar_sync.caldav_writer import CalDAVWriter

        writer = CalDAVWriter(self.cfg)
        return writer.create_event(
            summary=summary,
            dtstart_utc=dtstart_utc,
            dtend_utc=dtend_utc,
            location=location,
            description=description,
            attendees=attendees or [],
            calendar_name=calendar_name,
            status=status,
            rrule=rrule,
            is_all_day=is_all_day,
        )

    def update_event(
        self,
        *,
        ical_uid: str,
        summary: Optional[str] = None,
        dtstart_utc: Optional[datetime] = None,
        dtend_utc: Optional[datetime] = None,
        location: Optional[str] = None,
        description: Optional[str] = None,
        attendees: Optional[List[Dict[str, Any]]] = None,
        status: Optional[str] = None,
        calendar_name: Optional[str] = None,
        sequence_bump: bool = True,
        rrule: Optional[str] = None,
        is_all_day: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """CalDAV PUT update 现有事件.

        Args:
            attendees: None = 未传, **保留**原与会者 (Phase 4·#4 数据安全修复, 防
                writer PUT 全替换语义静默清空 Exchange 端); 显式 ``[]`` 清空 (caller
                明确意图: CLI ``--clear-attendees`` / 前端删光 chips); 显式 ``[...]`` 替换.
            rrule: None = 未传, 保留原 RRULE (F3 透传); 显式 str 覆盖 (改整系列);
                显式 '' 删除 RRULE (周期 → 单次) (Phase 4·#3).

        Raises:
            ValueError: status 非法 / dtend ≤ dtstart / writer raise (not found)
        """
        if status is not None and status not in VALID_EVENT_STATUS:
            raise ValueError(
                f"status={status!r} not in {VALID_EVENT_STATUS}"
            )
        if (
            dtstart_utc is not None
            and dtend_utc is not None
            and dtend_utc <= dtstart_utc
        ):
            raise ValueError(
                f"dtend_utc ({dtend_utc.isoformat()}) must be > "
                f"dtstart_utc ({dtstart_utc.isoformat()})"
            )

        from src.calendar_sync.caldav_writer import CalDAVWriter

        writer = CalDAVWriter(self.cfg)
        update_kwargs: Dict[str, Any] = dict(
            ical_uid=ical_uid,
            summary=summary,
            dtstart_utc=dtstart_utc,
            dtend_utc=dtend_utc,
            location=location,
            description=description,
            status=status,
            calendar_name=calendar_name,
            sequence_bump=sequence_bump,
        )
        # Phase 4·#4 — attendees sentinel 修复 (数据安全): None = 未传, 不 forward
        # → writer 默认 _UNSET 保留原与会者 (防 PUT 全替换语义静默清空 Exchange 端).
        # 显式 [] 清空 / 显式 [...] 替换. 老代码无条件 attendees=attendees 把 None
        # 透传给 writer (None is _UNSET == False → None or [] → 清空), 短路了 writer
        # 的 _UNSET 保护. 改条件传, 跟下方 rrule / is_all_day 一致.
        if attendees is not None:
            update_kwargs["attendees"] = attendees
        # Phase 4·#3 — rrule None = 未传 (writer 默认 _UNSET 保留原 RRULE);
        # 显式 str (含 '' 删除 → 周期变单次) 才透传给 writer 覆盖.
        if rrule is not None:
            update_kwargs["rrule"] = rrule
        # Phase 4·#2 — is_all_day None = 未传 (writer 检测保持原全天状态);
        # 显式 bool 才透传 (edit 改全天/定时状态).
        if is_all_day is not None:
            update_kwargs["is_all_day"] = is_all_day
        return writer.update_event(**update_kwargs)

    def update_occurrence(
        self,
        *,
        ical_uid: str,
        recurrence_id_utc: datetime,
        summary: Optional[str] = None,
        dtstart_utc: Optional[datetime] = None,
        dtend_utc: Optional[datetime] = None,
        location: Optional[str] = None,
        description: Optional[str] = None,
        status: Optional[str] = None,
        calendar_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Phase 4·#3c — 改周期事件单次 occurrence (detached occurrence / 改这一次).

        RFC 5545 RECURRENCE-ID override: 保留 master RRULE, 加/替换 override
        VEVENT. 不传字段从 master 继承.

        Raises:
            ValueError: status 非法 / dtend ≤ dtstart / writer raise (not found)
        """
        if status is not None and status not in VALID_EVENT_STATUS:
            raise ValueError(f"status={status!r} not in {VALID_EVENT_STATUS}")
        if (
            dtstart_utc is not None
            and dtend_utc is not None
            and dtend_utc <= dtstart_utc
        ):
            raise ValueError(
                f"dtend_utc ({dtend_utc.isoformat()}) must be > "
                f"dtstart_utc ({dtstart_utc.isoformat()})"
            )

        from src.calendar_sync.caldav_writer import CalDAVWriter

        writer = CalDAVWriter(self.cfg)
        return writer.update_occurrence(
            ical_uid=ical_uid,
            recurrence_id_utc=recurrence_id_utc,
            summary=summary,
            dtstart_utc=dtstart_utc,
            dtend_utc=dtend_utc,
            location=location,
            description=description,
            status=status,
            calendar_name=calendar_name,
        )

    def split_series(
        self,
        *,
        ical_uid: str,
        split_recurrence_id_utc: datetime,
        summary: Optional[str] = None,
        dtstart_utc: Optional[datetime] = None,
        dtend_utc: Optional[datetime] = None,
        location: Optional[str] = None,
        description: Optional[str] = None,
        status: Optional[str] = None,
        calendar_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Phase 4·#3d — 改未来 (this and following / split series).

        老 series 截断 + 新建 series 从 split 起. 详见 caldav_writer.split_series.

        Raises:
            ValueError: status 非法 / dtend ≤ dtstart / writer raise (not found / 非周期)
        """
        if status is not None and status not in VALID_EVENT_STATUS:
            raise ValueError(f"status={status!r} not in {VALID_EVENT_STATUS}")
        if (
            dtstart_utc is not None
            and dtend_utc is not None
            and dtend_utc <= dtstart_utc
        ):
            raise ValueError(
                f"dtend_utc ({dtend_utc.isoformat()}) must be > "
                f"dtstart_utc ({dtstart_utc.isoformat()})"
            )

        from src.calendar_sync.caldav_writer import CalDAVWriter

        writer = CalDAVWriter(self.cfg)
        return writer.split_series(
            ical_uid=ical_uid,
            split_recurrence_id_utc=split_recurrence_id_utc,
            summary=summary,
            dtstart_utc=dtstart_utc,
            dtend_utc=dtend_utc,
            location=location,
            description=description,
            status=status,
            calendar_name=calendar_name,
        )

    def delete_event(
        self,
        *,
        ical_uid: str,
        calendar_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """CalDAV DELETE 删除事件 (不可撤销).

        调用方必须自己确认 (CLI --yes, IPC confirm dialog).
        """
        from src.calendar_sync.caldav_writer import CalDAVWriter

        writer = CalDAVWriter(self.cfg)
        return writer.delete_event(
            ical_uid=ical_uid, calendar_name=calendar_name,
        )

    # ============================================================
    # RSVP + Notion replay
    # ============================================================

    def send_rsvp(
        self,
        *,
        ical_uid: str,
        response_status: str,
        recurrence_id: Optional[str] = None,
        source: Optional[str] = None,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """发 iTIP REPLY 给 organizer.

        Args:
            response_status: ``ACCEPTED`` / ``TENTATIVE`` / ``DECLINED``
                              (CLI 端处理别名后传进来).
            dry_run: True = 不实际发 SMTP, 返回 plan + body preview.

        Raises:
            ValueError: row 不存在 / organizer 字段非 email / source 非法
            smtplib.SMTPException: SMTP 发送失败
        """
        if source and source not in VALID_EVENT_SOURCES:
            raise ValueError(
                f"source={source!r} not in {VALID_EVENT_SOURCES}"
            )

        from src.calendar_sync.rsvp import send_rsvp as _send_rsvp

        return _send_rsvp(
            self.repo, self.cfg,
            ical_uid=ical_uid,
            response_status=response_status,
            recurrence_id=recurrence_id,
            source=source,
            dry_run=dry_run,
        )

    def replay_event_to_notion(
        self,
        *,
        ical_uid: str,
        recurrence_id: Optional[str] = None,
        source: Optional[str] = None,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """重导出 SQLite calendar_event 行到 Notion (Phase 2.4).

        dry_run 模式仅查 row + 拼 plan, 不写 Notion (无需 auth).

        Raises:
            ValueError: row 不存在 / source 非法
        """
        if source and source not in VALID_EVENT_SOURCES:
            raise ValueError(
                f"source={source!r} not in {VALID_EVENT_SOURCES}"
            )

        if dry_run:
            candidates = [source] if source else list(SOURCES_TRY_ORDER)
            row = None
            found_source = None
            for s in candidates:
                if not s:
                    continue
                candidate = self.repo.get_by_ical_uid(
                    ical_uid, source=s, recurrence_id=recurrence_id,
                )
                if candidate is not None:
                    row = candidate
                    found_source = s
                    break
            if row is None:
                raise ValueError(
                    f"calendar_event not found: ical_uid={ical_uid!r} "
                    f"recurrence_id={recurrence_id!r}; "
                    f"tried sources: {candidates}"
                )
            return {
                "action": "would_replay",
                "dry_run": True,
                "ical_uid": ical_uid,
                "recurrence_id": recurrence_id,
                "source": found_source,
                "row_id": row.id,
                "summary": row.summary,
                "current_notion_page_id": row.notion_page_id,
            }

        from src.calendar_notion.replay import replay_calendar_event
        from src.calendar_notion.sync import CalendarNotionSync

        notion_sync = CalendarNotionSync()
        result = asyncio.run(replay_calendar_event(
            self.repo, notion_sync,
            ical_uid=ical_uid,
            recurrence_id=recurrence_id,
            source=source,
        ))
        return {
            "action": result["action"],
            "page_id": result["page_id"],
            "ical_uid": result["ical_uid"],
            "recurrence_id": result["recurrence_id"],
            "source": result["source"],
            "dry_run": False,
        }

    # ============================================================
    # Recurring replay (legacy email_ics path)
    # ============================================================

    def recurring_replay_by_internal_ids(
        self,
        *,
        internal_ids: List[int],
        sync_store: "SyncStore",
        arm: Any,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """重跑指定 internal_id 的会议邀请 (修复历史 mis-sync).

        Args:
            arm: IMailBackend 实例 (AppleScript / DavMail 抽象). 来自 cli.backend
                  或 IPC 启动时已 probe 的 backend.
        """
        if not internal_ids:
            raise ValueError("need internal_ids list with at least one item")

        if dry_run:
            return {
                "replayed": [],
                "total": len(internal_ids),
                "succeeded": 0,
                "failed": 0,
                "dry_run": True,
                "candidate_internal_ids": list(internal_ids),
            }

        from src.calendar_notion.recurring_invite import replay_one
        from src.mail.meeting_sync import MeetingInviteSync

        meeting_sync = MeetingInviteSync(sync_store=sync_store)

        items: List[Dict[str, Any]] = []
        succeeded = 0
        failed = 0
        for iid in internal_ids:
            meeting_sync.reset_stats()
            try:
                page_id = asyncio.run(
                    replay_one(iid, sync_store, arm, meeting_sync)
                )
            except Exception as e:
                items.append({
                    "internal_id": iid,
                    "action": "error",
                    "error": str(e),
                })
                failed += 1
                continue
            if page_id is None:
                items.append({
                    "internal_id": iid,
                    "action": "skipped",
                    "error": "no calendar invite or fetch failed",
                })
                failed += 1
            else:
                items.append({
                    "internal_id": iid,
                    "action": "replayed",
                    "page_id": page_id,
                })
                succeeded += 1

        return {
            "replayed": items,
            "total": len(internal_ids),
            "succeeded": succeeded,
            "failed": failed,
            "dry_run": False,
            "candidate_internal_ids": list(internal_ids),
        }

    # ============================================================
    # Expand (周期会议 Notion mirror 滚动展开)
    # ============================================================

    def expand_recurring(
        self,
        *,
        sync_store: "SyncStore",
        horizon_weeks: int = 8,
        dry_run: bool = True,
    ) -> Dict[str, Any]:
        """周期会议 occurrence 滚动展开 (Notion mirror 用; 单次版本)."""
        if horizon_weeks <= 0:
            raise ValueError(
                f"horizon_weeks must be > 0, got {horizon_weeks}"
            )

        if not dry_run:
            from src.calendar_notion.expansion import run_expansion_tick
            from src.mail.meeting_sync import MeetingInviteSync

            meeting_sync = MeetingInviteSync(sync_store=sync_store)
            result = asyncio.run(
                run_expansion_tick(
                    sync_store,
                    meeting_sync,
                    horizon_weeks,
                    dry_run=False,
                )
            )
            return {
                "action": "calendar-expand",
                "mode": "inline",
                "horizon_weeks": horizon_weeks,
                "series_scanned": result.get("series_scanned", 0),
                "occurrences_synced": result.get("occurrences_synced", 0),
                "errors": result.get("errors", []),
            }

        # dry-run: 列待 expand 的 series, occurrences_added=0 (不实跑展开).
        now = datetime.now(timezone.utc)
        cutoff = now + timedelta(weeks=horizon_weeks)
        cutoff_iso = cutoff.isoformat()

        expanded: List[Dict[str, Any]] = []
        for row in sync_store.iter_series_needing_expansion(cutoff_iso):
            expanded.append({
                "series_uid": row.get("series_uid"),
                "master_dtstart": row.get("master_dtstart"),
                "last_occurrence_dtstart": row.get("last_occurrence_dtstart"),
                "notion_page_id": row.get("notion_page_id"),
                "subject": row.get("subject"),
                "occurrences_added": 0,
            })

        return {
            "action": "calendar-expand",
            "mode": "dry_run",
            "horizon_weeks": horizon_weeks,
            "cutoff_iso": cutoff_iso,
            "expanded": expanded,
            "total_series": len(expanded),
            "total_occurrences_added": 0,
            "dry_run": True,
        }


__all__ = [
    "CalendarService",
    "VALID_EVENT_SOURCES",
    "VALID_EVENT_STATUS",
    "RSVP_RESPONSE_ALIAS",
    "occurrence_to_dict",
    "row_to_dict",
]
