"""Capability & Context 配置面的 backend-owned 存储（Phase -1 / 0A）。

eval 评测的不是抽象 agent，而是「某一套 agent profile + active skills + memory + rules
版本」下的行为。本模块是该配置面的持久真源：

  - **统一 skill registry**（``agent_skills``）：builtin 懒行（只存 enable 覆盖）+ 用户安装
    skill 全行（携 manifest_json）。merge 进 ``src/skills/registry.all_skills()`` 后自动流向
    ``/api/skills`` + MCP（PR3）。
  - **能力变更审计**（``agent_skill_events``）：install/uninstall/enable/disable/grant_scope，
    与 ``agent_api_key_audit`` 对称。
  - **Standing Context 文档**（``agent_profile_docs`` + ``agent_profile_history``）：4 个用户可
    编辑文档 SOUL/AGENT/RULES/USER 的内容 + 版本历史（支持 rollback）。MEMORY/SKILLS 是投影，
    不存表。

**存储位置铁律**（与 ``src/security/api_keys.py`` 同款）：backend-owned SQLite（默认
``<sync_store 同目录>/agent_config.db``，可经 ``MAILAGENT_AGENT_CONFIG_DB_PATH`` 覆盖）。
**绝不**写 ``ai_chat.db``（其 schema owner 是前端 ``chat_db.ts``，BASE-3 不变式）。表自带
``CREATE TABLE IF NOT EXISTS`` 幂等初始化，**不参与** ``sync_store.db`` 的 ``DB_VERSION`` 体系，
故无需同步前端 ``EXPECTED_DB_VERSION``。

连接纪律（与 api_keys / ReportStore 一致）：store 只持 db_path，连接 per-call 短命 open/close，
WAL 下与 mail-sync writer 并发安全，进程内共享单例零风险。
"""


from __future__ import annotations

import os
from functools import lru_cache
from typing import Optional

from src.agent_config.store_common import (
    ALL_SOURCE_TYPES,
    CONTACT_AGENT_DOC_NAME,
    CONTACT_ORG_FRAME_DOC_NAME,
    INSTALLABLE_SOURCE_TYPES,
    MATTER_AGENT_DOC_NAME,
    MEMORY_DOC_NAME,
    PROFILE_DOC_NAMES,
    PROJECTION_DOC_NAMES,
    SKILL_EVENTS,
    STORABLE_DOC_NAMES,
    AgentConfigStoreBase,
    ConnectorRow,
    ConnectorToolRow,
    ExternalCredentialMeta,
    PolicyRuleRow,
    ProfileDoc,
    ProfileHistoryEntry,
    SkillDraftRow,
    SkillRow,
    SkillTrustRow,
    _SKILL_NAME_RE,
    resolve_enabled,
)
from src.agent_config.store_connectors import AgentConfigConnectorsMixin
from src.agent_config.store_docs import AgentConfigDocsMixin
from src.agent_config.store_policy import AgentConfigPolicyMixin
from src.agent_config.store_skills import AgentConfigSkillsMixin
from src.agent_config.templates import (
    AGENT_TEMPLATE,
    LEGACY_AGENT_TEMPLATE_P0,
    LEGACY_AGENT_TEMPLATE_P1,
    LEGACY_SOUL_TEMPLATE_P0,
    SEED_TEMPLATES,
    SOUL_TEMPLATE,
)

# Canonical connector enums (parsed by tests/config/test_connector_contract_parity.py).
CONNECTOR_TRANSPORTS = ("streamable_http", "sse", "stdio")
#: connector.status 值域（写侧校验）。
#:
#: 🔴 ``needs_reauth`` 与 ``error`` 的二分（PR5）：**授权**失效（过期 / 被撤销 / 从未授权，
#: 即 ``E_CONNECTOR_OAUTH`` / ``E_CONNECTOR_NOT_CONNECTED`` 两码）落 ``needs_reauth`` ——
#: 这是**可行动**的一类：owner 去 Connectors 配置台重连就好。其余故障（超时 / 网络 / 协议）
#: **不落态**（见 connectors/service.py 的落态点）—— 把远端抖一下说成「授权没了」会骗 owner
#: 去做一次无用的重新授权。``error`` 保留：授权流本身炸掉时（client.run_connect_flow 的兜底）
#: 仍写它，且存量行照常读得出来。
#: 🔴 两码命中只是**必要**条件（08-06）：``E_CONNECTOR_NOT_CONNECTED`` 还有「本地就装配不出
#: 请求」那一形状（``client.ConnectorUnconfigured``：端点没解析出来 / Composio key 缺失，
#: 请求一个字节都没发出去），它与超时/网络同性质、同样**不落态**。判定单源
#: ``connectors/service.py::should_mark_needs_reauth``（invoke 与 sync 两个落态点共用）。
CONNECTOR_STATUSES = ("disconnected", "authorizing", "connected", "needs_reauth", "error")

