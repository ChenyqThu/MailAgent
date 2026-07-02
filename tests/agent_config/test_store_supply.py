"""AgentConfigStore S2 W2 供应链迁移 —— 追加列/表幂等 + install files_json + 事件 detail + 密钥清理。

纯 store 单测（tmp_path 直建库，不碰 env / 单例）。
"""

from __future__ import annotations

import json
import sqlite3

from src.agent_config.store import AgentConfigStore


def _store(tmp_path, name="agent_config.db") -> AgentConfigStore:
    return AgentConfigStore(str(tmp_path / name))


def _table_cols(path, table):
    conn = sqlite3.connect(path)
    try:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    finally:
        conn.close()


def test_fresh_db_has_new_columns_and_table(tmp_path):
    st = _store(tmp_path)  # noqa: F841 — construction runs schema
    path = str(tmp_path / "agent_config.db")
    cols = _table_cols(path, "agent_skills")
    assert "files_json" in cols and "first_run_approved" in cols
    conn = sqlite3.connect(path)
    try:
        tbls = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    finally:
        conn.close()
    assert "skill_secrets" in tbls


def test_additive_migration_on_preexisting_table(tmp_path):
    """S2 之前建的 agent_skills 表（无新列）开库时被 _migrate_additive 补列，幂等。"""
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE agent_skills (skill_name TEXT PRIMARY KEY, source_type TEXT NOT NULL, "
        "source_uri TEXT, version TEXT, manifest_version TEXT, manifest_json TEXT, enabled INTEGER, "
        "granted_scopes_json TEXT, package_hash TEXT, trusted INTEGER NOT NULL DEFAULT 0, "
        "last_error TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    )
    conn.execute(
        "INSERT INTO agent_skills(skill_name,source_type,installed_at,updated_at) VALUES('old','document',1,1)"
    )
    conn.commit()
    conn.close()

    AgentConfigStore(path)  # migrate
    cols = _table_cols(path, "agent_skills")
    assert "files_json" in cols and "first_run_approved" in cols
    AgentConfigStore(path)  # idempotent — second open must not raise
    st = AgentConfigStore(path)
    row = st.get_skill("old")
    assert row is not None and row.files_json is None and row.first_run_approved is None


def test_install_persists_files_json_and_event_detail(tmp_path):
    st = _store(tmp_path)
    files = {"main.py": "a" * 64, "manifest.json": "b" * 64}
    st.install_skill(
        "scriptskill",
        source_type="skill_pack",
        manifest={"name": "scriptskill", "type": "script", "tools": []},
        manifest_version="2",
        package_hash="pkghash123",
        files_json=json.dumps(files, sort_keys=True),
    )
    row = st.get_skill("scriptskill")
    assert row is not None
    assert json.loads(row.files_json) == files
    assert row.package_hash == "pkghash123"
    # 事件 detail 含 package_hash + manifest_version（供应链溯源），无 secret 值。
    ev = st.list_events("scriptskill")[0]
    detail = json.loads(ev["detail_json"])
    assert detail["package_hash"] == "pkghash123"
    assert detail["manifest_version"] == "2"
    assert detail["source_type"] == "skill_pack"


def test_skill_secret_names_and_cleanup(tmp_path):
    """skill_secrets 行的名字列表 + uninstall 全清（值列本 wave 直写密文占位，W3 填加解密）。"""
    st = _store(tmp_path)
    conn = sqlite3.connect(str(tmp_path / "agent_config.db"))
    conn.execute(
        "INSERT INTO skill_secrets(skill_name,secret_name,value_ciphertext,updated_at) VALUES (?,?,?,?)",
        ("scriptskill", "DMS_TOKEN", b"ciphertext-bytes", "now"),
    )
    conn.commit()
    conn.close()
    assert st.list_skill_secret_names("scriptskill") == ["DMS_TOKEN"]
    assert st.delete_skill_secrets("scriptskill") == 1
    assert st.list_skill_secret_names("scriptskill") == []
    # 幂等：再删 0 行
    assert st.delete_skill_secrets("scriptskill") == 0
