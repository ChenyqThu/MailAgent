"""附件文本抽取 worker —— email_attachment_text 队列的长驻消费者 (PR0).

历史缺口: 登记侧一直正常 (``commit_email_with_body`` 对非 inline 附件
``INSERT OR IGNORE ... status='pending'``), 但长驻服务从未实现消费者 ——
唯一消费者是手动 CLI ``mailagent attachment extract --pending``。结果 pending
队列只进不出, 生产库积压上千行。

本模块把 CLI ``attachment extract --pending`` 的消费循环体抽成 **单一真源**
``process_pending_extractions()``:

- CLI 直接调它跑一轮 (行为对 CLI 逐字节等价, 退出码 / 统计输出不变);
- ``tick_loop()`` 在 ``src/service.py`` 里按 supervised worker 注册, 每
  ``poll_interval_sec`` 跑一轮 (受 ``MAILAGENT_ATTACHMENT_TEXT_WORKER_ENABLED``
  门控, 默认开; off = 不 spawn, 回纯手动 CLI 现状)。

退避语义**不在这里重复造** —— ``EmailRepository.list_pending_attachment_extractions``
已过滤 ``status='failed' AND next_retry_at <= now``,
``mark_attachment_text_failure`` 已算指数退避 (1m/5m/15m/1h/2h)。worker 只是
反复调它们, 天然尊重 ``next_retry_at``。

⚠ 不动 ``src/repository/email_repository.py`` / ``search_query.py`` (检索段并行
重构中); 只依赖已存在的 repo 方法 (``list_pending_attachment_extractions`` /
``commit_attachment_text`` / ``mark_attachment_text_failure``)。
"""

from __future__ import annotations

import asyncio
import sqlite3
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

from loguru import logger

if TYPE_CHECKING:
    from src.repository.email_repository import EmailRepository


# service.py 注册时的默认值 (config.py 有对应 Field, env 可调)。
DEFAULT_LIMIT_PER_CYCLE = 25
DEFAULT_POLL_INTERVAL_SEC = 60.0


@dataclass
class ExtractionBatchStats:
    """单轮消费的统计 (CLI ``attachment extract`` 的 data 字段同名子集)。"""

    processed: int = 0
    extracted: int = 0
    unsupported: int = 0
    failed: int = 0
    skipped: int = 0

    def any_work(self) -> bool:
        return bool(self.processed or self.skipped)

    def as_log_str(self) -> str:
        return (
            f"processed={self.processed} extracted={self.extracted} "
            f"unsupported={self.unsupported} failed={self.failed} "
            f"skipped={self.skipped}"
        )


def process_pending_extractions(
    repo: "EmailRepository",
    *,
    limit: int,
    dry_run: bool = False,
) -> ExtractionBatchStats:
    """跑一轮 pending / retry-ready 附件文本抽取 (CLI + worker 单一真源)。

    对每个 attachment:
        1. 取 attachment row + local_path (缺 → skipped + mark_failure);
        2. 反推绝对路径, 文件不存在 → skipped + mark_failure;
        3. ``extract_text(path, content_type, filename)``;
        4. extracted → ``commit_attachment_text(status='extracted')`` (FTS5 trigger 索引);
        5. unsupported → ``commit_attachment_text(status='unsupported')`` (不索引不重试);
        6. failed / extractor 抛异常 → ``mark_attachment_text_failure`` (指数退避)。

    Args:
        repo: EmailRepository 实例 (worker 用 ``watcher.email_repo``, CLI 用 ``cli.email_repo``)。
        limit: 本轮最多处理多少 attachment (worker=每 cycle 上限, CLI=--limit)。
        dry_run: True 只统计 processed, 不落任何写 (CLI --dry-run 语义)。

    Returns:
        ExtractionBatchStats: 本轮统计。
    """
    from src.converter.attachment_text import extract_text

    stats = ExtractionBatchStats()
    pending_ids = repo.list_pending_attachment_extractions(limit=limit)
    if not pending_ids:
        return stats

    conn = sqlite3.connect(str(repo.db_path), timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        for att_id in pending_ids:
            row = conn.execute(
                """
                SELECT id, internal_id, filename, content_type,
                       local_path, size_bytes
                  FROM email_attachment WHERE id = ?
                """,
                (att_id,),
            ).fetchone()
            if not row or not row["local_path"]:
                stats.skipped += 1
                if not dry_run:
                    repo.mark_attachment_text_failure(
                        att_id, "attachment row or local_path missing"
                    )
                continue

            # local_path 是相对项目根的路径 (如 'data/attachments/53675/file.pdf');
            # 用 attachment_store.base_dir.parent.parent 反推 project_root.
            project_root = repo.attachment_store.base_dir.parent.parent
            abs_path = project_root / row["local_path"]
            if not abs_path.exists():
                stats.skipped += 1
                if not dry_run:
                    repo.mark_attachment_text_failure(
                        att_id, f"file missing: {abs_path}"
                    )
                continue

            stats.processed += 1
            if dry_run:
                continue

            try:
                result = extract_text(
                    abs_path,
                    content_type=row["content_type"],
                    filename=row["filename"],
                )
            except Exception as e:  # noqa: BLE001 — 单条 extractor 崩不炸整轮
                repo.mark_attachment_text_failure(att_id, f"extractor exception: {e}")
                stats.failed += 1
                continue

            if result.status == "extracted":
                repo.commit_attachment_text(
                    att_id, text=result.text, extractor=result.extractor,
                    status="extracted", truncated=result.truncated,
                )
                stats.extracted += 1
            elif result.status == "unsupported":
                repo.commit_attachment_text(
                    att_id, text="", extractor=result.extractor,
                    status="unsupported", error_message=result.error_message,
                )
                stats.unsupported += 1
            else:  # failed
                repo.mark_attachment_text_failure(
                    att_id, result.error_message or "unknown extractor failure"
                )
                stats.failed += 1
    finally:
        conn.close()

    return stats


async def tick_loop(
    *,
    repo: "EmailRepository",
    shutdown_event: Optional[asyncio.Event] = None,
    limit_per_cycle: int = DEFAULT_LIMIT_PER_CYCLE,
    poll_interval_sec: float = DEFAULT_POLL_INTERVAL_SEC,
) -> None:
    """supervised worker 主循环: 每 ``poll_interval_sec`` 跑一轮消费。

    ``process_pending_extractions`` 是同步阻塞 IO (读盘 + extractor + sqlite),
    走 ``asyncio.to_thread`` 不阻塞事件循环。单轮内单条失败已被 mark_failure
    接住不炸整轮; 整轮意外异常这里 log 后继续 (supervised 层再兜进程级重启)。
    """
    logger.info(
        f"[attachment-text-worker] started "
        f"(limit_per_cycle={limit_per_cycle}, poll={poll_interval_sec}s)"
    )

    while shutdown_event is None or not shutdown_event.is_set():
        try:
            stats = await asyncio.to_thread(
                process_pending_extractions, repo, limit=limit_per_cycle
            )
            if stats.any_work():
                logger.info(f"[attachment-text-worker] cycle: {stats.as_log_str()}")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — 整轮意外异常不静默死
            logger.error(f"[attachment-text-worker] cycle error: {e}")

        try:
            if shutdown_event is None:
                await asyncio.sleep(poll_interval_sec)
            else:
                await asyncio.wait_for(shutdown_event.wait(), timeout=poll_interval_sec)
                break
        except asyncio.TimeoutError:
            continue
