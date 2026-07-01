"""ping-island 按钮回调的解耦 ack 通道 —— pending 登记表（契约 §6 / §9-4）.

背景（契约 §6 大坑）：envelope 的 3s 短连接兜不住异步人工点击（人来不及 3s 内点 →
socket 超时关闭 → fork 回写命中 guard 静默 no-op → 业务 CLI 从没被调）。

解耦方案：
- 每条带按钮的 envelope 带一个**不可猜的 ``ack_token``**（本模块 ``register`` 生成，
  注入 envelope ``metadata["ack_token"]``，经本地 unix socket 发给 ping-island）。
- ping-island fork 按钮点击时 fire-and-forget ``POST /api/island/ack {ack_token, choice}``
  到 serve-api（非同步 socket，不受 3s 限制）。
- serve-api 端 ``resolve`` 按 token 查 live pending → 路由到 ``island_response`` action handler。

跨进程：``register`` 跑在 **mail-sync 进程**（dispatch 时），``resolve`` 跑在 **serve-api
进程**（ack POST 时）——两进程读同一个 ``sync_store.db``（BackendLifecycleManager 分别
spawn 的独立进程，deps.py 已确认同库）。故 pending 落 SQLite 而非内存。用短命连接
（EmailRepository 同款，WAL 并发安全），**不碰 SyncStore 迁移机制**；表由本模块
``CREATE TABLE IF NOT EXISTS`` 幂等建（两进程谁先跑都行），不进 ``DB_VERSION``。

安全：loopback + ``ack_token`` 作能力令牌——ping-island 只因 MailAgent 经**本地** unix
socket 发过 envelope 才知道它（token 不出网、不进 Notion/远程 API）；对不上 live pending
即拒。单次消费（``DELETE ... RETURNING`` 原子 pop）+ TTL 过期。
"""

from __future__ import annotations

import json
import logging
import secrets
import sqlite3
import time
from dataclasses import dataclass
from typing import Dict, Optional, Set

log = logging.getLogger(__name__)

# 邮件通知可挂较久（岛生命周期 5min 隐藏 / 12h GC 松耦合）；1h 足够人回来点。
DEFAULT_TTL_SEC = 3600.0
# 上限防表膨胀（每封带按钮邮件一行；正常远小于此，异常时删最老）。
_MAX_PENDING = 500


@dataclass
class PendingAck:
    """一条 live pending（``resolve`` 命中后返回给调用方路由）."""

    ack_token: str
    kind: str  # "mail" | "agent"（agent 留给 Part B harness 上岛）
    internal_id: Optional[int]
    session_key: str
    event_type: str
    metadata: Dict[str, str]
    choices: Set[str]
    expires_at: float


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def _ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS island_ack_pending (
            ack_token     TEXT PRIMARY KEY,
            kind          TEXT NOT NULL,
            internal_id   INTEGER,
            session_key   TEXT NOT NULL,
            event_type    TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            choices_json  TEXT NOT NULL,
            created_at    REAL NOT NULL,
            expires_at    REAL NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_island_ack_session "
        "ON island_ack_pending(session_key, event_type)"
    )


def register(
    db_path: str,
    *,
    kind: str,
    session_key: str,
    event_type: str,
    metadata: Dict[str, str],
    choices: Set[str],
    internal_id: Optional[int] = None,
    ttl_sec: float = DEFAULT_TTL_SEC,
) -> str:
    """登记一条 pending，返回 ``ack_token``（注入 envelope metadata 发给 ping-island）.

    同 ``(session_key, event_type)`` 重发 → evict 旧 token（只保留最新 envelope 的 ack，
    契约 §9-1 幂等语义）；顺带 GC 过期行 + cap。DB 出错仍返 token（fail-open：不阻断
    dispatch，仅该按钮 ack 会 miss，等同现状）。
    """
    now = time.time()
    token = secrets.token_urlsafe(24)
    try:
        conn = _connect(db_path)
        try:
            _ensure_table(conn)
            with conn:  # 事务
                # evict 同 (session_key, event_type) 旧 pending + GC 过期
                conn.execute(
                    "DELETE FROM island_ack_pending WHERE session_key=? AND event_type=?",
                    (session_key, event_type),
                )
                conn.execute(
                    "DELETE FROM island_ack_pending WHERE expires_at <= ?", (now,)
                )
                conn.execute(
                    """
                    INSERT INTO island_ack_pending
                        (ack_token, kind, internal_id, session_key, event_type,
                         metadata_json, choices_json, created_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        token, kind,
                        int(internal_id) if internal_id is not None else None,
                        session_key, event_type,
                        json.dumps(metadata, ensure_ascii=False),
                        json.dumps(sorted(choices)),
                        now, now + max(ttl_sec, 1.0),
                    ),
                )
                # cap: 超 _MAX_PENDING 删最老 (按 created_at 保留最新 _MAX_PENDING 条)
                conn.execute(
                    """
                    DELETE FROM island_ack_pending WHERE ack_token IN (
                        SELECT ack_token FROM island_ack_pending
                        ORDER BY created_at DESC LIMIT -1 OFFSET ?
                    )
                    """,
                    (_MAX_PENDING,),
                )
        finally:
            conn.close()
    except sqlite3.Error as e:
        log.debug("[island-ack] register failed (fail-open): %s", e)
    return token


def resolve(db_path: str, ack_token: str, choice: str) -> Optional[PendingAck]:
    """按 token 查 live pending + 校验 + **单次消费**；无效/过期/choice 不匹配 → None.

    ``DELETE ... RETURNING`` 原子 pop：并发同 token 只有一个调用拿到行（另一个空），
    杜绝双执行。过期 / choice 不在该 envelope options → 返 None（已消费的不复活）。
    """
    if not ack_token or not choice:
        return None
    now = time.time()
    try:
        conn = _connect(db_path)
        try:
            _ensure_table(conn)
            with conn:
                row = conn.execute(
                    "DELETE FROM island_ack_pending WHERE ack_token=? RETURNING *",
                    (ack_token,),
                ).fetchone()
            if row is None:
                return None
            if now >= float(row["expires_at"]):
                return None  # 过期（已 pop，不复活）
            choices = set(json.loads(row["choices_json"]))
            if choice not in choices:
                return None  # choice 不在该 envelope 的 options（防伪造/串号）
            return PendingAck(
                ack_token=ack_token,
                kind=row["kind"],
                internal_id=row["internal_id"],
                session_key=row["session_key"],
                event_type=row["event_type"],
                metadata=json.loads(row["metadata_json"]),
                choices=choices,
                expires_at=float(row["expires_at"]),
            )
        finally:
            conn.close()
    except (sqlite3.Error, json.JSONDecodeError) as e:
        log.debug("[island-ack] resolve failed: %s", e)
        return None


def clear_for_tests(db_path: str) -> None:
    """单测用：清空 pending 表."""
    try:
        conn = _connect(db_path)
        try:
            _ensure_table(conn)
            with conn:
                conn.execute("DELETE FROM island_ack_pending")
        finally:
            conn.close()
    except sqlite3.Error:
        pass
