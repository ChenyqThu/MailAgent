"""exec / 文件端点 API 测试（S2 W1）—— 固定 env 白名单 / deny 地板 inode / hardlink / TOCTOU /
超时 / cap / shell 注入不可能 + policy CRUD + evaluate。

全部 fixture 合成（tmp_path + monkeypatch DATA_ROOT），零真实文件风险。auth bypass 默认 ON
（conftest MAILAGENT_API_AUTH_DISABLED=true）。
"""

from __future__ import annotations

import os

import pytest

from src.api import exec_floor


@pytest.fixture(autouse=True)
def _reset_floor():
    """每测试重置 deny 地板缓存 —— 让 monkeypatch 的 MAILAGENT_DATA_ROOT 生效 + 跨测试隔离。"""
    exec_floor.reset_exec_floor_cache()
    yield
    exec_floor.reset_exec_floor_cache()


def _post(client, path, body):
    return client.post(path, json=body)


def _data(resp):
    j = resp.json()
    assert j["status"] == "success", j
    return j["data"]


def _err(resp):
    j = resp.json()
    assert j["status"] == "error", j
    return resp.status_code, j["error"]["code"]


# ── run_command ─────────────────────────────────────────────────────────────────


def test_run_echo(client):
    d = _data(_post(client, "/api/exec/run", {"argv": ["/bin/echo", "hello"]}))
    assert d["exit_code"] == 0
    assert d["stdout"].strip() == "hello"
    assert d["truncated"] is False
    assert d["policy"]["decision"] == "ask"  # 无规则 → ask


def test_run_nonzero_exit_passthrough(client):
    d = _data(_post(client, "/api/exec/run", {"argv": ["/bin/ls", "/nonexistent-xyz-123"]}))
    assert d["exit_code"] != 0
    assert d["stderr"]  # ls 报错进 stderr


def test_run_timeout_kills(client):
    code, err = _err(_post(client, "/api/exec/run", {"argv": ["/bin/sleep", "5"], "timeout_ms": 200}))
    assert code == 504 and err == "E_EXEC_TIMEOUT"


def test_run_stdout_capped(client):
    # 300 KiB > 256 KiB cap → 截断 + 标记。
    d = _data(_post(client, "/api/exec/run", {"argv": ["/bin/dd", "if=/dev/zero", "bs=1024", "count=300"]}))
    assert d["truncated"] is True
    assert len(d["stdout"]) <= 256 * 1024


def test_run_env_is_fixed_whitelist_no_global_secrets(client, monkeypatch):
    """子进程 env = 固定白名单基底：PATH 硬编码、NOTION_TOKEN / MAILAGENT_* 等**不继承**。"""
    monkeypatch.setenv("NOTION_TOKEN", "sentinel-notion-should-not-leak")
    monkeypatch.setenv("MAILAGENT_SENTINEL", "sentinel-mailagent")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "sentinel-aws")
    d = _data(_post(client, "/api/exec/run", {"argv": ["/usr/bin/env"]}))
    out = d["stdout"]
    assert "PATH=/usr/bin:/bin:/usr/sbin:/sbin" in out
    assert "sentinel-notion" not in out and "NOTION_TOKEN" not in out
    assert "MAILAGENT_SENTINEL" not in out and "sentinel-mailagent" not in out
    assert "AWS_SECRET_ACCESS_KEY" not in out and "sentinel-aws" not in out


def test_run_no_shell_injection(client):
    """argv 数组直传 → shell 元字符作字面参数（无 shell=True）。"""
    d = _data(_post(client, "/api/exec/run", {"argv": ["/bin/echo", "; rm -rf / && echo pwned"]}))
    assert d["exit_code"] == 0
    assert "; rm -rf / && echo pwned" in d["stdout"]  # 原样打印，未被解释


def test_run_floor_hit_on_env_path(client, monkeypatch, tmp_path):
    data_root = tmp_path / "root"
    data_root.mkdir()
    (data_root / ".env").write_text("NOTION_TOKEN=x")
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    # echo 只打印路径（不读文件），但 argv 含敏感路径 → 静态 floor 标红（不阻断执行）。
    d = _data(_post(client, "/api/exec/run", {"argv": ["/bin/echo", str(data_root / ".env")]}))
    assert d["exit_code"] == 0
    assert d["floor_hit"] is True
    assert d["floor_hits"]


