"""connector / connector_tool 双表（08-01 PR1）：upsert 分工、refresh 纪律、orphan、
effective enabled 折算、delete 档位退役后的存量行迁移。纯单测（tmp_path 直建 store，
无加密面）。"""

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
    # PR5：needs_reauth 是合法值域成员（授权失效落态点写它）；error 保留（存量 + 授权流兜底）。
    st.update_connector_state(CID, status="needs_reauth")
    assert st.get_connector(CID).status == "needs_reauth"
    # last_error / scopes 哨兵：显式 None = 清空，不传 = 不动。
    st.update_connector_state(CID, status="error", last_error="boom")
    assert st.get_connector(CID).last_error == "boom"
    st.update_connector_state(CID, status="connected")
    assert st.get_connector(CID).last_error == "boom"  # 不传不动
    st.update_connector_state(CID, last_error=None)
    assert st.get_connector(CID).last_error is None  # 显式清空


# ── 工具清单 sync：refresh 纪律 + orphan ────────────────────────────────────────


def test_sync_tools_inserts_whole_manifest(tmp_path):
    st = _store(tmp_path)
    stats = st.sync_connector_tools(
        CID, _manifest(("search", "read"), ("create_page", "write"), ("update_page", "update"))
    )
    assert stats == {"total": 3, "inserted": 3, "updated": 0, "orphaned": 0}
    rows = {r.tool_name: r for r in st.list_connector_tools(CID)}
    assert rows["search"].crud_type == "read"
    assert rows["create_page"].crud_type == "write"
    assert rows["update_page"].crud_type == "update"
    # destructive 缺省（manifest 不带键）→ 0。
    assert rows["search"].destructive is False


def test_sync_tools_rejects_retired_delete_crud(tmp_path):
    """🔴 08-03 delete 档位退役：值域外 ⇒ 入库即拒（不再是「入库但恒灰」的保留位）。"""
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        st.sync_connector_tools(CID, _manifest(("delete_page", "delete")))
    assert st.list_connector_tools(CID) == []


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


def _force_stale_delete_row(db: str, tool_name: str) -> None:
    """把一行强改成 PR1 时代的陈旧形状（crud_type='delete' + destructive=0）。

    🔴 只能裸 SQL 造 —— 退役后 ``sync_connector_tools`` 的值域校验根本不收 'delete'，
    这正是「陈旧行只可能来自旧构建」的证据。
    """
    import sqlite3

    conn = sqlite3.connect(db)
    conn.execute(
        "UPDATE connector_tool SET crud_type='delete', destructive=0 WHERE tool_name=?",
        (tool_name,),
    )
    conn.commit()
    conn.close()


def test_stale_delete_rows_migrated_to_write_destructive(tmp_path):
    """🔴 08-03 delete 退役的**装机自愈**：旧构建落的 delete 行开库即离线重推导。

    可证明等价：旧映射产出 delete 的唯一路径是 ``destructive_hint is True``，而当前
    ``derive_crud_type`` 对同一输入产出 write、``derive_destructive`` 产出 True ⇒ 这条
    迁移就是把那次误判按新规则重算一遍，不需要网络 re-sync。用户 ``enabled`` 覆盖不碰。
    """
    db = str(tmp_path / "agent_config.db")
    st = _store(tmp_path)
    st.sync_connector_tools(CID, _manifest(("update_page", "write"), ("search", "read")))
    st.set_connector_tool_enabled(CID, "update_page", False)  # 用户显式关过（配置要保留）
    _force_stale_delete_row(db, "update_page")

    st2 = AgentConfigStore(db)  # 开库即迁移（_migrate_additive）
    rows = {r.tool_name: r for r in st2.list_connector_tools(CID)}
    assert rows["update_page"].crud_type == "write"
    assert rows["update_page"].destructive is True
    assert rows["update_page"].enabled is False  # 用户覆盖一列不碰
    # 无关行不受影响（WHERE crud_type='delete' 之外一行不动）。
    assert rows["search"].crud_type == "read" and rows["search"].destructive is False

    # 幂等：再开一次库，值不再变（WHERE 后已无 delete 行）。
    snapshot = {(r.tool_name, r.crud_type, r.destructive, r.enabled) for r in rows.values()}
    st3 = AgentConfigStore(db)
    again = {
        (r.tool_name, r.crud_type, r.destructive, r.enabled)
        for r in st3.list_connector_tools(CID)
    }
    assert again == snapshot


def test_migrated_stale_delete_row_is_configurable_and_registrable(tmp_path):
    """迁移后的行**不再恒灰**：可启用（写侧不拒）、折算为开、能被 LLM 工厂注册。"""
    from src.connectors.llm_tools import build_connector_llm_tools

    db = str(tmp_path / "agent_config.db")
    st = _store(tmp_path)
    st.upsert_connector(CID, server_url="https://x")
    st.update_connector_state(CID, status="connected", enabled=True)
    st.sync_connector_tools(CID, _manifest(("update_page", "write")))
    _force_stale_delete_row(db, "update_page")

    st2 = AgentConfigStore(db)
    st2.set_connector_tool_enabled(CID, "update_page", True)  # 曾经 ValueError，现在照常写
    row = st2.list_connector_tools(CID)[0]
    assert row.destructive is True  # 危险性提示还在（红警告的数据源）
    assert connector_tool_effective_enabled(row.crud_type, row.enabled) is True

    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr("src.connectors.llm_tools._connectors_enabled", lambda: True)
        monkey.setattr("src.agent_config.store.get_agent_config_store", lambda: st2)
        schemas, handlers = build_connector_llm_tools([(CID, "write")])
    finally:
        monkey.undo()
    assert [s["name"] for s in schemas] == ["mcp__notion__update_page"]
    assert set(handlers) == {"mcp__notion__update_page"}


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


