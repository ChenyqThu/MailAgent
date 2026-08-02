"""GET /api/skills manifest v1 —— 结构 + 字段完整性 + 工具清单 snapshot。

DoD ②：tool 含 name/input_schema/output_schema/auth_scopes/confirmation_tier/
side_effect/handler/mcp_exposed，并通过 snapshot（锁工具清单不漂移）。
"""

from __future__ import annotations

from src.skills.registry import build_manifest

# 工具清单 snapshot（稳定真源；新增/改 tool 必须同步更新此表 → 防意外漂移）。
EXPECTED_TOOLS = {
    "email": {
        "email_get": ("read", "none", ["email:read"], True),
        "email_body": ("read", "none", ["email:read"], True),
        "email_thread": ("read", "none", ["email:read"], True),
        "email_draft": ("write", "edit", ["email:draft"], True),
        "email_send": ("send", "edit", ["email:write"], False),
    },
    "search": {
        "email_search": ("read", "none", ["email:read"], True),
        "attachment_search": ("read", "none", ["attachment:read"], True),
    },
    "report": {
        "report_list": ("read", "none", ["report:read"], True),
        "report_get": ("read", "none", ["report:read"], True),
        "report_run": ("external_call", "preview", ["report:run"], True),
    },
    "calendar": {
        "calendar_events": ("read", "none", ["calendar:read"], True),
        "calendar_event_get": ("read", "none", ["calendar:read"], True),
    },
    "notion_agent": {
        # 07-21 (codex HIGH-2) — edit tier (was preview): the invoke chokepoint now requires an
        # explicit boolean confirm=true, so a direct /api/skills/invoke of this external-AI /
        # irreversible-write tool can't skip confirmation. side_effect stays external_call.
        "notion_agent_chat": ("external_call", "edit", ["notion_agent:invoke"], False),
    },
    # Configuration/workflow-only builtin. The six CRUD tools live in the gateway and remain
    # manual-chat-only capability changes rather than manifest invocation tools.
    "custom_agent": {},
}


def test_manifest_snapshot_owner():
    """principal=None（owner 视角）→ 全部 skill/tool 可见，清单与 snapshot 逐字段一致。"""
    m = build_manifest(None, generated_at="2026-06-21T00:00:00+00:00")
    assert m.manifest_version == "1.0"
    got = {
        s.name: {
            t.name: (t.side_effect, t.confirmation_tier, t.auth_scopes, t.mcp_exposed)
            for t in s.tools
        }
        for s in m.skills
    }
    assert got == EXPECTED_TOOLS


def test_manifest_tool_fields_complete():
    """每个 tool 必填字段齐全（DoD ②）。"""
    m = build_manifest(None, generated_at="2026-06-21T00:00:00+00:00")
    for skill in m.skills:
        for tool in skill.tools:
            assert isinstance(tool.name, str) and tool.name
            assert isinstance(tool.input_schema, dict) and tool.input_schema.get("type") == "object"
            assert isinstance(tool.output_schema, dict) and tool.output_schema
            assert isinstance(tool.auth_scopes, list) and tool.auth_scopes
            assert tool.confirmation_tier in ("none", "preview", "edit")
            assert tool.side_effect in ("read", "write", "external_call", "send")
            assert tool.handler.kind in ("service", "repository", "subprocess", "api")
            assert tool.handler.target
            assert isinstance(tool.mcp_exposed, bool)


def test_manifest_http_shape(skill_client):
    """GET /api/skills (bypass on) → 200 envelope，data 是 manifest dict。"""
    r = skill_client.get("/api/skills")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    data = body["data"]
    assert data["manifest_version"] == "1.0"
    names = {s["name"] for s in data["skills"]}
    assert names == set(EXPECTED_TOOLS)
    assert body["meta"]["skills"] == len(EXPECTED_TOOLS)


def test_manifest_scopes_within_known_catalog():
    """codex low 回归：每个 tool.auth_scopes ⊆ KNOWN_SCOPES（防 manifest↔key-store scope 漂移）。

    若 manifest 用了 key store 不认的 scope，该 tool 将永远无法被任何 key 授权（ungrantable）。
    """
    from src.security.api_keys import KNOWN_SCOPES

    m = build_manifest(None, generated_at="x")
    for s in m.skills:
        for t in s.tools:
            for sc in t.auth_scopes:
                assert sc in KNOWN_SCOPES, f"{s.name}.{t.name} scope {sc!r} not in KNOWN_SCOPES"


def test_send_tool_always_edit_confirmation():
    """发信工具恒 confirmation_tier=edit + side_effect=send（硬约束）。"""
    m = build_manifest(None, generated_at="x")
    send = next(t for s in m.skills for t in s.tools if t.name == "email_send")
    assert send.confirmation_tier == "edit"
    assert send.side_effect == "send"
    assert send.mcp_exposed is False
