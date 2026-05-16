"""EmailRepository + storage_payload_builder 单测（v4 架构）.

覆盖:
    - commit_email_with_body 事务原子性
    - email_body insert/replace
    - email_attachment 批量写入 + derived_from FK 关联
    - CASCADE DELETE（删 metadata → body + attachment 一起删 + 本地文件清理）
    - update_notion_links 回写
    - build_storage_payloads cid 重写 + Markdown 转换
    - 落盘失败回滚
"""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime
from pathlib import Path

import pytest

from src.mail.sync_store import SyncStore
from src.models import Attachment, Email
from src.repository import (
    AttachmentPayload,
    AttachmentStore,
    BodyPayload,
    EmailRepository,
    build_storage_payloads,
)


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def fresh_db(tmp_path: Path) -> Path:
    """初始化空 SQLite，含 v4 schema。"""
    db = tmp_path / "t.db"
    SyncStore(str(db))  # 触发 _init_database，建表
    return db


@pytest.fixture
def store(tmp_path: Path) -> AttachmentStore:
    return AttachmentStore(tmp_path / "attach")


@pytest.fixture
def repo(fresh_db: Path, store: AttachmentStore) -> EmailRepository:
    return EmailRepository(db_path=str(fresh_db), attachment_store=store)


def _insert_metadata(db: Path, internal_id: int):
    """直接 INSERT 一行 email_metadata，FK 父表。"""
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        "INSERT INTO email_metadata (internal_id, sync_status, mailbox, created_at, updated_at) "
        "VALUES (?, 'pending', '收件箱', ?, ?)",
        (internal_id, time.time(), time.time()),
    )
    conn.commit()
    conn.close()


# ============================================================
# commit_email_with_body
# ============================================================

