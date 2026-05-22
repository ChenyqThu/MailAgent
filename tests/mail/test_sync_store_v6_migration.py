"""SyncStore v6 migration tests (PR-4 US-001).

Covers:
- fresh init (v0 → v6): tables + indices exist, db_version=6
- v5 → v6 upgrade: existing email_metadata / email_body 行不丢, 新表追加
- v6 → v6 idempotent: 二次 init 不报错, 不重复插 db_version
- cli_checkpoints upsert + get + delete round-trip
- v4_rollout_stats write + get_latest round-trip
"""

from __future__ import annotations

import json
import sqlite3
import time

import pytest

from src.mail.sync_store import SyncStore


def _list_tables(db_path: str) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
        ).fetchall()
    finally:
        conn.close()
    return {r[0] for r in rows}


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


def test_fresh_init_at_v6(tmp_path):
    """fresh DB → 当前最新 schema, 新表 + 必备 v4/v5/v7/v10 表都在.

    DB_VERSION 演进：v8 加 email_metadata.is_pinned + pinned_at（ALTER ADD COLUMN，无新表）；
    v9 加 email_metadata.is_important（同上）；v10 加 email_outbox 表（Sprint 15 SSoT inversion）。
    """
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    tables = _list_tables(str(db))
    assert {
        "email_metadata",
        "email_body",
        "email_attachment",
        "email_body_fts",
        "cli_checkpoints",
        "v4_rollout_stats",
        "island_dispatch",  # v7
        "email_outbox",     # v10
    }.issubset(tables)
    assert _db_version(str(db)) == 13  # bumped to v13 (dual-backend)


def test_v6_indices_exist(tmp_path):
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    indexes = _list_indexes(str(db))
    assert "idx_cli_checkpoints_updated" in indexes
    assert "idx_v4_rollout_flushed_at" in indexes


def test_idempotent_double_init(tmp_path):
    """SyncStore() 跑两次, 不报错 + db_version 停在当前最新."""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    SyncStore(str(db))  # 应该幂等
    assert _db_version(str(db)) == 13  # bumped to v13 (dual-backend)


def test_v5_to_v6_preserves_existing_rows(tmp_path):
    """构造旧 schema 状态, 跑 SyncStore() 升级, 现有 email_metadata 行不丢。

    历史上这个 case 验证 v5→v6 升级；DB_VERSION 已推进到 7（island_dispatch 加入），
    现在同时验证 v5→v7 升级路径中 v6 / v7 新表全部建好。
    """
    db = tmp_path / "sync.db"
    # 先建当前最新 DB 拿到完整 schema
    SyncStore(str(db))
    # 写一行邮件
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, subject, sync_status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (12345, "v5 row preserved", "synced", time.time(), time.time()),
        )
        # 降级 db_version 标 + 删 v6/v7 表模拟 v5 状态
        conn.execute("UPDATE sync_state SET value='5' WHERE key='db_version'")
        conn.execute("DROP TABLE cli_checkpoints")
        conn.execute("DROP TABLE v4_rollout_stats")
        conn.execute("DROP TABLE IF EXISTS island_dispatch")
        conn.commit()
    finally:
        conn.close()

    # 重新 init → 升级到当前最新（v10）
    SyncStore(str(db))
    assert _db_version(str(db)) == 13  # bumped to v13 (dual-backend)

    # 原 email_metadata 行还在
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT subject FROM email_metadata WHERE internal_id=12345"
        ).fetchone()
    finally:
        conn.close()
    assert row is not None
    assert row[0] == "v5 row preserved"

    # v6 / v7 / v10 新表都已建
    tables = _list_tables(str(db))
    assert "cli_checkpoints" in tables
    assert "v4_rollout_stats" in tables
    assert "island_dispatch" in tables
    assert "email_outbox" in tables


def test_cli_checkpoint_upsert_get_delete(tmp_path):
    db = tmp_path / "sync.db"
    store = SyncStore(str(db))

    store.upsert_cli_checkpoint(
        command="email-resync",
        target_kind="range",
        target_key="53000-53100",
        last_completed_internal_id=53050,
        succeeded=50,
        failed=1,
        payload={"mailbox": "收件箱"},
    )

    row = store.get_cli_checkpoint("email-resync", "53000-53100")
    assert row is not None
    assert row["last_completed_internal_id"] == 53050
    assert row["succeeded"] == 50
    assert row["failed"] == 1
    assert row["target_kind"] == "range"
    assert json.loads(row["payload"])["mailbox"] == "收件箱"

    # 同 PK 再写 → UPDATE
    store.upsert_cli_checkpoint(
        command="email-resync",
        target_kind="range",
        target_key="53000-53100",
        last_completed_internal_id=53090,
        succeeded=89,
        failed=2,
    )
    row2 = store.get_cli_checkpoint("email-resync", "53000-53100")
    assert row2["last_completed_internal_id"] == 53090
    assert row2["succeeded"] == 89
    assert row2["failed"] == 2

    # delete
    assert store.delete_cli_checkpoint("email-resync", "53000-53100") is True
    assert store.get_cli_checkpoint("email-resync", "53000-53100") is None
    # 删不存在的返回 False
    assert store.delete_cli_checkpoint("email-resync", "missing") is False


def test_v4_rollout_snapshot_round_trip(tmp_path):
    db = tmp_path / "sync.db"
    store = SyncStore(str(db))

    assert store.get_latest_v4_rollout() is None

    rowid = store.write_v4_rollout_snapshot(
        from_sqlite_hit=100,
        fallback_miss=5,
        fallback_error=1,
        route_latency_p99_ms=12.5,
        body_miss_internal_ids=[53001, 53005, 53008],
        window_seconds=60,
    )
    assert rowid > 0

    snap = store.get_latest_v4_rollout()
    assert snap is not None
    assert snap["from_sqlite_hit"] == 100
    assert snap["fallback_miss"] == 5
    assert snap["fallback_error"] == 1
    assert snap["route_latency_p99_ms"] == pytest.approx(12.5)
    assert snap["body_miss_internal_ids"] == [53001, 53005, 53008]
    assert snap["window_seconds"] == 60
    assert snap["flushed_at"] > 0


def test_v4_rollout_get_latest_picks_most_recent(tmp_path):
    db = tmp_path / "sync.db"
    store = SyncStore(str(db))

    older = time.time() - 120
    newer = time.time()

    store.write_v4_rollout_snapshot(
        from_sqlite_hit=1,
        fallback_miss=0,
        fallback_error=0,
        route_latency_p99_ms=0.0,
        flushed_at=older,
    )
    store.write_v4_rollout_snapshot(
        from_sqlite_hit=42,
        fallback_miss=0,
        fallback_error=0,
        route_latency_p99_ms=0.0,
        flushed_at=newer,
    )
    snap = store.get_latest_v4_rollout()
    assert snap["from_sqlite_hit"] == 42
