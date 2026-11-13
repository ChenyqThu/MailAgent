"""LLM runner 优先读 SQLite 本地正文，本地没有正文才回落 backend 取信。

背景（task 11-13-kos-missed-ingest-fix R2）：runner 原先每次都经 backend（davmail 下是
IMAP）重新取原始邮件。DavMail 断网十几分钟，3 次重试就耗尽变 gave_up，KOS 随之把邮件永久
标成 ``skip: unlabeled``。而 v4 SQLite SSoT 里正文早已落库。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from src.config import config as cfg
from src.llm_agent.runner import LLMRunner
from src.llm_agent.store import LLMProcessingStore
from src.repository.email_repository import AttachmentRecord, EmailBodyRecord


_META = {
    "internal_id": 7,
    "message_id": "<m1@x>",
    "notion_page_id": "",
    "mailbox": "收件箱",
    "subject": "季度预算评审",
    "sender": "alice@example.test",
    "sender_name": "Alice",
    "to_addr": "me@example.test",
    "cc_addr": "bob@example.test",
    "date_received": "2026-11-12T09:30:00+00:00",
    "thread_id": "<t1@x>",
    "is_read": 1,
    "is_flagged": 0,
}


def _body(*, body_format="html", html="<p>请评审预算</p>", markdown="请评审预算"):
    return EmailBodyRecord(
        internal_id=7,
        message_id="<m1@x>",
        html=html,
        markdown=markdown,
        body_format=body_format,
        body_size_bytes=100,
        has_inline_images=False,
        raw_mime_sha256=None,
        fetched_at=0.0,
        fetched_source="test",
    )


def _att(att_id, filename, *, is_inline=False):
    return AttachmentRecord(
        id=att_id,
        internal_id=7,
        filename=filename,
        content_type="application/pdf",
        size_bytes=10,
        is_inline=is_inline,
        content_id=None,
        local_path=f"/nonexistent/{filename}",
        sha256=None,
        derived_from=None,
        derived_format=None,
        notion_file_id=None,
        notion_block_id=None,
        created_at=0.0,
    )


def _build(monkeypatch, tmp_path, *, body, attachments=(), fetch_result=None, parsed=None):
    monkeypatch.setattr("src.llm_agent.runner.notion_enabled", lambda: False)
    monkeypatch.setattr(cfg, "llm_max_retries", 3)
    monkeypatch.setattr(
        "src.llm_agent.runner._lookup_by_internal_id",
        lambda iid, db_path=None: dict(_META),
    )
    labels = SimpleNamespace(
        translation_segments=[],
        model="test-model",
        summary_for_log=lambda: {"priority": "🟢 普通"},
    )
    processor = SimpleNamespace(
        process_email=AsyncMock(return_value=labels), close=AsyncMock()
    )
    repo = SimpleNamespace(
        get_body=Mock(return_value=body),
        get_attachments=Mock(return_value=list(attachments)),
        get_attachment_bytes=Mock(
            side_effect=AssertionError("LLM path must not read attachment bytes")
        ),
    )
    backend = SimpleNamespace(fetch_email_content_by_id=Mock(return_value=fetch_result))
    db_path = str(tmp_path / "s.db")
    store = LLMProcessingStore(db_path=db_path)
    runner = LLMRunner(
        processor=processor,
        writer=SimpleNamespace(write=AsyncMock()),
        store=store,
        repo=repo,
        db_path=db_path,
        backend=backend,
    )
    runner._reader = SimpleNamespace(parse_email_source=Mock(return_value=parsed))
    return runner, processor, backend, store


@pytest.mark.asyncio
async def test_local_body_skips_backend_fetch(monkeypatch, tmp_path):
    runner, processor, backend, _ = _build(
        monkeypatch,
        tmp_path,
        body=_body(),
        attachments=[_att(1, "logo.png", is_inline=True), _att(2, "budget.pdf")],
    )

    result = await runner.run_for_internal_id(7)

    assert result["ok"] is True
    backend.fetch_email_content_by_id.assert_not_called()
    runner._reader.parse_email_source.assert_not_called()
    processor.process_email.assert_awaited_once()
    email = processor.process_email.await_args.args[0]
    assert email.internal_id == 7
    assert email.mailbox == "收件箱"
    assert email.message_id == "<m1@x>"
    assert email.subject == "季度预算评审"
    assert email.sender == "alice@example.test"
    assert email.sender_name == "Alice"
    assert email.to == "me@example.test"
    assert email.cc == "bob@example.test"
    assert email.thread_id == "<t1@x>"
    assert email.is_read is True
    assert email.content == "<p>请评审预算</p>"
    assert email.content_type == "text/html"
    assert [a.filename for a in email.attachments] == ["logo.png", "budget.pdf"]
    assert email.has_attachments is True
    assert email.date == datetime(2026, 11, 12, 9, 30, tzinfo=timezone.utc)
    assert email.date.utcoffset() is not None


@pytest.mark.asyncio
async def test_local_text_body_uses_markdown_plain(monkeypatch, tmp_path):
    runner, processor, backend, _ = _build(
        monkeypatch, tmp_path, body=_body(body_format="text", html=None)
    )

    result = await runner.run_for_internal_id(7)

    assert result["ok"] is True
    backend.fetch_email_content_by_id.assert_not_called()
    email = processor.process_email.await_args.args[0]
    assert email.content == "请评审预算"
    assert email.content_type == "text/plain"
    assert email.attachments == []
    assert email.has_attachments is False


@pytest.mark.asyncio
async def test_naive_local_date_is_beijing(monkeypatch, tmp_path):
    monkeypatch.setitem(_META, "date_received", "2026-11-12T17:30:00")
    runner, processor, _, _ = _build(monkeypatch, tmp_path, body=_body())

    await runner.run_for_internal_id(7)

    email = processor.process_email.await_args.args[0]
    assert email.date.utcoffset() == timedelta(hours=8)


@pytest.mark.asyncio
async def test_no_local_body_falls_back_to_backend(monkeypatch, tmp_path):
    parsed = SimpleNamespace(mailbox=None, internal_id=None)
    runner, processor, backend, _ = _build(
        monkeypatch,
        tmp_path,
        body=None,
        fetch_result={"source": "raw", "message_id": "<m1@x>"},
        parsed=parsed,
    )

    result = await runner.run_for_internal_id(7)

    assert result["ok"] is True
    backend.fetch_email_content_by_id.assert_called_once_with(7, "收件箱")
    runner._reader.parse_email_source.assert_called_once()
    assert processor.process_email.await_args.args[0] is parsed


@pytest.mark.asyncio
async def test_local_lookup_error_falls_back_to_backend(monkeypatch, tmp_path):
    parsed = SimpleNamespace(mailbox=None, internal_id=None)
    runner, processor, backend, _ = _build(
        monkeypatch,
        tmp_path,
        body=None,
        fetch_result={"source": "raw", "message_id": "<m1@x>"},
        parsed=parsed,
    )
    runner._repo.get_body.side_effect = RuntimeError("database is locked")

    result = await runner.run_for_internal_id(7)

    assert result["ok"] is True
    backend.fetch_email_content_by_id.assert_called_once()
    assert processor.process_email.await_args.args[0] is parsed


@pytest.mark.asyncio
async def test_fallback_fetch_failure_still_marks_failed(monkeypatch, tmp_path):
    runner, processor, backend, store = _build(
        monkeypatch, tmp_path, body=None, fetch_result=None
    )

    result = await runner.run_for_internal_id(7)

    assert result["ok"] is False
    assert "AppleScript fetch failed" in result["error"]
    assert (result["retry_count"], result["status"]) == (1, "failed")
    assert store.get(7)["retry_count"] == 1
    backend.fetch_email_content_by_id.assert_called_once()
    processor.process_email.assert_not_awaited()