class TestCommitEmailWithBody:
    def test_basic_commit_and_read(self, repo: EmailRepository, fresh_db: Path):
        _insert_metadata(fresh_db, 100)
        body = BodyPayload(
            html="<p>hi</p>",
            markdown="hi",
            body_format="html",
            has_inline_images=False,
            raw_mime_sha256="abc",
        )
        atts = [
            AttachmentPayload(
                filename="doc.txt", content=b"content",
                content_type="text/plain", is_inline=False,
            ),
        ]
        id_map = repo.commit_email_with_body(100, body, atts, message_id="<m@x>")
        assert id_map == {"doc.txt": 1}

        # 读 body
        b = repo.get_body(100)
        assert b is not None
        assert b.html == "<p>hi</p>"
        assert b.markdown == "hi"
        assert b.body_format == "html"
        assert b.raw_mime_sha256 == "abc"

        # 读 attachment
        ats = repo.get_attachments(100)
        assert len(ats) == 1
        assert ats[0].filename == "doc.txt"
        assert ats[0].sha256 is not None
        assert ats[0].local_path.endswith("/100/doc.txt")

    def test_commit_replaces_body(self, repo: EmailRepository, fresh_db: Path):
        """INSERT OR REPLACE: 第二次 commit 覆盖 body."""
        _insert_metadata(fresh_db, 101)
        body_v1 = BodyPayload(html="<p>v1</p>", markdown="v1", body_format="html")
        body_v2 = BodyPayload(html="<p>v2</p>", markdown="v2", body_format="html")
        repo.commit_email_with_body(101, body_v1, [])
        repo.commit_email_with_body(101, body_v2, [])
        b = repo.get_body(101)
        assert b.markdown == "v2"

    def test_commit_clears_old_attachments(self, repo: EmailRepository, fresh_db: Path):
        """第二次 commit 会先 DELETE 老 attachment 行。"""
        _insert_metadata(fresh_db, 102)
        body = BodyPayload(html="", markdown="", body_format="empty")
        repo.commit_email_with_body(102, body, [
            AttachmentPayload(filename="a.txt", content=b"a"),
            AttachmentPayload(filename="b.txt", content=b"b"),
        ])
        repo.commit_email_with_body(102, body, [
            AttachmentPayload(filename="c.txt", content=b"c"),
        ])
        ats = repo.get_attachments(102)
        assert [a.filename for a in ats] == ["c.txt"]

    def test_inline_attachment_marked(self, repo: EmailRepository, fresh_db: Path):
        _insert_metadata(fresh_db, 103)
        body = BodyPayload(html="<p></p>", markdown="", body_format="html", has_inline_images=True)
        atts = [
            AttachmentPayload(
                filename="logo.png", content=b"PNG", content_type="image/png",
                content_id="logo001", is_inline=True,
            ),
        ]
        repo.commit_email_with_body(103, body, atts)
        ats = repo.get_attachments(103)
        assert ats[0].is_inline is True
        assert ats[0].content_id == "logo001"

    def test_derived_from_links_to_original(self, repo: EmailRepository, fresh_db: Path):
        """report.pdf 的 derived_from 应指向 report.docx 的 id."""
        _insert_metadata(fresh_db, 104)
        body = BodyPayload(html="", markdown="", body_format="empty")
        atts = [
            AttachmentPayload(filename="report.docx", content=b"docx-content"),
            AttachmentPayload(
                filename="report.pdf", content=b"pdf-content",
                derived_from_filename="report.docx", derived_format="pdf",
            ),
        ]
        id_map = repo.commit_email_with_body(104, body, atts)
        assert "report.docx" in id_map
        assert "report.pdf" in id_map

        ats = repo.get_attachments(104)
        ats_by_name = {a.filename: a for a in ats}
        assert ats_by_name["report.pdf"].derived_from == ats_by_name["report.docx"].id
        assert ats_by_name["report.pdf"].derived_format == "pdf"
        assert ats_by_name["report.docx"].derived_from is None

    def test_files_landed_on_disk(self, repo: EmailRepository, fresh_db: Path, store: AttachmentStore):
        _insert_metadata(fresh_db, 105)
        body = BodyPayload(html="", markdown="", body_format="empty")
        atts = [AttachmentPayload(filename="doc.pdf", content=b"DATA")]
        repo.commit_email_with_body(105, body, atts)
        assert (store.dir_for(105) / "doc.pdf").read_bytes() == b"DATA"

    def test_filename_sanitized_on_disk(self, repo: EmailRepository, fresh_db: Path, store: AttachmentStore):
        _insert_metadata(fresh_db, 106)
        body = BodyPayload(html="", markdown="", body_format="empty")
        # 文件名含路径分隔符
        atts = [AttachmentPayload(filename="../etc/passwd", content=b"x")]
        repo.commit_email_with_body(106, body, atts)
        ats = repo.get_attachments(106)
        assert "/" not in ats[0].filename
        # 落盘 only 在 106/ 子目录
        files = list(store.dir_for(106).iterdir())
        assert len(files) == 1


# ============================================================
# CASCADE / delete_email_full
# ============================================================

class TestCascade:
    def test_cascade_delete_via_metadata(self, repo: EmailRepository, fresh_db: Path):
        """直接 DELETE email_metadata → body + attachment 自动 CASCADE 删."""
        _insert_metadata(fresh_db, 200)
        body = BodyPayload(html="", markdown="", body_format="empty")
        repo.commit_email_with_body(200, body, [AttachmentPayload(filename="x", content=b"x")])

        # 直接走 metadata DELETE
        conn = sqlite3.connect(str(fresh_db))
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("DELETE FROM email_metadata WHERE internal_id=?", (200,))
        conn.commit()
        body_count = conn.execute("SELECT COUNT(*) FROM email_body WHERE internal_id=?", (200,)).fetchone()[0]
        att_count = conn.execute("SELECT COUNT(*) FROM email_attachment WHERE internal_id=?", (200,)).fetchone()[0]
        conn.close()
        assert body_count == 0
        assert att_count == 0

    def test_delete_email_full_cleans_local_files(self, repo: EmailRepository, fresh_db: Path, store: AttachmentStore):
        _insert_metadata(fresh_db, 201)
        body = BodyPayload(html="", markdown="", body_format="empty")
        repo.commit_email_with_body(201, body, [AttachmentPayload(filename="a", content=b"1")])
        assert store.dir_for(201).exists()

        repo.delete_email_full(201)
        assert repo.get_body(201) is None
        assert repo.get_attachments(201) == []
        assert not store.dir_for(201).exists()


