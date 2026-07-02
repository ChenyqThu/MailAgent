"""skill 执行完整性 + 首跑闸（S2 W4，ADR-002 §5 D3）—— run 端点拒篡改 / 落首跑记录 +
``/policy/evaluate`` 前置 gate 顺序不变式（codex P2-7：宽白名单规则放行不了未首跑的 skill 脚本）。

skill 经真实 fetch→confirm 供应链装入（files_json 是 confirm 落库事实）；fixtures 全合成
（tmp skills dir + fresh agent_config.db，零真实文件风险）。auth bypass 默认 ON（conftest）。
"""

from __future__ import annotations

import json
import os
import zipfile

import pytest

from src.api import exec_floor


@pytest.fixture(autouse=True)
def _reset_floor():
    exec_floor.reset_exec_floor_cache()
    yield
    exec_floor.reset_exec_floor_cache()


_MANIFEST = {
    "manifest_version": 2,
    "type": "script",
    "name": "dms-approve",
    "version": "1.0",
    "title": "DMS Approver",
    "description": "auto-approve DMS approval mail",
    "entry_hint": "python3 main.py",
    "secrets": [],
}


def _make_zip(path, entries):
    with zipfile.ZipFile(path, "w") as z:
        for name, data in entries.items():
            z.writestr(name, data)


def _install_pack(client, tmp_path, *, version="1.0"):
    """真实两段式装入（fetch→confirm）→ 返回 <skills>/dms-approve 目录路径。"""
    z = tmp_path / f"dms-{version}.zip"
    _make_zip(
        z,
        {
            "manifest.json": json.dumps(dict(_MANIFEST, version=version)),
            "SKILL.md": "# DMS\nRun main.py via run_command.",
            "main.py": f"print('approve v{version}')",
        },
    )
    preview = client.post("/api/agent/skills/fetch", json={"localPath": str(z)}).json()["data"]
    r = client.post(
        "/api/agent/skills/confirm",
        json={
            "quarantineId": preview["quarantineId"],
            "expectedPackageHash": preview["packageHash"],
            "expectedFiles": preview["files"],
        },
    )
    assert r.status_code == 201, r.json()
    from src.skills.pack_fetch import skill_dir

    return skill_dir("dms-approve")


def _data(resp):
    j = resp.json()
    assert j["status"] == "success", j
    return j["data"]


def _err(resp):
    j = resp.json()
    assert j["status"] == "error", j
    return resp.status_code, j["error"]["code"]


def _echo_rule_matcher():
    """能匹配 ``/bin/echo <任意单参>`` 的宽规则 matcher（顺序不变式测试用）。"""
    return {
        "v": 1,
        "argv0_realpath": os.path.realpath("/bin/echo"),
        "argv_template": [{"any": True}],
    }


def _evaluate(client, argv, cwd=None):
    r = client.post(
        "/api/agent/policy/evaluate",
        json={"capability": "exec", "action": {"argv": argv, "cwd": cwd}, "contextMode": "manual_chat"},
    )
    return _data(r)


# ── evaluate 前置 gate：顺序不变式（判定在 PolicyRule auto_allow 之前）──────────────────────


