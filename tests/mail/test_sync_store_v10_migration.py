"""SyncStore v10 migration tests (Sprint 15 SQLite SSoT inversion).

Covers:
- fresh init (v0 → v10): email_outbox 表 + 3 索引 + CHECK constraint 全部就位
- v9 → v10 upgrade: 既有 email_metadata 行不丢, email_outbox 表追加
- v10 → v10 idempotent: 二次 init 不重复建表 / 不报错
- email_outbox CHECK constraint：非法 target / status 被拒
- FK CASCADE：删 email_metadata 行时同 internal_id 的 outbox 行级联删
"""

from __future__ import annotations

import sqlite3
import time

import pytest

from src.mail.sync_store import SyncStore


def _list_tables(db_path: str) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
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


def test_fresh_init_at_v10(tmp_path):
    """fresh DB → email_outbox 表 + 3 索引 + db_version=10."""
    db = tmp_path / "sync.db"
    SyncStore(str(db))

    tables = _list_tables(str(db))
    assert "email_outbox" in tables

    indexes = _list_indexes(str(db))
    assert "idx_outbox_pending" in indexes
    assert "idx_outbox_internal_id" in indexes
    assert "idx_outbox_target_status" in indexes

    assert _db_version(str(db)) == 15  # bumped to v15 (calendar SSoT)


def test_email_outbox_schema_columns(tmp_path):
    """email_outbox 13 列齐全 + 默认值正确."""
    db = tmp_path / "sync.db"
    SyncStore(str(db))

    conn = sqlite3.connect(str(db))
    try:
        cols = {r[1]: r for r in conn.execute("PRAGMA table_info(email_outbox)")}
    finally:
        conn.close()

    expected = {
        "outbox_id", "internal_id", "op_type", "target", "payload_json",
        "source", "status", "attempts", "last_error", "next_retry_at",
        "created_at", "updated_at",
    }
    assert expected.issubset(cols.keys()), f"missing columns: {expected - cols.keys()}"

    # status default = 'pending', attempts default = 0
    # PRAGMA table_info: col[4] = dflt_value
    assert "'pending'" in str(cols["status"][4])
    assert str(cols["attempts"][4]) == "0"


def test_v9_to_v10_preserves_existing_rows(tmp_path):
    """构造 v9 状态，跑 SyncStore() 升级，existing email_metadata 行不丢 + email_outbox 表追加."""
    db = tmp_path / "sync.db"
    # 先建当前最新 DB 拿到完整 schema
    SyncStore(str(db))

    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, subject, sync_status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (54321, "v9 row preserved", "synced", time.time(), time.time()),
        )
        # 降级 db_version 标 + 删 v10 表模拟 v9 状态
        conn.execute("UPDATE sync_state SET value='9' WHERE key='db_version'")
        conn.execute("DROP TABLE email_outbox")
        conn.commit()
    finally:
        conn.close()

    # 重新 init → 升级到 v10
    SyncStore(str(db))
    assert _db_version(str(db)) == 15  # bumped to v15 (calendar SSoT)

    # 原 email_metadata 行还在
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT subject FROM email_metadata WHERE internal_id=54321"
        ).fetchone()
    finally:
        conn.close()
    assert row is not None
    assert row[0] == "v9 row preserved"

    # email_outbox 表已建
    tables = _list_tables(str(db))
    assert "email_outbox" in tables


def test_idempotent_double_init(tmp_path):
    """SyncStore() 跑两次, 不报错 + db_version 仍是 10."""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    SyncStore(str(db))
    assert _db_version(str(db)) == 15  # bumped to v15 (calendar SSoT)


def test_email_outbox_target_check_constraint(tmp_path):
    """target 必须 in ('mailapp','notion'), 其他值 INSERT 被拒."""
    db = tmp_path / "sync.db"
    SyncStore(str(db))

    conn = sqlite3.connect(str(db))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        # 先建 metadata 行（FK 依赖）
        conn.execute(
            "INSERT INTO email_metadata (internal_id, sync_status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (1001, "synced", time.time(), time.time()),
        )
        conn.commit()

        # 合法 target 通过
        conn.execute(
            "INSERT INTO email_outbox (internal_id, op_type, target, payload_json, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (1001, "flag_sync", "mailapp", "{}", time.time(), time.time()),
        )
        conn.commit()

        # 非法 target 被 CHECK constraint 拒
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO email_outbox (internal_id, op_type, target, payload_json, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (1001, "flag_sync", "feishu", "{}", time.time(), time.time()),
            )
            conn.commit()
    finally:
        conn.close()


def test_email_outbox_status_check_constraint(tmp_path):
    """status 必须 in ('pending','processing','done','failed','dead_letter')."""
    db = tmp_path / "sync.db"
    SyncStore(str(db))

    conn = sqlite3.connect(str(db))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(
            "INSERT INTO email_metadata (internal_id, sync_status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (1002, "synced", time.time(), time.time()),
        )
        conn.commit()

        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO email_outbox (internal_id, op_type, target, payload_json, "
                "status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (1002, "flag_sync", "mailapp", "{}", "invalid_status", time.time(), time.time()),
            )
            conn.commit()
    finally:
        conn.close()


def test_email_outbox_cascade_on_email_delete(tmp_path):
    """FK ON DELETE CASCADE: 删 email_metadata 行时同 internal_id 的 outbox 行被级联删."""
    db = tmp_path / "sync.db"
    SyncStore(str(db))

    conn = sqlite3.connect(str(db))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(
            "INSERT INTO email_metadata (internal_id, sync_status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (1003, "synced", time.time(), time.time()),
        )
        # 2 条 outbox 行（mailapp + notion）
        for target in ("mailapp", "notion"):
            conn.execute(
                "INSERT INTO email_outbox (internal_id, op_type, target, payload_json, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (1003, "flag_sync", target, '{"is_read": true}', time.time(), time.time()),
            )
        conn.commit()

        # 删 metadata 行
        conn.execute("DELETE FROM email_metadata WHERE internal_id = ?", (1003,))
        conn.commit()

        # outbox 行应级联清空
        remaining = conn.execute(
            "SELECT COUNT(*) FROM email_outbox WHERE internal_id = ?", (1003,)
        ).fetchone()[0]
        assert remaining == 0, "FK CASCADE 没生效，outbox 仍有残留行"
    finally:
        conn.close()
