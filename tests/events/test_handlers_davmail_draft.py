"""EventHandlers._create_draft_via_imap 测试 — davmail mode draft 创建路径.

覆盖 review HIGH/MEDIUM:
- HIGH #4: References chain (thread_id + message_id) 正确拼接 → Outlook fold
- MEDIUM: _split_addrs 用 getaddresses, quoted display name with comma 不错切
- reply-all dedup + 自己邮箱排除 + Re: 主题 处理
- backend.append_draft 失败 → publish error 不 throw
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.events.handlers import EventHandlers
from src.mail.backend.types import DraftAppendResult, DraftRequest


# --------- _split_addrs (MEDIUM: quoted display name with comma) ---------

def test_split_addrs_simple():
    out = EventHandlers._split_addrs("a@x.com, b@y.com")
    assert out == ["a@x.com", "b@y.com"]


def test_split_addrs_semicolon_separator():
    out = EventHandlers._split_addrs("a@x.com; b@y.com")
    assert out == ["a@x.com", "b@y.com"]


def test_split_addrs_with_display_names():
    out = EventHandlers._split_addrs('"Foo" <foo@x.com>, Bar <bar@y.com>')
    assert out == ["foo@x.com", "bar@y.com"]


def test_split_addrs_quoted_display_with_comma():
    """MEDIUM: `"LastName, FirstName" <a@b>` 不能错切."""
    out = EventHandlers._split_addrs(
        '"Doe, John" <john@x.com>, "Smith, Jane" <jane@y.com>'
    )
    assert out == ["john@x.com", "jane@y.com"]


def test_split_addrs_empty():
    assert EventHandlers._split_addrs("") == []
    assert EventHandlers._split_addrs("   ") == []


# --------- _create_draft_via_imap full flow ---------

@pytest.fixture
def handlers_with_mock_backend():
    """构造 EventHandlers, backend / sync_store / notion_sync 全 mock."""
    sync_store = MagicMock()
    feishu = None
    notion_sync = MagicMock()
    notion_sync.update_page_mail_sync_status = AsyncMock()

    backend = MagicMock()
    backend.backend_origin = "davmail"

    h = EventHandlers(
        backend=backend,
        sync_store=sync_store,
        feishu=feishu,
        notion_sync=notion_sync,
        result_callback=AsyncMock(),
    )
    return h, backend, sync_store, notion_sync


@pytest.mark.asyncio
async def test_create_draft_via_imap_reply_all_excludes_self(
    handlers_with_mock_backend, monkeypatch
):
    """reply-all 应该排除自己 user_email, 且 dedup."""
    h, backend, sync_store, notion_sync = handlers_with_mock_backend

    from src.config import config as cfg
    monkeypatch.setattr(cfg, "user_email", "me@x.com", raising=False)

    sync_store.get = MagicMock(return_value={
        "internal_id": 42,
        "sender": "boss@x.com",
        "to_addr": "me@x.com, peer@x.com",
        "cc_addr": "team@x.com, me@x.com",
        "subject": "Question",
        "thread_id": "abc@x",
    })
    backend.append_draft = MagicMock(return_value=DraftAppendResult(
        success=True, drafts_folder="Drafts", appended_uid=777, method="imap_append",
    ))

    event = {
        "id": "evt-1",
        "page_id": "page-1",
        "properties": {
            "mode": "reply-all",
            "message_id": "orig@x",
            "reply_suggestion": "Sure!",
        },
    }

    await h._create_draft_via_imap(
        event=event, event_id="evt-1", page_id="page-1",
        internal_id=42, message_id="orig@x",
        reply_suggestion="Sure!", reply_suggestion_rich=None,
        props=event["properties"], mailbox="收件箱", _t0=0.0,
    )

    backend.append_draft.assert_called_once()
    draft: DraftRequest = backend.append_draft.call_args.args[0]
    assert "me@x.com" not in draft.to
    assert "me@x.com" not in draft.cc
    assert "boss@x.com" in draft.to
    assert "peer@x.com" in draft.to
    assert "team@x.com" in draft.cc
    # 自己邮箱已排除, 但 boss + peer 必须保留
    assert h._stats["create_draft_success"] == 1


@pytest.mark.asyncio
async def test_create_draft_via_imap_references_chain(
    handlers_with_mock_backend, monkeypatch
):
    """HIGH #4: References chain 应该包含 thread_id + message_id."""
    h, backend, sync_store, notion_sync = handlers_with_mock_backend

    from src.config import config as cfg
    monkeypatch.setattr(cfg, "user_email", "me@x.com", raising=False)

    sync_store.get = MagicMock(return_value={
        "internal_id": 100,
        "sender": "a@x.com",
        "to_addr": "me@x.com",
        "cc_addr": "",
        "subject": "Re: Hello",
        "thread_id": "head@x",  # 线程头 msgid (不同于当前 message_id)
    })
    backend.append_draft = MagicMock(return_value=DraftAppendResult(
        success=True, drafts_folder="Drafts", appended_uid=1, method="imap_append",
    ))

    event = {"id": "e", "page_id": "p", "properties": {"reply_suggestion": "OK"}}
    await h._create_draft_via_imap(
        event=event, event_id="e", page_id="p",
        internal_id=100, message_id="reply@x",
        reply_suggestion="OK", reply_suggestion_rich=None,
        props=event["properties"], mailbox="收件箱", _t0=0.0,
    )

    draft: DraftRequest = backend.append_draft.call_args.args[0]
    # In-Reply-To: 原邮件 msgid 加 <>
    assert draft.in_reply_to == "<reply@x>"
    # References: thread_id + msgid 两个都有
    assert draft.references is not None
    assert "<head@x>" in draft.references
    assert "<reply@x>" in draft.references


