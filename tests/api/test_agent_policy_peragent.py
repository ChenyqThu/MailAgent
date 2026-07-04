"""S5 per-agent 规则 CRUD REST + /policy/evaluate agentId + /agent-runs/tool-options 契约
（ADR-004 WA 验收）。

fixtures 全合成：fresh_agent_cfg（tmp agent_config.db）+ tmp SyncStore/ReportStore（custom agent
归属校验面）+ monkeypatch flag。auth bypass 默认 ON（conftest）。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

ECHO = os.path.realpath("/bin/echo")


@pytest.fixture()
def custom_agent_env(tmp_path, monkeypatch):
    """tmp sync_store + 两个 agent（custom email_filter / custom cron / 非 custom report）+
    flag on + get_report_store 指到 tmp 库（agent.py 建规归属校验 + reports 路由删除级联共用）。"""
    from src.mail.sync_store import SyncStore
    from src.reports.store import ReportStore

    db = tmp_path / "s.db"
    SyncStore(str(db))
    store = ReportStore(str(db))
    store.create_agent("dms", type="custom", enabled=True, title="DMS")
    store.update_agent("dms", {"trigger_json": json.dumps(
        {"v": 1, "kind": "email_filter", "subject_pattern": "DMS.*审批"})})
    store.create_agent("nightly", type="custom", enabled=True, title="Nightly")
    store.update_agent("nightly", {"trigger_json": json.dumps(
        {"v": 1, "kind": "cron", "cron": "0 9 * * 1-5"})})
    store.create_agent("daily", type="report", enabled=True, title="Daily")
    store.create_agent("broken", type="custom", enabled=True, title="Broken")  # 无 trigger_json

    import src.api.deps as deps
    import src.api.routers.agent as agent_router
    import src.api.routers.reports as reports_router

    monkeypatch.setattr(deps, "get_report_store", lambda: store)
    monkeypatch.setattr(reports_router, "get_report_store", lambda: store)
    monkeypatch.setattr(agent_router, "_custom_agents_enabled", lambda: True)
    return store


def _err(resp):
    j = resp.json()
    assert j["status"] == "error", j
    return resp.status_code, j["error"]["code"], j["error"]["message"]


def _create(client, body):
    return client.post("/api/agent/policy/rules", json=body)


# ── per-agent 建规：归属校验 / flag / context_mode 派生（ADR-004 §3.3）──────────────────


def test_peragent_create_flag_off_404(client, fresh_agent_cfg, custom_agent_env, monkeypatch):
    import src.api.routers.agent as agent_router

    monkeypatch.setattr(agent_router, "_custom_agents_enabled", lambda: False)
    code, err, _ = _err(_create(client, {
        "capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"}, "agentId": "dms",
    }))
    assert (code, err) == (404, "E_NOT_FOUND")


def test_peragent_create_domain_write_derives_context_mode(client, fresh_agent_cfg, custom_agent_env):
    # email_filter agent → untrusted_trigger。
    r = _create(client, {
        "capability": "domain_write", "matcher": {"v": 1, "tool": "email_draft_reply"},
        "agentId": "dms",
    })
    assert r.status_code == 201, r.json()
    d = r.json()["data"]
    assert d["agentId"] == "dms" and d["contextMode"] == "untrusted_trigger"
    # cron agent → cron_headless。
    r2 = _create(client, {
        "capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"},
        "agentId": "nightly",
    })
    assert r2.json()["data"]["contextMode"] == "cron_headless"


@pytest.mark.parametrize(
    "body,frag",
    [
        ({"capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"},
          "agentId": ""}, "non-empty"),                                  # 空串
        ({"capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"},
          "agentId": "ghost"}, "existing custom agent"),                 # 悬空
        ({"capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"},
          "agentId": "daily"}, "existing custom agent"),                 # 非 custom type
        ({"capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"},
          "agentId": "dms", "contextMode": "manual_chat"}, "derived"),   # 显式 contextMode 拒
        ({"capability": "file_read", "matcher": {"v": 1, "realpath_prefix": "/tmp"},
          "agentId": "dms"}, "only support"),                            # capability 面外
        ({"capability": "web", "matcher": {"v": 1, "origin": "https://x.com"},
          "agentId": "ghost"}, "existing custom agent"),                 # web 同套归属校验
        ({"capability": "web", "matcher": {"v": 1, "origin": "https://x.com"},
          "agentId": "dms", "contextMode": "manual_chat"}, "derived"),   # web 同套派生纪律
        ({"capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"},
          "agentId": "broken"}, "invalid trigger_json"),                 # 坏 trigger 无法派生
    ],
)
def test_peragent_create_rejections(client, fresh_agent_cfg, custom_agent_env, body, frag):
    code, err, msg = _err(_create(client, body))
    assert code == 400 and err == "E_INVALID_ARG"
    assert frag in msg


def test_global_create_unchanged_and_domain_write_requires_agent(client, fresh_agent_cfg, custom_agent_env):
    # 全局分支 S2 语义不变：exec + contextMode 默认 manual_chat。
    r = _create(client, {
        "capability": "exec",
        "matcher": {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"any": True}]},
    })
    assert r.status_code == 201
    d = r.json()["data"]
    assert d["agentId"] is None and d["contextMode"] == "manual_chat"
    # domain_write 是 per-agent 专属。
    code, err, msg = _err(_create(client, {
        "capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"},
    }))
    assert code == 400 and "per-agent only" in msg


# ── per-agent exec：pinned-entrypoint 形状闸（ADR-004 §4.3 拒建矩阵）─────────────────────


def _install_pack(client, tmp_path, name="dms-approve"):
    """真实两段式供应链装入（files_json = confirm 落库事实）→ 返回 entrypoint 绝对路径。"""
    import zipfile

    z = tmp_path / f"{name}.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("manifest.json", json.dumps({
            "manifest_version": 2, "type": "script", "name": name, "version": "1.0",
            "title": "T", "description": "d", "entry_hint": "python3 main.py", "secrets": [],
        }))
        zf.writestr("SKILL.md", "# t")
        zf.writestr("main.py", "print('ok')")
    preview = client.post("/api/agent/skills/fetch", json={"localPath": str(z)}).json()["data"]
    r = client.post("/api/agent/skills/confirm", json={
        "quarantineId": preview["quarantineId"],
        "expectedPackageHash": preview["packageHash"],
        "expectedFiles": preview["files"],
    })
    assert r.status_code == 201, r.json()
    from src.skills.pack_fetch import skill_dir

    return os.path.join(skill_dir(name), "main.py")


def test_peragent_exec_pinned_entrypoint_accepted(client, fresh_agent_cfg, fresh_skills_dir,
                                                  custom_agent_env, tmp_path):
    main_py = _install_pack(client, tmp_path)
    r = _create(client, {
        "capability": "exec",
        "matcher": {
            "v": 1,
            "argv0_realpath": os.path.realpath("/bin/echo"),
            "argv_template": [
                {"pin": main_py},
                {"arg": {"kind": "enum", "values": ["approve", "reject"]}},
            ],
        },
        "agentId": "dms",
    })
    assert r.status_code == 201, r.json()
    assert r.json()["data"]["contextMode"] == "untrusted_trigger"


@pytest.mark.parametrize("template_tail", [[{"any": True}], []])
def test_peragent_exec_rejects_raw_any_and_missing_entrypoint(
    client, fresh_agent_cfg, fresh_skills_dir, custom_agent_env, tmp_path, template_tail
):
    main_py = _install_pack(client, tmp_path)
    # raw {any} 尾位 / 空模板（无 argv[1]）都 400。
    template = ([{"pin": main_py}] + template_tail) if template_tail else []
    code, err, msg = _err(_create(client, {
        "capability": "exec",
        "matcher": {"v": 1, "argv0_realpath": ECHO, "argv_template": template},
        "agentId": "dms",
    }))
    assert code == 400 and "invalid headless exec rule" in msg


def test_peragent_exec_rejects_non_skill_argv1(client, fresh_agent_cfg, fresh_skills_dir,
                                               custom_agent_env, tmp_path):
    rogue = tmp_path / "rogue.py"
    rogue.write_text("x")
    code, _, msg = _err(_create(client, {
        "capability": "exec",
        "matcher": {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"pin": str(rogue)}]},
        "agentId": "dms",
    }))
    assert code == 400 and "invalid headless exec rule" in msg
    # manual 全局同 matcher 词汇零改动：非 skill pin 照常可建（S2 语义）。
    r = _create(client, {
        "capability": "exec",
        "matcher": {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"pin": str(rogue)}]},
    })
    assert r.status_code == 201


# ── per-agent web：域名白名单建规 + 双键 evaluate（S6 W3，ADR-004 rev3.1 F#1 语义翻转）────────
#
# 🔴 本节是对 rev1「web 全不引入」拒断言的**有意翻转**（rev3.1 §13 F#1 明示，非 frozen 面）：
# per-agent web 规则（gated web_fetch 域名白名单）可建，走同套归属校验 + context_mode 派生；
# matcher = WebMatcher {v:1, origin}，**无** headless 专用形状闸（exec 的 pinned-entrypoint 闸
# 不适用于 web —— 负断言见 evaluate 测试：普通 origin 规则照样 auto_allow）。


def test_peragent_web_rule_created_with_derived_context(client, fresh_agent_cfg, custom_agent_env):
    r = _create(client, {
        "capability": "web", "matcher": {"v": 1, "origin": "https://api.vendor.test"},
        "agentId": "dms",
    })
    assert r.status_code == 201, r.json()
    d = r.json()["data"]
    assert d["agentId"] == "dms" and d["contextMode"] == "untrusted_trigger"
    assert d["capability"] == "web" and d["dangerous"] is False
    # cron agent → cron_headless（同 domain_write 派生表）。
    r2 = _create(client, {
        "capability": "web", "matcher": {"v": 1, "origin": "http://feeds.corp.test:8080"},
        "agentId": "nightly",
    })
    assert r2.json()["data"]["contextMode"] == "cron_headless"
    # 坏 origin matcher → 422（WebMatcher _valid_origin 权威）。
    code, err, _ = _err(_create(client, {
        "capability": "web", "matcher": {"v": 1, "origin": "ftp://x.com"}, "agentId": "dms",
    }))
    assert code == 422


def test_peragent_web_evaluate_dual_key_no_exec_shape_gate(client, fresh_agent_cfg, custom_agent_env):
    """双键隔离（manual 不见 per-agent web 规则、他 agent 不见）+ 负断言：web capability 不进
    headless_exec_rule_problem 分支 —— 普通 origin 规则（非 pinned-entrypoint 形状）在 headless
    evaluate 照样 auto_allow（若误挂 exec 形状闸会被 skip → ask，本测试即红）。"""
    _create(client, {"capability": "web", "matcher": {"v": 1, "origin": "https://api.vendor.test"},
                     "agentId": "dms"})
    body = {"capability": "web", "action": {"url": "https://api.vendor.test/v1/data?q=1"},
            "contextMode": "untrusted_trigger"}
    # 带 agentId → 命中（canonical origin 归一：完整 URL → origin 等值）。
    d = client.post("/api/agent/policy/evaluate", json={**body, "agentId": "dms"}).json()["data"]
    assert d["decision"] == "auto_allow" and d["rule_id"] is not None
    # manual（无 agentId）→ per-agent 规则不进候选 → ask（红线①双向隔离）。
    assert client.post("/api/agent/policy/evaluate", json=body).json()["data"]["decision"] == "ask"
    # 他 agent → ask（严格等值）。
    assert client.post(
        "/api/agent/policy/evaluate", json={**body, "agentId": "other"}
    ).json()["data"]["decision"] == "ask"
    # 非白名单域 → ask（origin 等值，子域不命中）。
    assert client.post(
        "/api/agent/policy/evaluate",
        json={**body, "action": {"url": "https://sub.api.vendor.test/"}, "agentId": "dms"},
    ).json()["data"]["decision"] == "ask"


# ── list 过滤 + evaluate agentId + 删除级联 ─────────────────────────────────────────────


def test_list_rules_agent_filter(client, fresh_agent_cfg, custom_agent_env):
    _create(client, {"capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"},
                     "agentId": "dms"})
    _create(client, {"capability": "exec",
                     "matcher": {"v": 1, "argv0_realpath": ECHO, "argv_template": []}})
    all_rules = client.get("/api/agent/policy/rules").json()["data"]["rules"]
    assert len(all_rules) == 2
    dms_rules = client.get("/api/agent/policy/rules", params={"agentId": "dms"}).json()["data"]["rules"]
    assert len(dms_rules) == 1 and dms_rules[0]["agentId"] == "dms"


def test_evaluate_endpoint_agent_id_dual_key(client, fresh_agent_cfg, custom_agent_env):
    _create(client, {"capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"},
                     "agentId": "dms"})
    body = {"capability": "domain_write", "action": {"tool": "email_flag"},
            "contextMode": "untrusted_trigger"}
    # 无 agentId（manual 现状路径）→ per-agent 规则不进候选 → ask。
    assert client.post("/api/agent/policy/evaluate", json=body).json()["data"]["decision"] == "ask"
    # 带 agentId → auto_allow。
    d = client.post("/api/agent/policy/evaluate", json={**body, "agentId": "dms"}).json()["data"]
    assert d["decision"] == "auto_allow" and d["rule_id"] is not None
    # 他 agent → ask（严格等值）。
    assert client.post(
        "/api/agent/policy/evaluate", json={**body, "agentId": "other"}
    ).json()["data"]["decision"] == "ask"
    # 非法类型 → 400。
    r = client.post("/api/agent/policy/evaluate", json={**body, "agentId": 42})
    assert r.status_code == 400


def test_delete_agent_cascades_policy_rules(client, fresh_agent_cfg, custom_agent_env):
    _create(client, {"capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"},
                     "agentId": "dms"})
    _create(client, {"capability": "exec",
                     "matcher": {"v": 1, "argv0_realpath": ECHO, "argv_template": []}})
    r = client.delete("/api/report-agents/dms")
    assert r.status_code == 200, r.json()
    rules = client.get("/api/agent/policy/rules").json()["data"]["rules"]
    # per-agent 行级联清掉；全局（NULL）规则保留。
    assert len(rules) == 1 and rules[0]["agentId"] is None


# ── tool-options 契约（形状冻结）+ catalog 一致性闸 ─────────────────────────────────────


def test_tool_options_flag_off_404(client, monkeypatch):
    import src.api.routers.agent_runs as agent_runs

    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    assert client.get("/api/agent-runs/tool-options").status_code == 404


def test_tool_options_contract_shape(client, monkeypatch):
    import src.api.routers.agent_runs as agent_runs

    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: True)
    d = client.get("/api/agent-runs/tool-options").json()["data"]
    assert set(d.keys()) == {"tools", "defaults"}
    assert isinstance(d["tools"], list) and isinstance(d["defaults"], list)
    for t in d["tools"]:
        assert set(t.keys()) == {"name", "class"}
        assert t["class"] in ("read", "domain_write")
    names = [t["name"] for t in d["tools"]]
    assert len(names) == len(set(names))
    # defaults ⊆ tools（Settings 勾选面自洽）。
    assert set(d["defaults"]) <= set(names)
    assert list(d["defaults"]) == list(agent_runs.DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS)


def test_tool_options_consistent_with_tool_catalog():
    """HEADLESS_TOOL_OPTIONS 与 tests/agent_eval/tool_catalog.json 的 tool_class 轴单源一致：
    集合 = catalog 内全部 read+domain_write 工具；class 逐名相同（R4 catalog 闸的 Python 侧延伸，
    新读/写工具漏 HEADLESS_TOOL_OPTIONS 必红）。"""
    from src.api.routers.agent_runs import (
        DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS,
        HEADLESS_TOOL_OPTIONS,
    )

    catalog_path = Path(__file__).resolve().parents[1] / "agent_eval" / "tool_catalog.json"
    catalog = json.loads(catalog_path.read_text())["tools"]
    expected = {
        name: meta["tool_class"]
        for name, meta in catalog.items()
        if meta["tool_class"] in ("read", "domain_write")
    }
    assert dict(HEADLESS_TOOL_OPTIONS) == expected
    # 默认安全集成员必须都在 headless 地板内。
    assert set(DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS) <= set(expected)
