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


# =========================================================================
# Cross-backend merge protection (Sprint 16 cutover 安全网)
# =========================================================================

class TestCrossBackendMergeProtection:
    """场景: applescript → davmail cutover 后, davmail 抓到 message_id 已存在的邮件
    (e.g. uid_mapper backfill / radar 重复看到同邮件). 老逻辑 INSERT OR REPLACE
    触发 message_id UNIQUE 冲突 → 老 row 整行被删, notion_page_id / sync_status
    全丢. 新逻辑必须合并不删."""

    def test_davmail_dup_message_id_preserves_notion_page_id(self, tmp_path: Path):
        """davmail 抓到 applescript 时代已 synced 的邮件 → 保留 notion_page_id."""
        store = SyncStore(str(tmp_path / "v13.db"))
        # applescript 时代抓的, 已 synced 到 Notion
        store.save_email({
            'internal_id': 54200, 'message_id': 'm@x',
            'subject': 'Original', 'sender': 'a@x.com',
            'mailbox': '收件箱', 'thread_id': 'thread-1@x',
            'sync_status': 'synced', 'notion_page_id': 'notion-page-abc',
            'notion_thread_id': 'notion-thread-xyz',
            'backend_origin': 'applescript',
        })
        # cutover 到 davmail 后, davmail 抓到同 message_id, 分配新 ID
        result = store.save_email({
            'internal_id': 1_000_000_001, 'message_id': 'm@x',
            'subject': 'Original',
            'mailbox': '收件箱',
            'backend_origin': 'davmail',
            'imap_uid': 147644, 'imap_uidvalidity': 1,
        })
        assert result is True

        # 关键: 老 row 还在, internal_id=54200 不变, notion_page_id 不丢
        record = store.get(54200)
        assert record is not None
        assert record['notion_page_id'] == 'notion-page-abc'
        assert record['notion_thread_id'] == 'notion-thread-xyz'
        assert record['sync_status'] == 'synced'
        assert record['backend_origin'] == 'applescript'  # 不动
        # imap_uid 已被 merge 进去, 让未来 davmail 操作能快路径找到
        assert record['imap_uid'] == 147644
        assert record['imap_uidvalidity'] == 1

        # 新 internal_id (1B+) 不应该产生 row
        dup = store.get(1_000_000_001)
        assert dup is None

    def test_applescript_dup_message_id_after_davmail_phase(self, tmp_path: Path):
        """反向场景: 切回 mail.app, radar 抓到 davmail 时代已 synced 的邮件.

        EWS 关停后回退场景: davmail 行 internal_id >= 10^9 已经在 SQLite, 回切 mail.app
        radar 用新 ROWID 看到同邮件 → 必须保留 davmail 时代的 notion_page_id, 不删行.
        """
        store = SyncStore(str(tmp_path / "v13.db"))
        store.save_email({
            'internal_id': 1_000_000_500, 'message_id': 'm@y',
            'subject': 'Davmail Era',
            'mailbox': '收件箱',
            'sync_status': 'synced', 'notion_page_id': 'notion-dav',
            'backend_origin': 'davmail',
            'imap_uid': 200000, 'imap_uidvalidity': 1,
        })
        # 切回 mail.app, radar 用 Mail.app ROWID 54900 又看到同邮件
        store.save_email({
            'internal_id': 54900, 'message_id': 'm@y',
            'subject': 'Davmail Era',
            'mailbox': '收件箱',
            # AppleScript 路径 message_id=None pending 先 — 但 v3 _poll_cycle 现在
            # davmail 路径会带 message_id, applescript 路径里也有些场景会带; 测两个都不挂.
            'backend_origin': 'applescript',
        })

        # davmail 老 row 还在
        record = store.get(1_000_000_500)
        assert record is not None
        assert record['notion_page_id'] == 'notion-dav'
        assert record['backend_origin'] == 'davmail'  # 不被新 origin 覆盖
        # 新 internal_id 不应该产生 row (避免 dup)
        assert store.get(54900) is None

    def test_same_internal_id_same_message_id_idempotent(self, tmp_path: Path):
        """同 internal_id 同 message_id 再写一次 → 正常 REPLACE 更新, 不触发合并路径."""
        store = SyncStore(str(tmp_path / "v13.db"))
        store.save_email({
            'internal_id': 100, 'message_id': 'm@z', 'subject': 'Init',
            'sync_status': 'synced', 'notion_page_id': 'p1',
            'mailbox': '收件箱',
        })
        # 同 ID 同 msgid 再写 — 走 INSERT OR REPLACE 正常路径
        store.save_email({
            'internal_id': 100, 'message_id': 'm@z', 'subject': 'Updated Subject',
            'sync_status': 'synced', 'notion_page_id': 'p1',
            'mailbox': '收件箱',
        })
        record = store.get(100)
        assert record['subject'] == 'Updated Subject'  # REPLACE 生效
        assert record['notion_page_id'] == 'p1'

    def test_new_message_id_no_merge_conflict(self, tmp_path: Path):
        """新 message_id 不触发 merge guard, 走正常 INSERT path."""
        store = SyncStore(str(tmp_path / "v13.db"))
        store.save_email({
            'internal_id': 100, 'message_id': 'm1@x', 'subject': 'A',
            'mailbox': '收件箱',
        })
        store.save_email({
            'internal_id': 101, 'message_id': 'm2@x', 'subject': 'B',
            'mailbox': '收件箱',
        })
        assert store.get(100) is not None
        assert store.get(101) is not None

    def test_pending_no_message_id_does_not_collide(self, tmp_path: Path):
        """v3 pending (message_id=None) 不应触发 merge guard."""
        store = SyncStore(str(tmp_path / "v13.db"))
        store.save_email({
            'internal_id': 100, 'message_id': None, 'subject': 'pending1',
            'sync_status': 'pending', 'mailbox': '收件箱',
        })
        store.save_email({
            'internal_id': 101, 'message_id': None, 'subject': 'pending2',
            'sync_status': 'pending', 'mailbox': '收件箱',
        })
        # 两条 pending row 都应该正常落盘
        assert store.get(100) is not None
        assert store.get(101) is not None

    def test_merge_preserves_thread_id_when_old_has_none(self, tmp_path: Path):
        """老 row thread_id 为 NULL, 新 row 有 thread_id → 合并应该填进去."""
        store = SyncStore(str(tmp_path / "v13.db"))
        store.save_email({
            'internal_id': 54000, 'message_id': 'm@th',
            'mailbox': '收件箱', 'sync_status': 'synced',
            'notion_page_id': 'np',
            # 没传 thread_id
            'backend_origin': 'applescript',
        })
        store.save_email({
            'internal_id': 1_000_000_700, 'message_id': 'm@th',
            'thread_id': 'thread-from-davmail@x',
            'mailbox': '收件箱',
            'backend_origin': 'davmail',
            'imap_uid': 999, 'imap_uidvalidity': 1,
        })
        record = store.get(54000)
        assert record['thread_id'] == 'thread-from-davmail@x'
        assert record['notion_page_id'] == 'np'  # 保留