@pytest.mark.asyncio
async def test_create_draft_via_imap_re_prefix_not_doubled(
    handlers_with_mock_backend, monkeypatch
):
    """主题已含 'Re:' 不再重复加."""
    h, backend, sync_store, _ = handlers_with_mock_backend
    from src.config import config as cfg
    monkeypatch.setattr(cfg, "user_email", "me@x.com", raising=False)

    sync_store.get = MagicMock(return_value={
        "internal_id": 1, "sender": "a@x", "to_addr": "me@x.com",
        "cc_addr": "", "subject": "Re: Important",
        "thread_id": None,
    })
    backend.append_draft = MagicMock(return_value=DraftAppendResult(
        success=True, drafts_folder="Drafts",
    ))
    event = {"id": "e", "page_id": "p", "properties": {"reply_suggestion": "OK"}}
    await h._create_draft_via_imap(
        event=event, event_id="e", page_id="p",
        internal_id=1, message_id="m@x",
        reply_suggestion="OK", reply_suggestion_rich=None,
        props=event["properties"], mailbox="收件箱", _t0=0.0,
    )
    draft = backend.append_draft.call_args.args[0]
    # 不应该出现 "Re: Re:"
    assert draft.subject == "Re: Important"


@pytest.mark.asyncio
async def test_create_draft_via_imap_new_mode_uses_explicit_to(
    handlers_with_mock_backend, monkeypatch
):
    """mode=new 时不查 sync_store, 用 props.to_email."""
    h, backend, sync_store, _ = handlers_with_mock_backend
    from src.config import config as cfg
    monkeypatch.setattr(cfg, "user_email", "me@x.com", raising=False)

    backend.append_draft = MagicMock(return_value=DraftAppendResult(
        success=True, drafts_folder="Drafts",
    ))
    event = {
        "id": "e", "page_id": "p",
        "properties": {
            "mode": "new",
            "to_email": "recipient@x.com",
            "subject": "Brand New",
            "reply_suggestion": "Greetings",
        },
    }
    await h._create_draft_via_imap(
        event=event, event_id="e", page_id="p",
        internal_id=None, message_id="",
        reply_suggestion="Greetings", reply_suggestion_rich=None,
        props=event["properties"], mailbox="收件箱", _t0=0.0,
    )
    draft = backend.append_draft.call_args.args[0]
    assert "recipient@x.com" in draft.to
    assert draft.subject == "Brand New"
    # new mode 没原邮件 → 没 In-Reply-To / References
    assert draft.in_reply_to is None
    assert draft.references is None


@pytest.mark.asyncio
async def test_create_draft_via_imap_append_failure(
    handlers_with_mock_backend, monkeypatch
):
    """backend.append_draft 失败 → publish error, 不 throw."""
    h, backend, sync_store, _ = handlers_with_mock_backend
    from src.config import config as cfg
    monkeypatch.setattr(cfg, "user_email", "me@x.com", raising=False)

    sync_store.get = MagicMock(return_value={
        "internal_id": 1, "sender": "a@x", "to_addr": "",
        "cc_addr": "", "subject": "X", "thread_id": None,
    })
    backend.append_draft = MagicMock(return_value=DraftAppendResult(
        success=False, drafts_folder="Drafts", error="IMAP timeout",
    ))
    event = {"id": "e", "page_id": "p", "properties": {"reply_suggestion": "x"}}

    await h._create_draft_via_imap(
        event=event, event_id="e", page_id="p",
        internal_id=1, message_id="m@x",
        reply_suggestion="x", reply_suggestion_rich=None,
        props=event["properties"], mailbox="收件箱", _t0=0.0,
    )
    assert h._stats["create_draft_error"] == 1
    h._result_callback.assert_called_once()
    callback_payload = h._result_callback.call_args.args[1]
    assert callback_payload["status"] == "error"
    assert "IMAP timeout" in callback_payload["error"]


@pytest.mark.asyncio
async def test_create_draft_via_imap_extra_to_cc_merge(
    handlers_with_mock_backend, monkeypatch
):
    """props.extra_to / extra_cc 应该 merge 到收件人 + dedup."""
    h, backend, sync_store, _ = handlers_with_mock_backend
    from src.config import config as cfg
    monkeypatch.setattr(cfg, "user_email", "me@x.com", raising=False)

    sync_store.get = MagicMock(return_value={
        "internal_id": 1, "sender": "a@x", "to_addr": "",
        "cc_addr": "", "subject": "X", "thread_id": None,
    })
    backend.append_draft = MagicMock(return_value=DraftAppendResult(
        success=True, drafts_folder="Drafts",
    ))
    event = {
        "id": "e", "page_id": "p",
        "properties": {
            "extra_to": "extra1@x, extra2@x",
            "extra_cc": "ec@x",
            "reply_suggestion": "x",
        },
    }
    await h._create_draft_via_imap(
        event=event, event_id="e", page_id="p",
        internal_id=1, message_id="m@x",
        reply_suggestion="x", reply_suggestion_rich=None,
        props=event["properties"], mailbox="收件箱", _t0=0.0,
    )
    draft = backend.append_draft.call_args.args[0]
    # extra_to 应在前 (with a@x 原 sender 排前)
    assert "a@x" in draft.to
    assert "extra1@x" in draft.to
    assert "extra2@x" in draft.to
    assert "ec@x" in draft.cc
