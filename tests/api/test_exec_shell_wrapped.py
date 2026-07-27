"""issue #62 —— 壳包装 skill 引用的 run 端点 deny 地板 + 绝对路径 argv 三闸恢复 + last_error 清除。

病根：``["/bin/sh","-lc","cd <skills>/x && python3 f.py"]`` 是助手读完 SKILL.md「在安装目录下执行」
后**最自然**的写法。整条 shell 命令是**单个** argv token（realpath 不落 skills），``cd`` 又发生在
shell 内部（``run_cwd`` 仍是默认 data root）⇒ ``probe_skill_exec`` 的 ``names``/``touched_files``
双空 ⇒ 完整性校验 / 首跑记录 / **secret 注入**三个消费者一起 fail-open。安全面之外更痛的是功能面：
skill 作者声明了密钥、owner 在设置里填了值，脚本 ``os.environ`` 却是空的（零攻击者即触发）。

skill 经真实 fetch→confirm 供应链装入；fixtures 全合成（tmp DATA_ROOT + skills dir + fresh
agent_config.db；master key 强制 keyfile 通道，**绝不**碰真钥匙串/生产库）。**不执行任何 skill 脚本
本体** —— 沿用 test_exec_skill_gate 的纪律，用 ``/bin/echo <path>`` 让 probe 落地。
auth bypass 默认 ON（conftest）。
"""

from __future__ import annotations

import json
import os
import zipfile

import pytest

from src.agent_config import secrets
from src.api import exec_floor

SENTINEL = "sentinel-DMS-secret-4242"
SKILL = "dms-approve"


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """DATA_ROOT / skills 落 tmp + master key 走 keyfile（不弹钥匙串）+ 缓存重置。"""
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("MAILAGENT_SKILLS_DIR", str(tmp_path / "skills"))

    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)
    secrets.reset_master_key_cache()
    exec_floor.reset_exec_floor_cache()
    yield
    secrets.reset_master_key_cache()
    exec_floor.reset_exec_floor_cache()


_MAIN_PY = "print('approve v1.0')"


def _install_pack(client, tmp_path, *, extra=None):
    """真实两段式装入（fetch→confirm）→ 返回 <skills>/dms-approve。manifest 声明 DMS_TOKEN，
    这样「绝对路径 argv 恢复 secret 注入」有可观测对象。``extra`` = 额外的 {relpath: content}
    （多文件 skill 的 last_error 精确清除测试用）。"""
    z = tmp_path / "dms.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("manifest.json", json.dumps({
            "manifest_version": 2, "type": "script", "name": SKILL, "version": "1.0",
            "title": "DMS Approver", "description": "d", "entry_hint": "python3 main.py",
            "secrets": [{"name": "DMS_TOKEN"}],
        }))
        zf.writestr("SKILL.md", "# DMS\nRun main.py from the install directory.")
        zf.writestr("main.py", _MAIN_PY)
        for rel, content in (extra or {}).items():
            zf.writestr(rel, content)
    preview = client.post("/api/agent/skills/fetch", json={"localPath": str(z)}).json()["data"]
    r = client.post("/api/agent/skills/confirm", json={
        "quarantineId": preview["quarantineId"],
        "expectedPackageHash": preview["packageHash"],
        "expectedFiles": preview["files"],
    })
    assert r.status_code == 201, r.json()
    from src.skills.pack_fetch import skill_dir

    return skill_dir(SKILL)


def _data(resp):
    j = resp.json()
    assert j["status"] == "success", j
    return j["data"]


def _err(resp):
    j = resp.json()
    assert j["status"] == "error", j
    return resp.status_code, j["error"]["code"], j["error"]["message"]


def _shell_argv(skdir):
    """issue 原文那条命令的形状（模型自发选择的写法，**无** /bin/sh -lc 外壳包装 —— argv 数组
    本身就是模型传进来的，端点恒 create_subprocess_exec 从不加壳）。"""
    return ["/bin/sh", "-lc", f"cd {skdir} && python3 main.py"]


# ── 根因固化 ────────────────────────────────────────────────────────────────────────


