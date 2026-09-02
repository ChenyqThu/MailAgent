"""/api/agent/labs（g1 群聊，task 09-01）—— owner_settings 型实验开关端点。

形状抄 approval-mode 先例（owner-only verify_cf_access，conftest auth bypass 默认开；每测试
独立临时 agent_config.db）。覆盖：缺行默认 off / PUT 持久化（跨 store 实例 = 重启存活）/
越域值 400 且不落库 / 空 body 400 / 脏行读成 off（fail-closed）。

🔴 「缺行 = off」与「脏行 = off」两条不是同一条：前者是出厂态，后者是**有人手改过库**。两条
都必须 fail-closed —— gateway 的 resolveLabsFlags 同样以 off 兜底，服务端要是把脏行读成 on，
owner 会在完全不知情的情况下开始被服务端编排烧 token。
"""

from __future__ import annotations

from src.agent_config.store import AgentConfigStore


def test_get_default_off(client, fresh_agent_cfg):
    r = client.get("/api/agent/labs")
    assert r.status_code == 200
    assert r.json()["data"]["groupAgents"] == "off"


def test_put_persists_and_get_reflects(client, fresh_agent_cfg):
    assert client.put("/api/agent/labs", json={"groupAgents": "on"}).status_code == 200
    assert client.get("/api/agent/labs").json()["data"]["groupAgents"] == "on"
    # 持久化：同一 db 路径新建 store 实例仍读到（= 重启存活语义）。
    assert AgentConfigStore(fresh_agent_cfg.db_path).get_owner_setting("labs_group_agents") == "on"
    client.put("/api/agent/labs", json={"groupAgents": "off"})
    assert client.get("/api/agent/labs").json()["data"]["groupAgents"] == "off"


def test_put_invalid_value_400_and_not_persisted(client, fresh_agent_cfg):
    for bad in ("ON", "true", "enabled", "", 1, None, []):
        r = client.put("/api/agent/labs", json={"groupAgents": bad})
        assert r.status_code == 400, f"groupAgents={bad!r} should be rejected"
        assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert client.get("/api/agent/labs").json()["data"]["groupAgents"] == "off"


def test_put_missing_body_400(client, fresh_agent_cfg):
    r = client.put("/api/agent/labs", json={})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_dirty_stored_value_reads_off(client, fresh_agent_cfg):
    """脏行（绕过端点写入的越域值）→ GET fail-closed 回落 off。"""
    fresh_agent_cfg.set_owner_setting("labs_group_agents", "totally-bogus")
    assert client.get("/api/agent/labs").json()["data"]["groupAgents"] == "off"
