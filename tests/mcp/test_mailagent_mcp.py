"""MCP stdio wrapper —— JSON-RPC dispatch + manifest→MCP tools + in-process call。

DoD ④：tools/list + call search + call report_run/get（in-process LocalSkillClient）。
"""

from __future__ import annotations

import json

import pytest

from src.mcp.mailagent_mcp import LocalSkillClient, handle_request


@pytest.mark.asyncio
async def test_initialize():
    r = await handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, LocalSkillClient())
    assert r["result"]["protocolVersion"]
    assert "tools" in r["result"]["capabilities"]
    assert r["result"]["serverInfo"]["name"] == "mailagent"


@pytest.mark.asyncio
async def test_tools_list_only_exposes_mcp_tools():
    r = await handle_request(
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, LocalSkillClient()
    )
    names = {t["name"] for t in r["result"]["tools"]}
    # mcp_exposed=True
    assert "mailagent_email_search" in names
    assert "mailagent_report_run" in names
    assert "mailagent_report_get" in names
    assert "mailagent_email_get" in names
    # mcp_exposed=False → 不暴露
    assert "mailagent_email_send" not in names
    assert "mailagent_notion_agent_chat" not in names
    # 每个 tool 有 inputSchema
    for t in r["result"]["tools"]:
        assert t["inputSchema"]["type"] == "object"


@pytest.mark.asyncio
async def test_tools_call_search(mcp_ctx):
    r = await handle_request(
        {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "mailagent_email_search", "arguments": {"q": "redis"}},
        },
        LocalSkillClient(ctx=mcp_ctx),
    )
    assert not r["result"].get("isError")
    data = json.loads(r["result"]["content"][0]["text"])
    assert any(it["internal_id"] == 1001 for it in data["items"])


@pytest.mark.asyncio
async def test_tools_call_report_get(mcp_ctx):
    r = await handle_request(
        {
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {"name": "mailagent_report_get", "arguments": {"report_id": "rep-1"}},
        },
        LocalSkillClient(ctx=mcp_ctx),
    )
    assert not r["result"].get("isError")
    data = json.loads(r["result"]["content"][0]["text"])
    assert data["id"] == "rep-1"


@pytest.mark.asyncio
async def test_tools_call_report_run(mcp_ctx, monkeypatch):
    async def _fake(*, store, db_path, agent, **kwargs):
        store.create_report(
            report_id="rep-9", agent_id=agent["id"], cadence="daily", report_date="2026-06-02",
            window_start="a", window_end="b",
        )
        store.finish_report("rep-9", status="ready", headline="gen")
        return "rep-9"

    monkeypatch.setattr("src.reports.worker.run_report_once", _fake)
    # P0 审计（invoke.py confirmation gate 收窄）：report_run 是 preview tier，MCP 面与 REST 共用
    # 同一 chokepoint —— 无 confirm 必须被拒。本测试原先无 confirm 且断言成功，正是把漏洞固化成
    # 期望行为的第三条（tests/api 两条已同批改正）。
    r_no_confirm = await handle_request(
        {
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {"name": "mailagent_report_run", "arguments": {"agent_id": "daily"}},
        },
        LocalSkillClient(ctx=mcp_ctx),
    )
    assert r_no_confirm["result"].get("isError"), r_no_confirm["result"]
    assert "confirmation_tier=preview" in r_no_confirm["result"]["content"][0]["text"]

    r = await handle_request(
        {
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": {
                "name": "mailagent_report_run",
                "arguments": {"agent_id": "daily", "confirm": True},
            },
        },
        LocalSkillClient(ctx=mcp_ctx),
    )
    assert not r["result"].get("isError"), r["result"]
    data = json.loads(r["result"]["content"][0]["text"])
    assert data["report_id"] == "rep-9"


@pytest.mark.asyncio
async def test_tools_call_unknown_tool():
    r = await handle_request(
        {
            "jsonrpc": "2.0", "id": 6, "method": "tools/call",
            "params": {"name": "mailagent_nope", "arguments": {}},
        },
        LocalSkillClient(),
    )
    assert "error" in r and r["error"]["code"] == -32602


@pytest.mark.asyncio
async def test_notification_no_response():
    r = await handle_request(
        {"jsonrpc": "2.0", "method": "notifications/initialized"}, LocalSkillClient()
    )
    assert r is None


