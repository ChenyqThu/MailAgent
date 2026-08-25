"""``POST /api/approval/preview`` —— 审批卡 preview 的服务端出口（L4 批次 1 #6）。

端点只做形状校验 + 线程池调度，派生逻辑的行为闸在
``tests/services/test_approval_preview.py``。这里钉端点契约：

- 命中派生器 → ``data.preview`` 是服务端事实串；
- 无派生器 / input 形状不对 → **200 + ``preview: null``**（不是 4xx）：调用方
  gateway 只有「拿到就用、拿不到就回落」一条分支，端点不该逼它多写错误分支；
- 响应形状恒 ``{toolName, preview}``（gateway 按这两个键读）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import src.api.auth as auth_mod
from src.api.app import app
from src.api.deps import get_service_ctx, get_settings
from src.mail.sync_store import SyncStore

LOCAL_TOK = "ephemeral-secret-approval-preview"
CF_HEADERS = {"Cf-Access-Jwt-Assertion": "header.payload.sig"}
LOCAL_HEADERS = {auth_mod.LOCAL_TOKEN_HEADER: LOCAL_TOK}


@pytest.fixture()
def preview_client(tmp_path: Path) -> Iterator[tuple[TestClient, SyncStore]]:
    db = str(tmp_path / "sync_store.db")
    store = SyncStore(db)

    class _Cfg:
        sync_store_db_path = db
        user_email = "me@x.com"

    ctx = MagicMock()
    ctx.sync_store = store
    ctx.config = _Cfg()

    app.dependency_overrides[get_settings] = lambda: _Cfg()
    app.dependency_overrides[get_service_ctx] = lambda: ctx
    client = TestClient(app, raise_server_exceptions=False)
    with client:
        yield client, store
    app.dependency_overrides.pop(get_settings, None)
    app.dependency_overrides.pop(get_service_ctx, None)


def _post(client: TestClient, body: dict):
    return client.post("/api/approval/preview", json=body)


def test_preview_returns_server_derived_recipients(preview_client):
    client, store = preview_client
    store.save_email(
        {
            "internal_id": 11,
            "message_id": "orig-11@x",
            "subject": "预算",
            "sender": "boss@x.com",
            "to_addr": "me@x.com, peer@y.com",
            "mailbox": "收件箱",
            "date_received": "2026-08-01T10:00:00+00:00",
        }
    )

    r = _post(
        client,
        {
            "toolName": "email_draft_reply",
            "input": {"internal_id": 11, "body_markdown": "好的"},
        },
    )

    assert r.status_code == 200
    data = r.json()["data"]
    assert data["toolName"] == "email_draft_reply"
    assert "boss@x.com" in data["preview"]
    assert "peer@y.com" in data["preview"]


def test_unknown_tool_returns_null_preview_not_error(preview_client):
    client, _ = preview_client
    r = _post(client, {"toolName": "web_fetch", "input": {"url": "https://x"}})
    assert r.status_code == 200
    assert r.json()["data"] == {"toolName": "web_fetch", "preview": None}


@pytest.mark.parametrize(
    "body",
    [
        {"toolName": "email_draft_reply", "input": "not-an-object"},
        {"toolName": "email_draft_reply"},  # input 缺席
        {},  # 全缺
    ],
)
def test_bad_shapes_degrade_to_null_preview(preview_client, body):
    client, _ = preview_client
    r = _post(client, body)
    assert r.status_code == 200
    assert r.json()["data"]["preview"] is None


def test_missing_email_row_degrades_to_null_preview(preview_client):
    client, _ = preview_client
    r = _post(
        client,
        {
            "toolName": "email_draft_reply",
            "input": {"internal_id": 424242, "body_markdown": "x"},
        },
    )
    assert r.status_code == 200
    assert r.json()["data"]["preview"] is None


# ── 鉴权档（verify_local_token，不接受 CF JWT）─────────────────────────────────────
#
# 这道闸的价值不在「今天写对了」，在于**将来别被放宽**：本端点按任意 internal_id /
# ical_uid 摊开库内事实（真实收件人、日程现值），换成 verify_cf_access 就等于给远程
# CF 会话开了一个探测口子。范式抄 tests/api/test_exec_auth.py。


def _arm_cf_jwt(monkeypatch):
    """装配一个**有效** CF Access 会话 —— 用来证明本端点照样拒。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    class _Key:
        key = "irrelevant"

    monkeypatch.setattr(auth_mod._jwk_client, "get_signing_key_from_jwt", lambda _t: _Key())
    monkeypatch.setattr(auth_mod.jwt, "decode", lambda *a, **k: {"email": "owner@example.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@example.com"})


def test_rejects_cf_jwt_only(preview_client, monkeypatch):
    client, _ = preview_client
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    r = client.post(
        "/api/approval/preview",
        json={"toolName": "web_fetch", "input": {}},
        headers=CF_HEADERS,
    )
    assert r.status_code == 403


def test_accepts_local_token(preview_client, monkeypatch):
    client, _ = preview_client
    _arm_cf_jwt(monkeypatch)  # CF 也就绪，但这条腿根本不看 CF JWT
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    r = client.post(
        "/api/approval/preview",
        json={"toolName": "web_fetch", "input": {}},
        headers=LOCAL_HEADERS,
    )
    assert r.status_code == 200
    assert r.json()["data"] == {"toolName": "web_fetch", "preview": None}
