"""v4 Phase 4 单测：NotionSync.create_email_page_from_sqlite + 辅助方法。

覆盖:
    - _restore_cid_in_body_html：v4 attachments/ 路径 → cid: 还原
    - _materialize_attachments：SQLite 附件 → 临时文件 + Attachment list
    - _build_email_from_sqlite：SQLite 三块数据 → Email 对象
    - _build_file_id_map：上传结果 → {attachment_id: file_upload_id}
    - create_email_page_from_sqlite happy path
    - 缺 body / 缺 metadata → ValueError
    - inline image cid 还原后 _build_image_map 命中
    - 上传后 repo.update_notion_links 被调用

全部 mock NotionClient，不触发真实 Notion API。
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.mail.sync_store import SyncStore
from src.notion.sync import NotionSync
from src.repository import (
    AttachmentPayload,
    AttachmentStore,
    BodyPayload,
    EmailRepository,
)


# ============================================================
# Fixtures
# ============================================================

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


def _insert_metadata(
    db: Path,
    internal_id: int,
    *,
    subject: str = "Hello",
    sender: str = "alice@example.com",
    sender_name: str = "Alice",
    to_addr: str = "bob@example.com",
    cc_addr: str = "",
    thread_id: str = "<thread@example.com>",
    message_id: str = "<msg@example.com>",
    date_received: str = "2026-05-01T12:00:00+08:00",
    mailbox: str = "收件箱",
    is_read: int = 0,
    is_flagged: int = 0,
):
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        """INSERT INTO email_metadata
           (internal_id, message_id, thread_id, subject, sender, sender_name,
            to_addr, cc_addr, date_received, mailbox, is_read, is_flagged,
            sync_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)""",
        (
            internal_id, message_id, thread_id, subject, sender, sender_name,
            to_addr, cc_addr, date_received, mailbox, is_read, is_flagged,
            time.time(), time.time(),
        ),
    )
    conn.commit()
    conn.close()


def _bare_notion_sync(
    repo: 'EmailRepository' = None,
    sync_store: 'SyncStore' = None,
) -> NotionSync:
    """跳过 NotionClient 初始化，避免读 .env；可选注入 repo/sync_store."""
    ns = NotionSync.__new__(NotionSync)
    ns.client = MagicMock()
    ns.html_converter = MagicMock()
    ns.eml_generator = MagicMock()
    ns._email_repo = repo
    ns._sync_store = sync_store
    return ns


# ============================================================
# _restore_cid_in_body_html
# ============================================================

class TestRestoreCidInBodyHtml:
    def test_no_html(self):
        from src.repository import AttachmentRecord
        assert NotionSync._restore_cid_in_body_html(None, []) == ""
        assert NotionSync._restore_cid_in_body_html("", []) == ""

    def test_no_inline_attachments(self):
        html = '<p>hi</p><img src="attachments/123/logo.png">'
        # 没有 content_id → filename_to_cid 为空 → 原样返回
        assert NotionSync._restore_cid_in_body_html(html, []) == html

    def test_restores_cid(self):
        from src.repository import AttachmentRecord

        att = AttachmentRecord(
            id=1, internal_id=123, filename="logo.png",
            content_type="image/png", size_bytes=100,
            is_inline=True, content_id="logo01@host",
            local_path="data/attachments/123/logo.png", sha256="abc",
            derived_from=None, derived_format=None,
            notion_file_id=None, notion_block_id=None,
            created_at=time.time(),
        )
        html = '<p>x</p><img src="attachments/123/logo.png" alt="logo">'
        result = NotionSync._restore_cid_in_body_html(html, [att])
        assert 'src="cid:logo01@host"' in result
        assert "attachments/123/logo.png" not in result

    def test_skips_unknown_filename(self):
        """body_html 引用了 attachments/ 但 SQLite 里没这附件 → 原样保留。"""
        from src.repository import AttachmentRecord
        att = AttachmentRecord(
            id=1, internal_id=123, filename="other.png",
            content_type="image/png", size_bytes=100,
            is_inline=True, content_id="other@host",
            local_path="data/attachments/123/other.png", sha256="abc",
            derived_from=None, derived_format=None,
            notion_file_id=None, notion_block_id=None,
            created_at=time.time(),
        )
        html = '<img src="attachments/123/missing.png">'
        # missing.png 不在 filename_to_cid，保留原样
        assert NotionSync._restore_cid_in_body_html(html, [att]) == html

    def test_handles_href_too(self):
        from src.repository import AttachmentRecord
        att = AttachmentRecord(
            id=1, internal_id=123, filename="doc.pdf",
            content_type="application/pdf", size_bytes=100,
            is_inline=True, content_id="doc@host",
            local_path="data/attachments/123/doc.pdf", sha256="abc",
            derived_from=None, derived_format=None,
            notion_file_id=None, notion_block_id=None,
            created_at=time.time(),
        )
        html = '<a href="attachments/123/doc.pdf">link</a>'
        result = NotionSync._restore_cid_in_body_html(html, [att])
        assert 'href="cid:doc@host"' in result


# ============================================================
# _materialize_attachments
# ============================================================

class TestMaterializeAttachments:
    def test_writes_files(
        self, repo: EmailRepository, fresh_db: Path, tmp_path: Path
    ):
        _insert_metadata(fresh_db, 100)
        body = BodyPayload(html="<p>x</p>", markdown="x", body_format="html")
        repo.commit_email_with_body(
            100, body,
            [AttachmentPayload(
                filename="report.pdf", content=b"PDF_BYTES",
                content_type="application/pdf",
            )],
            message_id="<m1@x>",
        )
        att_records = repo.get_attachments(100)

        work_dir = tmp_path / "work"
        work_dir.mkdir()
        materialized, missing = NotionSync._materialize_attachments(
            att_records, work_dir, repo
        )
        assert len(materialized) == 1
        assert not missing
        assert Path(materialized[0].path).read_bytes() == b"PDF_BYTES"
        assert materialized[0].filename == "report.pdf"

    def test_skips_missing_file(
        self, repo: EmailRepository, fresh_db: Path, tmp_path: Path
    ):
        """email_attachment 行存在但本地文件被删 → 在 missing 列表，不抛异常。"""
        _insert_metadata(fresh_db, 100)
        body = BodyPayload(html="<p>x</p>", markdown="x", body_format="html")
        repo.commit_email_with_body(
            100, body,
            [AttachmentPayload(filename="a.txt", content=b"DATA")],
        )
        # 删掉本地文件
        att_records = repo.get_attachments(100)
        Path.cwd().joinpath(att_records[0].local_path).unlink()

        work_dir = tmp_path / "work"
        work_dir.mkdir()
        materialized, missing = NotionSync._materialize_attachments(
            att_records, work_dir, repo
        )
        assert materialized == []
        assert missing == [att_records[0].id]


# ============================================================
# _build_email_from_sqlite
# ============================================================

class TestBuildEmailFromSqlite:
    def test_basic_email(
        self,
        repo: EmailRepository,
        sync_store: SyncStore,
        fresh_db: Path,
        tmp_path: Path,
    ):
        _insert_metadata(
            fresh_db, 100,
            subject="Test Subject",
            sender="alice@example.com",
            sender_name="Alice",
            to_addr="bob@example.com",
            cc_addr="cc@example.com",
            thread_id="<t1@x>",
            message_id="<m1@x>",
            date_received="2026-05-01T10:30:00+08:00",
            mailbox="收件箱",
        )
        body = BodyPayload(
            html="<p>body</p>", markdown="body", body_format="html",
        )
        repo.commit_email_with_body(100, body, [], message_id="<m1@x>")

        body_record = repo.get_body(100)
        metadata = sync_store.get(100)
        att_records = repo.get_attachments(100)

        work_dir = tmp_path / "work"
        work_dir.mkdir()
        email = NotionSync._build_email_from_sqlite(
            100, body_record, metadata, att_records, work_dir, repo
        )
        assert email.subject == "Test Subject"
        assert email.sender == "alice@example.com"
        assert email.sender_name == "Alice"
        assert email.to == "bob@example.com"
        assert email.cc == "cc@example.com"
        assert email.thread_id == "<t1@x>"
        assert email.mailbox == "收件箱"
        assert email.content == "<p>body</p>"
        assert email.content_type == "text/html"
        assert email.internal_id == 100
        assert email.message_id == "<m1@x>"
        assert email.date.year == 2026

    def test_text_only(
        self,
        repo: EmailRepository,
        sync_store: SyncStore,
        fresh_db: Path,
        tmp_path: Path,
    ):
        _insert_metadata(fresh_db, 101, message_id="<m2@x>")
        body = BodyPayload(
            html=None, markdown="plain text", body_format="text-only",
        )
        repo.commit_email_with_body(101, body, [], message_id="<m2@x>")

        body_record = repo.get_body(101)
        metadata = sync_store.get(101)
        work_dir = tmp_path / "work"
        work_dir.mkdir()
        email = NotionSync._build_email_from_sqlite(
            101, body_record, metadata, [], work_dir, repo
        )
        assert email.content_type == "text/plain"
        assert email.content == "plain text"

    def test_cid_restored_in_content(
        self,
        repo: EmailRepository,
        sync_store: SyncStore,
        fresh_db: Path,
        tmp_path: Path,
    ):
        _insert_metadata(fresh_db, 102, message_id="<m3@x>")
        body = BodyPayload(
            html='<p>x</p><img src="attachments/102/logo.png">',
            markdown="x",
            body_format="html",
        )
        repo.commit_email_with_body(
            102, body,
            [AttachmentPayload(
                filename="logo.png", content=b"PNG",
                content_type="image/png", content_id="logo@host",
                is_inline=True,
            )],
            message_id="<m3@x>",
        )

        body_record = repo.get_body(102)
        metadata = sync_store.get(102)
        att_records = repo.get_attachments(102)

        work_dir = tmp_path / "work"
        work_dir.mkdir()
        email = NotionSync._build_email_from_sqlite(
            102, body_record, metadata, att_records, work_dir, repo
        )
        # cid 已还原，让 _build_image_map 能匹配
        assert 'src="cid:logo@host"' in email.content
        assert "attachments/102/logo.png" not in email.content

    def test_raises_when_no_message_id(
        self,
        repo: EmailRepository,
        sync_store: SyncStore,
        fresh_db: Path,
        tmp_path: Path,
    ):
        _insert_metadata(fresh_db, 103, message_id="")
        # 强制清掉
        conn = sqlite3.connect(str(fresh_db))
        conn.execute("UPDATE email_metadata SET message_id = NULL WHERE internal_id = 103")
        conn.commit()
        conn.close()
        body = BodyPayload(html="<p>x</p>", markdown="x", body_format="html")
        repo.commit_email_with_body(103, body, [], message_id=None)

        body_record = repo.get_body(103)
        metadata = sync_store.get(103)
        work_dir = tmp_path / "work"
        work_dir.mkdir()
        with pytest.raises(ValueError, match="Missing message_id"):
            NotionSync._build_email_from_sqlite(
                103, body_record, metadata, [], work_dir, repo
            )


# ============================================================
# _build_file_id_map
# ============================================================

class TestBuildFileIdMap:
    def test_maps_by_filename(self):
        from src.repository import AttachmentRecord
        atts = [
            AttachmentRecord(
                id=10, internal_id=1, filename="a.pdf",
                content_type="application/pdf", size_bytes=100,
                is_inline=False, content_id=None,
                local_path="x", sha256="x",
                derived_from=None, derived_format=None,
                notion_file_id=None, notion_block_id=None,
                created_at=time.time(),
            ),
            AttachmentRecord(
                id=11, internal_id=1, filename="b.png",
                content_type="image/png", size_bytes=100,
                is_inline=True, content_id="b@host",
                local_path="x", sha256="x",
                derived_from=None, derived_format=None,
                notion_file_id=None, notion_block_id=None,
                created_at=time.time(),
            ),
        ]
        uploaded = [
            {"filename": "a.pdf", "file_upload_id": "UID-A", "content_type": "application/pdf"},
            {"filename": "b.png", "file_upload_id": "UID-B", "content_type": "image/png"},
            {"filename": "ghost.txt", "file_upload_id": "UID-G"},  # 不在 atts 里 → 跳过
        ]
        m = NotionSync._build_file_id_map(uploaded, atts)
        assert m == {10: "UID-A", 11: "UID-B"}

    def test_skips_missing_upload_id(self):
        from src.repository import AttachmentRecord
        atts = [
            AttachmentRecord(
                id=10, internal_id=1, filename="a.pdf",
                content_type="application/pdf", size_bytes=100,
                is_inline=False, content_id=None,
                local_path="x", sha256="x",
                derived_from=None, derived_format=None,
                notion_file_id=None, notion_block_id=None,
                created_at=time.time(),
            ),
        ]
        uploaded = [{"filename": "a.pdf"}]  # 没 file_upload_id
        assert NotionSync._build_file_id_map(uploaded, atts) == {}


# ============================================================
# create_email_page_from_sqlite  end-to-end
# ============================================================

class TestCreateEmailPageFromSqlite:
    """end-to-end 测试，mock NotionClient 的网络方法。"""

    @pytest.fixture
    def mocked_ns(self, repo: EmailRepository, sync_store: SyncStore) -> NotionSync:
        ns = _bare_notion_sync(repo=repo, sync_store=sync_store)
        # 默认：没有重复
        ns.client.check_page_exists = AsyncMock(return_value=False)
        ns.client.query_database = AsyncMock(return_value=[])
        ns.client.upload_file = AsyncMock(return_value="UPLOAD-ID")
        ns.client.create_page = AsyncMock(return_value={"id": "PAGE-NEW"})
        ns.client.append_block_children = AsyncMock()
        # html_converter.convert 返回最小化 block list
        ns.html_converter.convert = MagicMock(return_value=[
            {"object": "block", "type": "paragraph",
             "paragraph": {"rich_text": [{"text": {"content": "body"}}]}}
        ])
        return ns

    def test_happy_path_creates_page_and_writes_back(
        self,
        mocked_ns: NotionSync,
        repo: EmailRepository,
        sync_store: SyncStore,
        fresh_db: Path,
    ):
        _insert_metadata(fresh_db, 200, message_id="<m200@x>")
        body = BodyPayload(html="<p>hi</p>", markdown="hi", body_format="html")
        repo.commit_email_with_body(
            200, body,
            [AttachmentPayload(
                filename="report.pdf", content=b"PDF",
                content_type="application/pdf",
            )],
            message_id="<m200@x>",
        )

        async def _():
            result = await mocked_ns.create_email_page_from_sqlite(
                200, repo=repo, sync_store=sync_store,
            )
            assert result.page_id == "PAGE-NEW"
            assert result.action == "created"
            assert result.existing_page_id is None
            assert result.archived_page_id is None
            # upload_file 应该被调（report.pdf + .eml = 2 次）
            assert mocked_ns.client.upload_file.await_count >= 1
            # create_page 应该被调一次
            mocked_ns.client.create_page.assert_awaited()

        asyncio.run(_())
        # P4-03: notion_file_id 已回写
        att_records = repo.get_attachments(200)
        assert any(a.notion_file_id == "UPLOAD-ID" for a in att_records)

    def test_raises_when_body_missing(
        self,
        mocked_ns: NotionSync,
        repo: EmailRepository,
        sync_store: SyncStore,
        fresh_db: Path,
    ):
        _insert_metadata(fresh_db, 201)

        async def _():
            with pytest.raises(ValueError, match="No body in SQLite"):
                await mocked_ns.create_email_page_from_sqlite(
                    201, repo=repo, sync_store=sync_store,
                )

        asyncio.run(_())

    def test_raises_when_metadata_missing(
        self,
        mocked_ns: NotionSync,
        repo: EmailRepository,
        sync_store: SyncStore,
        fresh_db: Path,
    ):
        # FK 约束要求先 insert metadata 才能 commit body → 再删掉
        _insert_metadata(fresh_db, 202, message_id="<m202@x>")
        body = BodyPayload(html="<p>x</p>", markdown="x", body_format="html")
        repo.commit_email_with_body(202, body, [], message_id="<m202@x>")

        # 删 metadata（关 FK 避免 CASCADE 把 body 带走）
        conn = sqlite3.connect(str(fresh_db))
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("DELETE FROM email_metadata WHERE internal_id = 202")
        conn.commit()
        conn.close()

        async def _():
            with pytest.raises(ValueError, match="No metadata in SQLite"):
                await mocked_ns.create_email_page_from_sqlite(
                    202, repo=repo, sync_store=sync_store,
                )

        asyncio.run(_())

    def test_returns_existing_page_when_duplicate(
        self,
        mocked_ns: NotionSync,
        repo: EmailRepository,
        sync_store: SyncStore,
        fresh_db: Path,
    ):
        _insert_metadata(fresh_db, 203, message_id="<m203@x>")
        body = BodyPayload(html="<p>x</p>", markdown="x", body_format="html")
        repo.commit_email_with_body(203, body, [], message_id="<m203@x>")

        mocked_ns.client.check_page_exists = AsyncMock(return_value=True)
        mocked_ns.client.query_database = AsyncMock(return_value=[{"id": "EXISTING"}])

        async def _():
            result = await mocked_ns.create_email_page_from_sqlite(
                203, repo=repo, sync_store=sync_store,
            )
            assert result.page_id == "EXISTING"
            assert result.action == "skipped"  # PR-2 critic round 2: dup-skipped
            assert result.existing_page_id == "EXISTING"
            assert result.archived_page_id is None
            mocked_ns.client.create_page.assert_not_awaited()

        asyncio.run(_())

    def test_duplicate_with_null_local_page_id_is_skipped(
        self,
        mocked_ns: NotionSync,
        repo: EmailRepository,
        sync_store: SyncStore,
        fresh_db: Path,
    ):
        """PR-2 critic round 2: dup-skipped 必须返回 action='skipped' 即使 local notion_page_id=NULL。

        过去 CLI 推断从 ``(replace, meta.notion_page_id, new_page_id)`` 派生 action,
        当 SQLite 里 notion_page_id 为 None 但 Notion 侧 dup 命中时, 会误把
        ``existing_page_id`` 标成 ``created``。结构化 result 把这个 case 收敛。
        """
        # 注意: 不调 update_notion_links, sync_store.get(203) 的 notion_page_id 仍是 NULL
        _insert_metadata(fresh_db, 205, message_id="<m205@x>")
        body = BodyPayload(html="<p>x</p>", markdown="x", body_format="html")
        repo.commit_email_with_body(205, body, [], message_id="<m205@x>")

        # Notion 侧已有这封 (老 page=EXISTING), 但本地 sync_store 没回写过
        mocked_ns.client.check_page_exists = AsyncMock(return_value=True)
        mocked_ns.client.query_database = AsyncMock(
            return_value=[{"id": "EXISTING-ON-NOTION-NOT-LOCAL"}]
        )

        async def _():
            result = await mocked_ns.create_email_page_from_sqlite(
                205, repo=repo, sync_store=sync_store, replace_existing=False,
            )
            assert result.action == "skipped"
            assert result.page_id == "EXISTING-ON-NOTION-NOT-LOCAL"
            assert result.existing_page_id == "EXISTING-ON-NOTION-NOT-LOCAL"
            assert result.archived_page_id is None
            mocked_ns.client.create_page.assert_not_awaited()

        asyncio.run(_())

    def test_replace_existing_archives_old_page(
        self,
        mocked_ns: NotionSync,
        repo: EmailRepository,
        sync_store: SyncStore,
        fresh_db: Path,
    ):
        _insert_metadata(fresh_db, 204, message_id="<m204@x>")
        body = BodyPayload(html="<p>x</p>", markdown="x", body_format="html")
        repo.commit_email_with_body(204, body, [], message_id="<m204@x>")

        mocked_ns.client.check_page_exists = AsyncMock(return_value=True)
        mocked_ns.client.query_database = AsyncMock(return_value=[{"id": "OLD"}])
        nested = MagicMock()
        nested.pages.update = AsyncMock()
        mocked_ns.client.client = nested

        async def _():
            result = await mocked_ns.create_email_page_from_sqlite(
                204, repo=repo, sync_store=sync_store,
                replace_existing=True,
            )
            assert result.page_id == "PAGE-NEW"
            assert result.action == "replaced"  # PR-2 critic round 2
            assert result.existing_page_id == "OLD"
            assert result.archived_page_id == "OLD"
            nested.pages.update.assert_any_await(page_id="OLD", archived=True)
            mocked_ns.client.create_page.assert_awaited()

        asyncio.run(_())


# ============================================================
# create_email_page_v2 wrapper 路由 (P4-04)
# ============================================================

class TestV2WrapperRouting:
    """开关控制：NOTION_READ_FROM_SQLITE 决定走 from-sqlite 还是老路径。"""

    def test_disabled_by_default(
        self, repo: EmailRepository, sync_store: SyncStore, fresh_db: Path,
        monkeypatch,
    ):
        """notion_read_from_sqlite=False → 不会走 SQLite 路径，即使 SQLite 有 body。

        I-01 fix: 不依赖 .env 真值 — 用户切 NOTION_READ_FROM_SQLITE=true 后该测试
        必失败。这里显式 monkeypatch 设回 False。
        """
        from src.config import config as app_config
        monkeypatch.setattr(app_config, "notion_read_from_sqlite", False)

        _insert_metadata(fresh_db, 300, message_id="<m300@x>")
        body = BodyPayload(html="<p>x</p>", markdown="x", body_format="html")
        repo.commit_email_with_body(300, body, [], message_id="<m300@x>")

        ns = _bare_notion_sync(repo=repo, sync_store=sync_store)

        from_sqlite_mock = AsyncMock(return_value="FROM-SQLITE-PAGE")
        monkeypatch.setattr(
            NotionSync, "create_email_page_from_sqlite", from_sqlite_mock
        )
        ns.client.check_page_exists = AsyncMock(return_value=True)
        ns.client.query_database = AsyncMock(return_value=[{"id": "LEGACY-PAGE"}])

        from src.models import Email
        from datetime import datetime
        email = Email(
            message_id="<m300@x>", subject="x", sender="a@x.com",
            sender_name="A", to="b@x.com", date=datetime.now(),
            content="<p>x</p>", content_type="text/html",
            internal_id=300, mailbox="收件箱",
        )

        async def _():
            page_id = await ns.create_email_page_v2(email)
            from_sqlite_mock.assert_not_awaited()
            assert page_id == "LEGACY-PAGE"

        asyncio.run(_())

    def test_enabled_with_body_routes_to_sqlite(
        self, repo: EmailRepository, sync_store: SyncStore, fresh_db: Path,
        monkeypatch,
    ):
        """NOTION_READ_FROM_SQLITE=true + body 存在 → 走 SQLite 路径。"""
        from src.notion.sync import CreateEmailFromSqliteResult

        _insert_metadata(fresh_db, 301, message_id="<m301@x>")
        body = BodyPayload(html="<p>x</p>", markdown="x", body_format="html")
        repo.commit_email_with_body(301, body, [], message_id="<m301@x>")

        ns = _bare_notion_sync(repo=repo, sync_store=sync_store)

        from_sqlite_mock = AsyncMock(return_value=CreateEmailFromSqliteResult(
            page_id="FROM-SQLITE-PAGE", action="created",
        ))
        monkeypatch.setattr(
            NotionSync, "create_email_page_from_sqlite", from_sqlite_mock
        )

        from src.config import config as app_config
        monkeypatch.setattr(app_config, "notion_read_from_sqlite", True)

        from src.models import Email
        from datetime import datetime
        email = Email(
            message_id="<m301@x>", subject="x", sender="a@x.com",
            sender_name="A", to="b@x.com", date=datetime.now(),
            content="<p>x</p>", content_type="text/html",
            internal_id=301, mailbox="收件箱",
        )

        async def _():
            page_id = await ns.create_email_page_v2(email)
            from_sqlite_mock.assert_awaited_once()
            assert page_id == "FROM-SQLITE-PAGE"

        asyncio.run(_())

    def test_enabled_but_no_body_falls_back_to_legacy(
        self, repo: EmailRepository, sync_store: SyncStore, fresh_db: Path,
        monkeypatch,
    ):
        """开关开，但 SQLite 无 body → fallback 老路径。"""
        ns = _bare_notion_sync(repo=repo, sync_store=sync_store)

        from_sqlite_mock = AsyncMock(return_value="SHOULD-NOT-BE-CALLED")
        monkeypatch.setattr(
            NotionSync, "create_email_page_from_sqlite", from_sqlite_mock
        )
        ns.client.check_page_exists = AsyncMock(return_value=True)
        ns.client.query_database = AsyncMock(return_value=[{"id": "LEGACY-PAGE"}])

        from src.config import config as app_config
        monkeypatch.setattr(app_config, "notion_read_from_sqlite", True)

        from src.models import Email
        from datetime import datetime
        email = Email(
            message_id="<m302@x>", subject="x", sender="a@x.com",
            sender_name="A", to="b@x.com", date=datetime.now(),
            content="<p>x</p>", content_type="text/html",
            internal_id=302, mailbox="收件箱",
        )

        async def _():
            page_id = await ns.create_email_page_v2(email)
            from_sqlite_mock.assert_not_awaited()
            assert page_id == "LEGACY-PAGE"

        asyncio.run(_())
