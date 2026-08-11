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

import hmac
import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

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
    #   - AGENT: agent_run (S4 custom agent headless run) + matter_followup (Matters P4
    #     跟进 run, 同为 poke-gateway 的 LLM run —— 同族共享 claim/孤儿纪律)。run_job
    #     **不处理** (无 runner 分支); 执行走独立 AgentRunWorker (W2, P4 起按 job_type
    #     分派) → poke gateway。LLM run 非幂等 → 孤儿绝不 requeue。
    MAINTENANCE_JOB_TYPES = frozenset({
        "resync",
        "backfill_body",
        "backfill_metadata",
    })
    AGENT_JOB_TYPES = frozenset({
        "agent_run",
        "matter_followup",
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
        expect_status: Optional[str] = None,
    ) -> bool:
        """写终态 (succeeded/partial_failure/failed/aborted) + summary。返回是否真的写入。

        ``expect_status`` = CAS 前置条件：只在该 job 当前正处于此状态时才写。默认 None =
        无条件覆盖（既有调用方语义逐字节不变 —— worker 写终态时 job 已是 running，它本就该赢）。

        🔴 谁需要 CAS：``run_queue.enqueue_agent_run`` 的预算跳过路径先 enqueue（status='queued'）
        再把它标成 succeeded+skipped。这两步之间 ``claim_next`` 能把行抢走并真的开跑；无条件
        UPDATE 会把**正在执行**的 run 记成「未执行」，随后 worker 的终态写又覆盖回来 —— 历史
        与事实两次相反。同进程同 event loop 下 enqueue 全程同步无 await，窗口不成立；跨进程
        （pm2 mail-sync + .app 并存，文档已禁止但不是物理不可能）则成立。传 'queued' 让抢跑方
        赢：跳过标记写不进去 = 这个 run 真的在跑，调用方据 result 判定 skipped 时自然得到 False。
        """
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
        sql = (
            "UPDATE async_jobs SET status=?, result_json=?, last_error=?, "
            "finished_at=?, updated_at=? WHERE job_id=?"
        )
        params: tuple[Any, ...] = (status, result_json, (last_error or None), now, now, job_id)
        if expect_status is not None:
            sql += " AND status=?"
            params += (expect_status,)
        conn = self._connect()
        try:
            cursor = conn.execute(sql, params)
            written = cursor.rowcount > 0
            conn.commit()
        finally:
            conn.close()
        if not written:
            # 只可能发生在带 expect_status 的 CAS 上（无条件写必命中现存行）。
            logger.info(
                f"[async-jobs] job_id={job_id} → {status} SKIPPED "
                f"(expect_status={expect_status!r} no longer holds — claimed elsewhere)"
            )
            return False
        logger.info(
            f"[async-jobs] job_id={job_id} → {status}"
            + (f" ({last_error})" if last_error else "")
        )
        return True

    def recover_orphaned(self) -> int:
        """``JobWorker`` 启动时回收残留 running (上次崩溃留下)——**只碰维护族**，返回重置条数。

        单 worker 语义下任何 running 维护行都是孤儿 (没有活跃 worker 在跑它): running → queued,
        claim_next 重新捡起, runner 从 checkpoint_internal_id 续跑 (幂等维护操作, 现状语义不变)。

        🔴 **不碰 agent 族** (W2-check P1 对称化)：agent 孤儿唯一归 ``recover_orphaned_agents()``
        (AgentRunWorker 启动调)。两 worker 严格各管各族 → 彻底消除对 create_task 顺序 + CPython
        FIFO 调度的隐式依赖。若本方法仍标 running agent_run 为 failed，会与 AgentRunWorker 已
        claim、正在正常 poke gateway 跑 LLM 的 running agent_run 撞车 (mark_terminal 无 WHERE
        status 守护 → recover 的 failed 与 worker 的 succeeded 互相无条件覆盖 = 脏态)。
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
            conn.commit()
        finally:
            conn.close()
        if n_maint:
            logger.warning(
                f"[async-jobs] recovered {n_maint} orphaned maintenance job(s) → queued"
            )
        return n_maint

    def recover_orphaned_agents(self) -> int:
        """agent 族孤儿的**唯一**回收面 (running → failed('E_ORPHANED'))，返回失败条数。

        ``AgentRunWorker`` 启动时调本方法。W2-check P1 对称化后 ``recover_orphaned`` 只碰维护族、
        本方法只碰 agent 族——两 worker 严格各管各族，无论 create_task 顺序 / 调度模型都不互相
        误杀 (LLM run 非幂等，孤儿永不 requeue，D4 fail-closed)。

        副作用（可接受）：flag-off / ``custom_agents_enabled=false`` 时无 AgentRunWorker 启动 →
        遗留的 running agent_run 孤儿无人清、停在 running。**无害**：claim_next 只捡 queued、不
        requeue、不执行；且 S4 默认 off 时几乎无 agent_run 行遗留。
        """
        now = time.time()
        conn = self._connect()
        try:
            agent = tuple(self.AGENT_JOB_TYPES)
            agent_ph = ",".join("?" for _ in agent)
            cursor = conn.execute(
                f"UPDATE async_jobs SET status='failed', last_error='E_ORPHANED', "
                f"finished_at=?, updated_at=? "
                f"WHERE status='running' AND job_type IN ({agent_ph})",
                (now, now, *agent),
            )
            n_agent = cursor.rowcount
            conn.commit()
        finally:
            conn.close()
        if n_agent:
            logger.warning(
                f"[async-jobs] failed {n_agent} orphaned agent_run job(s) → E_ORPHANED "
                f"(non-idempotent, never requeued)"
            )
        return n_agent

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
        """统计某 agent 自 ``since_epoch`` 起实际获准的 agent_run 数（runs/day 门）。

        ``outcome='skipped'`` 是预算门本身写下的审计行，不占用运行额度；否则每个实际入队行
        计一次（幂等命中不新建，天然不重复计）。
        """
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM async_jobs "
                "WHERE job_type='agent_run' AND target_key=? AND created_at>=? "
                "AND COALESCE(json_extract(result_json, '$.outcome'), '') != 'skipped'",
                (agent_id, since_epoch),
            ).fetchone()
            return int(row["n"]) if row else 0
        finally:
            conn.close()

    def list_agent_runs(
        self, *, agent_id: Optional[str] = None, limit: int = 20, offset: int = 0
    ) -> list[AsyncJob]:
        """列出 agent_run 历史行 (按 created_at desc)——S5 run 历史读侧唯一数据源。

        agent_id 非空 → 只返回该 agent (target_key 过滤); None → 全部 agent_run。limit clamp
        进 [1, 100]；offset clamp >= 0（task 07-21 分页）。返回 ``AsyncJob`` 投影 —— 读态
        (9 值域，含 skipped) 由调用方经 ``src.agents.run_state.derive_agent_run_state`` 派生,
        **不在此推导**
        (纯查询)。
        """
        lim = max(1, min(100, limit))
        off = max(0, offset)
        conn = self._connect()
        try:
            if agent_id:
                rows = conn.execute(
                    "SELECT * FROM async_jobs WHERE job_type='agent_run' AND target_key=? "
                    "ORDER BY created_at DESC, job_id DESC LIMIT ? OFFSET ?",
                    (agent_id, lim, off),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM async_jobs WHERE job_type='agent_run' "
                    "ORDER BY created_at DESC, job_id DESC LIMIT ? OFFSET ?",
                    (lim, off),
                ).fetchall()
            return [self._row_to_job(r) for r in rows]
        finally:
            conn.close()

    def count_agent_runs(self, *, agent_id: Optional[str] = None) -> int:
        """``list_agent_runs`` 同 agent_id filter 的 COUNT(*)（task 07-21 分页 total）。

        只按 agent_id 过滤（与 ``list_agent_runs`` 的 SQL-filterable 条件一致）——router 侧
        额外的 ``state`` 过滤是在 ``derive_agent_run_state`` 派生之后的内存过滤，不参与此计数。
        """
        conn = self._connect()
        try:
            if agent_id:
                row = conn.execute(
                    "SELECT COUNT(*) AS n FROM async_jobs "
                    "WHERE job_type='agent_run' AND target_key=?",
                    (agent_id,),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT COUNT(*) AS n FROM async_jobs WHERE job_type='agent_run'"
                ).fetchone()
            return int(row["n"]) if row else 0
        finally:
            conn.close()

    # ------------------------------------------------------------
    # agent_run fresh-spawn 支持 (S4 D2/D4): claim_token + spec CAS + approval 回写
    # ------------------------------------------------------------

    def set_claim_token(self, job_id: int, claim_token: str) -> None:
        """``AgentRunWorker`` 认领 agent_run 后写入 claim_token (能力令牌; spec pull CAS 校验它)。

        镜像 island stash ``resumeToken`` 的能力令牌纪律: 一次性写入, 后续 spec 端点凭它做
        one-shot CAS。worker claim → running 之后立即调 (job 已在 running 态)。
        """
        now = time.time()
        conn = self._connect()
        try:
            conn.execute(
                "UPDATE async_jobs SET claim_token=?, updated_at=? WHERE job_id=?",
                (claim_token, now, job_id),
            )
            conn.commit()
        finally:
            conn.close()

    def claim_spec_cas(
        self, job_id: int, claim_token: str
    ) -> Tuple[str, Optional[AsyncJob]]:
        """spec pull 的原子 CAS one-shot (S4 D2)。返回 (结果码, job|None)。

        结果码 → caller (spec 端点) 的 HTTP 映射:
          - ``'ok'``              : CAS 成功 (spec_claimed_at 本次写入), 返 200 + 组装 spec;
                                    第二元 = 该 job (含 params, 供 spec 组装)。
          - ``'not_found'``       : job 不存在或非 agent_run → 404 E_SPEC_NOT_FOUND。
          - ``'forbidden'``       : claim_token 不匹配 → 403 E_SPEC_FORBIDDEN (**不消费**
                                    spec_claimed_at —— 单条 UPDATE 的 WHERE 不命中即天然不写)。
          - ``'already_claimed'`` : 已 claim 过 / 非 running → 409 E_SPEC_ALREADY_CLAIMED。

        原子性 (codex P1-2): 权威闸 = 单条 ``UPDATE … WHERE status='running' AND
        claim_token=? AND spec_claimed_at IS NULL`` (rowcount==1 才算 claim 成功) —— 重复
        poke / HTTP 重试 / 并发第二次 pull **结构性不可能**起两个 drain (第二次 rowcount==0 →
        already_claimed)。先读一次仅为区分 403 vs 409 错误码 (token 不符要 403 非 409);
        token 比对用 ``hmac.compare_digest`` 防时序侧信道。``spec_claimed_at`` 列为 REAL →
        写 ``time.time()`` float epoch (与表内其余时间戳一致, W1-check §4)。
        """
        now = time.time()
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM async_jobs WHERE job_id=?", (job_id,)
            ).fetchone()
            if row is None or row["job_type"] not in self.AGENT_JOB_TYPES:
                return "not_found", None
            stored = row["claim_token"]
            if not stored or not hmac.compare_digest(str(stored), str(claim_token)):
                # token 不符 → 403; 不做任何写 (spec_claimed_at 不消费)。
                return "forbidden", None
            cursor = conn.execute(
                "UPDATE async_jobs SET spec_claimed_at=?, updated_at=? "
                "WHERE job_id=? AND status='running' AND claim_token=? "
                "AND spec_claimed_at IS NULL",
                (now, now, job_id, claim_token),
            )
            conn.commit()
            if cursor.rowcount != 1:
                # 已被拉过 (spec_claimed_at 非 NULL) 或非 running → 409。
                return "already_claimed", None
            full = conn.execute(
                "SELECT * FROM async_jobs WHERE job_id=?", (job_id,)
            ).fetchone()
            return "ok", self._row_to_job(full)
        finally:
            conn.close()

    def settle_agent_run_approval(self, job_id: int, state: str) -> str:
        """回写 agent_run 的 ``result_json.approval_state`` (S4 D4, P1-4)。返回结果码。

        岛上 approve/reject 终局后, W3 lifecycle 从 chat_db 解出 job_id → 调本方法把审批终态落
        job 行 (让「等审批」与「成功」在账本可区分: ``status=succeeded && approval_state=pending``
        永不得渲染为成功完成)。**只允许从 'pending' 迁移**; ``expired`` 不写库 (读侧按 age 推导)。

        结果码 → caller HTTP:
          - ``'ok'``          : pending → approved/rejected 写入成功, 200。
          - ``'idempotent'``  : 当前已是请求的同值 (approved==approved) → 200 幂等 no-op。
          - ``'not_found'``   : job 不存在或非 agent_run → 404。
          - ``'not_pending'`` : 无 result / 无 approval_state / 已是其它终态 (approved!=rejected)
                                → 409 (无 pending 可结算, 或已结算成不同值不可再迁移)。
        """
        if state not in ("approved", "rejected"):
            raise ValueError(f"invalid approval state={state!r}, must be approved|rejected")
        now = time.time()
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT job_type, result_json FROM async_jobs WHERE job_id=?",
                (job_id,),
            ).fetchone()
            if row is None or row["job_type"] not in self.AGENT_JOB_TYPES:
                return "not_found"
            try:
                result = json.loads(row["result_json"]) if row["result_json"] else {}
            except (json.JSONDecodeError, TypeError):
                result = {}
            if not isinstance(result, dict):
                result = {}
            cur = result.get("approval_state")
            if cur == state:
                return "idempotent"
            if cur != "pending":
                # 无 pending (None / 缺 result) 或已结算成不同终态 → 不可迁移。
                return "not_pending"
            result["approval_state"] = state
            conn.execute(
                "UPDATE async_jobs SET result_json=?, updated_at=? WHERE job_id=?",
                (json.dumps(result, ensure_ascii=False, default=str), now, job_id),
            )
            conn.commit()
            return "ok"
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