#: connector_tool.crud_type 值域单源（client.derive_crud_type 的产出、写侧校验、以及
#: PR2 注册期过滤都以此为准）。
#:
#: 🔴 **``delete`` 已整体退役**（08-03 owner dogfood 改判，推翻 grill Q3=B / Q16=A）：
#: MCP annotations **没有 delete 语义位**（裁决① 实证），``derive_crud_type`` 结构上不可能
#: 产出它 —— 保留一个不可达的档位只会让「连接工具应该都全部可配置」变成「有一档永远恒灰」。
#: 危险性提示改由**独立的 ``destructive`` 列**承担（审批卡红警告），写类工具恒 HITL 的安全
#: 地板不变。存量 ``crud_type='delete'`` 行由 ``_migrate_additive`` 离线重推导成 write+destructive。
CONNECTOR_CRUD_TYPES = ("read", "write", "update")

#: connector.source 值域（08-05 WP-12，写侧校验）——**canonical 源**：
#: ``composio`` = 预置目录条目，经 Composio 托管 MCP 端点（静态 header 装配、token 托管在
#: Composio、工具入参/返回过其云）；``custom_mcp`` = 直连远端 MCP server（现有 OAuth 2.1 /
#: PKCE / DCR 全套 + loopback 回调），也是**存量直连行**（Notion / Atlassian）的归属。
#:
#: 🔴 默认 ``custom_mcp`` 而不是研究稿建议的 ``composio``：``_migrate_additive`` 补列时存量
#: 行会吃默认值，而存量行**全是**直连的（08-05 之前不存在 composio 行）——默认写成 composio
#: 会把两条老直连行当场标错源，之后所有按 source 分派的地方（client 装配、出站告知、
#: 「已取代」提示）都跟着错。新建 composio 行一律显式传 source。
CONNECTOR_SOURCES = ("composio", "custom_mcp", "managed_local")

#: per-tool 三档值域（08-05 owner 拍板，master-plan WP-10）——**canonical 源**：
#: ``auto`` = 注册且 owner-present 场地免卡执行（read 的 auto 就是既有 silent 行为）；
#: ``ask`` = 注册且 owner-present 场地调用弹卡（无审批宿主的预处理场地 = 不注册，见
#: llm_tools 的 only_auto_tools）；``off`` = 任何场地不注册（吸收旧 ``enabled=0``）。
#: TS 侧两处镜像（gateway ``tools/connector.ts::ConnectorToolMode`` / 设置面
#: ``shared/api/types/connector.ts::ConnectorToolMode``）由
#: ``tests/config/test_connector_contract_parity.py`` 抽取对账（抽取失败必红）。
CONNECTOR_TOOL_MODES = ("auto", "ask", "off")


def connector_tool_effective_mode(
    mode_override: Optional[str],
    *,
    crud_type: str = "read",
    destructive: bool = False,
) -> str:
    """工具的有效档位（纯函数）：用户覆盖优先；无覆盖 → 按权限与破坏性折算。

    Phase 5 安全收紧（对标 Magpie 按类默认权限 + fail-closed 护栏）：
    - ``mode_override`` 显式为 ``'auto' | 'ask' | 'off'`` 时直接生效；
    - ``mode_override is None``：
      - ``destructive=True`` 或 ``crud_type in ("write", "update")`` → 默认 ``"ask"``（需审批）；
      - 非破坏性 ``read`` → 默认 ``"auto"``（免卡只读）。
    - 值域外野值（只可能来自手改 DB——写侧入库即拒）**fail-closed 折算成 ``off``**：一个
      看不懂的档位名绝不能被当成「免卡执行」（镜像 ``ceiling_allows`` 的值域外拒纪律）。
    """
    if mode_override is None:
        if destructive or crud_type in ("write", "update"):
            return "ask"
        return "auto"
    if mode_override in CONNECTOR_TOOL_MODES:
        return mode_override
    return "off"




