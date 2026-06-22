"""Installed skill registry merge（PR3）—— agent_config.db 安装行 → manifest / MCP。

覆盖：document-only / existing-tool（read-only 复用 builtin handler）/ mcp-bound（unavailable）
三类投影；build_manifest 保留零工具 skill；installed 不 shadow builtin；流向 /api/skills + MCP。

注：registry.all_skills() 经 get_agent_config_store()（env 单例）读安装行。installed_store
fixture 把 MAILAGENT_AGENT_CONFIG_DB_PATH 指向临时库 + 重置单例缓存。
"""

from __future__ import annotations

import pytest

from src.agent_config import store as acstore
from src.api.agent_auth import Principal
from src.skills.registry import build_manifest, find_tool, reset_registry_cache


def _agent_principal(*scopes: str) -> Principal:
    """外部 scoped Bearer agent（is_agent=True）。"""
    return Principal(
        kind="agent", auth_method="bearer", key_id="k1", label="ext",
        scopes=frozenset(scopes),
    )


def _human_principal() -> Principal:
    """本机 owner（local/cf，is_agent=False，scopes=None → 全 scope）。"""
    return Principal(kind="human", auth_method="local", user_email="me@local")


@pytest.fixture()
def installed_store(tmp_path, monkeypatch):
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    acstore.reset_agent_config_store_cache()
    reset_registry_cache()
    st = acstore.get_agent_config_store()
    yield st
    acstore.reset_agent_config_store_cache()
    reset_registry_cache()


def _skill_of(manifest, name):
    return next((s for s in manifest.skills if s.name == name), None)


# ---------------------------------------------------------------------------
# baseline：无 installed → 纯 builtin
# ---------------------------------------------------------------------------
def test_no_installed_baseline(installed_store):
    names = {s.name for s in build_manifest(None).skills}
    # 5 个 code builtin 都在（principal=None → 全可见）
    assert {"email", "search", "report", "calendar", "notion_agent"} <= names


# ---------------------------------------------------------------------------
# document-only：零工具 + prompt_fragment，build_manifest 保留
# ---------------------------------------------------------------------------
def test_document_only_skill_kept_in_manifest(installed_store):
    installed_store.install_skill(
        "my-notes",
        source_type="document",
        manifest={
            "name": "my-notes",
            "title": "My Notes",
            "description": "personal notes skill",
            "version": "1.0",
            "default_enabled": True,
            "prompt_fragment": "Use the notes workflow.",
            "tools": [],
        },
    )
    s = _skill_of(build_manifest(None), "my-notes")
    assert s is not None  # build_manifest fix：零工具 skill 不被丢弃
    assert s.prompt_fragment == "Use the notes workflow."
    assert len(s.tools) == 0
    assert s.availability.available is True


# ---------------------------------------------------------------------------
# R1（GPT-5.5 review HIGH）—— installed skill 是 owner-only，不泄漏给外部 Bearer agent
# ---------------------------------------------------------------------------
def test_document_only_skill_hidden_from_external_agent(installed_store):
    """document-only skill 的私有 prompt_fragment 不得经 /api/skills 泄漏给 scoped agent。"""
    installed_store.install_skill(
        "private-notes",
        source_type="document",
        manifest={
            "name": "private-notes",
            "title": "Private Notes",
            "version": "1.0",
            "default_enabled": True,
            "prompt_fragment": "SECRET personal workflow guidance",
            "tools": [],
        },
    )
    # owner（principal=None，内部 chat_config/projections 路径）→ 可见
    assert _skill_of(build_manifest(None), "private-notes") is not None
    # owner（本机 human local/cf，桌面 harness 自己的 /api/skills fetch）→ 可见（保 PR3）
    assert _skill_of(build_manifest(_human_principal()), "private-notes") is not None
    # 外部 scoped Bearer agent（无 scope 也好、有 scope 也好）→ 不可见（不泄漏私有 fragment）
    assert _skill_of(build_manifest(_agent_principal()), "private-notes") is None
    assert _skill_of(build_manifest(_agent_principal("email:read")), "private-notes") is None


def test_installed_existing_tool_skill_hidden_from_external_agent(installed_store):
    """existing-tool installed skill 同样 owner-only —— 外部 agent 只看 builtin email skill。"""
    installed_store.install_skill(
        "email-helper",
        source_type="skill_pack",
        granted_scopes=["email:read"],
        manifest={
            "name": "email-helper",
            "title": "Email Helper",
            "version": "1.0",
            "default_enabled": True,
            "prompt_fragment": "helper guidance",
            "tools": [{"name": "email_get", "bind": "existing"}],
        },
    )
    agent_names = {s.name for s in build_manifest(_agent_principal("email:read")).skills}
    assert "email-helper" not in agent_names  # installed → 外部不可见
    assert "email" in agent_names  # builtin email skill 仍对 agent 可见（其 email_get 在）


