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

# EWS throttle 暂停标志 (davmail_watchdog 写, 此处消费)。2026-06-11 前 backfill
# 主循环根本不读这个标志 — watchdog "auto-paused" 只是写了个没人看的键; 且 watchdog
# 的解除分支依赖进程内存态 (_announced_throttle_burst), 重启后 paused=true 永久残留。
# 修复: 每批前检查; paused 时等待轮询, 超过 _PAUSE_AUTO_RESUME_SEC 自动复位。
_PAUSED_KEY = "davmail_uid_backfill_paused"
_PAUSED_AT_KEY = "davmail_uid_backfill_paused_at"
_PAUSE_AUTO_RESUME_SEC = 24 * 3600
_PAUSE_POLL_INTERVAL_SEC = 60

# 整批失败 (IMAP connect / SELECT 超时等瞬态故障) 的重试策略: 不推进 marker,
# 退避后重试同一批; 连续 _MAX_CONSECUTIVE_FAILED_BATCHES 批全失败才放弃。
# 2026-06-11 实测: davmail EXAMINE 88k INBOX 偶发 >30s, 单次超时不该终结整个 backfill。
_FAILED_BATCH_BACKOFF_SEC = 30.0
_MAX_CONSECUTIVE_FAILED_BATCHES = 3

# IMAP 连接/命令超时。EXAMINE 大 INBOX (7w+) davmail 要重建全量 UID map, 偶发 >30s —
# 与 get_current_max_row_id 的 30→90 修复 (d9b90ec) 同理。
_IMAP_TIMEOUT_SEC = 90

# IMAP UID SEARCH HEADER 反查特别耗时, 单条 ~100-300ms, 限制并发避免压垮 DavMail.
# Sprint 16 收尾: batch 50→20 + sleep_between=3s, 防 EWS searchMessages throttling.
_DEFAULT_BATCH_SIZE = 20
_DEFAULT_SLEEP_BETWEEN_SEC = 3.0


