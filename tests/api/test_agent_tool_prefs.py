"""/api/agent/tool-prefs*（08-05 WP-11）—— built-in 写工具的 per-tool 审批档端点。

owner-only（verify_cf_access，conftest auth bypass 默认开）。每测试独立临时
agent_config.db（fresh_agent_cfg fixture）。覆盖：出厂默认全表 / PUT 覆盖 + 清除 /
不可配置工具 4xx / bulk（组/显式/互斥）/ preset / reset / send 白名单校验 /
acceptEdits 存量行为保持迁移 / 无凭证 401。
"""

from __future__ import annotations

import src.api.auth as auth_mod
from src.agent_config.store import AgentConfigStore
from src.agent_config.tool_prefs import (
    ACCEPT_EDITS_PRESET,
    BUILTIN_TOOL_POLICIES,
    BUILTIN_TOOL_POLICY_BY_NAME,
)


def _rows(client) -> dict[str, dict]:
    r = client.get("/api/agent/tool-prefs")
    assert r.status_code == 200
    data = r.json()["data"]
    return {row["toolName"]: row for row in data["tools"]}


# ── 出厂默认（08-05 拍板全表；改这里 = 改产品拍板，勿静默动）─────────────────────────

# 第一刀（频次数据）9 + A 组放宽 2 = 11 个默认 auto。
EXPECTED_DEFAULT_AUTO = {
    "email_flag",
    "email_archive",
    "email_pin",
    "email_resync",
    "email_draft_reply",
    "email_draft_compose",
    "email_draft_update",
    "web_fetch",
    "web_search",
    "skill_uninstall",
    "skill_draft_create",
    "skill_draft_write_file",
    "skill_draft_discard",
    "custom_agent_run_now",
    # Matters MVP P3 决策 D7：matter 本地可逆写默认 auto（审计 + 可撤销回执）。
    "matter_create",
    "matter_update",
    "matter_item_mutate",
    "matter_resource_mutate",
    "matter_stakeholder_mutate",
    "matter_relation_mutate",
    "matter_add_note",
    # Matters MVP P4 D8：启动/取消一轮跟进 run —— 本地可逆（取消不回滚已观察到的事实，
    # 但它本身不落任何 Matter 状态），与 custom_agent_run_now 同档。
    "matter_run_control",
    # 0813 轮 3 批 R：关注信号处置 / 资料建议整批处置 —— 同为本地派生态写，同档。
    "matter_attention_triage",
    "matter_suggestion_resolve",
}
# configurable=False（固定形状）：send=收件人白名单 / run_command=policy_rules /
# 供应链两卡 / custom-agent CRUD（run_now 除外）。
EXPECTED_FIXED_ASK = {
    "email_prepare_send",
    "run_command",
    "skill_install",
    "skill_install_confirm",
    "skill_draft_publish",
    "custom_agent_create",
    "custom_agent_update",
    "custom_agent_delete",
    "custom_agent_call",
    # Matters MVP P4 D8：评审决定的免卡形状是 gateway 侧的**动态** policyEvaluate（非 manual
    # 恒卡 / manual 拒绝免卡 / manual 接受且选中含 field change 弹卡），不是一个静态档 ——
    # 故不可配置且出厂 ask：owner 把它调成无条件 auto 就会绕过 field-accept 那张卡。
    "matter_review_update",
    # task 08-14：内建 agent 的写面与事项跟进的触发条件。两者都是「已经在跑 / 无人值守 +
    # 有网络出口」的 agent 的开关面 —— 设 auto 意味着邮件正文里一句注入就能改掉每日报告的
    # prompt 或某个事项的跟进排程（同 custom_agent_update 的论证）。
    "internal_agent_update",
    "matter_followup_mutate",
}
# D2=a：设 auto 需红警告 + 一次性确认。
EXPECTED_DANGER_AUTO = {"calendar_event_delete", "notion_agent_chat"}


def test_get_factory_defaults_full_table(client, fresh_agent_cfg):
    rows = _rows(client)
    assert set(rows) == {p.tool_name for p in BUILTIN_TOOL_POLICIES}
    for name, row in rows.items():
        assert row["tier"] is None, f"{name} should have no override on a fresh db"
        expected_default = "auto" if name in EXPECTED_DEFAULT_AUTO else "ask"
        assert row["defaultTier"] == expected_default, name
        assert row["effectiveTier"] == expected_default, name
        assert row["configurable"] is (name not in EXPECTED_FIXED_ASK), name
        assert row["dangerAuto"] is (name in EXPECTED_DANGER_AUTO), name


