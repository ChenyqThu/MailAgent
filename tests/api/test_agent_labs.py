"""/api/agent/labs（g1 群聊，task 09-01）—— owner_settings 型实验开关端点。

形状抄 approval-mode 先例（owner-only verify_cf_access，conftest auth bypass 默认开；每测试
独立临时 agent_config.db）。覆盖：缺行默认 on / PUT 持久化（跨 store 实例 = 重启存活）/
越域值 400 且不落库 / 空 body 400 / 脏行读成出厂默认。

🔴 出厂默认是 **on**（群聊多 agent 已是正常形态，开关只留给 owner 退回 v1 排查）。缺行与脏行
读同一个默认值：不为「有人手改过库」单开一档。owner 显式写过的 'off' 行照读不误 —— 端点绝不
把它当脏值覆盖掉。
"""

from __future__ import annotations

from src.agent_config.store import AgentConfigStore


def test_get_default_on(client, fresh_agent_cfg):
    r = client.get("/api/agent/labs")
    assert r.status_code == 200
    assert r.json()["data"]["groupAgents"] == "on"


def test_explicit_off_row_survives_new_default(client, fresh_agent_cfg):
    """owner 显式关过 → 读回来仍是 off（翻默认不迁移已有行）。"""
    assert client.put("/api/agent/labs", json={"groupAgents": "off"}).status_code == 200
    assert client.get("/api/agent/labs").json()["data"]["groupAgents"] == "off"
    assert AgentConfigStore(fresh_agent_cfg.db_path).get_owner_setting("labs_group_agents") == "off"


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
    assert client.get("/api/agent/labs").json()["data"]["groupAgents"] == "on"


def test_put_missing_body_400(client, fresh_agent_cfg):
    r = client.put("/api/agent/labs", json={})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_dirty_stored_value_reads_default(client, fresh_agent_cfg):
    """脏行（绕过端点写入的越域值）→ GET 回落出厂默认。"""
    fresh_agent_cfg.set_owner_setting("labs_group_agents", "totally-bogus")
    assert client.get("/api/agent/labs").json()["data"]["groupAgents"] == "on"
