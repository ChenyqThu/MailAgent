"""scope 强制 —— read-only key 不能 invoke write/execute tool（DoD ⑤）。

bearer 腿要求 AUTH_DISABLED=False（默认 bypass on）→ 各测试 monkeypatch 关 bypass。
api_key_store fixture 把 agent_auth + skills router 用的 store 指向临时 DB。
"""

from __future__ import annotations


import src.api.auth as auth_mod


def _bearer(store, scopes):
    rec, plaintext = store.create_key("t", scopes=scopes)
    return {"Authorization": f"Bearer {plaintext}"}, rec


def test_readonly_key_cannot_run_report(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, ["email:read", "report:read"])
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_run", "input": {"agent_id": "daily"}},
        headers=headers,
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_readonly_key_cannot_send_email(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, ["email:read"])
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "email", "tool": "email_send", "input": {"internalId": 1}},
        headers=headers,
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_readonly_key_manifest_excludes_write_tools(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, ["email:read", "report:read"])
    r = skill_client.get("/api/skills", headers=headers)
    assert r.status_code == 200
    names = {t["name"] for s in r.json()["data"]["skills"] for t in s["tools"]}
    assert "email_send" not in names
    assert "report_run" not in names
    assert "email_search" in names and "report_get" in names


def test_email_write_key_requires_confirmation(skill_client, api_key_store, monkeypatch):
    """有 email:write 但 confirm 缺失 → 403（发信/草稿永远 edit confirmation）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, ["email:write"])
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "email", "tool": "email_send", "input": {"internalId": 1}},
        headers=headers,
    )
    assert r.status_code == 403
    assert "confirm" in (r.json()["error"].get("hint", "") + r.json()["error"]["message"]).lower()


def test_handoff_key_can_run_report(skill_client, api_key_store, monkeypatch):
    """有 report:run 的 handoff key → report_run 不被 scope 拦（→ 200）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    async def _fake_run(*, store, db_path, agent, **kwargs):
        rid = "rep-x"
        store.create_report(
            report_id=rid, agent_id=agent["id"], cadence="daily", report_date="2026-06-02",
            window_start="a", window_end="b",
        )
        store.finish_report(rid, status="ready", headline="ok")
        return rid

    monkeypatch.setattr("src.reports.worker.run_report_once", _fake_run)
    headers, _ = _bearer(api_key_store, ["report:read", "report:run"])
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_run", "input": {"agent_id": "daily"}},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["report_id"] == "rep-x"
