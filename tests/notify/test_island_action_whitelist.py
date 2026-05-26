"""Tests for src.notify.island_action_whitelist.

Phase 2 (PRD §5.2) — 校验 KNOWN_ACTION_IDS = static 5 ∪ recommended 12 (10 inbox + 2 sent),
跟 schema.RECOMMENDED_ACTION_ID_* 一致. helper is_known/is_recommended 输入校验.
"""

from __future__ import annotations

import pytest

from src.llm_agent.schema import (
    RECOMMENDED_ACTION_ID_ENUM,
    RECOMMENDED_ACTION_ID_INBOX,
    RECOMMENDED_ACTION_ID_SENT,
)
from src.notify.island_action_whitelist import (
    KNOWN_ACTION_IDS,
    RECOMMENDED_ACTION_IDS,
    STATIC_FALLBACK_ACTION_IDS,
    is_known_action_id,
    is_recommended_action_id,
)


def test_static_fallback_action_ids_is_phase1_static_5():
    """Phase 1 static 5 (DEFAULT_OPTION_IDS in island_dispatch) 跟这里 1:1."""
    assert STATIC_FALLBACK_ACTION_IDS == frozenset({
        "open_notion", "create_draft", "mark_done", "snooze_1h", "open_mail",
    })


def test_recommended_action_ids_matches_schema_enum():
    """RECOMMENDED_ACTION_IDS 跟 schema enum 1:1, 不能漂."""
    assert set(RECOMMENDED_ACTION_IDS) == set(RECOMMENDED_ACTION_ID_ENUM)
    assert set(RECOMMENDED_ACTION_IDS) == (
        set(RECOMMENDED_ACTION_ID_INBOX) | set(RECOMMENDED_ACTION_ID_SENT)
    )


def test_known_action_ids_is_union():
    """整体 handler 端可识别 id = static 5 ∪ recommended 10 = 15.
    (escalate_to_oncall + ack_in_pagerduty 2026-05-26 下线后 recommended 12→10)."""
    assert KNOWN_ACTION_IDS == (
        STATIC_FALLBACK_ACTION_IDS | RECOMMENDED_ACTION_IDS
    )
    assert len(KNOWN_ACTION_IDS) == 15


def test_static_and_recommended_are_disjoint():
    """静态 5 跟 LLM dynamic recommended 不重叠 (test_recommended_action_disjoint_from_static_5
    在 schema 层断言过 enum 不冲突; whitelist 也保证)."""
    assert STATIC_FALLBACK_ACTION_IDS.isdisjoint(RECOMMENDED_ACTION_IDS)


def test_is_known_action_id_static():
    assert is_known_action_id("open_mail") is True
    assert is_known_action_id("create_draft") is True
    assert is_known_action_id("snooze_1h") is True


def test_is_known_action_id_recommended():
    assert is_known_action_id("archive_and_unsubscribe") is True
    assert is_known_action_id("add_to_calendar") is True
    assert is_known_action_id("mark_done_no_response") is True


def test_is_known_action_id_unknown_dropped():
    assert is_known_action_id("delete_email_forever") is False
    assert is_known_action_id("foo") is False
    assert is_known_action_id("") is False


def test_is_known_action_id_non_str_dropped():
    # defense in depth — None / int / list 不应误判 True
    assert is_known_action_id(None) is False  # type: ignore[arg-type]
    assert is_known_action_id(123) is False  # type: ignore[arg-type]
    assert is_known_action_id(["mark_done"]) is False  # type: ignore[arg-type]


def test_is_recommended_action_id_only_dynamic():
    """is_recommended_action_id 排除静态 5 (它们是 fallback path, 不在 LLM 推荐空间)."""
    # Static 5 → False
    for sid in ("open_mail", "open_notion", "create_draft", "mark_done", "snooze_1h"):
        assert is_recommended_action_id(sid) is False, sid
    # Dynamic → True
    for rid in (
        "archive_and_unsubscribe", "archive_only", "add_to_calendar",
        "decline_with_reason", "defer_to_monday_9am", "convert_to_notion_task",
        "quick_reply_yes",
        "quick_reply_no_with_reason", "mark_done_no_response", "nudge_recipient",
    ):
        assert is_recommended_action_id(rid) is True, rid
    # escalate_to_oncall + ack_in_pagerduty 已下线 → 不再是 recommended
    assert is_recommended_action_id("escalate_to_oncall") is False
    assert is_recommended_action_id("ack_in_pagerduty") is False


def test_is_recommended_action_id_non_str_dropped():
    assert is_recommended_action_id(None) is False  # type: ignore[arg-type]
    assert is_recommended_action_id("") is False
    assert is_recommended_action_id(["archive_only"]) is False  # type: ignore[arg-type]


def test_frozenset_immutable():
    """Whitelist 是 frozenset → 不可篡改 (防 import 后 mutate)."""
    with pytest.raises((AttributeError, TypeError)):
        STATIC_FALLBACK_ACTION_IDS.add("hack")  # type: ignore[attr-defined]
    with pytest.raises((AttributeError, TypeError)):
        KNOWN_ACTION_IDS.remove("open_mail")  # type: ignore[attr-defined]
