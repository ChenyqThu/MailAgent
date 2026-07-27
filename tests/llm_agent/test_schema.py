"""Tests for EMAIL_TOOL_SCHEMA + enums (no network)."""

from src.llm_agent.schema import (
    ACTION_TYPE_ALL,
    ACTION_TYPE_INBOX,
    ACTION_TYPE_SENT,
    CATEGORY_ENUM,
    EMAIL_TOOL_SCHEMA,
    LANGUAGE_ENUM,
    MAIL_ACTIONS_ENUM,
    PRIORITY_ENUM,
    PROCESSING_STATUS_AI_REVIEWED,
    PROCESSING_STATUS_COMPLETED,
    RECOMMENDED_ACTION_ID_ENUM,
    RECOMMENDED_ACTION_ID_INBOX,
    RECOMMENDED_ACTION_ID_SENT,
    SENDER_PRIORITY_ENUM,
    is_valid_action_type,
    is_valid_recommended_action_id,
)


def test_schema_top_level():
    assert EMAIL_TOOL_SCHEMA["name"] == "classify_email"
    assert EMAIL_TOOL_SCHEMA["input_schema"]["type"] == "object"
    assert EMAIL_TOOL_SCHEMA["input_schema"]["additionalProperties"] is False


def test_required_fields():
    req = set(EMAIL_TOOL_SCHEMA["input_schema"]["required"])
    assert req == {
        "ai_summary", "category", "language", "sender_priority",
        "action_required", "action_type", "priority",
    }


def test_action_type_union_contains_both_flavors():
    assert set(ACTION_TYPE_INBOX).issubset(ACTION_TYPE_ALL)
    assert set(ACTION_TYPE_SENT).issubset(ACTION_TYPE_ALL)
    assert "需要回复" in ACTION_TYPE_INBOX
    assert "等待响应" in ACTION_TYPE_SENT
    # overlap
    assert "仅供参考" in ACTION_TYPE_INBOX and "仅供参考" in ACTION_TYPE_SENT


def test_is_valid_action_type_inbox():
    assert is_valid_action_type("需要回复", "收件箱") is True
    assert is_valid_action_type("需要决策", "收件箱") is True
    assert is_valid_action_type("等待响应", "收件箱") is False
    assert is_valid_action_type("需要跟进", "收件箱") is False
    assert is_valid_action_type("仅供参考", "收件箱") is True


def test_is_valid_action_type_sent():
    assert is_valid_action_type("等待响应", "发件箱") is True
    assert is_valid_action_type("需要跟进", "发件箱") is True
    assert is_valid_action_type("已完结", "发件箱") is True
    assert is_valid_action_type("需要回复", "发件箱") is False
    assert is_valid_action_type("需要Review", "发件箱") is False
    assert is_valid_action_type("仅供参考", "发件箱") is True


def test_is_valid_action_type_default_to_inbox():
    # empty mailbox → treated as inbox (consistent with processor fallback)
    assert is_valid_action_type("需要回复", "") is True
    assert is_valid_action_type("等待响应", "") is False


def test_priority_values():
    assert PRIORITY_ENUM == ["🔴 紧急", "🟡 重要", "🟢 一般", "⚪ 低"]


def test_category_has_emoji_prefix():
    assert len(CATEGORY_ENUM) == 7
    for c in CATEGORY_ENUM:
        # first char is emoji or first two chars form a char+zwj sequence
        assert ord(c[0]) > 0x1F000 or c[0] in "🤝👥📊🔔🌐💼🛠"


def test_language_contains_expected():
    for lang in ["English", "中文", "Japanese", "Other"]:
        assert lang in LANGUAGE_ENUM


def test_mail_actions_enum_size():
    assert len(MAIL_ACTIONS_ENUM) == 8


def test_processing_status_constants():
    assert PROCESSING_STATUS_AI_REVIEWED == "AI Reviewed"
    assert PROCESSING_STATUS_COMPLETED == "已完成"


def test_sender_priority_has_system():
    assert "系统" in SENDER_PRIORITY_ENUM
    assert "管理层" in SENDER_PRIORITY_ENUM


def test_tool_schema_enum_fields_match_enums():
    props = EMAIL_TOOL_SCHEMA["input_schema"]["properties"]
    assert props["priority"]["enum"] == PRIORITY_ENUM
    assert props["language"]["enum"] == LANGUAGE_ENUM
    assert props["sender_priority"]["enum"] == SENDER_PRIORITY_ENUM
    assert props["action_type"]["enum"] == ACTION_TYPE_ALL
    assert props["mail_actions"]["items"]["enum"] == MAIL_ACTIONS_ENUM


def test_category_is_free_string_with_builtin_suggestions():
    """issue #63: category 不再是硬 enum — 硬 enum 会和用户自定义分类 prompt
    在同一次调用里互相打架。7 个内置值降级为 description 里的建议。"""
    cat = EMAIL_TOOL_SCHEMA["input_schema"]["properties"]["category"]
    assert cat["type"] == "string"
    assert "enum" not in cat
    for c in CATEGORY_ENUM:
        assert c in cat["description"]


# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 — recommended_actions (灵动岛动态建议按钮, PRD §5.2)
# ─────────────────────────────────────────────────────────────────────────────


def test_recommended_action_enum_is_union_of_inbox_and_sent():
    assert set(RECOMMENDED_ACTION_ID_INBOX).issubset(RECOMMENDED_ACTION_ID_ENUM)
    assert set(RECOMMENDED_ACTION_ID_SENT).issubset(RECOMMENDED_ACTION_ID_ENUM)
    assert set(RECOMMENDED_ACTION_ID_ENUM) == (
        set(RECOMMENDED_ACTION_ID_INBOX) | set(RECOMMENDED_ACTION_ID_SENT)
    )


def test_recommended_action_inbox_whitelist_content():
    # escalate_to_oncall + ack_in_pagerduty 已下线 2026-05-26 (运维场景, 产品经理不用)
    expected = {
        "archive_and_unsubscribe", "archive_only",
        "add_to_calendar", "decline_with_reason",
        "defer_to_monday_9am", "convert_to_notion_task",
        "quick_reply_yes", "quick_reply_no_with_reason",
    }
    assert set(RECOMMENDED_ACTION_ID_INBOX) == expected


def test_ops_actions_removed_from_whitelist():
    """escalate_to_oncall + ack_in_pagerduty 2026-05-26 下线 — 运维场景不在 whitelist."""
    for action in ("escalate_to_oncall", "ack_in_pagerduty"):
        assert action not in RECOMMENDED_ACTION_ID_INBOX
        assert action not in RECOMMENDED_ACTION_ID_ENUM


def test_recommended_action_sent_whitelist_content():
    assert set(RECOMMENDED_ACTION_ID_SENT) == {"mark_done_no_response", "nudge_recipient"}


def test_recommended_action_disjoint_from_static_5():
    """LLM 不应推荐 Phase 1 静态 5 按钮 id (open_mail/open_notion/create_draft/mark_done/snooze_1h);
    它们是 fallback 而不是 LLM dynamic 推荐范围."""
    static_5 = {"open_mail", "open_notion", "create_draft", "mark_done", "snooze_1h"}
    assert set(RECOMMENDED_ACTION_ID_ENUM).isdisjoint(static_5)


def test_recommended_actions_field_in_schema():
    props = EMAIL_TOOL_SCHEMA["input_schema"]["properties"]
    assert "recommended_actions" in props
    field = props["recommended_actions"]
    assert field["type"] == "array"
    assert field["maxItems"] == 3
    item = field["items"]
    assert item["type"] == "object"
    assert item["additionalProperties"] is False
    assert set(item["required"]) == {"id", "title", "confidence"}
    # id enum 必须匹配 union whitelist
    assert item["properties"]["id"]["enum"] == RECOMMENDED_ACTION_ID_ENUM
    # title / detail 长度上限
    assert item["properties"]["title"]["maxLength"] == 30
    assert item["properties"]["detail"]["maxLength"] == 80
    # confidence 范围
    assert item["properties"]["confidence"]["minimum"] == 0.0
    assert item["properties"]["confidence"]["maximum"] == 1.0


def test_recommended_actions_not_required():
    """recommended_actions 是可选字段, LLM 不确定时留空数组; 不应在 required 里."""
    req = set(EMAIL_TOOL_SCHEMA["input_schema"]["required"])
    assert "recommended_actions" not in req


def test_is_valid_recommended_action_id_inbox():
    assert is_valid_recommended_action_id("archive_and_unsubscribe", "收件箱") is True
    assert is_valid_recommended_action_id("add_to_calendar", "收件箱") is True
    assert is_valid_recommended_action_id("convert_to_notion_task", "收件箱") is True
    # ack_in_pagerduty 已下线 → 收件箱也无效
    assert is_valid_recommended_action_id("ack_in_pagerduty", "收件箱") is False
    # 发件箱专属 id 在收件箱无效
    assert is_valid_recommended_action_id("mark_done_no_response", "收件箱") is False
    assert is_valid_recommended_action_id("nudge_recipient", "收件箱") is False
    # 不在 whitelist 的 id
    assert is_valid_recommended_action_id("delete_email_forever", "收件箱") is False
    # 静态 5 按钮 id 也不算 recommended
    assert is_valid_recommended_action_id("open_mail", "收件箱") is False


def test_is_valid_recommended_action_id_sent():
    assert is_valid_recommended_action_id("mark_done_no_response", "发件箱") is True
    assert is_valid_recommended_action_id("nudge_recipient", "发件箱") is True
    # 收件箱专属 id 在发件箱无效
    assert is_valid_recommended_action_id("archive_and_unsubscribe", "发件箱") is False
    assert is_valid_recommended_action_id("add_to_calendar", "发件箱") is False


def test_is_valid_recommended_action_id_empty_mailbox_treated_as_inbox():
    # 跟 is_valid_action_type 一致: 空 mailbox → 收件箱
    assert is_valid_recommended_action_id("archive_only", "") is True
    assert is_valid_recommended_action_id("mark_done_no_response", "") is False
