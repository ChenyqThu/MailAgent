"""`GET/PUT /api/matters/agent-defaults` —— 全局跟进 Agent 的模型默认（0813 轮 3 · B10）。

形状抄 test_agent_matter_web_face.py（同一个弹窗里的兄弟设置）。差别在于值域校验**复用**
事项级那一份（`triggers.normalize_agent_overrides`），所以这里只需要证明那道闸真的挂上了、
且返回的是归一化后**真正落库**的那份，不是请求原样回显。
"""

from __future__ import annotations

import json

import src.api.auth as auth_mod
from src.matters.agent_defaults import MATTER_AGENT_DEFAULTS_KEY

ENDPOINT = "/api/matters/agent-defaults"


def test_get_missing_reads_as_nothing_configured(client, fresh_agent_cfg):
    response = client.get(ENDPOINT)
    assert response.status_code == 200
    assert response.json()["data"]["defaults"] == {}


def test_put_persists_and_get_reflects(client, fresh_agent_cfg):
    payload = {"model": "default:m1", "effort": "high", "fallback_models": ["default:m2"]}
    response = client.put(ENDPOINT, json={"defaults": payload})
    assert response.status_code == 200
    assert response.json()["data"]["defaults"] == payload
    assert client.get(ENDPOINT).json()["data"]["defaults"] == payload
    assert json.loads(fresh_agent_cfg.get_owner_setting(MATTER_AGENT_DEFAULTS_KEY)) == payload


def test_response_is_the_normalized_row_not_the_request_echo(client, fresh_agent_cfg):
    """🔴 前端拿返回值写缓存，所以它必须是**落库的那份** —— 回显请求会让「显示的」与
    「生效的」在归一化改动了输入时劈叉（这里：两侧空白被 strip、重复兜底被去重）。"""
    response = client.put(
        ENDPOINT,
        json={"defaults": {"model": "  default:m1  ", "fallback_models": ["a", "a", "b"]}},
    )
    assert response.status_code == 200
    assert response.json()["data"]["defaults"] == {
        "model": "default:m1",
        "fallback_models": ["a", "b"],
    }


def test_explicit_empty_fallback_survives_the_round_trip(client, fresh_agent_cfg):
    """`[]` = 显式不设兜底，与「没配过」不是一回事，两种空不许在 wire 上合成一种。"""
    response = client.put(ENDPOINT, json={"defaults": {"fallback_models": []}})
    assert response.json()["data"]["defaults"] == {"fallback_models": []}
    assert client.get(ENDPOINT).json()["data"]["defaults"] == {"fallback_models": []}


def test_clearing_is_expressible(client, fresh_agent_cfg):
    client.put(ENDPOINT, json={"defaults": {"model": "default:m1"}})
    assert client.put(ENDPOINT, json={"defaults": {}}).json()["data"]["defaults"] == {}
    assert client.get(ENDPOINT).json()["data"]["defaults"] == {}
    # body 里干脆不给 defaults 也是「清空」，不是 400（PUT 的语义是整体覆盖）。
    client.put(ENDPOINT, json={"defaults": {"model": "default:m1"}})
    assert client.put(ENDPOINT, json={}).json()["data"]["defaults"] == {}


def test_out_of_range_values_are_400_and_leave_the_row_untouched(client, fresh_agent_cfg):
    """🔴 越域一律 400、绝不静默丢：存下一个跑不起来的档位 = UI 显示的与真跑的劈叉。"""
    client.put(ENDPOINT, json={"defaults": {"model": "default:m1"}})
    for bad in (
        {"effort": "turbo"},
        {"effort": 3},
        {"model": 42},
        {"model": "   "},
        {"model": "m" * 201},
        {"fallback_models": "default:m2"},
        {"fallback_models": ["a", "b", "c", "d", "e"]},
        "not-an-object",
    ):
        response = client.put(ENDPOINT, json={"defaults": bad})
        assert response.status_code == 400, bad
        assert response.json()["error"]["code"] == "E_INVALID_ARG"
    # 被拒的请求一个字节都没落库
    assert client.get(ENDPOINT).json()["data"]["defaults"] == {"model": "default:m1"}


def test_dirty_stored_row_reads_as_nothing_configured(client, fresh_agent_cfg):
    fresh_agent_cfg.set_owner_setting(MATTER_AGENT_DEFAULTS_KEY, "{ not json")
    assert client.get(ENDPOINT).json()["data"]["defaults"] == {}


def test_unauthenticated_401(client, fresh_agent_cfg, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    assert client.get(ENDPOINT).status_code == 401
    assert client.put(ENDPOINT, json={"defaults": {"model": "x"}}).status_code == 401
    assert fresh_agent_cfg.get_owner_setting(MATTER_AGENT_DEFAULTS_KEY) is None
