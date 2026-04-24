"""Tests for LLMProcessor builders + sanitizer (no network)."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from src.llm_agent.client import LLMResult
from src.llm_agent.processor import LLMProcessor


def _fake_email(**overrides):
    base = dict(
        mailbox="收件箱",
        subject="Test Subject",
        sender="a@example.com",
        sender_name="Sender A",
        to="b@example.com",
        cc="",
        date=datetime(2026, 4, 23, 22, 30, tzinfo=timezone(timedelta(hours=-7))),
        thread_id="tid-001",
        has_attachments=False,
        is_flagged=False,
        is_read=False,
        attachments=[],
        text="Hello there. Some body text.",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _bare_processor() -> LLMProcessor:
    """Bypass __init__ to avoid creating real AnthropicClient / loaders."""
    p = LLMProcessor.__new__(LLMProcessor)
    p._client = None
    p._prompts = None
    p._context = None
    return p


def test_build_user_contains_subject_and_from():
    p = _bare_processor()
    msg = p._build_user(_fake_email())
    assert "Test Subject" in msg
    assert "a@example.com" in msg


def test_build_user_derives_utc8_date():
    p = _bare_processor()
    # PDT 22:30 + 7h → UTC 05:30 next day → UTC+8 13:30 on 2026-04-24
    msg = p._build_user(_fake_email())
    assert "2026-04-24" in msg


def test_build_user_truncates_body(monkeypatch):
    from src.llm_agent import processor as mod
    monkeypatch.setattr(mod.cfg, "llm_body_max_chars", 50)
    p = _bare_processor()
    msg = p._build_user(_fake_email(text="x" * 500))
    assert "[truncated]" in msg


def test_plaintext_body_strips_html_when_no_text():
    p = _bare_processor()
    email = _fake_email(text=None, html="<p>Hello <b>bold</b></p>")
    body = p._plaintext_body(email)
    assert "Hello" in body
    assert "<p>" not in body and "<b>" not in body


def test_parse_sanitizes_bad_priority():
    p = _bare_processor()
    result = LLMResult(
        tool_input={
            "ai_summary": "s", "category": "💼 产品管理",
            "language": "中文", "sender_priority": "核心团队",
            "action_required": True, "action_type": "需要回复",
            "priority": "超紧急!!",
        },
        input_tokens=100, output_tokens=50,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        model="test-model", latency_ms=100,
    )
    labels = p._parse(result, "收件箱")
    assert labels.priority == "🟢 一般"


def test_parse_rejects_mismatched_action_type():
    p = _bare_processor()
    result = LLMResult(
        tool_input={
            "ai_summary": "s", "category": "💼 产品管理",
            "language": "中文", "sender_priority": "核心团队",
            "action_required": True,
            "action_type": "等待响应",    # sent-box only
            "priority": "🟢 一般",
        },
        input_tokens=100, output_tokens=50,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        model="test", latency_ms=100,
    )
    labels = p._parse(result, "收件箱")  # inbox disallows 等待响应
    assert labels.action_type == "仅供参考"


def test_parse_accepts_correct_sent_action_type():
    p = _bare_processor()
    result = LLMResult(
        tool_input={
            "ai_summary": "s", "category": "💼 产品管理",
            "language": "中文", "sender_priority": "核心团队",
            "action_required": True,
            "action_type": "需要跟进",
            "priority": "🟡 重要",
        },
        input_tokens=100, output_tokens=50,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        model="test", latency_ms=100,
    )
    labels = p._parse(result, "发件箱")
    assert labels.action_type == "需要跟进"
    assert labels.mailbox == "发件箱"


def test_parse_drops_bad_daily_digest_date():
    p = _bare_processor()
    result = LLMResult(
        tool_input={
            "ai_summary": "s", "category": "💼 产品管理",
            "language": "中文", "sender_priority": "核心团队",
            "action_required": False, "action_type": "仅供参考",
            "priority": "🟢 一般",
            "daily_digest_date": "not-a-date",
        },
        input_tokens=0, output_tokens=0,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        model="m", latency_ms=0,
    )
    labels = p._parse(result, "收件箱")
    assert labels.daily_digest_date == ""


def test_parse_keeps_valid_daily_digest_date():
    p = _bare_processor()
    result = LLMResult(
        tool_input={
            "ai_summary": "s", "category": "💼 产品管理",
            "language": "中文", "sender_priority": "核心团队",
            "action_required": False, "action_type": "仅供参考",
            "priority": "🟢 一般",
            "daily_digest_date": "2026-04-24",
        },
        input_tokens=0, output_tokens=0,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        model="m", latency_ms=0,
    )
    labels = p._parse(result, "收件箱")
    assert labels.daily_digest_date == "2026-04-24"


def test_parse_filters_bad_mail_actions():
    p = _bare_processor()
    result = LLMResult(
        tool_input={
            "ai_summary": "s", "category": "💼 产品管理",
            "language": "中文", "sender_priority": "核心团队",
            "action_required": False, "action_type": "仅供参考",
            "priority": "🟢 一般",
            "mail_actions": ["⭐ Starred", "unknown", "⚠️ Flagged"],
        },
        input_tokens=0, output_tokens=0,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        model="m", latency_ms=0,
    )
    labels = p._parse(result, "收件箱")
    assert labels.mail_actions == ["⭐ Starred", "⚠️ Flagged"]


def test_parse_clears_out_of_enum_sender_priority():
    p = _bare_processor()
    result = LLMResult(
        tool_input={
            "ai_summary": "s", "category": "💼 产品管理",
            "language": "中文",
            "sender_priority": "VIP 客户",  # not in enum
            "action_required": False, "action_type": "仅供参考",
            "priority": "🟢 一般",
        },
        input_tokens=0, output_tokens=0,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        model="m", latency_ms=0,
    )
    labels = p._parse(result, "收件箱")
    assert labels.sender_priority == ""


def test_summary_for_log_does_not_leak_full_reply():
    p = _bare_processor()
    result = LLMResult(
        tool_input={
            "ai_summary": "A" * 500, "category": "💼 产品管理",
            "language": "中文", "sender_priority": "核心团队",
            "action_required": True, "action_type": "需要回复",
            "priority": "🟡 重要",
        },
        input_tokens=1000, output_tokens=200,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        model="m", latency_ms=100,
    )
    labels = p._parse(result, "收件箱")
    s = labels.summary_for_log()
    assert len(s["ai_summary"]) <= 80
