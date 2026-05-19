"""FanoutWorker — asyncio loop, 异步消费 email_outbox.

主循环每 N 秒（默认 5s）拉一批 pending/failed-ready 的 outbox 行,
按 target 分流到 MailAppFanout / NotionFanout 并行执行（有限并发）。

执行流程 per entry:
    1. mark_processing(outbox_id)
    2. fanout.execute(entry) → (success, detail)
    3. success → mark_done
       failure → mark_failed（attempts++, 退避 or dead_letter）
    4. 异常 → mark_failed (兜底)

并发：默认 3 并发（同时处理 3 条 outbox，跨 target）.
关闭：`stop()` 设置 stop_event，主 loop 退出。

详见 SPRINT15-HANDOFF.md §3.3 + plan Stage 1.3.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from loguru import logger

from src.sync.outbox import OutboxEntry, OutboxRepository


class FanoutWorker:
    """outbox 异步派发主循环."""

    def __init__(
        self,
        *,
        outbox_repo: OutboxRepository,
        mailapp_fanout,                       # MailAppFanout 实例
        notion_fanout,                        # NotionFanout 实例
        poll_interval_sec: int = 5,
        batch_size: int = 10,
        concurrency: int = 3,
        max_attempts: int = 5,
    ):
        self.outbox_repo = outbox_repo
        self.mailapp_fanout = mailapp_fanout
        self.notion_fanout = notion_fanout
        self.poll_interval_sec = poll_interval_sec
        self.batch_size = batch_size
        self.concurrency = concurrency
        self.max_attempts = max_attempts

        self._stop_event = asyncio.Event()
        self._sem: Optional[asyncio.Semaphore] = None
        self._stats = {
            "polled": 0,
            "done": 0,
            "failed": 0,
            "dead_letter": 0,
            "noop": 0,
        }

    @property
    def stats(self) -> dict:
        return dict(self._stats)

    def stop(self) -> None:
        """请求主循环退出. 当前 in-flight 会跑完."""
        self._stop_event.set()

    async def run(self) -> None:
        """主循环. 调用方 asyncio.create_task(worker.run())."""
        self._sem = asyncio.Semaphore(self.concurrency)
        logger.info(
            f"[fanout-worker] starting poll_interval={self.poll_interval_sec}s "
            f"batch={self.batch_size} concurrency={self.concurrency} "
            f"max_attempts={self.max_attempts}"
        )

        while not self._stop_event.is_set():
            try:
                await self._tick()
            except Exception as e:
                logger.error(f"[fanout-worker] tick crash: {e}", exc_info=True)

            # 用 wait_for 让 stop_event 能立即跳出 sleep
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(), timeout=self.poll_interval_sec
                )
            except asyncio.TimeoutError:
                continue

        logger.info(
            f"[fanout-worker] stopped. stats={self._stats}"
        )

    async def _tick(self) -> None:
        """单次 poll + dispatch."""
        entries = self.outbox_repo.poll_ready(limit=self.batch_size)
        if not entries:
            return

        self._stats["polled"] += len(entries)
        logger.debug(f"[fanout-worker] picked {len(entries)} entries")

        # 并发处理本批，最多 concurrency 个同时跑
        await asyncio.gather(
            *(self._process_one(entry) for entry in entries),
            return_exceptions=False,
        )

    async def _process_one(self, entry: OutboxEntry) -> None:
        """执行一条 outbox：mark_processing → fanout.execute → mark_done/failed."""
        assert self._sem is not None
        async with self._sem:
            outbox_id = entry.outbox_id
            if not self.outbox_repo.mark_processing(outbox_id):
                # 并发场景另一个 worker 已抢到, 跳过
                logger.debug(
                    f"[fanout-worker] mark_processing failed (race): outbox_id={outbox_id}"
                )
                return

            try:
                fanout = self._select_fanout(entry.target)
                if fanout is None:
                    self.outbox_repo.mark_failed(
                        outbox_id,
                        f"no fanout for target={entry.target!r}",
                        max_attempts=self.max_attempts,
                    )
                    self._stats["failed"] += 1
                    return

                success, detail = await fanout.execute(entry)
                if success:
                    self.outbox_repo.mark_done(outbox_id)
                    self._stats["done"] += 1
                    if detail.startswith("noop"):
                        self._stats["noop"] += 1
                else:
                    result = self.outbox_repo.mark_failed(
                        outbox_id, detail, max_attempts=self.max_attempts
                    )
                    if result["status"] == "dead_letter":
                        self._stats["dead_letter"] += 1
                    else:
                        self._stats["failed"] += 1

            except Exception as e:
                logger.error(
                    f"[fanout-worker] exception processing outbox_id={outbox_id}: {e}",
                    exc_info=True,
                )
                result = self.outbox_repo.mark_failed(
                    outbox_id,
                    f"{type(e).__name__}: {e}",
                    max_attempts=self.max_attempts,
                )
                if result["status"] == "dead_letter":
                    self._stats["dead_letter"] += 1
                else:
                    self._stats["failed"] += 1

    def _select_fanout(self, target: str):
        if target == "mailapp":
            return self.mailapp_fanout
        if target == "notion":
            return self.notion_fanout
        return None
