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
    assert "mailagent_search_email_search" in names
    assert "mailagent_report_report_run" in names
    assert "mailagent_report_report_get" in names
    assert "mailagent_email_email_get" in names
    # mcp_exposed=False → 不暴露
    assert "mailagent_email_email_send" not in names
    assert "mailagent_notion_agent_notion_agent_chat" not in names
    # 每个 tool 有 inputSchema
    for t in r["result"]["tools"]:
        assert t["inputSchema"]["type"] == "object"


@pytest.mark.asyncio
async def test_tools_call_search(mcp_ctx):
    r = await handle_request(
        {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "mailagent_search_email_search", "arguments": {"q": "redis"}},
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
            "params": {"name": "mailagent_report_report_get", "arguments": {"report_id": "rep-1"}},
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
    r = await handle_request(
        {
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": {"name": "mailagent_report_report_run", "arguments": {"agent_id": "daily"}},
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
            "params": {"name": "mailagent_search_email_search", "arguments": {}},
        },
        LocalSkillClient(ctx=mcp_ctx),
    )
    assert r["result"]["isError"] is True