def test_put_override_and_clear(client, fresh_agent_cfg):
    # 显式 ask 覆盖一个默认 auto 的工具
    r = client.put("/api/agent/tool-prefs/email_draft_reply", json={"tier": "ask"})
    assert r.status_code == 200
    rows = _rows(client)
    assert rows["email_draft_reply"]["tier"] == "ask"
    assert rows["email_draft_reply"]["effectiveTier"] == "ask"
    # deny 也是合法覆盖
    client.put("/api/agent/tool-prefs/web_search", json={"tier": "deny"})
    assert _rows(client)["web_search"]["effectiveTier"] == "deny"
    # 持久化（重启存活语义）
    st2 = AgentConfigStore(fresh_agent_cfg.db_path)
    assert st2.get_tool_approval_prefs()["email_draft_reply"] == "ask"
    # null = 清覆盖回默认
    r2 = client.put("/api/agent/tool-prefs/email_draft_reply", json={"tier": None})
    assert r2.status_code == 200
    rows2 = _rows(client)
    assert rows2["email_draft_reply"]["tier"] is None
    assert rows2["email_draft_reply"]["effectiveTier"] == "auto"


def test_put_rejects_unknown_and_fixed_and_junk(client, fresh_agent_cfg):
    # 未知工具（connector 动态名也算未知 —— WP-10 的三档体系不进这张表）
    assert client.put("/api/agent/tool-prefs/nope", json={"tier": "auto"}).status_code == 404
    assert (
        client.put("/api/agent/tool-prefs/mcp__notion__search", json={"tier": "auto"}).status_code
        == 404
    )
    # 不可配置（D2=a：send 不给裸 auto；run_command 的可配面是 policy_rules）
    for fixed in ("email_prepare_send", "run_command", "skill_install", "custom_agent_create"):
        r = client.put(f"/api/agent/tool-prefs/{fixed}", json={"tier": "auto"})
        assert r.status_code == 400, fixed
        assert r.json()["error"]["code"] == "E_INVALID_ARG"
    # 值域外档位
    r = client.put("/api/agent/tool-prefs/email_flag", json={"tier": "yes"})
    assert r.status_code == 400
    # 全部拒绝之后库里零覆盖行
    assert fresh_agent_cfg.get_tool_approval_prefs() == {}


def test_bulk_by_group_skips_fixed(client, fresh_agent_cfg):
    # outbound 组含 send（不可配置）——组级批量必须跳过它而不是 400/打穿
    r = client.post("/api/agent/tool-prefs/bulk", json={"tier": "ask", "group": "outbound"})
    assert r.status_code == 200
    assert r.json()["data"]["updated"] == 1  # 只有 notion_agent_chat 可配置
    prefs = fresh_agent_cfg.get_tool_approval_prefs()
    assert prefs == {"notion_agent_chat": "ask"}
    # 显式 tools 名单里出现不可配置名 → 整批 400（显式点名必须精确）
    r2 = client.post(
        "/api/agent/tool-prefs/bulk",
        json={"tier": "auto", "tools": ["email_flag", "email_prepare_send"]},
    )
    assert r2.status_code == 400
    assert fresh_agent_cfg.get_tool_approval_prefs() == {"notion_agent_chat": "ask"}
    # group 与 tools 互斥
    r3 = client.post(
        "/api/agent/tool-prefs/bulk",
        json={"tier": "auto", "group": "web", "tools": ["web_fetch"]},
    )
    assert r3.status_code == 400
    # 未知组
    assert (
        client.post("/api/agent/tool-prefs/bulk", json={"tier": "auto", "group": "nope"}).status_code
        == 400
    )


def test_preset_and_reset(client, fresh_agent_cfg):
    r = client.post("/api/agent/tool-prefs/preset", json={"preset": "acceptEdits"})
    assert r.status_code == 200
    assert r.json()["data"]["updated"] == len(ACCEPT_EDITS_PRESET)
    prefs = fresh_agent_cfg.get_tool_approval_prefs()
    assert set(prefs) == set(ACCEPT_EDITS_PRESET)
    assert set(prefs.values()) == {"auto"}
    # 未知 preset → 400
    assert (
        client.post("/api/agent/tool-prefs/preset", json={"preset": "nope"}).status_code == 400
    )
    # reset 清空全部覆盖
    r2 = client.post("/api/agent/tool-prefs/reset")
    assert r2.status_code == 200
    assert r2.json()["data"]["removed"] == len(ACCEPT_EDITS_PRESET)
    assert fresh_agent_cfg.get_tool_approval_prefs() == {}


