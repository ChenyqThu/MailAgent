"""S5 WC exec 面加固（ADR-004 D4-②③ + 附带审计透传）—— 盲区独立 deny（E_SKILL_UNRESOLVED）+
communicate 流式化 cap 回归 + context_mode/agent_id 纯审计标注。

skill 经真实 fetch→confirm 供应链装入；fixtures 全合成（tmp skills dir + fresh agent_config.db）。
auth bypass 默认 ON（conftest）。
"""

from __future__ import annotations

import json
import os
import shutil
import zipfile

import pytest

from src.api import exec_floor


@pytest.fixture(autouse=True)
def _reset_floor():
    exec_floor.reset_exec_floor_cache()
    yield
    exec_floor.reset_exec_floor_cache()


def _make_zip(path, entries):
    with zipfile.ZipFile(path, "w") as z:
        for name, data in entries.items():
            z.writestr(name, data)


def _install_pack(client, tmp_path, name="dms-approve"):
    z = tmp_path / f"{name}.zip"
    _make_zip(z, {
        "manifest.json": json.dumps({
            "manifest_version": 2, "type": "script", "name": name, "version": "1.0",
            "title": "T", "description": "d", "entry_hint": "python3 main.py", "secrets": [],
        }),
        "SKILL.md": "# t",
        "main.py": "print('ok')",
    })
    preview = client.post("/api/agent/skills/fetch", json={"localPath": str(z)}).json()["data"]
    r = client.post("/api/agent/skills/confirm", json={
        "quarantineId": preview["quarantineId"],
        "expectedPackageHash": preview["packageHash"],
        "expectedFiles": preview["files"],
    })
    assert r.status_code == 201, r.json()
    from src.skills.pack_fetch import skill_dir

    return skill_dir(name)


def _data(resp):
    j = resp.json()
    assert j["status"] == "success", j
    return j["data"]


def _err(resp):
    j = resp.json()
    assert j["status"] == "error", j
    return resp.status_code, j["error"]["code"], j["error"]["message"]


# ── D4-②：盲区独立 deny（skills root 内清单外内容 → 409，人批了也不跑）────────────────────


def test_bare_rogue_token_under_skill_cwd_409_even_with_matching_rule(
    client, fresh_agent_cfg, fresh_skills_dir, tmp_path
):
    """直接盲区形状：cwd=skill 目录 + 裸 token 指向**清单外**现存文件 → 409 E_SKILL_UNRESOLVED。
    先种一条恰匹配该 argv 的全局宽规则（policy 面「批了」）——独立 deny 不看审批/白名单。"""
    skdir = _install_pack(client, tmp_path)
    rogue = os.path.join(skdir, "rogue.py")
    with open(rogue, "w") as f:
        f.write("print('sneaky')")
    r = client.post("/api/agent/policy/rules", json={
        "capability": "exec",
        "matcher": {"v": 1, "argv0_realpath": os.path.realpath("/bin/echo"),
                    "argv_template": [{"any": True}]},
        "contextMode": "manual_chat",
    })
    assert r.status_code == 201
    code, err, msg = _err(client.post("/api/exec/run",
                                      json={"argv": ["/bin/echo", "rogue.py"], "cwd": skdir}))
    assert (code, err) == (409, "E_SKILL_UNRESOLVED")
    assert "skill supply chain" in msg  # 修复路径指引文案


def test_manifest_bare_token_under_skill_cwd_still_runs(client, fresh_agent_cfg,
                                                        fresh_skills_dir, tmp_path):
    """清单内的裸 token（main.py 在 files_json）→ 通过独立 deny（诚实边界：不经 hash 校验，
    headless 由 evaluate 恒 ask 兜底）。"""
    skdir = _install_pack(client, tmp_path)
    d = _data(client.post("/api/exec/run", json={"argv": ["/bin/echo", "main.py"], "cwd": skdir}))
    assert d["exit_code"] == 0


def test_directory_and_nonexistent_skill_refs_409(client, fresh_agent_cfg,
                                                  fresh_skills_dir, tmp_path):
    skdir = _install_pack(client, tmp_path)
    # skill 目录本身作 argv token → 目录不在 files_json → 409。
    code, err, _ = _err(client.post("/api/exec/run", json={"argv": ["/bin/ls", skdir]}))
    assert (code, err) == (409, "E_SKILL_UNRESOLVED")
    # skills root 内不存在的路径 → 409（fail-closed）。
    code2, err2, _ = _err(client.post(
        "/api/exec/run", json={"argv": ["/bin/echo", os.path.join(skdir, "ghost.py")]}
    ))
    assert (code2, err2) == (409, "E_SKILL_UNRESOLVED")


def test_quarantine_ref_409(client, fresh_agent_cfg, fresh_skills_dir):
    q = fresh_skills_dir / ".quarantine" / "x-abc123456789" / "content"
    q.mkdir(parents=True)
    f = q / "main.py"
    f.write_text("x")
    code, err, _ = _err(client.post("/api/exec/run", json={"argv": ["/bin/echo", str(f)]}))
    assert (code, err) == (409, "E_SKILL_UNRESOLVED")


