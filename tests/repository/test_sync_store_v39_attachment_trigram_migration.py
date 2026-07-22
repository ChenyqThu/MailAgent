"""SyncStore v39 migration tests (PR3 — 附件 trigram 并行表)。

v39 = 新增并行 contentful FTS5 表 ``email_attachment_fts_trigram``
(filename, text_content, tokenize='trigram') + 3 个 trigger (insert/update/delete
on email_attachment_text) + 幂等回填。主表 ``email_attachment_fts``
(porter unicode61, 仅 text_content) 不动。

Covers:
- fresh init: 表 + 3 trigger 就位 + db_version 抬到最新 (>=39)
- v38 → v39 upgrade: 老库 (无附件 trigram 表/trigger) 有 extracted/pending/failed
  附件文本 → 升级只回填 extracted 行 (含 filename join); version 抬到最新
- 回填幂等: 二次 init 不重复插、不报错
- insert trigger: 升级后新写 extracted 附件文本自动进 trigram 表 (pending 不进)
- update trigger: status 翻转 failed→extracted 入索引 / extracted→failed 出索引
- delete + cascade: 删 email_metadata → CASCADE → 附件文本删 → trigram FTS 清理
- filename 列可 MATCH (≥3 字) + LIKE (2 字中文)
- 再抽取 (INSERT OR REPLACE) 保持单行, 与主表 unicode FTS parity
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
    "email_attachment_fts_trigram_insert",
    "email_attachment_fts_trigram_update",
    "email_attachment_fts_trigram_delete",
}


def _insert_metadata(conn: sqlite3.Connection, internal_id: int,
                     subject: str = "主题", sender: str = "x@example.com") -> None:
    now = time.time()
    conn.execute(
        """INSERT INTO email_metadata
           (internal_id, subject, sender, mailbox, sync_status, created_at, updated_at)
           VALUES (?, ?, ?, '收件箱', 'synced', ?, ?)""",
        (internal_id, subject, sender, now, now),
    )


def _insert_attachment(conn: sqlite3.Connection, att_id: int, internal_id: int,
                       filename: str) -> None:
    conn.execute(
        """INSERT INTO email_attachment
           (id, internal_id, filename, created_at)
           VALUES (?, ?, ?, ?)""",
        (att_id, internal_id, filename, time.time()),
    )


def _insert_attachment_text(conn: sqlite3.Connection, att_id: int, text: str | None,
                            status: str, extractor: str = "pypdf") -> None:
    now = time.time()
    conn.execute(
        """INSERT OR REPLACE INTO email_attachment_text
           (attachment_id, text_content, text_size_bytes, extractor, status,
            retry_count, truncated, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)""",
        (att_id, text, len((text or "").encode("utf-8")), extractor, status, now, now),
    )


def _simulate_v38(db_path: str) -> None:
    """从最新 schema 模拟回退到 v38: 删附件 trigram 表+3 trigger + 降 version。"""
    conn = sqlite3.connect(db_path)
    try:
        for trig in _TRIGGERS:
            conn.execute(f"DROP TRIGGER IF EXISTS {trig}")
        conn.execute("DROP TABLE IF EXISTS email_attachment_fts_trigram")
        conn.execute("UPDATE sync_state SET value='38' WHERE key='db_version'")
        conn.commit()
    finally:
        conn.close()


def _match_ids(conn: sqlite3.Connection, expr: str) -> list[int]:
    return [
        r[0] for r in conn.execute(
            "SELECT rowid FROM email_attachment_fts_trigram "
            "WHERE email_attachment_fts_trigram MATCH ?",
            (expr,),
        ).fetchall()
    ]


def _count(conn: sqlite3.Connection, table: str) -> int:
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def test_fresh_init_has_attachment_trigram_table_and_triggers(tmp_path):
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    assert "email_attachment_fts_trigram" in _objects(str(db), "table")
    triggers = _objects(str(db), "trigger")
    assert _TRIGGERS <= triggers
    # 主表 + 主表 trigger 仍在 (unicode 附件搜索零回归底座)
    assert "email_attachment_fts" in _objects(str(db), "table")
    assert _db_version(str(db)) == SyncStore.DB_VERSION
    assert SyncStore.DB_VERSION >= 39


def test_v38_to_v39_upgrade_backfills_only_extracted_rows(tmp_path):
    """老 v38 库有 extracted/pending/failed 附件文本 → 升级只回填 extracted 行。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))  # 建完整最新 schema (含附件 trigram 表+trigger)
    _simulate_v38(str(db))
    assert "email_attachment_fts_trigram" not in _objects(str(db), "table")

    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 1)
        _insert_metadata(conn, 2)
        _insert_metadata(conn, 3)
        # extracted → 回填; filename 含 CJK, text 含中英
        _insert_attachment(conn, 10, 1, "固件升级说明.pdf")
        _insert_attachment_text(conn, 10, "firmware 固件升级 release notes", "extracted")
        # pending → 不回填
        _insert_attachment(conn, 20, 2, "pending_report.pdf")
        _insert_attachment_text(conn, 20, None, "pending")
        # failed → 不回填
        _insert_attachment(conn, 30, 3, "broken.docx")
        _insert_attachment_text(conn, 30, None, "failed")
        conn.commit()
    finally:
        conn.close()

    SyncStore(str(db))  # 重 init → 建表+trigger + 回填
    assert "email_attachment_fts_trigram" in _objects(str(db), "table")
    assert _TRIGGERS <= _objects(str(db), "trigger")
    assert _db_version(str(db)) == SyncStore.DB_VERSION

    conn = sqlite3.connect(str(db))
    try:
        assert _count(conn, "email_attachment_fts_trigram") == 1  # 只有 extracted 行
        # text_content ≥3 字 CJK MATCH
        assert _match_ids(conn, "固件升级") == [10]
        # text_content 英文子串 MATCH (≥3 字符)
        assert _match_ids(conn, "irmware") == [10]
        # filename 列回填了 —— ≥3 字 CJK MATCH
        assert _match_ids(conn, "固件升级") == [10]
        # filename 2 字中文 LIKE 兜底
        like_ids = {
            r[0] for r in conn.execute(
                "SELECT rowid FROM email_attachment_fts_trigram WHERE filename LIKE ?",
                ("%固件%",),
            ).fetchall()
        }
        assert like_ids == {10}
    finally:
        conn.close()


