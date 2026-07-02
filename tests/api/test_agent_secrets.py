"""per-skill 密钥 owner 端点（S2 W3）—— PUT write-only / GET 只名+时间戳 / DELETE 幂等，值永不回显；
非法 secret 名拒、未知 skill 404、uninstall 清理闭环。

master key 强制 keyfile 通道（不弹钥匙串）；fresh agent_config.db。auth bypass 默认 ON（conftest）。
"""

from __future__ import annotations

import os

import pytest

from src.agent_config import secrets

SENTINEL = "owner-set-secret-7777"


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("MAILAGENT_SKILLS_DIR", str(tmp_path / "skills"))

    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)
    secrets.reset_master_key_cache()
    yield
    secrets.reset_master_key_cache()


def _install(store, name="dms"):
    store.install_skill(
        name,
        source_type="local_folder",
        manifest={"name": name, "type": "script", "tools": [], "secrets": [{"name": "DMS_TOKEN"}]},
    )


def _data(resp):
    j = resp.json()
    assert j["status"] == "success", j
    return j["data"]


def _err(resp):
    j = resp.json()
    assert j["status"] == "error", j
    return resp.status_code, j["error"]["code"]


def test_put_get_delete_roundtrip(client, fresh_agent_cfg):
    store = fresh_agent_cfg
    _install(store)

    # PUT — write-only：响应不回显值。
    d = _data(client.put("/api/agent/skills/dms/secrets/DMS_TOKEN", json={"value": SENTINEL}))
    assert d["name"] == "dms" and d["secretName"] == "DMS_TOKEN"
    assert d["updatedAt"]  # 有时间戳
    assert SENTINEL not in str(d)  # 值不在响应

    # GET — 只名 + updatedAt，永无值。
    lst = _data(client.get("/api/agent/skills/dms/secrets"))
    assert lst["secrets"] == [{"name": "DMS_TOKEN", "updatedAt": d["updatedAt"]}]
    assert SENTINEL not in str(lst)

    # 值确实落库可解密（后端视角）。
    assert secrets.get_secret("dms", "DMS_TOKEN", store=store) == SENTINEL

    # DELETE — 幂等。
    r = _data(client.delete("/api/agent/skills/dms/secrets/DMS_TOKEN"))
    assert r["removed"] is True
    assert _data(client.get("/api/agent/skills/dms/secrets"))["secrets"] == []
    assert _data(client.delete("/api/agent/skills/dms/secrets/DMS_TOKEN"))["removed"] is False


def test_put_rejects_reserved_secret_name(client, fresh_agent_cfg):
    _install(fresh_agent_cfg)
    for bad in ("PATH", "NODE_OPTIONS", "BASH_ENV", "LD_PRELOAD", "token"):
        code, err = _err(client.put(f"/api/agent/skills/dms/secrets/{bad}", json={"value": "x"}))
        assert code == 400 and err == "E_INVALID_ARG"


def test_put_unknown_skill_404(client, fresh_agent_cfg):
    code, err = _err(client.put("/api/agent/skills/ghost/secrets/DMS_TOKEN", json={"value": "x"}))
    assert code == 404 and err == "E_NOT_FOUND"


def test_put_empty_value_rejected(client, fresh_agent_cfg):
    _install(fresh_agent_cfg)
    code, err = _err(client.put("/api/agent/skills/dms/secrets/DMS_TOKEN", json={"value": ""}))
    assert code == 400 and err == "E_INVALID_ARG"


def test_get_empty_when_no_secrets(client, fresh_agent_cfg):
    _install(fresh_agent_cfg)
    assert _data(client.get("/api/agent/skills/dms/secrets"))["secrets"] == []


def test_delete_validates_secret_name(client, fresh_agent_cfg):
    """畸形 secret 名（path 参数）→ 400，不触发 500。"""
    code, err = _err(client.delete("/api/agent/skills/dms/secrets/lower"))
    assert code == 400 and err == "E_INVALID_ARG"


def test_uninstall_full_clears_secrets(client, fresh_agent_cfg):
    """全清理卸载（W2 端点）→ skill_secrets 行随之清空（W3 闭环）。"""
    from src.skills.pack_fetch import skill_dir

    store = fresh_agent_cfg
    _install(store)
    os.makedirs(skill_dir("dms"), exist_ok=True)
    client.put("/api/agent/skills/dms/secrets/DMS_TOKEN", json={"value": SENTINEL})
    assert secrets.get_secrets_for_skill("dms", store=store) == {"DMS_TOKEN": SENTINEL}

    r = _data(client.post("/api/agent/skills/uninstall", json={"name": "dms"}))
    assert r["removedSecrets"] >= 1
    assert secrets.get_secrets_for_skill("dms", store=store) == {}
