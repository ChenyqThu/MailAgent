"""S5 per-agent 策略层单测（ADR-004 WA）—— 双键隔离矩阵 + domain_write matcher + 受约束参数位 +
headless pinned-entrypoint 形状闸 + evaluate 侧 skip 双防线。

纯单测（tmp_path 直建库 + MAILAGENT_SKILLS_DIR 落 tmp），零真实 PII / 零外部依赖。
"""

from __future__ import annotations

import hashlib
import inspect
import json
import os
import sqlite3

import pytest

from src.agent_config import policy as P
from src.agent_config.store import AgentConfigStore

ECHO = os.path.realpath("/bin/echo")


def _store(tmp_path) -> AgentConfigStore:
    return AgentConfigStore(str(tmp_path / "agent_config.db"))


def _rule(store, matcher, *, capability="exec", context_mode="manual_chat", agent_id=None):
    return store.create_policy_rule(
        capability, json.dumps(matcher), context_mode=context_mode, agent_id=agent_id
    )


# ── manual 候选查询逐字节锚（红线：S2 查询串零改动 + 绝无 IS NULL OR）────────────────────


def test_manual_candidate_sql_byte_identical_to_s2():
    src = inspect.getsource(AgentConfigStore.candidate_policy_rules)
    assert '"SELECT * FROM policy_rules WHERE enabled = 1 AND capability = ? "' in src
    assert '"AND context_mode = ? AND agent_id IS NULL ORDER BY id ASC"' in src
    assert "IS NULL OR agent_id" not in src  # 红线①：双向物理隔离，绝无兼收查询形状


# ── 双键隔离矩阵（ADR-004 §3.3 / codex P1-5）────────────────────────────────────────


def test_null_rule_never_enters_headless_candidates(tmp_path):
    """全局（NULL）规则永不进 headless 候选集 —— 即便 capability/context_mode 全同。"""
    st = _store(tmp_path)
    _rule(st, {"v": 1, "tool": "email_flag"}, capability="domain_write",
          context_mode="untrusted_trigger", agent_id=None)
    action = {"tool": "email_flag"}
    assert P.evaluate(st, "domain_write", action, "untrusted_trigger", agent_id="dms") == {
        "decision": "ask", "rule_id": None,
    }


def test_peragent_rule_never_enters_manual_candidates(tmp_path):
    """headless 规则永不进 manual（agent_id=None）候选集。"""
    st = _store(tmp_path)
    _rule(st, {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"pin": "hi"}]},
          context_mode="manual_chat", agent_id="dms")
    action = {"argv": ["/bin/echo", "hi"], "cwd": None}
    assert P.evaluate(st, "exec", action, "manual_chat") == {"decision": "ask", "rule_id": None}


def test_peragent_rule_strict_equality_across_agents(tmp_path):
    """agent_id 严格等值：agent A 的规则匹配不到 agent B 的 run。"""
    st = _store(tmp_path)
    _rule(st, {"v": 1, "tool": "email_flag"}, capability="domain_write",
          context_mode="untrusted_trigger", agent_id="agent-a")
    action = {"tool": "email_flag"}
    ok = P.evaluate(st, "domain_write", action, "untrusted_trigger", agent_id="agent-a")
    assert ok["decision"] == "auto_allow"
    assert P.evaluate(st, "domain_write", action, "untrusted_trigger", agent_id="agent-b") == {
        "decision": "ask", "rule_id": None,
    }


def test_context_mode_binding_still_holds_with_agent_id(tmp_path):
    """双键下 context_mode 严格等值不变：untrusted_trigger 规则不进 cron_headless 查询。"""
    st = _store(tmp_path)
    _rule(st, {"v": 1, "tool": "email_flag"}, capability="domain_write",
          context_mode="untrusted_trigger", agent_id="dms")
    action = {"tool": "email_flag"}
    assert P.evaluate(st, "domain_write", action, "cron_headless", agent_id="dms")["decision"] == "ask"


