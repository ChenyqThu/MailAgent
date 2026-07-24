"""flag_sync intent 共享入队层 (E2-D 反向写收编).

历史上 flag→outbox 入队逻辑有三份人肉镜像: `src/services/mail_write.py::set_flags`
(前端直写, dual-target mailapp+notion) / `src/events/handlers.py` 各反向 handler
(target=mailapp-only 防回环) / `src/mail/reverse_sync.py::_enqueue_outbox`
(轮询路径, target=mailapp-only)。E2-D 把「update_local_flags (echo prevention)
+ outbox.enqueue」骨架收编到这里, 三处消费同一入队函数, payload/target 语义差异
由参数承载:

- ``mailapp_payload``: 只含 is_read/is_flagged; 空/None → 不入 mailapp 队。
- ``notion_payload``: 可带 processing_status; None → 不入 notion 队
  (Notion 端是 intent 来源的路径防回环不回写)。
- echo prevention (source='notion_webhook' + target='notion' silent skip)
  仍在 OutboxRepository.enqueue 内, 本层不重复。

``converge_local_read_atomic`` 是入向路径 (issue #58 已读回收) 的专用变体: 与上面
「先 commit 本地、再另起连接入队」不同, 它把校验 + 本地 CAS + 入队压进**同一个
事务**, 详见其 docstring。
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from src.sync.outbox import OutboxRepository


class ConvergeLockBusy(RuntimeError):
    """收敛事务在 busy timeout 内没拿到 SQLite 写锁 —— 本轮让路, 下轮重判。

    与"真失败"分开一个类型, 是因为调用方对两者的处置不同: 锁竞争是**预期内的
    可跳过态** (下一个 interval 该封仍是本地未读 → 重新进候选, 幂等), 而
    IntegrityError / 磁盘错误之类要 warning 出来。另见
    ``converge_local_read_atomic`` 的 ``busy_timeout_sec``。
    """


def _is_sqlite_lock_error(exc: BaseException) -> bool:
    """区分「锁竞争」与其它 OperationalError (no such table / disk I/O error …)。

    sqlite3 没有为锁超时留独立异常类, 只能认 message ——
    ``database is locked`` / ``database table is locked`` 两种措辞。
    """
    return isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower()


@dataclass
class FlagSyncEnqueueResult:
    """单封邮件 flag_sync 入队结果。id 为 None = 该 target 未入队。"""

    mailapp_outbox_id: Optional[int] = None
    notion_outbox_id: Optional[int] = None


def enqueue_flag_sync(
    outbox_repo: OutboxRepository,
    internal_id: int,
    *,
    mailapp_payload: Optional[Dict[str, Any]] = None,
    notion_payload: Optional[Dict[str, Any]] = None,
    source: str,
) -> FlagSyncEnqueueResult:
    """flag_sync outbox 入队 (不碰 SQLite mirror) —— op_type='flag_sync' 唯一常量点。

    mailapp_payload 空/None → 跳过 mailapp target (与历史 mail_write
    ``if mailapp_payload`` truthiness 判定一致); notion_payload None → 跳过
    notion target (空 dict 仍入队, 保持 mail_write notion 恒入队语义)。
    """
    result = FlagSyncEnqueueResult()
    if mailapp_payload:
        result.mailapp_outbox_id = outbox_repo.enqueue(
            internal_id=internal_id,
            op_type="flag_sync",
            target="mailapp",
            payload=mailapp_payload,
            source=source,
        )
    if notion_payload is not None:
        result.notion_outbox_id = outbox_repo.enqueue(
            internal_id=internal_id,
            op_type="flag_sync",
            target="notion",
            payload=notion_payload,
            source=source,
        )
    return result


def mirror_and_enqueue_flag_sync(
    sync_store: Any,
    outbox_repo: OutboxRepository,
    internal_id: int,
    *,
    local_read: bool,
    local_flagged: bool,
    local_processing_status: Optional[str] = None,
    mailapp_payload: Optional[Dict[str, Any]] = None,
    notion_payload: Optional[Dict[str, Any]] = None,
    source: str,
) -> FlagSyncEnqueueResult:
    """update_local_flags (echo prevention, SQLite 立即镜像目标态) + flag_sync 入队。

    local_* 是 SQLite 侧的**目标状态** (非 diff): 立即镜像让下一轮 SQLite Radar /
    前端 listEnriched 不把 fanout 即将派发的状态当新 diff 触发反向链路。
    """
    sync_store.update_local_flags(
        internal_id,
        local_read,
        local_flagged,
        processing_status=local_processing_status,
    )
    return enqueue_flag_sync(
        outbox_repo,
        internal_id,
        mailapp_payload=mailapp_payload,
        notion_payload=notion_payload,
        source=source,
    )


def converge_local_read_atomic(
    sync_store: Any,
    outbox_repo: OutboxRepository,
    internal_id: int,
    *,
    expected_updated_at: Optional[float],
    notion_payload: Dict[str, Any],
    source: str,
    busy_timeout_sec: Optional[float] = None,
) -> bool:
    """入向已读回收 (issue #58) 专用: 「无在途 intent + 本地自快照起未被改动 → 置已读
    + 入 notion 队」整体落在**同一个 SQLite 事务**里, 返回是否真的收敛了这一封。

    ``expected_updated_at`` = 候选快照时读到的 email_metadata.updated_at, 由 CAS 比对
    (见 ``SyncStore.mark_read_if_unread_on_conn``)。

    为什么必须原子 (codex review 两处 BLOCK):
      1. ``mirror_and_enqueue_flag_sync`` 是"先 commit 本地已读, 再另起连接入队"。入队
         若因锁/磁盘/进程退出失败, 本地已是 is_read=1 → 下一轮 reconcile 只查未读行,
         这封**永远**不再进候选 → **Notion intent 永久缺失**。反过来先入队后更新只是把
         半提交换个方向 (队里有 intent 但本地仍未读, 下轮重复入队), 一样不对。
      2. ``has_pending`` 与写之间的 TOCTOU: 查完之后、写之前, 用户在前端把这封标"未读"
         并入队 mailapp ``is_read=false``; 若照旧写下去, 本地被改回 true 且 notion 队里
         的 ``json_patch`` 会把用户 intent 合并覆盖 —— 用户显式的「标为未读」被吞掉
         (Sprint15 事故类型的竞态变体)。

    实现: ``BEGIN IMMEDIATE`` 先拿写锁, 再依次做 (a) 在途 intent 复核 (b) ``is_read=0
    AND updated_at IS <快照值>`` 的 CAS 置已读 (c) outbox UPSERT; 任一步不成立 → 回滚,
    不留痕。
    email_metadata 与 email_outbox 同库 (sync_store.db), 故一个连接即可覆盖两表 ——
    不同库会退化成两阶段, 这里显式断言防以后拆库时静默失去原子性。

    ``busy_timeout_sec``: 覆盖连接的 SQLite busy timeout (默认沿用
    ``OutboxRepository.DEFAULT_BUSY_TIMEOUT_SEC`` = 30s)。入向回收传一个**短**值 ——
    这是个可跳过的便利型写 (下轮该封仍是本地未读, 会重新进候选), 不值得让调用方
    为它挂 30s；超时抛 ``ConvergeLockBusy`` 让调用方保守让路。
    """
    if Path(str(sync_store.db_path)) != Path(str(outbox_repo.db_path)):
        raise ValueError(
            "converge_local_read_atomic 要求 email_metadata 与 email_outbox 同库 "
            f"({sync_store.db_path!r} vs {outbox_repo.db_path!r})"
        )
    conn = outbox_repo._connect(timeout=busy_timeout_sec)
    try:
        conn.execute("BEGIN IMMEDIATE")
        # (a) 在途出向 intent (pending/processing/failed) → 本轮不碰, 让 fanout 先落定
        if outbox_repo.has_pending_on_conn(conn, internal_id, "flag_sync"):
            conn.rollback()
            return False
        # (b) CAS: 已读 / 快照之后被写过 → rowcount=0 → 放弃 (下轮重判)
        if not sync_store.mark_read_if_unread_on_conn(
            conn, internal_id, expected_updated_at
        ):
            conn.rollback()
            return False
        # (c) 同事务入队; 失败会连 (b) 一起回滚 → 不产生"本地已读但队里没有"的半提交
        outbox_id, was_inserted = outbox_repo.upsert_on_conn(
            conn,
            internal_id=internal_id,
            op_type="flag_sync",
            target="notion",
            payload=notion_payload,
            source=source,
        )
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        # 锁竞争单独成型: 调用方据此计数/让路, 而不是当成真失败刷 warning
        if _is_sqlite_lock_error(e):
            raise ConvergeLockBusy(str(e)) from e
        raise
    finally:
        conn.close()
    # SSE 在事务外发 (行已确定落库), 与 OutboxRepository.enqueue 同语义
    outbox_repo.announce_enqueued(
        outbox_id, was_inserted,
        internal_id=internal_id, op_type="flag_sync", target="notion", source=source,
    )
    return True
