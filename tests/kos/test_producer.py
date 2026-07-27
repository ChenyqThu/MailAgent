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
        assert result.skipped and result.reason == "unlabeled"
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
        # dry-run 归 skipped 三态, 但 result 带 payload 信息 = 过了 gate
        assert result.reason == "dry_run" and result.result is not None
        assert priority_at_or_above("🟢 一般", "important") is False
        assert priority_at_or_above("⚪ 低", "normal") is False
        assert priority_at_or_above("🟡 重要", "🟢 一般") is True
        assert priority_at_or_above("⚪ 低", "🟡 重要") is False


# ============================================================
# _yaml_quote (issue #60-63 批交叉 review: 值里裸换行会截断 frontmatter)
# ============================================================

class TestYamlQuote:
    """空白归一 —— 值里带裸换行会把单行 frontmatter 字段从中间断成多行, 若断出来
    的某行恰好是 `---` 就撞上 YAML 文档分隔符, 整页 yaml.safe_load 直接报废
    (端到端复现见 TestBuildKosPagePayload.test_newline_injection_does_not_break_frontmatter_yaml)。"""

    def test_none_unchanged(self):
        from src.kos.producer import _yaml_quote

        assert _yaml_quote(None) == "''"

    def test_single_quote_still_escaped(self):
        """单引号转义逻辑一字不动。"""
        from src.kos.producer import _yaml_quote

        assert _yaml_quote("It's a test") == "'It''s a test'"

    def test_plain_values_byte_identical(self):
        """不含换行类空白的普通值: 归一前后逐字节不变 —— 用原始 quote 公式当
        oracle 直接比对, 而非只断言"看起来没变"。覆盖 emoji/中文/URL/连续常规
        空格/首尾常规空格/全角空格 (U+3000 不在归一范围内, 不应被当作换行处理)。
        """
        from src.kos.producer import _yaml_quote

        samples = [
            "Q3 Review",
            "外部联系人",
            "🟡 重要",
            "https://example.com/a/b?x=1",
            "2026-05-23T10:30:00+08:00",
            "a   b",  # 连续常规空格不应被压缩
            "  leading and trailing  ",  # 首尾常规空格不应被剥离
            "全角　空格",  # U+3000 全角空格, 不在归一范围内
        ]
        for raw in samples:
            expected = "'" + raw.replace("'", "''") + "'"
            assert _yaml_quote(raw) == expected, raw

    def test_newline_becomes_space(self):
        from src.kos.producer import _yaml_quote

        assert _yaml_quote("工作\n---\nHACKED") == "'工作 --- HACKED'"

    def test_crlf_collapses_to_single_space(self):
        """\\r\\n 是一个整体换行, 应归一成一个空格, 不是两个。"""
        from src.kos.producer import _yaml_quote

        assert _yaml_quote("a\r\nb") == "'a b'"

    def test_consecutive_newlines_collapse_to_one_space(self):
        from src.kos.producer import _yaml_quote

        assert _yaml_quote("a\n\n\nb") == "'a b'"

    def test_tab_and_vertical_whitespace_become_space(self):
        from src.kos.producer import _yaml_quote

        assert _yaml_quote("a\tb") == "'a b'"
        assert _yaml_quote("a\x0bb\x0cc") == "'a b c'"

    def test_newline_and_single_quote_together(self):
        """归一与转义两道处理互不干扰。"""
        from src.kos.producer import _yaml_quote

        assert _yaml_quote("It's\nbroken") == "'It''s broken'"


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

    def test_newline_injection_does_not_break_frontmatter_yaml(self):
        """issue #60-63 批交叉 review 复现: subject / 全保留后的 ai_category /
        ai_sender_priority 完全由发件人或 LLM 输出决定, 未归一时一个
        `\\n---\\nHACKED` 就能把 frontmatter 从中间断成多行、撞上 YAML 文档
        分隔符, 整页 yaml.safe_load 直接 ScannerError (repro 见交叉 review)。
        归一后整页仍是合法 YAML, 且值本身可正确取回 (换行变空格, 不丢内容)。
        """
        import yaml

        _, content = build_kos_page_payload(
            internal_id=999, subject="工作\n---\nHACKED", sender="a@b.com",
            date_iso="2026-07-27T00:00:00", mailbox="收件箱",
            labels={
                "category": "自定义\n---\n分类注入",
                "sender_priority": "外部\r\nRESET",
            },
        )
        lines = content.split("\n")
        assert lines[0] == "---"
        end = next(i for i in range(1, len(lines)) if lines[i] == "---")
        fm_body = "\n".join(lines[1:end])
        doc = yaml.safe_load(fm_body)
        assert doc["title"] == "工作 --- HACKED"
        assert doc["mailagent"]["ai_category"] == "自定义 --- 分类注入"
        assert doc["mailagent"]["ai_sender_priority"] == "外部 RESET"

    def test_body_truncation_caps_page_under_50kb(self):
        # 中文 body 6 万字 ≈ 18 万字节, 远超 50KB → 按字节截, 整页 ≤ 49KB
        _, content = build_kos_page_payload(
            internal_id=7, subject="X", sender="a@b", date_iso="2026-01-01",
            mailbox="收件箱", body_markdown="测" * 60000,
        )
        assert "truncated to 50KB by mailagent client" in content
        assert "mailagent:7" in content
        assert len(content.encode("utf-8")) <= 49000

    # ---- 分区上限 (codex review MEDIUM-3) ----
    #
    # 原实现只有 body 有预算, 其余区块全部无界。任何一个把 49KB 吃光后
    # body_budget <= 0, 而截断判据 `> body_budget > 0` 的链式比较此时整体为
    # False → 完全不截、完整正文照塞。越是该截的场景越不截。

    def test_page_cap_holds_when_ai_section_is_huge(self):
        """超长 ai_summary + key_points 不再能把整页顶爆。"""
        _, content = build_kos_page_payload(
            internal_id=70, subject="X", sender="a@b", date_iso="2026-01-01",
            mailbox="收件箱", body_markdown="正文" * 5000,
            labels={"ai_summary": "摘" * 40000, "key_points": "点" * 40000},
        )
        assert len(content.encode("utf-8")) <= 49000

    def test_page_cap_holds_when_attachment_list_is_huge(self):
        """500 个长文件名附件 —— 条数和单条长度都被截。"""
        atts = [
            {"filename": f"{'超长文件名' * 40}_{i}.pdf", "size": 1024, "content_type": "application/pdf"}
            for i in range(500)
        ]
        _, content = build_kos_page_payload(
            internal_id=71, subject="X", sender="a@b", date_iso="2026-01-01",
            mailbox="收件箱", body_markdown="正文" * 5000, attachments=atts,
        )
        assert len(content.encode("utf-8")) <= 49000
        assert "另有 450 个附件未列出" in content

    def test_page_cap_holds_when_cc_list_is_huge(self):
        """企业群发 3000 个抄送 —— frontmatter 绝不截, 所以 cc 自己有界。"""
        cc = ", ".join(f"user{i}@verylongcorporatedomain.example.com" for i in range(3000))
        _, content = build_kos_page_payload(
            internal_id=72, subject="X", sender="a@b", date_iso="2026-01-01",
            mailbox="收件箱", body_markdown="正文" * 5000, cc_addr=cc,
        )
        assert len(content.encode("utf-8")) <= 49000
        # 静默截断会让「这封信到底抄送了谁」查不出来 —— 必须留痕。
        assert "cc_truncated: 2800" in content
        # frontmatter 仍是完整闭合的 YAML（--- ... ---），没被从中间砍断。
        assert content.startswith("---\n")
        assert "\n---\n" in content

    def test_page_cap_holds_when_everything_is_huge(self):
        """所有无界区块同时爆 —— 兜底闸必须守住。"""
        atts = [
            {"filename": f"{'名' * 200}_{i}.pdf", "size": 1, "content_type": "x"}
            for i in range(300)
        ]
        cc = ", ".join(f"u{i}@d{'x' * 60}.com" for i in range(2000))
        _, content = build_kos_page_payload(
            internal_id=73, subject="主题" * 300, sender="a@b", date_iso="2026-01-01",
            mailbox="收件箱", body_markdown="正" * 100000, cc_addr=cc,
            to_addr=", ".join(f"t{i}@dddd.com" for i in range(2000)),
            attachments=atts,
            labels={"ai_summary": "摘" * 50000, "key_points": "点" * 50000},
        )
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
        assert result.skipped and result.reason == "priority_floor"
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
        assert result.skipped and result.reason == "not_configured"
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
        assert result.skipped and result.reason == "dry_run"
        assert result.result["dry_run"] is True
        assert result.result["slug"] == "sources/email/42"
        assert result.result["content_bytes"] > 0
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
        assert result.pushed
        assert result.result == {
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
    async def test_kos_error_returns_failed_no_raise(self, email):
        """issue #59: KOSError 不再返 None 伪装成跳过 —— failed 三态 + error_code。"""
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock(
            side_effect=KOSError("rate limited", code="E_KOS_RATE_LIMIT", status=429)
        )
        result = await push_email_to_kos(
            email, internal_id=1, ai_priority="critical",
            priority_floor="normal", client=client,
        )
        assert result.failed and result.error_code == "E_KOS_RATE_LIMIT"

    @pytest.mark.asyncio
    async def test_unexpected_exception_returns_failed_no_raise(self, email):
        client = MagicMock(spec=KOSClient)
        client.configured = True
        client.put_page = MagicMock(side_effect=RuntimeError("boom"))
        result = await push_email_to_kos(
            email, internal_id=1, ai_priority="critical",
            priority_floor="normal", client=client,
        )
        assert result.failed and result.error_code == "E_KOS_UNEXPECTED"

    @pytest.mark.asyncio
    async def test_uses_bulk_client_when_none_passed(self, email, monkeypatch):
        """没传 client → 内部 make_bulk_kos_client(); env 缺 → not configured → skip."""
        monkeypatch.delenv("KOS_MCP_BASE", raising=False)
        monkeypatch.delenv("MAILAGENT_BULK_CLIENT_ID", raising=False)
        monkeypatch.delenv("MAILAGENT_BULK_CLIENT_SECRET", raising=False)
        result = await push_email_to_kos(
            email, internal_id=1, ai_priority="critical", priority_floor="normal",
        )
        assert result.skipped and result.reason == "not_configured"


# ============================================================
# build_kos_page_payload — ## Thread 节 (KOS Thread 链接, task 07-23)
# ============================================================

class TestThreadSection:
    def test_reply_has_parent_and_root_links(self):
        """回复邮件 (parent≠root) → 两行 + 链接精确 sources/email/{id}.md +
        frontmatter in_reply_to_email_id。"""
        _, content = build_kos_page_payload(
            internal_id=9, subject="Re: Re: Plan", sender="a@b",
            date_iso="2026-07-23T10:00:00", mailbox="收件箱",
            body_markdown="正文", thread_parent=(5, "Re: Plan"), thread_root=(2, "Plan"),
        )
        assert "## Thread" in content
        assert "- In reply to: [Re: Plan](sources/email/5.md)" in content
        assert "- Thread root: [Plan](sources/email/2.md)" in content
        # frontmatter provenance 从 thread_parent[0] 派生
        assert "in_reply_to_email_id: 5" in content

    def test_thread_section_after_meta_before_body(self):
        """## Thread 位于 metadata blockquote 之后、正文之前。"""
        _, content = build_kos_page_payload(
            internal_id=9, subject="Re: Plan", sender="a@b",
            date_iso="2026-07-23", mailbox="收件箱",
            body_markdown="BODYMARKER", thread_parent=(5, "Plan"), thread_root=(2, "Root"),
        )
        assert content.index("> Mailbox:") < content.index("## Thread")
        assert content.index("## Thread") < content.index("BODYMARKER")

    def test_one_level_reply_only_in_reply_to(self):
        """parent==root (一层回复, resolve_thread_refs 已把 root 置 None) →
        只出 In reply to 行, 无 Thread root 行。"""
        _, content = build_kos_page_payload(
            internal_id=9, subject="Re: Plan", sender="a@b",
            date_iso="2026-07-23", mailbox="收件箱",
            body_markdown="正文", thread_parent=(2, "Plan"), thread_root=None,
        )
        assert "- In reply to: [Plan](sources/email/2.md)" in content
        assert "Thread root" not in content

    def test_thread_first_email_no_section(self):
        """线程首封 (thread_parent/root 皆 None) → 无 ## Thread 节。"""
        _, content = build_kos_page_payload(
            internal_id=1, subject="Plan", sender="a@b",
            date_iso="2026-07-23", mailbox="收件箱", body_markdown="正文",
        )
        assert "## Thread" not in content
        assert "in_reply_to_email_id" not in content

    def test_byte_identical_when_no_thread_params(self):
        """不传 thread 参数 vs 显式传 None → 逐字节一致 (与改动前现状对齐)。"""
        kwargs = dict(
            internal_id=1, subject="Plan", sender="a@b",
            date_iso="2026-07-23", mailbox="收件箱", body_markdown="正文",
        )
        _, without = build_kos_page_payload(**kwargs)
        _, explicit_none = build_kos_page_payload(
            **kwargs, thread_parent=None, thread_root=None, in_reply_to_email_id=None,
        )
        assert without == explicit_none

    def test_miss_single_side_omits_that_line(self):
        """反查 miss 单侧 (只有 root, parent=None) → 只出 Thread root 行。"""
        _, content = build_kos_page_payload(
            internal_id=9, subject="Re: Plan", sender="a@b",
            date_iso="2026-07-23", mailbox="收件箱",
            body_markdown="正文", thread_parent=None, thread_root=(2, "Plan"),
        )
        assert "In reply to" not in content
        assert "- Thread root: [Plan](sources/email/2.md)" in content

    def test_subject_sanitized_in_link_text(self):
        """subject 里的 [ ] / 换行做防破链 sanitize; 空 subject → (no subject)。"""
        _, content = build_kos_page_payload(
            internal_id=9, subject="Re", sender="a@b", date_iso="2026-07-23",
            mailbox="收件箱", body_markdown="正文",
            thread_parent=(5, "a [tag] b\nc"), thread_root=(2, ""),
        )
        assert "- In reply to: [a (tag) b c](sources/email/5.md)" in content
        assert "- Thread root: [(no subject)](sources/email/2.md)" in content

    def test_thread_section_not_truncated_under_huge_body(self):
        """超长正文 → body 被截, 但 ## Thread 节 (在 skeleton 内) 完整保留。"""
        _, content = build_kos_page_payload(
            internal_id=9, subject="Re: Plan", sender="a@b",
            date_iso="2026-07-23", mailbox="收件箱",
            body_markdown="正" * 60000,
            thread_parent=(5, "Parent Subj"), thread_root=(2, "Root Subj"),
        )
        assert len(content.encode("utf-8")) <= 49000
        assert "truncated to 50KB by mailagent client" in content  # body 确实被截
        assert "- In reply to: [Parent Subj](sources/email/5.md)" in content
        assert "- Thread root: [Root Subj](sources/email/2.md)" in content


# ============================================================
# resolve_thread_refs — SQLite 反查 (task 07-23)
# ============================================================

class TestResolveThreadRefs:
    @pytest.fixture
    def db(self, tmp_path):
        from src.mail.sync_store import SyncStore

        dbp = str(tmp_path / "sync_store.db")
        store = SyncStore(db_path=dbp)
        # 线程: root(1) ← reply(2) ← reply2(3)
        store.save_email({
            "internal_id": 1, "message_id": "root@x", "subject": "Plan",
            "sender": "a@b", "mailbox": "收件箱", "sync_status": "synced",
        })
        store.save_email({
            "internal_id": 2, "message_id": "reply@x", "subject": "Re: Plan",
            "sender": "c@d", "mailbox": "收件箱", "sync_status": "synced",
            "in_reply_to": "root@x", "thread_id": "root@x",
        })
        store.save_email({
            "internal_id": 3, "message_id": "reply2@x", "subject": "Re: Re: Plan",
            "sender": "e@f", "mailbox": "收件箱", "sync_status": "synced",
            "in_reply_to": "reply@x", "thread_id": "root@x",
        })
        return dbp

    def test_first_email_returns_empty(self, db):
        """线程首封 (无 in_reply_to; thread_id 未设) → parent/root 皆 None。"""
        from src.kos.producer import resolve_thread_refs

        assert resolve_thread_refs(db, 1) == {"parent": None, "root": None}

    def test_one_level_reply_dedups_root(self, db):
        """一层回复: parent==root → root 置 None (只保留 parent)。"""
        from src.kos.producer import resolve_thread_refs

        assert resolve_thread_refs(db, 2) == {"parent": (1, "Plan"), "root": None}

    def test_deep_reply_resolves_parent_and_root(self, db):
        """深层回复: parent=直接父, root=线程根, 二者不同。"""
        from src.kos.producer import resolve_thread_refs

        refs = resolve_thread_refs(db, 3)
        assert refs["parent"] == (2, "Re: Plan")
        assert refs["root"] == (1, "Plan")

    def test_no_row_returns_empty(self, db):
        """本封 internal_id 查不到 → 空 (不报错)。"""
        from src.kos.producer import resolve_thread_refs

        assert resolve_thread_refs(db, 999) == {"parent": None, "root": None}

    def test_davmail_first_email_self_thread_id_guarded(self, db):
        """davmail 线程首封: thread_id == 自身 message_id (自指) → root None。
        （applescript 首封 thread_id=None 已由 test_first_email_returns_empty 覆盖；
        此处锁 davmail `_extract_thread_id` 兜底 = 自身 的分支不出 Thread root 行。）"""
        from src.kos.producer import resolve_thread_refs
        from src.mail.sync_store import SyncStore

        store = SyncStore(db_path=db)
        store.save_email({
            "internal_id": 10, "message_id": "self@x", "subject": "Plan",
            "sender": "a@b", "mailbox": "收件箱", "sync_status": "synced",
            "thread_id": "self@x",  # davmail 首封兜底 == 自身 message_id
        })
        assert resolve_thread_refs(db, 10) == {"parent": None, "root": None}

    def test_pathological_self_in_reply_to_guarded(self, db):
        """病态自指: in_reply_to == 自身 message_id → parent None (不自链)。"""
        from src.kos.producer import resolve_thread_refs
        from src.mail.sync_store import SyncStore

        store = SyncStore(db_path=db)
        store.save_email({
            "internal_id": 11, "message_id": "loop@x", "subject": "Loop",
            "sender": "a@b", "mailbox": "收件箱", "sync_status": "synced",
            "in_reply_to": "loop@x", "thread_id": "loop@x",
        })
        assert resolve_thread_refs(db, 11) == {"parent": None, "root": None}

    def test_dangling_ref_omitted(self, db, tmp_path):
        """in_reply_to 指向未入库的 message_id → parent None (构造不出链接目标)。"""
        from src.kos.producer import resolve_thread_refs
        from src.mail.sync_store import SyncStore

        store = SyncStore(db_path=db)
        store.save_email({
            "internal_id": 4, "message_id": "orphan@x", "subject": "Re: Gone",
            "sender": "g@h", "mailbox": "收件箱", "sync_status": "synced",
            "in_reply_to": "never-synced@x", "thread_id": "never-synced@x",
        })
        assert resolve_thread_refs(db, 4) == {"parent": None, "root": None}

    def test_bad_db_path_returns_empty_no_raise(self):
        """DB 不可达 → 吞异常返回空 (KOS 丰富层不炸主流程)。"""
        from src.kos.producer import resolve_thread_refs

        assert resolve_thread_refs("/nonexistent/dir/nope.db", 1) == {
            "parent": None, "root": None,
        }