def test_draft_ref_has_dedicated_409_and_file_floor_denies(
    client, fresh_agent_cfg, fresh_skills_dir
):
    draft = fresh_skills_dir / ".draft" / "x-abc123456789" / "content"
    draft.mkdir(parents=True)
    script = draft / "main.py"
    script.write_text("print('never')")

    code, err, message = _err(
        client.post("/api/exec/run", json={"argv": ["/bin/echo", str(script)]})
    )
    assert (code, err) == (409, "E_SKILL_DRAFT")
    assert message == "skill drafts are never executable; publish the draft first"

    read_code, read_err, _ = _err(
        client.post("/api/exec/file_read", json={"path": str(script)})
    )
    assert (read_code, read_err) == (403, "E_EXEC_FLOOR_DENIED")
    write_code, write_err, _ = _err(
        client.post(
            "/api/exec/file_write",
            json={"path": str(draft / "out.txt"), "content": "blocked"},
        )
    )
    assert (write_code, write_err) == (403, "E_EXEC_FLOOR_DENIED")


def test_outside_skills_root_manual_semantics_unchanged(client, fresh_agent_cfg,
                                                        fresh_skills_dir, tmp_path):
    """范围界定（codex P2-1）：skills root **外**的路径 token / 裸实参零变化。"""
    script = tmp_path / "tool.sh"
    script.write_text("echo hi")
    d = _data(client.post("/api/exec/run", json={"argv": ["/bin/cat", str(script)]}))
    assert d["exit_code"] == 0
    d2 = _data(client.post("/api/exec/run", json={"argv": ["/bin/echo", "sub", "--flag"]}))
    assert d2["exit_code"] == 0


def test_probed_untracked_file_keeps_tampered_code(client, fresh_agent_cfg,
                                                   fresh_skills_dir, tmp_path):
    """分工不变：probe **落地**的清单外文件仍走既有 E_SKILL_TAMPERED（先判），独立 deny 是
    probe 认不出对象时的兜底 —— 错误码不漂移。"""
    skdir = _install_pack(client, tmp_path)
    extra = os.path.join(skdir, "extra.py")
    with open(extra, "w") as f:
        f.write("x")
    code, err, _ = _err(client.post("/api/exec/run", json={"argv": ["/bin/echo", extra]}))
    assert (code, err) == (409, "E_SKILL_TAMPERED")


# ── D4-③：communicate 流式化 cap 回归 ──────────────────────────────────────────────────


def test_large_output_capped_and_truncated(client, fresh_agent_cfg, fresh_skills_dir):
    head = shutil.which("head")
    assert head, "head not found on PATH"
    d = _data(client.post("/api/exec/run",
                          json={"argv": [head, "-c", "600000", "/dev/zero"]}))
    assert d["exit_code"] == 0
    assert d["truncated"] is True
    assert len(d["stdout"]) == 256 * 1024  # cap 语义同 W1a：256KiB 截断


def test_small_output_not_truncated(client, fresh_agent_cfg, fresh_skills_dir):
    d = _data(client.post("/api/exec/run", json={"argv": ["/bin/echo", "hi"]}))
    assert d["exit_code"] == 0
    assert d["stdout"] == "hi\n"
    assert d["truncated"] is False


# ── 附带项：context_mode / agent_id 纯审计标注透传 ──────────────────────────────────────


def test_audit_context_mode_passthrough_changes_policy_verdict(client, fresh_agent_cfg,
                                                               fresh_skills_dir):
    """manual_chat 全局规则命中 → 默认（不传 context）policy=auto_allow；透传
    untrusted_trigger → 同 argv 的审计 verdict 变 ask（context_mode 严格键控生效于审计行）——
    证明字段真透传到 evaluate，且**不做门禁**（两次都 200 执行）。"""
    r = client.post("/api/agent/policy/rules", json={
        "capability": "exec",
        "matcher": {"v": 1, "argv0_realpath": os.path.realpath("/bin/echo"),
                    "argv_template": [{"pin": "hi"}]},
        "contextMode": "manual_chat",
    })
    assert r.status_code == 201
    d1 = _data(client.post("/api/exec/run", json={"argv": ["/bin/echo", "hi"]}))
    assert d1["policy"]["decision"] == "auto_allow"
    d2 = _data(client.post("/api/exec/run", json={
        "argv": ["/bin/echo", "hi"], "context_mode": "untrusted_trigger", "agent_id": "dms",
    }))
    assert d2["exit_code"] == 0  # 不门禁，照常执行
    assert d2["policy"]["decision"] == "ask"


def test_audit_context_mode_invalid_literal_422(client, fresh_agent_cfg, fresh_skills_dir):
    r = client.post("/api/exec/run", json={"argv": ["/bin/echo", "hi"], "context_mode": "bogus"})
    assert r.status_code == 422


def test_file_endpoints_accept_audit_fields(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    p = tmp_path / "note.txt"
    p.write_text("hello")
    d = _data(client.post("/api/exec/file_read", json={
        "path": str(p), "context_mode": "cron_headless", "agent_id": "nightly",
    }))
    assert d["content"] == "hello"
    d2 = _data(client.post("/api/exec/file_write", json={
        "path": str(tmp_path / "out.txt"), "content": "x",
        "context_mode": "untrusted_trigger", "agent_id": "dms",
    }))
    assert d2["bytes_written"] == 1
