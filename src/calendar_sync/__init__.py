"""calendar_sync — CalDAV → SQLite (calendar_event 表) SSoT 同步模块.

Phase 1 (plan §1.3): 把 DavMail CalDAV 当 source-of-truth, 增量 sync 到本地
SQLite calendar_event 表. 前端日历视图 / CLI calendar events / Notion mirror
全部从该表读, Outlook 端 (CalDAV) 一动 worker 60s 内捕获 + 落库.

公共 API:
    CalendarEventRepository — CRUD + 时间窗口查询 + 软删除
    CalendarEventRow / CalendarEventOccurrence — 数据模型
    CalendarSyncWorker — asyncio loop 主入口 (main.py 启动时挂)
    CalendarReconciler — CalDAV diff → SQLite upsert (worker 内部用, 也可单跑)
    expand_in_window — RRULE 展开窗口内 occurrences (dateutil 复用)

模块内部组件:
    repository.py — SQLite 读写封装
    expander.py — RRULE → occurrence list
    reconciler.py — CalDAV CalendarEvent → SQLite upsert/soft-delete diff
    worker.py — asyncio 主循环 (ctag 60s 轮询 + 增量 sync)
"""
from __future__ import annotations

from src.calendar_sync.expander import expand_in_window
from src.calendar_sync.reconciler import CalendarReconciler
from src.calendar_sync.repository import (
    CalendarEventOccurrence,
    CalendarEventRepository,
    CalendarEventRow,
    CalendarSyncStateRow,
)
from src.calendar_sync.worker import CalendarSyncWorker

__all__ = [
    "CalendarEventRepository",
    "CalendarEventRow",
    "CalendarEventOccurrence",
    "CalendarSyncStateRow",
    "CalendarReconciler",
    "CalendarSyncWorker",
    "expand_in_window",
]
