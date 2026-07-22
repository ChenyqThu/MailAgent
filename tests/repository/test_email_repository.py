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
    EmailFull,
    EmailMetadataRecord,
    EmailRepository,
    EmailSearchHit,
    ThreadMember,
    build_storage_payloads,
    smart_query_transform,
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
        conn = sqlite3.connect(str(fresh_db))
        try:
            snippet = conn.execute(
                "SELECT snippet FROM email_metadata WHERE internal_id = 100"
            ).fetchone()[0]
        finally:
            conn.close()
        assert snippet == "hi"

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
        conn = sqlite3.connect(str(fresh_db))
        try:
            snippet = conn.execute(
                "SELECT snippet FROM email_metadata WHERE internal_id = 101"
            ).fetchone()[0]
        finally:
            conn.close()
        assert snippet == "v2"

    def test_commit_truncates_snippet_to_100_unicode_characters(
        self, repo: EmailRepository, fresh_db: Path
    ):
        _insert_metadata(fresh_db, 107)
        markdown = "邮件正文🙂" * 30
        repo.commit_email_with_body(
            107,
            BodyPayload(html="", markdown=markdown, body_format="text"),
            [],
        )
        conn = sqlite3.connect(str(fresh_db))
        try:
            snippet = conn.execute(
                "SELECT snippet FROM email_metadata WHERE internal_id = 107"
            ).fetchone()[0]
        finally:
            conn.close()
        assert snippet == markdown[:100]

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


# ============================================================
# search_email_bodies (Phase 3: FTS5)
# ============================================================

def _insert_metadata_full(
    db: Path,
    internal_id: int,
    *,
    subject: str = "",
    sender: str = "",
    mailbox: str = "收件箱",
    date_received: str = "2026-05-15T10:00:00+08:00",
    notion_page_id: Optional[str] = None,
):
    """直接 INSERT 一行 email_metadata，带 subject/sender/date 让 FTS trigger 能取值。"""
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        """INSERT INTO email_metadata
           (internal_id, sync_status, mailbox, subject, sender,
            date_received, notion_page_id, created_at, updated_at)
           VALUES (?, 'synced', ?, ?, ?, ?, ?, ?, ?)""",
        (internal_id, mailbox, subject, sender, date_received,
         notion_page_id, time.time(), time.time()),
    )
    conn.commit()
    conn.close()


# Optional 已在文件顶部用过，重新 import 以防被 reformat
from typing import Optional  # noqa: E402


class TestSearchEmailBodies:
    def _seed(self, repo: EmailRepository, fresh_db: Path):
        """种 3 封：
        100 收件箱 'Project meeting tomorrow' alice  → 含 'meeting'
        200 发件箱 'Re: Project status update' bob   → 含 'project'
        300 收件箱 '产品周会日程同步' carol            → 中文
        """
        _insert_metadata_full(
            fresh_db, 100,
            subject="Project meeting tomorrow",
            sender="alice@example.com",
            mailbox="收件箱",
            date_received="2026-05-01T10:00:00+08:00",
            notion_page_id="page-100",
        )
        repo.commit_email_with_body(
            100,
            BodyPayload(html="<p>x</p>",
                        markdown="Let's discuss the meeting agenda tomorrow at 3pm.",
                        body_format="html"),
            [],
        )
        _insert_metadata_full(
            fresh_db, 200,
            subject="Re: Project status update",
            sender="bob@example.com",
            mailbox="发件箱",
            date_received="2026-05-10T10:00:00+08:00",
        )
        repo.commit_email_with_body(
            200,
            BodyPayload(html="<p>x</p>",
                        markdown="The project is on track. Will share details next Monday.",
                        body_format="html"),
            [],
        )
        _insert_metadata_full(
            fresh_db, 300,
            subject="产品周会日程同步",
            sender="carol@example.com",
            mailbox="收件箱",
            date_received="2026-05-15T10:00:00+08:00",
        )
        repo.commit_email_with_body(
            300,
            BodyPayload(html="<p>x</p>",
                        markdown="本周产品评审定在周三下午，请提前同步进度。",
                        body_format="html"),
            [],
        )

    def test_basic_hit(self, repo: EmailRepository, fresh_db: Path):
        self._seed(repo, fresh_db)
        hits = repo.search_email_bodies("meeting", limit=10)
        # 100 的 subject + body 都含 'meeting'，应该是最高分
        assert len(hits) >= 1
        assert hits[0].internal_id == 100
        assert "meeting" in hits[0].snippet.lower()
        # snippet 应该带高亮 marker
        assert "<mark>" in hits[0].snippet
        assert hits[0].subject == "Project meeting tomorrow"
        assert hits[0].sender == "alice@example.com"

    def test_hit_returns_dataclass(self, repo: EmailRepository, fresh_db: Path):
        self._seed(repo, fresh_db)
        hits = repo.search_email_bodies("project", limit=10)
        assert all(isinstance(h, EmailSearchHit) for h in hits)

    def test_empty_query_returns_empty(self, repo: EmailRepository, fresh_db: Path):
        self._seed(repo, fresh_db)
        assert repo.search_email_bodies("") == []
        assert repo.search_email_bodies("   ") == []

    def test_zero_limit_returns_empty(self, repo: EmailRepository, fresh_db: Path):
        self._seed(repo, fresh_db)
        assert repo.search_email_bodies("meeting", limit=0) == []
        assert repo.search_email_bodies("meeting", limit=-1) == []

    def test_no_hit_returns_empty(self, repo: EmailRepository, fresh_db: Path):
        self._seed(repo, fresh_db)
        assert repo.search_email_bodies("zzzzzz-no-match-token-here", limit=10) == []

    def test_invalid_syntax_returns_empty_not_raises(self, repo: EmailRepository, fresh_db: Path):
        """FTS5 语法错误（未闭合引号 / 孤立操作符）应被吞掉返回 []，记 warning."""
        self._seed(repo, fresh_db)
        # 未闭合的双引号
        assert repo.search_email_bodies('"unbalanced', limit=10) == []

    def test_mailbox_filter(self, repo: EmailRepository, fresh_db: Path):
        """mailbox 过滤：搜 project 时只看发件箱，应只命中 200."""
        self._seed(repo, fresh_db)
        hits = repo.search_email_bodies("project", limit=10, mailbox="发件箱")
        assert all(h.mailbox == "发件箱" for h in hits)
        assert any(h.internal_id == 200 for h in hits)
        # 收件箱模式不应包含 200
        hits_inbox = repo.search_email_bodies("project", limit=10, mailbox="收件箱")
        assert all(h.internal_id != 200 for h in hits_inbox)

    def test_since_date_filter(self, repo: EmailRepository, fresh_db: Path):
        """since_date 过滤：5/5 之后的，100 (5/1) 应被排除."""
        self._seed(repo, fresh_db)
        hits = repo.search_email_bodies("project", limit=10, since_date="2026-05-05")
        ids = [h.internal_id for h in hits]
        assert 100 not in ids  # 5/1 的被排除
        # 200 (5/10) 应在结果里
        assert 200 in ids

    def test_until_date_filter(self, repo: EmailRepository, fresh_db: Path):
        """until_date 过滤：5/5 之前的，200 (5/10) 应被排除."""
        self._seed(repo, fresh_db)
        hits = repo.search_email_bodies("project", limit=10, until_date="2026-05-05")
        ids = [h.internal_id for h in hits]
        assert 200 not in ids
        assert 100 in ids

    def test_chinese_search_unicode61_prefix(self, repo: EmailRepository, fresh_db: Path):
        """SQLite 自带的 unicode61 tokenizer 在没有 ICU 的情况下把连续 CJK 当**一个**
        大 token，因此精确搜 '产品' 命不中（token 是 '产品周会日程同步' 整串）。
        前缀匹配 '产品*' 能命中。文档里需提示中文用 '*' 后缀做前缀匹配，
        或未来 Phase 4+ 引入 jieba/signal-tokenizer 提质量。
        """
        self._seed(repo, fresh_db)
        # 不带 '*' 命不中（已验证 SQLite 行为）
        assert repo.search_email_bodies("产品", limit=10) == []
        # 带 '*' 前缀匹配能命中
        hits = repo.search_email_bodies("产品*", limit=10)
        ids = [h.internal_id for h in hits]
        assert 300 in ids

    def test_limit_caps_result_count(self, repo: EmailRepository, fresh_db: Path):
        """limit 严格生效."""
        self._seed(repo, fresh_db)
        hits = repo.search_email_bodies("project", limit=1)
        assert len(hits) <= 1

    def test_rank_ordering(self, repo: EmailRepository, fresh_db: Path):
        """bm25 升序：rank 越小越相关，第一个 <= 后面的."""
        self._seed(repo, fresh_db)
        hits = repo.search_email_bodies("project", limit=10)
        if len(hits) >= 2:
            assert hits[0].rank <= hits[1].rank

    def test_notion_url_populated(self, repo: EmailRepository, fresh_db: Path):
        """notion_page_id 存在 → notion_url 拼好；不存在 → None."""
        self._seed(repo, fresh_db)
        hits = repo.search_email_bodies("meeting", limit=10)
        h100 = next((h for h in hits if h.internal_id == 100), None)
        assert h100 is not None
        assert h100.notion_page_id == "page-100"
        assert h100.notion_url == "https://www.notion.so/page100"

        # 200 没有 notion_page_id
        hits2 = repo.search_email_bodies("project", limit=10)
        h200 = next((h for h in hits2 if h.internal_id == 200), None)
        if h200:
            assert h200.notion_page_id is None
            assert h200.notion_url is None

    def test_trigger_keeps_fts_in_sync_on_body_update(self, repo: EmailRepository, fresh_db: Path):
        """email_body UPDATE → fts_update trigger 重建 FTS 行，老 term 不再命中，新 term 命中."""
        _insert_metadata_full(fresh_db, 500, subject="s", sender="s@x", mailbox="收件箱")
        repo.commit_email_with_body(
            500,
            BodyPayload(html="", markdown="oldterm content here", body_format="html"),
            [],
        )
        assert any(h.internal_id == 500 for h in repo.search_email_bodies("oldterm", limit=10))

        # 第二次 commit 触发 INSERT OR REPLACE，但 FTS trigger AFTER INSERT 也会触发
        # 用户场景常见：backfill 后重抽
        repo.commit_email_with_body(
            500,
            BodyPayload(html="", markdown="newterm content here", body_format="html"),
            [],
        )
        # 新 term 应该命中（trigger 工作）
        assert any(h.internal_id == 500 for h in repo.search_email_bodies("newterm", limit=10))

    def test_trigger_removes_fts_on_body_delete(self, repo: EmailRepository, fresh_db: Path):
        """删 metadata → CASCADE 删 email_body → fts_delete trigger 移除 FTS 行."""
        _insert_metadata_full(fresh_db, 600, subject="s", sender="s@x", mailbox="收件箱")
        repo.commit_email_with_body(
            600,
            BodyPayload(html="", markdown="uniqueterm6 content", body_format="html"),
            [],
        )
        assert any(h.internal_id == 600 for h in repo.search_email_bodies("uniqueterm6", limit=10))

        repo.delete_email_full(600)
        assert not any(h.internal_id == 600 for h in repo.search_email_bodies("uniqueterm6", limit=10))


