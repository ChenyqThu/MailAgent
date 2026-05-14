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
    SENDER_PRIORITY_ENUM,
    is_valid_action_type,
)


def test_schema_top_level():
    assert EMAIL_TOOL_SCHEMA["name"] == "classify_email"
    assert EMAIL_TOOL_SCHEMA["input_schema"]["type"] == "object"
    assert EMAIL_TOOL_SCHEMA["input_schema"]["additionalProperties"] is False


def test_required_fields():
    req = set(EMAIL_TOOL_SCHEMA["input_schema"]["required"])
    assert req == {
        "ai_summary", "category", "language", "sender_priority",
        "action_required", "action_type", "priority", "confidence",
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
    assert props["category"]["enum"] == CATEGORY_ENUM
    assert props["priority"]["enum"] == PRIORITY_ENUM
    assert props["language"]["enum"] == LANGUAGE_ENUM
    assert props["sender_priority"]["enum"] == SENDER_PRIORITY_ENUM
    assert props["action_type"]["enum"] == ACTION_TYPE_ALL
    assert props["mail_actions"]["items"]["enum"] == MAIL_ACTIONS_ENUM
