"""SyncStore v25 migration tests (T8 — 收件人全文化, 并行 recipient FTS 表)。

v25 = 新增并行 contentful FTS5 表 ``email_recipient_fts``
(to_addr, cc_addr, sender_name; tokenize='porter unicode61 remove_diacritics 2') +
3 个 trigger (insert / update_of / delete on email_metadata) + 幂等回填。
数据源是 email_metadata 三列 (与 body_fts 来自 email_body 不同, 故 trigger 直接挂
email_metadata)。主表 ``email_body_fts`` / ``email_body_fts_trigram`` 不动。

Covers:
- fresh init: 表 + 3 trigger 就位 + db_version 抬到最新 (>=25)
- v24 → v25 upgrade: 老库 (无 recipient 表/trigger) 有历史 email_metadata 行 → 升级
  回填 + recipient_fts MATCH to_addr 命中
- 回填幂等: 二次 init 不重复插、不报错
- insert trigger: 升级后新写 email_metadata 行自动进 recipient 表
- update_of trigger: 改 email_metadata.to_addr 后 recipient 表同步
"""
from __future__ import annotations

import sqlite3
import time

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


_TRIGGERS = {
    "email_recipient_fts_insert",
    "email_recipient_fts_update",
    "email_recipient_fts_delete",
}


def _insert_metadata(
    conn: sqlite3.Connection,
    internal_id: int,
    *,
    to_addr: str = "",
    cc_addr: str = "",
    sender_name: str = "",
    subject: str = "subject",
) -> None:
    now = time.time()
    conn.execute(
        """INSERT INTO email_metadata
           (internal_id, subject, sender, sender_name, to_addr, cc_addr,
            mailbox, sync_status, created_at, updated_at)
           VALUES (?, ?, 'x@example.com', ?, ?, ?, '收件箱', 'synced', ?, ?)""",
        (internal_id, subject, sender_name, to_addr, cc_addr, now, now),
    )


def _simulate_v24(db_path: str) -> None:
    """从最新 schema 模拟回退到 v24: 删 recipient 表+3 trigger + 降 version。"""
    conn = sqlite3.connect(db_path)
    try:
        for trig in _TRIGGERS:
            conn.execute(f"DROP TRIGGER IF EXISTS {trig}")
        conn.execute("DROP TABLE IF EXISTS email_recipient_fts")
        conn.execute("UPDATE sync_state SET value='24' WHERE key='db_version'")
        conn.commit()
    finally:
        conn.close()


def test_fresh_init_has_recipient_table_and_triggers(tmp_path):
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    assert "email_recipient_fts" in _objects(str(db), "table")
    triggers = _objects(str(db), "trigger")
    assert _TRIGGERS <= triggers
    # 主表 (body_fts) 仍在 — 裸词搜索零回归底座, 未被动过。
    assert "email_body_fts" in _objects(str(db), "table")
    assert _db_version(str(db)) == SyncStore.DB_VERSION
    assert SyncStore.DB_VERSION >= 25


