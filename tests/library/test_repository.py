"""``LibraryRepository``：文件夹分页 / 历史裁剪 / 投影按月分组与 F4 过滤。"""

from __future__ import annotations

import sqlite3

import pytest

from src.library import repository as repo_mod
from src.library.db import LibraryDb
from src.library.repository import LibraryRepository

_SYNC_DDL = """
CREATE TABLE email_metadata (
    internal_id INTEGER PRIMARY KEY, subject TEXT, sender TEXT, sender_name TEXT, date_received TEXT
);
CREATE TABLE email_attachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT, internal_id INTEGER NOT NULL, filename TEXT NOT NULL,
    content_type TEXT, size_bytes INTEGER, is_inline INTEGER DEFAULT 0, local_path TEXT, created_at REAL NOT NULL
);
CREATE TABLE email_attachment_text (
    attachment_id INTEGER PRIMARY KEY, text_content TEXT, extractor TEXT NOT NULL, status TEXT NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0
);
"""


@pytest.fixture()
def repo(tmp_path) -> LibraryRepository:
    return LibraryRepository(LibraryDb(str(tmp_path / "library.db")), str(tmp_path / "sync_store.db"))


def _insert(conn, repo: LibraryRepository, rel: str, *, mount_id: int = 0, status: str = "present", mtime: float = 1.0) -> int:
    parent, _, name = rel.rpartition("/")
    return repo.insert_file(
        conn, mount_id=mount_id, rel_path=rel, rel_key=rel.casefold(), parent_path=parent, filename=name,
        kind="markdown", size_bytes=1, mtime=mtime, source="user", status=status, created_at=1.0, updated_at=1.0,
    )


def test_list_folder_pages_excludes_trashed_and_filters(repo: LibraryRepository) -> None:
    with repo.db.transaction() as conn:
        for i in range(5):
            _insert(conn, repo, f"my-docs/note-{i}.md")
        _insert(conn, repo, "my-docs/gone.md", status="trashed")
        _insert(conn, repo, "my-docs/sub/deep.md")
        _insert(conn, repo, "my-docs/note-9.md", mount_id=4)
    conn = repo.db.connect()
    try:
        rows, total = repo.list_folder(conn, 0, "my-docs", offset=0, limit=2)
        assert total == 5 and [r["filename"] for r in rows] == ["note-0.md", "note-1.md"]
        rows, _ = repo.list_folder(conn, 0, "my-docs", offset=4, limit=2)
        assert [r["filename"] for r in rows] == ["note-4.md"]
        rows, total = repo.list_folder(conn, 0, "my-docs", q="note-3")
        assert total == 1 and rows[0]["rel_path"] == "my-docs/note-3.md"
        assert repo.folder_paths(conn, 0) == {"my-docs", "my-docs/sub"}
        trash, n = repo.list_trash(conn)
        assert n == 1 and trash[0]["filename"] == "gone.md"
    finally:
        conn.close()


def test_prune_history_per_file_and_global_bytes(repo: LibraryRepository, monkeypatch) -> None:
    with repo.db.transaction() as conn:
        fid = _insert(conn, repo, "my-docs/h.md")
        other = _insert(conn, repo, "my-docs/o.md")
        for i in range(55):
            repo.insert_history(conn, file_id=fid, old_hash=None, new_hash=f"h{i}", content_snapshot="x" * 100,
                                changed_by="user", change_note=None, created_at=float(i))
        repo.insert_history(conn, file_id=other, old_hash=None, new_hash="o1", content_snapshot="y" * 100,
                            changed_by="user", change_note=None, created_at=0.5)
        removed = repo.prune_history(conn, fid)
        assert removed == 5
        assert len(repo.list_history(conn, fid, limit=100)) == 50
        newest = repo.list_history(conn, fid, limit=1)[0]
        assert newest["new_hash"] == "h54" and newest["snapshot_bytes"] == 100 and "content_snapshot" not in newest
        # 全库总量上限：50*100 + 100 = 5100 > 4000 → 按 id（插入序）最旧的先裁：
        # other 那条插入最晚，故 11 条全出自 fid。
        monkeypatch.setattr(repo_mod, "HISTORY_MAX_TOTAL_BYTES", 4000)
        removed = repo.prune_history(conn, fid)
        assert removed == 11  # 超额 1100 字节 / 100 = 11 条
        assert len(repo.list_history(conn, fid, limit=100)) == 39
        assert len(repo.list_history(conn, other, limit=10)) == 1


def test_projection_groups_by_month_excludes_inline_and_filters_source(repo: LibraryRepository) -> None:
    conn = sqlite3.connect(repo.sync_store_db_path)
    try:
        conn.executescript(_SYNC_DDL)
        conn.execute("INSERT INTO email_metadata VALUES (1, 'Q3 budget review', 'alice@x.test', 'Alice', '2026-07-03 09:00:00')")
        conn.execute("INSERT INTO email_metadata VALUES (2, 'Weekly sync', 'bob@x.test', 'Bob', '2026-07-20 10:00:00')")
        conn.execute("INSERT INTO email_metadata VALUES (3, 'Old contract', 'carol@x.test', 'Carol', '2026-05-01 10:00:00')")
        conn.execute("INSERT INTO email_metadata (internal_id, subject, sender) VALUES (4, 'No date', 'dave@x.test')")
        rows = [
            (1, "budget.xlsx", "application/x", 10, 0, "/a/budget.xlsx"),
            (1, "logo.png", "image/png", 10, 1, "/a/logo.png"),  # inline → 不进投影
            (2, "notes.pdf", "application/pdf", 10, 0, None),
            (3, "contract.docx", "application/x", 10, 0, "/a/contract.docx"),
            (4, "orphan.txt", "text/plain", 10, 0, "/a/orphan.txt"),
        ]
        for internal_id, name, mime, size, inline, path in rows:
            conn.execute(
                "INSERT INTO email_attachment (internal_id, filename, content_type, size_bytes, is_inline, local_path, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, 1.0)",
                (internal_id, name, mime, size, inline, path),
            )
        conn.execute("INSERT INTO email_attachment_text VALUES (1, 'numbers', 'xlsx', 'extracted', 0)")
        conn.commit()
    finally:
        conn.close()

    months = repo.projection_months()
    assert months == [
        {"month": "unknown", "count": 1},
        {"month": "2026-07", "count": 2},
        {"month": "2026-05", "count": 1},
    ]
    files, total = repo.projection_files("2026-07")
    assert total == 2 and [f["filename"] for f in files] == ["notes.pdf", "budget.xlsx"]
    assert files[1]["subject"] == "Q3 budget review" and files[1]["sender_name"] == "Alice"
    assert files[1]["text_status"] == "extracted" and files[0]["has_file"] == 0
    # F4：过滤同时匹配来源列（主题 / 发件人），不只文件名
    assert repo.projection_files("2026-07", q="budget")[1] == 1
    assert repo.projection_files("2026-07", q="Weekly")[1] == 1
    assert repo.projection_files("2026-07", q="bob@")[1] == 1
    assert repo.projection_files("2026-07", q="Alice")[1] == 1
    assert repo.projection_files("2026-07", q="nothing-here")[1] == 0
    assert repo.projection_files("2026-07", offset=1, limit=1)[0][0]["filename"] == "budget.xlsx"
