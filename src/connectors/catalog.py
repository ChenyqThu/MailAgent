"""connector 预置目录的**双轨**视图（08-06 owner dogfood 拍板）—— 纯数据 + 纯函数。

WP-12 把目录收敛成 Composio 单轨；08-06 dogfood 证伪了「单轨够用」这个前提：Composio 的
OAuth app 会去要**公司租户**的管理员同意（落到 Omada 的 IdP 就需要 IT 批），owner 拿不到
⇒ Atlassian 在 Composio 轨上结构性连不上。而我们自己那条 MCP OAuth 2.1 + PKCE + DCR 直连
打的是**官方** MCP 端点、授权页是官方自己的，不需要任何第三方 app 审批。⇒ 双轨并存：

  - ``direct``   —— 本模块 ``DIRECT_CATALOG``（Notion / Atlassian）：条目自带官方
    ``server_url``，连接走 ``client.run_connect_flow``（loopback OAuth + DCR）。
  - ``composio`` —— ``composio_catalog.COMPOSIO_CATALOG`` 的其余 14 家：托管 MCP，
    连接走 ``composio_flow.run_composio_connect_flow``。
  - ``managed_local`` —— 本模块 ``MANAGED_LOCAL_CATALOG``（``browser_use`` /
    ``desktop_use``）：受管本机 stdio MCP 运行时，一键装入 ``<userData>/mcp-runtimes/``。

🔴 **direct 轨不套用 Composio 的 curated 白名单**：那份白名单是 Composio 自己的 slug 命名
（``NOTION_FETCH_DATA`` 等），官方 MCP 端点 ``tools/list`` 自报的是完全另一套名字，套过去
只会得到一份对不上的假清单。故统一视图对 direct 条目恒发 ``toolkits=()`` /
``tool_count=None`` —— 清单以实际 ``tools/list`` 返回为准（这正是 WP-12 之前的行为）。

🔴 **notion / atlassian 两个 id 在两张表里都有，且 COMPOSIO_CATALOG 那两条不是死数据**：
目录侧（= 新连接的出厂轨道）**direct 优先**；但已经连成 composio 的**存量行**（owner 活库
里就有一行 atlassian）在 ``registry.get_connector_def`` 里行优先，仍解析成 composio 定义、
仍走 composio 流去重连/续期。``track``（目录侧出厂轨道）与 ``connector.source``（行侧既成
事实）是两件事 —— 换轨的唯一出口是 ``disconnect(purge=true)`` 后重连（``row_is_off_track``
就是设置页那句迁移提示的判据）。

零第三方 import（与 ``composio_catalog`` 同款纪律）：裸 worktree / 未装 mcp SDK 时照样
import 得动，router 才能在模块级薄封装里用它。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from src.connectors.composio_catalog import COMPOSIO_CATALOG, get_catalog_entry

#: 目录条目的出厂轨道值域（**canonical 源**）。镜像 TS
#: ``frontend/src/shared/api/types/connector.ts::ConnectorTrack``，闸在
#: ``tests/config/test_connector_contract_parity.py``。
CONNECTOR_TRACKS: tuple[str, ...] = ("direct", "composio", "managed_local")

#: 轨道 → 该轨连出来的行在 ``connector.source`` 列上的值（``store.CONNECTOR_SOURCES``）。
#: 🔴 两套词表**只在这里**对接：别处再写一次 `'direct' → 'custom_mcp'` 就是第二处手抄。
#: 值域相等由 parity 闸断言（这里刻意不 import store —— 本模块要保持零重依赖）。
TRACK_TO_SOURCE: dict[str, str] = {
    "direct": "custom_mcp",
    "composio": "composio",
    "managed_local": "managed_local",
}


@dataclass(frozen=True)
class DirectCatalogEntry:
    """直连轨的一条预置条目（= 官方 remote MCP 端点的出厂定义）。

    比 ``ComposioCatalogEntry`` **少** toolkits / curated 白名单：直连轨没有这两个概念
    （见模块 docstring 的红标）。
    """

    connector_id: str
    display_name: str
    #: 官方 remote MCP 端点（epic research 实测过 ``.well-known``）。
    server_url: str
    description_key: str
    category: str
    logo_text: str
    logo_color: str


#: 直连轨预置条目。端点值 = WP-12 退役掉的那张常量表原文（`git show b249bf92^`）。
DIRECT_CATALOG: dict[str, DirectCatalogEntry] = {
    "notion": DirectCatalogEntry(
        connector_id="notion",
        display_name="Notion",
        server_url="https://mcp.notion.com/mcp",
        description_key="settings.connectors.catalog.desc.notion",
        category="notes",
        logo_text="N",
        logo_color="#111111",
    ),
    "atlassian": DirectCatalogEntry(
        connector_id="atlassian",
        display_name="Atlassian (Jira / Confluence)",
        server_url="https://mcp.atlassian.com/v1/mcp/authv2",
        description_key="settings.connectors.catalog.desc.atlassian",
        category="work",
        logo_text="A",
        logo_color="#0052CC",
    ),
}


@dataclass(frozen=True)
class ManagedLocalCatalogEntry:
    """受管本机 stdio 运行时预置条目（WS-3：``browser_use`` / ``desktop_use``）。"""

    connector_id: str
    display_name: str
    description_key: str
    category: str
    logo_text: str
    logo_color: str
    default_mode: Optional[str] = None
    supported_modes: tuple[str, ...] = ()
    requires_permissions: tuple[str, ...] = ()
    supported_platforms: tuple[str, ...] = ()
    package_spec: str = ""


MANAGED_LOCAL_CATALOG: dict[str, ManagedLocalCatalogEntry] = {
    "browser_use": ManagedLocalCatalogEntry(
        connector_id="browser_use",
        display_name="Browser Use",
        description_key="settings.connectors.catalog.desc.browser_use",
        category="browser",
        logo_text="B",
        logo_color="#2563EB",
        default_mode="cdp_chrome",
        supported_modes=("cdp_chrome", "extension", "isolated_profile"),
        requires_permissions=(),
        supported_platforms=("darwin", "win32", "linux"),
        package_spec="@playwright/mcp",
    ),
    "desktop_use": ManagedLocalCatalogEntry(
        connector_id="desktop_use",
        display_name="Desktop Use",
        description_key="settings.connectors.catalog.desc.desktop_use",
        category="desktop",
        logo_text="D",
        logo_color="#7C3AED",
        default_mode=None,
        supported_modes=(),
        requires_permissions=("accessibility", "screen_recording"),
        supported_platforms=("darwin", "win32"),
        package_spec="vercel-labs/agent-desktop",
    ),
}


@dataclass(frozen=True)
class CatalogEntryView:
    """一条目录条目的**统一展示形状**（三轨共用；``GET /api/connector/catalog`` 的投影源）。"""

    connector_id: str
    display_name: str
    track: str
    description_key: str
    category: str
    logo_text: str
    logo_color: str
    #: direct 轨恒带（官方端点）；composio / managed_local 轨恒 ``None``。
    server_url: Optional[str]
    #: composio 轨 = curated 白名单覆盖的 toolkit；direct / managed_local 轨恒空。
    toolkits: tuple[str, ...]
    #: composio 轨 = 白名单条数（目录卡如实告知「会开多少个工具」）；direct / managed_local 轨恒 ``None``。
    tool_count: Optional[int]
    supported_modes: tuple[str, ...] = ()
    requires_permissions: tuple[str, ...] = ()
    supported_platforms: tuple[str, ...] = ()


def get_direct_entry(connector_id: str) -> Optional[DirectCatalogEntry]:
    """直连轨目录里有这一家吗（没有 → None，不抛）。"""
    return DIRECT_CATALOG.get(connector_id)


def get_managed_local_entry(connector_id: str) -> Optional[ManagedLocalCatalogEntry]:
    """受管本机目录里有这一家吗（没有 → None，不抛）。"""
    return MANAGED_LOCAL_CATALOG.get(connector_id)


def track_for(connector_id: str) -> Optional[str]:
    """该 id 的**出厂轨道**；三张表都没有 → None（自定义 MCP 行就落这里）。

    🔴 direct 优先：notion / atlassian 同时在 direct 与 composio 两张表里（见模块 docstring）。
    """
    if connector_id in DIRECT_CATALOG:
        return "direct"
    if connector_id in COMPOSIO_CATALOG:
        return "composio"
    if connector_id in MANAGED_LOCAL_CATALOG:
        return "managed_local"
    return None


def source_for_track(track: str) -> str:
    """轨道 → 该轨行的 ``source`` 值；未知轨道 → ``KeyError``（值域外不猜）。"""
    return TRACK_TO_SOURCE[track]


def row_is_off_track(source: str, connector_id: str) -> bool:
    """这一行的装配路线与目录出厂轨道**不符**吗（= 要先断开清配置才能换轨）。

    设置页那句迁移提示 + 目录卡 ``superseded`` 的**唯一**判据。三种取值：

      - 老直连行 + 目录现在是 composio 轨（WP-12 的原始场景）→ True
      - composio 行 + 目录现在是 direct 轨（08-06 双轨后 owner 活库那行 atlassian）→ True
      - 行与轨道一致 / 目录里根本没这一家（自定义 MCP 行）→ False

    🔴 「目录里没有」必须是 False 而不是 True：WP-24 用户自填 URL 的行永远不该被提示
    「已被目录取代」。
    """
    track = track_for(connector_id)
    if track is None:
        return False
    return source_for_track(track) != source


def catalog_ids() -> tuple[str, ...]:
    """三轨目录的全部 id（排序；``registry`` 的 KeyError 文案用）。"""
    return tuple(sorted(set(DIRECT_CATALOG) | set(COMPOSIO_CATALOG) | set(MANAGED_LOCAL_CATALOG)))


def catalog_views(*, include_managed_local: bool = True) -> list[CatalogEntryView]:
    """三轨合一的目录视图（按 id 排序，同 id 只出现一次 —— direct 优先）。

    🔴 轨道归属**只问 ``track_for``**：这里再写一次 `cid in DIRECT_CATALOG` 就是第二处判据，
    与 ``row_is_off_track``（走 ``track_for``）漂开时的症状正是目录卡说自己是 direct、
    ``superseded`` 却按 composio 判 —— 一整轨的正确行被标成「已被取代」。
    """
    out: list[CatalogEntryView] = []
    for cid in catalog_ids():
        track = track_for(cid)
        if track == "direct":
            direct = DIRECT_CATALOG[cid]
            out.append(
                CatalogEntryView(
                    connector_id=direct.connector_id,
                    display_name=direct.display_name,
                    track="direct",
                    description_key=direct.description_key,
                    category=direct.category,
                    logo_text=direct.logo_text,
                    logo_color=direct.logo_color,
                    server_url=direct.server_url,
                    toolkits=(),
                    tool_count=None,
                )
            )
            continue
        if track == "managed_local":
            if not include_managed_local:
                continue
            local = MANAGED_LOCAL_CATALOG[cid]
            out.append(
                CatalogEntryView(
                    connector_id=local.connector_id,
                    display_name=local.display_name,
                    track="managed_local",
                    description_key=local.description_key,
                    category=local.category,
                    logo_text=local.logo_text,
                    logo_color=local.logo_color,
                    server_url=None,
                    toolkits=(),
                    tool_count=None,
                    supported_modes=local.supported_modes,
                    requires_permissions=local.requires_permissions,
                    supported_platforms=local.supported_platforms,
                )
            )
            continue
        entry = get_catalog_entry(cid)
        assert entry is not None  # catalog_ids() 的构造保证（三张表的并集）
        out.append(
            CatalogEntryView(
                connector_id=entry.connector_id,
                display_name=entry.display_name,
                track="composio",
                description_key=entry.description_key,
                category=entry.category,
                logo_text=entry.logo_text,
                logo_color=entry.logo_color,
                server_url=None,
                toolkits=entry.toolkits,
                tool_count=len(entry.all_tools),
            )
        )
    return out


def validate_direct_catalog() -> None:
    """预置目录自检（import 期跑一次）——加错数据当场炸，不等到用户点连接才发现。

    钉住的是「直连条目**必须**带一个可用的 https 端点」：server_url 空/写错的直连条目会一路
    走到 ``client.session``，在那里才以 not-connected 的面目出现（症状与「没授权」完全一样，
    极难查）。
    """
    assert set(TRACK_TO_SOURCE) == set(CONNECTOR_TRACKS), (
        f"TRACK_TO_SOURCE 的键 {sorted(TRACK_TO_SOURCE)} 与 CONNECTOR_TRACKS "
        f"{sorted(CONNECTOR_TRACKS)} 不一致 —— 加轨道必须同时给出它的 source 归属"
    )
    for cid, entry in DIRECT_CATALOG.items():
        if cid != entry.connector_id:
            raise ValueError(
                f"direct catalog key {cid!r} != entry.connector_id {entry.connector_id!r}"
            )
        if not entry.server_url.startswith("https://"):
            raise ValueError(
                f"direct catalog entry {cid!r} must carry an https MCP endpoint, got "
                f"{entry.server_url!r} (a direct entry without a usable endpoint fails later "
                f"as a bogus 'not connected')"
            )
        if not entry.display_name or not entry.logo_text or not entry.logo_color:
            raise ValueError(f"direct catalog entry {cid!r} is missing display metadata")
    for cid, local in MANAGED_LOCAL_CATALOG.items():
        if cid != local.connector_id:
            raise ValueError(
                f"managed_local catalog key {cid!r} != entry.connector_id {local.connector_id!r}"
            )
        if cid in DIRECT_CATALOG or cid in COMPOSIO_CATALOG:
            raise ValueError(
                f"managed_local catalog id {cid!r} collides with direct/composio catalog"
            )
        if local.supported_modes and local.default_mode not in local.supported_modes:
            raise ValueError(
                f"managed_local entry {cid!r} default_mode={local.default_mode!r} not in {local.supported_modes!r}"
            )
        if not local.display_name or not local.logo_text or not local.logo_color:
            raise ValueError(f"managed_local catalog entry {cid!r} is missing display metadata")


validate_direct_catalog()
