"""wire 投影/patch 对 v30 custom agent 三列的处理（S4 W1, codex P2-3）。"""
from __future__ import annotations

import json

import pytest

from src.reports.wire import config_patch_to_db, resolve_agent


def test_resolve_custom_agent_projects_three_fields():
    agent = {
        "id": "c1", "type": "custom", "enabled": 1, "title": "DMS 审批",
        "trigger_json": json.dumps({"v": 1, "kind": "email_filter", "subject_pattern": "DMS"}),
        "tool_policy_json": json.dumps({"v": 1, "allowed_tools": ["email_get"]}),
        "budget_json": json.dumps({"v": 1, "max_steps": 4}),
    }
    out = resolve_agent(agent)
    assert out["trigger"]["kind"] == "email_filter"
    assert out["tool_policy"]["allowed_tools"] == ["email_get"]
    assert out["budget"]["max_steps"] == 4


def test_resolve_non_custom_projects_none():
    # report/preprocess/search 不用这三字段 → 恒 None（即便列有残值）。
    agent = {
        "id": "r1", "type": "report", "enabled": 1,
        "trigger_json": json.dumps({"v": 1, "kind": "cron", "cron": "0 9 * * *"}),
        "tool_policy_json": json.dumps({"v": 1}),
        "budget_json": json.dumps({"v": 1}),
    }
    out = resolve_agent(agent)
    assert out["trigger"] is None
    assert out["tool_policy"] is None
    assert out["budget"] is None


def test_resolve_custom_null_columns():
    agent = {"id": "c1", "type": "custom", "enabled": 1,
             "trigger_json": None, "tool_policy_json": None, "budget_json": None}
    out = resolve_agent(agent)
    assert out["trigger"] is None and out["tool_policy"] is None and out["budget"] is None


def test_patch_serializes_objects():
    patch = config_patch_to_db({
        "trigger": {"v": 1, "kind": "cron", "cron": "0 9 * * *"},
        "budget": {"v": 1, "max_steps": 8},
    })
    assert json.loads(patch["trigger_json"])["kind"] == "cron"
    assert json.loads(patch["budget_json"])["max_steps"] == 8


def test_patch_none_clears_column():
    patch = config_patch_to_db({"trigger": None})
    assert "trigger_json" in patch and patch["trigger_json"] is None


def test_patch_rejects_non_object():
    with pytest.raises(ValueError, match="trigger must be object or null"):
        config_patch_to_db({"trigger": "not an object"})


def test_patch_omits_unset_fields():
    # 未提供 → 不进 patch（不误清空）。
    patch = config_patch_to_db({"enabled": True})
    assert "trigger_json" not in patch
    assert "tool_policy_json" not in patch
    assert "budget_json" not in patch
