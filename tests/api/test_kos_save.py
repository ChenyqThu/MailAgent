"""src/chat/kos_save.py 纯逻辑 + 主入口测试（V2.1 3b-4）。

重点：frontmatter / slug / title 与前端 chat/kos_save.ts **字节对齐**（KOS backlinks 据
source_refs 解析 chat→email 图边）。save_conversation_to_kos 注入 mock chat_db / kos_client /
summarizer，覆盖 success(summary) / fallback(transcript) / 校验错误 / KOS 错误。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from src.chat.kos_save import (
    SaveConversationError,
    build_auto_title,
    build_conversation_page_content,
    build_conversation_slug,
    save_conversation_to_kos,
)
from src.kos.client import KOSError


# ── stubs ────────────────────────────────────────────────────────────


class _StubChatDb:
    def __init__(self, messages: List[Dict[str, Any]], session: Optional[Dict[str, Any]]):
        self._messages = messages
        self._session = session

    def get_message(self, mid: int) -> Optional[Dict[str, Any]]:
        return next((m for m in self._messages if m["id"] == mid), None)

    def get_session(self, sid: int) -> Optional[Dict[str, Any]]:
        if self._session and self._session["id"] == sid:
            return self._session
        return None

    def list_messages(self, sid: int) -> List[Dict[str, Any]]:
        return [m for m in self._messages if m["session_id"] == sid]


class _StubKos:
    def __init__(self, put_result: Optional[Dict[str, Any]] = None, raise_error: Optional[KOSError] = None):
        self.put_calls: List[tuple] = []
        self._put_result = put_result or {"slug": None, "status": "created_or_updated"}
        self._raise = raise_error

    def put_page(self, slug: str, content: str) -> Dict[str, Any]:
        self.put_calls.append((slug, content))
        if self._raise is not None:
            raise self._raise
        result = dict(self._put_result)
        if result.get("slug") is None:
            result["slug"] = slug
        return result


def _convo_chat_db() -> _StubChatDb:
    return _StubChatDb(
        messages=[
            {"id": 1, "session_id": 7, "role": "user", "content": "这封邮件讲什么?"},
            {
                "id": 2,
                "session_id": 7,
                "role": "assistant",
                "content": "讲的是 redis timeout.",
                "model": "claude-sonnet-4-6",
            },
        ],
        session={"id": 7, "email_id": 42, "backend_model": "claude-sonnet-4-6"},
    )


# ── slug / title 纯函数 ───────────────────────────────────────────────


def test_build_conversation_slug_default() -> None:
    assert (
        build_conversation_slug(email_id=42, session_id=7, message_id=99)
        == "chat-history/mailagent/42/7/99"
    )


def test_build_conversation_slug_custom_prefix() -> None:
    assert (
        build_conversation_slug(email_id=1, session_id=2, message_id=3, prefix="x/y")
        == "x/y/1/2/3"
    )


def test_build_auto_title_first_sentence() -> None:
    # 全角句号切首句（镜像 TS split(/[.。!?！?]/)）。
    assert build_auto_title("这封邮件讲什么。其它内容") == "这封邮件讲什么"


def test_build_auto_title_caps_50() -> None:
    long = "x" * 80
    assert build_auto_title(long) == "x" * 50


def test_build_auto_title_empty_fallback() -> None:
    assert build_auto_title("") == "Conversation excerpt"


def test_build_auto_title_fullwidth_bang_not_split() -> None:
    # TS char class `[.。!?!?]` 无全角 ！？（hexdump 确认）；全角不切首句 → 整句保留
    # （codex review MEDIUM parity）。
    assert build_auto_title("这是标题！还有更多内容") == "这是标题！还有更多内容"


# ── frontmatter 字节对齐（与 kos_save.ts buildConversationPageContent 一致）──────


def test_page_content_transcript_frontmatter_exact() -> None:
    """transcript fallback（summary_body=None）—— 逐字节对齐 TS。"""
    content = build_conversation_page_content(
        user_content="问题",
        assistant_content="回答",
        email_id=42,
        session_id=7,
        message_id=99,
        title="redis 讨论",
        saved_at_iso="2026-06-05T10:00:00.000Z",
        backend_model="claude-sonnet-4-6",
        summary_body=None,
        email_subject="Q review",
    )
    expected = (
        "---\n"
        "mailagent:\n"
        "  email_id: 42\n"
        "  message_id: 99\n"
        "  session_id: 7\n"
        "model: claude-sonnet-4-6\n"
        "saved_at: 2026-06-05T10:00:00.000Z\n"
        "source: mailagent-chat\n"
        "source_refs:\n"
        "  - 'sources/email/42'\n"
        "tags: [chat-history, mailagent, conversation]\n"
        'title: "redis 讨论"\n'
        "type: conversation\n"
        "---\n"
        "## User\n"
        "\n"
        "问题\n"
        "\n"
        "## Assistant\n"
        "\n"
        "回答\n"
    )
    assert content == expected


def test_page_content_transcript_omits_empty_user() -> None:
    content = build_conversation_page_content(
        user_content="",
        assistant_content="回答",
        email_id=1,
        session_id=1,
        message_id=1,
        title="t",
        saved_at_iso="2026-06-05T10:00:00.000Z",
        backend_model=None,
        summary_body=None,
    )
    assert "## User" not in content
    assert content.endswith("## Assistant\n\n回答\n")
    assert "model: unknown\n" in content  # backend_model None → 'unknown'


def test_page_content_summary_with_h1_and_subject() -> None:
    content = build_conversation_page_content(
        user_content="问题",
        assistant_content="回答",
        email_id=42,
        session_id=7,
        message_id=99,
        title="t",
        saved_at_iso="2026-06-05T10:00:00.000Z",
        backend_model="m",
        summary_body="# 主题标题\n\n## 关键结论\n- 用了 redis",
        email_subject="Q review",
    )
    # H1 后插 reference line（含 subject）；无 raw transcript。
    assert "# 主题标题\n> 关于邮件《Q review》的讨论 · 关联 sources/email/42\n\n## 关键结论" in content
    assert "## User" not in content


def test_page_content_summary_no_h1_no_subject() -> None:
    content = build_conversation_page_content(
        user_content="问题",
        assistant_content="回答",
        email_id=42,
        session_id=7,
        message_id=99,
        title="t",
        saved_at_iso="2026-06-05T10:00:00.000Z",
        backend_model="m",
        summary_body="纯文本总结没有标题",
        email_subject=None,
    )
    # 无 H1 → reference line 直接 prepend；无 subject → 通用 ref。
    assert "> 关于邮件的讨论 · 关联 sources/email/42\n\n纯文本总结没有标题" in content


# ── save_conversation_to_kos 主入口 ───────────────────────────────────


def _save(chat_db, kos, **over):
    kwargs = dict(
        chat_db=chat_db,
        kos_client=kos,
        message_id=2,
        slug=None,
        title=None,
        sync_db_path="/nonexistent/sync_store.db",  # get_email_subject → None
        saved_at_iso="2026-06-05T10:00:00.000Z",
        llm_api_key="",
        llm_api_base="",
        llm_model="",
    )
    kwargs.update(over)
    return save_conversation_to_kos(**kwargs)


def test_save_success_with_summary() -> None:
    kos = _StubKos()
    result = _save(
        _convo_chat_db(),
        kos,
        summarizer=lambda **kw: "# redis 主题\n\n## 关键结论\n- 用了 redis",
    )
    assert result["slug"] == "chat-history/mailagent/42/7/2"
    assert result["status"] == "created_or_updated"
    assert result["contentBytes"] > 0
    slug, content = kos.put_calls[0]
    assert slug == "chat-history/mailagent/42/7/2"
    assert "source_refs:\n  - 'sources/email/42'" in content
    assert "# redis 主题" in content
    # email_subject None（sync_db 不存在）→ 通用 ref line。
    assert "> 关于邮件的讨论 · 关联 sources/email/42" in content


def test_save_fallback_to_transcript_on_summarize_error() -> None:
    def _raise(**kw):
        raise RuntimeError("LLM down")

    kos = _StubKos()
    _save(_convo_chat_db(), kos, summarizer=_raise)
    _slug, content = kos.put_calls[0]
    assert "## User\n\n这封邮件讲什么?" in content
    assert "## Assistant\n\n讲的是 redis timeout." in content


def test_save_auto_title_from_user_message() -> None:
    # title 不传 → build_auto_title(user_content)；不验 content 但验不抛 + slug 默认。
    kos = _StubKos()
    result = _save(_convo_chat_db(), kos, summarizer=lambda **kw: "# t\n内容")
    assert result["slug"].endswith("/42/7/2")


def test_save_message_not_found() -> None:
    chat_db = _StubChatDb(messages=[], session=None)
    with pytest.raises(SaveConversationError) as ei:
        _save(chat_db, _StubKos(), message_id=99)
    assert ei.value.code == "E_NOT_FOUND"


def test_save_role_not_assistant() -> None:
    chat_db = _StubChatDb(
        messages=[{"id": 2, "session_id": 7, "role": "user", "content": "x"}],
        session={"id": 7, "email_id": 42, "backend_model": None},
    )
    with pytest.raises(SaveConversationError) as ei:
        _save(chat_db, _StubKos())
    assert ei.value.code == "E_INVALID_ARG"


def test_save_empty_assistant_content() -> None:
    chat_db = _StubChatDb(
        messages=[{"id": 2, "session_id": 7, "role": "assistant", "content": "   "}],
        session={"id": 7, "email_id": 42, "backend_model": None},
    )
    with pytest.raises(SaveConversationError) as ei:
        _save(chat_db, _StubKos())
    assert ei.value.code == "E_INVALID_ARG"


def test_save_invalid_message_id() -> None:
    with pytest.raises(SaveConversationError) as ei:
        _save(_convo_chat_db(), _StubKos(), message_id=-1)
    assert ei.value.code == "E_INVALID_ARG"


def test_save_kos_error_propagates_code() -> None:
    kos = _StubKos(raise_error=KOSError("rate limited", "E_KOS_RATE_LIMIT", 429))
    with pytest.raises(SaveConversationError) as ei:
        _save(_convo_chat_db(), kos, summarizer=lambda **kw: "# t\nx")
    assert ei.value.code == "E_KOS_RATE_LIMIT"


def test_save_slug_override() -> None:
    kos = _StubKos()
    result = _save(_convo_chat_db(), kos, slug="custom/slug", summarizer=lambda **kw: "# t\nx")
    assert result["slug"] == "custom/slug"
    assert kos.put_calls[0][0] == "custom/slug"