def test_empty_string_agent_id_is_pure_dirt(tmp_path):
    """空串隔离（codex P1-5）：create 拒；candidate('') 空；手工塞 agent_id='' 的怪行既非 NULL
    也匹配不到任何 agent_id 查询。"""
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        st.create_policy_rule("domain_write", json.dumps({"v": 1, "tool": "email_flag"}),
                              context_mode="untrusted_trigger", agent_id="")
    with pytest.raises(ValueError):
        st.create_policy_rule("domain_write", json.dumps({"v": 1, "tool": "email_flag"}),
                              context_mode="untrusted_trigger", agent_id="   ")
    # 手工入库怪行（绕过 store 写口）。
    conn = sqlite3.connect(str(tmp_path / "agent_config.db"))
    conn.execute(
        "INSERT INTO policy_rules (capability, matcher_json, context_mode, agent_id, enabled, "
        "created_at, use_count) VALUES (?,?,?,?,1,?,0)",
        ("domain_write", json.dumps({"v": 1, "tool": "email_flag"}), "untrusted_trigger", "", "now"),
    )
    conn.commit()
    conn.close()
    assert st.candidate_policy_rules("domain_write", "untrusted_trigger") == []  # 非 NULL
    assert st.candidate_policy_rules("domain_write", "untrusted_trigger", agent_id="") == []  # 拒脏实参
    assert st.candidate_policy_rules("domain_write", "untrusted_trigger", agent_id="dms") == []
    action = {"tool": "email_flag"}
    assert P.evaluate(st, "domain_write", action, "untrusted_trigger", agent_id="")["decision"] == "ask"


def test_delete_policy_rules_for_agent_cascade(tmp_path):
    """级联删除只清该 agent 的行；NULL 全局规则与他 agent 行不受影响；空串入参 → 0。"""
    st = _store(tmp_path)
    _rule(st, {"v": 1, "argv0_realpath": ECHO, "argv_template": []}, agent_id=None)
    _rule(st, {"v": 1, "tool": "email_flag"}, capability="domain_write",
          context_mode="untrusted_trigger", agent_id="dms")
    _rule(st, {"v": 1, "tool": "email_pin"}, capability="domain_write",
          context_mode="untrusted_trigger", agent_id="dms")
    _rule(st, {"v": 1, "tool": "email_flag"}, capability="domain_write",
          context_mode="untrusted_trigger", agent_id="other")
    assert st.delete_policy_rules_for_agent("") == 0
    assert st.delete_policy_rules_for_agent("dms") == 2
    remaining = st.list_policy_rules()
    assert {r.agent_id for r in remaining} == {None, "other"}
    assert st.list_policy_rules(agent_id="other")[0].agent_id == "other"


# ── domain_write matcher（ADR-004 §3.2）──────────────────────────────────────────────


def test_domain_write_matcher_parse_and_match():
    m = P.parse_matcher("domain_write", {"v": 1, "tool": "email_flag"})
    assert P._match("domain_write", m, {"tool": "email_flag", "internal_id": 42}) is True
    assert P._match("domain_write", m, {"tool": "email_archive"}) is False
    assert P._match("domain_write", m, {}) is False


@pytest.mark.parametrize(
    "bad",
    [
        {"v": 2, "tool": "email_flag"},          # 未知版本
        {"v": 1},                                  # 缺 tool
        {"v": 1, "tool": ""},                      # 空 tool
        {"v": 1, "tool": "email_flag", "x": 1},   # extra forbid
    ],
)
def test_domain_write_matcher_rejects(bad):
    with pytest.raises(Exception):
        P.parse_matcher("domain_write", bad)


def test_domain_write_use_count_bumped(tmp_path):
    st = _store(tmp_path)
    rule = _rule(st, {"v": 1, "tool": "email_draft_reply"}, capability="domain_write",
                 context_mode="untrusted_trigger", agent_id="dms")
    res = P.evaluate(st, "domain_write", {"tool": "email_draft_reply"},
                     "untrusted_trigger", agent_id="dms")
    assert res == {"decision": "auto_allow", "rule_id": rule.id}
    assert st.get_policy_rule(rule.id).use_count == 1


# ── 受约束参数位三形（ADR-004 §4.3（二））────────────────────────────────────────────


def _exec_m(template, argv0=ECHO):
    return P.ExecMatcher.model_validate(
        {"v": 1, "argv0_realpath": argv0, "argv_template": template}
    )


def test_enum_arg_matches_only_listed_values():
    m = _exec_m([{"arg": {"kind": "enum", "values": ["approve", "reject", "-n"]}}])
    assert P._match_exec(m, {"argv": ["/bin/echo", "approve"], "cwd": None}) is True
    assert P._match_exec(m, {"argv": ["/bin/echo", "delete"], "cwd": None}) is False
    # enum 显式列出的前导 - 值豁免 dash 拒绝。
    assert P._match_exec(m, {"argv": ["/bin/echo", "-n"], "cwd": None}) is True
    assert P._match_exec(m, {"argv": ["/bin/echo", "-x"], "cwd": None}) is False