def test_shell_wrapped_probe_is_blind_and_injects_no_secret(client, fresh_agent_cfg, tmp_path):
    """病根：该形状下 probe 双空 → ``_skill_secret_overlay`` 零注入。这就是「密钥填了却读不到」的
    机制本身（与安全无关的纯功能 bug）—— 纯判定层断言，不发请求。

    同时钉死「**旧**地板为什么漏判」：``_skill_unresolved_problem`` 按 realpath 判定，对整条 shell
    命令这个单 token 恒返回 None（``os.sep in tok`` 为真 → 走 pathish 分支 → realpath 不落 skills
    → continue）。若哪天有人把新 belt 删了以为「realpath 那条已经盖住了」，这条会红。"""
    from src.api.exec_floor import _data_root
    from src.api.routers.exec import _skill_secret_overlay, _skill_unresolved_problem
    from src.skills.exec_gate import probe_skill_exec

    skdir = _install_pack(client, tmp_path)
    secrets.set_secret(SKILL, "DMS_TOKEN", SENTINEL, store=fresh_agent_cfg)
    argv = _shell_argv(skdir)

    probe = probe_skill_exec(argv, _data_root())
    assert probe.names == frozenset() and probe.touched_files == {}
    assert _skill_secret_overlay(probe.names) == ({}, [])  # 声明了、存了，却一个都注不进去
    assert _skill_unresolved_problem(fresh_agent_cfg, argv, _data_root()) is None


# ── ① run 端点 deny 地板（409，独立于审批）────────────────────────────────────────────


def test_shell_wrapped_skill_ref_409_even_with_matching_rule(client, fresh_agent_cfg, tmp_path):
    """🔴 核心断言：shell 单 token 引用 skills_root → 409 硬拒。先种一条**恰匹配**该 argv 的全 pin
    规则（policy 面「批了」）——地板独立于审批/白名单，人批了也不跑。文案须给出可操作的修复路径
    （绝对路径 argv），模型读得到 409 message 就能自我纠正。"""
    from src.agent_config.policy import _resolve_argv0

    skdir = _install_pack(client, tmp_path)
    argv = _shell_argv(skdir)
    r = client.post("/api/agent/policy/rules", json={
        "capability": "exec",
        "matcher": {"v": 1, "argv0_realpath": _resolve_argv0(argv[0], None),
                    "argv_template": [{"pin": argv[1]}, {"pin": argv[2]}]},
        "contextMode": "manual_chat",
    })
    assert r.status_code == 201

    code, err, msg = _err(client.post("/api/exec/run", json={"argv": argv}))
    assert (code, err) == (409, "E_SKILL_UNRESOLVED")
    assert "absolute path" in msg  # 修复路径指引
    assert "sh -c" in msg and "&&" in msg  # 明说不要壳包装
    assert "secret" in msg  # 说清为什么（密钥注不进去，不只是「安全」）


def test_shell_wrapped_deny_covers_common_interpreters(client, fresh_agent_cfg, tmp_path):
    """危险名集是单源（``policy.is_dangerous_argv0``）—— bash / python3 -c / npx 同判。"""
    skdir = _install_pack(client, tmp_path)
    for argv in (
        ["/bin/bash", "-c", f"cd {skdir} && python3 main.py"],
        ["python3", "-c", f"import os; os.system('{skdir}/main.py')"],
        ["/bin/sh", "-c", f"{skdir}/main.py --flag"],
    ):
        code, err, _ = _err(client.post("/api/exec/run", json={"argv": argv}))
        assert (code, err) == (409, "E_SKILL_UNRESOLVED"), argv


def test_shell_wrapped_deny_matches_evaluate_side(client, fresh_agent_cfg, tmp_path):
    """执行侧与 evaluate 侧同判（同一个 ``exec_gate.shell_wrapped_skill_ref`` 单源）：evaluate 恒
    ask、run 端点 409 —— 两处不会再对同一形状给出相反的结论。"""
    skdir = _install_pack(client, tmp_path)
    argv = _shell_argv(skdir)
    verdict = _data(client.post("/api/agent/policy/evaluate", json={
        "capability": "exec", "action": {"argv": argv, "cwd": None},
        "contextMode": "manual_chat",
    }))
    assert verdict == {"decision": "ask", "rule_id": None}
    code, err, _ = _err(client.post("/api/exec/run", json={"argv": argv}))
    assert (code, err) == (409, "E_SKILL_UNRESOLVED")