def test_send_whitelist_validation_and_roundtrip(client, fresh_agent_cfg):
    # 合法：完整邮箱 + @域名；大小写归一 + 去重
    r = client.put(
        "/api/agent/send-whitelist",
        json={"recipients": ["A@Corp.Test", "@corp.test", "a@corp.test"]},
    )
    assert r.status_code == 200
    assert r.json()["data"]["sendWhitelist"] == ["a@corp.test", "@corp.test"]
    assert _rows(client)  # GET 面也带白名单
    assert (
        client.get("/api/agent/tool-prefs").json()["data"]["sendWhitelist"]
        == ["a@corp.test", "@corp.test"]
    )
    # 非法条目整批拒绝（白名单是安全数据，不静默丢弃）
    for bad in (["not-an-email"], ["@"], ["@x"], ["a@b"], [""], "a@corp.test", [1]):
        r2 = client.put("/api/agent/send-whitelist", json={"recipients": bad})
        assert r2.status_code == 400, bad
    # 失败不落库
    assert (
        client.get("/api/agent/tool-prefs").json()["data"]["sendWhitelist"]
        == ["a@corp.test", "@corp.test"]
    )
    # 空数组 = 清空 = send 恒 ask
    r3 = client.put("/api/agent/send-whitelist", json={"recipients": []})
    assert r3.status_code == 200
    assert r3.json()["data"]["sendWhitelist"] == []


def test_accept_edits_migration_preserves_behaviour(tmp_path, monkeypatch):
    """08-05 WP-11 —— 存量 chat_approval_mode='acceptEdits' 的一次性行为保持折算：
    15 个预设成员落显式 auto 覆盖行 + 模式改回 manual；幂等（重开库不重跑）。"""
    db = str(tmp_path / "agent_config.db")
    st = AgentConfigStore(db)
    st.set_owner_setting("chat_approval_mode", "acceptEdits")
    # 重开库触发 _migrate_additive
    st2 = AgentConfigStore(db)
    assert st2.get_owner_setting("chat_approval_mode") == "manual"
    prefs = st2.get_tool_approval_prefs()
    assert set(prefs) == set(ACCEPT_EDITS_PRESET)
    assert set(prefs.values()) == {"auto"}
    # 幂等：owner 事后清掉一个覆盖，再开库不得被迁移重新写回
    st2.set_tool_approval_pref("web_fetch", None)
    st3 = AgentConfigStore(db)
    assert "web_fetch" not in st3.get_tool_approval_prefs()
    assert st3.get_owner_setting("chat_approval_mode") == "manual"


def test_effective_tier_junk_override_folds_to_ask():
    """check 2026-08-05 —— 值域外野值（只可能来自手改 DB）双侧 fail-closed 到「弹卡」：
    Python effective_tool_tier 折 'ask'（**不是** default_tier——出厂 auto 工具上折默认
    = 折免卡，方向反了）；TS lifecycle resolver 对同一行整行丢弃 = 同样落回弹卡。"""
    from src.agent_config.tool_prefs import effective_tool_tier

    # 出厂 auto 的工具：野值必须折 ask（这正是原实现的 bug 面）
    assert effective_tool_tier("email_flag", "yes") == "ask"
    # 出厂 ask 的工具：野值同样折 ask
    assert effective_tool_tier("calendar_event_delete", "junk") == "ask"
    # 无覆盖 → 跟随出厂默认（两方向都验）
    assert effective_tool_tier("email_flag", None) == "auto"
    assert effective_tool_tier("calendar_event_delete", None) == "ask"
    # 合法覆盖原样生效；未知工具名恒 ask
    assert effective_tool_tier("email_flag", "deny") == "deny"
    assert effective_tool_tier("mcp__notion__search", "auto") == "ask"


def test_registry_sanity(client, fresh_agent_cfg):
    """注册表自洽：预设成员全部可配置；danger 行可配置；fixed 行默认 ask。"""
    for name in ACCEPT_EDITS_PRESET:
        assert BUILTIN_TOOL_POLICY_BY_NAME[name].configurable, name
    for name in EXPECTED_DANGER_AUTO:
        assert BUILTIN_TOOL_POLICY_BY_NAME[name].configurable, name
        assert BUILTIN_TOOL_POLICY_BY_NAME[name].default_tier == "ask", name
    for name in EXPECTED_FIXED_ASK:
        assert BUILTIN_TOOL_POLICY_BY_NAME[name].default_tier == "ask", name


def test_unauthenticated_401(client, fresh_agent_cfg, monkeypatch):
    """无凭证 → 401：per-tool 档是 owner 面（verify_cf_access；无任何 gateway 工具可写）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    assert client.get("/api/agent/tool-prefs").status_code == 401
    assert (
        client.put("/api/agent/tool-prefs/email_flag", json={"tier": "ask"}).status_code == 401
    )
    assert client.post("/api/agent/tool-prefs/bulk", json={"tier": "ask"}).status_code == 401
    assert (
        client.post("/api/agent/tool-prefs/preset", json={"preset": "acceptEdits"}).status_code
        == 401
    )
    assert client.post("/api/agent/tool-prefs/reset").status_code == 401
    assert client.put("/api/agent/send-whitelist", json={"recipients": []}).status_code == 401
    assert fresh_agent_cfg.get_tool_approval_prefs() == {}
