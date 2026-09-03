"""``library.db`` 开库 / 幂等 DDL / 独立版本梯 / 两张外部内容 FTS 的三 trigger。"""

from __future__ import annotations

import os

from src.library import db as library_db
from src.library.db import LIBRARY_SCHEMA_VERSION, LibraryDb


def _tables(conn) -> set[str]:
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")}


def test_schema_created_idempotently_with_own_version(tmp_path) -> None:
    path = str(tmp_path / "nested" / "library.db")
    db = LibraryDb(path)
    conn = db.connect()
    try:
        names = _tables(conn)
        for t in ("library_meta", "library_mount", "library_file", "library_history", "library_text",
                  "library_fts", "library_fts_trigram"):
            assert t in names, t
        version = conn.execute("SELECT value FROM library_meta WHERE key='schema_version'").fetchone()[0]
        assert int(version) == LIBRARY_SCHEMA_VERSION
        # 唯一键是 (mount_id, rel_key)：同 mount 同 key 拒，不同 mount 同 key 放行
        now = 1.0
        conn.execute(
            "INSERT INTO library_file (mount_id, rel_path, rel_key, parent_path, filename, kind, source, created_at, updated_at)"
            " VALUES (0, 'my-docs/A.md', 'my-docs/a.md', 'my-docs', 'A.md', 'markdown', 'user', ?, ?)",
            (now, now),
        )
        conn.execute(
            "INSERT INTO library_file (mount_id, rel_path, rel_key, parent_path, filename, kind, source, created_at, updated_at)"
            " VALUES (3, 'my-docs/A.md', 'my-docs/a.md', 'my-docs', 'A.md', 'markdown', 'user', ?, ?)",
            (now, now),
        )
        import sqlite3

        try:
            conn.execute(
                "INSERT INTO library_file (mount_id, rel_path, rel_key, parent_path, filename, kind, source, created_at, updated_at)"
                " VALUES (0, 'my-docs/a.md', 'my-docs/a.md', 'my-docs', 'a.md', 'markdown', 'user', ?, ?)",
                (now, now),
            )
            raise AssertionError("同 mount 同 rel_key 应被 UNIQUE 拒")
        except sqlite3.IntegrityError:
            pass
        conn.commit()
    finally:
        conn.close()
    # 重开不炸、不重建
    LibraryDb(path)
    conn = db.connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM library_file").fetchone()[0] == 2
    finally:
        conn.close()


def test_fts_triggers_keep_both_tables_in_sync(tmp_path) -> None:
    db = LibraryDb(str(tmp_path / "library.db"))
    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO library_file (id, mount_id, rel_path, rel_key, parent_path, filename, kind, source, created_at, updated_at)"
            " VALUES (11, 0, 'my-docs/n.md', 'my-docs/n.md', 'my-docs', 'n.md', 'markdown', 'user', 1, 1)"
        )
        conn.execute(
            "INSERT INTO library_text (file_id, filename, text_content, extractor, source_hash, truncated, extracted_at)"
            " VALUES (11, 'n.md', 'redis timeout 研发项目', 'plaintext', 'h1', 0, 1)"
        )
    conn = db.connect()
    try:
        assert conn.execute("SELECT rowid FROM library_fts WHERE library_fts MATCH 'redis'").fetchone()[0] == 11
        assert conn.execute("SELECT rowid FROM library_fts_trigram WHERE library_fts_trigram MATCH '研发项'").fetchone()[0] == 11
    finally:
        conn.close()
    # UPDATE：旧词消失、新词命中（外部内容表必须走 'delete' 命令，否则旧 token 残留）
    with db.transaction() as conn:
        conn.execute("UPDATE library_text SET text_content='kafka lag 项目汇报', source_hash='h2' WHERE file_id=11")
    conn = db.connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM library_fts WHERE library_fts MATCH 'redis'").fetchone()[0] == 0
        assert conn.execute("SELECT rowid FROM library_fts WHERE library_fts MATCH 'kafka'").fetchone()[0] == 11
        assert conn.execute("SELECT COUNT(*) FROM library_fts_trigram WHERE library_fts_trigram MATCH '研发项'").fetchone()[0] == 0
        # trigram MATCH 至少 3 字（2 字是 LIKE 的活，见 repository 的四条纪律）
        assert conn.execute("SELECT rowid FROM library_fts_trigram WHERE library_fts_trigram MATCH '目汇报'").fetchone()[0] == 11
    finally:
        conn.close()
    # DELETE：两表都清
    with db.transaction() as conn:
        conn.execute("DELETE FROM library_text WHERE file_id=11")
    conn = db.connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM library_fts WHERE library_fts MATCH 'kafka'").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM library_fts_trigram WHERE library_fts_trigram MATCH '目汇报'").fetchone()[0] == 0
        # integrity-check 通过 = 外部内容表与内容表一致
        conn.execute("INSERT INTO library_fts(library_fts) VALUES('integrity-check')")
        conn.execute("INSERT INTO library_fts_trigram(library_fts_trigram) VALUES('integrity-check')")
    finally:
        conn.close()


def test_resolve_paths_sit_next_to_sync_store(tmp_path) -> None:
    sync = str(tmp_path / "data" / "sync_store.db")
    assert library_db.library_db_for(sync) == os.path.join(str(tmp_path), "data", "library.db")
    assert library_db.library_root_for(sync) == os.path.join(str(tmp_path), "data", "library")
    assert library_db.resolve_library_db_path(sync) == library_db.library_db_for(sync)
