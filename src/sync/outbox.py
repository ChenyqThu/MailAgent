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

        # 紧凑 sorted —— 与 SQL json_patch 输出 (紧凑) + TS 侧 JSON.stringify (紧凑)
        # 逐字节一致 (B1 契约)。merge 不再应用层 dict 合并, 全交给下面的 json_patch。
        # ⚠️ 不变式: payload 值非 None —— json_patch 按 RFC7396 会删 value=null 的 key
        # (与旧 dict-merge 设 None 分歧); 现所有 caller 经 _flag_payloads 只放非 None 字段。
        payload_json = json.dumps(
            payload or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        now = time.time()

        conn = self._connect()
        try:
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
            conn.commit()
            outbox_id = int(row["outbox_id"])
            was_inserted = bool(row["was_inserted"])
        finally:
            conn.close()

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
        return outbox_id

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

    def count_pending(
        self, internal_id: int, *, op_type: Optional[str] = None
    ) -> int:
        """某邮件未派发完成 (pending/processing/failed) 的 outbox 条数.

        SSoT 守卫用: 本地 intent 未派发完成前, 服务器/Notion 端的旧状态不是
        真源, 不应回写覆盖本地 (reverse_sync._enqueue_outbox 据此跳过).
        """
        sql = (
            "SELECT COUNT(*) FROM email_outbox WHERE internal_id = ? "
            "AND status IN ('pending', 'processing', 'failed')"
        )
        params: List[Any] = [internal_id]
        if op_type:
            sql += " AND op_type = ?"
            params.append(op_type)
        conn = self._connect()
        try:
            row = conn.execute(sql, params).fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()

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
        safe_publish(
            f"outbox.{new_status}",  # outbox.failed or outbox.dead_letter
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
