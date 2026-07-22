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


# ── notion_agent 直调闸（codex HIGH-2）────────────────────────────────────────
# ① ToolDef confirmation_tier=edit → 无 confirm 的直调被 confirm 闸拒（403）。
# ④ enabled 闸（仅 notion_agent）→ skill 未启用（default off，无覆盖行）→ 409，直调面尊重
#    Settings→Custom AI→Skills 开关，外部 scoped key 不能绕过它触达这个外呼第三方 AI 工具。
# 都在 dispatch 之前拒 → 绝不真跑 notion-agent subprocess。


def test_notion_agent_invoke_disabled_returns_409(fresh_agent_cfg, skill_client):
    """skill 未启用（默认）→ 409 E_SKILL_DISABLED（即便带 confirm=true，enabled 闸在 confirm 闸之前）。"""
    r = skill_client.post(
        "/api/skills/invoke",
        json={
            "skill": "notion_agent",
            "tool": "notion_agent_chat",
            "input": {"prompt": "更新本周日程"},
            "confirm": True,
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "E_SKILL_DISABLED"


def test_notion_agent_invoke_enabled_requires_confirm(fresh_agent_cfg, skill_client):
    """skill 启用后，edit-tier confirm 闸仍拦无 confirm 的直调 → 403（不进 dispatch，不跑 CLI）。"""
    fresh_agent_cfg.set_enabled("notion_agent", True)
    r = skill_client.post(
        "/api/skills/invoke",
        json={
            "skill": "notion_agent",
            "tool": "notion_agent_chat",
            "input": {"prompt": "更新本周日程"},  # 无 confirm
        },
    )
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_notion_agent_invoke_enabled_bad_confirm_type_rejected(fresh_agent_cfg, skill_client):
    """启用后，confirm 非布尔（字符串 "true"）→ router 400（confirm 必须是 JSON boolean）。"""
    fresh_agent_cfg.set_enabled("notion_agent", True)
    r = skill_client.post(
        "/api/skills/invoke",
        json={
            "skill": "notion_agent",
            "tool": "notion_agent_chat",
            "input": {"prompt": "x"},
            "confirm": "true",
        },
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def _patch_notion_handler(monkeypatch, spy):
    """把 registry 里 notion_agent_chat 的 handler 换成 spy（BoundTool 是 lru_cache 单例，
    monkeypatch.setattr 用后自动还原）。返回 spy 便于断言 call 次数。"""
    from src.skills.registry import find_tool

    found = find_tool("notion_agent", "notion_agent_chat")
    assert found is not None
    _skill, tool = found
    monkeypatch.setattr(tool, "handler", spy)
    return spy


# ── notion_agent kill-switch（codex R2 HIGH：MAILAGENT_NOTION_AGENT_TOOL 覆盖直调链）────────────
# gateway 侧该 flag 显式 false = 不注册 notion_agent_chat 工具；但直调 /api/skills/invoke 此前不读
# 它 → 持 scope 的外部 key 带 confirm=true 仍能跑。invoke 门里补齐同一 kill-switch，且判在 enabled
# 闸之前（全局杀 > per-skill 启用）。


def test_notion_agent_invoke_kill_switch_rejects(fresh_agent_cfg, skill_client, monkeypatch):
    """flag 显式 false（应急杀）+ skill enabled + confirm=true → 仍拒（409）且 handler 未被调用。"""
    fresh_agent_cfg.set_enabled("notion_agent", True)

    import src.skills.invoke as invoke_mod

    monkeypatch.setattr(invoke_mod, "_notion_agent_tool_killed", lambda: True)

    calls = {"n": 0}

    def _spy(ctx, params):
        calls["n"] += 1
        return {"final_content": "should not run", "thread_id": None}

    _patch_notion_handler(monkeypatch, _spy)

    r = skill_client.post(
        "/api/skills/invoke",
        json={
            "skill": "notion_agent",
            "tool": "notion_agent_chat",
            "input": {"prompt": "更新本周日程"},
            "confirm": True,
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "E_SKILL_DISABLED"
    assert "MAILAGENT_NOTION_AGENT_TOOL" in r.json()["error"]["message"]
    assert calls["n"] == 0  # 拒在 dispatch 之前 → handler 从未跑


def test_notion_agent_invoke_all_gates_open_dispatches(fresh_agent_cfg, skill_client, monkeypatch):
    """门全开（kill-switch off + enabled + confirm=true）→ handler 真被调用、返回值透传进 envelope。"""
    fresh_agent_cfg.set_enabled("notion_agent", True)

    import src.skills.invoke as invoke_mod

    monkeypatch.setattr(invoke_mod, "_notion_agent_tool_killed", lambda: False)

    calls = {"n": 0, "prompt": None, "confirm": None}

    def _spy(ctx, params):
        calls["n"] += 1
        calls["prompt"] = params.get("prompt")
        calls["confirm"] = ctx.confirm  # invoke 把 confirm 归一成严格布尔透传给 handler
        return {"final_content": "本周日程已更新", "thread_id": "thr-42"}

    _patch_notion_handler(monkeypatch, _spy)

    r = skill_client.post(
        "/api/skills/invoke",
        json={
            "skill": "notion_agent",
            "tool": "notion_agent_chat",
            "input": {"prompt": "更新本周日程"},
            "confirm": True,
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data == {"final_content": "本周日程已更新", "thread_id": "thr-42"}  # 返回值原样透传
    assert calls["n"] == 1
    assert calls["prompt"] == "更新本周日程"
    assert calls["confirm"] is True


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


