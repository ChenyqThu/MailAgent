"""Tests for src.kos.producer (PR-2d).

覆盖:
    - normalize_message_id_for_slug 各种 RFC 2822 message-id 形态
    - priority_at_or_above 5-档 hierarchy
    - build_kos_page_payload 完整 frontmatter + body
    - push_email_to_kos: priority floor / not_configured / dry_run /
      success / KOSError / unexpected exception
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock

import pytest

from src.kos.client import KOSClient, KOSError
from src.kos.producer import (
    build_kos_page_payload,
    normalize_message_id_for_slug,
    priority_at_or_above,
    push_email_to_kos,
)
from src.models import Email


# ============================================================
# Helpers
# ============================================================

def _make_email(
    *,
    message_id: str = "<abc.123@example.com>",
    subject: str = "Test Subject",
    sender: str = "alice@example.com",
    sender_name: str = "Alice",
    mailbox: str = "收件箱",
    date: datetime = datetime(2026, 5, 23, 10, 30, 0),
) -> Email:
    return Email(
        message_id=message_id,
        subject=subject,
        sender=sender,
        sender_name=sender_name,
        mailbox=mailbox,
        date=date,
    )


# ============================================================
# normalize_message_id_for_slug
# ============================================================

class TestNormalizeMessageId:
    def test_basic_rfc2822_form(self):
        assert (
            normalize_message_id_for_slug("<abc.123@host.com>")
            == "abc-123-host-com"
        )

    def test_lowercase_applied(self):
        assert normalize_message_id_for_slug("<ABC.DEF@HOST>") == "abc-def-host"

    def test_strips_angle_brackets(self):
        assert normalize_message_id_for_slug("<msg-1@x>") == "msg-1-x"

    def test_no_brackets_ok(self):
        assert normalize_message_id_for_slug("plain-id-123") == "plain-id-123"

    def test_collapses_consecutive_punct(self):
        assert (
            normalize_message_id_for_slug("<a..b...c+++d@x>") == "a-b-c-d-x"
        )

    def test_trims_edge_dashes(self):
        assert normalize_message_id_for_slug("---foo---bar---") == "foo-bar"

    def test_empty_returns_unknown(self):
        assert normalize_message_id_for_slug("") == "unknown"

    def test_only_punct_returns_unknown(self):
        assert normalize_message_id_for_slug("<<>>") == "unknown"


# ============================================================
# priority_at_or_above
# ============================================================

class TestPriorityFloor:
    @pytest.mark.parametrize("actual,floor,expected", [
        # Equal or above
        ("critical", "normal", True),
        ("urgent", "normal", True),
        ("important", "normal", True),
        ("normal", "normal", True),
        ("low", "normal", False),
        # Above floor 'important'
        ("critical", "important", True),
        ("urgent", "important", True),
        ("important", "important", True),
        ("normal", "important", False),
        ("low", "important", False),
        # Floor 'low' = pass-through
        ("low", "low", True),
        ("normal", "low", True),
        # Floor 'critical' = strict
        ("critical", "critical", True),
        ("urgent", "critical", False),
    ])
    def test_priority_combos(self, actual, floor, expected):
        assert priority_at_or_above(actual, floor) is expected

    def test_unknown_actual_treated_as_normal(self):
        # 'foo' 不是合法 priority → 视为 normal
        assert priority_at_or_above("foo", "normal") is True
        assert priority_at_or_above("foo", "important") is False

    def test_unknown_floor_treated_as_normal(self):
        assert priority_at_or_above("low", "garbage") is False  # low < normal
        assert priority_at_or_above("important", "garbage") is True

    def test_none_actual_treated_as_normal(self):
        assert priority_at_or_above(None, "normal") is True
        assert priority_at_or_above(None, "important") is False

    def test_case_insensitive(self):
        assert priority_at_or_above("CRITICAL", "normal") is True
        assert priority_at_or_above("Important", "Normal") is True

    def test_cn_emoji_enum_maps_to_english(self):
        """LLM agent 中文 emoji enum '🟡 重要' 等 → 英文 normalize 后比较."""
        # 紧急 = critical, 高于 normal
        assert priority_at_or_above("🔴 紧急", "normal") is True
        # 重要 = important, 等于 important
        assert priority_at_or_above("🟡 重要", "important") is True
        # 一般 = normal, 等于 normal 通过, 低于 important 不通过
        assert priority_at_or_above("🟢 一般", "normal") is True
        assert priority_at_or_above("🟢 一般", "important") is False
        # 低 = low, 低于 normal 不通过
        assert priority_at_or_above("⚪ 低", "normal") is False
        # 中文 vs 中文 floor 也能比
        assert priority_at_or_above("🟡 重要", "🟢 一般") is True
        assert priority_at_or_above("⚪ 低", "🟡 重要") is False


# ============================================================
# build_kos_page_payload
# ============================================================

class TestBuildKosPagePayload:
    def test_slug_format(self):
        email = _make_email(message_id="<abc.123@example.com>")
        slug, _ = build_kos_page_payload(email, internal_id=42)
        assert slug == "sources/mailagent-abc-123-example-com"

    def test_slug_fallback_to_internal_id_when_no_message_id(self):
        email = _make_email(message_id="placeholder")
        # 实际 build 用 message_id 走 normalize; '' 时 fallback internal_id
        email.message_id = ""
        # __post_init__ 校验 message_id 必填, 不能为空; 我们手动绕 (因测试):
        # 直接构造时 message_id 必须非空, 这个 case 模拟跑入空 fallback
        # 路径 — 真生产场景不会触发, 但 build 函数应该兜底
        slug, _ = build_kos_page_payload(email, internal_id=999)
        assert slug == "sources/mailagent-999"

    def test_frontmatter_contains_required_fields(self):
        email = _make_email()
        _, content = build_kos_page_payload(
            email, internal_id=100,
            notion_page_id="abc-def-123",
            ai_priority="important",
            ai_action="需要回复",
        )
        assert content.startswith("---\n")
        # 检查 frontmatter 关键字段
        for token in (
            "type: source",
            "title: 'Test Subject'",
            "source_of_truth: mailagent-sqlite",
            "ai_priority: 'important'",
            "ai_action:",  # 中文 value YAML quote 形式
            "mailagent_internal_id: 100",
        ):
            assert token in content, f"frontmatter missing {token!r}"

    def test_source_refs_includes_notion_url(self):
        email = _make_email()
        _, content = build_kos_page_payload(
            email, internal_id=100, notion_page_id="page-abc-def",
        )
        # notion URL 去 dash
        assert "https://www.notion.so/pageabcdef" in content
        # mailagent ref
        assert "'mailagent:<abc.123@example.com>'" in content

    def test_tags_include_priority_and_mailbox(self):
        email = _make_email(mailbox="收件箱")
        _, content = build_kos_page_payload(
            email, internal_id=100, ai_priority="critical"
        )
        assert "priority-critical" in content
        assert "mailbox-inbox" in content

    def test_tags_unknown_priority_skipped(self):
        email = _make_email()
        _, content = build_kos_page_payload(
            email, internal_id=100, ai_priority="bogus"
        )
        assert "priority-bogus" not in content

    def test_cn_emoji_priority_normalized_to_english_tag(self):
        """LLM 中文 enum '🟡 重要' → frontmatter tag 'priority-important'.

        tag 用英文 normalize 让 KOS 端跨 namespace tag 过滤一致;
        ai_priority: 字段仍保留中文 raw enum 给图谱 entity 看原始 label.
        """
        email = _make_email()
        _, content = build_kos_page_payload(
            email, internal_id=100, ai_priority="🟡 重要"
        )
        assert "priority-important" in content    # tag 是英文 normalize
        assert "ai_priority: '🟡 重要'" in content  # raw enum 保留在字段里

        _, content2 = build_kos_page_payload(
            email, internal_id=101, ai_priority="🔴 紧急"
        )
        assert "priority-critical" in content2
        assert "ai_priority: '🔴 紧急'" in content2

        _, content3 = build_kos_page_payload(
            email, internal_id=102, ai_priority="⚪ 低"
        )
        assert "priority-low" in content3
        assert "ai_priority: '⚪ 低'" in content3

    def test_mailbox_sent_tag(self):
        email = _make_email(mailbox="发件箱")
        _, content = build_kos_page_payload(email, internal_id=100)
        assert "mailbox-sent" in content

    def test_body_appended_after_frontmatter(self):
        email = _make_email(subject="Q3 Review")
        _, content = build_kos_page_payload(
            email, internal_id=100,
            body_markdown="Body line 1\n\nBody line 2",
        )
        assert "# Q3 Review" in content
        assert "Body line 1" in content
        assert "Body line 2" in content
        # frontmatter 在 body 之前
        assert content.index("---") < content.index("Body line 1")

    def test_empty_body_placeholder(self):
        email = _make_email()
        _, content = build_kos_page_payload(email, internal_id=100)
        assert "_(body not yet extracted)_" in content

    def test_yaml_quote_escapes_single_quote(self):
        email = _make_email(subject="It's a test")
        _, content = build_kos_page_payload(email, internal_id=100)
        # 单引号 → 重复
        assert "title: 'It''s a test'" in content


# ============================================================
# push_email_to_kos
# ============================================================

class TestPushEmailToKos:
    @pytest.fixture
    def email(self):
        return _make_email()

    @pytest.mark.asyncio
    async def test_skip_low_priority(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock()
        result = await push_email_to_kos(
            email, internal_id=1,
            ai_priority="low",
            priority_floor="normal",
            client=client,
        )
        assert result is None
        client.put_page.assert_not_called()

    @pytest.mark.asyncio
    async def test_skip_not_configured(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = False
        client.put_page = MagicMock()
        result = await push_email_to_kos(
            email, internal_id=1,
            ai_priority="critical",
            priority_floor="normal",
            client=client,
        )
        assert result is None
        client.put_page.assert_not_called()

    @pytest.mark.asyncio
    async def test_dry_run_skips_network(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock()
        result = await push_email_to_kos(
            email, internal_id=42,
            ai_priority="important",
            priority_floor="normal",
            client=client,
            dry_run=True,
            body_markdown="hello",
        )
        assert result is not None
        assert result["dry_run"] is True
        assert result["slug"].startswith("sources/mailagent-")
        assert result["content_bytes"] > 0
        client.put_page.assert_not_called()

    @pytest.mark.asyncio
    async def test_success_returns_server_payload(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock(return_value={
            "slug": "sources/mailagent-abc-123-example-com",
            "status": "created_or_updated",
            "chunks": 3,
        })
        result = await push_email_to_kos(
            email, internal_id=42,
            body_markdown="body content",
            ai_priority="important",
            priority_floor="normal",
            client=client,
        )
        assert result == {
            "slug": "sources/mailagent-abc-123-example-com",
            "status": "created_or_updated",
            "chunks": 3,
        }
        client.put_page.assert_called_once()
        # 验证传给 put_page 的 slug + content shape
        args = client.put_page.call_args.args
        assert args[0].startswith("sources/mailagent-")
        assert args[1].startswith("---\n")
        assert "body content" in args[1]

    @pytest.mark.asyncio
    async def test_kos_error_returns_none_no_raise(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock(
            side_effect=KOSError("rate limited", code="E_KOS_RATE_LIMIT", status=429)
        )
        result = await push_email_to_kos(
            email, internal_id=1,
            ai_priority="critical",
            priority_floor="normal",
            client=client,
        )
        assert result is None  # silent failure for fire-and-forget caller

    @pytest.mark.asyncio
    async def test_unexpected_exception_returns_none_no_raise(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock(side_effect=RuntimeError("boom"))
        result = await push_email_to_kos(
            email, internal_id=1,
            ai_priority="critical",
            priority_floor="normal",
            client=client,
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_uses_default_client_when_none_passed(self, email, monkeypatch):
        """没传 client 参数 → 内部 new KOSClient(); env 缺 → configured=False → skip."""
        monkeypatch.delenv("KOS_MCP_BASE", raising=False)
        monkeypatch.delenv("KOS_OAUTH_CLIENT_ID", raising=False)
        monkeypatch.delenv("KOS_OAUTH_CLIENT_SECRET", raising=False)
        result = await push_email_to_kos(
            email, internal_id=1,
            ai_priority="critical",
            priority_floor="normal",
            # client=None → 内部构造
        )
        assert result is None  # not configured → skip
