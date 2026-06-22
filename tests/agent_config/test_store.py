"""AgentConfigStore 单元 —— PR1（Phase -1 / 0A capability & context foundation）.

覆盖：profile docs seed/edit/history/rollback/profile_hash、skills install/enable/uninstall/
events/scope 校验、enabled 三级回退、installed_rows_fingerprint 确定性、路径解析。
纯 store 单测用 tmp_path 直建库（不碰 env / 单例）。
"""

from __future__ import annotations

import pytest

from src.agent_config.store import (
    PROFILE_DOC_NAMES,
    AgentConfigStore,
    agent_config_db_for,
    resolve_agent_config_db_path,
    resolve_enabled,
)
from src.agent_config.templates import SEED_TEMPLATES


def _store(tmp_path, name="agent_config.db") -> AgentConfigStore:
    return AgentConfigStore(str(tmp_path / name))


# ---------------------------------------------------------------------------
# enabled 三级回退（纯函数，穷举）
# ---------------------------------------------------------------------------
def test_resolve_enabled_row_override_wins():
    # row 非 None 一律胜出（无视 manifest/code 默认）
    assert resolve_enabled(True, manifest_default=False, code_default=False) is True
    assert resolve_enabled(False, manifest_default=True, code_default=True) is False


def test_resolve_enabled_falls_back_to_manifest_then_code():
    # row=None → manifest 默认
    assert resolve_enabled(None, manifest_default=True, code_default=False) is True
    assert resolve_enabled(None, manifest_default=False, code_default=True) is False
    # row=None 且 manifest=None → code 默认
    assert resolve_enabled(None, manifest_default=None, code_default=True) is True
    assert resolve_enabled(None, manifest_default=None, code_default=False) is False
    # 全缺省 → False
    assert resolve_enabled(None) is False


# ---------------------------------------------------------------------------
# Standing Context 文档
# ---------------------------------------------------------------------------
def test_profile_docs_seed_on_read(tmp_path):
    st = _store(tmp_path)
    for name in PROFILE_DOC_NAMES:
        doc = st.get_profile_doc(name)
        assert doc.doc_name == name
        assert doc.content == SEED_TEMPLATES[name]
        assert doc.updated_by == "seed"
        assert doc.content_hash  # 非空
    # list 返回 4 个，顺序 = PROFILE_DOC_NAMES
    docs = st.list_profile_docs()
    assert [d.doc_name for d in docs] == list(PROFILE_DOC_NAMES)
    # seed 落了一条初始 history（old_hash=None）
    hist = st.list_profile_history("soul")
    assert len(hist) == 1
    assert hist[0].old_hash is None
    assert hist[0].changed_by == "seed"


def test_profile_doc_seed_is_idempotent(tmp_path):
    st = _store(tmp_path)
    d1 = st.get_profile_doc("user")
    d2 = st.get_profile_doc("user")  # 二次读不应再 seed / 不应多记 history
    assert d1.content_hash == d2.content_hash
    assert len(st.list_profile_history("user")) == 1


def test_profile_doc_set_records_history(tmp_path):
    st = _store(tmp_path)
    st.get_profile_doc("rules")  # seed
    updated = st.set_profile_doc("rules", "# RULES\nNew content", updated_by="user")
    assert updated.content == "# RULES\nNew content"
    assert updated.updated_by == "user"
    hist = st.list_profile_history("rules")
    assert len(hist) == 2  # seed + edit，DESC 排序最新在前
    assert hist[0].old_hash is not None
    assert hist[0].new_hash == updated.content_hash
    assert hist[0].content_snapshot == "# RULES\nNew content"


def test_profile_doc_set_noop_when_unchanged(tmp_path):
    st = _store(tmp_path)
    seed = st.get_profile_doc("agent")
    again = st.set_profile_doc("agent", seed.content, updated_by="user")
    assert again.content_hash == seed.content_hash
    assert len(st.list_profile_history("agent")) == 1  # 内容未变 → 不记新 history


def test_profile_doc_rollback(tmp_path):
    st = _store(tmp_path)
    seed = st.get_profile_doc("soul")
    seed_hash = seed.content_hash
    st.set_profile_doc("soul", "# SOUL\nv2", updated_by="user")
    st.set_profile_doc("soul", "# SOUL\nv3", updated_by="agent_proposed")
    # 回滚到 seed 版本
    rolled = st.rollback_profile_doc("soul", seed_hash, updated_by="user")
    assert rolled.content == seed.content
    # 回滚本身记一条新 history
    hist = st.list_profile_history("soul")
    assert hist[0].content_snapshot == seed.content
    # 未知 hash → KeyError
    with pytest.raises(KeyError):
        st.rollback_profile_doc("soul", "deadbeef", updated_by="user")


def test_profile_doc_rejects_unknown_name(tmp_path):
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        st.get_profile_doc("memory")  # 投影文档，不可经 profile_docs 读
    with pytest.raises(ValueError):
        st.set_profile_doc("bogus", "x", updated_by="user")


def test_profile_doc_rejects_empty_content(tmp_path):
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        st.set_profile_doc("user", "", updated_by="user")


def test_profile_hash_deterministic_and_sensitive(tmp_path):
    st = _store(tmp_path)
    h1 = st.profile_hash()
    h2 = st.profile_hash()
    assert h1 == h2  # 确定性
    st.set_profile_doc("user", "# USER\nchanged", updated_by="user")
    assert st.profile_hash() != h1  # 文档变 → hash 变