class TestSearchHitAiFields:
    """MED-2: 搜索命中补投影 ai_priority(raw) + lang(raw)。

    收敛单核后桌面命令面板搜索经 serve-api Python 核 → 旧 TS 投影的优先级 chip / lang pip
    曾丢失。这里锁住: ① email_metadata.ai_priority(v14 列) raw 串落到 hit.ai_priority;
    ② llm_processing.labels_json.language raw 串落到 hit.lang; ③ 无 llm_processing 表
    (SyncStore-only schema) graceful degrade lang=None 不崩。映射成 wire enum 在 serve-api
    出口 (test_envelope_and_email 覆盖), 这里只验 raw 串透传到 dataclass。
    """

    def _create_llm_processing(self, db: Path) -> None:
        from src.llm_agent.store import LLMProcessingStore

        LLMProcessingStore(str(db))  # 触发建 llm_processing 表

    def test_ai_priority_raw_projected_from_main_col(
        self, repo: EmailRepository, fresh_db: Path
    ):
        # 无 llm_processing 表 (SyncStore-only) → priority 从主表列, lang None。
        _insert_metadata_full(
            fresh_db, 700,
            subject="Priority hit", sender="p@example.com", mailbox="收件箱",
        )
        repo.commit_email_with_body(
            700,
            BodyPayload(html="<p>x</p>", markdown="prioneedle body content",
                        body_format="html"),
            [],
        )
        conn = sqlite3.connect(str(fresh_db))
        conn.execute(
            "UPDATE email_metadata SET ai_priority = ? WHERE internal_id = ?",
            ("🔴 紧急", 700),
        )
        conn.commit()
        conn.close()

        hits = repo.search_email_bodies("prioneedle", limit=10)
        hit = next(h for h in hits if h.internal_id == 700)
        assert hit.ai_priority == "🔴 紧急"  # raw 串 (serve-api 出口映射成 'critical')
        assert hit.lang is None  # 无 llm_processing → lang 降级

    def test_lang_raw_projected_from_labels_json(
        self, repo: EmailRepository, fresh_db: Path
    ):
        self._create_llm_processing(fresh_db)
        _insert_metadata_full(
            fresh_db, 710,
            subject="Lang hit", sender="l@example.com", mailbox="收件箱",
        )
        repo.commit_email_with_body(
            710,
            BodyPayload(html="<p>x</p>", markdown="langneedle body content",
                        body_format="html"),
            [],
        )
        conn = sqlite3.connect(str(fresh_db))
        conn.execute(
            "INSERT INTO llm_processing (internal_id, status, labels_json) "
            "VALUES (?, 'success', ?)",
            (710, '{"language": "English", "priority": "🟡 重要"}'),
        )
        conn.commit()
        conn.close()

        # 实例级 memo 已缓存「无 llm_processing」→ 用新 repo 实例重新探测。
        repo2 = EmailRepository(db_path=str(fresh_db),
                                attachment_store=repo.attachment_store)
        hits = repo2.search_email_bodies("langneedle", limit=10)
        hit = next(h for h in hits if h.internal_id == 710)
        assert hit.lang == "English"  # raw 串 (serve-api 出口映射成 'en')
        assert hit.ai_priority == "🟡 重要"  # labels_json fallback (主表列空)


