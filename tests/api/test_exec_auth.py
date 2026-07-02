"""W1a-fix P1：exec / policy-evaluate 端点鉴权收窄回归。

exec 三端点（``/api/exec/run|file_read|file_write``）+ ``/api/agent/policy/evaluate`` 从
``verify_cf_access`` 收窄为 ``verify_local_token``（**仅**本地 ephemeral token，**不接受** CF JWT）——
唯一合法调用方是同机 loopback 的 in-process gateway domainClient（恒带 ``X-MailAgent-Local-Token``）。
serve-api 经 cloudflared 暴露公网，若挂 cf_access 则持/窃 owner CF 会话者可远程 curl ``/api/exec/run``
拿 RCE，绕过 gateway 的 HITL / policy engine。

对照（**不得波及**）：``/api/agent/policy/rules`` CRUD + ``/skills/*`` + ``/profile/*`` 仍走
``verify_cf_access``（Settings UI 远程管理）。

fixture 沿用 conftest ``client``（bypass 默认 ON）；每用例 monkeypatch ``AUTH_DISABLED=False`` 实测
锁定行为，CF JWT 通过用 test_auth_and_bind 同款 stub（no-op 签名校验 + 受控 ``jwt.decode`` claims）。
"""

from __future__ import annotations

import os

import pytest

import src.api.auth as auth_mod
from src.api import exec_floor

LOCAL_TOK = "ephemeral-secret-w1afix"
CF_HEADERS = {"Cf-Access-Jwt-Assertion": "header.payload.sig"}
LOCAL_HEADERS = {auth_mod.LOCAL_TOKEN_HEADER: LOCAL_TOK}


@pytest.fixture(autouse=True)
def _reset_floor():
    """跨用例隔离 deny 地板缓存（run 真跑的用例会 monkeypatch DATA_ROOT）。"""
    exec_floor.reset_exec_floor_cache()
    yield
    exec_floor.reset_exec_floor_cache()


def _arm_cf_jwt(monkeypatch):
    """装配「合法 CF Access JWT」环境：签名校验 no-op + ``jwt.decode`` 返回 owner claims + 白名单命中。

    带 ``Cf-Access-Jwt-Assertion`` header 的请求经 ``verify_cf_access`` 会通过——用来证明 exec/evaluate
    即便面对一个**有效** CF 会话也拒绝（因为它们挂的是 ``verify_local_token``，根本不看 CF JWT）。
    """
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    class _Key:
        key = "irrelevant"

    monkeypatch.setattr(auth_mod._jwk_client, "get_signing_key_from_jwt", lambda _t: _Key())
    monkeypatch.setattr(auth_mod.jwt, "decode", lambda *a, **k: {"email": "owner@example.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@example.com"})


# ── exec 端点：CF-JWT-only 被拒 / 本地 token 通过 ────────────────────────────────────


@pytest.mark.parametrize(
    "path,body",
    [
        ("/api/exec/run", {"argv": ["/bin/echo", "x"]}),
        ("/api/exec/file_read", {"path": "/etc/hostname"}),
        ("/api/exec/file_write", {"path": "/tmp/w1afix_should_not_write.txt", "content": "x"}),
    ],
)
def test_exec_endpoints_reject_cf_jwt_only(client, monkeypatch, path, body):
    """三端点挂 verify_local_token → 即便带**有效** CF JWT，无本地 token header 也 403。"""
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    r = client.post(path, json=body, headers=CF_HEADERS)  # 只有 CF JWT，无本地 token
    assert r.status_code == 403


def test_exec_run_accepts_local_token(client, monkeypatch, tmp_path):
    """配了本地 token + 带正确 ``X-MailAgent-Local-Token`` → 放行（真跑 echo）。"""
    _arm_cf_jwt(monkeypatch)  # CF 也就绪，但 verify_local_token 只认本地 token
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    data_root = tmp_path / "root"
    data_root.mkdir()
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    exec_floor.reset_exec_floor_cache()
    r = client.post("/api/exec/run", json={"argv": ["/bin/echo", "hi"]}, headers=LOCAL_HEADERS)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "success" and j["data"]["stdout"].strip() == "hi"


def test_exec_run_no_token_at_all_rejected(client, monkeypatch):
    """配了本地 token 但请求两种 header 都不带 → 403（非 dev fail-closed）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    r = client.post("/api/exec/run", json={"argv": ["/bin/echo", "x"]})
    assert r.status_code == 403


# ── /policy/evaluate：同样收窄（CF-only 拒 / 本地 token 通过）─────────────────────────


def test_policy_evaluate_rejects_cf_jwt_only(client, monkeypatch, fresh_agent_cfg):
    """/policy/evaluate 是执行放行判定的前置门 → CF-only 会话不得触达。"""
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    r = client.post(
        "/api/agent/policy/evaluate",
        json={"capability": "exec", "action": {"argv": ["/bin/echo", "x"]}},
        headers=CF_HEADERS,
    )
    assert r.status_code == 403


def test_policy_evaluate_accepts_local_token(client, monkeypatch, fresh_agent_cfg):
    """本地 token → 放行；无规则 → decision=ask。"""
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    r = client.post(
        "/api/agent/policy/evaluate",
        json={"capability": "exec", "action": {"argv": ["/bin/echo", "x"]}, "contextMode": "manual_chat"},
        headers=LOCAL_HEADERS,
    )
    assert r.status_code == 200
    assert r.json()["data"]["decision"] == "ask"


# ── 对照回归：policy/rules CRUD 仍走 verify_cf_access（不被本改动波及）───────────────


def test_policy_rules_list_still_accepts_cf_jwt(client, monkeypatch, fresh_agent_cfg):
    """/policy/rules GET 保持 cf_access → 合法 CF JWT（**无**本地 token）仍 200。"""
    _arm_cf_jwt(monkeypatch)  # 不配 _LOCAL_API_TOKEN；仅 CF JWT
    r = client.get("/api/agent/policy/rules", headers=CF_HEADERS)
    assert r.status_code == 200
    assert r.json()["status"] == "success"


def test_policy_rules_create_still_accepts_cf_jwt(client, monkeypatch, fresh_agent_cfg):
    """/policy/rules POST 同样 CF JWT 可达（Settings 建规则路径不回归）。"""
    _arm_cf_jwt(monkeypatch)
    echo = os.path.realpath("/bin/echo")
    r = client.post(
        "/api/agent/policy/rules",
        json={
            "capability": "exec",
            "matcher": {"v": 1, "argv0_realpath": echo, "argv_template": [{"pin": "ping"}]},
        },
        headers=CF_HEADERS,
    )
    assert r.status_code == 201


def test_exec_run_rejected_while_rules_accept_same_cf_jwt(client, monkeypatch, fresh_agent_cfg):
    """决定性对照：**同一** CF-JWT-only 请求下，/policy/rules 200 而 /api/exec/run 403 —— 证明收窄
    只落 exec/evaluate，未误伤 rules CRUD。"""
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    assert client.get("/api/agent/policy/rules", headers=CF_HEADERS).status_code == 200
    assert (
        client.post("/api/exec/run", json={"argv": ["/bin/echo", "x"]}, headers=CF_HEADERS).status_code
        == 403
    )
