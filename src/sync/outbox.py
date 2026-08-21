"""OutboxRepository — Sprint 15 SQLite SSoT inversion 的 intent 层.

每条 outbox 行表示「**我想让 target（Mail.app 或 Notion）变成 payload 描述的样子**」。
FanoutWorker 异步消费，幂等执行，失败指数退避，5 次进 dead_letter + 飞书告警。

写入策略（合并同 pending）:
    enqueue(internal_id, op_type, target, payload, source=...)
    → 若同 (internal_id, op_type, target, status='pending') 已存在
      → merge payload（后写覆盖同 key）+ 刷 updated_at，返回 existing outbox_id
    → 否则 INSERT 新行

Echo prevention（避免 Notion → handler → outbox → fanout → Notion 回环）:
    source='notion_webhook' + target='notion' → silent skip + log warning, 返回 -1

状态机:
    pending → processing → done           ← 派发成功
                         → failed → (retry) ← attempts < max
                                  → dead_letter ← attempts ≥ max
             processing → pending / dead_letter ← FanoutWorker 启动时回收孤儿
                                                  (recover_orphaned_processing)

退避序列: 60s / 5min / 15min / 1h / 2h（与 LLMProcessingStore / sync_store 一致）

详见:
- SPRINT15-HANDOFF.md §3.3-§3.4
- .claude/plans/ultrathink-sprint-15-handoff-twinkly-nebula.md Stage 1.2
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from loguru import logger


# 指数退避序列（秒）；与 sync_store._update_for_retry / LLMProcessingStore 对齐
_BACKOFF_SECONDS = [60, 300, 900, 3600, 7200]


def _backoff_next_retry_at(attempts: int) -> float:
    """attempts 从 1 开始（首次失败后 attempts=1，应用第 0 个退避 60s）."""
    idx = min(max(attempts - 1, 0), len(_BACKOFF_SECONDS) - 1)
    return time.time() + _BACKOFF_SECONDS[idx]


# ============================================================
# Records
# ============================================================

@dataclass
class OutboxEntry:
    """email_outbox 行的 dataclass 投影. payload 已 json.loads 成 dict."""
    outbox_id: int
    internal_id: int
    op_type: str
    target: str                # 'mailapp' | 'notion'
    payload: Dict[str, Any]
    source: Optional[str]      # 'frontend' | 'notion_webhook' | 'cli' | None
    status: str                # pending | processing | done | failed | dead_letter
    attempts: int
    last_error: Optional[str]
    next_retry_at: Optional[float]
    created_at: float
    updated_at: float


@dataclass
class OutboxStats:
    """admin queue-depth / stats --section outbox 用."""
    by_status: Dict[str, int] = field(default_factory=dict)
    by_target: Dict[str, int] = field(default_factory=dict)
    age_buckets: Dict[str, int] = field(default_factory=dict)
    total: int = 0


# ============================================================
# Repository
# ============================================================

class OutboxRepository:
    """email_outbox 表读写入口."""

    # CHECK constraint 允许的枚举（写入前 client-side validation,
    # 避免 IntegrityError 把整个事务回滚）
    VALID_TARGETS = frozenset({"mailapp", "notion"})
    VALID_STATUSES = frozenset({
        "pending", "processing", "done", "failed", "dead_letter"
    })

    # 默认 busy timeout —— 常规写路径 (enqueue / mark_*) 宁可等也别丢 intent。
    # 例外: 入向已读回收的收敛事务传更短的值 (见 converge_local_read_atomic), 因为
    # 它是"便利型收敛、下轮必重判"的可跳过写, 不该把 30s 锁等待传导给调用方。
    DEFAULT_BUSY_TIMEOUT_SEC = 30.0

    def __init__(self, db_path: str = "data/sync_store.db"):
        self.db_path = Path(db_path)

    def _connect(self, timeout: Optional[float] = None) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self.db_path),
            timeout=self.DEFAULT_BUSY_TIMEOUT_SEC if timeout is None else timeout,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    # ------------------------------------------------------------
    # 写: enqueue
    # ------------------------------------------------------------

    def enqueue(
        self,
        *,
        internal_id: int,
        op_type: str,
        target: str,
        payload: Dict[str, Any],
        source: Optional[str] = None,
    ) -> int:
        """登记一条 outbox intent.

        Returns:
            outbox_id（>0 表示成功 INSERT / MERGE; -1 表示 echo prevention 跳过）.

        Raises:
            ValueError: target 不在 VALID_TARGETS 时. op_type 空时.
        """
        if target not in self.VALID_TARGETS:
            raise ValueError(
                f"invalid target={target!r}, must be one of {sorted(self.VALID_TARGETS)}"
            )
        if not op_type:
            raise ValueError("op_type required")

        # Echo prevention: Notion 端用户手改触发的 webhook → handler 写
        # outbox 时只能 target='mailapp'（同步到 Mail.app），不能再写
        # target='notion'（否则 fanout 又调 Notion → automation 又触发
        # webhook → 死循环 + 配额烧光）
        if source == "notion_webhook" and target == "notion":
            logger.warning(
                f"[outbox] echo prevention: skipped target=notion + source=notion_webhook "
                f"(internal_id={internal_id}, op_type={op_type})"
            )
            return -1

        conn = self._connect()
        try:
            outbox_id, was_inserted = self.upsert_on_conn(
                conn,
                internal_id=internal_id,
                op_type=op_type,
                target=target,
                payload=payload,
                source=source,
            )
            conn.commit()
        finally:
            conn.close()

        self.announce_enqueued(
            outbox_id, was_inserted,
            internal_id=internal_id, op_type=op_type, target=target, source=source,
        )
        return outbox_id

    def upsert_on_conn(
        self,
        conn: sqlite3.Connection,
        *,
        internal_id: int,
        op_type: str,
        target: str,
        payload: Dict[str, Any],
        source: Optional[str] = None,
    ) -> tuple[int, bool]:
        """UPSERT 本体 —— **不 commit、不发 SSE**, 事务边界与通知由调用方掌握.

        拆出来是为了让「本地镜像 + 入队」能落在**同一个 SQLite 事务**里 (issue #58
        入向已读回收: 两步分开 commit 时, 前一步成功后一步失败会留下"本地已读但
        Notion intent 永久缺失"的半提交 —— 下轮只查未读行, 该封再也进不了 reconcile)。
        校验与 echo prevention 由 ``enqueue`` 侧完成; 借用连接的调用方须自证 source
        不是 ``notion_webhook``。

        Returns: ``(outbox_id, was_inserted)`` —— was_inserted=False 表示 merge 进了
        已存在的 pending 行 (调用方据此决定是否发 SSE, 保持「仅新 intent 通知」语义)。
        """
        # 紧凑 sorted —— 与 SQL json_patch 输出 (紧凑) + TS 侧 JSON.stringify (紧凑)
        # 逐字节一致 (B1 契约)。merge 不再应用层 dict 合并, 全交给下面的 json_patch。
        # ⚠️ 不变式: payload 值非 None —— json_patch 按 RFC7396 会删 value=null 的 key
        # (与旧 dict-merge 设 None 分歧); 现所有 caller 经 _flag_payloads 只放非 None 字段。
        payload_json = json.dumps(
            payload or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        now = time.time()
        # B1: 单条原子 UPSERT。命中 partial unique index ux_outbox_pending_intent
        # (同 internal_id+op_type+target 且 status='pending') → DO UPDATE json_patch
        # (后写覆盖同 key, 保留旧独有 key, RFC7396); 否则 INSERT 新行。一次性消
        # 「读-改-写竞态」+「JS/Python 两份手抄 merge」。was_inserted 区分两路:
        # INSERT 的 created_at==updated_at (同一 now); DO UPDATE 的 created_at 是
        # 历史值 != 新 updated_at → 用于保持「仅新 intent 发 SSE」parity。
        row = conn.execute(
            """
            INSERT INTO email_outbox
                (internal_id, op_type, target, payload_json, source,
                 status, attempts, last_error, next_retry_at,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
            ON CONFLICT(internal_id, op_type, target) WHERE status = 'pending'
            DO UPDATE SET
                payload_json = json_patch(payload_json, excluded.payload_json),
                source = COALESCE(excluded.source, source),
                updated_at = excluded.updated_at
            RETURNING outbox_id, (created_at = updated_at) AS was_inserted
            """,
            (internal_id, op_type, target, payload_json, source, now, now),
        ).fetchone()
        return int(row["outbox_id"]), bool(row["was_inserted"])

    def announce_enqueued(
        self,
        outbox_id: int,
        was_inserted: bool,
        *,
        internal_id: int,
        op_type: str,
        target: str,
        source: Optional[str],
    ) -> None:
        """入队后的 log + SSE —— 必须在**事务提交之后**调用 (SSE 承诺行已落库)."""
        if was_inserted:
            logger.debug(
                f"[outbox] enqueued outbox_id={outbox_id} "
                f"(internal_id={internal_id}, op_type={op_type}, target={target}, source={source})"
            )
            # Sprint 15 Stage 2: SSE publish (out of DB transaction, silent on failure)。
            # merge 路径不发, 保持「仅新 intent 通知」语义 parity。
            from src.events.publisher import safe_publish
            safe_publish(
                "outbox.enqueued",
                internal_id=internal_id,
                data={
                    "outbox_id": outbox_id,
                    "op_type": op_type,
                    "target": target,
                    "source": source,
                },
                source="outbox",
            )
        else:
            logger.debug(
                f"[outbox] merged into pending outbox_id={outbox_id} "
                f"(internal_id={internal_id}, target={target})"
            )

    def enqueue_many(self, entries: List[Dict[str, Any]]) -> List[int]:
        """批量 enqueue（前端 BatchActionBar 一次 50 封 / `email flag --ids` 多封用）.

        Args:
            entries: list of dict, 每个 dict 同 enqueue() 的 kwargs（含 internal_id /
                     op_type / target / payload / source 可选）.

        Returns:
            list of outbox_id, 与 entries 等长. -1 表示 echo prevention 跳过.
        """
        return [self.enqueue(**entry) for entry in entries]

    # ------------------------------------------------------------
    # 读: poll / list / get
    # ------------------------------------------------------------

    def poll_ready(
        self,
        *,
        target: Optional[str] = None,
        limit: int = 20,
    ) -> List[OutboxEntry]:
        """拉准备好执行的 outbox 行.

        ready = (status='pending') OR (status='failed' AND next_retry_at <= now).
        按 created_at ASC 排序（FIFO），用于 FanoutWorker 主循环.
        """
        now = time.time()
        sql = """
            SELECT * FROM email_outbox
             WHERE (
                   status = 'pending'
                OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
             )
        """
        params: List[Any] = [now]
        if target:
            sql += " AND target = ?"
            params.append(target)
        sql += " ORDER BY created_at ASC LIMIT ?"
        params.append(limit)

        conn = self._connect()
        try:
            rows = conn.execute(sql, params).fetchall()
            return [self._row_to_entry(r) for r in rows]
        finally:
            conn.close()

    def get(self, outbox_id: int) -> Optional[OutboxEntry]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM email_outbox WHERE outbox_id = ?", (outbox_id,)
            ).fetchone()
            return self._row_to_entry(row) if row else None
        finally:
            conn.close()

    # 「尚未终态」的 outbox 状态 —— 派发还没有定论, 出向 intent 仍可能改变
    # Mail.app / Notion 端的状态。终态是 done (已派发) 与 dead_letter (放弃)。
    NON_TERMINAL_STATUSES = ("pending", "processing", "failed")

    def has_pending(self, internal_id: int, op_type: str) -> bool:
        """某邮件是否有**尚未终态**的指定 op_type intent (入向 read-reconcile 用).

        走 idx_outbox_internal_id 的等值前缀, 轻量。任一 target 有未终态 intent 即
        True —— read-reconcile 只需知道「这封是否正被 fanout 派发中」以跳过误判
        (Sprint15 fanout ~5s 窗口), 不区分 target。

        🔴 状态集是 pending + **processing + failed**, 不只 pending: processing =
        fanout 正在写 (这正是 Sprint15 窗口本身), failed = 还在退避重试队列里、随时
        会再写一次。只认 'pending' 会漏掉这两类在途 intent —— 例如用户刚标"未读"、
        intent 正在派发时, 服务器还是已读态, reconcile 就会把它又收敛回已读。
        done / dead_letter 是终态, 不阻断收敛。

        🔴 这个"读一眼再决定写"的形态**天生有 TOCTOU 窗口**: 查完到写之间另一进程仍
        可能插进 intent。真正要防竞态的调用方必须用 ``has_pending_on_conn`` 把这一查
        和随后的写放进同一个 ``BEGIN IMMEDIATE`` 事务里 (见 outbox_intents
        ``converge_local_read_atomic``); 本方法只适合"能容忍慢一拍"的粗筛。
        """
        conn = self._connect()
        try:
            return self.has_pending_on_conn(conn, internal_id, op_type)
        finally:
            conn.close()

    def has_pending_on_conn(
        self, conn: sqlite3.Connection, internal_id: int, op_type: str
    ) -> bool:
        """``has_pending`` 的借用连接版 —— 供"查 + 写"同事务的调用方消 TOCTOU."""
        placeholders = ", ".join("?" for _ in self.NON_TERMINAL_STATUSES)
        row = conn.execute(
            f"""
            SELECT 1 FROM email_outbox
             WHERE internal_id = ? AND op_type = ?
               AND status IN ({placeholders})
             LIMIT 1
            """,
            (internal_id, op_type, *self.NON_TERMINAL_STATUSES),
        ).fetchone()
        return row is not None

    def list_by_internal_id(
        self, internal_id: int, *, limit: int = 50
    ) -> List[OutboxEntry]:
        """查某邮件的所有 outbox 历史 (debug / 审计用)."""
        conn = self._connect()
        try:
            rows = conn.execute(
                """
                SELECT * FROM email_outbox
                 WHERE internal_id = ?
                 ORDER BY outbox_id DESC LIMIT ?
                """,
                (internal_id, limit),
            ).fetchall()
            return [self._row_to_entry(r) for r in rows]
        finally:
            conn.close()

    def list_dead_letter(self, *, limit: int = 50) -> List[OutboxEntry]:
        conn = self._connect()
        try:
            rows = conn.execute(
                """
                SELECT * FROM email_outbox
                 WHERE status = 'dead_letter'
                 ORDER BY updated_at DESC LIMIT ?
                """,
                (limit,),
            ).fetchall()
            return [self._row_to_entry(r) for r in rows]
        finally:
            conn.close()

    # ------------------------------------------------------------
    # 写: state transitions
    # ------------------------------------------------------------

    def mark_processing(self, outbox_id: int) -> bool:
        """status pending/failed → processing. Returns True if row was actually flipped."""
        now = time.time()
        conn = self._connect()
        try:
            cursor = conn.execute(
                """
                UPDATE email_outbox
                   SET status = 'processing', updated_at = ?
                 WHERE outbox_id = ? AND status IN ('pending', 'failed')
                """,
                (now, outbox_id),
            )
            conn.commit()
            return cursor.rowcount > 0
        finally:
            conn.close()

    def mark_done(self, outbox_id: int) -> bool:
        now = time.time()
        conn = self._connect()
        # Sprint 16: 先取 internal_id (同一连接) — SSE publish 时附带, 前端可以
        # 精准 invalidate ['email', id] / ['emails'] cache, 不用整列 refetch.
        internal_id: Optional[int] = None
        try:
            row = conn.execute(
                "SELECT internal_id FROM email_outbox WHERE outbox_id = ?",
                (outbox_id,),
            ).fetchone()
            if row is not None:
                internal_id = int(row["internal_id"])
            cursor = conn.execute(
                """
                UPDATE email_outbox
                   SET status = 'done',
                       last_error = NULL,
                       next_retry_at = NULL,
                       updated_at = ?
                 WHERE outbox_id = ?
                """,
                (now, outbox_id),
            )
            conn.commit()
            changed = cursor.rowcount > 0
        finally:
            conn.close()
        # Sprint 15 Stage 2: SSE publish (out of DB transaction, silent on failure)
        if changed:
            from src.events.publisher import safe_publish
            safe_publish(
                "outbox.done",
                internal_id=internal_id,
                data={"outbox_id": outbox_id},
                source="outbox",
            )
        return changed

    def mark_failed(
        self,
        outbox_id: int,
        error: str,
        *,
        max_attempts: int = 5,
    ) -> Dict[str, Any]:
        """attempts++, 退避或 dead_letter.

        Returns:
            {outbox_id, attempts, status, next_retry_at}.
        """
        now = time.time()
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT attempts FROM email_outbox WHERE outbox_id = ?",
                (outbox_id,),
            ).fetchone()
            current_attempts = int(row["attempts"] if row else 0)
            new_attempts = current_attempts + 1
            if new_attempts >= max_attempts:
                new_status = "dead_letter"
                next_retry: Optional[float] = None
            else:
                new_status = "failed"
                next_retry = _backoff_next_retry_at(new_attempts)

            conn.execute(
                """
                UPDATE email_outbox
                   SET status = ?,
                       attempts = ?,
                       last_error = ?,
                       next_retry_at = ?,
                       updated_at = ?
                 WHERE outbox_id = ?
                """,
                (
                    new_status,
                    new_attempts,
                    (error or "")[:500],
                    next_retry,
                    now,
                    outbox_id,
                ),
            )
            conn.commit()
            logger.warning(
                f"[outbox] mark_failed outbox_id={outbox_id} attempts={new_attempts} "
                f"status={new_status} retry_at={next_retry}"
            )
            result = {
                "outbox_id": outbox_id,
                "attempts": new_attempts,
                "status": new_status,
                "next_retry_at": next_retry,
            }
        finally:
            conn.close()
        # Sprint 15 Stage 2: SSE publish (silent on failure)
        from src.events.publisher import safe_publish
        # 字面量三元而非 f"outbox.{new_status}": 事件名一致性闸靠源码抽取字面量
        # (frontend/tests/shared/api/sseEventTypes.contract.test.ts), 拼接名对抽取器不可见。
        event = "outbox.dead_letter" if new_status == "dead_letter" else "outbox.failed"
        safe_publish(
            event,
            data={
                "outbox_id": outbox_id,
                "attempts": new_attempts,
                "last_error": (error or "")[:200],
                "next_retry_at": next_retry,
            },
            source="outbox",
        )
        return result

    def retry_dead_letter(self, outbox_id: int) -> bool:
        """把 dead_letter 行重置为 pending, attempts=0 (admin 介入用)."""
        now = time.time()
        conn = self._connect()
        try:
            cursor = conn.execute(
                """
                UPDATE email_outbox
                   SET status = 'pending',
                       attempts = 0,
                       last_error = NULL,
                       next_retry_at = NULL,
                       updated_at = ?
                 WHERE outbox_id = ? AND status = 'dead_letter'
                """,
                (now, outbox_id),
            )
            conn.commit()
            return cursor.rowcount > 0
        finally:
            conn.close()

    # 孤儿回收写进 last_error 的固定前缀（与 async_jobs 的 'E_ORPHANED' 同风格）。
    # 三种去向各一个前缀 —— 事后诊断能一眼分清「重排队了」「太老不敢重放」「毒丸配额耗尽」，
    # 也让 `WHERE last_error LIKE 'E_ORPHANED%'` 一把捞出所有崩溃残留。
    ORPHAN_REQUEUED_ERROR = "E_ORPHANED_REQUEUED: worker died mid-processing, requeued"
    ORPHAN_STALE_ERROR = "E_ORPHANED_STALE: worker died mid-processing, intent too old to replay"
    ORPHAN_POISON_ERROR = "E_ORPHANED_POISON: worker died mid-processing, retry budget exhausted"

    def recover_orphaned_processing(
        self,
        *,
        stale_after_sec: float = 3600.0,
        max_attempts: int = 5,
    ) -> Dict[str, int]:
        """``FanoutWorker`` 启动时回收残留 processing（上次进程死亡留下），返回各分支条数。

        ``poll_ready`` 只扫 pending / failed-ready，``mark_processing`` 之后进程若被杀
        （退出 / 崩溃 / SIGKILL），该行**永久**停在 processing —— 不重试、不进 dead_letter；
        而 ``get_stats`` 的 age_buckets 只统计 pending ⇒ 积压告警对它完全盲视。这是静默丢
        intent，本方法是唯一出口。

        🔴 只在 worker 启动时调，**不设「停机多久算卡死」阈值**：孤儿只由进程死亡产生，而进程
        死亡后必须重启才能继续干活 ⇒ 启动时回收覆盖 100% 的产生场景；且启动那一刻绝无
        in-flight（单 worker 语义 —— ``concurrency`` 是 asyncio 内并发不是多进程），不存在
        误杀活跃行的可能。做成每轮 tick 检查反而要引入一个会误杀的时长阈值。

        按 **intent 年龄**分流（``updated_at`` 距今）：
        - ≤ ``stale_after_sec`` → pending + attempts+1，交回既有重试梯子。
        - > ``stale_after_sec`` → dead_letter。🔴 outbox 的 payload 是「把 target 设成这个值」
          的**绝对意图**不是增量：一条几个月前的 flag_sync 现在重放，会拿陈旧值覆盖用户后来的
          手动修改。陈旧孤儿进 dead_letter 是**有意的保守** —— 可见、可被 ``retry_dead_letter``
          手动救回，而不是盲目重放。

        回收目标是 pending 而非 failed+退避：孤儿不是「失败」而是「没等到结果」，用户重启后期待
        flag 尽快落地，不该再等 60s 退避。毒丸保护改由 attempts+1 提供 —— 若某条 intent 执行
        必然杀死进程，不增 attempts 会形成「启动→回收→崩溃→启动」的无限循环；增了则配额耗尽
        后进 dead_letter，有上限且告警可见。代价是一次无辜中断吃掉一次重试配额（正常场景下这条
        intent 下次启动即成功，配额不累积）。

        🔴 配额耗尽的新鲜孤儿（``attempts + 1 >= max_attempts``）与陈旧孤儿一样进 dead_letter：
        少了这一档，attempts 就只是个没人读的计数器、上面那个无限循环依然成立 —— 毒丸永远走不到
        ``mark_failed``，没有任何别处会把它推向终态。

        Returns: ``{"requeued": n, "dead_lettered": m}``.
        """
        now = time.time()
        cutoff = now - stale_after_sec
        conn = self._connect()
        try:
            # 两条 UPDATE 的 WHERE 互斥且各自完整（不依赖先后顺序），都带 status='processing'
            # 守护 —— 绝不碰 pending / failed / done / dead_letter 行。
            # 🔴 SET 里的表达式读的是**更新前**的行值（SQLite 语义）：CASE 里的 updated_at 与
            # attempts + 1 都不受同一句 SET 影响。
            cursor = conn.execute(
                """
                UPDATE email_outbox
                   SET status = 'dead_letter',
                       last_error = CASE WHEN updated_at <= ? THEN ? ELSE ? END,
                       next_retry_at = NULL,
                       updated_at = ?
                 WHERE status = 'processing'
                   AND (updated_at <= ? OR attempts + 1 >= ?)
                """,
                (
                    cutoff,
                    self.ORPHAN_STALE_ERROR,
                    self.ORPHAN_POISON_ERROR,
                    now,
                    cutoff,
                    max_attempts,
                ),
            )
            dead_lettered = cursor.rowcount
            cursor = conn.execute(
                """
                UPDATE email_outbox
                   SET status = 'pending',
                       attempts = attempts + 1,
                       last_error = ?,
                       next_retry_at = NULL,
                       updated_at = ?
                 WHERE status = 'processing'
                   AND updated_at > ?
                   AND attempts + 1 < ?
                """,
                (self.ORPHAN_REQUEUED_ERROR, now, cutoff, max_attempts),
            )
            requeued = cursor.rowcount
            conn.commit()
        finally:
            conn.close()

        if requeued or dead_lettered:
            logger.warning(
                f"[outbox] recovered {requeued + dead_lettered} orphaned processing row(s): "
                f"{requeued} → pending (attempts+1), {dead_lettered} → dead_letter "
                f"(older than {stale_after_sec:.0f}s, or retry budget exhausted)"
            )
        # 🔴 有意不发 SSE：本方法只在 worker 启动那一刻跑，而 SSE 是 Redis pub/sub 的
        # fire-and-forget（不落库）—— 那时前端 / 看板还没订阅，发了也没人收。且这不是实时状态
        # 变化通知而是启动期一次性对账；回收结果走 warning 日志 + fanout-worker 的 starting 行，
        # dead_letter 行照常出现在 list_dead_letter() / get_stats()。不是漏了。
        return {"requeued": requeued, "dead_lettered": dead_lettered}

    # ------------------------------------------------------------
    # 读: stats (admin queue-depth / stats --section outbox)
    # ------------------------------------------------------------

    def get_stats(self) -> OutboxStats:
        conn = self._connect()
        try:
            stats = OutboxStats()

            # by_status
            rows = conn.execute(
                "SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status"
            ).fetchall()
            for r in rows:
                stats.by_status[r["status"]] = int(r["n"])
                stats.total += int(r["n"])

            # by_target
            rows = conn.execute(
                """
                SELECT target, COUNT(*) AS n FROM email_outbox
                 WHERE status IN ('pending', 'processing', 'failed')
                 GROUP BY target
                """
            ).fetchall()
            for r in rows:
                stats.by_target[r["target"]] = int(r["n"])

            # age buckets for pending: < 1min / 1-5min / 5-30min / > 30min
            now = time.time()
            buckets = {"lt_1m": 0, "lt_5m": 0, "lt_30m": 0, "gt_30m": 0}
            rows = conn.execute(
                "SELECT created_at FROM email_outbox WHERE status = 'pending'"
            ).fetchall()
            for r in rows:
                age = now - float(r["created_at"])
                if age < 60:
                    buckets["lt_1m"] += 1
                elif age < 300:
                    buckets["lt_5m"] += 1
                elif age < 1800:
                    buckets["lt_30m"] += 1
                else:
                    buckets["gt_30m"] += 1
            stats.age_buckets = buckets

            return stats
        finally:
            conn.close()

    # ------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------

    @staticmethod
    def _row_to_entry(row: sqlite3.Row) -> OutboxEntry:
        try:
            payload = json.loads(row["payload_json"] or "{}")
        except json.JSONDecodeError:
            payload = {}
        return OutboxEntry(
            outbox_id=int(row["outbox_id"]),
            internal_id=int(row["internal_id"]),
            op_type=row["op_type"],
            target=row["target"],
            payload=payload,
            source=row["source"],
            status=row["status"],
            attempts=int(row["attempts"]),
            last_error=row["last_error"],
            next_retry_at=row["next_retry_at"],
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
        )