class TestFilterIdsByMetadataChunking:
    """NS-3: 候选 id 集 IN(...) 分块 (>900) 不超 SQLite 参数上限 + 不丢任何 id (全召回)。

    trigram 路径 per-term 全召回 (不截断) → 候选集可能数万 → IN(<all ids>) 会
    OperationalError ('too many SQL variables')。_filter_ids_by_metadata 分块 union。
    """

    def test_chunked_filter_no_predicates_returns_all(
        self, repo: EmailRepository, fresh_db: Path
    ):
        conn = repo._connect()
        try:
            ids = set(range(1, 2001))  # 2000 > 900*2 → 多块
            assert repo._filter_ids_by_metadata(conn, ids, []) == ids
        finally:
            conn.close()

    def test_chunked_filter_with_predicate_keeps_all_matches(
        self, repo: EmailRepository, fresh_db: Path
    ):
        from src.repository.search_query import build_structured_filter_predicates

        conn = repo._connect()
        try:
            now = time.time()
            for i in range(1, 1501):  # 1500 > 900 → 触发分块
                conn.execute(
                    "INSERT INTO email_metadata (internal_id, sync_status, mailbox, "
                    "subject, sender, date_received, created_at, updated_at) "
                    "VALUES (?, 'synced', ?, ?, ?, ?, ?, ?)",
                    (i, "收件箱" if i % 2 == 0 else "发件箱", f"sub{i}",
                     "s@x.com", "2026-05-15T10:00:00+08:00", now, now),
                )
            conn.commit()
            ids = set(range(1, 1501))
            filters, _ = build_structured_filter_predicates(mailbox="收件箱")
            allowed = repo._filter_ids_by_metadata(conn, ids, filters)
            # 收件箱 = 偶数 internal_id = 750 封, 跨块全召回, 一个不丢。
            assert len(allowed) == 750
            assert all(i % 2 == 0 for i in allowed)
        finally:
            conn.close()


# ============================================================
# PR-2a: smart_query_transform + search_email_bodies_smart
# ============================================================


class TestSmartQueryTransform:
    """纯函数测试 — 验证 CJK-aware FTS5 query 改写规则."""

    def test_empty_query_returns_as_is(self):
        assert smart_query_transform("") == ""
        assert smart_query_transform("   ") == "   "

    def test_single_cjk_char_gets_prefix_wildcard(self):
        """单字 CJK → 'X*' prefix."""
        assert smart_query_transform("产") == "产*"
        assert smart_query_transform("会") == "会*"

    def test_multi_char_cjk_gets_prefix_or_char_and_fallback(self):
        """多字 CJK → '(token* OR (c1* AND c2*))' (整 prefix + 字符 AND 兜底)."""
        assert smart_query_transform("产品") == "(产品* OR (产* AND 品*))"
        assert smart_query_transform("本周产品评审") == (
            "(本周产品评审* OR (本* AND 周* AND 产* AND 品* AND 评* AND 审*))"
        )

    def test_pure_latin_token_unchanged(self):
        """纯拉丁 token 原样 (FTS5 按整词 match)."""
        assert smart_query_transform("redis") == "redis"
        assert smart_query_transform("timeout") == "timeout"

    def test_multi_latin_tokens_use_and(self):
        """多 latin token 之间 AND 连接 (符合英文搜索期望)."""
        assert smart_query_transform("redis timeout") == "redis AND timeout"
        assert smart_query_transform("project plan review") == (
            "project AND plan AND review"
        )

    def test_mixed_latin_and_cjk_tokens(self):
        """混合多 token: token 间 AND, CJK token 内部 prefix-OR fallback."""
        assert smart_query_transform("redis 超时") == (
            "redis AND (超时* OR (超* AND 时*))"
        )

    def test_mixed_char_within_one_token(self):
        """单 token 内 CJK + Latin 混合: 切 segment 各处理."""
        assert smart_query_transform("Redis超时") == (
            "(Redis AND (超时* OR (超* AND 时*)))"
        )

    def test_phrase_with_quotes_unchanged(self):
        """含双引号 → 用户已用 FTS5 phrase 语法 → 原样."""
        assert smart_query_transform('"redis timeout"') == '"redis timeout"'

    def test_wildcard_unchanged(self):
        """含 * → 用户已 prefix → 原样."""
        assert smart_query_transform("redis*") == "redis*"
        assert smart_query_transform("产品*") == "产品*"

    def test_explicit_operators_unchanged(self):
        """含 FTS5 操作符 AND/OR/NOT 全大写 → 原样."""
        assert smart_query_transform("redis AND timeout") == "redis AND timeout"
        assert smart_query_transform("redis OR cache") == "redis OR cache"
        assert smart_query_transform("redis NOT timeout") == "redis NOT timeout"

    def test_grouping_and_column_syntax_returns_raw(self):
        """真·FTS5 语法 (分组 () / 列限定 :) → 原样下放, 让 FTS5 自己处理."""
        assert smart_query_transform("(redis)") == "(redis)"
        assert smart_query_transform("body:redis") == "body:redis"

    def test_incidental_punctuation_quoted_as_phrase(self):
        """#1 修复: 含「附带标点」的 token (版本号 6.3 / IP / 邮箱 / 连字符, 无 FTS5
        语法字符) → quote 成短语而非原样下放.

        旧实现把整个 query 原样下放 → 裸 MATCH 触发 'fts5 syntax error near "."' →
        _fts_match_ids/_fetch_body_fts_rows 吞错返回空 → 整句零命中 (实测「Omada 6.3」
        「…SDN 6.3 Wlan Group修改」搜不到根因). 短语让 unicode61 按分词后子序列匹配.
        """
        assert smart_query_transform("6.3") == '"6.3"'
        assert smart_query_transform("Omada 6.3") == 'Omada AND "6.3"'
        assert smart_query_transform("SDN 6.3 Wlan") == 'SDN AND "6.3" AND Wlan'
        assert smart_query_transform("redis-timeout") == '"redis-timeout"'
        assert smart_query_transform("user@example.com") == '"user@example.com"'
        assert smart_query_transform("192.168.1.1") == '"192.168.1.1"'

    def test_hiragana_treated_as_cjk(self):
        """日文假名也走 CJK prefix 通配 (跟中文同 token-chunk 困境)."""
        # ひらがな 是 4 字假名 token
        result = smart_query_transform("ひらがな")
        assert result.startswith("(ひらがな*")
        assert "ひ*" in result and "ら*" in result

    def test_hangul_treated_as_cjk(self):
        """韩文谚文也走 CJK prefix 通配."""
        result = smart_query_transform("안녕")
        assert result == "(안녕* OR (안* AND 녕*))"

    def test_whitespace_normalized(self):
        """多空白 split 视作单 separator."""
        assert smart_query_transform("  redis    timeout  ") == "redis AND timeout"