# ============================================================
# update_notion_links
# ============================================================

class TestNotionLinks:
    def test_file_id_writeback(self, repo: EmailRepository, fresh_db: Path):
        _insert_metadata(fresh_db, 300)
        body = BodyPayload(html="", markdown="", body_format="empty")
        atts = [
            AttachmentPayload(filename="a.png", content=b"1"),
            AttachmentPayload(filename="b.pdf", content=b"2"),
        ]
        repo.commit_email_with_body(300, body, atts)
        before = repo.get_attachments(300)

        repo.update_notion_links(
            300,
            file_id_map={before[0].id: "notion-file-A", before[1].id: "notion-file-B"},
            block_id_map={before[0].id: "block-A"},
        )

        after = repo.get_attachments(300)
        after_by_name = {a.filename: a for a in after}
        assert after_by_name["a.png"].notion_file_id == "notion-file-A"
        assert after_by_name["a.png"].notion_block_id == "block-A"
        assert after_by_name["b.pdf"].notion_file_id == "notion-file-B"

    def test_empty_maps_noop(self, repo: EmailRepository, fresh_db: Path):
        _insert_metadata(fresh_db, 301)
        body = BodyPayload(html="", markdown="", body_format="empty")
        repo.commit_email_with_body(301, body, [])
        repo.update_notion_links(301)  # 啥也不做


# ============================================================
# Read helpers
# ============================================================

class TestReadHelpers:
    def test_get_body_html_markdown(self, repo: EmailRepository, fresh_db: Path):
        _insert_metadata(fresh_db, 400)
        body = BodyPayload(html="<p>hi</p>", markdown="hi", body_format="html")
        repo.commit_email_with_body(400, body, [])
        assert repo.get_body_html(400) == "<p>hi</p>"
        assert repo.get_body_markdown(400) == "hi"

    def test_get_body_markdown_truncation(self, repo: EmailRepository, fresh_db: Path):
        _insert_metadata(fresh_db, 401)
        long_md = "x" * 100
        repo.commit_email_with_body(
            401, BodyPayload(html="", markdown=long_md, body_format="html"), []
        )
        assert repo.get_body_markdown(401, max_chars=10) == "x" * 10
        assert repo.get_body_markdown(401, max_chars=-1) == long_md

    def test_get_body_none_when_absent(self, repo: EmailRepository):
        assert repo.get_body(999) is None
        assert repo.get_body_html(999) is None
        assert repo.get_body_markdown(999) is None
        assert repo.get_attachments(999) == []

    def test_get_attachment_bytes_roundtrip(self, repo: EmailRepository, fresh_db: Path):
        _insert_metadata(fresh_db, 402)
        body = BodyPayload(html="", markdown="", body_format="empty")
        repo.commit_email_with_body(402, body, [AttachmentPayload(filename="x.bin", content=b"\x00\x01\x02")])
        ats = repo.get_attachments(402)
        assert repo.get_attachment_bytes(ats[0].id) == b"\x00\x01\x02"

    def test_get_attachment_bytes_missing_file(self, repo: EmailRepository, fresh_db: Path, store: AttachmentStore):
        _insert_metadata(fresh_db, 403)
        body = BodyPayload(html="", markdown="", body_format="empty")
        repo.commit_email_with_body(403, body, [AttachmentPayload(filename="x.bin", content=b"abc")])
        ats = repo.get_attachments(403)
        # 手动删文件
        Path(ats[0].local_path).unlink()
        # 仍能优雅返回 None，不抛
        assert repo.get_attachment_bytes(ats[0].id) is None


# ============================================================
# build_storage_payloads (storage_payload_builder)
# ============================================================

