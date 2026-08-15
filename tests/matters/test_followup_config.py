"""事项跟进配置的逐条编辑（task 08-14）。

盯的是 PRD D2 那条纪律：**删除必须显式带 trigger_id**。所以最重要的一组用例不是「改得对不对」，
而是「改一条的时候，旁边那些没被点名的 trigger 还在不在」。
"""

from __future__ import annotations

import json

import pytest

from src.matters.followup_config import (
    FOLLOWUP_OPERATIONS,
    apply_followup_operation,
    followup_view,
)
from src.matters.triggers import TriggerError

RULE = {
    "freq": "weekly",
    "interval": 1,
    "weekdays": [1],
    "monthMode": "date",
    "monthDay": 1,
    "ordinal": 1,
    "weekday": 1,
    "hour": 9,
    "minute": 0,
    "clamp": False,
}

#: owner 活库 MAT-0001 的真实形状：三种 kind 并存 —— 正是「改排程别把另外两条删了」的现场。
THREE_TRIGGERS = {
    "v": 2,
    "triggers": [
        {"id": "mtr_evt", "kind": "event", "enabled": True, "event_type": "resource_doc_updated"},
        {"id": "mtr_cond", "kind": "condition", "enabled": True, "condition": "action_overdue"},
        {
            "id": "mtr_sched",
            "kind": "schedule",
            "enabled": True,
            "rule": RULE,
            "anchor": "2026-08-13",
            "timezone": "America/Los_Angeles",
        },
    ],
    "actions": ["summary", "items", "proposal"],
}


def matter(schedule_json=THREE_TRIGGERS, **overrides):
    row = {
        "id": 1,
        "public_id": "MAT-0001",
        "agent_enabled": 1,
        "agent_profile_id": None,
        "matter_instructions": None,
        "schedule_json": json.dumps(schedule_json) if schedule_json is not None else None,
    }
    row.update(overrides)
    return row


def triggers_after(patch):
    return json.loads(json.dumps(patch["schedule_json"]))["triggers"]


# ── 读投影 ──────────────────────────────────────────────────────────────────────


def test_view_exposes_trigger_ids_actions_and_bindings():
    view = followup_view(matter(agent_profile_id="dms", matter_instructions="盯紧交付"))
    assert [entry["id"] for entry in view["triggers"]] == ["mtr_evt", "mtr_cond", "mtr_sched"]
    assert view["actions"] == ["summary", "items", "proposal"]
    assert view["enabled"] is True
    assert view["profile_id"] == "dms"
    assert view["instructions"] == "盯紧交付"
    assert view["parse_error"] is None


def test_view_normalizes_the_v1_legacy_shape_without_rewriting_the_row():
    """老形状要被惰性映射成 entries —— 模型看到的形状必须与 worker 求值用的是同一个。"""
    legacy = {"kind": "schedule", "rule": RULE, "anchor": "2026-08-13", "timezone": "UTC"}
    view = followup_view(matter(legacy))
    assert len(view["triggers"]) == 1
    assert view["triggers"][0]["kind"] == "schedule"
    assert view["triggers"][0]["id"]  # up-convert 出来的稳定 id


def test_view_surfaces_a_parse_error_instead_of_pretending_there_is_no_schedule():
    view = followup_view(matter({"triggers": [{"kind": "nope"}]}))
    assert view["triggers"] == []
    assert view["parse_error"]  # 坏数据不隐身


# ── 🔴 逐条纪律 ─────────────────────────────────────────────────────────────────


def test_editing_the_schedule_keeps_the_event_and_condition_triggers():
    """本任务的核心保证：改一条不碰其余条。"""
    patch = apply_followup_operation(
        matter(),
        "update_trigger",
        {"trigger_id": "mtr_sched", "trigger": {"rule": {**RULE, "hour": 18}}},
    )
    entries = triggers_after(patch)
    assert [entry["id"] for entry in entries] == ["mtr_evt", "mtr_cond", "mtr_sched"]
    assert entries[2]["rule"]["hour"] == 18


def test_removing_one_trigger_names_it_and_leaves_the_rest():
    patch = apply_followup_operation(matter(), "remove_trigger", {"trigger_id": "mtr_cond"})
    assert [entry["id"] for entry in triggers_after(patch)] == ["mtr_evt", "mtr_sched"]