def test_pattern_arg_fullmatch_maxlen_and_dash():
    m = _exec_m([{"arg": {"kind": "pattern", "regex": "[A-Z0-9-]{1,32}", "max_len": 16}}])
    assert P._match_exec(m, {"argv": ["/bin/echo", "REQ-42"], "cwd": None}) is True
    # fullmatch 锚定：部分匹配不过。
    assert P._match_exec(m, {"argv": ["/bin/echo", "REQ-42;rm"], "cwd": None}) is False
    # 超 max_len 拒。
    assert P._match_exec(m, {"argv": ["/bin/echo", "A" * 17], "cwd": None}) is False
    # 前导 - 拒（regex 本可匹配 "-A"，隐式约束先拒）。
    assert P._match_exec(m, {"argv": ["/bin/echo", "-A"], "cwd": None}) is False


def test_path_within_arg_prefix_and_relative(tmp_path):
    scope = tmp_path / "outbox"
    scope.mkdir()
    (scope / "a.txt").write_text("x")
    m = _exec_m([{"arg": {"kind": "path_within", "prefix": str(scope)}}])
    assert P._match_exec(m, {"argv": ["/bin/echo", str(scope / "a.txt")], "cwd": None}) is True
    assert P._match_exec(m, {"argv": ["/bin/echo", str(tmp_path / "b.txt")], "cwd": None}) is False
    # 相对实参：有 cwd → 按 cwd join；无 cwd → 不匹配（fail-closed）。
    assert P._match_exec(m, {"argv": ["/bin/echo", "a.txt"], "cwd": str(scope)}) is True
    assert P._match_exec(m, {"argv": ["/bin/echo", "a.txt"], "cwd": None}) is False


@pytest.mark.parametrize(
    "bad",
    [
        {"kind": "enum", "values": []},                         # 空枚举
        {"kind": "enum", "values": ["a"], "regex": "x"},        # 跨形字段（extra forbid）
        {"kind": "pattern", "regex": "("},                       # 不可编译
        {"kind": "pattern", "regex": "a" * 300},                 # regex 超长
        {"kind": "pattern", "regex": "a", "max_len": 0},         # max_len < 1
        {"kind": "path_within", "prefix": "rel/dir"},            # 非绝对
        {"kind": "nonsense"},                                     # 未知判别式
    ],
)
def test_constrained_arg_rejects(bad):
    with pytest.raises(Exception):
        _exec_m([{"arg": bad}])


def test_argv_item_exactly_one_of_pin_any_arg():
    with pytest.raises(Exception):
        _exec_m([{"pin": "a", "arg": {"kind": "enum", "values": ["a"]}}])
    with pytest.raises(Exception):
        _exec_m([{}])


# ── headless pinned-entrypoint 形状闸（ADR-004 §4.3（一））────────────────────────────


@pytest.fixture()
def skill_env(tmp_path, monkeypatch):
    """tmp skills root + 一个带 files_json 清单的 installed skill 行 + 落盘 entrypoint。"""
    skills = tmp_path / "skills"
    monkeypatch.setenv("MAILAGENT_SKILLS_DIR", str(skills))
    st = _store(tmp_path)
    skdir = skills / "dms-approve"
    skdir.mkdir(parents=True)
    main_py = skdir / "main.py"
    main_py.write_text("print('approve')\n")
    digest = hashlib.sha256(main_py.read_bytes()).hexdigest()
    st.install_skill(
        "dms-approve",
        source_type="local_folder",
        manifest={"name": "dms-approve", "type": "script"},
        version="1.0",
        files_json=json.dumps({"main.py": digest}),
    )
    return st, str(main_py), digest


def _pinned_matcher(entry, tail=None, cwd_scope=None):
    m = {
        "v": 1,
        "argv0_realpath": os.path.realpath("/usr/bin/python3")
        if os.path.exists("/usr/bin/python3") else ECHO,
        "argv_template": [{"pin": entry}] + (tail or []),
    }
    if cwd_scope is not None:
        m["cwd_scope"] = cwd_scope
    return m


def test_headless_shape_valid_pinned_entrypoint(skill_env):
    st, main_py, _ = skill_env
    m = P.ExecMatcher.model_validate(
        _pinned_matcher(main_py, tail=[{"arg": {"kind": "enum", "values": ["approve"]}}],
                        cwd_scope=os.path.dirname(main_py))
    )
    assert P.headless_exec_rule_problem(st, m) is None


def test_headless_shape_rejects_raw_any(skill_env):
    st, main_py, _ = skill_env
    m = P.ExecMatcher.model_validate(_pinned_matcher(main_py, tail=[{"any": True}]))
    assert "raw {any}" in P.headless_exec_rule_problem(st, m)


