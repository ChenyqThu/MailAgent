"""Backend abstraction dataclass tests."""
from __future__ import annotations

from src.mail.backend.types import (
    DraftAppendResult,
    DraftRequest,
    EmailContent,
    EmailMeta,
)


def test_email_content_to_legacy_dict_keys():
    """EmailContent.to_legacy_dict() 输出字段必须跟现有 fetch_email_content_by_id 对齐."""
    ec = EmailContent(
        message_id="<m@ex>",
        internal_id=42,
        subject="Hi",
        sender="from@ex",
        date_received="2026-01-01T00:00:00",
        content="body",
        source="raw mime",
        is_read=True,
        is_flagged=False,
        thread_id="<thread@ex>",
        mailbox="收件箱",
    )
    legacy = ec.to_legacy_dict()
    assert set(legacy.keys()) == {
        "message_id", "subject", "sender", "date", "content",
        "source", "is_read", "is_flagged", "thread_id",
    }
    assert legacy["date"] == "2026-01-01T00:00:00"
    assert legacy["thread_id"] == "<thread@ex>"


def test_email_content_imap_fields_optional():
    """imap_uid / imap_uidvalidity 默认 None (AppleScript backend 不填)."""
    ec = EmailContent(
        message_id="m", internal_id=1, subject="", sender="", date_received="",
        content="", source="", is_read=False, is_flagged=False, thread_id=None,
    )
    assert ec.imap_uid is None
    assert ec.imap_uidvalidity is None


def test_email_meta_defaults():
    em = EmailMeta(
        message_id="m", internal_id=1, subject="s", sender="from",
        date_received="2026", is_read=False, is_flagged=False,
    )
    assert em.thread_id is None
    assert em.mailbox is None
    assert em.imap_uid is None


def test_draft_request_defaults():
    d = DraftRequest()
    assert d.mode == "reply-all"
    assert d.to == []
    assert d.cc == []
    assert d.reply_text == ""
    assert d.reply_html is None
    assert d.drafts_folder is None


def test_draft_append_result_failure():
    r = DraftAppendResult(success=False, drafts_folder="Drafts", error="oops")
    assert r.success is False
    assert r.appended_uid is None
    assert r.method is None
