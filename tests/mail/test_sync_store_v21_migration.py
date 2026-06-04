"""SyncStore v21 migration tests (C1 — async_jobs 子系统)。

v21 = 新增 ``async_jobs`` 表 (长任务统一 enqueue + 执行账本) +
``ux_async_jobs_idempotency`` partial unique + ``ix_async_jobs_status``。纯加表
(CREATE TABLE IF NOT EXISTS 对新/旧库均生效), 无 data migration。

Covers:
- fresh init: async_jobs 表 + 两索引就位 + db_version 动态最新
- idempotency partial unique: 同 idempotency_key 第二条被拒; NULL key 不约束
- v20 → v21 upgrade: 老库 (无 async_jobs) 重新 init 后表建好 + version 抬到最新
- idempotent: 二次 init 不报错
"""
from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore


def _objects(db_path: str, obj_type: str) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type=?", (obj_type,)
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


def test_fresh_init_has_async_jobs_table_and_indexes(tmp_path):
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    assert "async_jobs" in _objects(str(db), "table")
    idxs = _objects(str(db), "index")
    assert "ux_async_jobs_idempotency" in idxs
    assert "ix_async_jobs_status" in idxs
    assert _db_version(str(db)) == SyncStore.DB_VERSION
    assert SyncStore.DB_VERSION >= 21


def test_idempotency_partial_unique_blocks_duplicate_key(tmp_path):
    """同 idempotency_key 第二条 INSERT 被 partial unique 拒。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            "INSERT INTO async_jobs (job_type, idempotency_key, created_at, updated_at) "
            "VALUES ('resync', 'k1', 1.0, 1.0)"
        )
        conn.commit()
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO async_jobs (job_type, idempotency_key, created_at, updated_at) "
                "VALUES ('resync', 'k1', 2.0, 2.0)"
            )
            conn.commit()
    finally:
        conn.close()


def test_idempotency_partial_unique_allows_null_keys(tmp_path):
    """idempotency_key=NULL 不受 partial unique 约束 (多条 NULL 可并存)。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            "INSERT INTO async_jobs (job_type, idempotency_key, created_at, updated_at) "
            "VALUES ('backfill_body', NULL, 1.0, 1.0)"
        )
        conn.execute(
            "INSERT INTO async_jobs (job_type, idempotency_key, created_at, updated_at) "
            "VALUES ('backfill_body', NULL, 2.0, 2.0)"
        )
        conn.commit()  # 不应报错
        n = conn.execute("SELECT COUNT(*) FROM async_jobs").fetchone()[0]
    finally:
        conn.close()
    assert n == 2


def test_v20_to_v21_upgrade_creates_table(tmp_path):
    """老 v20 库 (无 async_jobs) 重 init → 表建好 + version 抬到最新。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))  # 先建完整 schema
    conn = sqlite3.connect(str(db))
    try:
        # 模拟 v20: 删 async_jobs 表 + 降 version
        conn.execute("DROP TABLE async_jobs")
        conn.execute("UPDATE sync_state SET value='20' WHERE key='db_version'")
        conn.commit()
    finally:
        conn.close()
    assert "async_jobs" not in _objects(str(db), "table")

    SyncStore(str(db))  # 重新 init → CREATE TABLE IF NOT EXISTS 补回
    assert "async_jobs" in _objects(str(db), "table")
    assert "ux_async_jobs_idempotency" in _objects(str(db), "index")
    assert _db_version(str(db)) == SyncStore.DB_VERSION


def test_idempotent_double_init(tmp_path):
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    SyncStore(str(db))
    assert "async_jobs" in _objects(str(db), "table")
    assert _db_version(str(db)) == SyncStore.DB_VERSION
