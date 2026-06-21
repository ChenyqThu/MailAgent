"""scoped Bearer key —— store 单元 + 第四腿鉴权 fail-closed + audit + CF/local 不回归。

DoD ⑤：无/坏/revoked key→401/403；last_used/audit 记录；CF/local 既有路径不回归。
"""

from __future__ import annotations

import time

import pytest

import src.api.auth as auth_mod
from src.security.api_keys import ApiKeyStore


# ---------------------------------------------------------------------------
# Store 单元
# ---------------------------------------------------------------------------
def test_store_create_verify_revoke_rotate(tmp_path):
    st = ApiKeyStore(str(tmp_path / "a.db"))
    rec, plain = st.create_key("k", scopes=["email:read"])
    assert plain.startswith("mak_")
    assert st.verify(plain).id == rec.id
    assert st.verify("mak_bogus") is None
    # revoke → fail-closed
    assert st.revoke(rec.id) is True
    assert st.verify(plain) is None
    assert st.revoke(rec.id) is False  # 幂等
    # rotate → 旧明文失效，新明文有效
    rec2, p2 = st.create_key("k2")
    new_plain = st.rotate(rec2.id)
    assert new_plain and new_plain != p2
    assert st.verify(p2) is None
    assert st.verify(new_plain).id == rec2.id
    assert st.rotate("no-such-id") is None


def test_store_rotate_refuses_revoked_key(tmp_path):
    """撤销是终态：rotate 不复活已撤销 key（返回 None）。"""
    st = ApiKeyStore(str(tmp_path / "rot.db"))
    rec, _ = st.create_key("r", scopes=["email:read"])
    assert st.revoke(rec.id) is True
    assert st.rotate(rec.id) is None
    assert st.get_key(rec.id).revoked_at is not None  # 仍为撤销态


def test_store_expired_key_fails_closed(tmp_path):
    st = ApiKeyStore(str(tmp_path / "b.db"))
    rec, plain = st.create_key("exp", expires_at=int(time.time()) - 10)
    assert st.verify(plain) is None  # 已过期


def test_store_default_scopes_are_readonly(tmp_path):
    st = ApiKeyStore(str(tmp_path / "c.db"))
    rec, _ = st.create_key("def")
    assert "email:write" not in rec.scopes
    assert "report:run" not in rec.scopes
    assert "email:read" in rec.scopes


def test_store_rejects_unknown_scope(tmp_path):
    st = ApiKeyStore(str(tmp_path / "d.db"))
    with pytest.raises(ValueError):
        st.create_key("bad", scopes=["bogus:scope"])


# ---------------------------------------------------------------------------
# 第四腿鉴权（bearer）via /api/skills —— fail-closed
# ---------------------------------------------------------------------------
def test_no_credentials_401(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = skill_client.get("/api/skills")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_bad_bearer_403(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = skill_client.get("/api/skills", headers={"Authorization": "Bearer mak_bogus"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_valid_bearer_lists_and_records_use(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    rec, plain = api_key_store.create_key("agent", scopes=["email:read"])
    r = skill_client.get("/api/skills", headers={"Authorization": f"Bearer {plain}"})
    assert r.status_code == 200
    assert api_key_store.get_key(rec.id).last_used_at is not None


def test_revoked_bearer_403(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    rec, plain = api_key_store.create_key("agent", scopes=["email:read"])
    api_key_store.revoke(rec.id)
    r = skill_client.get("/api/skills", headers={"Authorization": f"Bearer {plain}"})
    assert r.status_code == 403


def test_bearer_rejected_on_non_skills_route(skill_client, api_key_store, monkeypatch):
    """codex medium 回归：Bearer agent key **只在 /api/skills 生效**；非 skills 路由
    （用 verify_cf_access，不认 Bearer）→ 401 → 越权 by construction 不可达。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    _rec, plain = api_key_store.create_key("agent", scopes=["email:read"])
    hdr = {"Authorization": f"Bearer {plain}"}
    # 读路由（email/list 走 verify_cf_access）：Bearer 不被识别 → 401
    r = skill_client.get("/api/email/list?limit=1", headers=hdr)
    assert r.status_code == 401, r.text
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"
    # 写路由（email flag 批量）同样 401（无 CF JWT / 无 local token）
    r2 = skill_client.post("/api/email/flag", json={"ids": [1], "isRead": True}, headers=hdr)
    assert r2.status_code == 401


def test_audit_records_invoke(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    rec, plain = api_key_store.create_key("agent", scopes=["email:read"])
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "search", "tool": "email_search", "input": {"q": "redis"}},
        headers={"Authorization": f"Bearer {plain}"},
    )
    assert r.status_code == 200, r.text
    rows = api_key_store.list_audit(key_id=rec.id)
    assert len(rows) == 1
    assert rows[0]["status"] == "ok"
    assert rows[0]["skill"] == "search" and rows[0]["tool"] == "email_search"


def test_audit_records_scope_denied(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    rec, plain = api_key_store.create_key("agent", scopes=["email:read"])
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_run", "input": {"agent_id": "daily"}},
        headers={"Authorization": f"Bearer {plain}"},
    )
    assert r.status_code == 403
    rows = api_key_store.list_audit(key_id=rec.id)
    assert rows and rows[0]["status"] == "error" and rows[0]["error_code"] == "E_AUTH_FAILED"


# ---------------------------------------------------------------------------
# CF / local 既有路径不回归
# ---------------------------------------------------------------------------
def test_local_token_still_works_on_skills(skill_client, api_key_store, monkeypatch):
    """同机 local token 腿在 skills 路由仍放行（owner 全 scope，可见全部 tool）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "loc-secret")
    r = skill_client.get(
        "/api/skills", headers={auth_mod.LOCAL_TOKEN_HEADER: "loc-secret"}
    )
    assert r.status_code == 200
    # owner → 看得到 write tool（scopes=None → 全可见）
    names = {t["name"] for s in r.json()["data"]["skills"] for t in s["tools"]}
    assert "email_send" in names and "report_run" in names


def test_dev_bypass_still_works(skill_client):
    """默认 bypass on（AUTH_DISABLED=true）→ /api/skills 无凭据可读（dev）。"""
    r = skill_client.get("/api/skills")
    assert r.status_code == 200
