"""S5 W5a — project_progress 行的 wire 投影 + config patch 往返 + 保存时校验。

纯函数（wire.resolve_agent / config_patch_to_db / validate_agent_config_patch）—— 无 transport。
"""
from __future__ import annotations

import json

import pytest

from src.agents.trigger import TriggerValidationError, validate_agent_config_patch
from src.reports import wire


def _pp_row(**over):
    row = {
        "id": "project_progress_sync",
        "type": "project_progress",
        "enabled": 1,
        "title": "项目周报同步",
        "trigger_json": json.dumps(
            {"v": 1, "kind": "email_filter", "subject_pattern": "sub", "sender_pattern": "snd@x.com"}
        ),
        "tool_policy_json": None,
        "budget_json": None,
    }
    row.update(over)
    return row


def test_resolve_projects_trigger_for_project_progress():
    out = wire.resolve_agent(_pp_row())
    assert out["type"] == "project_progress"
    assert out["enabled"] is True
    assert out["trigger"] == {
        "v": 1,
        "kind": "email_filter",
        "subject_pattern": "sub",
        "sender_pattern": "snd@x.com",
    }
    # tool_policy/budget 仍 custom-only（project_progress 执行不进 gateway）。
    assert out["tool_policy"] is None
    assert out["budget"] is None
    # search 专属字段不误投影。
    assert out["context_docs"] == []


def test_resolve_trigger_null_when_missing():
    out = wire.resolve_agent(_pp_row(trigger_json=None))
    assert out["trigger"] is None


def test_config_patch_roundtrip_enabled_and_trigger():
    patch = {
        "enabled": True,
        "trigger": {"v": 1, "kind": "email_filter", "subject_pattern": "X", "sender_pattern": "y@z"},
    }
    db_patch = wire.config_patch_to_db(patch)
    assert db_patch["enabled"] == 1
    assert json.loads(db_patch["trigger_json"])["subject_pattern"] == "X"


def test_validate_accepts_email_filter_trigger():
    # subject_pattern（正则可编译）→ 通过。
    validate_agent_config_patch(
        {"enabled": True, "trigger": {"v": 1, "kind": "email_filter", "subject_pattern": r"\[weekly\]"}}
    )
    # email 作 sender_pattern（合法正则）→ 通过。
    validate_agent_config_patch(
        {"trigger": {"v": 1, "kind": "email_filter", "sender_pattern": "weekly@corp.com"}}
    )


def test_validate_rejects_empty_trigger():
    """空触发（sender+subject 全空）= 死配置 → parse_trigger 拒（前端也先拦）。"""
    with pytest.raises(TriggerValidationError):
        validate_agent_config_patch(
            {"trigger": {"v": 1, "kind": "email_filter", "subject_pattern": "", "sender_pattern": ""}}
        )


def test_validate_skips_when_no_trigger_in_patch():
    """只改 enabled（不带 trigger）→ 不触发 parse_trigger 校验（PATCH 语义：字段缺席=不动）。"""
    validate_agent_config_patch({"enabled": False})  # 不抛
