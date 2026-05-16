"""R-02 _handle_thread_relations 切 SQLite SSoT 单测.

覆盖:
    - SQLite 命中 → 用 SQLite 数据
    - SQLite 空 + fallback_to_notion=True → 走 Notion API
    - SQLite 空 + fallback_to_notion=False → 直接 return
    - thread_id 空 → 直接 return
    - SQLite member 缺 page_id → 跳过
    - 当前邮件不是最新 → 更新 latest 的 sub-item
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from typing import Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.mail.sync_store import SyncStore
from src.notion.sync import BEIJING_TZ, NotionSync
from src.repository import AttachmentStore, EmailRepository


@pytest.fixture
def fresh_db(tmp_path: Path) -> Path:
    db = tmp_path / "t.db"
    SyncStore(str(db))
    return db


@pytest.fixture
def attach_store(tmp_path: Path) -> AttachmentStore:
    return AttachmentStore(tmp_path / "attach")


@pytest.fixture
def repo(fresh_db: Path, attach_store: AttachmentStore) -> EmailRepository:
    return EmailRepository(db_path=str(fresh_db), attachment_store=attach_store)


@pytest.fixture
def sync_store(fresh_db: Path) -> SyncStore:
    return SyncStore(str(fresh_db))


def _make_ns(repo: EmailRepository, sync_store: SyncStore) -> NotionSync:
    ns = NotionSync.__new__(NotionSync)
    ns.client = MagicMock()
    ns.html_converter = MagicMock()
    ns.eml_generator = MagicMock()
    ns._email_repo = repo
    ns._sync_store = sync_store
    ns.update_sub_items = AsyncMock()
    ns._find_all_thread_members_with_date = AsyncMock(return_value=[])
    return ns


def _make_email(
    *,
    internal_id: Optional[int] = 100,
    thread_id: str = "<thread-A>",
    message_id: str = "<msg-A>",
    date: Optional[datetime] = None,
):
    from src.models import Email
    if date is None:
        date = datetime(2026, 5, 10, 12, 0, 0, tzinfo=BEIJING_TZ)
    return Email(
        message_id=message_id, subject="subject", sender="a@x.com",
        sender_name="A", to="b@x.com", date=date,
        content="<p>x</p>", content_type="text/html",
        internal_id=internal_id, mailbox="收件箱",
        thread_id=thread_id,
    )


def _insert_thread_metadata(
    db: Path, internal_id: int, *, thread_id: str, page_id: Optional[str],
    date_received: str = "2026-05-01T12:00:00+08:00",
    sync_status: str = "synced",
):
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    now = time.time()
    conn.execute(
        """INSERT INTO email_metadata
           (internal_id, thread_id, sync_status, notion_page_id,
            date_received, mailbox, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '收件箱', ?, ?)""",
        (internal_id, thread_id, sync_status, page_id, date_received, now, now),
    )
    conn.commit()
    conn.close()


class TestThreadRelationsSqliteFirst:
    def test_no_thread_id_returns_early(self, repo, sync_store):
        ns = _make_ns(repo, sync_store)
        email = _make_email(thread_id="")
        asyncio.run(ns._handle_thread_relations("PAGE-CURRENT", email))
        ns.update_sub_items.assert_not_awaited()
        ns._find_all_thread_members_with_date.assert_not_awaited()

    def test_sqlite_hit_uses_sqlite_data(self, repo, sync_store, fresh_db):
        _insert_thread_metadata(fresh_db, 200, thread_id="<T1>", page_id="PAGE-200",
                                date_received="2026-05-01T08:00:00+08:00")
        _insert_thread_metadata(fresh_db, 201, thread_id="<T1>", page_id="PAGE-201",
                                date_received="2026-05-02T08:00:00+08:00")
        ns = _make_ns(repo, sync_store)
        email = _make_email(
            internal_id=202, thread_id="<T1>", message_id="<msg-202>",
            date=datetime(2026, 5, 5, 12, 0, 0, tzinfo=BEIJING_TZ),
        )

        asyncio.run(ns._handle_thread_relations("PAGE-CURRENT", email))

        ns.update_sub_items.assert_awaited_once()
        args, kwargs = ns.update_sub_items.await_args
        all_args = list(args) + list(kwargs.values())
        assert all_args[0] == "PAGE-CURRENT"
        assert set(all_args[1]) == {"PAGE-200", "PAGE-201"}
        ns._find_all_thread_members_with_date.assert_not_awaited()

    def test_sqlite_empty_fallback_to_notion(self, repo, sync_store, monkeypatch):
        from src.config import config as app_config
        monkeypatch.setattr(app_config, "thread_relations_fallback_to_notion", True)
        ns = _make_ns(repo, sync_store)
        ns._find_all_thread_members_with_date = AsyncMock(return_value=[
            {"page_id": "PAGE-NOTION-1", "date": "2026-05-01T08:00:00+08:00"},
        ])
        email = _make_email(
            internal_id=300, thread_id="<T-NO-SQL>", message_id="<msg-300>",
            date=datetime(2026, 5, 5, 12, 0, 0, tzinfo=BEIJING_TZ),
        )

        asyncio.run(ns._handle_thread_relations("PAGE-CURRENT", email))

        ns._find_all_thread_members_with_date.assert_awaited_once()
        ns.update_sub_items.assert_awaited_once()

    def test_sqlite_empty_no_fallback_returns_early(self, repo, sync_store, monkeypatch):
        from src.config import config as app_config
        monkeypatch.setattr(app_config, "thread_relations_fallback_to_notion", False)
        ns = _make_ns(repo, sync_store)
        email = _make_email(internal_id=400, thread_id="<T-NO-FB>", message_id="<msg-400>")

        asyncio.run(ns._handle_thread_relations("PAGE-CURRENT", email))

        ns._find_all_thread_members_with_date.assert_not_awaited()
        ns.update_sub_items.assert_not_awaited()

    def test_sqlite_member_without_page_id_skipped(
        self, repo, sync_store, fresh_db, monkeypatch,
    ):
        from src.config import config as app_config
        monkeypatch.setattr(app_config, "thread_relations_fallback_to_notion", False)
        _insert_thread_metadata(fresh_db, 500, thread_id="<T-SKIP>", page_id=None,
                                date_received="2026-05-01T08:00:00+08:00")
        _insert_thread_metadata(fresh_db, 501, thread_id="<T-SKIP>", page_id="PAGE-501",
                                date_received="2026-05-02T08:00:00+08:00")
        ns = _make_ns(repo, sync_store)
        email = _make_email(
            internal_id=502, thread_id="<T-SKIP>", message_id="<msg-502>",
            date=datetime(2026, 5, 5, 12, 0, 0, tzinfo=BEIJING_TZ),
        )

        asyncio.run(ns._handle_thread_relations("PAGE-CURRENT", email))

        ns.update_sub_items.assert_awaited_once()
        args, kwargs = ns.update_sub_items.await_args
        all_args = list(args) + list(kwargs.values())
        assert all_args[0] == "PAGE-CURRENT"
        assert set(all_args[1]) == {"PAGE-501"}

    def test_current_not_latest_updates_latest_subitems(
        self, repo, sync_store, fresh_db,
    ):
        _insert_thread_metadata(fresh_db, 600, thread_id="<T-OLD>", page_id="PAGE-EARLY",
                                date_received="2026-05-01T08:00:00+08:00")
        _insert_thread_metadata(fresh_db, 601, thread_id="<T-OLD>", page_id="PAGE-LATEST",
                                date_received="2026-05-10T08:00:00+08:00")
        ns = _make_ns(repo, sync_store)
        email = _make_email(
            internal_id=602, thread_id="<T-OLD>", message_id="<msg-602>",
            date=datetime(2026, 5, 5, 12, 0, 0, tzinfo=BEIJING_TZ),
        )

        asyncio.run(ns._handle_thread_relations("PAGE-CURRENT", email))

        ns.update_sub_items.assert_awaited_once()
        args, kwargs = ns.update_sub_items.await_args
        all_args = list(args) + list(kwargs.values())
        assert all_args[0] == "PAGE-LATEST"
        assert set(all_args[1]) == {"PAGE-EARLY", "PAGE-CURRENT"}
