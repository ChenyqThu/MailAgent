"""trigger_json 解析/校验 + budget 解析单测（S4 W1, ADR D5/D7）。"""
from __future__ import annotations

import pytest

from src.agents.trigger import (
    MAX_PATTERN_LEN,
    MAX_STEPS_CEILING,
    Budget,
    CronTrigger,
    EmailFilterTrigger,
    ToolPolicy,
    ToolPolicyValidationError,
    TriggerValidationError,
    parse_budget,
    parse_tool_policy,
    parse_trigger,
    validate_agent_config_patch,
)


# ============================================================
# cron 触发
# ============================================================

def test_parse_cron_valid():
    t = parse_trigger({"v": 1, "kind": "cron", "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai"})
    assert isinstance(t, CronTrigger)
    assert t.cron == "0 9 * * 1-5"
    assert t.timezone == "Asia/Shanghai"


def test_parse_cron_json_string_input():
    t = parse_trigger('{"v":1,"kind":"cron","cron":"0 0 * * *"}')
    assert isinstance(t, CronTrigger)
    assert t.timezone == "UTC"  # 缺省 → UTC


def test_parse_cron_rejects_invalid_expr():
    with pytest.raises(TriggerValidationError, match="invalid cron"):
        parse_trigger({"v": 1, "kind": "cron", "cron": "99 99 * * *"})


def test_parse_cron_rejects_non_five_field():
    # 6-field（含秒）语义不同 → 拒（ADR 契约 = 标准 5-field）。
    with pytest.raises(TriggerValidationError, match="5-field"):
        parse_trigger({"v": 1, "kind": "cron", "cron": "0 0 9 * * 1-5"})


def test_parse_cron_rejects_special_string():
    with pytest.raises(TriggerValidationError, match="5-field"):
        parse_trigger({"v": 1, "kind": "cron", "cron": "@daily"})


def test_parse_cron_rejects_bad_timezone():
    with pytest.raises(TriggerValidationError, match="timezone"):
        parse_trigger({"v": 1, "kind": "cron", "cron": "0 9 * * *", "timezone": "Bad/Zone"})


# ============================================================
# email_filter 触发
# ============================================================

def test_parse_email_filter_valid():
    t = parse_trigger({
        "v": 1, "kind": "email_filter",
        "subject_pattern": "DMS.*审批", "sender_pattern": r"dms@corp\.com",
        "folders": ["收件箱", "审批"],
    })
    assert isinstance(t, EmailFilterTrigger)
    assert t.subject_pattern == "DMS.*审批"
    assert t.folders == ("收件箱", "审批")


def test_parse_email_filter_subject_only():
    t = parse_trigger({"v": 1, "kind": "email_filter", "subject_pattern": "invoice"})
    assert isinstance(t, EmailFilterTrigger)
    assert t.sender_pattern is None
    assert t.folders == ()


def test_parse_email_filter_folders_only():
    # 仅 folders（无正则）也合法 = 匹配该文件夹全部邮件。
    t = parse_trigger({"v": 1, "kind": "email_filter", "folders": ["收件箱"]})
    assert isinstance(t, EmailFilterTrigger)
    assert t.folders == ("收件箱",)


def test_parse_email_filter_rejects_all_empty():
    with pytest.raises(TriggerValidationError, match="at least one"):
        parse_trigger({"v": 1, "kind": "email_filter"})


def test_parse_email_filter_rejects_all_empty_strings():
    with pytest.raises(TriggerValidationError, match="at least one"):
        parse_trigger({"v": 1, "kind": "email_filter", "subject_pattern": "", "sender_pattern": ""})


# ============================================================
# ReDoS 收面（ADR D5 条件 ①）
# ============================================================

def test_parse_rejects_overlong_pattern():
    with pytest.raises(TriggerValidationError, match="too long"):
        parse_trigger({"v": 1, "kind": "email_filter", "subject_pattern": "a" * (MAX_PATTERN_LEN + 1)})


def test_parse_accepts_max_len_pattern():
    # 恰好上限（256）合法。
    t = parse_trigger({"v": 1, "kind": "email_filter", "subject_pattern": "a" * MAX_PATTERN_LEN})
    assert isinstance(t, EmailFilterTrigger)