def test_run_bad_cwd(client):
    code, err = _err(_post(client, "/api/exec/run", {"argv": ["/bin/echo", "x"], "cwd": "/nonexistent-dir-xyz"}))
    assert code == 400 and err == "E_BAD_CWD"


def test_run_command_not_found(client):
    code, err = _err(_post(client, "/api/exec/run", {"argv": ["/no/such/binary-xyz"]}))
    assert code == 400 and err == "E_NO_BIN"


# ── file_read ────────────────────────────────────────────────────────────────────


def test_file_read_normal(client, monkeypatch, tmp_path):
    data_root = tmp_path / "root"
    (data_root / "work").mkdir(parents=True)
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    f = data_root / "work" / "notes.txt"
    f.write_text("hello world")
    d = _data(_post(client, "/api/exec/file_read", {"path": str(f)}))
    assert d["content"] == "hello world"
    assert d["truncated"] is False and d["size"] == 11


def test_file_read_truncates(client, monkeypatch, tmp_path):
    data_root = tmp_path / "root"
    (data_root / "work").mkdir(parents=True)
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    f = data_root / "work" / "big.txt"
    f.write_text("A" * 5000)
    d = _data(_post(client, "/api/exec/file_read", {"path": str(f), "max_bytes": 1000}))
    assert d["truncated"] is True and len(d["content"]) == 1000 and d["size"] == 5000


def test_file_read_denies_env(client, monkeypatch, tmp_path):
    data_root = tmp_path / "root"
    data_root.mkdir()
    (data_root / ".env").write_text("NOTION_TOKEN=secret")
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    code, err = _err(_post(client, "/api/exec/file_read", {"path": str(data_root / ".env")}))
    assert code == 403 and err == "E_EXEC_FLOOR_DENIED"


def test_file_read_denies_hardlink_to_env(client, monkeypatch, tmp_path):
    """codex P1-4：敏感文件 hardlink 到允许目录 → inode 复核拦住（realpath 前缀挡不住）。"""
    data_root = tmp_path / "root"
    (data_root / "work").mkdir(parents=True)
    env_path = data_root / ".env"
    env_path.write_text("NOTION_TOKEN=secret")
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()  # 构造地板 → 缓存 .env inode
    link = data_root / "work" / "innocent.txt"
    os.link(str(env_path), str(link))  # hardlink（同 inode）
    code, err = _err(_post(client, "/api/exec/file_read", {"path": str(link)}))
    assert code == 403 and err == "E_EXEC_FLOOR_DENIED"


def test_file_read_denies_symlink_to_env(client, monkeypatch, tmp_path):
    data_root = tmp_path / "root"
    (data_root / "work").mkdir(parents=True)
    env_path = data_root / ".env"
    env_path.write_text("NOTION_TOKEN=secret")
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    sym = data_root / "work" / "sym.txt"
    os.symlink(str(env_path), str(sym))
    code, err = _err(_post(client, "/api/exec/file_read", {"path": str(sym)}))
    assert code == 403 and err == "E_EXEC_FLOOR_DENIED"


def test_file_read_denies_agent_config_db(client, monkeypatch, tmp_path):
    """*.db 直读被拒（直写库绕过全部业务不变式）。"""
    data_root = tmp_path / "root"
    (data_root / "data").mkdir(parents=True)
    db = data_root / "data" / "agent_config.db"
    db.write_text("sqlite-bytes")
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(db))
    exec_floor.reset_exec_floor_cache()
    code, err = _err(_post(client, "/api/exec/file_read", {"path": str(db)}))
    assert code == 403 and err == "E_EXEC_FLOOR_DENIED"


# ── file_write ───────────────────────────────────────────────────────────────────


def test_file_write_create_new(client, monkeypatch, tmp_path):
    data_root = tmp_path / "root"
    (data_root / "work").mkdir(parents=True)
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    f = data_root / "work" / "new.txt"
    d = _data(_post(client, "/api/exec/file_write", {"path": str(f), "content": "hi"}))
    assert d["created"] is True and d["bytes_written"] == 2
    assert f.read_text() == "hi"


def test_file_write_create_new_existing_conflicts(client, monkeypatch, tmp_path):
    data_root = tmp_path / "root"
    (data_root / "work").mkdir(parents=True)
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    f = data_root / "work" / "exists.txt"
    f.write_text("old")
    code, err = _err(_post(client, "/api/exec/file_write", {"path": str(f), "content": "new", "mode": "create_new"}))
    assert code == 409 and err == "E_FILE_EXISTS"
    assert f.read_text() == "old"  # 未被改