def test_profile_hash_stable_across_stores_same_seed(tmp_path):
    """同一默认种群（全 seed）的 profile_hash 在不同库实例间一致（可复现 baseline）。"""
    a = _store(tmp_path, "a.db")
    b = _store(tmp_path, "b.db")
    a.list_profile_docs()
    b.list_profile_docs()
    assert a.profile_hash() == b.profile_hash()


# ---------------------------------------------------------------------------
# Skills
# ---------------------------------------------------------------------------
def test_install_skill_document(tmp_path):
    st = _store(tmp_path)
    skill = st.install_skill(
        "my-notes",
        source_type="document",
        manifest={"name": "my-notes", "tools": []},
        version="1.0.0",
        manifest_version="1.0",
        granted_scopes=["email:read"],
    )
    assert skill.skill_name == "my-notes"
    assert skill.source_type == "document"
    assert skill.manifest == {"name": "my-notes", "tools": []}
    assert skill.granted_scopes == ("email:read",)
    assert skill.is_builtin is False
    # event 记了 install
    events = st.list_events("my-notes")
    assert events[0]["event"] == "install"


def test_install_skill_rejects_unknown_scope(tmp_path):
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        st.install_skill("bad", source_type="document", granted_scopes=["bogus:scope"])


def test_install_skill_rejects_builtin_source(tmp_path):
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        st.install_skill("x", source_type="builtin")  # builtin 来自代码，不可经 install


# R5（GPT-5.5 review）—— skill_name slug + manifest.name 一致性
def test_install_skill_rejects_invalid_slug(tmp_path):
    st = _store(tmp_path)
    for bad in ("Has Space", "UPPER", "with/slash", "包含中文", "9starts-digit", "-leadhyphen", ""):
        with pytest.raises(ValueError):
            st.install_skill(bad, source_type="document")


def test_install_skill_accepts_valid_slug(tmp_path):
    st = _store(tmp_path)
    for good in ("a", "my-notes", "report_helper", "x9", "a" + "b" * 40):
        st.install_skill(good, source_type="document")  # 不抛


def test_install_skill_rejects_manifest_name_mismatch(tmp_path):
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        st.install_skill(
            "foo", source_type="document", manifest={"name": "bar", "tools": []}
        )
    # manifest.name 缺省 或 与 skill_name 相等 → 通过
    st.install_skill("foo", source_type="document", manifest={"tools": []})
    st.install_skill("baz", source_type="document", manifest={"name": "baz", "tools": []})


def test_set_enabled_lazy_builtin_row(tmp_path):
    st = _store(tmp_path)
    assert st.get_skill("email") is None
    st.set_enabled("email", False)  # builtin 懒建覆盖行
    row = st.get_skill("email")
    assert row is not None
    assert row.source_type == "builtin"
    assert row.enabled is False
    assert row.manifest is None  # builtin 行不存 manifest（来自代码）
    # 再 enable → 更新同一行
    st.set_enabled("email", True)
    assert st.get_skill("email").enabled is True
    # 事件记了 disable + enable
    events = [e["event"] for e in st.list_events("email")]
    assert "disable" in events and "enable" in events


def test_enabled_none_vs_false_distinct(tmp_path):
    """NULL（无覆盖）与 0（显式禁用）必须可区分 —— 决定三级回退是否触发。"""
    st = _store(tmp_path)
    st.install_skill("a", source_type="document", enabled=None)
    st.install_skill("b", source_type="document", enabled=False)
    st.install_skill("c", source_type="document", enabled=True)
    assert st.get_skill("a").enabled is None
    assert st.get_skill("b").enabled is False
    assert st.get_skill("c").enabled is True


def test_uninstall_skill(tmp_path):
    st = _store(tmp_path)
    st.install_skill("gone", source_type="document")
    assert st.uninstall_skill("gone") is True
    assert st.get_skill("gone") is None
    assert st.uninstall_skill("gone") is False  # 幂等
    assert st.uninstall_skill("never") is False


def test_list_skills_ordered(tmp_path):
    st = _store(tmp_path)
    st.install_skill("zeta", source_type="document")
    st.install_skill("alpha", source_type="document")
    st.set_enabled("mid", True)  # builtin 懒行
    names = [s.skill_name for s in st.list_skills()]
    assert names == sorted(names)  # ORDER BY skill_name


def test_installed_rows_fingerprint_deterministic(tmp_path):
    st = _store(tmp_path)
    st.install_skill("b", source_type="document", version="1.0", manifest_version="1.0")
    st.install_skill("a", source_type="skill_pack", version="2.0", manifest_version="1.0")
    fp1 = st.installed_rows_fingerprint()
    fp2 = st.installed_rows_fingerprint()
    assert fp1 == fp2
    # 含 name/source_type/version/manifest_version，ORDER BY name（a 在 b 前）
    assert fp1.index("a|skill_pack") < fp1.index("b|document")
    # enabled 不进指纹（toggle 不改 installed_skills_hash）
    before = st.installed_rows_fingerprint()
    st.set_enabled("a", False)
    assert st.installed_rows_fingerprint() == before


# ---------------------------------------------------------------------------
# 路径解析
# ---------------------------------------------------------------------------
def test_path_resolution_env_override(tmp_path, monkeypatch):
    override = str(tmp_path / "override.db")
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", override)
    assert resolve_agent_config_db_path() == override
    assert resolve_agent_config_db_path("/other/data/sync_store.db") == override
    monkeypatch.delenv("MAILAGENT_AGENT_CONFIG_DB_PATH", raising=False)
    ss = str(tmp_path / "data" / "sync_store.db")
    assert resolve_agent_config_db_path(ss) == agent_config_db_for(ss)
    assert agent_config_db_for(ss).endswith("agent_config.db")