class TestSearchEmailBodiesSmart:
    """集成测试 — repo.search_email_bodies_smart 实际命中行为."""

    def _seed_cjk(self, repo: EmailRepository, fresh_db: Path):
        """种几封含 CJK chunk token 的邮件验证 wrapper 改善召回.

        Token boundary 提示: unicode61 把连续 CJK 当一 token, 用中文逗号
        '，' 切出 'token1，token2' → tokens 'token1' + 'token2'.
        700 subject token = '产品评审会' (产品* prefix 命中 subject)
        700 body tokens = '本周产品评审定' + '周三下午请提前同步进度'
                         (周三* prefix 命中 body 第二段)
        """
        _insert_metadata_full(
            fresh_db, 700,
            subject="产品评审会",
            sender="alice@example.com",
            mailbox="收件箱",
        )
        repo.commit_email_with_body(
            700,
            BodyPayload(
                html="",
                markdown="本周产品评审定，周三下午请提前同步进度。",
                body_format="html",
            ),
            [],
        )
        _insert_metadata_full(
            fresh_db, 701,
            subject="无关邮件",
            sender="bob@example.com",
            mailbox="收件箱",
        )
        repo.commit_email_with_body(
            701,
            BodyPayload(
                html="",
                markdown="meeting agenda is unrelated.",
                body_format="html",
            ),
            [],
        )

    def test_smart_finds_cjk_in_chunked_token(self, repo: EmailRepository, fresh_db: Path):
        """raw '产品' 命不中 (token 是 '本周产品评审定在周三下午'),
        smart 改写后能命中."""
        self._seed_cjk(repo, fresh_db)
        # raw 模式
        assert repo.search_email_bodies("产品", limit=10) == []
        # smart 模式
        hits = repo.search_email_bodies_smart("产品", limit=10)
        ids = [h.internal_id for h in hits]
        assert 700 in ids
        assert 701 not in ids

    def test_smart_passthrough_for_explicit_fts_syntax(
        self, repo: EmailRepository, fresh_db: Path
    ):
        """含 FTS5 语法 → smart 不动 query, 跟 raw 等价（非 trigram smart 路径的 passthrough 契约）.

        G-A6 起 SEARCH_TRIGRAM_ENABLED 默认 True → 裸 CJK plain query（含 '产品*'）会先被
        trigram 子串路由接管（v0.11.0 既有 flag 行为，非本期引入；路由是否该跳过显式 '*' 属
        Phase B 引擎内部范畴）。本测试验证的是「非 trigram smart 路径显式 FTS 语法原样透传 =
        raw」这一契约，故 smart 侧显式用 trigram-off repo 还原该路径。"""
        self._seed_cjk(repo, fresh_db)
        raw_hits = repo.search_email_bodies("产品*", limit=10)
        nontrigram_repo = EmailRepository(db_path=str(fresh_db), trigram_enabled=False)
        smart_hits = nontrigram_repo.search_email_bodies_smart("产品*", limit=10)
        assert [h.internal_id for h in smart_hits] == [h.internal_id for h in raw_hits]

    def test_smart_multi_cjk_token_and(self, repo: EmailRepository, fresh_db: Path):
        """smart '产品 周三' (双 token CJK) → 两 token 都命中才 hit."""
        self._seed_cjk(repo, fresh_db)
        hits = repo.search_email_bodies_smart("产品 周三", limit=10)
        ids = [h.internal_id for h in hits]
        assert 700 in ids  # 含 "产品" + "周三"

    def test_smart_latin_unchanged(self, repo: EmailRepository, fresh_db: Path):
        """smart 模式拉丁 query 跟 raw 完全等价."""
        self._seed_cjk(repo, fresh_db)
        smart_hits = repo.search_email_bodies_smart("meeting", limit=10)
        raw_hits = repo.search_email_bodies("meeting", limit=10)
        assert [h.internal_id for h in smart_hits] == [h.internal_id for h in raw_hits]

    def _seed_version_subject(self, repo: EmailRepository, fresh_db: Path):
        """#1 回归种子: 含版本号 (6.3) 的 CJK+英文混排主题邮件 + 一封不相关诱饵。"""
        _insert_metadata_full(
            fresh_db, 776,
            subject="回复: 【配置声明】Omada SDN 6.3 Wlan Group修改",
            sender="lucien@omadanetworks.com",
            mailbox="收件箱",
        )
        repo.commit_email_with_body(
            776,
            BodyPayload(
                html="",
                markdown="Omada SDN 6.3 controller wlan group 配置声明 修改 deadline。",
                body_format="html",
            ),
            [],
        )
        _insert_metadata_full(
            fresh_db, 777,
            subject="无关邮件",
            sender="bob@example.com",
            mailbox="收件箱",
        )
        repo.commit_email_with_body(
            777,
            BodyPayload(html="", markdown="completely unrelated content.", body_format="html"),
            [],
        )

    def test_smart_version_token_fastpath(self, repo: EmailRepository, fresh_db: Path):
        """#1 修复: 纯英文含版本号 'Omada 6.3' (fast-path, token 含 '.') 不再因 fts5
        语法错误零命中。旧实现 smart_query_transform 原样下放 → MATCH 报错 → []。"""
        self._seed_version_subject(repo, fresh_db)
        ids = [h.internal_id for h in repo.search_email_bodies_smart("Omada 6.3", limit=10)]
        assert 776 in ids
        assert 777 not in ids

    def test_smart_version_token_trigram_cjk(self, fresh_db: Path):
        """#1 修复: CJK+英文混排含版本号 'SDN 6.3 修改' (trigram 路径) 不再因 '6.3'
        unicode term MATCH 语法错误打死整条 AND 链 → []（用户报告主题的最小复现）。"""
        repo = EmailRepository(db_path=str(fresh_db), trigram_enabled=True)
        self._seed_version_subject(repo, fresh_db)
        ids = [h.internal_id for h in repo.search_email_bodies_smart("SDN 6.3 修改", limit=10)]
        assert 776 in ids
        assert 777 not in ids

    def _seed_latin_dual_lane(self, fresh_db: Path):
        """PR2 种子: 连写文档 (拉丁 token 嵌在 'Omada固件升级' 连续串里, unicode61
        零召回) + 整词文档 (含独立 'Omada' token)。subject/sender 均不含独立 Omada,
        保证 780 只能靠 trigram 子串 lane 命中。"""
        repo = EmailRepository(db_path=str(fresh_db))
        _insert_metadata_full(
            fresh_db, 780,
            subject="固件升级公告",
            sender="victor@example.com",
            mailbox="收件箱",
        )
        repo.commit_email_with_body(
            780,
            BodyPayload(html="", markdown="Omada固件升级公告已发布，请查收。", body_format="html"),
            [],
        )
        _insert_metadata_full(
            fresh_db, 781,
            subject="Omada release",
            sender="victor@example.com",
            mailbox="收件箱",
        )
        repo.commit_email_with_body(
            781,
            BodyPayload(html="", markdown="Omada 固件升级说明文档已上传。", body_format="html"),
            [],
        )

    def test_latin_dual_lane_recalls_connected_doc(self, fresh_db: Path):
        """PR2: 含 CJK 混合 query 里 >=3 字符拉丁 token 双 lane (unicode61 ∪ trigram
        子串) —— 连写文档 780 不再被 unicode61 零召回拖垮 AND 交集; 整词文档 781
        双 lane RRF 叠加排前。"""
        self._seed_latin_dual_lane(fresh_db)
        repo_on = EmailRepository(
            db_path=str(fresh_db), trigram_enabled=True, latin_trigram_enabled=True
        )
        ids = [
            h.internal_id
            for h in repo_on.search_email_bodies_smart("Omada 固件升级", limit=10)
        ]
        assert ids == [781, 780]

    def test_latin_dual_lane_flag_off_reverts_to_pre_pr2(self, fresh_db: Path):
        """SEARCH_LATIN_TRIGRAM_ENABLED=false → 拉丁 token 回单 unicode lane, 与 PR2
        前行为逐字节一致: 整词文档 781 仍命中, 连写文档 780 不可达; 拉丁 token
        unicode61 零召回的 query 整体空 (旧 AND 交集清空语义)。同库同 query 对比
        两种 flag 实例, 锁回退门。"""
        self._seed_latin_dual_lane(fresh_db)
        repo_off = EmailRepository(
            db_path=str(fresh_db), trigram_enabled=True, latin_trigram_enabled=False
        )
        repo_on = EmailRepository(
            db_path=str(fresh_db), trigram_enabled=True, latin_trigram_enabled=True
        )
        # PR2 前: unicode61 MATCH 'Omada' 只命中 781 → 交集 {781}
        assert [
            h.internal_id
            for h in repo_off.search_email_bodies_smart("Omada 固件升级", limit=10)
        ] == [781]
        # PR2 前: 'mada' unicode61 零召回 → 整查询空; flag off 保持, flag on 兜住 780
        assert repo_off.search_email_bodies_smart("公告 mada", limit=10) == []
        assert [
            h.internal_id
            for h in repo_on.search_email_bodies_smart("公告 mada", limit=10)
        ] == [780]
        # <3 字符拉丁 token 不加 trigram lane: 两种 flag 下行为一致 (均空)
        assert repo_off.search_email_bodies_smart("固件 ab", limit=10) == []
        assert repo_on.search_email_bodies_smart("固件 ab", limit=10) == []

    def test_smart_empty_query_returns_empty(self, repo: EmailRepository, fresh_db: Path):
        self._seed_cjk(repo, fresh_db)
        assert repo.search_email_bodies_smart("", limit=10) == []
        assert repo.search_email_bodies_smart("   ", limit=10) == []

    def test_smart_filters_pass_through(self, repo: EmailRepository, fresh_db: Path):
        """mailbox / date 过滤跟 raw 行为一致 — wrapper 仅改写 query."""
        self._seed_cjk(repo, fresh_db)
        hits = repo.search_email_bodies_smart("产品", limit=10, mailbox="收件箱")
        assert all(h.mailbox == "收件箱" for h in hits)
        # 发件箱过滤应空
        hits_sent = repo.search_email_bodies_smart("产品", limit=10, mailbox="发件箱")
        assert hits_sent == []

    def test_smart_search_includes_attachment_only_hit(
        self, repo: EmailRepository, fresh_db: Path
    ):
        """public smart 入口也应走正文+附件融合，而不是只查 body FTS."""
        _insert_metadata_full(
            fresh_db,
            702,
            subject="Attachment fixture",
            sender="alice@example.com",
            mailbox="收件箱",
        )
        id_map = repo.commit_email_with_body(
            702,
            BodyPayload(
                html="",
                markdown="body without the target token",
                body_format="html",
            ),
            [
                AttachmentPayload(
                    filename="contract.pdf",
                    content=b"%PDF-1.4 fixture",
                    content_type="application/pdf",
                ),
            ],
        )
        repo.commit_attachment_text(
            id_map["contract.pdf"],
            text="contractneedle appears only inside attachment text",
            extractor="fixture",
        )

        hits = repo.search_email_bodies_smart("contractneedle", limit=10)

        hit = next((item for item in hits if item.internal_id == 702), None)
        assert hit is not None
        assert hit.source == "attachment"
        assert hit.filename == "contract.pdf"


