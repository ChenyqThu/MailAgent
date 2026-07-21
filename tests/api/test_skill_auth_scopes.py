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


def test_confirm_must_be_json_boolean_not_truthy(skill_client, api_key_store, monkeypatch):
    """codex blocker 回归：confirm 必须是 JSON 布尔；字符串 "false"/"true" 不得击穿确认闸。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, ["email:write"])
    for bad in ("false", "true", 1, 0):
        r = skill_client.post(
            "/api/skills/invoke",
            json={"skill": "email", "tool": "email_send", "input": {"internalId": 1}, "confirm": bad},
            headers=headers,
        )
        # 非布尔 confirm → 400（router 拒），绝不当作已确认放行发信。
        assert r.status_code == 400, f"confirm={bad!r} should be rejected, got {r.status_code}"
        assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_drafter_key_cannot_send_and_never_sees_send_tool(
    skill_client, api_key_store, monkeypatch
):
    """issue #50 端到端：draft-only key 拿不到发信能力（manifest 不投影 + 直调 403）。"""
    from src.security.api_keys import DRAFTER_SCOPES

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, list(DRAFTER_SCOPES))

    m = skill_client.get("/api/skills", headers=headers)
    assert m.status_code == 200
    names = {t["name"] for s in m.json()["data"]["skills"] for t in s["tools"]}
    assert "email_draft" in names
    assert "email_send" not in names

    r = skill_client.post(
        "/api/skills/invoke",
        json={
            "skill": "email", "tool": "email_send",
            "input": {"internalId": 1, "mode": "reply-all"}, "confirm": True,
        },
        headers=headers,
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_drafter_key_draft_without_confirm_403(skill_client, api_key_store, monkeypatch):
    """草稿同样 fail closed：无 JSON 布尔 confirm:true → 403，service 永不被调。"""
    from src.security.api_keys import DRAFTER_SCOPES

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, list(DRAFTER_SCOPES))
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "email", "tool": "email_draft", "input": {"mode": "new"}},
        headers=headers,
    )
    assert r.status_code == 403
    assert "confirm" in (r.json()["error"].get("hint", "") + r.json()["error"]["message"]).lower()


def test_drafter_key_can_create_draft(skill_client, api_key_store, monkeypatch):
    """有 email:draft + confirm=true → 走到 service（compose_draft 被真调），返回 200。"""
    import src.services.mail_write as mw
    from src.security.api_keys import DRAFTER_SCOPES

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    def _fake_compose(self, request, *, actor):
        assert actor.authenticated is True
        return mw.ComposeDraftResult(
            internal_id=request.internal_id, drafts_folder="Drafts", appended_uid=7,
            method="imap", mode=request.mode, to_count=1, cc_count=0, attachments=0,
            warnings=[],
        )

    monkeypatch.setattr(mw.MailWriteService, "__init__", lambda self, ctx: None)
    monkeypatch.setattr(mw.MailWriteService, "compose_draft", _fake_compose)
    monkeypatch.setattr(
        "src.skills.context.SkillContext.service_ctx", lambda self: None
    )

    headers, rec = _bearer(api_key_store, list(DRAFTER_SCOPES))
    r = skill_client.post(
        "/api/skills/invoke",
        json={
            "skill": "email", "tool": "email_draft",
            "input": {"mode": "new", "to": ["a@b.test"], "subject": "hi", "bodyText": "yo"},
            "confirm": True,
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["appended_uid"] == 7
    assert data["internal_id"] is None  # mode=new 不外泄哨兵 -1

    # API key 审计行为不变：agent 调用照常记一行 ok。
    audit = api_key_store.list_audit(key_id=rec.id)
    assert audit and audit[0]["tool"] == "email_draft" and audit[0]["status"] == "ok"


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