def test_remove_and_update_require_a_trigger_id():
    for operation in ("remove_trigger", "update_trigger", "set_trigger_enabled"):
        with pytest.raises(TriggerError, match="trigger_id is required"):
            apply_followup_operation(matter(), operation, {})


def test_unknown_trigger_id_is_refused_rather_than_silently_ignored():
    with pytest.raises(TriggerError, match="no trigger mtr_ghost"):
        apply_followup_operation(matter(), "remove_trigger", {"trigger_id": "mtr_ghost"})


def test_no_operation_can_replace_the_whole_trigger_list():
    """把「整份替换」的可能性钉死在值域上（与 parity 闸互为两道）。"""
    assert not ({"set_triggers", "replace_triggers"} & set(FOLLOWUP_OPERATIONS))


# ── 各 operation ────────────────────────────────────────────────────────────────


def test_add_trigger_appends_and_derives_an_id_from_the_server_side():
    patch = apply_followup_operation(
        matter(),
        "add_trigger",
        {"trigger": {"kind": "condition", "condition": "health_down", "id": "mtr_evt"}},
    )
    entries = triggers_after(patch)
    assert len(entries) == 4
    # 模型给的 id 被丢掉 —— 否则它能用一个既有 id「新增」出一条覆盖掉原条目。
    assert entries[3]["id"] != "mtr_evt"
    assert entries[3]["condition"] == "health_down"


def test_set_trigger_enabled_toggles_only_the_named_entry():
    patch = apply_followup_operation(
        matter(), "set_trigger_enabled", {"trigger_id": "mtr_evt", "enabled": False}
    )
    entries = {entry["id"]: entry["enabled"] for entry in triggers_after(patch)}
    assert entries == {"mtr_evt": False, "mtr_cond": True, "mtr_sched": True}


def test_a_triggers_kind_cannot_be_changed_in_place():
    """换 kind = 换一条 trigger，而 per-trigger marker 会继续套用在新判据上。"""
    with pytest.raises(TriggerError, match="kind cannot be changed"):
        apply_followup_operation(
            matter(),
            "update_trigger",
            {"trigger_id": "mtr_sched", "trigger": {"kind": "event", "event_type": "x"}},
        )


def test_binding_operations_do_not_touch_the_schedule():
    assert apply_followup_operation(matter(), "set_enabled", {"enabled": False}) == {
        "agent_enabled": False
    }
    assert apply_followup_operation(matter(), "set_profile", {"profile_id": "  dms  "}) == {
        "agent_profile_id": "dms"
    }
    assert apply_followup_operation(matter(), "set_profile", {"profile_id": None}) == {
        "agent_profile_id": None
    }
    assert apply_followup_operation(matter(), "set_instructions", {"instructions": None}) == {
        "matter_instructions": None
    }


def test_instructions_length_is_capped():
    with pytest.raises(TriggerError, match="exceeds"):
        apply_followup_operation(matter(), "set_instructions", {"instructions": "x" * 4001})


def test_set_actions_replaces_actions_and_keeps_triggers():
    patch = apply_followup_operation(matter(), "set_actions", {"actions": ["summary"]})
    envelope = patch["schedule_json"]
    assert envelope["actions"] == ["summary"]
    assert len(envelope["triggers"]) == 3


def test_set_model_override_round_trips_and_clears():
    patch = apply_followup_operation(
        matter(), "set_model_override", {"agent": {"model": "claude-opus-5"}}
    )
    assert patch["schedule_json"]["agent"]["model"] == "claude-opus-5"
    cleared = apply_followup_operation(matter(), "set_model_override", {"agent": None})
    assert "agent" not in cleared["schedule_json"]


# ── 出口校验 ────────────────────────────────────────────────────────────────────


def test_a_bad_rule_is_refused_at_the_edit_instead_of_sleeping_until_the_worker():
    with pytest.raises(TriggerError):
        apply_followup_operation(
            matter(),
            "update_trigger",
            {"trigger_id": "mtr_sched", "trigger": {"rule": {"freq": "hourly"}}},
        )


def test_unknown_operation_is_refused():
    with pytest.raises(TriggerError, match="unknown operation"):
        apply_followup_operation(matter(), "set_triggers", {})
