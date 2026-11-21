"""Contract tests for the `artifact_studio` builtin skill."""

from __future__ import annotations

import pytest

from src.agent_config.projections import advertised_skill_names
from src.agent_config.store import AgentConfigStore
from src.skills.registry import build_manifest, builtin_doc_file, code_builtin_skills


@pytest.fixture()
def _rebuild_builtins():
    code_builtin_skills.cache_clear()
    yield
    code_builtin_skills.cache_clear()


def _artifact_studio_skill():
    return next(
        item for item in build_manifest(None, generated_at="x").skills if item.name == "artifact_studio"
    )


def test_artifact_studio_builtin_is_registered_and_zero_tool(_rebuild_builtins):
    skill = _artifact_studio_skill()
    assert skill.tools == []
    assert skill.docs_path == "skills/artifact_studio/SKILL.md"
    assert skill.default_enabled is True
    assert "artifact_write" in skill.prompt_fragment
    assert "skill_read" in skill.prompt_fragment
    doc_path = builtin_doc_file("artifact_studio")
    assert doc_path is not None and doc_path.endswith("docs/artifact_studio/SKILL.md")


def test_artifact_studio_skill_is_advertised_by_default(tmp_path, _rebuild_builtins):
    store = AgentConfigStore(str(tmp_path / "agent_config.db"))
    code_builtin_skills.cache_clear()
    skills = build_manifest(None, generated_at="x").skills
    assert "artifact_studio" in advertised_skill_names(skills, store)
