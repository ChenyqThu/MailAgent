"""SyncStore v24 migration tests (T7 — CJK 并行 trigram 表)。

v24 = 新增并行 contentful FTS5 表 ``email_body_fts_trigram`` (tokenize='trigram') +
4 个 trigger (insert/delete/update on email_body + meta_update on email_metadata) +
幂等回填。主表 ``email_body_fts`` (porter unicode61) 不动。

Covers:
- fresh init: 表 + 4 trigger 就位 + db_version 抬到最新 (>=24)
- v23 → v24 upgrade: 老库 (无 trigram 表/trigger) 重 init → 表+4 trigger 建好 +
  历史 email_body 行被回填进 trigram 表 + version 抬到最新
- 回填幂等: 二次 init 不重复插、不报错
- insert trigger: 升级后新写 email_body 行自动进 trigram 表
- meta_update trigger: 改 email_metadata.subject 后 trigram 表 subject 列同步
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
    "email_body_fts_trigram_insert",
    "email_body_fts_trigram_delete",
    "email_body_fts_trigram_update",
    "email_body_fts_trigram_meta_update",
}


def _insert_metadata(conn: sqlite3.Connection, internal_id: int, subject: str,
                     sender: str = "x@example.com") -> None:
    now = time.time()
    conn.execute(
        """INSERT INTO email_metadata
           (internal_id, subject, sender, mailbox, sync_status, created_at, updated_at)
           VALUES (?, ?, ?, '收件箱', 'synced', ?, ?)""",
        (internal_id, subject, sender, now, now),
    )


def _insert_body(conn: sqlite3.Connection, internal_id: int, body: str) -> None:
    now = time.time()
    conn.execute(
        """INSERT INTO email_body
           (internal_id, body_markdown, body_format, body_size_bytes,
            fetched_at, fetched_source)
           VALUES (?, ?, 'text-only', ?, ?, 'test')""",
        (internal_id, body, len(body), now),
    )


def _simulate_v23(db_path: str) -> None:
    """从已建好的最新 schema 模拟回退到 v23: 删 trigram 表+4 trigger + 降 version。"""
    conn = sqlite3.connect(db_path)
    try:
        for trig in _TRIGGERS:
            conn.execute(f"DROP TRIGGER IF EXISTS {trig}")
        conn.execute("DROP TABLE IF EXISTS email_body_fts_trigram")
        conn.execute("UPDATE sync_state SET value='23' WHERE key='db_version'")
        conn.commit()
    finally:
        conn.close()


def test_fresh_init_has_trigram_table_and_triggers(tmp_path):
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    assert "email_body_fts_trigram" in _objects(str(db), "table")
    triggers = _objects(str(db), "trigger")
    assert _TRIGGERS <= triggers
    # 主表 + 主表 trigger 仍在 (英文零回归底座)
    assert "email_body_fts" in _objects(str(db), "table")
    assert _db_version(str(db)) == SyncStore.DB_VERSION
    assert SyncStore.DB_VERSION >= 24


def test_v23_to_v24_upgrade_backfills_existing_rows(tmp_path):
    """老 v23 库 (无 trigram 表) 有历史 email_body 行 → 升级回填进 trigram 表。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))  # 建完整最新 schema (含 trigram 表+trigger)
    _simulate_v23(str(db))
    assert "email_body_fts_trigram" not in _objects(str(db), "table")

    # 灌历史数据 (此时无 trigram 表/trigger, 模拟 v23 时期写入)
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 1, "产品评审会议")
        _insert_body(conn, 1, "本周产品评审定在周三下午")
        _insert_metadata(conn, 2, "Weekly report")
        _insert_body(conn, 2, "weekly report project budget")
        conn.commit()
    finally:
        conn.close()

    SyncStore(str(db))  # 重 init → 建表+trigger + 回填
    assert "email_body_fts_trigram" in _objects(str(db), "table")
    assert _TRIGGERS <= _objects(str(db), "trigger")
    assert _db_version(str(db)) == SyncStore.DB_VERSION

    conn = sqlite3.connect(str(db))
    try:
        backfilled = conn.execute(
            "SELECT COUNT(*) FROM email_body_fts_trigram"
        ).fetchone()[0]
        assert backfilled == 2
        # 3 字 CJK MATCH 命中回填行
        match_ids = [
            r[0] for r in conn.execute(
                "SELECT rowid FROM email_body_fts_trigram WHERE email_body_fts_trigram MATCH ?",
                ("产品评",),
            ).fetchall()
        ]
        assert match_ids == [1]
        # subject 列也回填了 (从 email_metadata join)
        like_ids = {
            r[0] for r in conn.execute(
                "SELECT rowid FROM email_body_fts_trigram WHERE subject LIKE ?",
                ("%产品%",),
            ).fetchall()
        }
        assert like_ids == {1}
    finally:
        conn.close()


def test_backfill_idempotent_double_init(tmp_path):
    """二次 init 不重复回填、不报错 (WHERE NOT EXISTS 防重)。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    _simulate_v23(str(db))
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 1, "产品评审会议")
        _insert_body(conn, 1, "本周产品评审定在周三下午")
        conn.commit()
    finally:
        conn.close()

    SyncStore(str(db))  # 第一次升级 + 回填
    SyncStore(str(db))  # 第二次 init — 不应重复插 / 不报错

    conn = sqlite3.connect(str(db))
    try:
        n = conn.execute("SELECT COUNT(*) FROM email_body_fts_trigram").fetchone()[0]
    finally:
        conn.close()
    assert n == 1  # 仍只有 1 行 (没被回填两次)
    assert _db_version(str(db)) == SyncStore.DB_VERSION


def test_insert_trigger_indexes_new_body_after_upgrade(tmp_path):
    """升级后新写 email_body 行 → insert trigger 自动进 trigram 表。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))  # 已含 trigram 表+trigger
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 5, "新邮件主题")  # metadata 先 commit (trigger join 取)
        conn.commit()
        _insert_body(conn, 5, "正文里有产品评审定相关内容")
        conn.commit()
        match_ids = [
            r[0] for r in conn.execute(
                "SELECT rowid FROM email_body_fts_trigram WHERE email_body_fts_trigram MATCH ?",
                ("产品评",),
            ).fetchall()
        ]
    finally:
        conn.close()
    assert match_ids == [5]


def test_meta_update_trigger_syncs_subject(tmp_path):
    """改 email_metadata.subject 后 → meta_update trigger 同步 trigram 表 subject 列。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 7, "旧主题无关键词")
        conn.commit()
        _insert_body(conn, 7, "正文普通内容")
        conn.commit()
        # 改 subject 加入可搜索的 CJK 子串
        conn.execute(
            "UPDATE email_metadata SET subject = ? WHERE internal_id = ?",
            ("更新后产品评审主题", 7),
        )
        conn.commit()
        match_ids = [
            r[0] for r in conn.execute(
                "SELECT rowid FROM email_body_fts_trigram WHERE email_body_fts_trigram MATCH ?",
                ("产品评",),
            ).fetchall()
        ]
    finally:
        conn.close()
    assert match_ids == [7]