def test_headless_shape_rejects_non_skill_entrypoint(skill_env, tmp_path):
    st, _, _ = skill_env
    outside = tmp_path / "rogue.py"
    outside.write_text("x")
    m = P.ExecMatcher.model_validate(_pinned_matcher(str(outside)))
    assert "skills directory" in P.headless_exec_rule_problem(st, m)


def test_headless_shape_rejects_unmanifested_file(skill_env):
    st, main_py, _ = skill_env
    rogue = os.path.join(os.path.dirname(main_py), "rogue.py")
    with open(rogue, "w") as f:
        f.write("x")
    m = P.ExecMatcher.model_validate(_pinned_matcher(rogue))
    assert "file manifest" in P.headless_exec_rule_problem(st, m)


def test_headless_shape_rejects_missing_or_wildcard_entrypoint(skill_env):
    st, main_py, _ = skill_env
    # 空模板（无 argv[1]）。
    m0 = P.ExecMatcher.model_validate({"v": 1, "argv0_realpath": ECHO, "argv_template": []})
    assert "argv[1]" in P.headless_exec_rule_problem(st, m0)
    # argv[1] 是通配而非 pin。
    m1 = P.ExecMatcher.model_validate(
        {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"any": True}]}
    )
    assert P.headless_exec_rule_problem(st, m1) is not None
    # argv[1] pin 相对路径。
    m2 = P.ExecMatcher.model_validate(
        {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"pin": "main.py"}]}
    )
    assert "absolute" in P.headless_exec_rule_problem(st, m2)


def test_headless_shape_rejects_cwd_scope_outside_skill(skill_env, tmp_path):
    st, main_py, _ = skill_env
    m = P.ExecMatcher.model_validate(_pinned_matcher(main_py, cwd_scope=str(tmp_path)))
    assert "cwd_scope" in P.headless_exec_rule_problem(st, m)


# ── evaluate 侧形状复核双防线（手工入库怪行经候选集也放行不了）──────────────────────────


def test_evaluate_skips_nonconforming_headless_exec_rule(skill_env):
    """种一条**能匹配**该 argv 的 manual 词汇宽规则（echo + {any}）到 headless 候选（手工绕过
    建规 API 形状闸）→ evaluate 复核 skip → ask。"""
    st, main_py, _ = skill_env
    st.create_policy_rule(
        "exec",
        json.dumps({"v": 1, "argv0_realpath": ECHO, "argv_template": [{"any": True}]}),
        context_mode="untrusted_trigger",
        agent_id="dms",
    )
    action = {"argv": ["/bin/echo", main_py], "cwd": None}
    # 规则本会命中（manual 语义下）——证明拦截来自形状复核而非不匹配。
    wide = P.ExecMatcher.model_validate(
        {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"any": True}]}
    )
    assert P._match_exec(wide, action) is True
    assert P.evaluate(st, "exec", action, "untrusted_trigger", agent_id="dms") == {
        "decision": "ask", "rule_id": None,
    }


def test_evaluate_allows_conforming_pinned_rule_after_first_run(skill_env):
    """合形 pinned-entrypoint 规则 + 首跑记录在位 → headless auto_allow；同规则对未首跑
    entrypoint（skill gate 前置）仍 ask —— 三重闸顺序不变式在 per-agent 下成立。"""
    st, main_py, digest = skill_env
    argv0 = os.path.realpath("/usr/bin/python3") if os.path.exists("/usr/bin/python3") else ECHO
    rule = st.create_policy_rule(
        "exec",
        json.dumps({"v": 1, "argv0_realpath": argv0, "argv_template": [{"pin": main_py}]}),
        context_mode="untrusted_trigger",
        agent_id="dms",
    )
    action = {"argv": [argv0, main_py], "cwd": None}
    # 未首跑 → skill gate 在查规则之前 ask。
    assert P.evaluate(st, "exec", action, "untrusted_trigger", agent_id="dms")["decision"] == "ask"
    st.merge_first_run_approved(
        "dms-approve",
        {os.path.realpath(main_py): {"version": "1.0", "entrypoint_hash": digest}},
    )
    assert P.evaluate(st, "exec", action, "untrusted_trigger", agent_id="dms") == {
        "decision": "auto_allow", "rule_id": rule.id,
    }
    # 同 action、无 agent_id（manual）→ per-agent 规则不进候选 → ask。
    assert P.evaluate(st, "exec", action, "untrusted_trigger")["decision"] == "ask"
