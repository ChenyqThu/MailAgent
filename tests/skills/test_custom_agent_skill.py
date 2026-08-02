"""W6 conversational Custom Agent builtin skill contract."""

from __future__ import annotations

from src.agent_config.projections import advertised_skill_names
from src.agent_config.store import AgentConfigStore
from src.skills.registry import build_manifest


def test_custom_agent_builtin_is_default_advertised(tmp_path):
    manifest = build_manifest(None, generated_at="x")
    skill = next(item for item in manifest.skills if item.name == "custom_agent")
    assert skill.default_enabled is True
    assert skill.tools == []
    assert skill.docs_path == "skills/custom_agent/SKILL.md"
    assert "six capability tiers" in skill.prompt_fragment

    store = AgentConfigStore(str(tmp_path / "agent_config.db"))
    assert "custom_agent" in advertised_skill_names(manifest.skills, store)


def test_custom_agent_skill_uses_tiers_and_keeps_safety_floor():
    skill = next(
        item
        for item in build_manifest(None, generated_at="x").skills
        if item.name == "custom_agent"
    )
    fragment = skill.prompt_fragment
    assert "Email read/organize/draft" in fragment
    assert "Calendar off/read/write" in fragment
    assert "Reports read/produce" in fragment
    assert "mandatory approval card" in fragment
    assert "Calendar writes always" in fragment
    assert "atomic" in fragment and "tool names" in fragment
