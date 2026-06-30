"""MEMORY/SKILLS 投影 + 配置快照 hash 单元（PR2）.

确定性是关键 —— installed_skills_hash 进 Phase 0 eval trace，必须可复现。
"""

from __future__ import annotations

from types import SimpleNamespace

from src.agent_config.projections import (
    advertised_skill_names,
    builtin_skills_signature,
    compute_installed_skills_hash,
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
# MEMORY 投影（memory_doc_projection）随 M5b agent_memory_kv 退役删除 —— MEMORY content
# 现恒空（src/api/routers/agent.py:_memory_projection 无条件返 ''），不再有 markdown-头投影。


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


# ---------------------------------------------------------------------------
# advertised_skill_names（M4a — gateway skill→tool 门控的业务状态源）
# ---------------------------------------------------------------------------
def test_advertised_skill_names_enabled_and_available(tmp_path):
    """advertised = enabled(override ?? default) AND available。
    供 gateway skill→tool 门控：只有这些 skill 的工具对模型可见。"""
    store = AgentConfigStore(str(tmp_path / "adv.db"))
    store.set_enabled("email", False)  # override 关掉 default-on 的 email
    skills = [
        _skill("email", default_enabled=True),  # override False → 出局
        _skill("search", default_enabled=True),  # default on + available → 进
        _skill("report", default_enabled=False),  # default off + 无 override → 出局
        _skill("kos", default_enabled=True, available=False),  # enabled 但 unavailable → 出局
    ]
    assert advertised_skill_names(skills, store) == ["search"]


def test_advertised_skill_names_override_enables_default_off(tmp_path):
    """override=True 把 default-off 的 skill 激活进 advertised。"""
    store = AgentConfigStore(str(tmp_path / "adv2.db"))
    store.set_enabled("report", True)  # 打开 default-off 的 report
    skills = [_skill("report", default_enabled=False)]
    assert advertised_skill_names(skills, store) == ["report"]


def test_advertised_skill_names_empty_when_all_off(tmp_path):
    """全禁 / 全不可用 → []（区别于端点 fail-soft 的 None：[] = 门控全删 skill 工具，
    None = 未知 → gateway fail-open）。"""
    store = AgentConfigStore(str(tmp_path / "adv3.db"))
    skills = [
        _skill("a", default_enabled=False),
        _skill("b", default_enabled=True, available=False),
    ]
    assert advertised_skill_names(skills, store) == []
