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


# ── notion_agent kill-switch 真 helper 表驱动（codex R3 HIGH split-brain / MEDIUM 覆盖）─────
# 上面的 *_kill_switch_rejects / *_all_gates_open_dispatches 两测 monkeypatch 掉
# _notion_agent_tool_killed，只测门控接线；这一节测**真 helper**：两来源（os.environ / .env
# 兜底）× 值形态 × 优先级，断言与 gateway 的 envBool 逐字节同判。真值表与
# frontend/src/electron/main/lib/env-bool.ts + frontend/tests/main/env_bool.test.ts 交叉引用
# （同一张表，改一处必改三处），防跨端漂移。

import src.skills.invoke as _invoke_mod  # noqa: E402

_NA_KEY = "MAILAGENT_NOTION_AGENT_TOOL"

# (raw 值, envBool 判定 on?) —— 与 env_bool.test.ts 的 TABLE 逐条对齐。None = 键未定义/缺失。
# on=True → 工具放行（not killed）；on=False → killed。
_ENVBOOL_TABLE = [
    (None, True),  # unset → default(on)
    ("", True),  # 空串（未 trim）→ default(on)
    ("   ", False),  # 纯空白 → trim 成 "" → 非 1/true → off（与 "" 不对称）
    ("1", True),
    (" 1 ", True),  # trim
    ("true", True),
    ("TRUE", True),  # 大小写不敏感
    ("True", True),
    (" true ", True),  # trim
    ("0", False),
    ("false", False),
    ("FALSE", False),
    ("no", False),
    ("off", False),
    ("garbage", False),  # 任意其它非空值 → off
    ("yes", False),
    ("2", False),
]


@pytest.mark.parametrize("raw,on", _ENVBOOL_TABLE)
def test_gateway_envbool_on_mirrors_node_table(raw, on):
    """纯解析函数逐条镜像 gateway envBool(key, true)（含空串/纯空白/大小写/未定义每分支）。"""
    assert _invoke_mod._gateway_envbool_on(raw, True) is on


@pytest.mark.parametrize("raw,on", [(r, o) for (r, o) in _ENVBOOL_TABLE if r is not None])
def test_notion_agent_killed_from_os_environ(monkeypatch, raw, on):
    """来源①：os.environ 有键即用它（serve-api 继承 Electron bootstrap 后的 process.env）。

    键在 environ → 绝不读 .env → 判定 == gateway 对同一有效值的判定，killed == not on。
    """
    monkeypatch.setenv(_NA_KEY, raw)
    assert _invoke_mod._notion_agent_tool_killed() is (not on)


def test_notion_agent_killed_unset_both_sources(monkeypatch):
    """两来源都无该键 → raw=None → 默认 on → 不 killed（不误杀应急路径）。"""
    monkeypatch.delenv(_NA_KEY, raising=False)
    monkeypatch.setattr("src.api.deps.get_env_file_path", lambda: "/nonexistent/.env")
    assert _invoke_mod._notion_agent_tool_killed() is False


# .env 源值形态（未定义单独由 *_unset_both_sources 覆盖）。纯空白必须引号写（bare 会被
# dotenv strip 成空串），其余 bare 写 dotenv 逐字节保留（已实证）。
_DOTENV_TABLE = [
    ("", True, f"{_NA_KEY}=\n"),
    ("   ", False, f'{_NA_KEY}="   "\n'),
    ("1", True, f"{_NA_KEY}=1\n"),
    ("true", True, f"{_NA_KEY}=true\n"),
    ("TRUE", True, f"{_NA_KEY}=TRUE\n"),
    ("0", False, f"{_NA_KEY}=0\n"),
    ("false", False, f"{_NA_KEY}=false\n"),
    ("FALSE", False, f"{_NA_KEY}=FALSE\n"),
    ("no", False, f"{_NA_KEY}=no\n"),
    ("off", False, f"{_NA_KEY}=off\n"),
    ("garbage", False, f"{_NA_KEY}=garbage\n"),
]


@pytest.mark.parametrize("raw,on,content", _DOTENV_TABLE)
def test_notion_agent_killed_from_dotenv_fallback(monkeypatch, tmp_path, raw, on, content):
    """来源②：os.environ 无该键 → 热读 dotenv_values(.env) 兜底（standalone serve-api / pytest，
    进程未 load_dotenv 时键不在 environ）。killed == not on，与 os.environ 源同判。"""
    monkeypatch.delenv(_NA_KEY, raising=False)
    env_path = tmp_path / ".env"
    env_path.write_text(content, encoding="utf-8")
    monkeypatch.setattr("src.api.deps.get_env_file_path", lambda: str(env_path))
    assert _invoke_mod._notion_agent_tool_killed() is (not on)


@pytest.mark.parametrize(
    "env_val,dotenv_val,expected_killed",
    [
        ("true", "false", False),  # environ on 覆盖 .env off → 不 killed
        ("false", "true", True),  # environ off 覆盖 .env on → killed
        ("garbage", "true", True),  # 🔴 environ garbage(off) 覆盖 .env on → killed（本 issue split-brain 病根场景）
        ("", "false", False),  # environ 空串(default on) 在 environ → 不再读 .env off
    ],
)
def test_notion_agent_os_environ_overrides_dotenv(
    monkeypatch, tmp_path, env_val, dotenv_val, expected_killed
):
    """优先级：os.environ 有键即用它、不读 .env（镜像 dotenv-bootstrap override:false = OS 优先）。"""
    monkeypatch.setenv(_NA_KEY, env_val)
    env_path = tmp_path / ".env"
    env_path.write_text(f"{_NA_KEY}={dotenv_val}\n", encoding="utf-8")
    monkeypatch.setattr("src.api.deps.get_env_file_path", lambda: str(env_path))
    assert _invoke_mod._notion_agent_tool_killed() is expected_killed


