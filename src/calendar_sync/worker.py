"""CalendarSyncWorker — DavMail CalDAV → SQLite calendar_event 表的增量 sync loop.

Phase 1 (plan §1.3): asyncio 长循环, 跟 FanoutWorker 同生命周期. 启动时全量
初始化 (拉 -1m / +5m 窗口, 落库 + 记 ctag/sync_token), 然后主循环 60s 拉 ctag
跟存的比, 变了就 sync-collection (RFC 6578) / 失败降级到 ctag 全窗口 re-read.

为什么不开独立 PM2 进程:
- 跟 mail-sync 共享 sqlite (PRAGMA WAL) + cfg + 日志, 单进程更清爽.
- 60s 一轮 CalDAV PROPFIND ctag + 偶尔的 sync-collection, 资源占用极低,
  不影响主 mail sync.
- legacy 'calendar-sync' PM2 进程依然保留 (灰度共存), 跑老 EventKit 路径.

线程安全:
- worker 是 asyncio loop, 同进程内单实例 (main.py 只 create_task 一次).
- CalDAVReader / Repository / Reconciler 都用 sqlite3 短连接 + WAL, 跨线程安全.
- 反复运行幂等: ctag 没变跳过, ctag 变了走 upsert 也是 ON CONFLICT idempotent.
"""
from __future__ import annotations

import asyncio
import traceback
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Optional

from loguru import logger

from src.calendar_sync.reconciler import CalendarReconciler

if TYPE_CHECKING:
    from src.calendar_notion.caldav_reader import CalDAVReader
    from src.calendar_sync.repository import CalendarEventRepository
    from src.config import Config


