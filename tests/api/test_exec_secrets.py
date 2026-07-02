"""exec 端点 per-skill 密钥注入 + 输出脱敏（S2 W3）—— 命中 skill 目录注入声明∩已存储密钥、
非 skill 命令零注入、stdout 精确脱敏、哨兵值不进响应/日志/异常。

全合成（tmp DATA_ROOT + MAILAGENT_SKILLS_DIR + fresh agent_config.db；master key 强制 keyfile 通道，
**绝不**碰真钥匙串）。auth bypass 默认 ON（conftest）。
"""

from __future__ import annotations

import logging
import os

import pytest

from src.agent_config import secrets
from src.api import exec_floor

SENTINEL = "sentinel-DMS-secret-4242"


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """master key 走 keyfile（不弹钥匙串）+ DATA_ROOT/skills 落 tmp + 缓存重置。"""
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


def _install_script_skill(store, name, secret_names):
    """装一个 script skill 行（manifest 声明 secret_names）+ 建落盘目录，返回 skill 目录路径。"""
    store.install_skill(
        name,
        source_type="local_folder",
        manifest={
            "name": name,
            "type": "script",
            "tools": [],
            "secrets": [{"name": s} for s in secret_names],
        },
    )
    from src.skills.pack_fetch import skill_dir

    d = skill_dir(name)
    os.makedirs(d, exist_ok=True)
    return d


def _data(resp):
    j = resp.json()
    assert j["status"] == "success", j
    return j["data"]


def test_secret_injected_and_value_redacted(client, fresh_agent_cfg):
    """cwd 落在 skill 目录 → 声明的 DMS_TOKEN 注入子进程 env；env 输出里名字在、**值被脱敏**。"""
    store = fresh_agent_cfg
    skdir = _install_script_skill(store, "dms", ["DMS_TOKEN"])
    secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=store)

    d = _data(client.post("/api/exec/run", json={"argv": ["/usr/bin/env"], "cwd": skdir}))
    assert d["injected_secret_names"] == ["DMS_TOKEN"]
    out = d["stdout"]
    assert "DMS_TOKEN=" in out  # 证明确实注入
    assert SENTINEL not in out  # 值被脱敏
    assert "[REDACTED:DMS_TOKEN]" in out


def test_redact_prefix_pair_no_tail_leak(client, fresh_agent_cfg):
    """两 secret 值互为前缀 → 长值必须先脱敏（W3 review P2-①）。若按名序，短值 ``TOKENabc`` 先
    替换会把长值 ``TOKENabc123XY`` 的前缀吃掉、泄漏尾部 ``123XY``；len 降序则整段命中。"""
    store = fresh_agent_cfg
    skdir = _install_script_skill(store, "pfx", ["SECRET_A", "SECRET_B"])
    short_v, long_v = "TOKENabc", "TOKENabc123XY"
    secrets.set_secret("pfx", "SECRET_A", short_v, store=store)
    secrets.set_secret("pfx", "SECRET_B", long_v, store=store)

    d = _data(client.post("/api/exec/run", json={"argv": ["/usr/bin/env"], "cwd": skdir}))
    out = d["stdout"]
    assert short_v not in out
    assert long_v not in out
    assert "123XY" not in out  # 长值尾部不因短值先替换而泄漏（前缀子串洞）
    assert "[REDACTED:SECRET_A]" in out and "[REDACTED:SECRET_B]" in out


def test_non_skill_command_zero_injection(client, fresh_agent_cfg):
    """普通命令（cwd 缺省 = DATA_ROOT，不触达 skill 目录）→ 零注入，无密钥泄漏。"""
    store = fresh_agent_cfg
    _install_script_skill(store, "dms", ["DMS_TOKEN"])
    secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=store)

    d = _data(client.post("/api/exec/run", json={"argv": ["/usr/bin/env"]}))
    assert d["injected_secret_names"] == []
    assert "DMS_TOKEN" not in d["stdout"]
    assert SENTINEL not in d["stdout"]


def test_undeclared_stored_secret_not_injected(client, fresh_agent_cfg):
    """存了一个 manifest 未声明的密钥 → 不注入（只注入「声明 ∩ 已存储」）。"""
    store = fresh_agent_cfg
    skdir = _install_script_skill(store, "dms", ["DMS_TOKEN"])
    secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=store)
    secrets.set_secret("dms", "OTHER_TOKEN", "undeclared-999", store=store)

    d = _data(client.post("/api/exec/run", json={"argv": ["/usr/bin/env"], "cwd": skdir}))
    assert d["injected_secret_names"] == ["DMS_TOKEN"]
    assert "OTHER_TOKEN" not in d["stdout"]
    assert "undeclared-999" not in d["stdout"]


def test_ambiguous_multi_skill_no_injection(client, fresh_agent_cfg):
    """argv 触达两个不同 skill 目录 → 保守零注入（防 skill A 密钥泄漏给触达 skill B 的命令）。"""
    store = fresh_agent_cfg
    a = _install_script_skill(store, "dms", ["DMS_TOKEN"])
    b = _install_script_skill(store, "other", ["OTHER_TOKEN"])
    secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=store)

    d = _data(client.post(
        "/api/exec/run",
        json={"argv": ["/bin/echo", os.path.join(a, "x"), os.path.join(b, "y")]},
    ))
    assert d["injected_secret_names"] == []
    assert SENTINEL not in d["stdout"]


def test_skill_without_stored_secret_injects_nothing(client, fresh_agent_cfg):
    """声明了 secret 但 owner 还没写值 → 注入空（脚本会因缺 secret 失败，但不泄漏）。"""
    store = fresh_agent_cfg
    skdir = _install_script_skill(store, "dms", ["DMS_TOKEN"])
    d = _data(client.post("/api/exec/run", json={"argv": ["/usr/bin/env"], "cwd": skdir}))
    assert d["injected_secret_names"] == []


def test_sentinel_never_in_response_or_logs(client, fresh_agent_cfg, caplog):
    """全链路哨兵：跑一轮后，注入的值不出现在端点响应 JSON / logger 输出。"""
    store = fresh_agent_cfg
    skdir = _install_script_skill(store, "dms", ["DMS_TOKEN"])
    secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=store)

    from loguru import logger as _lg

    sink_id = _lg.add(caplog.handler, format="{message}", level="DEBUG")
    caplog.set_level(logging.DEBUG)
    try:
        # echo 只打印固定串（不回显密钥）→ 响应里绝无哨兵；env 会回显但被脱敏。
        resp = client.post("/api/exec/run", json={"argv": ["/bin/echo", "hi"], "cwd": skdir})
    finally:
        _lg.remove(sink_id)
    assert resp.status_code == 200
    assert SENTINEL not in resp.text  # 整个响应 JSON 无哨兵
    assert SENTINEL not in caplog.text  # 日志无哨兵