def test_file_write_overwrite_and_append(client, monkeypatch, tmp_path):
    data_root = tmp_path / "root"
    (data_root / "work").mkdir(parents=True)
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    f = data_root / "work" / "log.txt"
    f.write_text("first")
    d1 = _data(_post(client, "/api/exec/file_write", {"path": str(f), "content": "over", "mode": "overwrite"}))
    assert d1["created"] is False and f.read_text() == "over"
    _data(_post(client, "/api/exec/file_write", {"path": str(f), "content": "+more", "mode": "append"}))
    assert f.read_text() == "over+more"


def test_file_write_parent_missing(client, monkeypatch, tmp_path):
    data_root = tmp_path / "root"
    data_root.mkdir()
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    code, err = _err(_post(client, "/api/exec/file_write",
                           {"path": str(data_root / "no_such_dir" / "x.txt"), "content": "y"}))
    assert code == 400 and err == "E_BAD_PATH"


def test_file_write_overwrite_hardlink_to_env_denied_and_intact(client, monkeypatch, tmp_path):
    """overwrite 的截断推迟到 inode 复核之后 → hardlink 到 .env 的 overwrite 被拒 + .env 内容不损。"""
    data_root = tmp_path / "root"
    (data_root / "work").mkdir(parents=True)
    env_path = data_root / ".env"
    env_path.write_text("NOTION_TOKEN=secret")
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    link = data_root / "work" / "innocent.txt"
    os.link(str(env_path), str(link))
    code, err = _err(_post(client, "/api/exec/file_write", {"path": str(link), "content": "wiped", "mode": "overwrite"}))
    assert code == 403 and err == "E_EXEC_FLOOR_DENIED"
    assert env_path.read_text() == "NOTION_TOKEN=secret"  # 截断没发生


# ── W1a-fix：deny 地板扩展（P2-2 完整 .app bundle / P2-3 ai_chat.db override）────────


def test_file_read_denies_app_bundle_electron_main(client, monkeypatch, tmp_path):
    """P2-2：deny 地板覆盖**完整** macOS .app bundle —— Electron main 可执行体
    （Contents/MacOS/*）被拒（ADR-001 §7，防 agent 改写自身可执行体做持久化后门）。
    仅覆盖内嵌 python（sys.prefix）会漏掉 bundle 内其余可执行体。"""
    bundle = tmp_path / "MailAgent.app"
    pybin = bundle / "Contents" / "Resources" / "python" / "bin"
    pybin.mkdir(parents=True)
    fake_py = pybin / "python3"
    fake_py.write_text("#!/bin/sh\n")
    # sys.executable 落在假 bundle 内 → _app_bundle_root 上溯命中 *.app 根。
    monkeypatch.setattr(exec_floor.sys, "executable", str(fake_py))
    main_bin = bundle / "Contents" / "MacOS" / "MailAgent"
    main_bin.parent.mkdir(parents=True)
    main_bin.write_text("mach-o binary")
    data_root = tmp_path / "root"
    (data_root / "work").mkdir(parents=True)
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    code, err = _err(_post(client, "/api/exec/file_read", {"path": str(main_bin)}))
    assert code == 403 and err == "E_EXEC_FLOOR_DENIED"


def test_file_write_denies_app_bundle_resource(client, monkeypatch, tmp_path):
    """P2-2：写 bundle 内任意文件（此处 Resources/app 下的 JS）同样被拒。"""
    bundle = tmp_path / "MailAgent.app"
    pybin = bundle / "Contents" / "Resources" / "python" / "bin"
    pybin.mkdir(parents=True)
    fake_py = pybin / "python3"
    fake_py.write_text("#!/bin/sh\n")
    monkeypatch.setattr(exec_floor.sys, "executable", str(fake_py))
    data_root = tmp_path / "root"
    data_root.mkdir()
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    target = bundle / "Contents" / "Resources" / "app" / "inject.js"
    target.parent.mkdir(parents=True)
    code, err = _err(_post(client, "/api/exec/file_write",
                           {"path": str(target), "content": "pwn", "mode": "overwrite"}))
    assert code == 403 and err == "E_EXEC_FLOOR_DENIED"


