"""POST /api/skills/invoke —— email_search / report_run / report_get 闭环。

DoD ③：invoke 调通 email_search、report_run（拿 report_id）、report_get（取详情）。
invoke 主路径不 fork 子进程调 CLI（E2-C 起 ``src/api/cli_runner.py`` 已整体退役，
这一属性现由模块不存在本身保证，不再需要运行时炸弹式反证测试）。
"""

from __future__ import annotations

import pytest

from tests.api.conftest import EMAIL_ID


def test_invoke_email_search(skill_client):
    """email_search 命中 conftest 播的 "redis timeout" 邮件。"""
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "search", "tool": "email_search", "input": {"q": "redis"}},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    ids = [it["internal_id"] for it in data["items"]]
    assert EMAIL_ID in ids
    assert data["total_matches"] >= 1
    assert "has_more" in data


def test_invoke_report_get(skill_client):
    """report_get 取到 conftest 播的 rep-1（含 doc + counts）。"""
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_get", "input": {"report_id": "rep-1"}},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["id"] == "rep-1"
    assert data["headline"] == "3 emails today"
    assert data["counts"] == {"total": 3}
    assert "doc" in data


def test_invoke_report_get_not_found(skill_client):
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_get", "input": {"report_id": "nope"}},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_invoke_report_run_then_get(skill_client, monkeypatch):
    """report_run（monkeypatch run_report_once）拿到 report_id → report_get 取详情。"""

    async def _fake_run(*, store, db_path, agent, **kwargs):
        rid = "rep-generated"
        store.create_report(
            report_id=rid,
            agent_id=agent["id"],
            cadence="daily",
            report_date="2026-06-02",
            window_start="2026-06-02T00:00:00Z",
            window_end="2026-06-03T00:00:00Z",
        )
        store.finish_report(
            rid, status="ready", headline="generated digest", blocks_json='{"blocks": []}',
            counts_json='{"total": 1}',
        )
        return rid

    monkeypatch.setattr("src.reports.worker.run_report_once", _fake_run)

    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_run", "input": {"agent_id": "daily"}},
    )
    assert r.status_code == 200, r.text
    run_data = r.json()["data"]
    rid = run_data["report_id"]
    assert rid == "rep-generated"
    assert run_data["status"] == "ready"

    r2 = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_get", "input": {"report_id": rid}},
    )
    assert r2.status_code == 200
    assert r2.json()["data"]["headline"] == "generated digest"


def test_invoke_unknown_tool_404(skill_client):
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "search", "tool": "nope", "input": {}},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_invoke_missing_required_arg_400(skill_client):
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "search", "tool": "email_search", "input": {}},
    )
    assert r.status_code in (400, 422)
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


@pytest.mark.asyncio
async def test_email_send_threads_confirm_to_service(monkeypatch):
    """MEDIUM-1 防御纵深：handler 把真实 confirm 透传给 service（非硬编码 True）。"""
    import src.services.mail_write as mw
    from src.skills.context import SkillContext
    from src.skills.invoke import invoke_skill

    captured: dict = {}

    class _FakeResult:
        internal_id = 1
        mode = "reply-all"
        message_id = "mid"
        archived_to_sent = False
        method = "smtp"

    def _fake_send(self, req, *, actor, confirmed):
        captured["confirmed"] = confirmed
        return _FakeResult()

    monkeypatch.setattr(mw.MailWriteService, "__init__", lambda self, ctx: None)
    monkeypatch.setattr(mw.MailWriteService, "send", _fake_send)

    ctx = SkillContext()
    monkeypatch.setattr(ctx, "service_ctx", lambda: None)  # 避免构造真 ServiceContext

    # owner principal(None)→scope 通过；confirm=True→edit gate 通过 → 透传 confirmed=True。
    res = await invoke_skill(
        None, "email", "email_send", {"internalId": 1, "mode": "reply-all"}, confirm=True, ctx=ctx
    )
    assert captured["confirmed"] is True
    assert res["sent"] is True


@pytest.mark.asyncio
async def test_confirm_gate_requires_strict_true(monkeypatch):
    """codex blocker 回归（invoke chokepoint）：edit gate 用严格 `is True`，非布尔真值不算确认。

    覆盖非 router 路径（MCP/in-process）：即便上游传了 "true"/1 等真值，invoke 层仍拒。
    """
    import src.api.agent_auth as aa
    from src.skills.context import SkillContext
    from src.skills.errors import SkillError
    from src.skills.invoke import invoke_skill

    principal = aa.Principal(kind="agent", auth_method="bearer", scopes=frozenset({"email:write"}))
    ctx = SkillContext()
    monkeypatch.setattr(ctx, "service_ctx", lambda: None)

    for truthy in ("true", "false", 1, "yes"):
        with pytest.raises(SkillError) as ei:
            await invoke_skill(
                principal, "email", "email_send",
                {"internalId": 1, "mode": "reply-all"}, confirm=truthy, ctx=ctx,
            )
        assert ei.value.http_status == 403, f"confirm={truthy!r} must NOT confirm"
        assert "confirm" in (ei.value.hint or ei.value.message).lower()