def test_backfill_idempotent_double_init(tmp_path):
    """二次 init 不重复回填、不报错 (WHERE NOT EXISTS 防重)。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    _simulate_v38(str(db))
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 1)
        _insert_attachment(conn, 10, 1, "a.pdf")
        _insert_attachment_text(conn, 10, "extracted attachment body", "extracted")
        conn.commit()
    finally:
        conn.close()

    SyncStore(str(db))  # 第一次升级 + 回填
    SyncStore(str(db))  # 第二次 init — 不应重复插 / 不报错

    conn = sqlite3.connect(str(db))
    try:
        assert _count(conn, "email_attachment_fts_trigram") == 1
    finally:
        conn.close()
    assert _db_version(str(db)) == SyncStore.DB_VERSION


def test_insert_trigger_indexes_extracted_only_after_upgrade(tmp_path):
    """升级后新写 email_attachment_text 行 → extracted 进索引, pending 不进。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))  # 已含附件 trigram 表+trigger
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 5)
        _insert_metadata(conn, 6)
        _insert_attachment(conn, 50, 5, "notes.pdf")
        _insert_attachment(conn, 60, 6, "todo.pdf")
        conn.commit()
        # extracted → insert trigger 索引 (含 filename 子查询)
        _insert_attachment_text(conn, 50, "本季度产品评审纪要", "extracted")
        # pending → WHEN 门挡住, 不索引
        _insert_attachment_text(conn, 60, None, "pending")
        conn.commit()
        assert _match_ids(conn, "产品评审") == [50]
        assert _count(conn, "email_attachment_fts_trigram") == 1
        # filename 子查询取到了
        assert _match_ids(conn, "notes") == [50]
    finally:
        conn.close()


def test_update_trigger_status_flip(tmp_path):
    """status 翻转: failed→extracted 入索引, extracted→failed 出索引。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 7)
        _insert_attachment(conn, 70, 7, "report.pdf")
        # 初始 failed → 不索引
        _insert_attachment_text(conn, 70, None, "failed")
        conn.commit()
        assert _count(conn, "email_attachment_fts_trigram") == 0
        # failed → extracted (INSERT OR REPLACE = update 语义, 触发 update trigger)
        _insert_attachment_text(conn, 70, "重新抽取成功的固件升级正文", "extracted")
        conn.commit()
        assert _match_ids(conn, "固件升级") == [70]
        # extracted → failed 再翻回 (清索引)
        conn.execute(
            "UPDATE email_attachment_text SET status='failed', text_content=NULL "
            "WHERE attachment_id=70"
        )
        conn.commit()
        assert _count(conn, "email_attachment_fts_trigram") == 0
    finally:
        conn.close()


def test_cascade_delete_cleans_trigram_fts(tmp_path):
    """删 email_metadata → CASCADE (attachment → attachment_text) → 附件 trigram FTS 清理。

    与主表 email_attachment_fts 同一机制: FK CASCADE 删 email_attachment_text 触发其
    AFTER DELETE trigger (SQLite 3.53.1, recursive_triggers 默认 off 亦触发)。
    """
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 8)
        _insert_attachment(conn, 80, 8, "evidence.pdf")
        _insert_attachment_text(conn, 80, "cascade cleanup 固件升级 sample", "extracted")
        conn.commit()
        assert _count(conn, "email_attachment_fts_trigram") == 1
        assert _count(conn, "email_attachment_fts") == 1  # 主表也进 (parity)

        conn.execute("DELETE FROM email_metadata WHERE internal_id = 8")
        conn.commit()
        # 附件文本行随 CASCADE 删除
        assert _count(conn, "email_attachment_text") == 0
        # trigram + unicode FTS 都被 delete trigger 清理 (parity)
        assert _count(conn, "email_attachment_fts_trigram") == 0
        assert _count(conn, "email_attachment_fts") == 0
    finally:
        conn.close()


def test_reextraction_insert_or_replace_stays_single_row(tmp_path):
    """再抽取 (INSERT OR REPLACE) 保持单行, 与主表 unicode FTS 逐条 parity。"""
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        _insert_metadata(conn, 9)
        _insert_attachment(conn, 90, 9, "spec.pdf")
        _insert_attachment_text(conn, 90, "firmware notes v1 固件升级", "extracted")
        conn.commit()
        assert _count(conn, "email_attachment_fts_trigram") == 1
        assert _count(conn, "email_attachment_fts") == 1
        # 再抽取覆盖 (INSERT OR REPLACE 同 attachment_id)
        _insert_attachment_text(conn, 90, "firmware notes v2 固件升级修订", "extracted")
        conn.commit()
        assert _count(conn, "email_attachment_fts_trigram") == 1  # 不重复/不残留
        assert _count(conn, "email_attachment_fts") == 1
        assert _match_ids(conn, "固件升级") == [90]
    finally:
        conn.close()
