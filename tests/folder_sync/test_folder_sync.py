"""folder_sync 回归测试 — parse_message_to_folder_dict (imap_folder_reader).

固化 raw MIME → dict 的纯解析逻辑为正式 pytest (不依赖真 IMAP, 喂 raw MIME bytes)。
旧的 FolderEmailRepository / sync_folder_once / FolderSyncWorker 展示链路已在 P6 删除
(实测从未工作), 对应的 repository / sync_ops 测试随之移除。FolderImapReader 的 IMAP
操作 (list_folder/delete/move/send) 由归档 (mail_write) / 草稿 (draft) e2e 验证。
"""
from __future__ import annotations

import json
from email.message import EmailMessage

from src.mail.backend.imap_folder_reader import parse_message_to_folder_dict


# =============================================================================
# parse_message_to_folder_dict
# =============================================================================

class TestParseMessage:
    def _build(self, *, html: str = "<p>hello</p>", with_attach: bool = False) -> bytes:
        m = EmailMessage()
        m["From"] = "Alice Wang <alice@acme.com>"
        m["To"] = "bob@x.com, carol@y.com"
        m["Cc"] = "dave@z.com"
        m["Subject"] = "Q2 Budget Review"
        m["Message-ID"] = "<abc123@acme.com>"
        m["Date"] = "Mon, 26 May 2026 10:00:00 +0800"
        m["References"] = "<root@acme.com> <abc123@acme.com>"
        m.set_content("plain fallback")
        m.add_alternative(html, subtype="html")
        if with_attach:
            m.add_attachment(b"%PDF-x", maintype="application", subtype="pdf",
                             filename="report.pdf")
        return m.as_bytes()

    def test_basic_fields(self):
        d = parse_message_to_folder_dict(
            self._build(), folder="drafts", imap_uid=42,
            imap_uidvalidity=100, is_flagged=True,
        )
        assert d["folder"] == "drafts"
        assert d["imap_uid"] == 42
        assert d["imap_uidvalidity"] == 100
        assert d["subject"] == "Q2 Budget Review"
        assert d["sender"] == "alice@acme.com"
        assert d["sender_name"] == "Alice Wang"
        assert "bob@x.com" in d["to_addr"] and "carol@y.com" in d["to_addr"]
        assert d["cc_addr"] == "dave@z.com"
        assert d["message_id"] == "abc123@acme.com"
        assert d["thread_id"] == "root@acme.com"  # References 首个
        assert d["is_flagged"] == 1
        assert len(d["raw_mime_sha256"]) == 64

    def test_html_to_markdown_body(self):
        d = parse_message_to_folder_dict(
            self._build(html="<p>Hello <b>world</b> budget</p>"),
            folder="archive", imap_uid=1, imap_uidvalidity=1,
        )
        assert "budget" in d["body_markdown"]
        assert "**world**" in d["body_markdown"]  # markdownify 加粗
        assert d["snippet"]

    def test_attachments(self):
        d = parse_message_to_folder_dict(
            self._build(with_attach=True),
            folder="drafts", imap_uid=1, imap_uidvalidity=1,
        )
        assert d["has_attachments"] == 1
        atts = json.loads(d["attachments_json"])
        assert atts[0]["filename"] == "report.pdf"
        assert atts[0]["content_type"] == "application/pdf"

    def test_no_attachments(self):
        d = parse_message_to_folder_dict(
            self._build(with_attach=False),
            folder="drafts", imap_uid=1, imap_uidvalidity=1,
        )
        assert d["has_attachments"] == 0
        assert d["attachments_json"] is None
