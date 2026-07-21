"""email_draft —— scope 拆分（issue #50）+ confirm fail-closed + MCP 投影 + 配额闸。

覆盖 issue #50 的安全属性（draft-only key 能建草稿、看不见也调不动 email_send），以及本次
新增的两个坑位回归：
  - MCP inputSchema 必须含 ``confirm``（否则投出去的写工具恒 403，MCP 客户端填不上）。
  - ``mode='new'`` 不得把服务层哨兵 ``-1`` 泄进对外契约。

这些都不需要 HTTP 栈 —— 直接打 registry / invoke / MCP 投影（transport-neutral 真源）。
HTTP 端到端（Bearer key → 403）在 ``tests/api/test_skill_auth_scopes.py``。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import pytest

import src.services.mail_write as mw
from src.mcp.mailagent_mcp import manifest_to_mcp_tools
from src.security.api_keys import (
    DRAFTER_SCOPES,
    KNOWN_SCOPES,
    WRITER_SCOPES,
    validate_scopes,
)
from src.skills import rate_limit
from src.skills.context import SkillContext
from src.skills.errors import SkillError
from src.skills.invoke import invoke_skill
from src.skills.registry import build_manifest


@dataclass(frozen=True)
class Principal:
    """``src.api.agent_auth.Principal`` 的最小替身（同 has_scopes 语义）。

    不 import 真 Principal：那条 import 链会拉进 ``src.api.auth`` 的 import-time env 断言，
    而本文件测的是 transport-neutral 的 skills 层。真 Principal 的端到端在 tests/api。
    """

    key_id: str
    scopes: frozenset
    kind: str = "agent"
    auth_method: str = "bearer"

    @property
    def is_agent(self) -> bool:
        return self.kind == "agent"

    def has_scopes(self, required: Iterable[str]) -> bool:
        return all(s in self.scopes for s in required)


DRAFTER = Principal(key_id="k-draft", scopes=frozenset(DRAFTER_SCOPES))
READER = Principal(key_id="k-read", scopes=frozenset({"email:read"}))


@pytest.fixture(autouse=True)
def _clean_rate_limit():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def fake_compose(monkeypatch):
    """把 MailWriteService.compose_draft 换成记录参数的替身（不碰真 IMAP / DB）。"""
    captured: dict = {}

    def _fake(self, request, *, actor):
        captured["request"] = request
        captured["actor"] = actor
        return mw.ComposeDraftResult(
            internal_id=request.internal_id,
            drafts_folder="Drafts",
            appended_uid=42,
            method="imap",
            mode=request.mode,
            to_count=1,
            cc_count=0,
            attachments=0,
            warnings=[],
        )

    monkeypatch.setattr(mw.MailWriteService, "__init__", lambda self, ctx: None)
    monkeypatch.setattr(mw.MailWriteService, "compose_draft", _fake)
    return captured


def _ctx(monkeypatch) -> SkillContext:
    ctx = SkillContext()
    monkeypatch.setattr(ctx, "service_ctx", lambda: None)  # 不构造真 ServiceContext
    return ctx


def _email_tools(principal) -> dict:
    m = build_manifest(principal, generated_at="x")
    email = next((s for s in m.skills if s.name == "email"), None)
    return {t.name: t for t in (email.tools if email else [])}


# --- scope catalog / preset -------------------------------------------------


def test_email_draft_scope_is_grantable():
    assert "email:draft" in KNOWN_SCOPES
    assert validate_scopes(DRAFTER_SCOPES) == tuple(sorted(DRAFTER_SCOPES))
    assert validate_scopes(WRITER_SCOPES) == tuple(sorted(WRITER_SCOPES))


def test_drafter_preset_excludes_send_scope():
    """起草 preset 不得夹带 email:write —— 「安全 by construction」的前提。"""
    assert "email:write" not in DRAFTER_SCOPES
    assert "email:draft" in DRAFTER_SCOPES
    # write 预设显式带上 draft（has_scopes 不做蕴含 → 在 preset 层兜住）。
    assert {"email:draft", "email:write"} <= set(WRITER_SCOPES)


def test_cli_presets_all_valid():
    from src.cli.commands.api_key import _PRESETS

    assert set(_PRESETS) == {"readonly", "handoff", "drafter", "writer"}
    for name, scopes in _PRESETS.items():
        validate_scopes(scopes)  # 非法 scope 会 ValueError


# --- manifest 过滤 ----------------------------------------------------------


def test_drafter_manifest_shows_draft_hides_send():
    tools = _email_tools(DRAFTER)
    assert "email_draft" in tools
    assert "email_send" not in tools
    assert "email_get" in tools  # 读工具照常


def test_readonly_manifest_hides_draft():
    tools = _email_tools(READER)
    assert "email_draft" not in tools and "email_send" not in tools


def test_draft_tool_contract():
    tool = _email_tools(None)["email_draft"]
    assert tool.auth_scopes == ["email:draft"]
    assert tool.confirmation_tier == "edit"
    assert tool.side_effect == "write"
    assert tool.mcp_exposed is True
    assert tool.handler.target == "MailWriteService.compose_draft"
    # 配额闸只声明在 email_draft 上（其余 tool 行为零变化）。
    assert tool.rate_limit == {"limit": 20, "per_seconds": 3600, "scope": "principal"}
    others = [
        t.name
        for s in build_manifest(None, generated_at="x").skills
        for t in s.tools
        if t.rate_limit is not None
    ]
    assert others == ["email_draft"]


def test_send_tool_unchanged():
    send = _email_tools(None)["email_send"]
    assert send.auth_scopes == ["email:write"]
    assert send.mcp_exposed is False
    assert send.side_effect == "send"


# --- MCP 投影 ---------------------------------------------------------------


def test_mcp_projection_exposes_draft_with_confirm_field():
    """🔴 回归：MCP 桥是 args.pop("confirm") —— schema 里没有 confirm，客户端永远填不上 → 恒 403。"""
    tools = {t["name"]: t for t in manifest_to_mcp_tools(build_manifest(DRAFTER, generated_at="x"))}
    assert "mailagent_email_email_draft" in tools
    assert "mailagent_email_email_send" not in tools
    schema = tools["mailagent_email_email_draft"]["inputSchema"]
    assert schema["properties"]["confirm"]["type"] == "boolean"
    # confirm 不能进 required：REST 走 body 顶层、MCP 已被 pop 走 → 两条路 params 里都没有它。
    assert "confirm" not in schema.get("required", [])
    assert "internalId" not in schema.get("required", [])  # mode=new 可省略


def test_mcp_projection_never_exposes_send_even_for_owner():
    names = {t["name"] for t in manifest_to_mcp_tools(build_manifest(None, generated_at="x"))}
    assert "mailagent_email_email_send" not in names


@pytest.mark.asyncio
async def test_mcp_local_client_roundtrip_creates_draft(monkeypatch, fake_compose):
    """MCP 客户端形态（confirm 在 arguments 里，被桥 pop）能真正调通，不是恒 403。"""
    from src.mcp.mailagent_mcp import LocalSkillClient

    client = LocalSkillClient(ctx=_ctx(monkeypatch))
    res = await client.call_tool(
        "email", "email_draft", {"mode": "new", "to": ["a@b.test"], "confirm": True}
    )
    assert res["appended_uid"] == 42
    assert fake_compose["request"].mode == "new"


# --- confirm fail-closed ----------------------------------------------------


@pytest.mark.asyncio
async def test_draft_without_confirm_fails_closed(monkeypatch, fake_compose):
    with pytest.raises(SkillError) as ei:
        await invoke_skill(DRAFTER, "email", "email_draft", {"mode": "new"}, ctx=_ctx(monkeypatch))
    assert ei.value.http_status == 403
    assert "request" not in fake_compose  # service 从未被调到


@pytest.mark.asyncio
async def test_draft_confirm_must_be_strict_json_true(monkeypatch, fake_compose):
    """truthy 字符串 / 数字不得击穿确认闸（invoke 层 `is not True` 严格身份判定）。"""
    for truthy in ("true", "false", 1, "yes", 0, None):
        with pytest.raises(SkillError) as ei:
            await invoke_skill(
                DRAFTER, "email", "email_draft", {"mode": "new"},
                confirm=truthy, ctx=_ctx(monkeypatch),
            )
        assert ei.value.http_status == 403, f"confirm={truthy!r} must NOT confirm"
    assert "request" not in fake_compose


def test_draft_handler_rechecks_confirm(monkeypatch, fake_compose):
    """防御纵深：即便旁路 invoke gate 直调 handler，ctx.confirm 不是 True 也拒。"""
    from src.skills.builtin.email import _email_draft

    ctx = _ctx(monkeypatch)
    ctx.confirm = False
    with pytest.raises(SkillError) as ei:
        _email_draft(ctx, {"mode": "new"})
    assert ei.value.code == "E_AUTH_FAILED"
    assert "request" not in fake_compose


# --- scope 隔离 -------------------------------------------------------------


@pytest.mark.asyncio
async def test_drafter_key_cannot_send(monkeypatch, fake_compose):
    with pytest.raises(SkillError) as ei:
        await invoke_skill(
            DRAFTER, "email", "email_send", {"internalId": 1, "mode": "reply-all"},
            confirm=True, ctx=_ctx(monkeypatch),
        )
    assert ei.value.code == "E_AUTH_FAILED"
    assert ei.value.http_status == 403


# --- mode=new / 哨兵不外泄 --------------------------------------------------


@pytest.mark.asyncio
async def test_mode_new_without_internal_id(monkeypatch, fake_compose):
    res = await invoke_skill(
        DRAFTER, "email", "email_draft",
        {"mode": "new", "to": ["a@b.test"], "subject": "hi", "bodyText": "yo"},
        confirm=True, ctx=_ctx(monkeypatch),
    )
    # 服务层拿到哨兵 -1（内部约定）……
    assert fake_compose["request"].internal_id == -1
    assert fake_compose["request"].to == "a@b.test"
    # ……但对外契约里不出现它。
    assert res["internal_id"] is None
    assert res["mode"] == "new" and res["drafts_folder"] == "Drafts"


@pytest.mark.asyncio
async def test_reply_mode_still_requires_internal_id(monkeypatch, fake_compose):
    with pytest.raises(SkillError) as ei:
        await invoke_skill(
            DRAFTER, "email", "email_draft", {"mode": "reply-all"},
            confirm=True, ctx=_ctx(monkeypatch),
        )
    assert ei.value.code == "E_INVALID_ARG"


@pytest.mark.asyncio
async def test_email_send_internal_id_still_required(monkeypatch, fake_compose):
    """_compose_request 放宽 internalId 不得影响 email_send（schema 仍 required）。"""
    owner = None  # owner principal → scope 全通过
    with pytest.raises(SkillError) as ei:
        await invoke_skill(
            owner, "email", "email_send", {"mode": "new"}, confirm=True, ctx=_ctx(monkeypatch)
        )
    assert ei.value.code == "E_INVALID_ARG"


# --- 配额闸 -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_draft_rate_limit(monkeypatch, fake_compose):
    ctx = _ctx(monkeypatch)
    for i in range(20):
        await invoke_skill(
            DRAFTER, "email", "email_draft", {"mode": "new"}, confirm=True, ctx=ctx
        )
    with pytest.raises(SkillError) as ei:
        await invoke_skill(
            DRAFTER, "email", "email_draft", {"mode": "new"}, confirm=True, ctx=ctx
        )
    assert ei.value.code == "E_RATE_LIMITED"
    assert ei.value.http_status == 429


@pytest.mark.asyncio
async def test_rate_limit_is_per_principal(monkeypatch, fake_compose):
    """一个跑飞的 key 不得把别的 key 一起饿死。"""
    other = Principal(key_id="k-other", scopes=frozenset(DRAFTER_SCOPES))
    ctx = _ctx(monkeypatch)
    for _ in range(20):
        await invoke_skill(DRAFTER, "email", "email_draft", {"mode": "new"}, confirm=True, ctx=ctx)
    res = await invoke_skill(other, "email", "email_draft", {"mode": "new"}, confirm=True, ctx=ctx)
    assert res["appended_uid"] == 42


@pytest.mark.asyncio
async def test_rejected_calls_do_not_consume_quota(monkeypatch, fake_compose):
    """配额在校验闸之后判定：形状错 / 未确认的调用不吃额度。"""
    ctx = _ctx(monkeypatch)
    for _ in range(30):
        with pytest.raises(SkillError):
            await invoke_skill(DRAFTER, "email", "email_draft", {"mode": "new"}, ctx=ctx)
    res = await invoke_skill(DRAFTER, "email", "email_draft", {"mode": "new"}, confirm=True, ctx=ctx)
    assert res["appended_uid"] == 42


@pytest.mark.asyncio
async def test_bad_mode_does_not_consume_quota(monkeypatch, fake_compose):
    """codex 复现：``mode='bogus'`` 过得了 _validate_input（只查 required），改前会**先扣额度**
    再在 handler 里 E_INVALID_ARG —— 连打 20 次拼错的 mode 就把一把合法 key 锁死一小时。"""
    ctx = _ctx(monkeypatch)
    for _ in range(20):
        with pytest.raises(SkillError) as ei:
            await invoke_skill(
                DRAFTER, "email", "email_draft", {"mode": "bogus"}, confirm=True, ctx=ctx
            )
        assert ei.value.code == "E_INVALID_ARG"
    res = await invoke_skill(DRAFTER, "email", "email_draft", {"mode": "new"}, confirm=True, ctx=ctx)
    assert res["appended_uid"] == 42


@pytest.mark.asyncio
async def test_backend_failure_does_not_consume_quota(monkeypatch, fake_compose):
    """没有草稿落库的失败（service 连不上等）同样不该吃额度。"""
    ctx = _ctx(monkeypatch)
    stubbed = mw.MailWriteService.compose_draft  # fake_compose 装好的替身
    failing = {"on": True}

    def _maybe_boom(self, request, *, actor):
        if failing["on"]:
            raise RuntimeError("imap down")
        return stubbed(self, request, actor=actor)

    monkeypatch.setattr(mw.MailWriteService, "compose_draft", _maybe_boom)
    for _ in range(20):
        with pytest.raises(RuntimeError):
            await invoke_skill(
                DRAFTER, "email", "email_draft", {"mode": "new"}, confirm=True, ctx=ctx
            )
    failing["on"] = False
    res = await invoke_skill(DRAFTER, "email", "email_draft", {"mode": "new"}, confirm=True, ctx=ctx)
    assert res["appended_uid"] == 42


def test_rate_limit_window_slides():
    """滑窗到期后放行（注入 now，不睡）。"""
    spec = {"limit": 2, "per_seconds": 60}
    p = Principal(key_id="k-window", scopes=frozenset())
    for stamp in (1000.0, 1001.0):
        rate_limit.check(p, "email", "email_draft", spec, now=stamp)
        rate_limit.record(p, "email", "email_draft", spec, now=stamp)
    with pytest.raises(SkillError):
        rate_limit.check(p, "email", "email_draft", spec, now=1002.0)
    rate_limit.check(p, "email", "email_draft", spec, now=1062.0)  # 首次调用已出窗


def test_rate_limit_check_does_not_count():
    """check 是纯判定 —— 只 check 不 record，额度永不消耗。"""
    spec = {"limit": 2, "per_seconds": 60}
    p = Principal(key_id="k-checkonly", scopes=frozenset())
    for _ in range(50):
        rate_limit.check(p, "email", "email_draft", spec, now=1000.0)


def test_rate_limit_noop_without_spec():
    p = Principal(key_id="k-none", scopes=frozenset())
    for _ in range(100):
        rate_limit.check(p, "email", "email_get", None)
        rate_limit.record(p, "email", "email_get", None)
        rate_limit.check(p, "email", "email_get", {"limit": "bogus"})
        rate_limit.record(p, "email", "email_get", {"limit": "bogus"})
