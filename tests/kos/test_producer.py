"""Tests for src.kos.producer (Scenario B — doc §4 形状, 2026-05-26 重构).

覆盖:
    - normalize_message_id_for_slug 各种 RFC 2822 message-id 形态 (保留 helper)
    - priority_at_or_above 5-档 hierarchy
    - build_kos_page_payload: slug=sources/email/{id} + doc §4 frontmatter +
      mailagent: 嵌套 AI labels + body (subject/metadata/正文/AI 分析/附件) + 截断
    - push_email_to_kos: priority floor / not_configured / dry_run /
      success / KOSError / unexpected exception
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock

import pytest

from src.kos.client import KOSClient, KOSError
from src.kos.producer import (
    LABEL_KNOWN,
    LABEL_MISSING,
    LABEL_UNKNOWN,
    build_kos_page_payload,
    is_labeled,
    normalize_message_id_for_slug,
    passes_priority_gate,
    priority_at_or_above,
    priority_label_state,
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
# normalize_message_id_for_slug (保留 backward-compat helper)
# ============================================================

class TestNormalizeMessageId:
    def test_basic_rfc2822_form(self):
        assert normalize_message_id_for_slug("<abc.123@host.com>") == "abc-123-host-com"

    def test_lowercase_applied(self):
        assert normalize_message_id_for_slug("<ABC.DEF@HOST>") == "abc-def-host"

    def test_strips_angle_brackets(self):
        assert normalize_message_id_for_slug("<msg-1@x>") == "msg-1-x"

    def test_no_brackets_ok(self):
        assert normalize_message_id_for_slug("plain-id-123") == "plain-id-123"

    def test_collapses_consecutive_punct(self):
        assert normalize_message_id_for_slug("<a..b...c+++d@x>") == "a-b-c-d-x"

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
        ("critical", "normal", True),
        ("urgent", "normal", True),
        ("important", "normal", True),
        ("normal", "normal", True),
        ("low", "normal", False),
        ("critical", "important", True),
        ("urgent", "important", True),
        ("important", "important", True),
        ("normal", "important", False),
        ("low", "important", False),
        ("low", "low", True),
        ("normal", "low", True),
        ("critical", "critical", True),
        ("urgent", "critical", False),
    ])
    def test_priority_combos(self, actual, floor, expected):
        assert priority_at_or_above(actual, floor) is expected

    def test_unknown_actual_treated_as_normal(self):
        assert priority_at_or_above("foo", "normal") is True
        assert priority_at_or_above("foo", "important") is False

    def test_unknown_floor_treated_as_normal(self):
        assert priority_at_or_above("low", "garbage") is False
        assert priority_at_or_above("important", "garbage") is True

    def test_none_actual_treated_as_normal(self):
        assert priority_at_or_above(None, "normal") is True
        assert priority_at_or_above(None, "important") is False

    def test_case_insensitive(self):
        assert priority_at_or_above("CRITICAL", "normal") is True
        assert priority_at_or_above("Important", "Normal") is True

    def test_cn_emoji_enum_maps_to_english(self):
        assert priority_at_or_above("🔴 紧急", "normal") is True
        assert priority_at_or_above("🟡 重要", "important") is True
        assert priority_at_or_above("🟢 一般", "normal") is True


class TestRequireLabeledGate:
    """issue #49 — 「AI 从未标注」第三态, 不该被隐式并入 normal 由 floor 放行。"""

    @pytest.mark.parametrize("raw", [None, "", "   "])
    def test_is_labeled_false_for_missing(self, raw):
        assert is_labeled(raw) is False

    @pytest.mark.parametrize("raw", ["normal", "🟡 重要", "CRITICAL"])
    def test_is_labeled_true_only_for_known_enum(self, raw):
        assert is_labeled(raw) is True

    @pytest.mark.parametrize("raw", ["foo", "P0", "很急"])
    def test_unknown_value_is_not_labeled(self, raw):
        """野值不算「已标注」—— _normalize_priority 会把它降成 normal, floor=normal
        下同样被放行, 跟 #49 抱怨的「未标注被当 normal」是同一类 bug。
        （codex review MEDIUM-2；来源: Notion 人工字段 / 自定义 agent /
        upsert_external_labels，store 层不校验枚举。）"""
        assert is_labeled(raw) is False
        assert priority_label_state(raw) == LABEL_UNKNOWN
        assert passes_priority_gate(raw, "normal", require_labeled=True) is False
        # 但默认 off 时行为不变 —— 仍按 normal 放行。
        assert passes_priority_gate(raw, "normal") is True

    @pytest.mark.parametrize("raw,expected", [
        (None, LABEL_MISSING), ("", LABEL_MISSING), ("  ", LABEL_MISSING),
        ("foo", LABEL_UNKNOWN),
        ("low", LABEL_KNOWN), ("🔴 紧急", LABEL_KNOWN),
    ])
    def test_三态分类(self, raw, expected):
        """missing / unknown 必须分开计数 —— 合成一个数字正是 #49 的病根。"""
        assert priority_label_state(raw) == expected

    @pytest.mark.parametrize("actual,floor", [
        (None, "normal"), ("", "normal"), (None, "low"), (None, "critical"),
        ("low", "normal"), ("critical", "normal"), ("normal", "normal"),
        ("foo", "normal"), ("foo", "important"),
    ])
    def test_default_off_matches_priority_at_or_above(self, actual, floor):
        """默认 require_labeled=False 时**过滤语义**逐 case 等价于旧行为。

        注意口径: 等价的是「放行/阻断」的判定, 不是 bulk 的 stats dict / 日志字节
        —— 那两处新增了 skipped_unlabeled / skipped_invalid_priority 计数键和
        require_labeled 字段 (codex review LOW-2 纠正了原先「逐字节不变」的说法)。
        """
        assert passes_priority_gate(actual, floor) is priority_at_or_above(actual, floor)

    def test_on_blocks_unlabeled_even_at_lowest_floor(self):
        """require_labeled 与 floor 独立: floor='low' 也不该把未标注放行。"""
        assert passes_priority_gate(None, "low", require_labeled=True) is False
        assert passes_priority_gate("", "normal", require_labeled=True) is False

    def test_on_keeps_labeled_filtering_by_floor(self):
        """已标注的仍按 floor 正常过滤, gate 不改这一半语义。"""
        assert passes_priority_gate("critical", "normal", require_labeled=True) is True
        assert passes_priority_gate("low", "normal", require_labeled=True) is False