def test_parse_rejects_uncompilable_regex():
    with pytest.raises(TriggerValidationError, match="valid regex"):
        parse_trigger({"v": 1, "kind": "email_filter", "subject_pattern": "([unclosed"})


# ============================================================
# 判别式 / 版本 / 形状
# ============================================================

def test_parse_rejects_unknown_kind():
    with pytest.raises(TriggerValidationError, match="unknown trigger kind"):
        parse_trigger({"v": 1, "kind": "webhook"})


def test_parse_rejects_unsupported_version():
    with pytest.raises(TriggerValidationError, match="unsupported trigger version"):
        parse_trigger({"v": 2, "kind": "cron", "cron": "0 9 * * *"})


def test_parse_version_defaults_to_one():
    # 缺 v → 视作 1（宽容）。
    t = parse_trigger({"kind": "cron", "cron": "0 9 * * *"})
    assert isinstance(t, CronTrigger)


def test_parse_rejects_none_and_empty():
    with pytest.raises(TriggerValidationError, match="empty or not an object"):
        parse_trigger(None)
    with pytest.raises(TriggerValidationError):
        parse_trigger("")


def test_parse_rejects_non_object_json():
    with pytest.raises(TriggerValidationError):
        parse_trigger("[1,2,3]")


# ============================================================
# budget（防御性：不抛，NULL/坏 → 默认 + clamp）
# ============================================================

def test_parse_budget_defaults():
    b = parse_budget(None)
    assert b == Budget()
    assert (b.max_steps, b.max_runs_per_day, b.max_run_seconds) == (8, 24, 300)


def test_parse_budget_custom():
    b = parse_budget({"v": 1, "max_steps": 4, "max_runs_per_day": 10, "max_run_seconds": 120})
    assert (b.max_steps, b.max_runs_per_day, b.max_run_seconds) == (4, 10, 120)


def test_parse_budget_clamps_max_steps():
    assert parse_budget({"v": 1, "max_steps": 999}).max_steps == MAX_STEPS_CEILING
    assert parse_budget({"v": 1, "max_steps": 0}).max_steps == 1  # 下限 1


def test_parse_budget_bad_json_returns_default():
    assert parse_budget("not json") == Budget()
    assert parse_budget({"v": 1, "max_steps": "abc"}).max_steps == 8  # 坏值回默认


def test_parse_budget_unknown_version_returns_default():
    assert parse_budget({"v": 99, "max_steps": 3}) == Budget()


# ============================================================
# validate_agent_config_patch（保存时深校验，P2-1）
# ============================================================

def test_validate_patch_accepts_valid_trigger():
    # 不抛 = 通过。
    validate_agent_config_patch({"trigger": {"v": 1, "kind": "cron", "cron": "0 9 * * *"}})
    validate_agent_config_patch(
        {"trigger": {"v": 1, "kind": "email_filter", "subject_pattern": "DMS"}}
    )


def test_validate_patch_rejects_bad_cron():
    with pytest.raises(TriggerValidationError):
        validate_agent_config_patch({"trigger": {"v": 1, "kind": "cron", "cron": "garbage"}})


def test_validate_patch_rejects_unknown_kind():
    with pytest.raises(TriggerValidationError, match="unknown trigger kind"):
        validate_agent_config_patch({"trigger": {"v": 1, "kind": "webhook"}})


def test_validate_patch_rejects_overlong_pattern():
    with pytest.raises(TriggerValidationError, match="too long"):
        validate_agent_config_patch(
            {"trigger": {"v": 1, "kind": "email_filter", "subject_pattern": "a" * 300}}
        )


def test_validate_patch_skips_when_no_trigger():
    # report/preprocess/search patch（无 trigger 键）不受影响。
    validate_agent_config_patch({"enabled": True, "model": "claude-opus-4-8"})
    validate_agent_config_patch({})


def test_validate_patch_skips_when_trigger_none():
    # 清空 trigger（None）跳过深校验（wire 会落 SQL NULL）。
    validate_agent_config_patch({"trigger": None})


def test_validate_patch_ignores_budget_but_checks_tool_policy_shape():
    # budget 不在此硬拒（值域运行时 clamp）；tool_policy 合法形状通过（S5 起坏形状硬拒，见下）。
    validate_agent_config_patch({"budget": {"max_steps": 999}, "tool_policy": {"allowed_tools": []}})


