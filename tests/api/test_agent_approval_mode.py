"""/api/agent/approval-mode（07-16 approval-mode switcher）—— chat 授权模式端点。

owner-only（verify_cf_access，conftest auth bypass 默认开）。每测试独立临时
agent_config.db（fresh_agent_cfg fixture）。覆盖：默认 manual / PUT 持久化（跨 store
实例）/ 越域值 400 / 空 body 400 / 无凭证 401（GET+PUT 双端点）。
"""

from __future__ import annotations

import src.api.auth as auth_mod
from src.agent_config.store import AgentConfigStore


def test_get_default_manual(client, fresh_agent_cfg):
    r = client.get("/api/agent/approval-mode")
    assert r.status_code == 200
    assert r.json()["data"]["mode"] == "manual"


def test_put_persists_and_get_reflects(client, fresh_agent_cfg):
    r = client.put("/api/agent/approval-mode", json={"mode": "acceptEdits"})
    assert r.status_code == 200
    assert r.json()["data"]["mode"] == "acceptEdits"
    assert client.get("/api/agent/approval-mode").json()["data"]["mode"] == "acceptEdits"
    # bypass 同样合法
    r2 = client.put("/api/agent/approval-mode", json={"mode": "bypass"})
    assert r2.status_code == 200
    assert client.get("/api/agent/approval-mode").json()["data"]["mode"] == "bypass"
    # 持久化：同一 db 路径新建 store 实例仍读到（= 重启存活语义）
    st2 = AgentConfigStore(fresh_agent_cfg.db_path)
    assert st2.get_owner_setting("chat_approval_mode") == "bypass"
    # 切回 manual
    client.put("/api/agent/approval-mode", json={"mode": "manual"})
    assert client.get("/api/agent/approval-mode").json()["data"]["mode"] == "manual"


def test_put_invalid_mode_400(client, fresh_agent_cfg):
    for bad in ("auto-reversible", "always", "BYPASS", "", 1, None):
        r = client.put("/api/agent/approval-mode", json={"mode": bad})
        assert r.status_code == 400, f"mode={bad!r} should be rejected"
        assert r.json()["error"]["code"] == "E_INVALID_ARG"
    # 越域值绝不落库 —— GET 仍 manual
    assert client.get("/api/agent/approval-mode").json()["data"]["mode"] == "manual"


def test_put_missing_body_400(client, fresh_agent_cfg):
    r = client.put("/api/agent/approval-mode", json={})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_dirty_stored_value_reads_as_manual(client, fresh_agent_cfg):
    """脏行（绕过端点写入的越域值）→ GET fail-closed 回落 manual。"""
    fresh_agent_cfg.set_owner_setting("chat_approval_mode", "totally-bogus")
    assert client.get("/api/agent/approval-mode").json()["data"]["mode"] == "manual"


def test_unauthenticated_401(client, fresh_agent_cfg, monkeypatch):
    """无凭证（无 CF JWT / 无本地 token）→ 401：模式切换是 owner 面（verify_cf_access 双腿）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = client.get("/api/agent/approval-mode")
    assert r.status_code == 401
    r2 = client.put("/api/agent/approval-mode", json={"mode": "bypass"})
    assert r2.status_code == 401
    # 未鉴权的 PUT 绝不落库
    assert fresh_agent_cfg.get_owner_setting("chat_approval_mode") is None
