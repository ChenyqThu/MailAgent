"""/api/agent/assistant-identity（0813 主 agent 身份）—— 名字 + 头像端点。

owner-only（verify_cf_access，conftest auth bypass 默认开）。每测试独立临时
agent_config.db（fresh_agent_cfg fixture）。覆盖：默认 null/null / PUT 往返与持久化 /
name 规整（trim、空折 null、超长 400、非串 400）/ avatar 校验（bot 词表越域、多余键、
image data URI、legacy oreo 拒收）/ 脏行 fail-open 默认 / 无凭证 401。
"""

from __future__ import annotations

import base64
import json

import src.api.auth as auth_mod
from src.agent_config.store import AgentConfigStore

_URL = "/api/agent/assistant-identity"


def _image_data_uri(nbytes: int = 64) -> str:
    return "data:image/webp;base64," + base64.b64encode(b"\x00" * nbytes).decode("ascii")


def test_get_default_null_identity(client, fresh_agent_cfg):
    r = client.get(_URL)
    assert r.status_code == 200
    assert r.json()["data"] == {"name": None, "avatar": None}


def test_put_name_and_bot_avatar_round_trip(client, fresh_agent_cfg):
    avatar = {"type": "bot", "shape": "cube", "color": "teal"}
    r = client.put(_URL, json={"name": "Jarvis", "avatar": avatar})
    assert r.status_code == 200
    assert r.json()["data"] == {"name": "Jarvis", "avatar": avatar}
    assert client.get(_URL).json()["data"] == {"name": "Jarvis", "avatar": avatar}
    # 持久化：同一 db 路径新建 store 实例仍读到（= 重启存活语义）
    st2 = AgentConfigStore(fresh_agent_cfg.db_path)
    stored = json.loads(st2.get_owner_setting("assistant_identity"))
    assert stored == {"name": "Jarvis", "avatar": avatar}


def test_put_name_normalization(client, fresh_agent_cfg):
    # trim + 空串折 null
    assert client.put(_URL, json={"name": "  Jarvis  ", "avatar": None}).json()["data"][
        "name"
    ] == "Jarvis"
    assert client.put(_URL, json={"name": "   ", "avatar": None}).json()["data"]["name"] is None
    # 超长 400（40 字符上限；trim 后判）
    r = client.put(_URL, json={"name": "x" * 41, "avatar": None})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    # 非字符串 400
    assert client.put(_URL, json={"name": 42, "avatar": None}).status_code == 400
    # 越域写不落库：GET 仍是上一次合法值（name=None）
    assert client.get(_URL).json()["data"]["name"] is None


def test_put_avatar_validation(client, fresh_agent_cfg):
    # bot 越域 shape / color / 多余键 / 缺键
    for bad in (
        {"type": "bot", "shape": "blob", "color": "orange"},  # v1 形状名写侧不认（读侧才换代）
        {"type": "bot", "shape": "cube", "color": "neon"},
        {"type": "bot", "shape": "cube", "color": "teal", "x": 1},
        {"type": "bot", "shape": "cube"},
        {"shape": "nova", "palette": "rose"},  # legacy oreo：主 agent 无存量行，不适用
        {"type": "unknown"},
        "not-a-dict",
    ):
        r = client.put(_URL, json={"name": None, "avatar": bad})
        assert r.status_code == 400, f"avatar={bad!r} should be rejected"
        assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert client.get(_URL).json()["data"] == {"name": None, "avatar": None}


def test_put_image_avatar_round_trip(client, fresh_agent_cfg):
    avatar = {"type": "image", "data": _image_data_uri()}
    r = client.put(_URL, json={"name": None, "avatar": avatar})
    assert r.status_code == 200
    assert r.json()["data"]["avatar"] == avatar
    assert client.get(_URL).json()["data"]["avatar"] == avatar
    # 清回默认
    assert client.put(_URL, json={"name": None, "avatar": None}).json()["data"] == {
        "name": None,
        "avatar": None,
    }


def test_dirty_row_reads_as_default(client, fresh_agent_cfg):
    """脏行（坏 JSON / 非 dict / 键形状不对）→ GET fail-open 回默认（显示型数据，
    不许把一条坏行变成加载失败）。"""
    for dirty in ("not-json", '"a string"', "[1,2]", '{"name": 42, "avatar": "x"}'):
        fresh_agent_cfg.set_owner_setting("assistant_identity", dirty)
        assert client.get(_URL).json()["data"] == {"name": None, "avatar": None}, dirty


def test_unauthenticated_401(client, fresh_agent_cfg, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    assert client.get(_URL).status_code == 401
    r = client.put(_URL, json={"name": "Jarvis", "avatar": None})
    assert r.status_code == 401
    assert fresh_agent_cfg.get_owner_setting("assistant_identity") is None
