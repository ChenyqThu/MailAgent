"""0812 dogfood — the `matters` follow-up builtin skill contract.

Three things that a "挂了个 skill" claim actually depends on:
  · it is registered (a builder that nobody adds to the tuple is a no-op);
  · it is a ZERO-TOOL skill (the matter_* tools are CORE_UNGATED in the gateway — this skill must
    not pretend to own / unlock them);
  · `default_enabled` follows MAILAGENT_MATTERS_ENABLED (advertising a matter workflow while the
    feature is off teaches the model to call tools that are not registered).

The 「fragment 真的进 system prompt」leg lives in tests/api/test_chat.py (it needs the /chat/config
endpoint, which owns the trusted-fragment whitelist).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from src.agent_config.projections import advertised_skill_names
from src.agent_config.store import AgentConfigStore
from src.skills.registry import build_manifest, code_builtin_skills


@pytest.fixture()
def _rebuild_builtins():
    """code_builtin_skills() 是 lru_cache —— 改设置后必须清缓存重建，退出时再清一次，
    免得本用例构造出来的 skill 元组泄漏给后面的测试。"""
    code_builtin_skills.cache_clear()
    yield
    code_builtin_skills.cache_clear()


def _matters_skill():
    return next(item for item in build_manifest(None, generated_at="x").skills if item.name == "matters")


def test_matters_builtin_is_registered_and_zero_tool(monkeypatch, _rebuild_builtins):
    monkeypatch.setattr("src.api.deps.get_settings", lambda: SimpleNamespace(matters_enabled=True))
    skill = _matters_skill()
    assert skill.tools == []
    assert skill.docs_path == "skills/matters/SKILL.md"
    # 名字不得与 headless run kind `matter_followup` 撞（同名不同物，见 builtin/matters.py 头注）。
    assert skill.name == "matters"
    assert "matter_find" in skill.prompt_fragment
    assert "matter_get" in skill.prompt_fragment


def test_matters_skill_default_follows_matters_flag(monkeypatch, tmp_path, _rebuild_builtins):
    store = AgentConfigStore(str(tmp_path / "agent_config.db"))

    monkeypatch.setattr("src.api.deps.get_settings", lambda: SimpleNamespace(matters_enabled=True))
    code_builtin_skills.cache_clear()
    on = build_manifest(None, generated_at="x").skills
    assert next(s for s in on if s.name == "matters").default_enabled is True
    assert "matters" in advertised_skill_names(on, store)

    monkeypatch.setattr("src.api.deps.get_settings", lambda: SimpleNamespace(matters_enabled=False))
    code_builtin_skills.cache_clear()
    off = build_manifest(None, generated_at="x").skills
    assert next(s for s in off if s.name == "matters").default_enabled is False
    assert "matters" not in advertised_skill_names(off, store)


def test_matters_fragment_teaches_find_before_create_and_draft_only(monkeypatch, _rebuild_builtins):
    monkeypatch.setattr("src.api.deps.get_settings", lambda: SimpleNamespace(matters_enabled=True))
    fragment = _matters_skill().prompt_fragment
    # 重复检测：邮件工具栏的「创建事项」把去重职责交给了 agent（不再有 MatterLinkPopover 的
    # 重复候选面），所以「先查再建」必须写在恒注入的方法论里。
    assert "Before creating anything" in fragment
    assert "near-duplicate" in fragment
    # 起草不发送 + 结果以工具返回为准（两条安全地板）。
    assert "never sent by you" in fragment
    assert "until the tool result confirms it" in fragment


def test_matters_fragment_tells_the_model_to_research_before_creating(monkeypatch, _rebuild_builtins):
    """0813 dogfood #4（owner：「创建事项…好像不会去检索 notion」）。

    「AI 调研创建」那条链根本不经过 ``create_research``（那是创建对话框的纯读端点）：它开的是
    一场普通 manual chat，模型做什么完全取决于 prompt。原方法论只写了「先查重再建」，一个字
    没提要去查资料 —— 于是模型读完这一封就建。这条断言钉住「建之前先调研」这个动作。

    🔴 同时钉住**不许点名工具**：Notion 的检索能力在 owner 机器上来自 MCP connector /
    notion_agent skill，两者都是动态注册的；恒注入的方法论里写死一个工具名 = 工具面里没有它
    时就是在教模型调不存在的工具（回归网 R 系列的老失败模式）。故只许指「你自己的工具列表」。
    """
    monkeypatch.setattr("src.api.deps.get_settings", lambda: SimpleNamespace(matters_enabled=True))
    fragment = _matters_skill().prompt_fragment
    assert "Creating a Matter is a research step" in fragment
    assert "Notion" in fragment
    assert "your own tool list" in fragment
    # 没有对应工具的来源必须如实说没查，而不是含糊带过（否则「查过 Notion」是幻觉）。
    assert "Never imply you searched a source you have no tool for" in fragment
    # 恒注入面里不得出现具体的 Notion 工具名 —— 它们是动态注册的，写死即断言不存在的能力。
    for dynamic_tool in ("notion_agent_chat", "mcp__notion__", "notion-search"):
        assert dynamic_tool not in fragment
