"""MEMORY/SKILLS 投影 + 配置快照 hash 单元（PR2）.

确定性是关键 —— installed_skills_hash 进 Phase 0 eval trace，必须可复现。
"""

from __future__ import annotations

from types import SimpleNamespace

from src.agent_config.projections import (
    builtin_skills_signature,
    compute_installed_skills_hash,
    memory_doc_projection,
    resolved_skills,
    skill_overrides_map,
    skills_doc_projection,
)
from src.agent_config.store import AgentConfigStore


def _skill(
    name, version="1.0", title=None, default_enabled=True, available=True, reason=None,
    ntools=0, scopes=None,
):
    return SimpleNamespace(
        name=name,
        version=version,
        title=title or name.title(),
        description=f"{name} skill",
        default_enabled=default_enabled,
        availability=SimpleNamespace(available=available, reason=reason),
        tools=[SimpleNamespace(auth_scopes=list(scopes or [])) for _ in range(ntools)],
    )


# ---------------------------------------------------------------------------
# 文档投影
# ---------------------------------------------------------------------------
def test_memory_projection_empty():
    out = memory_doc_projection("")
    assert "# MEMORY" in out
    assert "No durable memory yet" in out


def test_memory_projection_with_body():
    out = memory_doc_projection("- name: Alice\n- tz: PDT")
    assert out.startswith("# MEMORY")
    assert "- name: Alice" in out


def test_skills_projection_lists_skills_sorted():
    out = skills_doc_projection([_skill("zeta", ntools=2), _skill("alpha", ntools=1)])
    assert out.index("`alpha`") < out.index("`zeta`")  # 排序
    assert "1 tools" in out and "2 tools" in out


def test_skills_projection_unavailable_reason():
    out = skills_doc_projection([_skill("kos", available=False, reason="KOS not configured")])
    assert "unavailable: KOS not configured" in out


def test_skills_projection_empty():
    assert "No skills available" in skills_doc_projection([])


# ---------------------------------------------------------------------------
# hash 确定性（golden / 不变式）
# ---------------------------------------------------------------------------
def test_builtin_signature_sorted_deterministic():
    a = builtin_skills_signature([_skill("b", "2.0"), _skill("a", "1.0")])
    b = builtin_skills_signature([_skill("a", "1.0"), _skill("b", "2.0")])
    assert a == b  # 输入顺序无关
    assert a == "a|1.0\nb|2.0"


def test_installed_skills_hash_deterministic(tmp_path):
    store = AgentConfigStore(str(tmp_path / "c.db"))
    skills = [_skill("email", "1.0"), _skill("search", "1.0")]
    h1 = compute_installed_skills_hash(skills, store)
    h2 = compute_installed_skills_hash(list(reversed(skills)), store)
    assert h1 == h2  # 与 manifest skill 顺序无关
    assert len(h1) == 64  # sha256 hex


def test_installed_skills_hash_changes_on_install(tmp_path):
    store = AgentConfigStore(str(tmp_path / "d.db"))
    skills = [_skill("email", "1.0")]
    before = compute_installed_skills_hash(skills, store)
    store.install_skill("extra", source_type="document", version="1.0", manifest_version="1.0")
    after = compute_installed_skills_hash(skills, store)
    assert before != after  # 安装新 skill → installed_skills_hash 变


def test_installed_skills_hash_stable_on_toggle(tmp_path):
    """enabled toggle 不改 installed_skills_hash（启用态属 active_skills_hash）。"""
    store = AgentConfigStore(str(tmp_path / "e.db"))
    store.install_skill("x", source_type="document", version="1.0", manifest_version="1.0")
    skills = [_skill("email", "1.0")]
    before = compute_installed_skills_hash(skills, store)
    store.set_enabled("x", False)
    assert compute_installed_skills_hash(skills, store) == before


# ---------------------------------------------------------------------------
# 启用态（PR5）
# ---------------------------------------------------------------------------
def test_skill_overrides_map_only_explicit(tmp_path):
    store = AgentConfigStore(str(tmp_path / "ov.db"))
    store.install_skill("a", source_type="document", enabled=True)
    store.install_skill("b", source_type="document", enabled=False)
    store.install_skill("c", source_type="document", enabled=None)  # 无覆盖
    store.set_enabled("email", False)  # builtin 懒覆盖
    m = skill_overrides_map(store)
    assert m == {"a": True, "b": False, "email": False}  # c（None）不在 map


def test_resolved_skills_merges_override(tmp_path):
    store = AgentConfigStore(str(tmp_path / "rs.db"))
    store.set_enabled("email", False)  # builtin override
    skills = [
        _skill("email", default_enabled=True, ntools=2, scopes=["email:read"]),
        _skill("search", default_enabled=True, ntools=1, scopes=["email:read"]),
    ]
    by = {s["name"]: s for s in resolved_skills(skills, store)}
    assert by["email"]["enabled"] is False and by["email"]["overridden"] is True
    assert by["email"]["sourceType"] == "builtin"
    assert by["email"]["scopes"] == ["email:read"]
    # search 无覆盖 → 回退 default_enabled=True
    assert by["search"]["enabled"] is True and by["search"]["overridden"] is False