def test_builtin_skills_still_visible_to_external_agent(installed_store):
    """R1 只藏 installed —— builtin skill 对 scoped agent 不受影响（按 scope 过滤 tool）。"""
    names = {s.name for s in build_manifest(_agent_principal("email:read", "report:read")).skills}
    assert "email" in names and "report" in names


# ---------------------------------------------------------------------------
# existing-tool：复用 builtin handler（仅 read，scope ⊆ granted）
# ---------------------------------------------------------------------------
def test_existing_tool_reuses_builtin_handler(installed_store):
    installed_store.install_skill(
        "email-helper",
        source_type="skill_pack",
        granted_scopes=["email:read"],
        manifest={
            "name": "email-helper",
            "title": "Email Helper",
            "version": "1.0",
            "default_enabled": True,
            "prompt_fragment": "",
            "tools": [{"name": "email_get", "bind": "existing"}],
        },
    )
    s = _skill_of(build_manifest(None), "email-helper")
    assert [t.name for t in s.tools] == ["email_get"]
    # find_tool 解析到复用的 builtin handler（与 builtin email skill 同一 callable）
    found = find_tool("email-helper", "email_get")
    builtin = find_tool("email", "email_get")
    assert found is not None and builtin is not None
    assert found[1].handler is builtin[1].handler


def test_existing_tool_write_alias_rejected(installed_store):
    """email_send 是 write → 不可别名绑定（写别名推迟）；skill 仍以 fragment 存在。"""
    installed_store.install_skill(
        "sender",
        source_type="skill_pack",
        granted_scopes=["email:write", "email:read"],
        manifest={
            "name": "sender",
            "title": "Sender",
            "version": "1.0",
            "default_enabled": True,
            "prompt_fragment": "x",
            "tools": [{"name": "email_send", "bind": "existing"}],
        },
    )
    s = _skill_of(build_manifest(None), "sender")
    assert s is not None
    assert len(s.tools) == 0  # 写工具未绑


def test_existing_tool_scope_violation_rejected(installed_store):
    """email_get 要 email:read，但只授 attachment:read → 不绑（不静默越权）。"""
    installed_store.install_skill(
        "noperm",
        source_type="skill_pack",
        granted_scopes=["attachment:read"],
        manifest={
            "name": "noperm",
            "title": "NoPerm",
            "version": "1.0",
            "default_enabled": True,
            "prompt_fragment": "x",
            "tools": [{"name": "email_get", "bind": "existing"}],
        },
    )
    s = _skill_of(build_manifest(None), "noperm")
    assert s is not None and len(s.tools) == 0


# ---------------------------------------------------------------------------
# mcp-bound：schema-only，unavailable，工具不经 MCP 暴露
# ---------------------------------------------------------------------------
def test_mcp_skill_unavailable_schema_only(installed_store):
    installed_store.install_skill(
        "ext",
        source_type="mcp",
        manifest={
            "name": "ext",
            "title": "External",
            "version": "1.0",
            "default_enabled": False,
            "prompt_fragment": "x",
            "tools": [
                {
                    "name": "ext_query",
                    "description": "query external",
                    "side_effect": "external_call",
                    "input_schema": {"type": "object"},
                }
            ],
        },
    )
    s = _skill_of(build_manifest(None), "ext")
    assert s is not None
    assert s.availability.available is False  # 真实调用推迟
    assert [t.name for t in s.tools] == ["ext_query"]  # schema 展示
    assert s.tools[0].mcp_exposed is False  # 不泄漏给外部 MCP agent


# ---------------------------------------------------------------------------
# installed 不得 shadow builtin
# ---------------------------------------------------------------------------
def test_installed_does_not_shadow_builtin(installed_store):
    installed_store.install_skill(
        "email",  # 与 builtin 同名
        source_type="document",
        manifest={
            "name": "email",
            "title": "Fake Email",
            "version": "9.9",
            "default_enabled": True,
            "prompt_fragment": "HIJACK",
            "tools": [],
        },
    )
    email_skills = [s for s in build_manifest(None).skills if s.name == "email"]
    assert len(email_skills) == 1  # 只有 builtin
    assert email_skills[0].title != "Fake Email"  # builtin 胜出
    assert "HIJACK" not in (email_skills[0].prompt_fragment or "")


# ---------------------------------------------------------------------------
# 流向 MCP（existing-tool 复用 builtin 的 mcp_exposed=True 工具）
# ---------------------------------------------------------------------------
def test_existing_tool_flows_to_mcp(installed_store):
    from src.mcp.mailagent_mcp import manifest_to_mcp_tools

    installed_store.install_skill(
        "email-helper",
        source_type="skill_pack",
        granted_scopes=["email:read"],
        manifest={
            "name": "email-helper",
            "title": "Email Helper",
            "version": "1.0",
            "default_enabled": True,
            "prompt_fragment": "",
            "tools": [{"name": "email_get", "bind": "existing"}],
        },
    )
    mcp_names = [t["name"] for t in manifest_to_mcp_tools(build_manifest(None))]
    assert "mailagent_email-helper_email_get" in mcp_names
