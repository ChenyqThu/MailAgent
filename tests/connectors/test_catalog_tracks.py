"""双轨预置目录（08-06）：direct 条目带官方端点、composio 条目不带、换轨判据、定义解析。

零网络、零真实 key —— 全是纯数据 + `registry` 的解析路径。
"""

from __future__ import annotations

import pytest

from src.connectors.catalog import (
    CONNECTOR_TRACKS,
    DIRECT_CATALOG,
    catalog_ids,
    catalog_views,
    get_direct_entry,
    row_is_off_track,
    source_for_track,
    track_for,
    validate_direct_catalog,
)
from src.connectors.composio_catalog import COMPOSIO_CATALOG


def test_direct_catalog_self_check_passes():
    """import 期已跑过一次；显式再跑一次，让「加错数据」在这条用例上有名字。"""
    validate_direct_catalog()


def test_notion_and_atlassian_are_the_direct_track():
    """owner 拍板：这两家走自建直连（Composio 的 OAuth app 要公司 IT 同意，拿不到）。"""
    assert set(DIRECT_CATALOG) == {"notion", "atlassian"}
    assert track_for("notion") == "direct"
    assert track_for("atlassian") == "direct"


def test_direct_entries_carry_the_official_endpoint():
    """跨 lane 契约 §3：direct 条目**必须**带 server_url（否则「还没连过的直连家」点连接
    会走到 client.session 才以一个假的 not-connected 面目失败）。"""
    assert DIRECT_CATALOG["notion"].server_url == "https://mcp.notion.com/mcp"
    assert (
        DIRECT_CATALOG["atlassian"].server_url == "https://mcp.atlassian.com/v1/mcp/authv2"
    )
    assert DIRECT_CATALOG["atlassian"].display_name == "Atlassian (Jira / Confluence)"


def test_every_other_service_stays_on_the_composio_track():
    """双轨不是二选一：其余 14 家原样留在托管轨。"""
    composio_ids = set(COMPOSIO_CATALOG) - set(DIRECT_CATALOG)
    assert len(composio_ids) == 14
    for cid in composio_ids:
        assert track_for(cid) == "composio", cid


def test_unknown_id_has_no_track():
    """自定义 MCP 行（WP-24）不在任何目录里 —— 判据必须答 None 而不是猜一条轨。"""
    assert track_for("definitely-not-a-service") is None


def test_catalog_view_direct_entries_have_endpoint_and_no_whitelist():
    """🔴 direct 轨**不套用** Composio 的 curated 白名单（那是 Composio 的 slug 命名，
    官方端点 tools/list 报的是另一套）⇒ toolkits 空、tool_count 为 None。"""
    views = {v.connector_id: v for v in catalog_views()}
    notion = views["notion"]
    assert notion.track == "direct"
    assert notion.server_url == "https://mcp.notion.com/mcp"
    assert notion.toolkits == () and notion.tool_count is None


def test_catalog_view_composio_entries_have_whitelist_and_no_endpoint():
    """composio 轨相反：托管 endpoint 要 session 建出来（恒 None），白名单条数如实告知。"""
    gmail = {v.connector_id: v for v in catalog_views()}["gmail"]
    assert gmail.track == "composio"
    assert gmail.server_url is None
    assert gmail.toolkits == ("GMAIL",)
    assert gmail.tool_count == len(COMPOSIO_CATALOG["gmail"].all_tools)


def test_catalog_view_lists_every_id_exactly_once_sorted():
    """两张表的并集，同 id 只出现一次（direct 优先）——否则设置页会渲染出两张 Notion 卡。"""
    views = catalog_views()
    ids = [v.connector_id for v in views]
    assert ids == sorted(ids) == list(catalog_ids())
    assert len(ids) == len(set(ids)) == 16


def test_track_and_source_are_a_bijection():
    assert set(CONNECTOR_TRACKS) == {"direct", "composio"}
    assert source_for_track("direct") == "custom_mcp"
    assert source_for_track("composio") == "composio"
    with pytest.raises(KeyError):
        source_for_track("made-up-track")


# ── 换轨判据（设置页那句迁移提示的唯一来源）──────────────────────────────────────


def test_direct_row_on_a_direct_entry_is_not_off_track():
    """🔴 本 task 修的那个 bug：老判据（custom_mcp + 目录里有同 id）会把**正确的直连行**
    误标成「已被目录取代」，把 owner 诱导去断开重连一遍。"""
    assert row_is_off_track("custom_mcp", "notion") is False
    assert row_is_off_track("custom_mcp", "atlassian") is False


def test_composio_row_on_a_direct_entry_is_off_track():
    """owner 活库那行 atlassian(source=composio)：目录已回到 direct 轨 ⇒ 提示换轨。"""
    assert row_is_off_track("composio", "atlassian") is True


def test_composio_row_on_a_composio_entry_is_not_off_track():
    assert row_is_off_track("composio", "gmail") is False


def test_legacy_direct_row_on_a_composio_entry_is_off_track():
    """WP-12 的原始场景仍成立（老直连行 + 托管轨条目 → 要先断开清配置）。"""
    assert row_is_off_track("custom_mcp", "gmail") is True


def test_a_row_outside_the_catalog_is_never_off_track():
    """WP-24 用户自填 URL 的行永远不该被提示「已被目录取代」。"""
    assert row_is_off_track("custom_mcp", "my-own-mcp") is False


# ── registry 解析 ───────────────────────────────────────────────────────────────


def test_direct_catalog_entry_resolves_to_a_usable_definition(fresh_agent_cfg):
    """库里没行时 direct 条目照样解析出**可用**的 def（带端点 + custom_mcp 装配路线）——
    这就是「还没连过的直连家」点连接能走 loopback OAuth 的原因。"""
    from src.connectors.registry import get_connector_def

    d = get_connector_def("notion")
    assert d.source == "custom_mcp"
    assert d.server_url == "https://mcp.notion.com/mcp"
    assert d.display_name == "Notion"