class TestAttachmentTrigramLaneDegrade:
    """PR4 graceful degrade: 旧库 (v38) 无 email_attachment_fts_trigram (v39 表) 时,
    附件 trigram lane 静默缺席 (OperationalError 被接住), 搜索不崩、body/unicode
    附件结果照常 —— 上线前必要保证 (真机 userData 库升级前仍是 v38 形态:
    body trigram 在 [v24]、attachment trigram 缺 [v39])。"""

    # 镜像 sync_store.py v39 迁移块注释的回滚脚本 (DROP 3 trigger + DROP 表)。
    _DROP_V39 = """
        DROP TRIGGER IF EXISTS email_attachment_fts_trigram_insert;
        DROP TRIGGER IF EXISTS email_attachment_fts_trigram_update;
        DROP TRIGGER IF EXISTS email_attachment_fts_trigram_delete;
        DROP TABLE IF EXISTS email_attachment_fts_trigram;
    """

    def _seed(self, fresh_db: Path, store: AttachmentStore) -> None:
        # 必须传隔离 store —— 默认 AttachmentStore() 会把附件写进仓库 data/attachments/。
        repo = EmailRepository(db_path=str(fresh_db), attachment_store=store)
        _insert_metadata_full(
            fresh_db, 790,
            subject="固件升级公告",
            sender="victor@example.com",
            mailbox="收件箱",
        )
        repo.commit_email_with_body(
            790,
            BodyPayload(
                html="", markdown="Omada固件升级公告已发布。", body_format="html"
            ),
            [],
        )
        _insert_metadata_full(
            fresh_db, 791,
            subject="Attachment host",
            sender="victor@example.com",
            mailbox="收件箱",
        )
        id_map = repo.commit_email_with_body(
            791,
            BodyPayload(
                html="", markdown="plain body without needles", body_format="html"
            ),
            [
                AttachmentPayload(
                    filename="manual.pdf",
                    content=b"%PDF-1.4 fixture",
                    content_type="application/pdf",
                ),
            ],
        )
        repo.commit_attachment_text(
            id_map["manual.pdf"],
            text="固件升级手册正文 attachneedle",
            extractor="fixture",
        )

    def _drop_v39_table(self, fresh_db: Path) -> None:
        conn = sqlite3.connect(str(fresh_db))
        try:
            conn.executescript(self._DROP_V39)
        finally:
            conn.close()

    def test_attachment_lane_hits_when_table_present(
        self, fresh_db: Path, store: AttachmentStore
    ):
        """对照组: v39 表在 → CJK trigram 路径命中 attachment-only 邮件
        (source='attachment' + filename), body 命中照常。"""
        self._seed(fresh_db, store)
        repo = EmailRepository(
            db_path=str(fresh_db), trigram_enabled=True, latin_trigram_enabled=True
        )
        hits = repo.search_email_bodies_smart("固件升级", limit=10)
        by_id = {h.internal_id: h for h in hits}
        assert set(by_id) == {790, 791}
        assert by_id[790].source == "body"
        assert by_id[791].source == "attachment"
        assert by_id[791].filename == "manual.pdf"

    def test_cjk_path_survives_missing_attachment_trigram_table(
        self, fresh_db: Path, store: AttachmentStore
    ):
        """CJK trigram 路径 (>=3 MATCH + 2 字 LIKE 两分支): 表缺失 → 附件 lane
        静默空 (attachment-only 邮件退化不可见), body 命中照常, 不崩。"""
        self._seed(fresh_db, store)
        self._drop_v39_table(fresh_db)
        repo = EmailRepository(
            db_path=str(fresh_db), trigram_enabled=True, latin_trigram_enabled=True
        )
        assert [
            h.internal_id
            for h in repo.search_email_bodies_smart("固件升级", limit=10)
        ] == [790]
        assert [
            h.internal_id for h in repo.search_email_bodies_smart("固件", limit=10)
        ] == [790]

    def test_fused_path_survives_missing_attachment_trigram_table(
        self, fresh_db: Path, store: AttachmentStore
    ):
        """纯英文裸查 (fused): body-trigram-whole 子串照常 (v24 表在),
        attachment-trigram-whole 静默空; attachment-unicode 行级 lane (主表) 不受影响。"""
        self._seed(fresh_db, store)
        self._drop_v39_table(fresh_db)
        repo = EmailRepository(
            db_path=str(fresh_db), trigram_enabled=True, latin_trigram_enabled=True
        )
        # 整 query 短语 lane: 'Omad' 子串命中连写正文 (body trigram 表仍在)。
        assert [
            h.internal_id for h in repo.search_email_bodies_smart("Omad", limit=10)
        ] == [790]
        # 附件文本整词: 老 attachment-unicode 主表行级 lane 照常命中。
        hits = repo.search_email_bodies_smart("attachneedle", limit=10)
        assert [h.internal_id for h in hits] == [791]
        assert hits[0].source == "attachment"
        assert hits[0].filename == "manual.pdf"


