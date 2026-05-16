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


def _bare_processor(repo=None) -> LLMProcessor:
    """Bypass __init__ to avoid creating real AnthropicClient / loaders."""
    p = LLMProcessor.__new__(LLMProcessor)
    p._client = None
    p._prompts = None
    p._context = None
    p._repo = repo
    return p


class _FakeRepo:
    """Minimal EmailRepository stub: only get_body_markdown is consulted by _plaintext_body."""

    def __init__(self, mapping=None, *, raise_on=None):
        self._mapping = mapping or {}
        self._raise_on = raise_on
        self.calls = []

    def get_body_markdown(self, internal_id, max_chars=-1):
        self.calls.append(internal_id)
        if self._raise_on is not None and internal_id == self._raise_on:
            raise RuntimeError("simulated SQLite read error")
        return self._mapping.get(internal_id)


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


# ===== v4 SSoT: SQLite markdown body 路径 =====

def test_plaintext_body_prefers_sqlite_markdown_when_hit(monkeypatch):
    """SQLite hit → 直接返回 markdown，不再做正则剥 HTML."""
    from src.llm_agent import processor as mod
    monkeypatch.setattr(mod.cfg, "llm_prefer_sqlite_body", True)

    repo = _FakeRepo(mapping={42: "# Real Markdown\n\nFrom SQLite."})
    p = _bare_processor(repo=repo)
    email = _fake_email(text="ignored fallback text", internal_id=42)

    body = p._plaintext_body(email)
    assert body == "# Real Markdown\n\nFrom SQLite."
    assert repo.calls == [42]


def test_plaintext_body_fallback_when_sqlite_miss(monkeypatch):
    """SQLite 没行（get_body_markdown=None）→ 回退到 .text 路径."""
    from src.llm_agent import processor as mod
    monkeypatch.setattr(mod.cfg, "llm_prefer_sqlite_body", True)

    repo = _FakeRepo(mapping={})  # no entry for 99
    p = _bare_processor(repo=repo)
    email = _fake_email(text="fallback wins", internal_id=99)

    body = p._plaintext_body(email)
    assert body == "fallback wins"
    assert repo.calls == [99]


def test_plaintext_body_fallback_when_empty_markdown(monkeypatch):
    """SQLite 返回空串（body_format='empty'）→ 回退."""
    from src.llm_agent import processor as mod
    monkeypatch.setattr(mod.cfg, "llm_prefer_sqlite_body", True)

    repo = _FakeRepo(mapping={42: ""})
    p = _bare_processor(repo=repo)
    email = _fake_email(text="fallback wins again", internal_id=42)

    body = p._plaintext_body(email)
    assert body == "fallback wins again"


def test_plaintext_body_fallback_when_internal_id_missing(monkeypatch):
    """email 没有 internal_id 属性 → 不查 SQLite，走 fallback."""
    from src.llm_agent import processor as mod
    monkeypatch.setattr(mod.cfg, "llm_prefer_sqlite_body", True)

    repo = _FakeRepo(mapping={1: "would have been SQLite"})
    p = _bare_processor(repo=repo)
    # _fake_email 不设 internal_id
    email = _fake_email(text="no id → fallback")

    body = p._plaintext_body(email)
    assert body == "no id → fallback"
    assert repo.calls == []  # 完全没查 SQLite


def test_plaintext_body_fallback_when_repo_is_none(monkeypatch):
    """repo=None → 完全不走 SQLite 路径."""
    from src.llm_agent import processor as mod
    monkeypatch.setattr(mod.cfg, "llm_prefer_sqlite_body", True)

    p = _bare_processor(repo=None)
    email = _fake_email(text="repo=None fallback", internal_id=42)

    body = p._plaintext_body(email)
    assert body == "repo=None fallback"


def test_plaintext_body_fallback_when_flag_disabled(monkeypatch):
    """LLM_PREFER_SQLITE_BODY=false → 即便 repo 有也走 fallback（灰度逃生开关）."""
    from src.llm_agent import processor as mod
    monkeypatch.setattr(mod.cfg, "llm_prefer_sqlite_body", False)

    repo = _FakeRepo(mapping={42: "should NOT be returned"})
    p = _bare_processor(repo=repo)
    email = _fake_email(text="flag-off fallback", internal_id=42)

    body = p._plaintext_body(email)
    assert body == "flag-off fallback"
    assert repo.calls == []  # 开关关闭时连 SQLite 都不查


def test_plaintext_body_fallback_when_sqlite_raises(monkeypatch):
    """SQLite 抛异常 → warning + fallback，不让 LLM hook 整体挂掉."""
    from src.llm_agent import processor as mod
    monkeypatch.setattr(mod.cfg, "llm_prefer_sqlite_body", True)

    repo = _FakeRepo(mapping={}, raise_on=42)
    p = _bare_processor(repo=repo)
    email = _fake_email(text="exception fallback", internal_id=42)

    body = p._plaintext_body(email)
    assert body == "exception fallback"


def test_plaintext_body_sqlite_overrides_html_fallback(monkeypatch):
    """SQLite hit 应抢在 .html / content_type 之前 —— 验证优先级."""
    from src.llm_agent import processor as mod
    monkeypatch.setattr(mod.cfg, "llm_prefer_sqlite_body", True)

    repo = _FakeRepo(mapping={42: "**Cleaned**: from markdownify"})
    p = _bare_processor(repo=repo)
    # text=None 触发 .html 路径；但 SQLite 应该先命中
    email = _fake_email(
        text=None,
        html="<p>Raw HTML that would be regex-stripped</p>",
        internal_id=42,
    )

    body = p._plaintext_body(email)
    assert "Cleaned" in body
    assert "Raw HTML" not in body


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