class AgentConfigStore(
    AgentConfigDocsMixin,
    AgentConfigSkillsMixin,
    AgentConfigConnectorsMixin,
    AgentConfigPolicyMixin,
    AgentConfigStoreBase,
):
    """Unified backend-owned SQLite store for agent profile, skills, connectors, and policy."""


# ---------------------------------------------------------------------------
# 路径解析 + 进程内单例（lazy，镜像 api_keys / deps.py 纪律）
# ---------------------------------------------------------------------------


def agent_config_db_for(sync_store_db_path: str) -> str:
    """从 sync_store.db 路径推 agent_config.db（同目录并列）。"""
    return os.path.join(
        os.path.dirname(os.path.abspath(sync_store_db_path)), "agent_config.db"
    )


def resolve_agent_config_db_path(sync_store_db_path: Optional[str] = None) -> str:
    """agent_config.db 绝对路径 —— serve-api 与 CLI 的统一解析真源。

    优先级（与 api_keys.resolve_api_auth_db_path 同款）：env ``MAILAGENT_AGENT_CONFIG_DB_PATH``
    → 显式 ``sync_store_db_path`` 同目录 → config.sync_store_db_path 同目录 → config 构造失败
    回退 ``<DATA_ROOT>/data/agent_config.db``。
    """
    override = os.environ.get("MAILAGENT_AGENT_CONFIG_DB_PATH")
    if override:
        return os.path.abspath(os.path.expanduser(override))
    if sync_store_db_path:
        return agent_config_db_for(sync_store_db_path)
    try:
        from src.config import config as _config_singleton

        return agent_config_db_for(_config_singleton.sync_store_db_path)
    except Exception:  # noqa: BLE001 — 裸 worktree / 缺 .env：回退 DATA_ROOT
        data_root = os.environ.get("MAILAGENT_DATA_ROOT") or "."
        return os.path.join(os.path.abspath(data_root), "data", "agent_config.db")


@lru_cache(maxsize=1)
def get_agent_config_store() -> AgentConfigStore:
    """进程内 AgentConfigStore 单例（lazy）。store 无状态（只持 db_path），WAL 下并发安全。"""
    return AgentConfigStore(db_path=resolve_agent_config_db_path())


def reset_agent_config_store_cache() -> None:
    """test-only：清单例缓存，让测试切换 ``MAILAGENT_AGENT_CONFIG_DB_PATH`` 后重建。"""
    get_agent_config_store.cache_clear()


__all__ = [
    "ALL_SOURCE_TYPES",
    "AGENT_TEMPLATE",
    "CONNECTOR_CRUD_TYPES",
    "CONNECTOR_SOURCES",
    "CONNECTOR_STATUSES",
    "CONNECTOR_TOOL_MODES",
    "CONNECTOR_TRANSPORTS",
    "CONTACT_AGENT_DOC_NAME",
    "CONTACT_ORG_FRAME_DOC_NAME",
    "INSTALLABLE_SOURCE_TYPES",
    "LEGACY_AGENT_TEMPLATE_P0",
    "LEGACY_AGENT_TEMPLATE_P1",
    "LEGACY_SOUL_TEMPLATE_P0",
    "MATTER_AGENT_DOC_NAME",
    "MEMORY_DOC_NAME",
    "PROFILE_DOC_NAMES",
    "PROJECTION_DOC_NAMES",
    "SEED_TEMPLATES",
    "SKILL_EVENTS",
    "SOUL_TEMPLATE",
    "STORABLE_DOC_NAMES",
    "AgentConfigStore",
    "ConnectorRow",
    "ConnectorToolRow",
    "ExternalCredentialMeta",
    "PolicyRuleRow",
    "ProfileDoc",
    "ProfileHistoryEntry",
    "SkillDraftRow",
    "SkillRow",
    "SkillTrustRow",
    "_SKILL_NAME_RE",
    "agent_config_db_for",
    "connector_tool_effective_mode",
    "get_agent_config_store",
    "reset_agent_config_store_cache",
    "resolve_agent_config_db_path",
    "resolve_enabled",
]