def test_composio_catalog_entry_still_resolves_without_an_endpoint(fresh_agent_cfg):
    """对位物：托管轨条目仍是空 server_url（拿编出来的 URL 发请求才是真事故）。"""
    from src.connectors.registry import get_connector_def

    d = get_connector_def("gmail")
    assert d.source == "composio" and d.server_url == ""


def test_existing_composio_row_still_wins_over_the_direct_entry(fresh_agent_cfg):
    """🔴 行优先不变（契约 §3：track 是目录侧出厂轨道，source 是行侧既成事实）——
    owner 活库那行 composio 的 atlassian 不会因为目录换了轨就被改写装配路线。"""
    from src.connectors.registry import get_connector_def

    fresh_agent_cfg.upsert_connector(
        "atlassian",
        server_url="https://mcp.composio.test/trs_1",
        display_name="Atlassian",
        source="composio",
    )
    d = get_connector_def("atlassian")
    assert d.source == "composio"
    assert d.server_url == "https://mcp.composio.test/trs_1"


def test_direct_entries_are_reachable_from_get_direct_entry_only_by_id():
    assert get_direct_entry("gmail") is None
    assert get_direct_entry("notion") is not None


# ── 读行**失败**的兜底：direct 条目不许交出端点（否则一次 DB 抖动就真的出网）─────────


def _break_row_lookup(monkeypatch):
    """把 `connector` 行查询换成必抛（锁竞争 / 库损坏的合成版本）。

    打在 `AgentConfigStore.get_connector` 上而不是模块级 `get_agent_config_store` 上：后者带
    `lru_cache`，换成裸函数会让 `fresh_agent_cfg` 的 teardown（`cache_clear()`）自己先炸。
    """
    from src.agent_config.store import AgentConfigStore

    def _boom(self, connector_id):
        raise RuntimeError("agent_config.db is locked (synthetic)")

    monkeypatch.setattr(AgentConfigStore, "get_connector", _boom)


def test_direct_entry_withholds_its_endpoint_when_the_row_lookup_blows_up(
    fresh_agent_cfg, monkeypatch
):
    """🔴 「读不出行」≠「没有行」：读行抛异常时 direct 条目**不得**交出官方端点。

    交出去会发生什么（这条用例守的就是它）：一行**健康的** composio 版 notion/atlassian 在
    DB 抖动的那一刻被解析成直连 def ⇒ 拿 `connector:<id>` 下并不存在的直连 token 去打
    mcp.notion.com —— 真的出网发了 DCR/授权请求（兜底原本承诺的是「失败在本地、零出网」）。

    原先这里还列了第二条后果（失败码 ∈ CONNECTOR_REAUTH_ERROR_CODES ⇒ 那条健康连接被落成
    needs_reauth）。**该后果 08-06 起已由 `service.should_mark_needs_reauth` 独立兜住**（空
    端点抛 `client.ConnectorUnconfigured`，invoke 与 sync 两个落态点都据类型放行；用例在
    `test_service_gate.py` / `test_connector_api.py`）—— 但本用例照旧成立且必须保留：它守的
    是**零出网**，那一条谁也替不了。

    空 server_url ⇒ `client.session` 在**打开传输之前**就显式拒（同 composio 兜底的性质）。
    """
    from src.connectors.registry import get_connector_def

    _break_row_lookup(monkeypatch)
    for cid in ("notion", "atlassian"):
        d = get_connector_def(cid)
        assert d.server_url == "", (
            f"{cid}: 读行失败时仍交出了端点 {d.server_url!r} —— 这会让一次 DB 抖动变成一次"
            f"真实的出网授权请求 + 一条健康连接被误落 needs_reauth"
        )
        # 其余字段照常（这一家仍然「认识」，只是端点不可信）——不退化成 KeyError/404。
        assert d.source == "custom_mcp" and d.display_name


def test_direct_entry_serves_its_endpoint_when_the_row_lookup_says_no_row(
    fresh_agent_cfg,
):
    """反面：查询**正常**返回 None（这家确实没连过）时端点照常交出去。

    没有这一条，上面那条用例可以被「direct 条目一律不带端点」这种过度收紧解法满足，而那会
    把本 task 的正事（还没连过的直连家点连接能起 OAuth）一起废掉。
    """
    from src.connectors.registry import get_connector_def

    d = get_connector_def("notion")
    assert d.server_url == "https://mcp.notion.com/mcp"
    assert d.source == "custom_mcp"


def test_composio_entry_fallback_is_unchanged_when_the_row_lookup_blows_up(
    fresh_agent_cfg, monkeypatch
):
    """composio 轨在异常路径上**行为不变**：照常顶上、照常空 server_url。

    它本来就没有端点可交，「失败在本地、零出网」的安全论证对它一直成立 ⇒ 本次收紧不该顺手
    改动它（改了就是在一个与本 bug 无关的路径上引入新行为）。
    """
    from src.connectors.registry import get_connector_def

    _break_row_lookup(monkeypatch)
    d = get_connector_def("gmail")
    assert d.source == "composio" and d.server_url == "" and d.display_name == "Gmail"


def test_unknown_id_still_raises_when_the_row_lookup_blows_up(fresh_agent_cfg, monkeypatch):
    """读行失败也不该把「这家根本不存在」答成一个 def（KeyError → 404 的语义不变）。"""
    from src.connectors.registry import get_connector_def

    _break_row_lookup(monkeypatch)
    with pytest.raises(KeyError):
        get_connector_def("definitely-not-a-service")
