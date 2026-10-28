"""/api/davmail/reauth/* —— DavMail 认证失效自助重连接口（task 10-28）。

钉住：非 davmail 后端 409；start 的线上形状；会话过期 / 不存在给出 ok=false；成功后会话作废、
写入 ``davmail.auth.last_interactive_at``；授权码与 token 原文不进日志、不进响应。
换 token 与 LOGIN 验证经 monkeypatch 模块属性替换，不碰微软接口和真实 DavMail。
"""
from __future__ import annotations

import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from loguru import logger

from src.api.app import app
from src.api.deps import get_settings
from src.api.routers import davmail as router_mod
from src.mail import davmail_reauth
from src.mail.davmail_reauth import decrypt_token, read_token_value
from src.mail.davmail_watchdog import AUTH_LAST_INTERACTIVE_AT_KEY

FAKE_CODE = "0.AXEAfakeAuthCodeForApiTests_abcdefghijklmnopqrstuvwxyz-0123456789"
FAKE_REFRESH = "0.AXEAfakeRefreshTokenForApiTests.zyxwvutsrqponmlkjihgfedcba~987654"
CIPHER = "api-test-cipher-key"
USER = "owner@example.com"
_BASE = "/api/davmail/reauth"


class _Store:
    def __init__(self):
        self.state: dict[str, str] = {}

    def set_state(self, key, value):
        self.state[key] = value


def _env(tmp_path: Path, *, backend: str = "davmail", mode: str = "O365Manual"):
    root = tmp_path / "davmail-poc"
    (root / "config").mkdir(parents=True)
    token_file = root / "token" / "token.dat"
    (root / "config" / "davmail.properties").write_text(
        f"davmail.mode={mode}\n"
        "davmail.oauth.clientId=client-xyz\n"
        f"davmail.oauth.tokenFilePath={token_file}\n",
        encoding="latin-1",
    )
    cfg = SimpleNamespace(
        mailagent_backend=backend,
        davmail_root=str(root),
        user_email=USER,
        davmail_cipher_key=CIPHER,
        davmail_poc_mode=False,
    )
    return cfg, token_file


@pytest.fixture()
def reauth_env(tmp_path, monkeypatch):
    cfg, token_file = _env(tmp_path)
    store = _Store()

    async def fake_exchange(settings, code):
        assert code == FAKE_CODE
        return FAKE_REFRESH

    monkeypatch.setattr(davmail_reauth, "exchange_code", fake_exchange)
    monkeypatch.setattr(davmail_reauth, "verify_login", lambda c: True)
    router_mod._sessions.clear()
    app.dependency_overrides[get_settings] = lambda: cfg
    app.dependency_overrides[router_mod.get_reauth_store] = lambda: store
    lines: list[str] = []
    sink_id = logger.add(lambda m: lines.append(str(m)), level="DEBUG")
    with TestClient(app, raise_server_exceptions=False) as client:
        yield SimpleNamespace(client=client, cfg=cfg, store=store, token_file=token_file, logs=lines)
    logger.remove(sink_id)
    app.dependency_overrides.pop(get_settings, None)
    app.dependency_overrides.pop(router_mod.get_reauth_store, None)
    router_mod._sessions.clear()


def _data(resp):
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def _start(client):
    return _data(client.post(f"{_BASE}/start"))


def test_start_returns_session_and_authorize_url(reauth_env):
    before = time.time()
    data = _start(reauth_env.client)
    assert set(data) == {"session_id", "authorize_url", "expires_at"}
    assert data["authorize_url"].startswith(
        "https://login.microsoftonline.com/common/oauth2/authorize?client_id=client-xyz&"
    )
    assert "login_hint=owner%40example.com" in data["authorize_url"]
    assert before + 590 <= data["expires_at"] <= time.time() + 600