class TestGetMetadata:
    def test_returns_none_when_missing(self, repo: EmailRepository):
        assert repo.get_metadata(99999) is None

    def test_returns_dataclass_with_all_fields(self, repo: EmailRepository, fresh_db: Path):
        now = time.time()
        notion_page_id = "abc123-def456-ghi789-jkl012-mno345-pqr678"
        conn = sqlite3.connect(str(fresh_db))
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute(
            """INSERT INTO email_metadata
               (internal_id, message_id, thread_id, subject, sender,
                sender_name, to_addr, cc_addr, date_received, mailbox,
                is_read, is_flagged, sync_status, notion_page_id,
                notion_thread_id, sync_error, retry_count, next_retry_at,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                500,
                "<m500@x>",
                "<t500@x>",
                "Subject 500",
                "sender@example.com",
                "Sender Name",
                "to@example.com",
                "cc@example.com",
                "2026-05-01T12:00:00+08:00",
                "收件箱",
                1,
                0,
                "synced",
                notion_page_id,
                "thread-page-id",
                "sync error text",
                2,
                now + 60,
                now,
                now,
            ),
        )
        conn.commit()
        conn.close()

        m = repo.get_metadata(500)

        assert isinstance(m, EmailMetadataRecord)
        assert m.internal_id == 500
        assert m.message_id == "<m500@x>"
        assert m.thread_id == "<t500@x>"
        assert m.subject == "Subject 500"
        assert m.sender == "sender@example.com"
        assert m.sender_name == "Sender Name"
        assert m.to_addr == "to@example.com"
        assert m.cc_addr == "cc@example.com"
        assert m.date_received == "2026-05-01T12:00:00+08:00"
        assert m.mailbox == "收件箱"
        assert m.is_read is True
        assert m.is_flagged is False
        assert m.sync_status == "synced"
        assert m.notion_page_id == notion_page_id
        assert m.notion_thread_id == "thread-page-id"
        assert m.sync_error == "sync error text"
        assert m.retry_count == 2
        assert m.next_retry_at == now + 60
        assert m.created_at == now
        assert m.updated_at == now
        assert m.notion_url == "https://www.notion.so/abc123def456ghi789jkl012mno345pqr678"

    def test_notion_url_none_when_page_id_missing(self, repo: EmailRepository, fresh_db: Path):
        _insert_metadata(fresh_db, 501)

        m = repo.get_metadata(501)

        assert m is not None
        assert m.notion_page_id is None
        assert m.notion_url is None


class TestGetEmailFull:
    def test_returns_none_when_metadata_missing(self, repo: EmailRepository):
        assert repo.get_email_full(99999) is None

    def test_returns_full_when_only_metadata(self, repo: EmailRepository, fresh_db: Path):
        _insert_metadata(fresh_db, 600)

        full = repo.get_email_full(600)

        assert isinstance(full, EmailFull)
        assert full.internal_id == 600
        assert full.metadata.internal_id == 600
        assert full.body is None
        assert full.attachments == []

    def test_returns_full_with_body_and_attachments(self, repo: EmailRepository, fresh_db: Path):
        _insert_metadata(fresh_db, 601)
        repo.commit_email_with_body(
            601,
            body=BodyPayload(html="<p>x</p>", markdown="x body", body_format="html"),
            attachments=[
                AttachmentPayload("f1.pdf", b"AAA", "application/pdf"),
                AttachmentPayload("f2.txt", b"BBB", "text/plain"),
            ],
            message_id="<m601@x>",
        )

        full = repo.get_email_full(601)

        assert isinstance(full, EmailFull)
        assert full.body is not None
        assert full.body.markdown == "x body"
        assert len(full.attachments) == 2
        assert sorted(a.filename for a in full.attachments) == ["f1.pdf", "f2.txt"]


class TestGetThreadMembers:
    def _insert_thread_email(
        self, db: Path, internal_id: int, *, thread_id: str,
        sync_status: str = "synced", page_id: Optional[str] = None,
        date_received: str = "2026-05-01T12:00:00+08:00",
    ):
        """辅助函数：直接 INSERT 一行带 thread_id / sync_status / notion_page_id / date 的 metadata."""
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

    def test_empty_thread_id_returns_empty(self, repo: EmailRepository):
        assert repo.get_thread_members("") == []
        assert repo.get_thread_members(None) == []  # type: ignore[arg-type]

    def test_no_matches_returns_empty(self, repo: EmailRepository):
        assert repo.get_thread_members("<no-such-thread>") == []

    def test_filters_by_thread_id_default_synced_only(
        self, repo: EmailRepository, fresh_db: Path,
    ):
        # 同 thread: 1 synced + 1 pending；另一个 thread: 1 synced
        self._insert_thread_email(fresh_db, 700, thread_id="<T1>", sync_status="synced", page_id="P-700")
        self._insert_thread_email(fresh_db, 701, thread_id="<T1>", sync_status="pending", page_id=None)
        self._insert_thread_email(fresh_db, 702, thread_id="<T2>", sync_status="synced", page_id="P-702")

        members = repo.get_thread_members("<T1>")
        assert len(members) == 1
        assert isinstance(members[0], ThreadMember)
        assert members[0].internal_id == 700
        assert members[0].page_id == "P-700"
        assert members[0].is_synced is True

    def test_excludes_internal_id(self, repo: EmailRepository, fresh_db: Path):
        self._insert_thread_email(fresh_db, 710, thread_id="<T-EXC>", page_id="P-710",
                                  date_received="2026-05-01T10:00:00+08:00")
        self._insert_thread_email(fresh_db, 711, thread_id="<T-EXC>", page_id="P-711",
                                  date_received="2026-05-01T11:00:00+08:00")
        members = repo.get_thread_members("<T-EXC>", exclude_internal_id=710)
        assert len(members) == 1
        assert members[0].internal_id == 711

    def test_synced_only_false_includes_pending(
        self, repo: EmailRepository, fresh_db: Path,
    ):
        self._insert_thread_email(fresh_db, 720, thread_id="<T-ALL>", sync_status="synced", page_id="P-720")
        self._insert_thread_email(fresh_db, 721, thread_id="<T-ALL>", sync_status="pending", page_id=None)
        self._insert_thread_email(fresh_db, 722, thread_id="<T-ALL>", sync_status="failed", page_id=None)

        members = repo.get_thread_members("<T-ALL>", synced_only=False)
        assert len(members) == 3
        assert {m.internal_id for m in members} == {720, 721, 722}
        # is_synced 应仅对 sync_status='synced' 行为 True
        is_synced_map = {m.internal_id: m.is_synced for m in members}
        assert is_synced_map == {720: True, 721: False, 722: False}

    def test_orders_by_date_received_desc(self, repo: EmailRepository, fresh_db: Path):
        # 故意乱序插入，验证返回按日期降序
        self._insert_thread_email(fresh_db, 730, thread_id="<T-ORD>", page_id="P-A",
                                  date_received="2026-05-01T08:00:00+08:00")
        self._insert_thread_email(fresh_db, 731, thread_id="<T-ORD>", page_id="P-C",
                                  date_received="2026-05-03T08:00:00+08:00")
        self._insert_thread_email(fresh_db, 732, thread_id="<T-ORD>", page_id="P-B",
                                  date_received="2026-05-02T08:00:00+08:00")
        members = repo.get_thread_members("<T-ORD>")
        assert [m.internal_id for m in members] == [731, 732, 730]


# ============================================================
# PR-2b: 附件文本抽取 + FTS5 搜索
# ============================================================


class TestAttachmentText:
    """测 EmailRepository 的 attachment_text CRUD + retry queue."""

    def _seed_email_with_attachment(
        self,
        repo: EmailRepository,
        fresh_db: Path,
        internal_id: int = 800,
        *,
        subject: str = "test email",
        sender: str = "a@x",
    ) -> int:
        """种 email + 一个非 inline 附件, 返附件 attachment_id."""
        _insert_metadata_full(
            fresh_db, internal_id, subject=subject, sender=sender, mailbox="收件箱"
        )
        id_map = repo.commit_email_with_body(
            internal_id,
            BodyPayload(html="", markdown="body", body_format="html"),
            [AttachmentPayload(
                filename="doc.pdf",
                content=b"%PDF-1.4 fake",
                content_type="application/pdf",
                is_inline=False,
            )],
        )
        return id_map["doc.pdf"]

    def test_commit_with_attachment_auto_enqueues_pending(
        self, repo: EmailRepository, fresh_db: Path
    ):
        att_id = self._seed_email_with_attachment(repo, fresh_db)
        record = repo.get_attachment_text(att_id)
        assert record is not None
        assert record.attachment_id == att_id
        assert record.status == "pending"
        assert record.extractor == "pending"
        assert record.text_content is None

    def test_inline_attachment_skipped_from_enqueue(
        self, repo: EmailRepository, fresh_db: Path
    ):
        """is_inline=True 附件不入 attachment_text queue (cid: 图无需抽文本)."""
        _insert_metadata_full(fresh_db, 801, mailbox="收件箱")
        id_map = repo.commit_email_with_body(
            801,
            BodyPayload(html="", markdown="body", body_format="html"),
            [
                AttachmentPayload(
                    filename="image.png", content=b"binary",
                    content_type="image/png", is_inline=True,
                ),
            ],
        )
        att_id = id_map["image.png"]
        assert repo.get_attachment_text(att_id) is None

    def test_commit_attachment_text_extracted_status(
        self, repo: EmailRepository, fresh_db: Path
    ):
        att_id = self._seed_email_with_attachment(repo, fresh_db)
        repo.commit_attachment_text(
            att_id,
            text="redis cluster scaling notes",
            extractor="pypdf",
            status="extracted",
        )
        record = repo.get_attachment_text(att_id)
        assert record is not None
        assert record.status == "extracted"
        assert record.extractor == "pypdf"
        assert "redis cluster" in record.text_content
        assert record.extracted_at is not None
        assert record.text_size_bytes > 0

    def test_commit_attachment_text_failed_status_strips_text(
        self, repo: EmailRepository, fresh_db: Path
    ):
        """status='failed' 时 text_content 即使传入也不存 (避免 FTS5 索引 garbage)."""
        att_id = self._seed_email_with_attachment(repo, fresh_db)
        repo.commit_attachment_text(
            att_id,
            text="ignored garbage",
            extractor="pypdf",
            status="failed",
            error_message="OCR not available",
        )
        record = repo.get_attachment_text(att_id)
        assert record is not None
        assert record.status == "failed"
        assert record.text_content is None
        assert record.error_message == "OCR not available"

    def test_commit_attachment_text_unsupported(
        self, repo: EmailRepository, fresh_db: Path
    ):
        att_id = self._seed_email_with_attachment(repo, fresh_db)
        repo.commit_attachment_text(
            att_id, text="", extractor="none", status="unsupported",
            error_message="unsupported extension: .zip",
        )
        record = repo.get_attachment_text(att_id)
        assert record.status == "unsupported"

    def test_commit_invalid_status_rejected(
        self, repo: EmailRepository, fresh_db: Path
    ):
        att_id = self._seed_email_with_attachment(repo, fresh_db)
        with pytest.raises(ValueError):
            repo.commit_attachment_text(
                att_id, text="x", extractor="pypdf", status="bogus"
            )

    def test_list_pending_attachment_extractions(
        self, repo: EmailRepository, fresh_db: Path
    ):
        a1 = self._seed_email_with_attachment(repo, fresh_db, internal_id=810)
        a2 = self._seed_email_with_attachment(repo, fresh_db, internal_id=811)
        pending = repo.list_pending_attachment_extractions(limit=10)
        assert set(pending) >= {a1, a2}
        # 标了 extracted 的不再 pending
        repo.commit_attachment_text(a1, text="t", extractor="pypdf")
        pending2 = repo.list_pending_attachment_extractions(limit=10)
        assert a1 not in pending2
        assert a2 in pending2

    def test_mark_attachment_text_failure_schedules_retry(
        self, repo: EmailRepository, fresh_db: Path
    ):
        att_id = self._seed_email_with_attachment(repo, fresh_db)
        repo.mark_attachment_text_failure(att_id, "transient", max_retries=5)
        record = repo.get_attachment_text(att_id)
        assert record.status == "failed"
        assert record.retry_count == 1
        assert record.next_retry_at is not None
        # 5 次后 dead, next_retry_at = None
        for _ in range(4):
            repo.mark_attachment_text_failure(att_id, "again", max_retries=5)
        record = repo.get_attachment_text(att_id)
        assert record.retry_count == 5
        assert record.next_retry_at is None  # dead-letter

    def test_cascade_delete_email_drops_attachment_text(
        self, repo: EmailRepository, fresh_db: Path
    ):
        att_id = self._seed_email_with_attachment(repo, fresh_db, internal_id=830)
        repo.commit_attachment_text(att_id, text="x", extractor="pypdf")
        assert repo.get_attachment_text(att_id) is not None
        repo.delete_email_full(830)
        assert repo.get_attachment_text(att_id) is None


class TestSearchAttachmentTexts:
    """测 FTS5 + smart wrapper attachment search."""

    def _seed(self, repo: EmailRepository, fresh_db: Path):
        """种 3 封邮件 + 各带 1 attachment + extracted text."""
        # 800: PDF, redis cluster scaling
        _insert_metadata_full(
            fresh_db, 850, subject="技术调研", sender="alice@x",
            mailbox="收件箱", date_received="2026-05-10T10:00:00+08:00",
            notion_page_id="page-850",
        )
        id_map = repo.commit_email_with_body(
            850,
            BodyPayload(html="", markdown="see attached", body_format="html"),
            [AttachmentPayload(
                filename="redis_notes.pdf", content=b"%PDF",
                content_type="application/pdf",
            )],
        )
        repo.commit_attachment_text(
            id_map["redis_notes.pdf"],
            text="redis cluster scaling beyond 16 nodes is tricky",
            extractor="pypdf",
        )
        # 851: docx, 产品评审
        _insert_metadata_full(
            fresh_db, 851, subject="周会", sender="bob@x",
            mailbox="收件箱", date_received="2026-05-12T10:00:00+08:00",
        )
        id_map2 = repo.commit_email_with_body(
            851,
            BodyPayload(html="", markdown="see attached", body_format="html"),
            [AttachmentPayload(
                filename="plan.docx", content=b"PK",  # zip header
                content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )],
        )
        repo.commit_attachment_text(
            id_map2["plan.docx"],
            text="本周 产品 评审 周三 下午",
            extractor="docx",
        )
        # 852: unrelated
        _insert_metadata_full(
            fresh_db, 852, subject="无关", sender="carol@x",
            mailbox="发件箱", date_received="2026-05-15T10:00:00+08:00",
        )
        id_map3 = repo.commit_email_with_body(
            852,
            BodyPayload(html="", markdown="see attached", body_format="html"),
            [AttachmentPayload(
                filename="other.pdf", content=b"%PDF",
                content_type="application/pdf",
            )],
        )
        repo.commit_attachment_text(
            id_map3["other.pdf"],
            text="meeting agenda is unrelated",
            extractor="pypdf",
        )
        return id_map["redis_notes.pdf"], id_map2["plan.docx"], id_map3["other.pdf"]

    def test_basic_english_search(self, repo: EmailRepository, fresh_db: Path):
        a_redis, a_plan, a_other = self._seed(repo, fresh_db)
        hits = repo.search_attachment_texts("redis", limit=10)
        ids = [h.attachment_id for h in hits]
        assert a_redis in ids
        assert a_plan not in ids
        # snippet 带高亮
        hit = next(h for h in hits if h.attachment_id == a_redis)
        assert "<mark>" in hit.snippet
        assert hit.email_subject == "技术调研"
        assert hit.filename == "redis_notes.pdf"

    def test_smart_cjk_search_finds_chunked_token(
        self, repo: EmailRepository, fresh_db: Path
    ):
        """raw '产品' chunk-token 命不中, smart prefix 改写后能命中."""
        a_redis, a_plan, a_other = self._seed(repo, fresh_db)
        # raw 命不中 (假设 plan.docx text 整 chunk 不以 '产品' 开头 token; 实际
        # 我们 fixture 用空格分隔 → token = '产品' 完全 exact, raw 也能命中)
        smart_hits = repo.search_attachment_texts_smart("产品", limit=10)
        smart_ids = [h.attachment_id for h in smart_hits]
        assert a_plan in smart_ids

    def test_mailbox_filter(self, repo: EmailRepository, fresh_db: Path):
        a_redis, a_plan, a_other = self._seed(repo, fresh_db)
        hits = repo.search_attachment_texts(
            "meeting", limit=10, mailbox="发件箱"
        )
        # other.pdf 在发件箱
        ids = [h.attachment_id for h in hits]
        assert a_other in ids

    def test_since_date_filter(self, repo: EmailRepository, fresh_db: Path):
        a_redis, a_plan, a_other = self._seed(repo, fresh_db)
        hits = repo.search_attachment_texts(
            "redis", limit=10, since_date="2026-05-11"
        )
        # 850 是 5/10, 应被排除
        ids = [h.attachment_id for h in hits]
        assert a_redis not in ids

    def test_empty_query_returns_empty(self, repo: EmailRepository, fresh_db: Path):
        self._seed(repo, fresh_db)
        assert repo.search_attachment_texts("") == []
        assert repo.search_attachment_texts("   ") == []

    def test_invalid_fts_query_returns_empty(self, repo: EmailRepository, fresh_db: Path):
        self._seed(repo, fresh_db)
        assert repo.search_attachment_texts('"unbalanced') == []

    def test_notion_url_populated(self, repo: EmailRepository, fresh_db: Path):
        a_redis, _, _ = self._seed(repo, fresh_db)
        hits = repo.search_attachment_texts("redis", limit=10)
        hit = next(h for h in hits if h.attachment_id == a_redis)
        assert hit.notion_page_id == "page-850"
        assert hit.notion_url == "https://www.notion.so/page850"

    def test_failed_extraction_not_indexed(self, repo: EmailRepository, fresh_db: Path):
        """status='failed' 不进 FTS index, 搜不到."""
        _insert_metadata_full(fresh_db, 860, mailbox="收件箱")
        id_map = repo.commit_email_with_body(
            860,
            BodyPayload(html="", markdown="body", body_format="html"),
            [AttachmentPayload(
                filename="encrypted.pdf", content=b"%PDF", content_type="application/pdf",
            )],
        )
        repo.commit_attachment_text(
            id_map["encrypted.pdf"],
            text="secret token redis hidden", extractor="pypdf",
            status="failed", error_message="password protected",
        )
        # 即使 text='secret token redis hidden', 因 status=failed 不入 FTS
        hits = repo.search_attachment_texts("secret", limit=10)
        assert id_map["encrypted.pdf"] not in [h.attachment_id for h in hits]