def test_wide_rule_does_not_allow_unapproved_first_run(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    """🔴 codex P2-7 核心断言：种一条**能匹配该 argv** 的宽规则，skill 未首跑 → evaluate 仍 ask；
    run 一次（owner 批准面）落首跑记录 → 同 action 变 auto_allow；篡改文件 → 回到 ask 且 run 409。"""
    skdir = _install_pack(client, tmp_path)
    main_py = os.path.join(skdir, "main.py")
    argv = ["/bin/echo", main_py]

    r = client.post(
        "/api/agent/policy/rules",
        json={"capability": "exec", "matcher": _echo_rule_matcher(), "contextMode": "manual_chat"},
    )
    assert r.status_code == 201
    rule_id = r.json()["data"]["id"]

    # ① 未首跑 → 宽规则不放行（gate 在查 rules 之前）。
    assert _evaluate(client, argv) == {"decision": "ask", "rule_id": None}

    # ② run 一次 → 执行成功 + 落首跑记录（entrypoint realpath）。
    d = _data(client.post("/api/exec/run", json={"argv": argv}))
    assert d["exit_code"] == 0
    assert d["first_run_recorded"] == [os.path.realpath(main_py)]
    row = fresh_agent_cfg.get_skill("dms-approve")
    rec = json.loads(row.first_run_approved)[os.path.realpath(main_py)]
    assert rec["version"] == "1.0" and rec["entrypoint_hash"] and rec["approved_at"]

    # ③ 首跑记录有效 → 同 action 现在命中宽规则免卡。
    assert _evaluate(client, argv) == {"decision": "auto_allow", "rule_id": rule_id}

    # ④ 篡改 main.py → evaluate 回到 ask（完整性不符），run 端点 409 拒执行 + last_error。
    with open(main_py, "a") as f:
        f.write("# injected")
    assert _evaluate(client, argv) == {"decision": "ask", "rule_id": None}
    code, err = _err(client.post("/api/exec/run", json={"argv": argv}))
    assert code == 409 and err == "E_SKILL_TAMPERED"
    row = fresh_agent_cfg.get_skill("dms-approve")
    assert row.last_error == "tampered:main.py"


def test_bare_token_cd_pattern_never_whitelisted(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    """🔴 探测盲区收口（team-lead 对抗推演）：``cd <skills>/x && python3 main.py`` 形状里 main.py
    是裸 token 不被 probe（touched_files 空、names 非空）。种一条**恰好匹配**该 argv 的窄规则
    （owner 从同形状「总是允许」派生的合法规则）——先证明规则本会命中，再证明 evaluate 仍 ask
    （是 gate 在裸 token 盲区上拦的，而非规则不匹配）。堵免卡 + 零完整性 + secret 注入的最坏叠加。"""
    from src.agent_config.policy import ExecMatcher, _match_exec, _resolve_argv0

    skdir = _install_pack(client, tmp_path)
    argv = ["python3", "main.py"]  # 全裸 token（无分隔符）—— probe 识别不出触达文件
    action = {"argv": argv, "cwd": skdir}

    # owner 从同形状动作派生的窄规则：argv0 解析到 python3 realpath + argv_template 全 pin + cwd 落域。
    argv0_rp = _resolve_argv0("python3", skdir)
    matcher = {
        "v": 1,
        "argv0_realpath": argv0_rp,
        "argv_template": [{"pin": "main.py"}],
        "cwd_scope": skdir,
    }
    # 先断言：不经 gate，这条规则对该 action **确实命中**（证明拦截来自 gate，而非规则不匹配）。
    assert _match_exec(ExecMatcher.model_validate(matcher), action) is True

    r = client.post(
        "/api/agent/policy/rules",
        json={"capability": "exec", "matcher": matcher, "contextMode": "manual_chat"},
    )
    assert r.status_code == 201

    # evaluate 必须 ask —— 盲区形状不可校验 ⇒ 永不可白名单免卡（顺序不变式对该形状也成立）。
    assert _evaluate(client, argv, cwd=skdir) == {"decision": "ask", "rule_id": None}


def test_bare_token_cd_pattern_ask_persists_after_run(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    """盲区形状即便 run 过一次也永不免卡：run 端点对裸 token 同样识别不出触达文件（零首跑记录
    可落）→ 下次 evaluate 仍 ask。对照非盲区路径（argv 带 main.py 全路径 → 首跑后 auto_allow）。"""
    from src.agent_config.policy import _resolve_argv0

    skdir = _install_pack(client, tmp_path)
    argv = ["python3", "main.py"]
    argv0_rp = _resolve_argv0("python3", skdir)
    client.post(
        "/api/agent/policy/rules",
        json={
            "capability": "exec",
            "matcher": {
                "v": 1,
                "argv0_realpath": argv0_rp,
                "argv_template": [{"pin": "main.py"}],
                "cwd_scope": skdir,
            },
            "contextMode": "manual_chat",
        },
    )
    # run 一次（裸 token → 无触达文件 → 无首跑记录可落）。
    d = _data(client.post("/api/exec/run", json={"argv": argv, "cwd": skdir}))
    assert d["exit_code"] == 0
    assert d["first_run_recorded"] == []  # 盲区形状不落首跑
    # 仍 ask —— 盲区形状恒不免卡。
    assert _evaluate(client, argv, cwd=skdir) == {"decision": "ask", "rule_id": None}


def test_version_change_retriggers_first_run(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    """首跑记录绑 version + entrypoint hash（非裸时间戳）：升级重装后旧记录失效，evaluate 回 ask。"""
    skdir = _install_pack(client, tmp_path, version="1.0")
    main_py = os.path.join(skdir, "main.py")
    argv = ["/bin/echo", main_py]
    client.post(
        "/api/agent/policy/rules",
        json={"capability": "exec", "matcher": _echo_rule_matcher(), "contextMode": "manual_chat"},
    )
    _data(client.post("/api/exec/run", json={"argv": argv}))  # 落 v1.0 首跑
    assert _evaluate(client, argv)["decision"] == "auto_allow"

    _install_pack(client, tmp_path, version="2.0")  # 升级重装（version + main.py hash 都变）
    assert _evaluate(client, argv) == {"decision": "ask", "rule_id": None}


def test_untracked_file_in_skill_dir_rejected(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    """触达文件不在 files_json（安装后被塞进 skill 目录）→ 视为篡改拒执行（fail-closed：skills
    目录下只应有供应链管控内容 —— 堵「首跑批过的脚本写个新脚本绕 hash 链」）。"""
    skdir = _install_pack(client, tmp_path)
    extra = os.path.join(skdir, "extra.py")
    with open(extra, "w") as f:
        f.write("print('sneaky')")
    code, err = _err(client.post("/api/exec/run", json={"argv": ["/bin/echo", extra]}))
    assert code == 409 and err == "E_SKILL_TAMPERED"
    assert _evaluate(client, ["/bin/echo", extra]) == {"decision": "ask", "rule_id": None}


def test_unmanaged_skill_dir_rejected(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    """skill 目录存在但无 agent_skills 行（手动放置，无 files_json 可校验）→ 拒执行。"""
    d = fresh_skills_dir / "rogue"
    d.mkdir(parents=True)
    script = d / "run.py"
    script.write_text("print('rogue')")
    code, err = _err(client.post("/api/exec/run", json={"argv": ["/bin/echo", str(script)]}))
    assert code == 409 and err == "E_SKILL_TAMPERED"


def test_non_skill_run_unaffected(client, fresh_agent_cfg, fresh_skills_dir):
    """普通命令（不触达 skill 目录）→ 完整性/首跑闸零介入（W1a 行为不变）。"""
    d = _data(client.post("/api/exec/run", json={"argv": ["/bin/echo", "hello"]}))
    assert d["exit_code"] == 0
    assert d["first_run_recorded"] == []


def test_cwd_only_hit_no_integrity_object(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    """仅 cwd 命中 skill 目录（零触达文件）→ 无完整性/首跑对象，正常执行（与 secret overlay 的
    cwd 命中语义共存 —— 已知探测盲区照实保留，不静默扩大）。"""
    skdir = _install_pack(client, tmp_path)
    d = _data(client.post("/api/exec/run", json={"argv": ["/bin/echo", "hi"], "cwd": skdir}))
    assert d["exit_code"] == 0
    assert d["first_run_recorded"] == []


def test_quarantine_content_never_gates_as_skill(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    """.quarantine 下内容不按 skill 首跑/完整性处理（probe 跳过）—— 执行它由 exec_floor deny
    地板硬拒（W1a 已盖），这里只断言 probe 不把它当 skill 命中。"""
    from src.skills.exec_gate import probe_skill_exec

    q = fresh_skills_dir / ".quarantine" / "x-abc123456789" / "content"
    q.mkdir(parents=True)
    f = q / "main.py"
    f.write_text("x")
    probe = probe_skill_exec(["/bin/echo", str(f)], None)
    assert probe.names == frozenset()
    assert probe.touched_files == {}
