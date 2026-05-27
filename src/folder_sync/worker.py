"""FolderSyncWorker — Archive/Drafts IMAP → SQLite folder_email 增量 sync loop.

对标 src/calendar_sync/worker.py CalendarSyncWorker: mail-sync 进程内 asyncio loop.
启动全量 (drafts + archive 各一次 sync_folder_once), 然后 poll_interval 轮询 IMAP
STATUS (UIDVALIDITY UIDNEXT) 判断变化, 变了才 sync. 每 force_full_every_n_ticks 强制
一次 full (捕获"无新增但有删除"的纯删除场景, reconcile 软删).

davmail-only: main.py 仅在 MAILAGENT_BACKEND=davmail + MAILBOX_FOLDER_SYNC_ENABLED
时构造本 worker. AppleScript 模式不启动.
"""
from __future__ import annotations

import asyncio
import time
import traceback
from typing import TYPE_CHECKING

from loguru import logger

from src.folder_sync.sync_ops import sync_folder_once

if TYPE_CHECKING:
    from src.config import Config
    from src.folder_sync.imap_folder_reader import FolderImapReader
    from src.folder_sync.repository import FolderEmailRepository

_FOLDERS = ("drafts", "archive")


class FolderSyncWorker:
    """Archive/Drafts → SQLite 增量 sync 主循环."""

    def __init__(
        self,
        cfg: "Config",
        reader: "FolderImapReader",
        repo: "FolderEmailRepository",
        *,
        poll_interval: float = 60.0,
        force_full_every_n_ticks: int = 60,
    ):
        """
        Args:
            poll_interval: IMAP STATUS 轮询间隔 (秒). 默认 60s.
            force_full_every_n_ticks: 每 N tick 强制 full sync 一次 (默认 60 ≈ 1h at
                60s poll). 捕获 STATUS 看不出的纯删除 (uidnext 不变但邮件被移走).
        """
        self.cfg = cfg
        self.reader = reader
        self.repo = repo
        self.poll_interval = poll_interval
        self.force_full_every_n_ticks = force_full_every_n_ticks
        self._stop = asyncio.Event()
        self._tick_count = 0

    def stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        if not getattr(self.cfg, "mailbox_folder_sync_enabled", False):
            logger.info("[folder-sync-worker] disabled by cfg.mailbox_folder_sync_enabled")
            return
        logger.info(f"[folder-sync-worker] starting (poll={self.poll_interval}s)")
        try:
            await self._initial_full_sync()
            while not self._stop.is_set():
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self.poll_interval)
                    break  # _stop 触发 → 退
                except asyncio.TimeoutError:
                    pass
                try:
                    await self._tick()
                except Exception as e:
                    logger.error(
                        f"[folder-sync-worker] tick failed: {e}\n{traceback.format_exc()}"
                    )
        except asyncio.CancelledError:
            logger.info("[folder-sync-worker] cancelled — exiting")
            raise
        finally:
            logger.info("[folder-sync-worker] stopped")

    async def _initial_full_sync(self) -> None:
        for folder in _FOLDERS:
            try:
                await asyncio.to_thread(
                    sync_folder_once, folder,
                    reader=self.reader, repo=self.repo, cfg=self.cfg, full=True,
                )
                status = await asyncio.to_thread(self.reader.folder_status, folder)
                if status:
                    uv, un = status
                    self.repo.upsert_sync_state(folder, imap_uidvalidity=uv, last_uidnext=un)
            except Exception as e:
                logger.error(f"[folder-sync-worker] initial sync {folder!r} failed: {e}")
                try:
                    self.repo.upsert_sync_state(folder, last_error=str(e)[:500])
                except Exception:
                    pass

    async def _tick(self) -> None:
        self._tick_count += 1
        force_full = (
            self.force_full_every_n_ticks > 0
            and self._tick_count % self.force_full_every_n_ticks == 0
        )
        for folder in _FOLDERS:
            try:
                await self._tick_one(folder, force_full)
            except Exception as e:
                logger.warning(f"[folder-sync-worker] tick_one {folder!r} failed: {e}")

    async def _tick_one(self, folder: str, force_full: bool) -> None:
        status = await asyncio.to_thread(self.reader.folder_status, folder)
        if status is None:
            return  # folder 不存在 (如无 Archive)
        uv, un = status
        state = self.repo.get_sync_state(folder)
        changed = (
            force_full
            or state is None
            or state.last_uidnext != un
            or state.imap_uidvalidity != uv
        )
        if not changed:
            return
        logger.info(
            f"[folder-sync-worker] {folder!r} changed (uv={uv} uidnext={un} "
            f"force_full={force_full}); syncing"
        )
        await asyncio.to_thread(
            sync_folder_once, folder,
            reader=self.reader, repo=self.repo, cfg=self.cfg, full=True,
        )
        self.repo.upsert_sync_state(
            folder, imap_uidvalidity=uv, last_uidnext=un,
            last_incremental_sync_at=time.time(),
        )