def test_purge_orphans_deletes_only_orphan_rows(tmp_path):
    """PR5 清理出口：只删 orphan=1，在册行（含用户覆盖）一行不碰，返回删除计数。"""
    st = _store(tmp_path)
    st.sync_connector_tools(
        CID, _manifest(("search", "read"), ("old_a", "write"), ("old_b", "write"))
    )
    st.set_connector_tool_enabled(CID, "search", False)  # 在册工具的用户覆盖
    st.set_connector_tool_enabled(CID, "old_a", True)
    st.sync_connector_tools(CID, _manifest(("search", "read")))  # old_a/old_b 变 orphan

    assert st.purge_orphan_connector_tools(CID) == 2
    rows = {r.tool_name: r for r in st.list_connector_tools(CID)}
    assert set(rows) == {"search"}
    assert rows["search"].enabled is False  # 覆盖存活

    # 幂等 + 空集：没得删 → 0（不抛）。未知 connector 同样 0（删空不是错）。
    assert st.purge_orphan_connector_tools(CID) == 0
    assert st.purge_orphan_connector_tools("ghost") == 0

    # 清理不是「拉黑」：远端再有同名工具 → 下次 sync 照常 INSERT 回来（默认态）。
    st.sync_connector_tools(CID, _manifest(("search", "read"), ("old_a", "write")))
    revived = {r.tool_name: r for r in st.list_connector_tools(CID)}
    assert revived["old_a"].orphan is False
    assert revived["old_a"].enabled is None  # 行被删过 → 用户覆盖不复存在


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


# ── per-tool 启用覆盖：在册行一律可配置 ──────────────────────────────────────────


def test_every_listed_tool_is_configurable_write_side(tmp_path):
    """🔴 08-03 改判：任何在册工具（含 destructive）都能被 owner 开 —— 没有恒灰的一档。"""
    st = _store(tmp_path)
    manifest = _manifest(("update_page", "update"))
    manifest[0]["destructive"] = True
    st.sync_connector_tools(CID, _manifest(("search", "read")) + manifest)
    for name in ("search", "update_page"):
        for value in (True, False, None):
            st.set_connector_tool_enabled(CID, name, value)
    rows = {r.tool_name: r for r in st.list_connector_tools(CID)}
    assert rows["update_page"].destructive is True  # 危险性只是红警告位，不是禁令
    st.set_connector_tool_enabled(CID, "update_page", True)
    assert st.list_connector_tools(CID)[1].enabled is True
    # 不在册的名字仍拒（白名单纪律没松）。
    with pytest.raises(KeyError):
        st.set_connector_tool_enabled(CID, "ghost", True)


def test_effective_enabled_resolution():
    # 默认：read 开，write/update 关。
    assert connector_tool_effective_enabled("read", None) is True
    assert connector_tool_effective_enabled("write", None) is False
    assert connector_tool_effective_enabled("update", None) is False
    # 用户覆盖优先 —— 三档都压得动（08-03 起没有恒 False 的档位）。
    assert connector_tool_effective_enabled("read", False) is False
    assert connector_tool_effective_enabled("write", True) is True
    assert connector_tool_effective_enabled("update", True) is True


# ── 分类侧独立授权位（PR3 坑 3）──────────────────────────────────────────────────


def test_preprocess_enabled_defaults_off_and_roundtrips(tmp_path):
    """默认 0（分类侧默认拿不到任何 connector）；置位可读回、可关回。"""
    st = _store(tmp_path)
    st.upsert_connector(CID, server_url="https://x")
    assert st.get_connector(CID).preprocess_enabled is False  # 默认关 = inert

    st.set_connector_preprocess_enabled(CID, True)
    assert st.get_connector(CID).preprocess_enabled is True
    assert st.list_connectors()[0].preprocess_enabled is True

    st.set_connector_preprocess_enabled(CID, False)
    assert st.get_connector(CID).preprocess_enabled is False


def test_preprocess_enabled_unknown_connector_raises(tmp_path):
    st = _store(tmp_path)
    with pytest.raises(KeyError):
        st.set_connector_preprocess_enabled("ghost", True)


def test_preprocess_enabled_column_added_to_pre_pr3_db(tmp_path):
    """幂等加列迁移：PR1/PR2 老库（connector 无 preprocess_enabled 列）重开即补列，默认关。"""
    import sqlite3

    db = str(tmp_path / "agent_config.db")
    _store(tmp_path)  # 先建新库拿到其余表
    conn = sqlite3.connect(db)
    conn.execute("DROP TABLE connector")
    conn.execute(
        "CREATE TABLE connector ("
        " connector_id TEXT PRIMARY KEY, server_url TEXT NOT NULL,"
        " transport TEXT NOT NULL DEFAULT 'streamable_http', display_name TEXT,"
        " status TEXT NOT NULL DEFAULT 'disconnected', enabled INTEGER NOT NULL DEFAULT 1,"
        " scopes_json TEXT, last_error TEXT, last_synced_at INTEGER,"
        " created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    )
    conn.execute(
        "INSERT INTO connector (connector_id, server_url, created_at, updated_at)"
        " VALUES (?,?,1,1)",
        (CID, "https://x"),
    )
    conn.commit()
    conn.close()

    st2 = AgentConfigStore(db)  # 开库即迁移（_migrate_additive）
    assert st2.get_connector(CID).preprocess_enabled is False  # 老行回填默认 0
    st2.set_connector_preprocess_enabled(CID, True)
    assert st2.get_connector(CID).preprocess_enabled is True
    # 重开幂等（不重复 ALTER）。
    assert AgentConfigStore(db).get_connector(CID).preprocess_enabled is True
