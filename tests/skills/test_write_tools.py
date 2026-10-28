"""对外写工具（10-27）：email_send 上 MCP + email_organize / calendar 写 / matter_write 共 11 个工具。

覆盖：
  - annotations 与设计表逐行一致（design.md §1，含 destructive / idempotent 覆盖字段）；
  - scope 过滤（看不到 + 直调 403）、confirm 闸（不带 confirm=true → 403 且不执行）、配额（超限 429
    且不执行）——全部走真实的 ``invoke_skill`` chokepoint；
  - 每个工具调到应用内同名操作的同一个 service 方法、同样的参数（邮件 / 日历用 spy，事项用真库）；
  - 操作人记成 ``mcp:<密钥名>``。
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

import pytest

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

import src.services.mail_write as mw  # noqa: E402
from src.api.agent_auth import Principal  # noqa: E402
from src.mail.sync_store import SyncStore  # noqa: E402
from src.mcp.mailagent_mcp import manifest_to_mcp_tools, tool_annotations  # noqa: E402
from src.security.api_keys import HANDOFF_SCOPES  # noqa: E402
from src.skills import rate_limit, registry  # noqa: E402
from src.skills.context import SkillContext  # noqa: E402
from src.skills.errors import SkillError  # noqa: E402
from src.skills.invoke import invoke_skill  # noqa: E402

# (skill, tool, scope, rate limit/h, 最小合法参数)
WRITE_TOOLS = [
    ("email", "email_send", "email:write", 10, {"mode": "reply-all", "internalId": 7}),
    ("email_organize", "email_flag", "email:organize", 60, {"internal_id": 7, "is_flagged": True}),
    ("email_organize", "email_pin", "email:organize", 60, {"internal_id": 7, "pinned": True}),
    ("email_organize", "email_archive", "email:organize", 60, {"internal_id": 7}),
    ("calendar", "calendar_event_rsvp", "calendar:write", 20, {"event_id": "uid-1", "response": "accept"}),
    (
        "calendar", "calendar_event_reschedule", "calendar:write", 20,
        {"event_id": "uid-1", "new_start": "2026-11-02T10:00:00+08:00", "new_end": "2026-11-02T11:00:00+08:00"},
    ),
    ("calendar", "calendar_event_delete", "calendar:write", 20, {"event_id": "uid-1"}),
    ("matter_write", "matter_create", "matters:write", 60, {"title": "Atlas"}),
    ("matter_write", "matter_add_note", "matters:write", 60, {"public_id": "MAT-0001", "text": "n", "expected_version": 1}),
    ("matter_write", "matter_item_add", "matters:write", 60, {"public_id": "MAT-0001", "title": "t", "expected_version": 1}),
    (
        "matter_write", "matter_item_update", "matters:write", 60,
        {"public_id": "MAT-0001", "item_id": 1, "status": "done", "expected_version": 1},
    ),
]
_TOOL_IDS = [f"{s}.{t}" for s, t, *_ in WRITE_TOOLS]

# design.md §1：(readOnly, destructive, idempotent, openWorld)
EXPECTED_ANNOTATIONS = {
    "email_send": (False, True, False, True),
    "email_flag": (False, False, True, False),
    "email_pin": (False, False, True, False),
    "email_archive": (False, False, True, False),
    "calendar_event_rsvp": (False, False, True, True),
    "calendar_event_reschedule": (False, False, True, True),
    "calendar_event_delete": (False, True, True, True),
    "matter_create": (False, False, False, False),
    "matter_add_note": (False, False, False, False),
    "matter_item_add": (False, False, False, False),
    "matter_item_update": (False, False, True, False),
}


def _agent(scopes, label="notion") -> Principal:
    return Principal(
        kind="agent", auth_method="bearer", key_id=f"k-{label}", label=label, scopes=frozenset(scopes)
    )


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.setattr(registry, "_load_installed_skills", lambda builtins: [])
    rate_limit.reset()
    yield
    rate_limit.reset()


def _bound(skill: str, tool: str):
    found = registry.find_tool(skill, tool)
    assert found is not None, f"{skill}.{tool} not registered"
    return found[1]


# ── annotations ─────────────────────────────────────────────────────────────


def test_annotations_match_design_table():
    tools = {t["_tool"]: t for t in manifest_to_mcp_tools(registry.build_manifest(None, generated_at="x"))}
    got = {
        name: tuple(
            tools[name]["annotations"][k]
            for k in ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint")
        )
        for name in EXPECTED_ANNOTATIONS
    }
    assert got == EXPECTED_ANNOTATIONS


def test_annotation_overrides_only_touch_destructive_and_idempotent():
    base = tool_annotations("T", "send")
    assert tool_annotations("T", "send", destructive=None, idempotent=None) == base
    flipped = tool_annotations("T", "send", destructive=False, idempotent=True)
    assert (flipped["destructiveHint"], flipped["idempotentHint"]) == (False, True)
    assert (flipped["readOnlyHint"], flipped["openWorldHint"]) == (base["readOnlyHint"], base["openWorldHint"])


def test_annotation_overrides_survive_http_manifest_dicts():
    """HttpSkillClient 从 /api/skills 的 JSON 投影：覆盖字段必须随 manifest 序列化出去。"""
    dumped = registry.build_manifest(None, generated_at="x").model_dump()
    tools = {t["_tool"]: t for t in manifest_to_mcp_tools(dumped)}
    assert tools["calendar_event_rsvp"]["annotations"]["destructiveHint"] is False
    assert tools["email_flag"]["annotations"]["idempotentHint"] is True


# ── scope / confirm / 配额（真实 invoke chokepoint，handler 换成计数替身）──────────────


@pytest.fixture()
def counting_handler(monkeypatch):
    calls: list[str] = []

    def install(skill: str, tool: str):
        bound = _bound(skill, tool)
        monkeypatch.setattr(bound, "handler", lambda ctx, params: calls.append(tool) or {"ok": True})
        return calls

    return install


@pytest.mark.parametrize("skill,tool,scope,limit,params", WRITE_TOOLS, ids=_TOOL_IDS)
def test_hidden_and_forbidden_without_scope(skill, tool, scope, limit, params, counting_handler):
    calls = counting_handler(skill, tool)
    handoff = _agent(HANDOFF_SCOPES)
    names = {t.name for s in registry.build_manifest(handoff, generated_at="x").skills for t in s.tools}
    assert tool not in names
    mcp_names = {t["_tool"] for t in manifest_to_mcp_tools(registry.build_manifest(handoff, generated_at="x"))}
    assert tool not in mcp_names
    with pytest.raises(SkillError) as ei:
        asyncio.run(invoke_skill(handoff, skill, tool, dict(params), confirm=True))
    assert (ei.value.code, ei.value.http_status) == ("E_AUTH_FAILED", 403)
    assert calls == []

    granted = _agent((*HANDOFF_SCOPES, scope))
    mcp_names = {t["_tool"] for t in manifest_to_mcp_tools(registry.build_manifest(granted, generated_at="x"))}
    assert tool in mcp_names


@pytest.mark.asyncio
@pytest.mark.parametrize("skill,tool,scope,limit,params", WRITE_TOOLS, ids=_TOOL_IDS)
async def test_confirm_required(skill, tool, scope, limit, params, counting_handler):
    calls = counting_handler(skill, tool)
    principal = _agent([scope])
    for confirm in (False, "true", 1):
        with pytest.raises(SkillError) as ei:
            await invoke_skill(principal, skill, tool, dict(params), confirm=confirm)
        assert (ei.value.code, ei.value.http_status) == ("E_AUTH_FAILED", 403)
    assert calls == []
    # MCP 桥 pop confirm：schema 必须声明它，否则客户端填不上
    schema = _bound(skill, tool).definition.input_schema
    assert schema["properties"]["confirm"]["type"] == "boolean"
    assert "confirm" not in schema.get("required", [])


@pytest.mark.asyncio
@pytest.mark.parametrize("skill,tool,scope,limit,params", WRITE_TOOLS, ids=_TOOL_IDS)
async def test_rate_limited_per_key(skill, tool, scope, limit, params, counting_handler):
    calls = counting_handler(skill, tool)
    principal = _agent([scope])
    for _ in range(limit):
        await invoke_skill(principal, skill, tool, dict(params), confirm=True)
    with pytest.raises(SkillError) as ei:
        await invoke_skill(principal, skill, tool, dict(params), confirm=True)
    assert (ei.value.code, ei.value.http_status) == ("E_RATE_LIMITED", 429)
    assert len(calls) == limit
    # 另一把 key 有自己的额度
    await invoke_skill(_agent([scope], label="other"), skill, tool, dict(params), confirm=True)
    assert len(calls) == limit + 1


# ── 邮件：同一个 MailWriteService 方法 ──────────────────────────────────────


def _ctx(**kw: Any) -> SkillContext:
    ctx = SkillContext(config=SimpleNamespace(sync_store_db_path=kw.pop("db", "/nonexistent")))
    ctx.service_ctx = lambda: "svc-ctx"  # type: ignore[method-assign]
    for k, v in kw.items():
        setattr(ctx, k, v)
    return ctx


@pytest.fixture()
def spy_mail(monkeypatch):
    calls: dict[str, Any] = {}

    def set_flags(self, ids, **kw):
        calls["set_flags"] = (self._ctx, ids, kw)
        return mw.FlagResult(updated_ids=list(ids), payload={"is_flagged": kw["is_flagged"]}, outbox_entries=[{"internal_id": ids[0]}], not_found=[])

    def set_pin(self, internal_id, **kw):
        calls["set_pin"] = (self._ctx, internal_id, kw)
        return mw.PinResult(internal_id=internal_id, is_pinned=kw["pinned"], changed=True)

    def archive(self, internal_id, **kw):
        calls["archive"] = (self._ctx, internal_id, kw)
        return mw.ArchiveResult(internal_id=internal_id, from_mailbox="收件箱", to_mailbox="存档", notion_updated=False, notion_error=None)

    def send(self, request, **kw):
        calls["send"] = (self._ctx, request, kw)
        return mw.ComposeSendResult(internal_id=request.internal_id, mode=request.mode, message_id="<m>", archived_to_sent=True, method="smtp", to_count=1, cc_count=0, attachments=0, warnings=[])

    for name, fn in (("set_flags", set_flags), ("set_pin", set_pin), ("archive", archive), ("send", send)):
        monkeypatch.setattr(mw.MailWriteService, name, fn)
    return calls


@pytest.mark.asyncio
async def test_email_flag_calls_set_flags(spy_mail):
    data = await invoke_skill(_agent(["email:organize"]), "email_organize", "email_flag",
                              {"internal_id": 7, "is_flagged": False}, confirm=True, ctx=_ctx())
    svc_ctx, ids, kw = spy_mail["set_flags"]
    assert svc_ctx == "svc-ctx" and ids == [7]
    assert kw["is_flagged"] is False and kw["allow_concurrent"] is True
    assert set(kw) == {"is_flagged", "actor", "allow_concurrent"}  # 不碰 is_read / processing_status
    assert kw["actor"].label == "mcp:notion" and kw["actor"].authenticated is True
    assert data["is_flagged"] is False and data["updated_ids"] == [7]


@pytest.mark.asyncio
async def test_email_flag_unknown_id_is_not_found(monkeypatch):
    monkeypatch.setattr(
        mw.MailWriteService, "set_flags",
        lambda self, ids, **kw: mw.FlagResult(updated_ids=[], payload={}, outbox_entries=[], not_found=list(ids)),
    )
    with pytest.raises(SkillError) as ei:
        await invoke_skill(_agent(["email:organize"]), "email_organize", "email_flag",
                           {"internal_id": 9, "is_flagged": True}, confirm=True, ctx=_ctx())
    assert (ei.value.code, ei.value.http_status) == ("E_NOT_FOUND", 404)


@pytest.mark.asyncio
async def test_email_pin_and_archive_call_service(spy_mail):
    p = _agent(["email:organize"], label="ops")
    await invoke_skill(p, "email_organize", "email_pin", {"internal_id": 3, "pinned": True}, confirm=True, ctx=_ctx())
    _, iid, kw = spy_mail["set_pin"]
    assert iid == 3 and kw["pinned"] is True and kw["actor"].label == "mcp:ops"
    data = await invoke_skill(p, "email_organize", "email_archive", {"internal_id": 3}, confirm=True, ctx=_ctx())
    _, iid, kw = spy_mail["archive"]
    assert iid == 3 and kw["actor"].label == "mcp:ops"
    assert data["archived"] is True and data["to_mailbox"] == "存档"


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", [{"internal_id": "7", "is_flagged": True}, {"internal_id": 7, "is_flagged": "yes"}])
async def test_email_flag_rejects_bad_types(spy_mail, bad):
    with pytest.raises(SkillError) as ei:
        await invoke_skill(_agent(["email:organize"]), "email_organize", "email_flag", bad, confirm=True, ctx=_ctx())
    assert ei.value.code == "E_INVALID_ARG"
    assert "set_flags" not in spy_mail


@pytest.mark.asyncio
async def test_email_send_over_mcp_calls_send(spy_mail):
    from src.mcp.mailagent_mcp import PrincipalSkillClient, handle_request

    client = PrincipalSkillClient(_agent(["email:write"]), _ctx())
    r = await handle_request(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "mailagent_email_send",
            "arguments": {"mode": "new", "to": ["a@b.test"], "subject": "s", "bodyText": "hi", "confirm": True},
        }},
        client,
    )
    assert "isError" not in r["result"], r
    _, request, kw = spy_mail["send"]
    assert request.mode == "new" and kw["confirmed"] is True
    assert kw["actor"].label == "mcp:notion"


# ── 日历：同一个 CalendarService 方法，只透传时间 ───────────────────────────


class _FakeCalendar:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def send_rsvp(self, **kw):
        self.calls.append(("send_rsvp", kw))
        return {"action": "rsvp", "ical_uid": kw["ical_uid"], "recurrence_id": kw["recurrence_id"],
                "source": "caldav", "response_status": kw["response_status"], "to_email": "org@x.test"}

    def update_event(self, **kw):
        self.calls.append(("update_event", kw))
        return {"calendar_name": "Calendar"}

    def update_occurrence(self, **kw):
        self.calls.append(("update_occurrence", kw))
        return {"calendar_name": "Calendar"}

    def delete_event(self, **kw):
        self.calls.append(("delete_event", kw))
        return {"action": "deleted", "ical_uid": kw["ical_uid"], "calendar_name": "Calendar"}


@pytest.fixture()
def cal():
    fake = _FakeCalendar()
    return fake, _ctx(calendar_service=lambda: fake)


_CAL = _agent(["calendar:write"])


@pytest.mark.asyncio
async def test_rsvp_calls_send_rsvp(cal, caplog):
    fake, ctx = cal
    with caplog.at_level(logging.INFO, logger="mailagent.api.calendar"):
        await invoke_skill(_CAL, "calendar", "calendar_event_rsvp",
                           {"event_id": "uid-1", "response": "tentative", "recurrence_id": "2026-10-23T16:30:00+08:00"},
                           confirm=True, ctx=ctx)
    assert fake.calls == [("send_rsvp", {
        "ical_uid": "uid-1", "response_status": "TENTATIVE",
        "recurrence_id": "2026-10-23T16:30:00+08:00", "source": None, "dry_run": False,
    })]
    assert "[calendar-write] action=rsvp actor=mcp:notion" in caplog.text


@pytest.mark.asyncio
async def test_reschedule_series_passes_only_times(cal):
    fake, ctx = cal
    data = await invoke_skill(_CAL, "calendar", "calendar_event_reschedule",
                              {"event_id": "uid-1", "new_start": "2026-11-02T10:00:00+08:00",
                               "new_end": "2026-11-02T03:00:00Z"}, confirm=True, ctx=ctx)
    assert fake.calls == [("update_event", {
        "ical_uid": "uid-1",
        "dtstart_utc": datetime(2026, 11, 2, 2, 0, tzinfo=timezone.utc),
        "dtend_utc": datetime(2026, 11, 2, 3, 0, tzinfo=timezone.utc),
    })]
    assert data["rescheduled"] is True


@pytest.mark.asyncio
async def test_reschedule_occurrence_branch(cal):
    fake, ctx = cal
    await invoke_skill(_CAL, "calendar", "calendar_event_reschedule",
                       {"event_id": "uid-1", "new_start": "2026-11-02T10:00:00+08:00",
                        "new_end": "2026-11-02T11:00:00+08:00", "recurrence_id": "2026-10-23T16:30:00+08:00"},
                       confirm=True, ctx=ctx)
    name, kw = fake.calls[0]
    assert name == "update_occurrence"
    assert kw["recurrence_id_utc"] == datetime(2026, 10, 23, 8, 30, tzinfo=timezone.utc)
    assert set(kw) == {"ical_uid", "recurrence_id_utc", "dtstart_utc", "dtend_utc"}


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("new_start", "2026-11-02T10:00:00"), ("new_end", "tomorrow")])
async def test_reschedule_rejects_naive_or_bad_time(cal, field, value):
    fake, ctx = cal
    params = {"event_id": "uid-1", "new_start": "2026-11-02T10:00:00+08:00", "new_end": "2026-11-02T11:00:00+08:00"}
    params[field] = value
    with pytest.raises(SkillError) as ei:
        await invoke_skill(_CAL, "calendar", "calendar_event_reschedule", params, confirm=True, ctx=ctx)
    assert (ei.value.code, ei.value.http_status) == ("E_INVALID_ARG", 400)
    assert fake.calls == []


@pytest.mark.asyncio
async def test_delete_calls_delete_event_and_maps_not_found(cal, monkeypatch):
    fake, ctx = cal
    await invoke_skill(_CAL, "calendar", "calendar_event_delete",
                       {"event_id": "uid-1", "calendar_name": "Work"}, confirm=True, ctx=ctx)
    assert fake.calls == [("delete_event", {"ical_uid": "uid-1", "calendar_name": "Work"})]

    def missing(**kw):
        raise ValueError("event uid-x not found")

    monkeypatch.setattr(fake, "delete_event", missing)
    with pytest.raises(SkillError) as ei:
        await invoke_skill(_CAL, "calendar", "calendar_event_delete", {"event_id": "uid-x"}, confirm=True, ctx=ctx)
    assert ei.value.code == "E_NOT_FOUND"


# ── 事项：真库，落到同一张 matter_event 表 ────────────────────────────────────


@pytest.fixture()
def matter_ctx(tmp_path):
    path = str(tmp_path / "sync.db")
    SyncStore(path)
    return path, _ctx(db=path)


def _events(path: str) -> list[sqlite3.Row]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            "SELECT kind, actor_kind, actor_id, source FROM matter_event ORDER BY id"
        ).fetchall()
    finally:
        conn.close()


@pytest.mark.asyncio
async def test_matter_write_end_to_end_records_mcp_actor(matter_ctx):
    path, ctx = matter_ctx
    p = _agent(["matters:write"], label="notion-agent")
    created = await invoke_skill(p, "matter_write", "matter_create",
                                 {"title": "Atlas rollout", "goal": "ship"}, confirm=True, ctx=ctx)
    matter = created["matter"]
    assert matter["title"] == "Atlas rollout" and matter["goal"] == "ship"
    assert "matter_instructions" not in matter and "schedule_json" not in matter
    public_id, version = matter["public_id"], matter["version"]

    note = await invoke_skill(p, "matter_write", "matter_add_note",
                              {"public_id": public_id, "text": "kickoff done", "expected_version": version},
                              confirm=True, ctx=ctx)
    assert note["item"]["kind"] == "note" and note["item"]["description"] == "kickoff done"

    added = await invoke_skill(p, "matter_write", "matter_item_add",
                               {"public_id": public_id, "title": "book venue", "due_at": 1_800_000_000_000,
                                "expected_version": note["matter"]["version"]}, confirm=True, ctx=ctx)
    item = added["item"]
    assert (item["kind"], item["status"], item["due_at"]) == ("action", "open", 1_800_000_000_000)
    assert (item["created_by_kind"], item["created_by_id"]) == ("agent", "mcp:notion-agent")

    updated = await invoke_skill(p, "matter_write", "matter_item_update",
                                 {"public_id": public_id, "item_id": item["id"], "status": "done",
                                  "expected_version": added["matter"]["version"]}, confirm=True, ctx=ctx)
    assert updated["item"]["status"] == "done" and updated["item"]["title"] == "book venue"

    rows = _events(path)
    assert [r["kind"] for r in rows] == ["matter_created", "item_created", "item_created", "item_updated"]
    assert {(r["actor_kind"], r["actor_id"], r["source"]) for r in rows} == {
        ("agent", "mcp:notion-agent", "mcp")
    }


@pytest.mark.asyncio
async def test_matter_methods_are_the_service_methods(matter_ctx, monkeypatch):
    """每个工具调到的就是应用内同名操作的那一个 MatterService 方法。"""
    from src.matters.service import MatterService

    _, ctx = matter_ctx
    seen: list[str] = []
    for name in ("create_matter", "add_note", "create_item", "update_item"):
        def fake(self, *a, _name=name, **kw):
            seen.append(_name)
            assert kw["source"] == "mcp" and kw["actor"].actor_id == "mcp:notion"
            return {"matter": {"public_id": "MAT-0001", "version": 2}, "item": {"id": 1}}

        monkeypatch.setattr(MatterService, name, fake)
    p = _agent(["matters:write"])
    for skill, tool, _scope, _limit, params in WRITE_TOOLS:
        if skill == "matter_write":
            await invoke_skill(p, skill, tool, dict(params), confirm=True, ctx=ctx)
    assert seen == ["create_matter", "add_note", "create_item", "update_item"]


@pytest.mark.asyncio
async def test_matter_idempotency_key_dedupes(matter_ctx):
    path, ctx = matter_ctx
    p = _agent(["matters:write"])
    a = await invoke_skill(p, "matter_write", "matter_create", {"title": "X", "idempotency_key": "k1"}, confirm=True, ctx=ctx)
    b = await invoke_skill(p, "matter_write", "matter_create", {"title": "X", "idempotency_key": "k1"}, confirm=True, ctx=ctx)
    assert a["matter"]["public_id"] == b["matter"]["public_id"]
    assert len(_events(path)) == 1
    # 幂等键按操作人隔离：另一把密钥用同一个键是一次新的写入，不重放别人的结果。
    c = await invoke_skill(_agent(["matters:write"], label="other"), "matter_write", "matter_create",
                           {"title": "Y", "idempotency_key": "k1"}, confirm=True, ctx=ctx)
    assert c["matter"]["public_id"] != a["matter"]["public_id"]
    assert len(_events(path)) == 2


@pytest.mark.asyncio
async def test_matter_item_update_needs_a_field_and_unknown_matter_404(matter_ctx):
    _, ctx = matter_ctx
    p = _agent(["matters:write"])
    with pytest.raises(SkillError) as ei:
        await invoke_skill(p, "matter_write", "matter_item_update",
                           {"public_id": "MAT-0001", "item_id": 1, "expected_version": 1}, confirm=True, ctx=ctx)
    assert ei.value.code == "E_INVALID_ARG"
    with pytest.raises(SkillError) as ei:
        await invoke_skill(p, "matter_write", "matter_add_note",
                           {"public_id": "MAT-9999", "text": "x", "expected_version": 1}, confirm=True, ctx=ctx)
    assert (ei.value.code, ei.value.http_status) == ("E_NOT_FOUND", 404)


def test_owner_actor_label():
    from src.skills.builtin._common import mcp_actor_label

    owner = Principal(kind="human", auth_method="local")
    assert mcp_actor_label(SimpleNamespace(principal=owner)) == "mcp:owner"
    assert mcp_actor_label(SimpleNamespace(principal=None)) == "mcp:owner"
    assert mcp_actor_label(SimpleNamespace(principal=_agent([], label="x"))) == "mcp:x"