# ============================================================
# tool_policy 严格解析（S5 ADR-004 P1-4）
# ============================================================

def test_parse_tool_policy_unconfigured():
    tp = parse_tool_policy(None)
    assert tp.allowed_tools is None and tp.grant_exec is False and tp.grant_web == "off"
    assert tp.skills is None  # 未配置 → None（投影层代默认挂载集，rev3.1 §5.1）
    assert parse_tool_policy("") == ToolPolicy()


def test_parse_tool_policy_valid_shapes():
    tp = parse_tool_policy({"v": 1, "allowed_tools": ["email_get", "email_body"], "grant_exec": True})
    assert tp.allowed_tools == ("email_get", "email_body")
    assert tp.grant_exec is True
    assert tp.grant_web == "off"  # 缺省 off（现存行零迁移）
    # v 缺省视作 1；grant_exec 缺省 False；显式 [] → ()（区别于 None）。
    tp2 = parse_tool_policy({"allowed_tools": []})
    assert tp2.allowed_tools == () and tp2.grant_exec is False
    # JSON 串输入 + grant_exec 显式 False。
    tp3 = parse_tool_policy('{"v": 1, "grant_exec": false}')
    assert tp3.allowed_tools is None and tp3.grant_exec is False


@pytest.mark.parametrize("grant_web", ["off", "gated", "open"])
def test_parse_tool_policy_grant_web_literals(grant_web):
    # S6 W3（ADR-004 rev3.1 D6）：三态字面量逐个可解析。
    tp = parse_tool_policy({"v": 1, "grant_web": grant_web})
    assert tp.grant_web == grant_web


def test_parse_tool_policy_skills_shapes():
    """S6 W3（ADR-004 rev3.1 §3.2/§5.1）：skills 镜像 allowed_tools 的解析形状 —— 缺省 None /
    显式 [] → ()（零挂载 verbatim）/ list[str] 滤空串 → tuple。未安装名不校验（strict-effect）。"""
    assert parse_tool_policy({"v": 1}).skills is None
    tp = parse_tool_policy({"v": 1, "skills": []})
    assert tp.skills == ()
    tp2 = parse_tool_policy({"v": 1, "skills": ["email", "", "dms-cli"]})
    assert tp2.skills == ("email", "dms-cli")  # 空串滤除，未知名照收（效果为零）
    # JSON 串输入同形。
    tp3 = parse_tool_policy('{"v": 1, "skills": ["search"]}')
    assert tp3.skills == ("search",)


@pytest.mark.parametrize(
    "bad",
    [
        {"v": 2},                                    # 未知版本
        {"grant_exec": "yes"},                       # 字符串真值 → 拒（必须 JSON boolean）
        {"grant_exec": 1},                           # int 1 → 拒（bool 严格）
        {"grant_web": True},                         # bool → 拒（必须三态字面量，rev3.1）
        {"grant_web": 1},                            # int → 拒
        {"grant_web": "yes"},                        # 面外字符串 → 拒
        {"grant_web": "OPEN"},                       # 大小写敏感 → 拒（fail-closed）
        {"grant_web": {}},                           # object → 拒
        {"allowed_tools": "email_get"},              # 非 list
        {"allowed_tools": [1, 2]},                   # 非 str 项
        {"skills": "email"},                         # skills 非 list（裸串）→ 拒（rev3.1）
        {"skills": ["email", 3]},                    # skills 非 str 项 → 拒
        {"skills": {"email": True}},                 # skills object → 拒
        {"v": 1, "sneaky": True},                    # 未知键（extra forbid）
        "[]",                                         # 非 object JSON
        "not-json",                                   # 坏 JSON
    ],
)
def test_parse_tool_policy_rejects(bad):
    with pytest.raises(ToolPolicyValidationError):
        parse_tool_policy(bad)


def test_validate_patch_rejects_bad_tool_policy():
    with pytest.raises(ValueError):
        validate_agent_config_patch({"tool_policy": {"grant_exec": "yes"}})
    with pytest.raises(ValueError):
        validate_agent_config_patch({"tool_policy": {"v": 1, "unknown_key": 1}})
    # 清空（None）跳过（wire 落 SQL NULL）。
    validate_agent_config_patch({"tool_policy": None})