# ── ② 绝对路径 argv：完整性 / 首跑 / secret 注入三闸恢复 ──────────────────────────────


def test_absolute_argv_restores_first_run_and_secret_injection(client, fresh_agent_cfg, tmp_path):
    """🔴 修复路径成立：绝对路径 argv → probe 落地 → 首跑记录落库 + 声明的密钥真注入。
    （用 ``/bin/echo <path>`` 让 probe 落地，**不执行** skill 脚本本体。）"""
    skdir = _install_pack(client, tmp_path)
    secrets.set_secret(SKILL, "DMS_TOKEN", SENTINEL, store=fresh_agent_cfg)
    main_py = os.path.join(skdir, "main.py")

    d = _data(client.post("/api/exec/run", json={"argv": ["/bin/echo", main_py]}))
    assert d["exit_code"] == 0
    assert d["injected_secret_names"] == ["DMS_TOKEN"]
    assert d["first_run_recorded"] == [os.path.realpath(main_py)]
    rec = json.loads(fresh_agent_cfg.get_skill(SKILL).first_run_approved)[os.path.realpath(main_py)]
    assert rec["version"] == "1.0" and rec["entrypoint_hash"] and rec["approved_at"]


def test_secret_value_really_reaches_child_env(client, fresh_agent_cfg, tmp_path):
    """注入不是只在响应里「报告」了 —— 子进程 env 真带上了值（脱敏标记出现 = 值曾在 stdout 里）。
    仍不碰 skill 脚本：跑的是 ``/usr/bin/env``。"""
    skdir = _install_pack(client, tmp_path)
    secrets.set_secret(SKILL, "DMS_TOKEN", SENTINEL, store=fresh_agent_cfg)

    d = _data(client.post("/api/exec/run", json={"argv": ["/usr/bin/env"], "cwd": skdir}))
    assert d["injected_secret_names"] == ["DMS_TOKEN"]
    assert "[REDACTED:DMS_TOKEN]" in d["stdout"]
    assert SENTINEL not in d["stdout"]


# ── ③ last_error：完整性闸通过后清除 ─────────────────────────────────────────────────


def test_successful_run_clears_stale_last_error(client, fresh_agent_cfg, tmp_path):
    """篡改 → 409 + last_error 落库；文件修回原样再跑 → last_error 必须被清（此前只有
    install/confirm 的 upsert 会清 → Settings 长期标红一个已消失的错误）。"""
    skdir = _install_pack(client, tmp_path)
    main_py = os.path.join(skdir, "main.py")
    argv = ["/bin/echo", main_py]

    with open(main_py, "a") as f:
        f.write("# injected\n")
    code, err, _ = _err(client.post("/api/exec/run", json={"argv": argv}))
    assert (code, err) == (409, "E_SKILL_TAMPERED")
    assert fresh_agent_cfg.get_skill(SKILL).last_error == "tampered:main.py"

    with open(main_py, "w") as f:  # 修回供应链清单里的内容 → 完整性闸重新通过
        f.write(_MAIN_PY)
    d = _data(client.post("/api/exec/run", json={"argv": argv}))
    assert d["exit_code"] == 0
    assert fresh_agent_cfg.get_skill(SKILL).last_error is None


def test_clear_is_scoped_to_the_file_actually_verified(client, fresh_agent_cfg, tmp_path):
    """🔴 清除必须**精确到文件**：skill 有两个文件，helper.py 被篡改（last_error 记的是它），
    此后跑 main.py 成功 —— 不能因为「闸整体通过」就把 helper.py 的错抹掉（Settings 会显示
    false-green，而 helper.py 仍是篡改状态）。安全信号不许往绿的方向错。"""
    skdir = _install_pack(client, tmp_path, extra={"helper.py": "print('helper')"})
    helper = os.path.join(skdir, "helper.py")

    with open(helper, "a") as f:
        f.write("# injected\n")
    code, err, _ = _err(client.post("/api/exec/run", json={"argv": ["/bin/echo", helper]}))
    assert (code, err) == (409, "E_SKILL_TAMPERED")
    assert fresh_agent_cfg.get_skill(SKILL).last_error == "tampered:helper.py"

    # 跑另一个**完好**的文件 → 成功，但 helper.py 的错不该被连带清掉。
    d = _data(client.post("/api/exec/run",
                          json={"argv": ["/bin/echo", os.path.join(skdir, "main.py")]}))
    assert d["exit_code"] == 0
    assert fresh_agent_cfg.get_skill(SKILL).last_error == "tampered:helper.py"


