"""connector / connector_tool 双表（08-01 PR1）：upsert 分工、refresh 纪律、orphan、
delete 写侧拒、effective enabled 折算。纯单测（tmp_path 直建 store，无加密面）。"""

from __future__ import annotations

import pytest

from src.agent_config.store import (
    AgentConfigStore,
    connector_tool_effective_enabled,
)

CID = "notion"


def _store(tmp_path) -> AgentConfigStore:
    return AgentConfigStore(str(tmp_path / "agent_config.db"))


def _manifest(*names_cruds):
    return [
        {
            "name": n,
            "description": f"desc {n}",
            "input_schema": {"type": "object", "properties": {}},
            "output_schema": None,
            "crud_type": c,
        }
        for n, c in names_cruds
    ]


# ── connector 行 ─────────────────────────────────────────────────────────────────


def test_upsert_connector_preserves_runtime_state(tmp_path):
    st = _store(tmp_path)
    st.upsert_connector(CID, server_url="https://mcp.notion.com/mcp", display_name="Notion")
    st.update_connector_state(CID, status="connected", scopes=["default"], enabled=False)

    # 再 upsert（定义刷新）→ 运行态不动。
    st.upsert_connector(CID, server_url="https://mcp.notion.com/mcp2", display_name="Notion2")
    row = st.get_connector(CID)
    assert row is not None
    assert row.server_url == "https://mcp.notion.com/mcp2"
    assert row.display_name == "Notion2"
    assert row.status == "connected"
    assert row.scopes == ["default"]
    assert row.enabled is False


def test_update_connector_state_validates(tmp_path):
    st = _store(tmp_path)
    st.upsert_connector(CID, server_url="https://x")
    with pytest.raises(ValueError):
        st.update_connector_state(CID, status="bogus")
    with pytest.raises(ValueError):
        st.update_connector_state(CID, scopes="not-a-list")
    with pytest.raises(KeyError):
        st.update_connector_state("ghost", status="error")
    # last_error / scopes 哨兵：显式 None = 清空，不传 = 不动。
    st.update_connector_state(CID, status="error", last_error="boom")
    assert st.get_connector(CID).last_error == "boom"
    st.update_connector_state(CID, status="connected")
    assert st.get_connector(CID).last_error == "boom"  # 不传不动
    st.update_connector_state(CID, last_error=None)
    assert st.get_connector(CID).last_error is None  # 显式清空


# ── 工具清单 sync：refresh 纪律 + orphan ────────────────────────────────────────


def test_sync_tools_inserts_and_delete_class_recorded(tmp_path):
    st = _store(tmp_path)
    stats = st.sync_connector_tools(
        CID, _manifest(("search", "read"), ("create_page", "write"), ("delete_page", "delete"))
    )
    assert stats == {"total": 3, "inserted": 3, "updated": 0, "orphaned": 0}
    rows = {r.tool_name: r for r in st.list_connector_tools(CID)}
    # 🔴 Q16=A：delete 类照常入库（清单完整——机制保留位；PR2 起推导不再产出但值域不动）。
    assert rows["delete_page"].crud_type == "delete"
    assert rows["search"].crud_type == "read"
    # destructive 缺省（manifest 不带键）→ 0。
    assert rows["search"].destructive is False


def test_sync_tools_persists_destructive_and_refresh_overwrites(tmp_path):
    """裁决①：destructive 是 manifest 派生字段 —— 落列、refresh 覆盖（用户配置不动）。"""
    st = _store(tmp_path)
    manifest = _manifest(("update_page", "write"))
    manifest[0]["destructive"] = True
    st.sync_connector_tools(CID, manifest)
    row = st.list_connector_tools(CID)[0]
    assert row.destructive is True and row.crud_type == "write"

    # refresh：服务器撤掉 destructive 标 → 列跟随（manifest 派生字段）。
    manifest2 = _manifest(("update_page", "write"))
    st.sync_connector_tools(CID, manifest2)
    assert st.list_connector_tools(CID)[0].destructive is False


def test_sync_overwrites_stale_delete_crud_self_heal(tmp_path):
    """裁决①存量自愈：PR1 误判成 delete 的行，重跑 sync（新 derive 产出 write+destructive）
    即被全量 upsert 刷新 —— crud_type 属 manifest 派生字段，owner 点一次 sync 就修。"""
    st = _store(tmp_path)
    # PR1 时代落库的误判行（destructive_hint → delete），用户显式关过它（配置要保留）。
    st.sync_connector_tools(CID, _manifest(("update_page", "delete")))
    st.set_connector_tool_enabled(CID, "update_page", False)

    # PR2 之后的 sync：同一工具按新推导入库。
    healed = _manifest(("update_page", "write"))
    healed[0]["destructive"] = True
    stats = st.sync_connector_tools(CID, healed)
    assert stats["updated"] == 1
    row = st.list_connector_tools(CID)[0]
    assert row.crud_type == "write"
    assert row.destructive is True
    assert row.enabled is False  # 用户覆盖不被 refresh 动