def test_file_read_denies_ai_chat_db_with_override(client, monkeypatch, tmp_path):
    """P2-3：ai_chat.db 路径经 resolve_ai_chat_db_path 取 → ``AI_CHAT_DB_PATH`` override 时地板仍
    命中该 db（之前硬编码 DATA_ROOT/frontend/ai_chat.db，override 时地板双失）。"""
    data_root = tmp_path / "root"
    (data_root / "custom").mkdir(parents=True)
    db = data_root / "custom" / "relocated_chat.db"
    db.write_text("sqlite-bytes")
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    monkeypatch.setenv("AI_CHAT_DB_PATH", str(db))
    exec_floor.reset_exec_floor_cache()
    code, err = _err(_post(client, "/api/exec/file_read", {"path": str(db)}))
    assert code == 403 and err == "E_EXEC_FLOOR_DENIED"


# ── policy 规则 CRUD + evaluate 端点 ───────────────────────────────────────────────


def test_policy_rule_crud_and_dangerous_flag(client, fresh_agent_cfg):
    echo = os.path.realpath("/bin/echo")
    # create（安全全 pin 规则）
    d = _data(_post(client, "/api/agent/policy/rules", {
        "capability": "exec",
        "matcher": {"v": 1, "argv0_realpath": echo, "argv_template": [{"pin": "ping"}]},
        "note": "allow echo ping",
    }))
    rid = d["id"]
    assert d["capability"] == "exec" and d["enabled"] is True and d["dangerous"] is False

    # create（危险宽规则：git + {any}）→ 入库成功但 dangerous=true
    d2 = _data(_post(client, "/api/agent/policy/rules", {
        "capability": "exec",
        "matcher": {"v": 1, "argv0_realpath": "/usr/bin/git", "argv_template": [{"any": True}]},
    }))
    assert d2["dangerous"] is True

    # list
    lst = _data(_post_get(client, "/api/agent/policy/rules"))
    assert len(lst["rules"]) == 2

    # patch disable
    pd = _data(client.patch(f"/api/agent/policy/rules/{rid}", json={"enabled": False}))
    assert pd["enabled"] is False

    # delete
    dd = _data(client.request("DELETE", f"/api/agent/policy/rules/{rid}"))
    assert dd["removed"] is True
    # 幂等再删
    dd2 = _data(client.request("DELETE", f"/api/agent/policy/rules/{rid}"))
    assert dd2["removed"] is False


def test_policy_rule_create_rejects_bad_matcher(client, fresh_agent_cfg):
    code, err = _err(_post(client, "/api/agent/policy/rules", {
        "capability": "exec", "matcher": {"v": 1},  # 缺 argv0_realpath
    }))
    assert code == 422 and err == "E_INVALID_ARG"


def test_policy_evaluate_endpoint_context_binding(client, fresh_agent_cfg):
    echo = os.path.realpath("/bin/echo")
    _data(_post(client, "/api/agent/policy/rules", {
        "capability": "exec",
        "matcher": {"v": 1, "argv0_realpath": echo, "argv_template": [{"pin": "ping"}]},
        "contextMode": "manual_chat",
    }))
    action = {"argv": ["/bin/echo", "ping"], "cwd": None}
    # manual 显式 → auto_allow
    r1 = _data(_post(client, "/api/agent/policy/evaluate",
                     {"capability": "exec", "action": action, "contextMode": "manual_chat"}))
    assert r1["decision"] == "auto_allow" and r1["rule_id"] is not None
    # 缺 contextMode → fail-closed 到 untrusted → ask（manual 规则不匹配）
    r2 = _data(_post(client, "/api/agent/policy/evaluate", {"capability": "exec", "action": action}))
    assert r2["decision"] == "ask" and r2["rule_id"] is None


def test_run_policy_auto_allow_after_rule(client, fresh_agent_cfg, monkeypatch, tmp_path):
    """建规则后经 exec 端点跑 → 端点内部 evaluate 命中 → policy.decision=auto_allow（审计透传）。"""
    data_root = tmp_path / "root"
    data_root.mkdir()
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    echo = os.path.realpath("/bin/echo")
    _data(_post(client, "/api/agent/policy/rules", {
        "capability": "exec",
        "matcher": {"v": 1, "argv0_realpath": echo, "argv_template": [{"pin": "ping"}]},
    }))
    d = _data(_post(client, "/api/exec/run", {"argv": ["/bin/echo", "ping"]}))
    assert d["policy"]["decision"] == "auto_allow" and d["policy"]["rule_id"] is not None


def _post_get(client, path):
    """GET helper（policy list 是 GET）—— 与 _post 对称，便于 _data 复用。"""
    return client.get(path)