@pytest.mark.asyncio
async def test_scope_denied_surfaces_as_iserror(mcp_ctx):
    """invoke 层 SkillError（如缺必填）→ MCP isError 文本，不崩 server。"""
    r = await handle_request(
        {
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": {"name": "mailagent_email_search", "arguments": {}},
        },
        LocalSkillClient(ctx=mcp_ctx),
    )
    assert r["result"]["isError"] is True


# ── 10-27 规范化：title / annotations / 短名 / ping / 真实版本号 ──────────────────


@pytest.mark.asyncio
async def test_initialize_reports_real_version_and_list_changed_false():
    from src.skills.registry import _server_version

    r = await handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, LocalSkillClient())
    assert r["result"]["serverInfo"]["version"] == _server_version()
    assert r["result"]["capabilities"] == {"tools": {"listChanged": False}}


@pytest.mark.asyncio
async def test_ping_returns_empty_result():
    r = await handle_request({"jsonrpc": "2.0", "id": 9, "method": "ping"}, LocalSkillClient())
    assert r == {"jsonrpc": "2.0", "id": 9, "result": {}}


@pytest.mark.parametrize(
    "side_effect, expected",
    [
        ("read", (True, False, True, False)),
        ("write", (False, False, False, False)),
        ("external_call", (False, False, False, True)),
        ("send", (False, True, False, True)),
    ],
)
def test_annotations_derived_from_side_effect(side_effect, expected):
    from src.mcp.mailagent_mcp import tool_annotations

    ann = tool_annotations("T", side_effect)
    assert ann == {
        "title": "T",
        "readOnlyHint": expected[0],
        "destructiveHint": expected[1],
        "idempotentHint": expected[2],
        "openWorldHint": expected[3],
    }


@pytest.mark.asyncio
async def test_tools_list_carries_title_and_annotations():
    r = await handle_request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, LocalSkillClient())
    tools = {t["name"]: t for t in r["result"]["tools"]}
    for t in tools.values():
        assert set(t) == {"name", "title", "description", "inputSchema", "annotations"}
        assert t["title"] and t["annotations"]["title"] == t["title"]
        assert set(t["annotations"]) == {
            "title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint",
        }
    assert tools["mailagent_email_search"]["annotations"]["readOnlyHint"] is True
    assert tools["mailagent_email_search"]["title"] == "Search Emails"
    for name in ("mailagent_email_draft", "mailagent_report_run", "mailagent_custom_agent_run_now"):
        assert tools[name]["annotations"]["readOnlyHint"] is False, name
    for name in ("mailagent_report_run", "mailagent_custom_agent_run_now"):
        assert tools[name]["annotations"]["openWorldHint"] is True, name


@pytest.mark.asyncio
async def test_old_skill_prefixed_name_is_unknown(mcp_ctx):
    r = await handle_request(
        {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "mailagent_search_email_search", "arguments": {"q": "redis"}},
        },
        LocalSkillClient(ctx=mcp_ctx),
    )
    assert r["error"]["code"] == -32602


def _manifest(*skills):
    def tool(name, side_effect="read", title=None, exposed=True):
        return {
            "name": name, "title": title, "description": "d", "input_schema": {"type": "object"},
            "side_effect": side_effect, "mcp_exposed": exposed,
        }

    return {"skills": [{"name": s, "tools": [tool(*t) for t in ts]} for s, ts in skills]}


def test_colliding_tool_names_fall_back_to_skill_prefix():
    from src.mcp.mailagent_mcp import _split_tool_name, manifest_to_mcp_tools

    manifest = _manifest(
        ("search", [("email_search",), ("attachment_search",)]),
        ("my_pack", [("email_search",)]),
    )
    tools = manifest_to_mcp_tools(manifest)
    names = [t["name"] for t in tools]
    assert names == [
        "mailagent_search_email_search",
        "mailagent_attachment_search",
        "mailagent_my_pack_email_search",
    ]
    assert _split_tool_name("mailagent_my_pack_email_search", tools) == ("my_pack", "email_search")
    assert _split_tool_name("mailagent_email_search", tools) is None


def test_title_falls_back_to_tool_name_and_unexposed_tools_dropped():
    from src.mcp.mailagent_mcp import manifest_to_mcp_tools

    manifest = _manifest(("pack", [("plain_tool",), ("hidden", "write", "Hidden", False)]))
    tools = manifest_to_mcp_tools(manifest)
    assert [t["name"] for t in tools] == ["mailagent_plain_tool"]
    assert tools[0]["title"] == "plain_tool"
    assert tools[0]["annotations"]["title"] == "plain_tool"
