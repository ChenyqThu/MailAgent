"""v30 迁移单测（S4 W1）—— report_agent 三列 + async_jobs 两列，v29→v30 ALTER + 幂等。"""
from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore

_RA_NEW = {"trigger_json", "tool_policy_json", "budget_json"}
_AJ_NEW = {"claim_token", "spec_claimed_at"}


def _cols(db, table):
    conn = sqlite3.connect(str(db))
    try:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    finally:
        conn.close()


def _db_version(db):
    conn = sqlite3.connect(str(db))
    try:
        return int(conn.execute("SELECT value FROM sync_state WHERE key='db_version'").fetchone()[0])
    finally:
        conn.close()


def test_fresh_db_is_current_version_with_new_columns(tmp_path):
    db = tmp_path / "s.db"
    SyncStore(str(db))
    # 钉当前 DB_VERSION 常量（migration 把库带到当前版本）—— 后续 bump 不再因硬编码红一次。
    assert _db_version(db) == SyncStore.DB_VERSION
    assert _RA_NEW <= _cols(db, "report_agent")
    assert _AJ_NEW <= _cols(db, "async_jobs")


def test_v29_to_v30_migration_adds_columns(tmp_path):
    """真实 v29→v30 ALTER 路径：删掉五列 + 降 version 到 29 模拟旧库，再 init → ALTER 补回。"""
    db = tmp_path / "s.db"
    SyncStore(str(db))  # 先建 v30
    # 模拟 v29：DROP 五列 + version 回 29 + 塞一行既有数据（验证保留）。
    conn = sqlite3.connect(str(db))
    conn.execute(
        "INSERT INTO report_agent (id, type, enabled, title) VALUES ('keep', 'report', 1, '旧行')"
    )
    for c in _RA_NEW:
        conn.execute(f"ALTER TABLE report_agent DROP COLUMN {c}")
    for c in _AJ_NEW:
        conn.execute(f"ALTER TABLE async_jobs DROP COLUMN {c}")
    conn.execute("UPDATE sync_state SET value='29' WHERE key='db_version'")
    conn.commit()
    conn.close()
    # 确认模拟成功（列已删）。
    assert not (_RA_NEW & _cols(db, "report_agent"))
    assert not (_AJ_NEW & _cols(db, "async_jobs"))

    # 触发迁移。
    SyncStore(str(db))
    assert _db_version(db) == SyncStore.DB_VERSION
    assert _RA_NEW <= _cols(db, "report_agent")
    assert _AJ_NEW <= _cols(db, "async_jobs")
    # 既有数据保留。
    conn = sqlite3.connect(str(db))
    row = conn.execute("SELECT title FROM report_agent WHERE id='keep'").fetchone()
    conn.close()
    assert row[0] == "旧行"


def test_migration_idempotent(tmp_path):
    db = tmp_path / "s.db"
    SyncStore(str(db))
    SyncStore(str(db))  # 重跑不崩、不重复
    SyncStore(str(db))
    assert _db_version(db) == SyncStore.DB_VERSION
    assert _RA_NEW <= _cols(db, "report_agent")
    assert _AJ_NEW <= _cols(db, "async_jobs")


def test_no_custom_seed_rows(tmp_path):
    # W1 不播种 type='custom' 行（只由 owner 创建）。
    db = tmp_path / "s.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    n = conn.execute("SELECT COUNT(*) FROM report_agent WHERE type='custom'").fetchone()[0]
    conn.close()
    assert n == 0
