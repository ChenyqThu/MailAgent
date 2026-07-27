"""Tests for AIFieldsWriter._build_props / _processing_status (no network)."""

from src.llm_agent.notion_writer import AIFieldsWriter
from src.llm_agent.processor import AILabels


def _bare_writer() -> AIFieldsWriter:
    """Bypass __init__ to avoid spinning up a real NotionClient."""
    w = AIFieldsWriter.__new__(AIFieldsWriter)
    w._client = None
    w._digest = None
    return w


def _labels(**overrides) -> AILabels:
    base = dict(
        ai_summary="summary text",
        key_points="- k1\n- k2",
        category="💼 产品管理",
        language="中文",
        sender_priority="核心团队",
        action_required=True,
        action_type="需要回复",
        priority="🟡 重要",
        urgency_reason="",
        mail_actions=["⭐ Starred"],
        reply_suggestion_md="Hi\n\n----\nBest,\nLucien",
        daily_digest_date="2026-04-24",
        related_project="",
        mailbox="收件箱",
    )
    base.update(overrides)
    return AILabels(**base)


def test_processing_status_inbox():
    assert _bare_writer()._processing_status("收件箱") == "AI Reviewed"


def test_processing_status_sent():
    assert _bare_writer()._processing_status("发件箱") == "已完成"


def test_processing_status_default():
    assert _bare_writer()._processing_status("") == "AI Reviewed"
    assert _bare_writer()._processing_status("unknown") == "AI Reviewed"


def test_build_props_inbox_full():
    w = _bare_writer()
    props = w._build_props(_labels(), digest_page_id="digest-page-123")
    for name in [
        "AI Summary", "Key Points", "Category", "Language", "Sender Priority",
        "Action Required", "Action Type", "Priority", "Mail Actions",
        "Reply Suggestion", "Daily Digests", "Processing Status",
    ]:
        assert name in props, f"missing {name}"
    assert props["Processing Status"]["select"]["name"] == "AI Reviewed"
    assert props["Daily Digests"]["relation"] == [{"id": "digest-page-123"}]


def test_build_props_sent_routes_to_completed():
    w = _bare_writer()
    props = w._build_props(
        _labels(mailbox="发件箱", action_type="需要跟进"),
        digest_page_id=None,
    )
    assert props["Processing Status"]["select"]["name"] == "已完成"
    assert "Daily Digests" not in props  # resolver returned None


def test_build_props_skips_empty_optionals():
    w = _bare_writer()
    props = w._build_props(
        _labels(
            ai_summary="", key_points="", category="",
            language="", sender_priority="", action_required=False,
            action_type="", priority="", mail_actions=[],
            reply_suggestion_md="", related_project="",
        ),
        digest_page_id=None,
    )
    for name in ["AI Summary", "Key Points", "Category", "Language",
                 "Sender Priority", "Action Type", "Priority",
                 "Mail Actions", "Reply Suggestion", "Related Project"]:
        assert name not in props, f"empty {name} should be skipped"
    # Action Required is checkbox → always written (False included)
    assert "Action Required" in props
    assert props["Action Required"]["checkbox"] is False
    # Processing Status always written
    assert "Processing Status" in props


def test_build_props_urgency_reason_included_when_non_empty():
    w = _bare_writer()
    props = w._build_props(
        _labels(priority="🔴 紧急", urgency_reason="线上事故，P0"),
        digest_page_id=None,
    )
    assert "Urgency Reason" in props
    rt = props["Urgency Reason"]["rich_text"][0]["text"]["content"]
    assert "线上事故" in rt


def test_reply_suggestion_converts_to_rich():
    w = _bare_writer()
    props = w._build_props(
        _labels(reply_suggestion_md="**Bold** reply text"),
        digest_page_id=None,
    )
    rich = props["Reply Suggestion"]["rich_text"]
    assert any(x.get("annotations", {}).get("bold") for x in rich)


def test_reply_suggestion_empty_skipped():
    w = _bare_writer()
    props = w._build_props(_labels(reply_suggestion_md=""), digest_page_id=None)
    assert "Reply Suggestion" not in props


def test_ai_summary_truncated_to_2000():
    w = _bare_writer()
    long = "x" * 3000
    props = w._build_props(_labels(ai_summary=long), digest_page_id=None)
    content = props["AI Summary"]["rich_text"][0]["text"]["content"]
    assert len(content) <= 2000


def test_mail_actions_multi_select_shape():
    w = _bare_writer()
    props = w._build_props(
        _labels(mail_actions=["⭐ Starred", "⚠️ Flagged"]),
        digest_page_id=None,
    )
    names = [o["name"] for o in props["Mail Actions"]["multi_select"]]
    assert names == ["⭐ Starred", "⚠️ Flagged"]


# ─────────────────────────────────────────────────────────────────────────────
# issue #63 — 自定义分类护栏 (category / sender_priority 现在是自由文本)
# ─────────────────────────────────────────────────────────────────────────────


def test_custom_category_passes_through_verbatim():
    """普通自定义分类原样写进 Notion — 护栏只在越界时才动手."""
    w = _bare_writer()
    props = w._build_props(_labels(category="📮 客户投诉"), digest_page_id=None)
    assert props["Category"]["select"]["name"] == "📮 客户投诉"


def test_select_name_strips_comma():
    """Notion select option 名含逗号 → API 400 → 整封邮件 AI 字段写不进去."""
    w = _bare_writer()
    props = w._build_props(
        _labels(category="投诉, 退款", sender_priority="VIP, 大客户"),
        digest_page_id=None,
    )
    assert "," not in props["Category"]["select"]["name"]
    assert props["Category"]["select"]["name"] == "投诉 退款"
    assert "," not in props["Sender Priority"]["select"]["name"]


def test_select_name_strips_fullwidth_comma():
    """全角 '，' 一并替换 — Notion 文档只说 "Commas are not valid", 未区分码点,
    保守处理 (中文自定义分类里出现全角逗号很现实)."""
    w = _bare_writer()
    props = w._build_props(_labels(category="投诉，退款"), digest_page_id=None)
    assert props["Category"]["select"]["name"] == "投诉 退款"


def test_select_name_collapses_whitespace_from_comma_replacement():
    """替换逗号会产生连续空格; 归一掉, 避免 Notion 里堆出只差空格数的近似重复 option."""
    w = _bare_writer()
    props = w._build_props(_labels(category="A，, B\tC\nD"), digest_page_id=None)
    assert props["Category"]["select"]["name"] == "A B C D"


def test_select_name_clamped_to_90_chars():
    w = _bare_writer()
    props = w._build_props(_labels(category="分" * 200), digest_page_id=None)
    assert len(props["Category"]["select"]["name"]) == 90


def test_select_name_trimmed():
    w = _bare_writer()
    props = w._build_props(
        _labels(category="  📮 客户投诉  "), digest_page_id=None
    )
    assert props["Category"]["select"]["name"] == "📮 客户投诉"


def test_select_name_all_commas_skips_prop():
    """规范化后为空 → 不写该 prop (空 option 名 Notion 也不收)."""
    w = _bare_writer()
    props = w._build_props(_labels(category=" , "), digest_page_id=None)
    assert "Category" not in props


def test_select_guard_does_not_touch_code_owned_enums():
    """Language / Priority / Action Type 仍是代码校验过的闭集, 不过护栏."""
    w = _bare_writer()
    props = w._build_props(_labels(), digest_page_id=None)
    assert props["Language"]["select"]["name"] == "中文"
    assert props["Priority"]["select"]["name"] == "🟡 重要"
    assert props["Action Type"]["select"]["name"] == "需要回复"
