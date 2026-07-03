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

    # job_type 两族分区 (S4 D1, codex P1-1)。两族**互不可见**: 各 worker claim 自己那族,
    # 公共 REST 只收维护族, recover_orphaned 对两族分别处理 (维护族 requeue, agent 族失败不重放)。
    #   - MAINTENANCE: 与 src/sync/job_runners.py JOB_TYPES(=runner registry) 逐一致
    #     (test_job_types_match_runner_registry 断言); JobWorker 串行 claim + run_job 执行。
    #   - AGENT: agent_run (S4 custom agent headless run)。run_job **不处理** (无 runner 分支);
    #     执行走独立 AgentRunWorker (W2) → poke gateway。LLM run 非幂等 → 孤儿绝不 requeue。
    MAINTENANCE_JOB_TYPES = frozenset({
        "resync",
        "backfill_body",
        "backfill_derivatives",
        "backfill_metadata",
    })
    AGENT_JOB_TYPES = frozenset({
        "agent_run",
    })
    # 并集 = enqueue 合法性总闸 (向后兼容: 既有 job_type 全在 MAINTENANCE 里)。
    VALID_JOB_TYPES = MAINTENANCE_JOB_TYPES | AGENT_JOB_TYPES
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

    def claim_next(self, types: Optional[frozenset] = None) -> Optional[AsyncJob]:
        """原子 claim 最老的 queued job → running，返回它；无匹配 queued 则 None。

        Args:
            types: 只 claim 这些 job_type (族过滤, S4 D1 分区)。默认 = ``MAINTENANCE_JOB_TYPES``
                (既有 JobWorker/测试零变化); ``AgentRunWorker`` 传 ``AGENT_JOB_TYPES`` →
                两族互不可见 (维护 worker 看不到 agent_run, 反之亦然)。

        条件 UPDATE (status queued→running, 仿 fanout mark_processing): rowcount==0
        表示被并发抢走 (单 worker 不会发生), 返 None 让 caller 下个 tick 再试。
        """
        allowed = tuple(types if types is not None else self.MAINTENANCE_JOB_TYPES)
        if not allowed:
            return None  # 空族 → 无可 claim (防 IN () 语法错)
        placeholders = ",".join("?" for _ in allowed)
        conn = self._connect()
        try:
            row = conn.execute(
                f"SELECT job_id FROM async_jobs WHERE status='queued' "
                f"AND job_type IN ({placeholders}) "
                "ORDER BY job_id ASC LIMIT 1",
                allowed,
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
        """worker 启动时回收残留 running (上次崩溃留下)，按族分家 (S4 D1)，返回**维护族**重置条数。

        单 worker 语义下任何 running 行都是孤儿 (没有活跃 worker 在跑它)。两族语义不同:
          - 维护族 (resync/backfill_*): running → queued。幂等维护操作, claim_next 重新捡起,
            runner 从 checkpoint_internal_id 续跑 (现状语义不变)。
          - agent 族 (agent_run): running → failed('E_ORPHANED')。LLM run **非幂等**, 重放 =
            违背 D4 fail-closed 方向 (陈旧写重演)。**永不 requeue**, 下个触发窗口靠新幂等键自然重来。

        返回值 = 维护族重置条数 (保持既有调用点日志语义); agent 族失败数单独 log。
        """
        now = time.time()
        conn = self._connect()
        try:
            maint = tuple(self.MAINTENANCE_JOB_TYPES)
            maint_ph = ",".join("?" for _ in maint)
            cursor = conn.execute(
                f"UPDATE async_jobs SET status='queued', updated_at=? "
                f"WHERE status='running' AND job_type IN ({maint_ph})",
                (now, *maint),
            )
            n_maint = cursor.rowcount
            agent = tuple(self.AGENT_JOB_TYPES)
            agent_ph = ",".join("?" for _ in agent)
            cursor2 = conn.execute(
                f"UPDATE async_jobs SET status='failed', last_error='E_ORPHANED', "
                f"finished_at=?, updated_at=? "
                f"WHERE status='running' AND job_type IN ({agent_ph})",
                (now, now, *agent),
            )
            n_agent = cursor2.rowcount
            conn.commit()
        finally:
            conn.close()
        if n_maint:
            logger.warning(
                f"[async-jobs] recovered {n_maint} orphaned maintenance job(s) → queued"
            )
        if n_agent:
            logger.warning(
                f"[async-jobs] failed {n_agent} orphaned agent_run job(s) → E_ORPHANED "
                f"(non-idempotent, never requeued)"
            )
        return n_maint

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

    def count_agent_runs_since(self, agent_id: str, since_epoch: float) -> int:
        """统计某 agent 自 ``since_epoch`` 起 enqueue 的 agent_run 数 (S4 D7-1 runs/day 门)。

        target_key = agent_id (触发方 enqueue 时约定), 计所有 created_at>=since 的行 (含终态,
        含 idempotent 去重后的实际入队数——去重不新建行, 天然不重复计)。
        """
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM async_jobs "
                "WHERE job_type='agent_run' AND target_key=? AND created_at>=?",
                (agent_id, since_epoch),
            ).fetchone()
            return int(row["n"]) if row else 0
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
