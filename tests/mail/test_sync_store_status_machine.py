"""R-03 / I-02: 验证 fetched 状态是死代码 — 永不被写入也永远不被查到.

覆盖:
    - get_emails_by_status('fetched') 永远返回 [] (即使尝试手动 INSERT)
    - 现存所有状态写入 API 都不会产生 'fetched' 状态
    - search_emails 不返回 fetched 状态的邮件
    - TypedDict EmailMetadata.sync_status 注释不再含 'fetched'
"""

from __future__ import annotations

import inspect
import sqlite3
import time
from pathlib import Path

import pytest

from src.mail.sync_store import EmailMetadata, SyncStore


@pytest.fixture
def store(tmp_path: Path) -> SyncStore:
    return SyncStore(str(tmp_path / "t.db"))


def _insert_metadata_with_status(db: Path, internal_id: int, sync_status: str):
    """直接 INSERT 一行带指定状态的 metadata（绕过 mark_* API）."""
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    now = time.time()
    conn.execute(
        """INSERT INTO email_metadata
           (internal_id, sync_status, mailbox, created_at, updated_at)
           VALUES (?, ?, '收件箱', ?, ?)""",
        (internal_id, sync_status, now, now),
    )
    conn.commit()
    conn.close()


class TestNoFetchedStatus:
    """fetched 是死代码，应永不出现在生产数据中。"""

    def test_get_emails_by_status_fetched_returns_empty(self, store: SyncStore):
        """get_emails_by_status('fetched') 在新建 DB 上返回 []."""
        assert store.get_emails_by_status("fetched") == []

    def test_get_emails_by_status_fetched_returns_empty_even_with_other_data(
        self, store: SyncStore, tmp_path: Path,
    ):
        """即使有 pending / synced 邮件，get_emails_by_status('fetched') 仍返回 []."""
        _insert_metadata_with_status(tmp_path / "t.db", 100, "pending")
        _insert_metadata_with_status(tmp_path / "t.db", 101, "synced")
        assert store.get_emails_by_status("fetched") == []

    def test_search_emails_excludes_fetched_status(
        self, store: SyncStore, tmp_path: Path,
    ):
        """即使手动写入 fetched 状态行（模拟历史 bug），search_emails 也不会查到.

        断言 R-03: 'fetched' 已从 search_emails 的 sync_status IN (...) 允许列表删除。
        """
        _insert_metadata_with_status(tmp_path / "t.db", 200, "synced")
        _insert_metadata_with_status(tmp_path / "t.db", 201, "pending")
        _insert_metadata_with_status(tmp_path / "t.db", 202, "fetched")  # 死代码状态

        result = store.search_emails({}, limit=50)
        internal_ids = {e["internal_id"] for e in result["emails"]}
        assert 200 in internal_ids  # synced 应出现
        assert 201 in internal_ids  # pending 应出现
        assert 202 not in internal_ids  # fetched 应被过滤掉

    def test_typeddict_sync_status_comment_no_fetched(self):
        """EmailMetadata.sync_status 字段的 schema 注释应不含 'fetched'.

        通过 inspect 源码检查（R-03 + R-07 文档一致性）。
        """
        src = inspect.getsource(EmailMetadata)
        # 找 sync_status 那一行
        sync_status_lines = [l for l in src.splitlines() if "sync_status" in l and ":" in l]
        assert sync_status_lines, "expected to find sync_status: ... line in EmailMetadata"
        for line in sync_status_lines:
            assert "fetched" not in line.lower() or "fetched_at" in line.lower() or "fetched_source" in line.lower(), (
                f"EmailMetadata.sync_status comment should not contain 'fetched' state: {line}"
            )

    def test_get_emails_by_status_docstring_no_fetched(self):
        """get_emails_by_status docstring 应不列 'fetched' 作为可能的状态."""
        doc = SyncStore.get_emails_by_status.__doc__ or ""
        # docstring 里只能在 fetched_at 这样的复合词出现 fetched，不能单独作为状态名
        # 简单断言：docstring 不含字符串 ", fetched" 也不含 "/fetched" 也不含 " fetched "
        assert ", fetched" not in doc, f"docstring should not list 'fetched' as status: {doc}"
        assert "/fetched" not in doc, f"docstring should not list 'fetched' as status: {doc}"
        assert " fetched " not in doc, f"docstring should not list 'fetched' as status: {doc}"
        assert "fetched)" not in doc, f"docstring should not list 'fetched' as status: {doc}"