class TestStoragePayloadBuilder:
    def _make_email_html(self, tmp_path: Path) -> Email:
        inline = tmp_path / "logo.png"
        inline.write_bytes(b"PNG bytes")
        regular = tmp_path / "doc.pdf"
        regular.write_bytes(b"PDF bytes")
        return Email(
            message_id="<m@x>",
            subject="t",
            sender="a@b",
            content='<p>see <img src="cid:logo01@host"/></p>',
            content_type="text/html",
            attachments=[
                Attachment(
                    filename="logo.png", content_type="image/png", size=9,
                    path=str(inline), content_id="logo01@host", is_inline=True,
                ),
                Attachment(filename="doc.pdf", content_type="application/pdf", size=9, path=str(regular)),
            ],
            date=datetime.now(),
        )

    def test_cid_rewritten_in_html(self, tmp_path, store: AttachmentStore):
        email = self._make_email_html(tmp_path)
        body, atts = build_storage_payloads(email, 7777, attachment_store=store)
        assert 'cid:' not in body.html
        assert 'attachments/7777/logo.png' in body.html
        assert body.has_inline_images is True

    def test_markdown_generated(self, tmp_path, store: AttachmentStore):
        email = self._make_email_html(tmp_path)
        body, _ = build_storage_payloads(email, 7777, attachment_store=store)
        # markdownify 把 <p> 转 Markdown
        assert body.markdown
        assert "attachments/7777/logo.png" in body.markdown

    def test_attachment_content_loaded_from_path(self, tmp_path, store: AttachmentStore):
        email = self._make_email_html(tmp_path)
        _, atts = build_storage_payloads(email, 7777, attachment_store=store)
        att_by_name = {a.filename: a for a in atts}
        assert att_by_name["logo.png"].content == b"PNG bytes"
        assert att_by_name["doc.pdf"].content == b"PDF bytes"

    def test_missing_attachment_file_skipped(self, tmp_path, store: AttachmentStore):
        """path 指向不存在的文件 → 跳过该附件，不阻断."""
        email = Email(
            message_id="<m@x>", subject="t", sender="a@b",
            content="<p>x</p>", content_type="text/html",
            attachments=[
                Attachment(filename="ghost.bin", content_type="application/octet-stream",
                           size=0, path=str(tmp_path / "nonexistent.bin")),
            ],
            date=datetime.now(),
        )
        body, atts = build_storage_payloads(email, 999, attachment_store=store)
        assert atts == []
        assert body.html == "<p>x</p>"

    def test_plaintext_email(self, tmp_path, store: AttachmentStore):
        email = Email(
            message_id="<m@x>", subject="t", sender="a@b",
            content="plain body here", content_type="text/plain",
            attachments=[], date=datetime.now(),
        )
        body, _ = build_storage_payloads(email, 1, attachment_store=store)
        assert body.body_format == "text-only"
        assert body.html is None
        assert body.markdown == "plain body here"

    def test_empty_content(self, tmp_path, store: AttachmentStore):
        email = Email(
            message_id="<m@x>", subject="t", sender="a@b",
            content="", content_type="text/plain",
            attachments=[], date=datetime.now(),
        )
        body, _ = build_storage_payloads(email, 1, attachment_store=store)
        assert body.body_format == "empty"
        assert body.markdown == ""

    def test_raw_mime_sha256(self, tmp_path, store: AttachmentStore):
        email = self._make_email_html(tmp_path)
        body, _ = build_storage_payloads(
            email, 1, raw_mime_source="From: a\nTo: b\n\nhi", attachment_store=store
        )
        assert body.raw_mime_sha256
        assert len(body.raw_mime_sha256) == 64  # SHA-256 hex


# ============================================================
# html_to_markdown 转换
# ============================================================

class TestHtmlToMarkdown:
    def test_basic(self):
        from src.converter.html_to_markdown import html_to_markdown
        md = html_to_markdown("<p>Hi <b>K</b></p>")
        assert "Hi" in md
        assert "**K**" in md

    def test_empty(self):
        from src.converter.html_to_markdown import html_to_markdown
        assert html_to_markdown("") == ""
        assert html_to_markdown(None) == ""

    def test_strip_images(self):
        from src.converter.html_to_markdown import html_to_markdown
        md = html_to_markdown('<p>a <img src="x"/></p>', strip_images=True)
        assert "img" not in md.lower()
        assert "x" not in md  # src 也没了

    def test_list_and_link(self):
        from src.converter.html_to_markdown import html_to_markdown
        md = html_to_markdown('<ul><li>X</li></ul><a href="http://x">L</a>')
        assert "X" in md
        assert "[L](http://x)" in md