def test_destructive_column_added_to_pre_pr2_db(tmp_path):
    """幂等加列迁移：PR1 老库（connector_tool 无 destructive 列）重开即补列，行读不炸。"""
    import sqlite3

    db = str(tmp_path / "agent_config.db")
    st = _store(tmp_path)
    st.sync_connector_tools(CID, _manifest(("search", "read")))
    # 模拟 PR1 老库：重建一张无 destructive 列的 connector_tool（SQLite 无 DROP COLUMN 顾虑，
    # 直接建旧形状表）。
    conn = sqlite3.connect(db)
    conn.execute("DROP TABLE connector_tool")
    conn.execute(
        "CREATE TABLE connector_tool ("
        " connector_id TEXT NOT NULL, tool_name TEXT NOT NULL, description TEXT,"
        " input_schema_json TEXT, output_schema_json TEXT,"
        " crud_type TEXT NOT NULL DEFAULT 'read', enabled INTEGER,"
        " orphan INTEGER NOT NULL DEFAULT 0, first_seen_at INTEGER NOT NULL,"
        " last_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,"
        " PRIMARY KEY (connector_id, tool_name))"
    )
    conn.execute(
        "INSERT INTO connector_tool (connector_id, tool_name, description, crud_type,"
        " first_seen_at, last_seen_at, updated_at) VALUES (?,?,?,?,1,1,1)",
        (CID, "old_row", "", "write"),
    )
    conn.commit()
    conn.close()

    st2 = AgentConfigStore(db)  # 开库即迁移（_migrate_additive）
    rows = {r.tool_name: r for r in st2.list_connector_tools(CID)}
    assert rows["old_row"].destructive is False  # 老行回填默认 0，读取不炸


def test_refresh_never_overwrites_user_config(tmp_path):
    st = _store(tmp_path)
    st.sync_connector_tools(CID, _manifest(("search", "read"), ("create_page", "write")))
    st.set_connector_tool_enabled(CID, "search", False)       # 用户关掉 read 工具
    st.set_connector_tool_enabled(CID, "create_page", True)   # 用户打开 write 工具
    first = {r.tool_name: r for r in st.list_connector_tools(CID)}

    # refresh：description/schema 变了 → 覆盖；enabled / first_seen_at → 永不覆盖。
    updated = _manifest(("search", "read"), ("create_page", "write"))
    updated[0]["description"] = "NEW desc"
    stats = st.sync_connector_tools(CID, updated)
    assert stats["updated"] == 2 and stats["inserted"] == 0
    rows = {r.tool_name: r for r in st.list_connector_tools(CID)}
    assert rows["search"].description == "NEW desc"
    assert rows["search"].enabled is False
    assert rows["create_page"].enabled is True
    assert rows["search"].first_seen_at == first["search"].first_seen_at


def test_vanished_tool_marked_orphan_and_revives(tmp_path):
    st = _store(tmp_path)
    st.sync_connector_tools(CID, _manifest(("search", "read"), ("old_tool", "write")))
    st.set_connector_tool_enabled(CID, "old_tool", True)

    stats = st.sync_connector_tools(CID, _manifest(("search", "read")))
    assert stats["orphaned"] == 1
    rows = {r.tool_name: r for r in st.list_connector_tools(CID)}
    assert rows["old_tool"].orphan is True
    assert rows["old_tool"].enabled is True  # 配置行保留（用户偏好）

    # 远端复活 → orphan 清零，用户配置仍在。
    st.sync_connector_tools(CID, _manifest(("search", "read"), ("old_tool", "write")))
    rows2 = {r.tool_name: r for r in st.list_connector_tools(CID)}
    assert rows2["old_tool"].orphan is False
    assert rows2["old_tool"].enabled is True


def test_sync_tools_rejects_bad_manifest(tmp_path):
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        st.sync_connector_tools(CID, [{"name": "", "crud_type": "read"}])
    with pytest.raises(ValueError):
        st.sync_connector_tools(CID, [{"name": "x", "crud_type": "purge"}])
    with pytest.raises(ValueError):
        st.sync_connector_tools(
            CID, _manifest(("dup", "read")) + _manifest(("dup", "write"))
        )
    # 坏 manifest 整批拒 —— 不留半截清单。
    assert st.list_connector_tools(CID) == []


# ── delete 类：写侧拒启用 + 读侧防御纵深 ─────────────────────────────────────────


def test_delete_class_cannot_be_enabled_write_side(tmp_path):
    st = _store(tmp_path)
    st.sync_connector_tools(CID, _manifest(("delete_page", "delete")))
    with pytest.raises(ValueError):
        st.set_connector_tool_enabled(CID, "delete_page", True)
    # 显式关 / 清覆盖照常可写。
    st.set_connector_tool_enabled(CID, "delete_page", False)
    st.set_connector_tool_enabled(CID, "delete_page", None)
    with pytest.raises(KeyError):
        st.set_connector_tool_enabled(CID, "ghost", True)


def test_effective_enabled_resolution():
    # 默认：read 开，write/update 关。
    assert connector_tool_effective_enabled("read", None) is True
    assert connector_tool_effective_enabled("write", None) is False
    assert connector_tool_effective_enabled("update", None) is False
    # 用户覆盖优先。
    assert connector_tool_effective_enabled("read", False) is False
    assert connector_tool_effective_enabled("write", True) is True
    # 🔴 delete 恒 False —— 任何 override 压不开（读侧防御纵深；写侧已拒）。
    assert connector_tool_effective_enabled("delete", None) is False
    assert connector_tool_effective_enabled("delete", True) is False
