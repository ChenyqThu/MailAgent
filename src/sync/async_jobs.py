"""AsyncJobRepository — C1 长任务 (batch resync / backfill) 的 enqueue + 执行账本。

每条 ``async_jobs`` 行表示「**跑一个长任务**」。与 ``email_outbox`` 同构 (sync-engine
队列) 但语义不同: outbox 是字段级 merge 幂等 intent (FanoutWorker 字段合并派发), job
是带 checkpoint / 熔断 / 进度的**过程** —— 强塞 outbox 会破坏 merge 不变式, 故独立表。

写入 (idempotency):
    enqueue(job_type, target_kind, target_key, params, idempotency_key=...)
    → idempotency_key 已存在 (partial unique) → 返回**已有** job_id + was_created=False
      (弱网重发同一 backfill 不会起 N 个); 否则 INSERT 新行返新 job_id。

状态机 (单 worker 串行):
    queued → running → succeeded / partial_failure / failed / aborted
    worker 崩溃 → 重启 recover_orphaned() 把残留 running 重置 queued → 从
    checkpoint_internal_id 续跑。

claim 用条件 UPDATE (status queued→running, 仿 ``fanout.py`` mark_processing): 即便
未来多 worker 也不会双claim。

详见 docs/reference/architecture/backend-service-migration-matrix.md C1 + plan §C1。
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from loguru import logger


# ============================================================
# Records
# ============================================================

@dataclass
class AsyncJob:
    """async_jobs 行的 dataclass 投影. params / result 已 json.loads 成 dict。"""
    job_id: int
    job_type: str
    target_kind: str
    target_key: str
    params: Dict[str, Any]
    status: str                      # queued|running|succeeded|partial_failure|failed|aborted
    idempotency_key: Optional[str]
    progress_done: int
    progress_total: int
    checkpoint_internal_id: Optional[int]
    result: Optional[Dict[str, Any]]
    last_error: Optional[str]
    created_at: float
    updated_at: float
    started_at: Optional[float]
    finished_at: Optional[float]


# ============================================================
# Repository
# ============================================================

class AsyncJobRepository:
    """async_jobs 表读写入口 (仿 OutboxRepository)。"""

    # job_type 枚举 (client-side validation, 与 src/sync/job_runners.py JOB_TYPES 对齐;
    # tests/sync/test_async_jobs.py::test_job_types_match_runner_registry 断言一致)
    VALID_JOB_TYPES = frozenset({
        "resync",
        "backfill_body",
        "backfill_derivatives",
        "backfill_metadata",
    })
    # 终态集 (mark_terminal 只接受这些; queued/running 是活跃态)
    TERMINAL_STATUSES = frozenset({
        "succeeded", "partial_failure", "failed", "aborted",
    })

    def __init__(self, db_path: str = "data/sync_store.db"):
        self.db_path = Path(db_path)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    # ------------------------------------------------------------
    # 写: enqueue
    # ------------------------------------------------------------

    def enqueue(
        self,
        *,
        job_type: str,
        target_kind: str,
        target_key: str,
        params: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> tuple[int, bool]:
        """登记一个长任务 (status='queued')。

        Returns:
            (job_id, was_created)。was_created=False ⇒ 命中 idempotency_key 已有行
            (弱网重发去重, 返回既有 job_id, 不新建)。

        Raises:
            ValueError: job_type 不在 VALID_JOB_TYPES。
        """
        if job_type not in self.VALID_JOB_TYPES:
            raise ValueError(
                f"invalid job_type={job_type!r}, must be one of {sorted(self.VALID_JOB_TYPES)}"
            )
        params_json = json.dumps(params or {}, ensure_ascii=False, sort_keys=True)
        now = time.time()

        conn = self._connect()
        try:
            # idempotency_key IS NULL → partial unique 不约束 → 恒 INSERT (RETURNING 出
            # 新 job_id)。idempotency_key 命中 → DO NOTHING (既有行**原封不动**, 真幂等
            # no-op) → RETURNING 无行 → 回查既有 job_id, was_created=False。比「DO UPDATE
            # + created_at==updated_at 探针」更稳: 不依赖时钟分辨率 (同 tick 重发不误判)。
            row = conn.execute(
                """
                INSERT INTO async_jobs
                    (job_type, target_kind, target_key, params_json,
                     status, idempotency_key, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
                ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL
                DO NOTHING
                RETURNING job_id
                """,
                (job_type, target_kind, target_key, params_json,
                 idempotency_key, now, now),
            ).fetchone()
            if row is not None:
                job_id = int(row["job_id"])
                was_created = True
            else:
                # 命中既有 idempotency_key (DO NOTHING 未插入) → 回查 (此分支必非 NULL key)
                existing = conn.execute(
                    "SELECT job_id FROM async_jobs WHERE idempotency_key = ?",
                    (idempotency_key,),
                ).fetchone()
                job_id = int(existing["job_id"])
                was_created = False
            conn.commit()
        finally:
            conn.close()

        if was_created:
            logger.info(
                f"[async-jobs] enqueued job_id={job_id} type={job_type} "
                f"target={target_kind}={target_key}"
            )
        else:
            logger.info(
                f"[async-jobs] idempotent re-enqueue → existing job_id={job_id} "
                f"(idempotency_key={idempotency_key!r})"
            )
        return job_id, was_created

    # ------------------------------------------------------------
    # 写: claim / progress / terminal / recover
    # ------------------------------------------------------------

    def claim_next(self) -> Optional[AsyncJob]:
        """原子 claim 最老的 queued job → running，返回它；无 queued 则 None。

        条件 UPDATE (status queued→running, 仿 fanout mark_processing): rowcount==0
        表示被并发抢走 (单 worker 不会发生), 返 None 让 caller 下个 tick 再试。
        """
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT job_id FROM async_jobs WHERE status='queued' "
                "ORDER BY job_id ASC LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            job_id = int(row["job_id"])
            now = time.time()
            cursor = conn.execute(
                "UPDATE async_jobs SET status='running', "
                "started_at=COALESCE(started_at, ?), updated_at=? "
                "WHERE job_id=? AND status='queued'",
                (now, now, job_id),
            )
            conn.commit()
            if cursor.rowcount == 0:
                logger.debug(f"[async-jobs] claim race lost job_id={job_id}")
                return None
            full = conn.execute(
                "SELECT * FROM async_jobs WHERE job_id=?", (job_id,)
            ).fetchone()
            return self._row_to_job(full)
        finally:
            conn.close()

    def update_progress(
        self,
        job_id: int,
        *,
        done: int,
        total: Optional[int] = None,
        checkpoint_internal_id: Optional[int] = None,
    ) -> None:
        """刷进度 (worker 每 N unit 调一次)。total / checkpoint 为 None 时保留旧值。"""
        now = time.time()
        conn = self._connect()
        try:
            conn.execute(
                "UPDATE async_jobs SET progress_done=?, "
                "progress_total=COALESCE(?, progress_total), "
                "checkpoint_internal_id=COALESCE(?, checkpoint_internal_id), "
                "updated_at=? WHERE job_id=?",
                (done, total, checkpoint_internal_id, now, job_id),
            )
            conn.commit()
        finally:
            conn.close()

    def mark_terminal(
        self,
        job_id: int,
        *,
        status: str,
        result: Optional[Dict[str, Any]] = None,
        last_error: Optional[str] = None,
    ) -> None:
        """写终态 (succeeded/partial_failure/failed/aborted) + summary。"""
        if status not in self.TERMINAL_STATUSES:
            raise ValueError(
                f"invalid terminal status={status!r}, must be one of "
                f"{sorted(self.TERMINAL_STATUSES)}"
            )
        now = time.time()
        result_json = (
            json.dumps(result, ensure_ascii=False, default=str)
            if result is not None else None
        )
        conn = self._connect()
        try:
            conn.execute(
                "UPDATE async_jobs SET status=?, result_json=?, last_error=?, "
                "finished_at=?, updated_at=? WHERE job_id=?",
                (status, result_json, (last_error or None), now, now, job_id),
            )
            conn.commit()
        finally:
            conn.close()
        logger.info(
            f"[async-jobs] job_id={job_id} → {status}"
            + (f" ({last_error})" if last_error else "")
        )

    def recover_orphaned(self) -> int:
        """worker 启动时把残留 running (上次崩溃留下) 重置 queued，返回条数。

        单 worker 语义下任何 running 行都是孤儿 (没有活跃 worker 在跑它)。重置后
        claim_next 会重新捡起, runner 从 checkpoint_internal_id 续跑。
        """
        now = time.time()
        conn = self._connect()
        try:
            cursor = conn.execute(
                "UPDATE async_jobs SET status='queued', updated_at=? "
                "WHERE status='running'",
                (now,),
            )
            conn.commit()
            n = cursor.rowcount
        finally:
            conn.close()
        if n:
            logger.warning(
                f"[async-jobs] recovered {n} orphaned running job(s) → queued"
            )
        return n

    # ------------------------------------------------------------
    # 读: get
    # ------------------------------------------------------------

    def get(self, job_id: int) -> Optional[AsyncJob]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM async_jobs WHERE job_id=?", (job_id,)
            ).fetchone()
            return self._row_to_job(row) if row else None
        finally:
            conn.close()

    # ------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------

    @staticmethod
    def _row_to_job(row: sqlite3.Row) -> AsyncJob:
        try:
            params = json.loads(row["params_json"] or "{}")
        except (json.JSONDecodeError, TypeError):
            params = {}
        result: Optional[Dict[str, Any]] = None
        if row["result_json"]:
            try:
                result = json.loads(row["result_json"])
            except json.JSONDecodeError:
                result = None
        return AsyncJob(
            job_id=int(row["job_id"]),
            job_type=row["job_type"],
            target_kind=row["target_kind"],
            target_key=row["target_key"],
            params=params,
            status=row["status"],
            idempotency_key=row["idempotency_key"],
            progress_done=int(row["progress_done"]),
            progress_total=int(row["progress_total"]),
            checkpoint_internal_id=(
                int(row["checkpoint_internal_id"])
                if row["checkpoint_internal_id"] is not None else None
            ),
            result=result,
            last_error=row["last_error"],
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
            started_at=(
                float(row["started_at"]) if row["started_at"] is not None else None
            ),
            finished_at=(
                float(row["finished_at"]) if row["finished_at"] is not None else None
            ),
        )
