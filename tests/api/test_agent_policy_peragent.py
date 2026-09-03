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
    store.create_agent("sched", type="custom", enabled=True, title="Sched")
    store.update_agent("sched", {"trigger_json": json.dumps({
        "v": 1, "kind": "schedule",
        "rule": {"freq": "weekly", "interval": 2, "weekdays": [1], "monthMode": "date",
                 "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0,
                 "clamp": False},
        "anchor": "2026-07-06", "timezone": "Asia/Shanghai"})})
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


def test_peragent_create_schedule_agent_derives_cron_headless(client, fresh_agent_cfg, custom_agent_env):
    """kind='schedule'（schedule-builder）与 cron 同为定时 headless → 盖章 cron_headless。

    🔴 与 gateway TS ``deriveContextMode`` 是同一张表、必须同批改：Python 盖
    untrusted_trigger 而 gateway 按 cron_headless 求值时，owner 配的免卡规则**永不命中**
    （每个动作恒 HITL）。本用例锁 Python 半边；TS 半边在 frontend 测试里锁。"""
    r = _create(client, {
        "capability": "domain_write", "matcher": {"v": 1, "tool": "email_flag"},
        "agentId": "sched",
    })
    assert r.status_code == 201, r.json()
    assert r.json()["data"]["contextMode"] == "cron_headless"


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


def _mount_skills(store, agent_id, skills, **extra):
    """agent 行挂载 skill（S6 W3 rev3.1 §5.2：exec 规则引用的 installed skill 必须 ∈ 挂载集）。"""
    store.update_agent(agent_id, {"tool_policy_json": json.dumps(
        {"v": 1, "skills": skills, **extra})})


def test_peragent_exec_pinned_entrypoint_accepted(client, fresh_agent_cfg, fresh_skills_dir,
                                                  custom_agent_env, tmp_path):
    main_py = _install_pack(client, tmp_path)
    _mount_skills(custom_agent_env, "dms", ["dms-approve"])  # 归属闸前置：先挂载
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


# ── per-agent exec：挂载归属闸（S6 W3, rev3.1 §5.2 —— 形状闸之上第四层纯收窄）──────────────


