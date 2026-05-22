"""DavMail UID backfill — 把 applescript 时代抓的存量邮件的 imap_uid 副字段补齐.

价值: 切到 davmail mode 后, DavMailBackend.fetch_email_by_id 优先用 (imap_uidvalidity,
imap_uid) 走 IMAP UID FETCH (~200ms); imap_uid 为 NULL 时 fallback 走 message_id IMAP
SEARCH HEADER (~1-2s + LOGIN). Backfill 后所有反向 flag / fetch 都走快路径.

Phase C.1 (plan §"Phase C — 数据列 + IMAP UID backfill + CalDAV enrichment").
触发时机: main.py 在 davmail mode startup 后延迟 10s, asyncio.create_task 后台跑,
不阻塞主循环. 进度写 sync_state 续传.

Schema 假设 (v13): email_metadata 有 imap_uidvalidity / imap_uid / backend_origin 列.
"""
from __future__ import annotations

import asyncio
import sqlite3
import time
from typing import TYPE_CHECKING, Optional

from loguru import logger

from src.mail.backend.imap_client import imap_connect

if TYPE_CHECKING:
    from src.config import Config
    from src.mail.sync_store import SyncStore


# 进度跟踪 key (sync_state 表)
_PROGRESS_KEY = "davmail_backfill_progress"
_LAST_INTERNAL_ID_KEY = "davmail_backfill_last_internal_id"

# IMAP UID SEARCH HEADER 反查特别耗时, 单条 ~100-300ms, 限制并发避免压垮 DavMail
_DEFAULT_BATCH_SIZE = 50