class DavMailUidMapper:
    """Backfill imap_uid 副字段给 backend_origin='applescript' AND imap_uid IS NULL 的存量邮件."""

    def __init__(
        self, cfg: "Config", sync_store: "SyncStore",
        *,
        batch_size: int = _DEFAULT_BATCH_SIZE,
        max_failures_per_batch: int = 20,
        sleep_between_batches_sec: float = _DEFAULT_SLEEP_BETWEEN_SEC,
    ):
        self.cfg = cfg
        self.sync_store = sync_store
        self.batch_size = batch_size
        self.max_failures_per_batch = max_failures_per_batch
        self.sleep_between_batches_sec = sleep_between_batches_sec

    def count_pending(self) -> int:
        """统计还需 backfill 的邮件数.

        review NIT: 旧版用 ``backend_origin IN ('applescript', NULL)`` — SQLite
        ``IN (NULL)`` 永远 false (NULL 等于性按 IS 算), 真实结果是只统计了
        ``backend_origin='applescript'`` 的行, NULL backend_origin 的存量邮件被漏算.
        改用显式 ``= 'applescript' OR IS NULL`` (跟 ``_fetch_batch_to_backfill`` 一致).
        """
        with sqlite3.connect(self.cfg.sync_store_db_path, timeout=5.0) as conn:
            conn.execute("PRAGMA busy_timeout = 5000")
            row = conn.execute(
                """SELECT COUNT(*) FROM email_metadata
                   WHERE (backend_origin = 'applescript' OR backend_origin IS NULL)
                     AND imap_uid IS NULL
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

        consecutive_failed_batches = 0
        completed_naturally = False
        while True:
            await self._wait_if_paused()
            batch = self._fetch_batch_to_backfill(last_iid)
            if not batch:
                completed_naturally = True
                break

            result = await self._backfill_one_batch(batch)

            # 整批失败 (connect / SELECT 瞬态超时) → 不推进 marker, 退避重试同一批。
            # 否则失败的 20 条被 marker 永久跳过 (resume key 不会回卷), 直到下次全量。
            if result["failed"] >= len(batch):
                consecutive_failed_batches += 1
                if consecutive_failed_batches >= _MAX_CONSECUTIVE_FAILED_BATCHES:
                    total_failed += result["failed"]
                    logger.warning(
                        f"[davmail-uid-mapper] aborting: "
                        f"{consecutive_failed_batches} consecutive fully-failed batches"
                    )
                    break
                logger.warning(
                    f"[davmail-uid-mapper] batch fully failed "
                    f"({consecutive_failed_batches}/{_MAX_CONSECUTIVE_FAILED_BATCHES}), "
                    f"retrying same batch after {_FAILED_BATCH_BACKOFF_SEC}s"
                )
                await asyncio.sleep(_FAILED_BATCH_BACKOFF_SEC)
                continue
            consecutive_failed_batches = 0

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

            # Sprint 16 收尾: 每批 sleep 给 davmail 端 EWS 喘息, 防 throttling
            if self.sleep_between_batches_sec > 0:
                await asyncio.sleep(self.sleep_between_batches_sec)

        # 跑完一轮但还有残留 (中途 partial failure 被 marker 跳过的行) → 回卷 marker,
        # 让下次启动从头再扫一遍。永久 miss 已标 imap_uid=-1 不在 pending 集, 不会死循环。
        if completed_naturally and self.count_pending() > 0:
            self.sync_store.set_state(_LAST_INTERNAL_ID_KEY, "0")
            logger.info(
                "[davmail-uid-mapper] pass complete with leftovers "
                f"({self.count_pending()} still pending), resume marker reset to 0"
            )

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

    async def _wait_if_paused(self) -> None:
        """EWS throttle 暂停时等待; 暂停超过 _PAUSE_AUTO_RESUME_SEC 自动复位.

        watchdog 只写 paused=true, 时间戳可能缺 (旧版 watchdog / 手动 set) —
        缺时补一个 "从现在起算", 保证残留的 stale paused 标志最多再活 24h。
        """
        announced = False
        while self.sync_store.get_state(_PAUSED_KEY) == "true":
            paused_at_raw = self.sync_store.get_state(_PAUSED_AT_KEY)
            try:
                paused_at = float(paused_at_raw) if paused_at_raw else None
            except (TypeError, ValueError):
                paused_at = None
            if paused_at is None:
                paused_at = time.time()
                self.sync_store.set_state(_PAUSED_AT_KEY, str(paused_at))
            if time.time() - paused_at >= _PAUSE_AUTO_RESUME_SEC:
                self.sync_store.set_state(_PAUSED_KEY, "false")
                logger.info(
                    "[davmail-uid-mapper] paused flag exceeded "
                    f"{_PAUSE_AUTO_RESUME_SEC}s, auto-resuming backfill"
                )
                break
            if not announced:
                logger.info(
                    "[davmail-uid-mapper] backfill paused by EWS throttle flag, "
                    f"polling every {_PAUSE_POLL_INTERVAL_SEC}s (auto-resume after 24h)"
                )
                self.sync_store.set_state(_PROGRESS_KEY, "paused:ews_throttle")
                announced = True
            await asyncio.sleep(_PAUSE_POLL_INTERVAL_SEC)

    def _fetch_batch_to_backfill(self, after_internal_id: int) -> list[tuple[int, str, str]]:
        """SELECT (internal_id, message_id, mailbox) batch_size 条邮件, 排除已处理."""
        with sqlite3.connect(self.cfg.sync_store_db_path, timeout=5.0) as conn:
            conn.execute("PRAGMA busy_timeout = 5000")
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
        """处理一批 — 单 IMAP 连接 reuse, 单 SQLite 连接 + executemany 批量 UPDATE.

        review HIGH #7: 旧版每条 UID 命中/缺失都 ``sqlite3.connect`` 一次, 50/batch ×
        8857 邮件 → 8857 次 connect (~3-5ms each on macOS APFS), 整体 ~30-45s 纯连接
        开销, 并发跟主 mail-sync loop 抢 GIL. 改成单连接 + 累积 UPDATE + 末尾
        executemany, 阻塞时间从 N×latency 降到 一次 commit.
        """
        processed = 0
        backfilled = 0
        missing = 0
        failed = 0

        # 同步 IMAP + SQLite 在 to_thread 里跑, 避免阻塞 event loop
        def _sync_backfill():
            nonlocal processed, backfilled, missing, failed
            try:
                imap = imap_connect(self.cfg, timeout=_IMAP_TIMEOUT_SEC)
            except Exception as e:
                logger.error(f"[davmail-uid-mapper] IMAP connect failed: {e}")
                # 整批标 failed
                failed += len(batch)
                processed += len(batch)
                return

            # 累积 UPDATE 参数, 末尾 executemany 一次性提交
            backfill_params: list[tuple[int, Optional[int], int]] = []  # (uid, uv, iid)
            missing_params: list[tuple[int]] = []  # (iid,) — 标 -1 表示永久 miss

            try:
                # 按 mailbox 分组减少 SELECT
                from collections import defaultdict
                by_mailbox: dict[str, list[tuple[int, str]]] = defaultdict(list)
                for iid, mid, mbox in batch:
                    by_mailbox[mbox].append((iid, mid))

                from src.mail.backend.davmail_backend import (
                    DavMailBackend,
                    _mailbox_to_imap,
                    _read_uidvalidity_from_select,
                )

                conn_dead = False
                for mbox, items in by_mailbox.items():
                    imap_box = _mailbox_to_imap(mbox)
                    if conn_dead:
                        failed += len(items)
                        processed += len(items)
                        continue
                    # SELECT 超时必须按"失败"处理而非抛穿 run_backfill —
                    # 旧版异常直接炸死整个 backfill task (进度残留 "running:",
                    # 2026-06-11 实锤 processed=240 的中断就是这么来的)。
                    try:
                        typ, _ = imap.select(imap_box, readonly=True)
                    except Exception as e:
                        logger.warning(
                            f"[davmail-uid-mapper] SELECT {imap_box!r} raised: {e}"
                        )
                        failed += len(items)
                        processed += len(items)
                        conn_dead = True  # 连接已废, 剩余组直接计失败
                        continue
                    if typ != "OK":
                        logger.warning(f"[davmail-uid-mapper] SELECT {imap_box!r} failed")
                        failed += len(items)
                        processed += len(items)
                        continue
                    # UIDVALIDITY 从 SELECT 响应读 (CRITICAL #3 协议合规, 不再调 STATUS 同 mailbox)
                    uv = _read_uidvalidity_from_select(imap)

                    for iid, mid in items:
                        processed += 1
                        try:
                            # raise_on_error=True: SEARCH 异常 (超时/连接死) 必须计
                            # failed 留待重试 — 默认吞异常返 None 会被下面误判成
                            # "永久 miss" 标 imap_uid=-1, 从此被排除在 backfill 外。
                            uid = DavMailBackend._lookup_uid_by_message_id(
                                imap, mid, raise_on_error=True
                            )
                        except Exception as e:
                            logger.warning(
                                f"[davmail-uid-mapper] lookup iid={iid} failed: {e}"
                            )
                            failed += 1
                            continue
                        if uid:
                            backfill_params.append((int(uid), uv, int(iid)))
                            backfilled += 1
                        else:
                            missing_params.append((int(iid),))
                            missing += 1
            finally:
                try:
                    imap.logout()
                except Exception:
                    pass

            # 单 SQLite 连接 + busy_timeout + executemany 一次性 commit
            if not backfill_params and not missing_params:
                return
            try:
                with sqlite3.connect(self.cfg.sync_store_db_path, timeout=10.0) as conn:
                    conn.execute("PRAGMA busy_timeout = 10000")
                    if backfill_params:
                        conn.executemany(
                            """UPDATE email_metadata
                               SET imap_uid = ?, imap_uidvalidity = ?
                               WHERE internal_id = ?""",
                            backfill_params,
                        )
                    if missing_params:
                        conn.executemany(
                            """UPDATE email_metadata SET imap_uid = -1
                               WHERE internal_id = ?""",
                            missing_params,
                        )
                    conn.commit()
            except Exception as e:
                logger.error(
                    f"[davmail-uid-mapper] batch UPDATE failed "
                    f"(backfill={len(backfill_params)} missing={len(missing_params)}): {e}"
                )
                # 把累积的 backfill+missing 重新算成 failed (上游会重试整批)
                failed += backfilled + missing
                backfilled = 0
                missing = 0

        await asyncio.to_thread(_sync_backfill)
        return {
            "processed": processed, "backfilled": backfilled,
            "missing": missing, "failed": failed,
        }


async def schedule_backfill_task(cfg: "Config", sync_store: "SyncStore", delay_sec: int = 10):
    """供 main.py 调用 — 延迟 N 秒启动 backfill task (避免跟启动其他 task 抢资源)."""
    # Sprint 16 收尾: 加 enabled 开关 + 从 cfg 读限流参数, 防 EWS throttling
    if not getattr(cfg, "davmail_uid_backfill_enabled", True):
        logger.info("[davmail-uid-mapper] disabled via DAVMAIL_UID_BACKFILL_ENABLED=false, skip")
        return

    await asyncio.sleep(delay_sec)
    mapper = DavMailUidMapper(
        cfg, sync_store,
        batch_size=int(getattr(cfg, "davmail_uid_backfill_batch_size", _DEFAULT_BATCH_SIZE)),
        sleep_between_batches_sec=float(getattr(cfg, "davmail_uid_backfill_sleep_sec", _DEFAULT_SLEEP_BETWEEN_SEC)),
    )
    pending = mapper.count_pending()
    if pending == 0:
        logger.info("[davmail-uid-mapper] no pending emails, skip backfill")
        return
    logger.info(
        f"[davmail-uid-mapper] scheduling backfill ({pending} emails, "
        f"batch={mapper.batch_size}, sleep_between={mapper.sleep_between_batches_sec}s)"
    )
    await mapper.run_backfill()