class CalendarSyncWorker:
    """CalDAV → SQLite 增量 sync 主循环.

    用法:
        worker = CalendarSyncWorker(cfg, reader, repo)
        asyncio.create_task(worker.run())  # main.py 启动序列

    可观察性:
        - calendar_sync_state 表里每个 calendar 一行 (ctag / sync_token / 时间戳)
        - mailagent calendar sync-status 命令读上述表显示
    """

    def __init__(
        self,
        cfg: "Config",
        reader: "CalDAVReader",
        repo: "CalendarEventRepository",
        *,
        poll_interval: float = 60.0,
        full_sync_window_days: int = 180,
        full_sync_past_days: int = 30,
    ):
        """
        Args:
            cfg: 全局 config (用 calendar_caldav_sync_enabled 开关检查).
            reader: 已初始化的 CalDAVReader 实例.
            repo: CalendarEventRepository (跟 mail-sync 共享同 db_path).
            poll_interval: ctag 轮询间隔 (秒). 默认 60s 平衡 freshness vs CalDAV 负载.
            full_sync_window_days: 启动全量 sync 窗口右边界 (今天 + N 天).
                                   默认 180 = 半年未来日历.
            full_sync_past_days: 启动全量 sync 窗口左边界 (今天 - N 天). 默认 30.
        """
        self.cfg = cfg
        self.reader = reader
        self.repo = repo
        self.reconciler = CalendarReconciler(repo)
        self.poll_interval = poll_interval
        self.full_sync_window_days = full_sync_window_days
        self.full_sync_past_days = full_sync_past_days
        self._stop = asyncio.Event()
        self._calendars: list[str] = []

    def stop(self) -> None:
        """通知 worker 优雅停止. 当前 tick 跑完后退出."""
        self._stop.set()

    async def run(self) -> None:
        """主入口 — 启动全量 sync + 进入 ctag 轮询 loop.

        - 失败容忍: 任何一轮挂掉都 log + 继续, 不让 worker 静默死.
        - 优雅退出: ``stop()`` 信号 + asyncio.CancelledError 都 graceful 关.
        """
        if not getattr(self.cfg, "calendar_caldav_sync_enabled", False):
            logger.info(
                "[calendar-sync-worker] disabled by cfg.calendar_caldav_sync_enabled=False"
            )
            return

        logger.info(
            f"[calendar-sync-worker] starting "
            f"(poll={self.poll_interval}s, window=[-{self.full_sync_past_days}d, "
            f"+{self.full_sync_window_days}d])"
        )

        try:
            # 1. 拉 calendar 列表 (启动一次, 假设运行期不动态新增 calendar)
            try:
                self._calendars = await asyncio.to_thread(
                    self.reader.list_calendar_names_for_sync
                )
                logger.info(
                    f"[calendar-sync-worker] discovered {len(self._calendars)} "
                    f"calendars: {self._calendars}"
                )
            except Exception as e:
                logger.error(
                    f"[calendar-sync-worker] list_calendar_names_for_sync failed: {e} "
                    f"— 降级到固定单 calendar 'calendar'"
                )
                self._calendars = ["calendar"]

            # 2. 全量初始化
            await self._initial_full_sync()

            # 3. 主轮询 loop
            while not self._stop.is_set():
                try:
                    await asyncio.wait_for(
                        self._stop.wait(), timeout=self.poll_interval
                    )
                    break  # _stop 触发 → 退
                except asyncio.TimeoutError:
                    pass

                try:
                    await self._tick()
                except Exception as e:
                    logger.error(
                        f"[calendar-sync-worker] tick failed: {e}\n"
                        f"{traceback.format_exc()}"
                    )

        except asyncio.CancelledError:
            logger.info("[calendar-sync-worker] cancelled — exiting")
            raise
        finally:
            logger.info("[calendar-sync-worker] stopped")

    # --------------------------------------------------------
    # Sync stages
    # --------------------------------------------------------

    async def _initial_full_sync(self) -> None:
        """启动全量 — 对每个 calendar 拉窗口内 events, 全 reconcile_full_window."""
        window_start, window_end = self._sync_window()
        logger.info(
            f"[calendar-sync-worker] initial full sync "
            f"[{window_start.isoformat()}, {window_end.isoformat()})"
        )

        for cal_name in self._calendars:
            try:
                events = await asyncio.to_thread(
                    self.reader.list_events_with_full_detail,
                    window_start,
                    window_end,
                    calendar_name=cal_name,
                )
                stats = self.reconciler.reconcile_full_window(
                    events,
                    calendar_name=cal_name,
                    window_start=window_start,
                    window_end=window_end,
                )
                # 拿 ctag, 落 sync_state
                ctag = await asyncio.to_thread(
                    self.reader.get_collection_ctag, cal_name
                )
                self.repo.upsert_sync_state(
                    cal_name, ctag=ctag, full_sync=True, last_error=None
                )
                logger.info(
                    f"[calendar-sync-worker] full sync done for {cal_name!r}: "
                    f"upserted={stats.upserted} soft_deleted={stats.soft_deleted}"
                )
            except Exception as e:
                logger.error(
                    f"[calendar-sync-worker] full sync for {cal_name!r} failed: {e}"
                )
                self.repo.upsert_sync_state(cal_name, last_error=str(e)[:500])

    async def _tick(self) -> None:
        """单次增量 tick — 对每个 calendar 查 ctag, 变了就增量 / 重读."""
        for cal_name in self._calendars:
            try:
                await self._tick_one_calendar(cal_name)
            except Exception as e:
                logger.warning(
                    f"[calendar-sync-worker] tick_one {cal_name!r} failed: {e}"
                )
                self.repo.upsert_sync_state(cal_name, last_error=str(e)[:500])

    async def _tick_one_calendar(self, cal_name: str) -> None:
        # 1. 拉新 ctag, 跟存的比
        new_ctag = await asyncio.to_thread(self.reader.get_collection_ctag, cal_name)
        state = self.repo.get_sync_state(cal_name)
        old_ctag = state.ctag if state else None

        if new_ctag is not None and new_ctag == old_ctag:
            # ctag 没变 — 只更新 last_incremental_sync_at, 不动 ctag/data
            self.repo.upsert_sync_state(cal_name, last_error=None)
            return

        # CTag 不可用兜底 (DavMail 6.7 PROPFIND getctag 实测返 None):
        # 没 ctag 信号, 改用时间间隔. 默认 1h 内不重做 full sync — 用户改了日历
        # 最多 1h 延迟看到. 真要更快用户可手动 `mailagent calendar sync-now`.
        if new_ctag is None and state and state.last_full_sync_at:
            stale_sec = (
                datetime.now(timezone.utc) - state.last_full_sync_at
            ).total_seconds()
            if stale_sec < 3600:
                # ctag 不可用 + 上次 full sync < 1h 前 → 跳过
                self.repo.upsert_sync_state(cal_name, last_error=None)
                return

        logger.info(
            f"[calendar-sync-worker] {cal_name!r} ctag changed "
            f"({old_ctag} → {new_ctag}); syncing"
        )

        # 2. 尝试 sync-collection 增量
        old_token = state.sync_token if state else None
        changed, deleted, new_token = await asyncio.to_thread(
            self.reader.sync_collection, cal_name, old_token
        )

        if new_token is not None and (changed or deleted):
            # 增量路径成功
            self.reconciler.reconcile_incremental(
                changed, deleted, calendar_name=cal_name
            )
            self.repo.upsert_sync_state(
                cal_name, ctag=new_ctag, sync_token=new_token, last_error=None
            )
            return

        # 3. 增量不可用 / 空结果 — 降级到全窗口 re-read
        logger.info(
            f"[calendar-sync-worker] {cal_name!r} sync-collection not available "
            f"or empty — full window re-read"
        )
        window_start, window_end = self._sync_window()
        events = await asyncio.to_thread(
            self.reader.list_events_with_full_detail,
            window_start,
            window_end,
            calendar_name=cal_name,
        )
        self.reconciler.reconcile_full_window(
            events,
            calendar_name=cal_name,
            window_start=window_start,
            window_end=window_end,
        )
        self.repo.upsert_sync_state(cal_name, ctag=new_ctag, last_error=None)

    def _sync_window(self) -> tuple[datetime, datetime]:
        """计算当前 sync 窗口 [today - past_days, today + future_days)."""
        now = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        start = now - timedelta(days=self.full_sync_past_days)
        end = now + timedelta(days=self.full_sync_window_days)
        return start, end
