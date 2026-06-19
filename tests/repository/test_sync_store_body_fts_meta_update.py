"""SyncStore NS-5 — email_body_fts meta_update trigger 测试。

NS-5: 主表 ``email_body_fts`` 历史隐患 —— subject/sender 改在 ``email_metadata`` 上时
主表 FTS 不更新 → 按 subject/sender 搜可能命中陈旧值。补 ``email_body_fts_meta_update``
trigger (无条件 CREATE IF NOT EXISTS, 每次 init 幂等创建, 无需 bump DB_VERSION,
与 ``email_body_fts_trigram_meta_update`` 对齐)。

Covers:
- fresh init: trigger 就位
- meta_update trigger: 改 email_metadata.subject 后主表 email_body_fts.subject 列同步
- meta_update trigger: 改 email_metadata.sender 后主表 email_body_fts.sender 列同步
- 无 body 行时不建 FTS 行 (WHEN EXISTS body 守卫)
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


def _fts_row(conn: sqlite3.Connection, internal_id: int) -> tuple[str, str] | None:
    row = conn.execute(
        "SELECT subject, sender FROM email_body_fts WHERE rowid = ?",
        (internal_id,),
    ).fetchone()
    return (row[0], row[1]) if row else None


def test_fresh_init_has_meta_update_trigger(tmp_path):
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    assert "email_body_fts_meta_update" in _objects(str(db), "trigger")
    # 主表 + 既有 trigger 仍在 (零回归)
    assert "email_body_fts" in _objects(str(db), "table")
    assert {"email_body_fts_insert", "email_body_fts_update", "email_body_fts_delete"} <= \
        _objects(str(db), "trigger")


def test_meta_update_trigger_syncs_subject(tmp_path):
    """改 email_metadata.subject 后 → 主表 email_body_fts.subject 列同步 (修 NS-5)。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 7, "旧主题")
        conn.commit()
        _insert_body(conn, 7, "正文普通内容")
        conn.commit()
        # 初始: FTS subject = 旧主题 (insert trigger join 取)
        assert _fts_row(conn, 7) == ("旧主题", "x@example.com")

        conn.execute(
            "UPDATE email_metadata SET subject = ? WHERE internal_id = ?",
            ("更新后的新主题", 7),
        )
        conn.commit()
        # NS-5 修复前: FTS subject 仍是 '旧主题' (stale); 修复后: 同步成新主题
        assert _fts_row(conn, 7) == ("更新后的新主题", "x@example.com")
        # 用 FTS MATCH 验证可按新 subject 搜到
        match_ids = [
            r[0] for r in conn.execute(
                "SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?",
                ("subject : 更新后的新主题",),
            ).fetchall()
        ]
        assert 7 in match_ids
    finally:
        conn.close()


def test_meta_update_trigger_syncs_sender(tmp_path):
    """改 email_metadata.sender 后 → 主表 email_body_fts.sender 列同步。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 8, "主题", sender="old@example.com")
        conn.commit()
        _insert_body(conn, 8, "正文")
        conn.commit()
        conn.execute(
            "UPDATE email_metadata SET sender = ? WHERE internal_id = ?",
            ("new@example.com", 8),
        )
        conn.commit()
        assert _fts_row(conn, 8) == ("主题", "new@example.com")
    finally:
        conn.close()


def test_meta_update_without_body_does_not_create_fts_row(tmp_path):
    """无 body 行时改 subject → WHEN EXISTS body 守卫: 不建 FTS 行。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 9, "只有 metadata 无 body")
        conn.commit()
        conn.execute(
            "UPDATE email_metadata SET subject = ? WHERE internal_id = ?",
            ("改了主题但没有 body", 9),
        )
        conn.commit()
        assert _fts_row(conn, 9) is None
    finally:
        conn.close()