def test_peragent_exec_mount_gate_create_and_evaluate(
    client,
    fresh_agent_cfg,
    fresh_skills_dir,
    custom_agent_env,
    tmp_path,
    monkeypatch,
):
    """建规侧：引用未挂载 installed skill → 400（提示先挂载）；挂载（含默认集缺省 = 未挂）后
    201。evaluate 侧：挂载 + 首跑在位 → auto_allow；owner 卸挂载 → 规则静默 dormant（ask），
    规则行不删 —— 重挂载即恢复（fail-closed 方向全程成立）。"""
    import hashlib

    main_py = _install_pack(client, tmp_path)
    matcher = {"v": 1, "argv0_realpath": os.path.realpath("/bin/echo"),
               "argv_template": [{"pin": main_py}]}
    # 未挂载（tool_policy 缺省 → 默认挂载集 email/search/report，不含 installed skill）→ 400。
    code, _, msg = _err(_create(client, {"capability": "exec", "matcher": matcher,
                                         "agentId": "dms"}))
    assert code == 400 and "not mounted" in msg
    # 显式零挂载 → 同 400。
    _mount_skills(custom_agent_env, "dms", [])
    code2, _, msg2 = _err(_create(client, {"capability": "exec", "matcher": matcher,
                                           "agentId": "dms"}))
    assert code2 == 400 and "not mounted" in msg2
    # 挂载后 → 201。
    _mount_skills(custom_agent_env, "dms", ["email", "dms-approve"])
    r = _create(client, {"capability": "exec", "matcher": matcher, "agentId": "dms"})
    assert r.status_code == 201, r.json()
    rid = r.json()["data"]["id"]

    # evaluate 侧：首跑记录直写（run 端点链在 dms e2e 全跑，此处只验挂载闸的判决翻转）。
    digest = hashlib.sha256(open(main_py, "rb").read()).hexdigest()
    fresh_agent_cfg.merge_first_run_approved(
        "dms-approve", {os.path.realpath(main_py): {"version": "1.0", "entrypoint_hash": digest}})
    skill_row = fresh_agent_cfg.get_skill("dms-approve")
    assert skill_row is not None and skill_row.package_hash
    body = {"capability": "exec", "action": {"argv": [os.path.realpath("/bin/echo"), main_py]},
            "contextMode": "untrusted_trigger", "agentId": "dms"}
    assert client.post("/api/agent/policy/evaluate", json=body).json()["data"]["decision"] == "ask"
    fresh_agent_cfg.grant_skill_trust(
        "trust-dms-approve-mismatch",
        "dms-approve",
        skill_row.package_hash,
        os.path.realpath(main_py),
        {"argvPattern": [os.path.realpath("/bin/echo"), "pattern:^never$"]},
    )
    assert client.post("/api/agent/policy/evaluate", json=body).json()["data"]["decision"] == "ask"
    trust = fresh_agent_cfg.grant_skill_trust(
        "trust-dms-approve",
        "dms-approve",
        skill_row.package_hash,
        os.path.realpath(main_py),
        {"argvPattern": [os.path.realpath("/bin/echo"), main_py]},
    )
    d = client.post("/api/agent/policy/evaluate", json=body).json()["data"]
    assert d == {"decision": "auto_allow", "rule_id": rid}
    # owner 卸挂载 → 同 action dormant skip（规则行仍在，不放行）。
    _mount_skills(custom_agent_env, "dms", ["email"])
    d2 = client.post("/api/agent/policy/evaluate", json=body).json()["data"]
    assert d2 == {"decision": "ask", "rule_id": None}
    # 重挂载 → 恢复 auto_allow（dormant 非删除）。
    _mount_skills(custom_agent_env, "dms", ["dms-approve"])
    d3 = client.post("/api/agent/policy/evaluate", json=body).json()["data"]
    assert d3["decision"] == "auto_allow"
    fresh_agent_cfg.install_skill(
        "dms-approve",
        source_type=skill_row.source_type,
        manifest=skill_row.manifest,
        manifest_version=skill_row.manifest_version,
        version=skill_row.version,
        source_uri=skill_row.source_uri,
        package_hash="f" * 64,
        files_json=skill_row.files_json,
        enabled=skill_row.enabled,
    )
    assert client.post("/api/agent/policy/evaluate", json=body).json()["data"]["decision"] == "ask"
    fresh_agent_cfg.install_skill(
        "dms-approve",
        source_type=skill_row.source_type,
        manifest=skill_row.manifest,
        manifest_version=skill_row.manifest_version,
        version=skill_row.version,
        source_uri=skill_row.source_uri,
        package_hash=skill_row.package_hash,
        files_json=skill_row.files_json,
        enabled=skill_row.enabled,
    )
    assert fresh_agent_cfg.revoke_skill_trust(trust.id) is True
    assert client.post("/api/agent/policy/evaluate", json=body).json()["data"]["decision"] == "ask"
    monkeypatch.setattr("src.skills.flags.skill_creator_enabled", lambda: False)
    assert (
        client.post("/api/agent/policy/evaluate", json=body).json()["data"]["decision"]
        == "auto_allow"
    )


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


