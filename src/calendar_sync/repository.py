"""CalendarEventRepository — calendar_event / calendar_sync_state 表的 CRUD.

Phase 1 (plan §1.4): 给 worker / CLI / IPC handler / 前端 (better-sqlite3 直读)
统一的读写入口. 不调 CalDAV (那是 worker 的事), 不调 Notion (那是 mirror 的事).
只做 SQLite.

DB schema 见 src/mail/sync_store.py DB_VERSION=15 calendar_event 表注释.

设计要点:
1. 时间统一存 UTC epoch (REAL); 前端 toLocaleString() 转本地展示, 后端 datetime
   接口暴露 tz-aware utc datetime. _to_epoch / _from_epoch 双向转换在 row 入口.
2. UNIQUE INDEX 走 (ical_uid, COALESCE(recurrence_id, ''), source); upsert 用
   ON CONFLICT 命中. NULL recurrence_id = 主事件, 非 NULL = 跳脱 occurrence.
3. 软删除: deleted_at 时间戳, 不真删, 30 天后清理. CalDAV 端删除 → reconciler 调
   soft_delete(); 用户 unaware.
4. 时间窗口查询: 默认按 dtstart_utc 排序 + skip deleted_at IS NOT NULL.
5. RRULE 展开**不在 repository**, 在 expander.py — 给 caller 选: 要 raw rows
   就 ``list_event_rows``; 要展开的 occurrences 就 ``list_event_occurrences``.
"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Iterator, Optional

from src.calendar_sync.expander import expand_in_window

if TYPE_CHECKING:
    from src.calendar_notion.caldav_reader import CalendarEvent


_VALID_SOURCES = frozenset({"caldav", "email_ics", "legacy_calendar_app"})


@dataclass
class CalendarEventRow:
    """calendar_event 表一行的内存表示.

    时间字段是 tz-aware UTC datetime (在 _row_to_dataclass 里从 epoch 转); 写入
    repository 时也接收 datetime, _to_epoch 在边界处转回 REAL.
    """

    id: int
    ical_uid: str
    recurrence_id: Optional[str]
    sequence: int
    calendar_name: str
    summary: str
    description: str
    location: str
    organizer: str
    attendees: list[dict]  # JSON-decoded
    dtstart_utc: datetime
    dtend_utc: Optional[datetime]
    is_all_day: bool
    rrule: str
    exdates: list[str]
    rdates: list[str]
    status: str
    response_status: str
    url: str
    ics_raw: str
    source: str
    notion_page_id: Optional[str]
    related_email_internal_id: Optional[int]
    last_synced_at: datetime
    deleted_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime


@dataclass
class CalendarEventOccurrence:
    """RRULE 展开后的单个 occurrence — row + occurrence-specific 起止时间.

    一行 CalendarEventRow (含 RRULE) 可能展开成多个 occurrence; 单次 (非
    recurring) event 展开后 occurrence_start_utc / _end 跟 row.dtstart_utc /
    dtend_utc 相同.

    前端日历 timeline 渲染拿到的就是这个; row 是它的"模板".
    """

    row: CalendarEventRow
    occurrence_start_utc: datetime
    occurrence_end_utc: datetime
    is_recurrence_instance: bool = False  # True = 来自 RRULE 展开, False = 单次


@dataclass
class CalendarSyncStateRow:
    """calendar_sync_state 表一行 (per-calendar CalDAV sync 状态)."""

    calendar_name: str
    ctag: Optional[str] = None
    sync_token: Optional[str] = None
    last_full_sync_at: Optional[datetime] = None
    last_incremental_sync_at: Optional[datetime] = None
    last_error: Optional[str] = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


# ============================================================
# Helpers — datetime ↔ epoch & JSON encode/decode
# ============================================================

def _to_epoch(dt: Optional[datetime]) -> Optional[float]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _from_epoch(ts: Optional[float]) -> Optional[datetime]:
    if ts is None:
        return None
    return datetime.fromtimestamp(float(ts), tz=timezone.utc)


def _json_list(v) -> str:
    """list[str|dict] → JSON; None / 空 → '[]'."""
    if not v:
        return "[]"
    try:
        return json.dumps(v, ensure_ascii=False)
    except (TypeError, ValueError):
        return "[]"


def _decode_json_list(s: Optional[str]) -> list:
    if not s:
        return []
    try:
        v = json.loads(s)
        return v if isinstance(v, list) else []
    except (TypeError, ValueError):
        return []


# ============================================================
# Repository
# ============================================================

class CalendarEventRepository:
    """calendar_event / calendar_sync_state 表的封装.

    用法:
        repo = CalendarEventRepository("data/sync_store.db")
        repo.upsert_from_caldav_event(event_obj, source="caldav")
        for occ in repo.list_event_occurrences(start, end):
            print(occ.row.summary, occ.occurrence_start_utc)
    """

    def __init__(self, db_path: str = "data/sync_store.db"):
        self.db_path = Path(db_path)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @contextmanager
    def _conn_ctx(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    # --------------------------------------------------------
    # Write — upsert / soft-delete / mirror linking
    # --------------------------------------------------------

    def upsert_from_caldav_event(
        self,
        event: "CalendarEvent",
        *,
        source: str = "caldav",
        related_email_internal_id: Optional[int] = None,
    ) -> int:
        """把 CalDAV reader 拿的 CalendarEvent 落到 calendar_event 表 (upsert).

        ical_uid 必须非空 (来自 vEvent UID, RFC 5545 强制要求). 没 UID 的 event
        在 reader 层就被丢掉, 这里不再 defensive 检查.

        Returns:
            id (AUTOINCREMENT row id) — 调用方可拿来写关联 (notion_page_id 等).
        """
        if source not in _VALID_SOURCES:
            raise ValueError(
                f"source={source!r} not in {sorted(_VALID_SOURCES)}"
            )
        if not event.ical_uid:
            raise ValueError("CalendarEvent.ical_uid is empty — refusing to upsert")

        now = time.time()
        # F2 原子化: 老代码 INSERT + 单独 SELECT 拿 id 是两条 SQL, ON CONFLICT
        # 路径 lastrowid=0 必须 SELECT 复查. 两 statement 之间存在并发 race
        # window — CLI ``sync-now`` + worker ``_tick_one_calendar`` 同时跑同
        # calendar 时, 第二个 connection 在 INSERT 跟 SELECT 之间可能拿到错
        # row id, 后续 ``update_notion_link`` 写错页. 改 INSERT ... RETURNING
        # 一条 atomic statement (SQLite ≥ 3.35), 同时复用 sqlite3 deferred
        # transaction + WAL writer serialization, 关掉 race window.
        with self._conn_ctx() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO calendar_event (
                    ical_uid, recurrence_id, sequence, calendar_name,
                    summary, description, location, organizer, attendees_json,
                    dtstart_utc, dtend_utc, is_all_day,
                    rrule, exdates_json, rdates_json,
                    status, response_status, url, ics_raw,
                    source, notion_page_id, related_email_internal_id,
                    last_synced_at, deleted_at, created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, NULL, ?,
                    ?, NULL, ?, ?
                )
                ON CONFLICT (ical_uid, COALESCE(recurrence_id, ''), source) DO UPDATE SET
                    sequence       = excluded.sequence,
                    calendar_name  = excluded.calendar_name,
                    summary        = excluded.summary,
                    description    = excluded.description,
                    location       = excluded.location,
                    organizer      = excluded.organizer,
                    attendees_json = excluded.attendees_json,
                    dtstart_utc    = excluded.dtstart_utc,
                    dtend_utc      = excluded.dtend_utc,
                    is_all_day     = excluded.is_all_day,
                    rrule          = excluded.rrule,
                    exdates_json   = excluded.exdates_json,
                    rdates_json    = excluded.rdates_json,
                    status         = excluded.status,
                    response_status= excluded.response_status,
                    url            = excluded.url,
                    ics_raw        = excluded.ics_raw,
                    related_email_internal_id = COALESCE(
                        excluded.related_email_internal_id,
                        calendar_event.related_email_internal_id
                    ),
                    last_synced_at = excluded.last_synced_at,
                    deleted_at     = NULL,
                    updated_at     = excluded.updated_at
                RETURNING id
                """,
                (
                    event.ical_uid,
                    event.recurrence_id,
                    int(event.sequence or 0),
                    event.calendar_name or "",
                    event.summary or "",
                    event.description or "",
                    event.location or "",
                    event.organizer or "",
                    _json_list(event.attendees_detail or [
                        {"email": e} for e in event.attendees
                    ]),
                    _to_epoch(event.start),
                    _to_epoch(event.end),
                    int(bool(event.is_all_day)),
                    event.rrule or "",
                    _json_list(event.exdates or []),
                    _json_list(event.rdates or []),
                    event.status or "",
                    event.response_status or "",
                    event.url or "",
                    event.ics_raw or "",
                    source,
                    related_email_internal_id,
                    now,  # last_synced_at
                    now,  # created_at — ON CONFLICT path 不会改 (DEFAULT 语义只在 INSERT)
                    now,  # updated_at
                ),
            )
            row = cur.fetchone()
            conn.commit()
            return int(row["id"]) if row else 0

    def soft_delete(
        self,
        *,
        ical_uid: str,
        source: str,
        recurrence_id: Optional[str] = None,
    ) -> int:
        """把指定 event 软删除 (deleted_at = now). 返回受影响行数."""
        now = time.time()
        with self._conn_ctx() as conn:
            cur = conn.cursor()
            if recurrence_id is None:
                # 主事件 — 同时连带删除其所有 occurrence 跳脱
                cur.execute(
                    """
                    UPDATE calendar_event
                    SET deleted_at = ?, updated_at = ?
                    WHERE ical_uid = ? AND source = ?
                      AND deleted_at IS NULL
                    """,
                    (now, now, ical_uid, source),
                )
            else:
                cur.execute(
                    """
                    UPDATE calendar_event
                    SET deleted_at = ?, updated_at = ?
                    WHERE ical_uid = ? AND recurrence_id = ? AND source = ?
                      AND deleted_at IS NULL
                    """,
                    (now, now, ical_uid, recurrence_id, source),
                )
            conn.commit()
            return cur.rowcount

    def update_notion_link(
        self, event_id: int, notion_page_id: Optional[str]
    ) -> None:
        """Notion mirror 创建/更新页面后回写 notion_page_id."""
        with self._conn_ctx() as conn:
            conn.execute(
                """
                UPDATE calendar_event
                SET notion_page_id = ?, updated_at = ?
                WHERE id = ?
                """,
                (notion_page_id, time.time(), event_id),
            )
            conn.commit()

    def update_response_status(self, event_id: int, response_status: str) -> None:
        """Phase 2.1 — RSVP 发送 iTIP REPLY 后更新本地 response_status.

        服务端 (Outlook/Exchange) 收到 REPLY 后异步更新 organizer 端 attendee
        PARTSTAT, 下次 caldav sync 也会反映. 此 method 立即在本地 SQLite 写,
        让前端 drawer 不必等下次 sync 才看到状态变化.
        """
        with self._conn_ctx() as conn:
            conn.execute(
                """
                UPDATE calendar_event
                SET response_status = ?, updated_at = ?
                WHERE id = ?
                """,
                (response_status, time.time(), event_id),
            )
            conn.commit()

    # --------------------------------------------------------
    # Read — by id / window / list calendars
    # --------------------------------------------------------

    def get_by_id(self, event_id: int) -> Optional[CalendarEventRow]:
        with self._conn_ctx() as conn:
            row = conn.execute(
                "SELECT * FROM calendar_event WHERE id = ?", (event_id,)
            ).fetchone()
        return _row_to_dataclass(row) if row else None

    def get_by_ical_uid(
        self,
        ical_uid: str,
        *,
        source: str = "caldav",
        recurrence_id: Optional[str] = None,
        include_deleted: bool = False,
    ) -> Optional[CalendarEventRow]:
        sql = (
            "SELECT * FROM calendar_event "
            "WHERE ical_uid = ? AND source = ? "
            "AND COALESCE(recurrence_id, '') = COALESCE(?, '')"
        )
        params: list = [ical_uid, source, recurrence_id]
        if not include_deleted:
            sql += " AND deleted_at IS NULL"
        with self._conn_ctx() as conn:
            row = conn.execute(sql, params).fetchone()
        return _row_to_dataclass(row) if row else None

    def list_event_rows(
        self,
        *,
        source: Optional[str] = None,
        calendar_name: Optional[str] = None,
        include_deleted: bool = False,
        limit: int = 10000,
        window_start: Optional[datetime] = None,
        window_end: Optional[datetime] = None,
    ) -> list[CalendarEventRow]:
        """读 raw rows (不展开 RRULE). worker / CLI / 调试用.

        F9 — ``window_start`` / ``window_end`` 提供时加 SQL filter:
        ``dtstart < end AND (rrule != '' OR dtend >= start)``
        含 RRULE master event 全保留 (它们可能 dtstart 远早于窗口但有
        occurrence 落进窗口, expander 后续过滤). 走 idx_calendar_event_dtstart
        索引, 数据量 ↑ 后避免全表扫.
        """
        clauses = []
        params: list = []
        if source:
            clauses.append("source = ?")
            params.append(source)
        if calendar_name:
            clauses.append("calendar_name = ?")
            params.append(calendar_name)
        if not include_deleted:
            clauses.append("deleted_at IS NULL")
        if window_end is not None:
            # dtstart 早于窗口 end (含 RRULE master 也可能跨进窗口)
            clauses.append("dtstart_utc < ?")
            params.append(_to_epoch(window_end))
        if window_start is not None:
            # 单次 event 要求 dtend 跨过窗口 start;
            # RRULE master (rrule != '') 直接保留, occurrence 在窗口内由
            # expander 决定
            clauses.append(
                "(rrule != '' OR dtend_utc IS NULL OR dtend_utc >= ?)"
            )
            params.append(_to_epoch(window_start))
        where_sql = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = (
            f"SELECT * FROM calendar_event{where_sql} "
            f"ORDER BY dtstart_utc ASC LIMIT ?"
        )
        params.append(limit)
        with self._conn_ctx() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_dataclass(r) for r in rows]

    def list_event_occurrences(
        self,
        start_utc: datetime,
        end_utc: datetime,
        *,
        source: Optional[str] = None,
        calendar_name: Optional[str] = None,
        expand_recurrences: bool = True,
        max_per_series: int = 500,
    ) -> list[CalendarEventOccurrence]:
        """前端日历视图主入口: 拉时间窗口内的展开 occurrences (含 RRULE 展开).

        Args:
            start_utc / end_utc: 窗口边界 (tz-aware UTC datetime).
            source: 过滤 'caldav' / 'email_ics' / 'legacy_calendar_app'; 留空全要.
            calendar_name: 过滤单个 CalDAV calendar.
            expand_recurrences: True (default) 把 RRULE 展开成 occurrences;
                False 只返回主事件本身.
            max_per_series: 单 RRULE 最多展开 N 个 occurrence (防 infinite RRULE).

        Returns:
            list of CalendarEventOccurrence, 按 occurrence_start_utc 升序.
            非 recurring 也用 CalendarEventOccurrence 包一层 (前端零特例).
        """
        # F9 — SQL 层先用 window filter 剪掉绝对落窗口外的非 RRULE rows
        # (走 idx_calendar_event_dtstart 索引), 仅剩 in-window single events +
        # 所有 RRULE master events 进 Python 端 expander 过滤. 数据量 ↑ 后
        # 避免全表扫.
        rows = self.list_event_rows(
            source=source,
            calendar_name=calendar_name,
            include_deleted=False,
            window_start=start_utc,
            window_end=end_utc,
        )

        occurrences: list[CalendarEventOccurrence] = []
        for r in rows:
            if r.rrule and expand_recurrences:
                # RRULE 展开窗口内 occurrences (expander 处理 EXDATE / RDATE)
                expanded = expand_in_window(
                    dtstart=r.dtstart_utc,
                    dtend=r.dtend_utc,
                    rrule=r.rrule,
                    exdates_iso=r.exdates,
                    rdates_iso=r.rdates,
                    window_start=start_utc,
                    window_end=end_utc,
                    max_count=max_per_series,
                )
                for occ_start, occ_end in expanded:
                    occurrences.append(CalendarEventOccurrence(
                        row=r,
                        occurrence_start_utc=occ_start,
                        occurrence_end_utc=occ_end,
                        is_recurrence_instance=True,
                    ))
            else:
                # 单次 event — 直接看 dtstart 是否落窗口内
                if r.dtstart_utc < end_utc and (
                    r.dtend_utc is None or r.dtend_utc > start_utc
                ):
                    occurrences.append(CalendarEventOccurrence(
                        row=r,
                        occurrence_start_utc=r.dtstart_utc,
                        occurrence_end_utc=r.dtend_utc or r.dtstart_utc,
                        is_recurrence_instance=False,
                    ))

        occurrences.sort(key=lambda o: o.occurrence_start_utc)
        return occurrences

    def list_calendar_names(self) -> list[str]:
        """枚举 calendar_event 表里出现过的 calendar_name (非空, distinct)."""
        with self._conn_ctx() as conn:
            rows = conn.execute(
                "SELECT DISTINCT calendar_name FROM calendar_event "
                "WHERE calendar_name != '' AND deleted_at IS NULL "
                "ORDER BY calendar_name"
            ).fetchall()
        return [r["calendar_name"] for r in rows]

    # --------------------------------------------------------
    # Sync state (CalDAV ctag / sync_token per-calendar)
    # --------------------------------------------------------

    def get_sync_state(self, calendar_name: str) -> Optional[CalendarSyncStateRow]:
        with self._conn_ctx() as conn:
            row = conn.execute(
                "SELECT * FROM calendar_sync_state WHERE calendar_name = ?",
                (calendar_name,),
            ).fetchone()
        if not row:
            return None
        return CalendarSyncStateRow(
            calendar_name=row["calendar_name"],
            ctag=row["ctag"],
            sync_token=row["sync_token"],
            last_full_sync_at=_from_epoch(row["last_full_sync_at"]),
            last_incremental_sync_at=_from_epoch(row["last_incremental_sync_at"]),
            last_error=row["last_error"],
            created_at=_from_epoch(row["created_at"]) or datetime.now(timezone.utc),
            updated_at=_from_epoch(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def upsert_sync_state(
        self,
        calendar_name: str,
        *,
        ctag: Optional[str] = None,
        sync_token: Optional[str] = None,
        full_sync: bool = False,
        last_error: Optional[str] = None,
    ) -> None:
        """记 worker 本轮 sync 结果 (ctag / sync_token / 时间戳)."""
        now = time.time()
        with self._conn_ctx() as conn:
            cur = conn.cursor()
            existing = cur.execute(
                "SELECT calendar_name FROM calendar_sync_state WHERE calendar_name = ?",
                (calendar_name,),
            ).fetchone()
            if existing:
                # 增量更新 — 只覆盖非 None 字段
                sets = ["updated_at = ?"]
                params: list = [now]
                if ctag is not None:
                    sets.append("ctag = ?")
                    params.append(ctag)
                if sync_token is not None:
                    sets.append("sync_token = ?")
                    params.append(sync_token)
                if full_sync:
                    sets.append("last_full_sync_at = ?")
                    params.append(now)
                # 永远更新 last_incremental_sync_at (本次 tick 时间)
                sets.append("last_incremental_sync_at = ?")
                params.append(now)
                # last_error: None = 清错; 非 None = 设错
                sets.append("last_error = ?")
                params.append(last_error)
                params.append(calendar_name)
                cur.execute(
                    f"UPDATE calendar_sync_state SET {', '.join(sets)} "
                    f"WHERE calendar_name = ?",
                    params,
                )
            else:
                cur.execute(
                    """
                    INSERT INTO calendar_sync_state (
                        calendar_name, ctag, sync_token,
                        last_full_sync_at, last_incremental_sync_at, last_error,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        calendar_name, ctag, sync_token,
                        now if full_sync else None, now, last_error,
                        now, now,
                    ),
                )
            conn.commit()

    def list_sync_states(self) -> list[CalendarSyncStateRow]:
        with self._conn_ctx() as conn:
            rows = conn.execute(
                "SELECT * FROM calendar_sync_state ORDER BY calendar_name"
            ).fetchall()
        return [
            CalendarSyncStateRow(
                calendar_name=r["calendar_name"],
                ctag=r["ctag"],
                sync_token=r["sync_token"],
                last_full_sync_at=_from_epoch(r["last_full_sync_at"]),
                last_incremental_sync_at=_from_epoch(r["last_incremental_sync_at"]),
                last_error=r["last_error"],
                created_at=_from_epoch(r["created_at"]) or datetime.now(timezone.utc),
                updated_at=_from_epoch(r["updated_at"]) or datetime.now(timezone.utc),
            )
            for r in rows
        ]


# ============================================================
# Row → dataclass adapter
# ============================================================

def _row_to_dataclass(row: sqlite3.Row) -> CalendarEventRow:
    return CalendarEventRow(
        id=int(row["id"]),
        ical_uid=row["ical_uid"],
        recurrence_id=row["recurrence_id"],
        sequence=int(row["sequence"] or 0),
        calendar_name=row["calendar_name"] or "",
        summary=row["summary"] or "",
        description=row["description"] or "",
        location=row["location"] or "",
        organizer=row["organizer"] or "",
        attendees=_decode_json_list(row["attendees_json"]),
        dtstart_utc=_from_epoch(row["dtstart_utc"]) or datetime.fromtimestamp(0, tz=timezone.utc),
        dtend_utc=_from_epoch(row["dtend_utc"]),
        is_all_day=bool(row["is_all_day"]),
        rrule=row["rrule"] or "",
        exdates=_decode_json_list(row["exdates_json"]),
        rdates=_decode_json_list(row["rdates_json"]),
        status=row["status"] or "",
        response_status=row["response_status"] or "",
        url=row["url"] or "",
        ics_raw=row["ics_raw"] or "",
        source=row["source"],
        notion_page_id=row["notion_page_id"],
        related_email_internal_id=row["related_email_internal_id"],
        last_synced_at=_from_epoch(row["last_synced_at"]) or datetime.fromtimestamp(0, tz=timezone.utc),
        deleted_at=_from_epoch(row["deleted_at"]),
        created_at=_from_epoch(row["created_at"]) or datetime.fromtimestamp(0, tz=timezone.utc),
        updated_at=_from_epoch(row["updated_at"]) or datetime.fromtimestamp(0, tz=timezone.utc),
    )