def test_v24_to_v25_upgrade_backfills_existing_rows(tmp_path):
    """老 v24 库 (无 recipient 表) 有历史 email_metadata 行 → 升级回填。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))  # 建完整最新 schema (含 recipient 表+trigger)
    _simulate_v24(str(db))
    assert "email_recipient_fts" not in _objects(str(db), "table")

    # 灌历史数据 (此时无 recipient 表/trigger, 模拟 v24 时期写入)
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(
            conn, 1,
            to_addr="bob@example.com",
            cc_addr="carol@example.com",
            sender_name="Alice Zhang",
        )
        _insert_metadata(
            conn, 2,
            to_addr="dave@example.com",
            sender_name="Mallory Ops",
        )
        conn.commit()
    finally:
        conn.close()

    SyncStore(str(db))  # 重 init → 建表+trigger + 回填
    assert "email_recipient_fts" in _objects(str(db), "table")
    assert _TRIGGERS <= _objects(str(db), "trigger")
    assert _db_version(str(db)) == SyncStore.DB_VERSION

    conn = sqlite3.connect(str(db))
    try:
        backfilled = conn.execute(
            "SELECT COUNT(*) FROM email_recipient_fts"
        ).fetchone()[0]
        assert backfilled == 2
        # to_addr 列 MATCH 命中回填行
        to_ids = [
            r[0] for r in conn.execute(
                "SELECT rowid FROM email_recipient_fts "
                "WHERE email_recipient_fts MATCH ?",
                ("to_addr:bob",),
            ).fetchall()
        ]
        assert to_ids == [1]
        # cc_addr 列也回填了
        cc_ids = [
            r[0] for r in conn.execute(
                "SELECT rowid FROM email_recipient_fts "
                "WHERE email_recipient_fts MATCH ?",
                ("cc_addr:carol",),
            ).fetchall()
        ]
        assert cc_ids == [1]
        # sender_name 列也回填了
        name_ids = {
            r[0] for r in conn.execute(
                "SELECT rowid FROM email_recipient_fts "
                "WHERE email_recipient_fts MATCH ?",
                ("sender_name:Mallory",),
            ).fetchall()
        }
        assert name_ids == {2}
    finally:
        conn.close()


def test_backfill_idempotent_double_init(tmp_path):
    """二次 init 不重复回填、不报错 (WHERE NOT EXISTS 防重)。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    _simulate_v24(str(db))
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 1, to_addr="bob@example.com")
        conn.commit()
    finally:
        conn.close()

    SyncStore(str(db))  # 第一次升级 + 回填
    SyncStore(str(db))  # 第二次 init — 不应重复插 / 不报错

    conn = sqlite3.connect(str(db))
    try:
        n = conn.execute(
            "SELECT COUNT(*) FROM email_recipient_fts"
        ).fetchone()[0]
    finally:
        conn.close()
    assert n == 1  # 仍只有 1 行 (没被回填两次)
    assert _db_version(str(db)) == SyncStore.DB_VERSION


def test_insert_trigger_indexes_new_metadata_after_upgrade(tmp_path):
    """升级后新写 email_metadata 行 → insert trigger 自动进 recipient 表。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))  # 已含 recipient 表+trigger
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 5, to_addr="frank@example.com")
        conn.commit()
        match_ids = [
            r[0] for r in conn.execute(
                "SELECT rowid FROM email_recipient_fts "
                "WHERE email_recipient_fts MATCH ?",
                ("to_addr:frank",),
            ).fetchall()
        ]
    finally:
        conn.close()
    assert match_ids == [5]


def test_update_of_trigger_syncs_to_addr(tmp_path):
    """改 email_metadata.to_addr 后 → update_of trigger 同步 recipient 表 to_addr 列。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 7, to_addr="old@example.com")
        conn.commit()
        # 旧地址命中
        old_hit = conn.execute(
            "SELECT rowid FROM email_recipient_fts WHERE email_recipient_fts MATCH ?",
            ("to_addr:old",),
        ).fetchall()
        assert [r[0] for r in old_hit] == [7]
        # 改 to_addr
        conn.execute(
            "UPDATE email_metadata SET to_addr = ? WHERE internal_id = ?",
            ("newrecipient@example.com", 7),
        )
        conn.commit()
        new_ids = [
            r[0] for r in conn.execute(
                "SELECT rowid FROM email_recipient_fts "
                "WHERE email_recipient_fts MATCH ?",
                ("to_addr:newrecipient",),
            ).fetchall()
        ]
        # 旧地址不再命中
        old_after = conn.execute(
            "SELECT rowid FROM email_recipient_fts WHERE email_recipient_fts MATCH ?",
            ("to_addr:old",),
        ).fetchall()
    finally:
        conn.close()
    assert new_ids == [7]
    assert old_after == []
