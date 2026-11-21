"""Contract tests for the `omada_prototype` builtin skill."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.agent_config.projections import advertised_skill_names
from src.agent_config.store import AgentConfigStore
from src.skills.registry import build_manifest, builtin_doc_file, code_builtin_skills


@pytest.fixture()
def _rebuild_builtins():
    code_builtin_skills.cache_clear()
    yield
    code_builtin_skills.cache_clear()


def _omada_prototype_skill():
    return next(
        item for item in build_manifest(None, generated_at="x").skills if item.name == "omada_prototype"
    )


def test_omada_prototype_builtin_is_registered_and_zero_tool(_rebuild_builtins):
    skill = _omada_prototype_skill()
    assert skill.tools == []
    assert skill.docs_path == "skills/omada_prototype/SKILL.md"
    assert skill.default_enabled is True
    assert "@chenyqthu/omada-ui-kit" in skill.prompt_fragment
    assert "omada_catalog_query" in skill.prompt_fragment
    assert "artifact_write" in skill.prompt_fragment
    assert "artifact_build_omada" in skill.prompt_fragment
    assert "skill_read" in skill.prompt_fragment
    doc_path = builtin_doc_file("omada_prototype")
    assert doc_path is not None and doc_path.endswith("docs/omada_prototype/SKILL.md")
    doc_text = Path(doc_path).read_text(encoding="utf-8")
    assert "@chenyqthu/omada-ui-kit" in doc_text
    assert "omada_catalog_query" in doc_text
    assert "artifact_write" in doc_text


def test_omada_prototype_skill_is_advertised_by_default(tmp_path, _rebuild_builtins):
    store = AgentConfigStore(str(tmp_path / "agent_config.db"))
    code_builtin_skills.cache_clear()
    skills = build_manifest(None, generated_at="x").skills
    assert "omada_prototype" in advertised_skill_names(skills, store)