def test_peragent_web_origin_normalized_on_store_echo(client, fresh_agent_cfg, custom_agent_env):
    """S6 W3-3（rev3.1 §4.2 ①/D-fix-4 ④）：web origin 归一入库 —— 完整 URL / 混大小写 / 缺省端口
    提交 → 返回行 matcher.origin = canonical ``scheme://host:port``（Settings/PIN 直接回显该值）。"""
    # 完整 URL（含 path/query）+ 大写 host + 缺省端口 → 塌成 https://api.vendor.test:443。
    r = _create(client, {
        "capability": "web",
        "matcher": {"v": 1, "origin": "HTTPS://API.Vendor.Test/v1/data?q=1"},
        "agentId": "dms",
    })
    assert r.status_code == 201, r.json()
    assert r.json()["data"]["matcher"]["origin"] == "https://api.vendor.test:443"
    # 显式非默认端口保留、host 小写。
    r2 = _create(client, {
        "capability": "web", "matcher": {"v": 1, "origin": "http://Feeds.Corp.Test:8080"},
        "agentId": "nightly",
    })
    assert r2.json()["data"]["matcher"]["origin"] == "http://feeds.corp.test:8080"


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
        assert t["class"] in ("read", "domain_write", "artifact")
    names = [t["name"] for t in d["tools"]]
    assert len(names) == len(set(names))
    # defaults ⊆ tools（Settings 勾选面自洽）。
    assert set(d["defaults"]) <= set(names)
    assert list(d["defaults"]) == list(agent_runs.DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS)


def test_tool_options_consistent_with_tool_catalog():
    """HEADLESS_TOOL_OPTIONS 与 tests/agent_eval/tool_catalog.json 的 tool_class 轴单源一致：
    集合 = catalog 内全部 read+domain_write+artifact 工具，减去 legacy_retired（产品里已不存在）、
    manual_only 与 headless_excluded（均 venue 门控，headless 结构性拿不到）三类标记行；class
    逐名相同（R4 catalog 闸的 Python 侧延伸，新读/写工具漏 HEADLESS_TOOL_OPTIONS 必红）。"""
    from src.api.routers.agent_runs import (
        DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS,
        HEADLESS_TOOL_OPTIONS,
    )

    catalog_path = Path(__file__).resolve().parents[1] / "agent_eval" / "tool_catalog.json"
    catalog = json.loads(catalog_path.read_text())["tools"]
    # 三类标记行不进 headless 工具面（判据在 catalog 的行标记上，不在这里手抄工具名）：
    #   legacy_retired（plan_update / skill_list_installed / email_search）—— 在 catalog 里只为 frozen
    #     baseline v0.13.0.jsonl 的历史 tool_use 保留、产品里已不存在；
    #   manual_only（suggest_followups）—— chat UI 优化 W6 的交互 UI 供给（追问 chips + 本回合的
    #     hasToolCall 停机条件），buildGatewayTools 只在 contextMode==='manual_chat' 注册（tools/index.ts
    #     的 venue 闸，policy.test.ts MANUAL_ONLY_READ_TOOLS 锁死它在 headless/im 缺席）；
    #   headless_excluded（venue 门控：P3 拍板 matter 工具 headless 结构性不注册——连读面都不给，
    #     不进勾选面即结构性拿不到；与 manual_only 不同，matter 工具在 im_chat 也注册，故不能复用
    #     那个标记；P4 matter_followup 相位再议）。
    # 三者都必须留在 catalog 里（legacy_retired 供 frozen trace 解析，后两类是活的 gateway 工具、
    # validate_catalog 的反向闸要求它们在源里），故排除只能读行标记 —— tool-options 端点不得提供
    # 这些名字：要么是已不存在的工具，要么是 headless run 永远挂不上的工具（勾了也没有消费点）。
    expected = {
        name: meta["tool_class"]
        for name, meta in catalog.items()
            if meta["tool_class"] in ("read", "domain_write", "artifact")
            and not meta.get("legacy_retired")
            and not meta.get("manual_only")
            and not meta.get("headless_excluded")
            and name != "plan_update"  # core-unmanaged: every headless run gets the local no-op plan tool
            # task 09-02：会话三工具对 custom agent 恒注册（wrapCfgForAgentRun 按名豁免交集），读取
            # 半径走 grant_sessions —— 与 exec/web 一样不是勾选项，结构性不进 HEADLESS_TOOL_OPTIONS。
            and name not in ("chat_session_list", "chat_session_search", "chat_session_get")
        }
    assert dict(HEADLESS_TOOL_OPTIONS) == expected
    # 默认安全集成员必须都在 headless 地板内。
    assert set(DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS) <= set(expected)