def test_complete_success_writes_token_and_invalidates_session(reauth_env):
    sid = _start(reauth_env.client)["session_id"]
    resp = reauth_env.client.post(
        f"{_BASE}/complete",
        json={"session_id": sid, "callback": f"urn:ietf:wg:oauth:2.0:oob?code={FAKE_CODE}\n"},
    )
    assert _data(resp) == {
        "ok": True, "stage": "done", "code": "OK", "message": "已恢复，邮件同步会自动继续。"
    }
    assert decrypt_token(read_token_value(reauth_env.token_file, USER), CIPHER) == FAKE_REFRESH
    assert AUTH_LAST_INTERACTIVE_AT_KEY in reauth_env.store.state

    again = _data(reauth_env.client.post(f"{_BASE}/complete", json={"session_id": sid, "callback": FAKE_CODE}))
    assert (again["ok"], again["stage"], again["code"]) == (False, "session", "E_SESSION_EXPIRED")

    joined = "\n".join(reauth_env.logs)
    assert FAKE_CODE not in joined and FAKE_REFRESH not in joined
    assert FAKE_CODE not in resp.text and FAKE_REFRESH not in resp.text


def test_complete_failure_keeps_session_for_retry(reauth_env, monkeypatch):
    async def expired(settings, code):
        raise davmail_reauth.ReauthError("exchange", "AADSTS70008", davmail_reauth.describe_aadsts("70008"))

    monkeypatch.setattr(davmail_reauth, "exchange_code", expired)
    sid = _start(reauth_env.client)["session_id"]
    resp = reauth_env.client.post(f"{_BASE}/complete", json={"session_id": sid, "callback": FAKE_CODE})
    data = _data(resp)
    assert (data["ok"], data["stage"], data["code"]) == (False, "exchange", "AADSTS70008")
    assert "过期" in data["message"]
    assert sid in router_mod._sessions
    assert not reauth_env.token_file.exists()
    assert FAKE_CODE not in "\n".join(reauth_env.logs)


def test_complete_expired_session(reauth_env):
    sid = _start(reauth_env.client)["session_id"]
    router_mod._sessions[sid] = replace(router_mod._sessions[sid], expires_at=time.time() - 1)
    data = _data(reauth_env.client.post(f"{_BASE}/complete", json={"session_id": sid, "callback": FAKE_CODE}))
    assert (data["ok"], data["stage"], data["code"]) == (False, "session", "E_SESSION_EXPIRED")
    assert sid not in router_mod._sessions


def test_complete_unknown_session(reauth_env):
    data = _data(reauth_env.client.post(f"{_BASE}/complete", json={"session_id": "nope", "callback": FAKE_CODE}))
    assert (data["ok"], data["code"]) == (False, "E_SESSION_EXPIRED")


@pytest.mark.parametrize(
    "body",
    [{}, {"session_id": "", "callback": "x"}, {"session_id": "s", "callback": 1}],
)
def test_complete_rejects_bad_body(reauth_env, body):
    resp = reauth_env.client.post(f"{_BASE}/complete", json=body)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_non_davmail_backend_is_409(tmp_path):
    cfg, _ = _env(tmp_path, backend="applescript")
    app.dependency_overrides[get_settings] = lambda: cfg
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            r1 = client.post(f"{_BASE}/start")
            r2 = client.post(f"{_BASE}/complete", json={"session_id": "s", "callback": FAKE_CODE})
    finally:
        app.dependency_overrides.pop(get_settings, None)
    assert r1.status_code == 409 and r2.status_code == 409
    assert r1.json()["error"]["code"] == "E_INVALID_STATE"


def test_start_graph_mode_is_409(tmp_path):
    cfg, _ = _env(tmp_path, mode="O365Graph")
    app.dependency_overrides[get_settings] = lambda: cfg
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            resp = client.post(f"{_BASE}/start")
    finally:
        app.dependency_overrides.pop(get_settings, None)
    assert resp.status_code == 409
    assert "Graph" in resp.json()["error"]["message"]