def test_clean_run_does_not_write_when_no_error(client, fresh_agent_cfg, tmp_path, monkeypatch):
    """无错时**一次都不写**（``set_skill_last_error`` 会 bump ``updated_at``，每次 run 都写等于
    把「上次改动时间」变成「上次运行时间」）。以调用计数为判据 —— ``_now()`` 是秒粒度，用
    updated_at 比对在同一秒内的测试里是**恒真**的假判据。"""
    skdir = _install_pack(client, tmp_path)
    calls: list = []
    cls = type(fresh_agent_cfg)
    orig = cls.set_skill_last_error

    def _spy(self, skill_name, error):
        calls.append((skill_name, error))
        return orig(self, skill_name, error)

    monkeypatch.setattr(cls, "set_skill_last_error", _spy)
    _data(client.post("/api/exec/run", json={"argv": ["/bin/echo", os.path.join(skdir, "main.py")]}))
    assert calls == []
    assert fresh_agent_cfg.get_skill(SKILL).last_error is None


# ── 反向断言：不误伤 ────────────────────────────────────────────────────────────────


def test_non_skill_shell_command_unaffected(client, fresh_agent_cfg, tmp_path):
    """危险解释器 + 壳包装但**不引用** skills 目录 → 照常执行（belt 只打 skills 文本引用）。"""
    _install_pack(client, tmp_path)
    d = _data(client.post("/api/exec/run", json={"argv": ["/bin/sh", "-c", "echo hi"]}))
    assert d["exit_code"] == 0 and d["stdout"] == "hi\n"
    assert d["injected_secret_names"] == []


def test_non_dangerous_argv0_text_ref_not_denied(client, fresh_agent_cfg, tmp_path):
    """非危险 argv0（/bin/echo）+ token 文本含 skills_root 但 realpath 不落地 → belt 第一关即放行
    （与 evaluate 侧 ``test_non_dangerous_argv0_text_ref_not_belt_blocked`` 同判，不越界拦）。"""
    skdir = _install_pack(client, tmp_path)
    d = _data(client.post("/api/exec/run", json={"argv": ["/bin/echo", f"note:{skdir}/main.py"]}))
    assert d["exit_code"] == 0


def test_plain_commands_unaffected(client, fresh_agent_cfg, tmp_path):
    """普通非 skill 命令（含 skills root 外的路径实参）零变化。"""
    _install_pack(client, tmp_path)
    script = tmp_path / "tool.sh"
    script.write_text("echo hi")
    assert _data(client.post("/api/exec/run", json={"argv": ["/bin/cat", str(script)]}))["exit_code"] == 0
    assert _data(client.post("/api/exec/run", json={"argv": ["/bin/echo", "sub", "--flag"]}))["exit_code"] == 0


def test_direct_absolute_argv_with_dangerous_argv0_not_denied(client, fresh_agent_cfg, tmp_path):
    """🔴 最重要的反误伤：危险 argv0 + **直接**绝对路径（正是我们劝模型改用的写法）绝不能被自己
    的地板拦下 —— 该 token realpath 落 skills 内，belt ``continue``。（用 /bin/cat 读脚本源码，
    不执行它；argv0 ``python3`` 的等价形状由 belt 逻辑同一分支覆盖。）"""
    skdir = _install_pack(client, tmp_path)
    main_py = os.path.join(skdir, "main.py")
    d = _data(client.post("/api/exec/run",
                          json={"argv": ["python3", "--version"], "cwd": skdir}))
    assert d["exit_code"] == 0  # 危险 argv0 + cwd 落 skill 目录，无 skills 文本引用 → 放行
    d2 = _data(client.post("/api/exec/run", json={"argv": ["/bin/cat", main_py]}))
    assert d2["exit_code"] == 0 and _MAIN_PY in d2["stdout"]
