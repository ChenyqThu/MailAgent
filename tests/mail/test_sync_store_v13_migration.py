"""SyncStore v13 migration tests.

覆盖 review Open Question #4 + Test Gap:
- ALTER TABLE 新增三列 (imap_uidvalidity / imap_uid / backend_origin)
- backend_origin 默认 'applescript' 写到老 row
- allocate_davmail_internal_id 单进程 / 多进程 atomic
- idempotent 重跑 (重复调 _init_database 不挂)
- _save_email_v3 接受新字段 + 默认值合理
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest

from src.mail.sync_store import SyncStore


def test_v13_columns_present(tmp_path: Path):
    """v13 启动后 email_metadata 必须含三列."""
    store = SyncStore(str(tmp_path / "v13.db"))
    cols = {
        row[1] for row in
        store._get_connection().execute("PRAGMA table_info(email_metadata)").fetchall()
    }
    assert "imap_uidvalidity" in cols
    assert "imap_uid" in cols
    assert "backend_origin" in cols


def test_save_email_default_backend_origin_applescript(tmp_path: Path):
    """不传 backend_origin → 默认 'applescript'."""
    store = SyncStore(str(tmp_path / "v13.db"))
    store.save_email({
        "internal_id": 42, "message_id": "m@x", "subject": "S",
        "mailbox": "收件箱",
    })
    record = store.get(42)
    assert record["backend_origin"] == "applescript"
    assert record["imap_uid"] is None


def test_save_email_with_davmail_fields(tmp_path: Path):
    """davmail 路径透传 imap_uid / imap_uidvalidity / backend_origin."""
    store = SyncStore(str(tmp_path / "v13.db"))
    store.save_email({
        "internal_id": 1_000_000_001,
        "message_id": "dav@x",
        "subject": "Davmail",
        "mailbox": "收件箱",
        "backend_origin": "davmail",
        "imap_uid": 147644,
        "imap_uidvalidity": 12345,
    })
    record = store.get(1_000_000_001)
    assert record["backend_origin"] == "davmail"
    assert record["imap_uid"] == 147644
    assert record["imap_uidvalidity"] == 12345


def test_allocate_davmail_internal_id_starts_at_billion(tmp_path: Path):
    """第一次调用应该返回 1_000_000_000 (起点)."""
    store = SyncStore(str(tmp_path / "v13.db"))
    iid = store.allocate_davmail_internal_id()
    assert iid == 1_000_000_000


def test_allocate_davmail_internal_id_increments(tmp_path: Path):
    """连续调用 single-threaded → 严格递增."""
    store = SyncStore(str(tmp_path / "v13.db"))
    ids = [store.allocate_davmail_internal_id() for _ in range(5)]
    assert ids == [1_000_000_000, 1_000_000_001, 1_000_000_002, 1_000_000_003, 1_000_000_004]


def test_allocate_davmail_internal_id_concurrent(tmp_path: Path):
    """多线程并发 (模拟 CLI + mail-sync 同时跑) — BEGIN IMMEDIATE 保证唯一."""
    store = SyncStore(str(tmp_path / "v13.db"))
    results: list[int] = []
    lock = threading.Lock()

    def worker():
        # 每个 worker 用独立 store (跨进程模拟)
        s = SyncStore(str(tmp_path / "v13.db"))
        for _ in range(10):
            iid = s.allocate_davmail_internal_id()
            with lock:
                results.append(iid)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # 4 × 10 = 40 个 id
    assert len(results) == 40
    # 全部唯一
    assert len(set(results)) == 40
    # 所有 id ≥ 1_000_000_000
    assert all(i >= 1_000_000_000 for i in results)


def test_v13_migration_idempotent(tmp_path: Path):
    """重复 init 同一个 db 不挂 (ALTER TABLE IF NOT EXISTS 模式)."""
    db = str(tmp_path / "v13.db")
    s1 = SyncStore(db)
    s1.save_email({
        "internal_id": 1, "message_id": "m@x", "subject": "X",
        "mailbox": "收件箱",
    })
    del s1
    # 二次开 → migration 应该静默跳过 (列已存在)
    s2 = SyncStore(db)
    record = s2.get(1)
    assert record is not None
    # 仍然能正常 save 新 row
    s2.save_email({
        "internal_id": 2, "message_id": "m2@x", "subject": "Y",
        "mailbox": "收件箱",
    })
    assert s2.get(2) is not None


def test_v13_indexes_created(tmp_path: Path):
    """idx_email_imap_uid + idx_email_backend_origin 应该创建."""
    store = SyncStore(str(tmp_path / "v13.db"))
    conn = store._get_connection()
    indexes = {
        row[0] for row in
        conn.execute("SELECT name FROM sqlite_master WHERE type='index'").fetchall()
    }
    assert "idx_email_imap_uid" in indexes
    assert "idx_email_backend_origin" in indexes


def test_v13_imap_uid_partial_index(tmp_path: Path):
    """idx_email_imap_uid 是 partial index (WHERE imap_uid IS NOT NULL)."""
    store = SyncStore(str(tmp_path / "v13.db"))
    conn = store._get_connection()
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name='idx_email_imap_uid'"
    ).fetchone()
    assert row is not None
    sql = row[0] or ""
    assert "WHERE" in sql and "imap_uid IS NOT NULL" in sql
