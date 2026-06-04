"""SyncStore v20 migration tests (B1 — outbox merge 原子化前置).

v20 = email_outbox ``ux_outbox_pending_intent`` partial unique index
(``UNIQUE(internal_id, op_type, target) WHERE status='pending'``)，配合 enqueue
的原子 UPSERT 消「读-改-写竞态 + 两份手抄 merge」。

Covers:
- fresh init (v0 → v20): partial unique index 就位 + db_version 动态最新
- partial index 防重: 同 key 第二条 pending 被拒
- partial 特性: 同 key 但非 pending (done) 不受约束 → 可与 pending 并存
- v19 → v20 upgrade: 历史竞态产生的重复 pending 行被去重 (payload 合并) + index 建好
- idempotent: 二次 init 不报错
"""
from __future__ import annotations

import json
import sqlite3
import time

import pytest

from src.mail.sync_store import SyncStore


def _list_indexes(db_path: str) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
    finally:
        conn.close()
    return {r[0] for r in rows}


def _db_version(db_path: str) -> int:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()
    finally:
        conn.close()
    return int(row[0]) if row else 0


def _seed_meta(conn: sqlite3.Connection, internal_id: int) -> None:
    now = time.time()
    conn.execute(
        "INSERT INTO email_metadata (internal_id, sync_status, created_at, updated_at) "
        "VALUES (?, 'synced', ?, ?)",
        (internal_id, now, now),
    )


def _insert_outbox(
    conn: sqlite3.Connection, internal_id: int, target: str, payload_json: str,
    *, status: str = "pending",
) -> None:
    now = time.time()
    conn.execute(
        "INSERT INTO email_outbox (internal_id, op_type, target, payload_json, source, "
        "status, created_at, updated_at) VALUES (?, 'flag_sync', ?, ?, 'cli', ?, ?, ?)",
        (internal_id, target, payload_json, status, now, now),
    )


def test_fresh_init_has_partial_unique_index(tmp_path):
    """fresh DB → ux_outbox_pending_intent index + db_version 动态最新。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    assert "ux_outbox_pending_intent" in _list_indexes(str(db))
    assert _db_version(str(db)) == SyncStore.DB_VERSION


def test_partial_unique_index_blocks_second_pending(tmp_path):
    """同 (internal_id, op_type, target) 第二条 pending 被 partial unique index 拒。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        _seed_meta(conn, 2001)
        _insert_outbox(conn, 2001, "notion", '{"is_read":true}')
        conn.commit()
        with pytest.raises(sqlite3.IntegrityError):
            _insert_outbox(conn, 2001, "notion", '{"is_flagged":false}')
            conn.commit()
    finally:
        conn.close()


def test_partial_index_allows_non_pending_duplicate(tmp_path):
    """partial index 只约束 pending: 同 key 的 done 行可与一条 pending 并存。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        _seed_meta(conn, 2002)
        _insert_outbox(conn, 2002, "notion", '{"is_read":true}', status="done")
        _insert_outbox(conn, 2002, "notion", '{"is_read":true}', status="pending")
        conn.commit()  # 不应报错
        n = conn.execute(
            "SELECT COUNT(*) FROM email_outbox WHERE internal_id=2002 AND target='notion'"
        ).fetchone()[0]
    finally:
        conn.close()
    assert n == 2


def test_v19_to_v20_dedups_duplicate_pending_then_builds_index(tmp_path):
    """v19 库有历史竞态重复 pending 行 → v20 migration 去重 (payload 合并) + 建 index。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))  # 先建 v20 拿完整 schema
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        _seed_meta(conn, 2003)
        # 模拟 v19: 删 unique index + 降 version, 塞 2 行同 key pending (竞态产物)
        conn.execute("DROP INDEX ux_outbox_pending_intent")
        conn.execute("UPDATE sync_state SET value='19' WHERE key='db_version'")
        _insert_outbox(conn, 2003, "notion", '{"is_read":true}')
        _insert_outbox(conn, 2003, "notion", '{"is_flagged":false}')
        conn.commit()
    finally:
        conn.close()

    # 重新 init → v20 migration 去重 + 建 index
    SyncStore(str(db))
    assert _db_version(str(db)) == SyncStore.DB_VERSION
    assert "ux_outbox_pending_intent" in _list_indexes(str(db))

    conn = sqlite3.connect(str(db))
    try:
        rows = conn.execute(
            "SELECT payload_json FROM email_outbox "
            "WHERE internal_id=2003 AND target='notion' AND status='pending'"
        ).fetchall()
    finally:
        conn.close()
    assert len(rows) == 1, "重复 pending 应去重成 1 行"
    # 两行 payload 升序合并 (后写覆盖同 key)
    assert json.loads(rows[0][0]) == {"is_read": True, "is_flagged": False}


def test_idempotent_double_init(tmp_path):
    """SyncStore() 跑两次不报错 + db_version 稳定 (index 已存在不重建)。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    SyncStore(str(db))
    assert _db_version(str(db)) == SyncStore.DB_VERSION
    assert "ux_outbox_pending_intent" in _list_indexes(str(db))