class TestPushRequireLabeled:
    """issue #49 在增量 producer 侧的接线。"""

    @pytest.mark.asyncio
    async def test_unlabeled_skipped_when_required(self):
        client = MagicMock(spec=KOSClient)
        result = await push_email_to_kos(
            _make_email(), internal_id=1, client=client,
            priority_floor="low", require_labeled=True,
        )
        assert result is None
        client.put_page.assert_not_called()

    @pytest.mark.asyncio
    async def test_unlabeled_passes_when_not_required(self):
        """默认 off: 未标注仍按 normal 放行 (现状行为不变)。"""
        client = MagicMock(spec=KOSClient)
        client.configured = True
        result = await push_email_to_kos(
            _make_email(), internal_id=1, client=client,
            priority_floor="normal", dry_run=True,
        )
        assert result is not None
        assert priority_at_or_above("🟢 一般", "important") is False
        assert priority_at_or_above("⚪ 低", "normal") is False
        assert priority_at_or_above("🟡 重要", "🟢 一般") is True
        assert priority_at_or_above("⚪ 低", "🟡 重要") is False


# ============================================================
# build_kos_page_payload (Scenario B — doc §4)
# ============================================================

class TestBuildKosPagePayload:
    def test_slug_uses_internal_id(self):
        slug, _ = build_kos_page_payload(
            internal_id=42, subject="X", sender="a@b.com",
            date_iso="2026-05-23T10:30:00", mailbox="收件箱",
        )
        assert slug == "sources/email/42"

    def test_frontmatter_required_fields(self):
        _, content = build_kos_page_payload(
            internal_id=100, subject="Test Subject", sender="alice@example.com",
            date_iso="2026-05-23T10:30:00+08:00", mailbox="收件箱",
            message_id="<abc@x>", notion_page_id="abc-def-123",
            labels={"priority": "🟡 重要", "action_type": "需要回复",
                    "category": "💼 产品管理", "sender_priority": "外部联系人",
                    "language": "中文"},
        )
        assert content.startswith("---\n")
        for token in (
            "type: email",
            "kind: source",
            "title: 'Test Subject'",
            "status: stable",
            "created: '2026-05-23'",
            "date_received: '2026-05-23T10:30:00+08:00'",
            "sender: 'alice@example.com'",
            "mailbox: '收件箱'",
            "source: mailagent-emails",
            "source_of_truth: mailagent-sqlite",
            "email_id: 100",
            "ai_priority: '🟡 重要'",
            "ai_action: '需要回复'",
            "ai_category: '💼 产品管理'",
            "ai_sender_priority: '外部联系人'",
            "ai_language: '中文'",
        ):
            assert token in content, f"frontmatter missing {token!r}"

    def test_source_refs(self):
        _, content = build_kos_page_payload(
            internal_id=100, subject="X", sender="a@b",
            date_iso="2026-01-01", mailbox="收件箱", notion_page_id="page-abc-def",
        )
        assert "'mailagent:100'" in content
        assert "https://www.notion.so/pageabcdef" in content

    def test_recipient_and_cc_list(self):
        _, content = build_kos_page_payload(
            internal_id=1, subject="X", sender="a@b", date_iso="2026-01-01",
            mailbox="收件箱", to_addr="bob@x.com", cc_addr="c@x.com, d@y.com; e@z.com",
        )
        assert "recipient: 'bob@x.com'" in content
        assert "cc: ['c@x.com', 'd@y.com', 'e@z.com']" in content

    def test_body_meta_block_does_not_repeat_recipients(self):
        """issue #48: To/CC 只在 frontmatter 出现一次, body meta_block 不重复。

        重复写的代价是企业群发的长收件人名单被切成独立 chunk 进 embedding,
        语义检索时压过正文结论段落。
        """
        _, content = build_kos_page_payload(
            internal_id=1, subject="X", sender="a@b", date_iso="2026-01-01",
            mailbox="收件箱", to_addr="bob@x.com", cc_addr="c@x.com, d@y.com",
        )
        # frontmatter 与 body 的分界: body 从 "# {subject}" 起
        body = content.split("# X", 1)[1]
        assert "bob@x.com" not in body
        assert "c@x.com" not in body and "d@y.com" not in body
        # meta_block 仍保留 From / Date / Mailbox
        assert "> From: a@b" in body
        assert "> Date: 2026-01-01" in body
        assert "> Mailbox: 收件箱" in body

    def test_body_and_ai_section(self):
        _, content = build_kos_page_payload(
            internal_id=100, subject="Q3 Review", sender="a@b",
            date_iso="2026-05-23", mailbox="收件箱",
            body_markdown="Body line 1\n\nBody line 2",
            labels={"priority": "🟡 重要", "ai_summary": "这是摘要",
                    "key_points": "- 要点1\n- 要点2", "category": "💼 产品管理",
                    "action_type": "需要回复"},
        )
        assert "# Q3 Review" in content
        assert "Body line 1" in content and "Body line 2" in content
        assert "## AI 分析" in content
        assert "**摘要**: 这是摘要" in content
        assert "- 要点1" in content
        assert "分类: 💼 产品管理" in content
        assert content.index("---") < content.index("Body line 1")

    def test_no_ai_section_when_labels_empty(self):
        _, content = build_kos_page_payload(
            internal_id=1, subject="X", sender="a@b", date_iso="2026-01-01",
            mailbox="收件箱", body_markdown="just body",
        )
        assert "## AI 分析" not in content

    def test_empty_body_placeholder(self):
        _, content = build_kos_page_payload(
            internal_id=100, subject="X", sender="a@b",
            date_iso="2026-01-01", mailbox="收件箱",
        )
        assert "_(body not extracted)_" in content

    def test_yaml_quote_escapes_single_quote(self):
        _, content = build_kos_page_payload(
            internal_id=100, subject="It's a test", sender="a@b",
            date_iso="2026-01-01", mailbox="收件箱",
        )
        assert "title: 'It''s a test'" in content

    def test_body_truncation_caps_page_under_50kb(self):
        # 中文 body 6 万字 ≈ 18 万字节, 远超 50KB → 按字节截, 整页 ≤ 49KB
        _, content = build_kos_page_payload(
            internal_id=7, subject="X", sender="a@b", date_iso="2026-01-01",
            mailbox="收件箱", body_markdown="测" * 60000,
        )
        assert "truncated to 50KB by mailagent client" in content
        assert "mailagent:7" in content
        assert len(content.encode("utf-8")) <= 49000

    def test_no_truncation_when_small(self):
        _, content = build_kos_page_payload(
            internal_id=8, subject="X", sender="a@b", date_iso="2026-01-01",
            mailbox="收件箱", body_markdown="short body",
        )
        assert "truncated" not in content
        assert "short body" in content

    def test_attachments_section(self):
        _, content = build_kos_page_payload(
            internal_id=1, subject="X", sender="a@b", date_iso="2026-01-01",
            mailbox="收件箱",
            attachments=[
                {"filename": "report.pdf", "size": 2 * 1024 * 1024,
                 "content_type": "application/pdf"},
            ],
        )
        assert "## Attachments" in content
        assert "report.pdf" in content
        assert "2.00 MB" in content


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
            email, internal_id=1, ai_priority="low",
            priority_floor="normal", client=client,
        )
        assert result is None
        client.put_page.assert_not_called()

    @pytest.mark.asyncio
    async def test_skip_not_configured(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = False
        client.put_page = MagicMock()
        result = await push_email_to_kos(
            email, internal_id=1, ai_priority="critical",
            priority_floor="normal", client=client,
        )
        assert result is None
        client.put_page.assert_not_called()

    @pytest.mark.asyncio
    async def test_dry_run_skips_network(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock()
        result = await push_email_to_kos(
            email, internal_id=42, ai_priority="important",
            priority_floor="normal", client=client, dry_run=True,
            body_markdown="hello",
        )
        assert result is not None
        assert result["dry_run"] is True
        assert result["slug"] == "sources/email/42"
        assert result["content_bytes"] > 0
        client.put_page.assert_not_called()

    @pytest.mark.asyncio
    async def test_success_returns_server_payload(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock(return_value={
            "slug": "sources/email/42", "status": "created_or_updated", "chunks": 3,
        })
        result = await push_email_to_kos(
            email, internal_id=42, body_markdown="body content",
            ai_priority="important", priority_floor="normal", client=client,
        )
        assert result == {
            "slug": "sources/email/42", "status": "created_or_updated", "chunks": 3,
        }
        client.put_page.assert_called_once()
        args = client.put_page.call_args.args
        assert args[0] == "sources/email/42"
        assert args[1].startswith("---\n")
        assert "body content" in args[1]
        # 关键: put_page 只传 (slug, content), 不传 source (靠 client 路由)
        assert len(args) == 2

    @pytest.mark.asyncio
    async def test_labels_full_dict_used(self, email):
        """传完整 labels dict → AI 字段进 payload。"""
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock(return_value={"status": "created_or_updated"})
        await push_email_to_kos(
            email, internal_id=42, body_markdown="b",
            labels={"priority": "🔴 紧急", "ai_summary": "紧急摘要",
                    "category": "🔔 系统通知"},
            priority_floor="normal", client=client,
        )
        content = client.put_page.call_args.args[1]
        assert "ai_priority: '🔴 紧急'" in content
        assert "**摘要**: 紧急摘要" in content

    @pytest.mark.asyncio
    async def test_kos_error_returns_none_no_raise(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock(
            side_effect=KOSError("rate limited", code="E_KOS_RATE_LIMIT", status=429)
        )
        result = await push_email_to_kos(
            email, internal_id=1, ai_priority="critical",
            priority_floor="normal", client=client,
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_unexpected_exception_returns_none_no_raise(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock(side_effect=RuntimeError("boom"))
        result = await push_email_to_kos(
            email, internal_id=1, ai_priority="critical",
            priority_floor="normal", client=client,
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_uses_bulk_client_when_none_passed(self, email, monkeypatch):
        """没传 client → 内部 make_bulk_kos_client(); env 缺 → not configured → skip."""
        monkeypatch.delenv("KOS_MCP_BASE", raising=False)
        monkeypatch.delenv("MAILAGENT_BULK_CLIENT_ID", raising=False)
        monkeypatch.delenv("MAILAGENT_BULK_CLIENT_SECRET", raising=False)
        result = await push_email_to_kos(
            email, internal_id=1, ai_priority="critical", priority_floor="normal",
        )
        assert result is None