class DavMailUidMapper:
    """Backfill imap_uid 副字段给 backend_origin='applescript' AND imap_uid IS NULL 的存量邮件."""

    def __init__(
        self, cfg: "Config", sync_store: "SyncStore",
        *,
        batch_size: int = _DEFAULT_BATCH_SIZE,
        max_failures_per_batch: int = 20,
    ):
        self.cfg = cfg
        self.sync_store = sync_store
        self.batch_size = batch_size
        self.max_failures_per_batch = max_failures_per_batch

    def count_pending(self) -> int:
        """统计还需 backfill 的邮件数."""
        with sqlite3.connect(self.cfg.sync_store_db_path) as conn:
            row = conn.execute(
                """SELECT COUNT(*) FROM email_metadata
                   WHERE backend_origin IN ('applescript', NULL) AND imap_uid IS NULL
                     AND message_id IS NOT NULL"""
            ).fetchone()
            return int(row[0]) if row else 0

    async def run_backfill(self) -> dict:
        """主入口 — 全量 backfill 直到没有待处理或失败超阈值.

        Returns: {processed, backfilled, missing, failed, elapsed_sec}
        """
        t0 = time.time()
        total_processed = 0
        total_backfilled = 0
        total_missing = 0
        total_failed = 0

        # 起点: 从上次保存的 last_internal_id 续跑
        resume_str = self.sync_store.get_state(_LAST_INTERNAL_ID_KEY)
        last_iid = int(resume_str) if resume_str and resume_str.isdigit() else 0

        pending = self.count_pending()
        logger.info(f"[davmail-uid-mapper] start backfill, pending={pending}, resume_from={last_iid}")
        self.sync_store.set_state(_PROGRESS_KEY, f"running:pending={pending}")

        while True:
            batch = self._fetch_batch_to_backfill(last_iid)
            if not batch:
                break

            result = await self._backfill_one_batch(batch)
            total_processed += result["processed"]
            total_backfilled += result["backfilled"]
            total_missing += result["missing"]
            total_failed += result["failed"]
            last_iid = batch[-1][0]  # last internal_id
            self.sync_store.set_state(_LAST_INTERNAL_ID_KEY, str(last_iid))
            self.sync_store.set_state(
                _PROGRESS_KEY,
                f"running:processed={total_processed} backfilled={total_backfilled} "
                f"missing={total_missing} failed={total_failed}",
            )
            logger.info(
                f"[davmail-uid-mapper] batch done internal_id≤{last_iid}: "
                f"+{result['backfilled']} backfilled, +{result['missing']} missing, "
                f"+{result['failed']} failed (total backfilled={total_backfilled})"
            )

            if result["failed"] >= self.max_failures_per_batch:
                logger.warning(
                    f"[davmail-uid-mapper] aborting: batch failures "
                    f"({result['failed']}) >= max ({self.max_failures_per_batch})"
                )
                break

        elapsed = int(time.time() - t0)
        self.sync_store.set_state(
            _PROGRESS_KEY,
            f"completed:processed={total_processed} backfilled={total_backfilled} "
            f"missing={total_missing} failed={total_failed} elapsed={elapsed}s",
        )
        logger.info(
            f"[davmail-uid-mapper] backfill complete: "
            f"processed={total_processed} backfilled={total_backfilled} "
            f"missing={total_missing} failed={total_failed} elapsed={elapsed}s"
        )
        return {
            "processed": total_processed, "backfilled": total_backfilled,
            "missing": total_missing, "failed": total_failed, "elapsed_sec": elapsed,
        }

    def _fetch_batch_to_backfill(self, after_internal_id: int) -> list[tuple[int, str, str]]:
        """SELECT (internal_id, message_id, mailbox) batch_size 条邮件, 排除已处理."""
        with sqlite3.connect(self.cfg.sync_store_db_path) as conn:
            rows = conn.execute(
                """SELECT internal_id, message_id, mailbox FROM email_metadata
                   WHERE (backend_origin = 'applescript' OR backend_origin IS NULL)
                     AND imap_uid IS NULL
                     AND message_id IS NOT NULL
                     AND internal_id > ?
                   ORDER BY internal_id ASC
                   LIMIT ?""",
                (after_internal_id, self.batch_size),
            ).fetchall()
            return [(int(r[0]), r[1], r[2] or "收件箱") for r in rows]

    async def _backfill_one_batch(
        self, batch: list[tuple[int, str, str]]
    ) -> dict:
        """处理一批 — 单 IMAP 连接 reuse, 每条 SEARCH HEADER Message-ID + UPDATE."""
        processed = 0
        backfilled = 0
        missing = 0
        failed = 0

        # 同步 IMAP 在 to_thread 里跑, 避免阻塞 event loop
        def _sync_backfill():
            nonlocal processed, backfilled, missing, failed
            try:
                imap = imap_connect(self.cfg, timeout=30)
            except Exception as e:
                logger.error(f"[davmail-uid-mapper] IMAP connect failed: {e}")
                # 整批标 failed
                failed += len(batch)
                return

            try:
                # 按 mailbox 分组减少 SELECT
                from collections import defaultdict
                by_mailbox: dict[str, list[tuple[int, str]]] = defaultdict(list)
                for iid, mid, mbox in batch:
                    by_mailbox[mbox].append((iid, mid))

                from src.mail.backend.davmail_backend import (
                    DavMailBackend, _mailbox_to_imap,
                )
                # 拿 uidvalidity 一次性, 每个 mailbox 内 SELECT 后 STATUS
                uv_cache: dict[str, Optional[int]] = {}

                for mbox, items in by_mailbox.items():
                    imap_box = _mailbox_to_imap(mbox)
                    typ, _ = imap.select(imap_box, readonly=True)
                    if typ != "OK":
                        logger.warning(f"[davmail-uid-mapper] SELECT {imap_box!r} failed")
                        failed += len(items)
                        processed += len(items)
                        continue
                    # uidvalidity
                    if mbox not in uv_cache:
                        typ, data = imap.status(imap_box, "(UIDVALIDITY)")
                        if typ == "OK" and data:
                            uv_str = DavMailBackend._extract_status_value(
                                data[0], "UIDVALIDITY"
                            )
                            uv_cache[mbox] = int(uv_str) if uv_str else None

                    uv = uv_cache.get(mbox)

                    for iid, mid in items:
                        processed += 1
                        uid = DavMailBackend._lookup_uid_by_message_id(imap, mid)
                        if uid:
                            # UPDATE email_metadata
                            try:
                                with sqlite3.connect(self.cfg.sync_store_db_path) as conn:
                                    conn.execute(
                                        """UPDATE email_metadata
                                           SET imap_uid = ?, imap_uidvalidity = ?
                                           WHERE internal_id = ?""",
                                        (uid, uv, iid),
                                    )
                                    conn.commit()
                                backfilled += 1
                            except Exception as e:
                                logger.warning(
                                    f"[davmail-uid-mapper] UPDATE iid={iid} failed: {e}"
                                )
                                failed += 1
                        else:
                            # 没找到 (邮件被删 / 在别的 mailbox) — 标 -1 表示永久 miss
                            try:
                                with sqlite3.connect(self.cfg.sync_store_db_path) as conn:
                                    conn.execute(
                                        """UPDATE email_metadata
                                           SET imap_uid = -1
                                           WHERE internal_id = ?""",
                                        (iid,),
                                    )
                                    conn.commit()
                                missing += 1
                            except Exception as e:
                                logger.warning(
                                    f"[davmail-uid-mapper] mark missing iid={iid} failed: {e}"
                                )
                                failed += 1
            finally:
                try:
                    imap.logout()
                except Exception:
                    pass

        await asyncio.to_thread(_sync_backfill)
        return {
            "processed": processed, "backfilled": backfilled,
            "missing": missing, "failed": failed,
        }


async def schedule_backfill_task(cfg: "Config", sync_store: "SyncStore", delay_sec: int = 10):
    """供 main.py 调用 — 延迟 N 秒启动 backfill task (避免跟启动其他 task 抢资源)."""
    await asyncio.sleep(delay_sec)
    mapper = DavMailUidMapper(cfg, sync_store)
    pending = mapper.count_pending()
    if pending == 0:
        logger.info("[davmail-uid-mapper] no pending emails, skip backfill")
        return
    logger.info(f"[davmail-uid-mapper] scheduling backfill ({pending} emails)")
    await mapper.run_backfill()
