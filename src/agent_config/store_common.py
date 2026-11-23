"""Shared constants, dataclasses, DDL, row mappers, and base connection logic for AgentConfigStore."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterable, Iterator, Optional

from src.agent_config.templates import (
    AGENT_TEMPLATE,
    LEGACY_AGENT_TEMPLATE_P0,
    LEGACY_AGENT_TEMPLATE_P1,
    LEGACY_SOUL_TEMPLATE_P0,
    SOUL_TEMPLATE,
)

# ---------------------------------------------------------------------------
# 概念常量
# ---------------------------------------------------------------------------

# 用户可编辑、落 agent_profile_docs 的 4 个文档。这 4 份组装成 standing_context（可信身份）。
PROFILE_DOC_NAMES: tuple[str, ...] = ("soul", "agent", "rules", "user")
# memory.md（Hermes 式有界记忆）—— 也落 agent_profile_docs（复用 content + history/rollback），
# 但**刻意排除出 PROFILE_DOC_NAMES**：它是 auto-capture 抽取的、源自不可信邮件正文的记忆，
# 单独经 /chat/config 的 memorySummary（MEMORY fence，untrusted 背景）注入，不进 standing_context
# 那 4 份可信身份、不进 profile_hash。seed 为空串（首次 get 落一行空 doc）。
MEMORY_DOC_NAME: str = "memory"
# 事项跟进 Agent 的任务契约（Matters P6-B D3/D17）—— 同样落 agent_profile_docs 复用
# content + history/rollback，同样**刻意排除出 PROFILE_DOC_NAMES**：它只在 matter
# followup 的 headless run spec 里当任务契约用，不该注入到每一次普通对话的身份里。
# 🔴 seed 为空：行缺失或内容为空时 run_spec 逐字回落代码里的 _TASK_CONTRACT，
# 所以「用户从没编辑过」== 「跟随代码默认」，以后改默认文案能自动惠及未自定义的用户；
# 「恢复默认」也就等于把这行清空，而不是把当前默认文本写进库里冻住。
MATTER_AGENT_DOC_NAME: str = "matter_agent"
CONTACT_AGENT_DOC_NAME: str = "contact_agent"
# 通讯录组织框架同样复用 profile docs：同时喂画像与治理两个 agent，不进 standing_context。
# 🔴 seed 为空；owner 清空即表示不约束，画像/治理都回到代码默认行为。
CONTACT_ORG_FRAME_DOC_NAME: str = "contact_org_frame"
# 可存储（落表 + get/set/history/rollback）的全部 doc 名 = 4 份身份 + memory.md + 事项契约。
STORABLE_DOC_NAMES: tuple[str, ...] = PROFILE_DOC_NAMES + (
    MEMORY_DOC_NAME,
    MATTER_AGENT_DOC_NAME,
    CONTACT_AGENT_DOC_NAME,
    CONTACT_ORG_FRAME_DOC_NAME,
)
# 投影文档（只读视图，SKILLS 来自 skill registry）—— 不存表。
PROJECTION_DOC_NAMES: tuple[str, ...] = ("skills",)

# 可安装 skill 的来源类型（builtin 来自代码，不算"安装"）。
INSTALLABLE_SOURCE_TYPES: tuple[str, ...] = (
    "local_folder",
    "skill_pack",
    "document",
    "mcp",
    "user_created",
)
ALL_SOURCE_TYPES: tuple[str, ...] = ("builtin",) + INSTALLABLE_SOURCE_TYPES

# R5（GPT-5.5 review）—— skill_name 必须是规范 slug：小写字母开头，[a-z0-9_-]，≤41 字符。
# 防「名为 foo 的行投影成 manifest skill bar」/ @mention 与 enable/disable 解析漂移 /
# 含空格·大写·斜杠·unicode 标点的脏名进 registry。
_SKILL_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,40}$")

# skill 能力变更事件类型（审计）。
SKILL_EVENTS: tuple[str, ...] = (
    "install",
    "uninstall",
    "enable",
    "disable",
    "grant_scope",
)


def _now() -> int:
    return int(time.time())


def _now_iso() -> str:
    """UTC ISO 时间戳（policy_rules.created_at/last_used_at 用 —— ADR SQL 定义为 TEXT）。"""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _hash(text: str) -> str:
    """文本 → sha256 hex（content_hash / profile_hash 用，与 api_keys._hash_key 同算法）。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


#: 「参数未传」哨兵（``update_connector_state`` 区分「不动该列」与「显式写 NULL」）。
_UNSET: Any = object()


# ---------------------------------------------------------------------------
# 行投影 dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SkillRow:
    """``agent_skills`` 行投影。``manifest`` 已解析（builtin 行为 None —— manifest 来自代码）。"""

    skill_name: str
    source_type: str
    enabled: Optional[bool]  # None=无覆盖（回退 manifest/code 默认）；True/False=用户覆盖
    granted_scopes: tuple[str, ...]
    # Deprecated dead column. P8 起版本信任唯一真源 = agent_skill_trust；保留列与 upsert 仅为
    # additive schema 兼容，任何运行时判定都不得读取本字段。
    trusted: bool
    source_uri: Optional[str] = None
    version: Optional[str] = None
    manifest_version: Optional[str] = None
    manifest: Optional[dict[str, Any]] = None
    package_hash: Optional[str] = None
    last_error: Optional[str] = None
    installed_at: int = 0
    updated_at: int = 0
    # S2 W2 供应链：{relpath: sha256} 逐文件 hash（执行时完整性校验用，W1/W4 消费）+ 首跑闸记录。
    files_json: Optional[str] = None
    first_run_approved: Optional[str] = None
    upstream_meta: Optional[dict[str, Any]] = None

    @property
    def is_builtin(self) -> bool:
        return self.source_type == "builtin"


@dataclass(frozen=True)
class PolicyRuleRow:
    """``policy_rules`` 行投影（ADR-001 §6 D4）。``matcher`` 为已解析 dict（结构化 typed matcher）。"""

    id: int
    capability: str
    matcher: dict[str, Any]
    context_mode: str
    agent_id: Optional[str]
    enabled: bool
    note: Optional[str]
    created_at: str
    last_used_at: Optional[str]
    use_count: int


@dataclass(frozen=True)
class SkillDraftRow:
    id: str
    name: str
    status: str
    root_path: str
    manifest: Optional[dict[str, Any]]
    validation: Optional[dict[str, Any]]
    source_session_id: Optional[int]
    created_at: int
    updated_at: int


@dataclass(frozen=True)
class SkillTrustRow:
    id: str
    skill_name: str
    package_hash: str
    entrypoint: str
    policy: dict[str, Any]
    trusted_at: int
    revoked_at: Optional[int]


@dataclass(frozen=True)
class ExternalCredentialMeta:
    """``external_credential`` 的**非敏感**行投影 —— 只含明文列，**永不含 payload**。

    peek / list 的返回类型：设置页据此展示「这个连接存了什么、什么时候过期、什么时候更新的」，
    整条路径不触碰 Fernet（master key 不可用时依然可读）。
    """

    namespace: str
    credential_key: str
    expires_at: Optional[int]  # epoch 秒；None = 不过期 / 未知
    metadata: dict[str, Any]  # 明文非敏感元数据（坏 JSON → {}）
    created_at: int
    updated_at: int


@dataclass(frozen=True)
class ConnectorRow:
    """``connector`` 行投影（MCP connector 连接元数据；凭证另在 external_credential）。"""

    connector_id: str
    server_url: str
    transport: str
    display_name: Optional[str]
    status: str
    enabled: bool
    scopes: Optional[list[str]]  # scopes_json 解出（坏 JSON / NULL → None）
    last_error: Optional[str]
    last_synced_at: Optional[int]
    created_at: int
    updated_at: int
    #: PR3：邮件预处理分类是否获授权用这个 connector（独立于 custom agent 的 grant_connectors；
    #: 天花板恒 read，见 DDL 注释）。默认 False。
    preprocess_enabled: bool = False
    #: 08-05 WP-12（Composio 单轨）：这一行的**装配路线**。``'composio'`` = 预置目录条目
    #: （托管 MCP 端点 + 静态 header）；``'custom_mcp'`` = 直连远端 MCP（OAuth 2.1/PKCE/DCR），
    #: 也是**存量直连行**（Notion / Atlassian）升级后的归属。默认 custom_mcp——见 DDL 注释。
    source: str = "custom_mcp"
    #: composio 行的 tool-router session id（明文非敏感；服务端持久，复用而非每次重建）。
    composio_session_id: Optional[str] = None
    #: Phase 5 (WP-5B.4) — 自定义 HTTP header 名称与 stdio 配置（非密元数据；密文另存 BLOB 列）。
    custom_header_names: tuple[str, ...] = ()
    stdio_command: Optional[dict[str, Any]] = None
    stdio_env_keys: tuple[str, ...] = ()
    #: WS-3：managed_local 运行时配置（例如 browser_use 的 {"mode": "cdp_chrome", "cdp_url": ...}）。
    runtime_config: Optional[dict[str, Any]] = None



@dataclass(frozen=True)
class ConnectorToolRow:
    """``connector_tool`` 行投影（远端工具清单一行；schema 保持 JSON 字符串，读方自解）。"""

    connector_id: str
    tool_name: str
    description: str
    input_schema_json: Optional[str]
    output_schema_json: Optional[str]
    crud_type: str
    #: 裁决①（PR2）：manifest ``destructive_hint`` 单独落列（破坏性**更新**语义位，不是
    #: crud 档位）——审批卡红警告消费；manifest 派生字段，refresh 覆盖。08-03 delete 档位
    #: 退役后，**这一列是危险性的唯一表示**。
    destructive: bool
    #: 🔴 旧 per-tool 启用覆盖（08-05 per-tool 三档改判后**退役为死列**）：写侧只写 ``mode``，
    #: 本字段仅供迁移取证/回滚参考，任何折算/闸判都不许再读它。
    enabled: Optional[bool]
    orphan: bool
    first_seen_at: int
    last_seen_at: int
    updated_at: int
    #: per-tool 三档：``'auto' | 'ask' | 'off'``；
    #: None = 跟随默认（``connector_tool_effective_mode``：非破坏性 ``read`` 默认 ``auto``，
    #: ``write`` / ``update`` / ``destructive`` 默认 ``ask``）。用户配置——
    #: refresh 纪律 2「永不覆盖」原样适用。
    mode: Optional[str] = None



@dataclass(frozen=True)
class ProfileDoc:
    doc_name: str
    content: str
    content_hash: str
    updated_by: str
    updated_at: int


@dataclass(frozen=True)
class ProfileHistoryEntry:
    id: int
    doc_name: str
    old_hash: Optional[str]
    new_hash: str
    content_snapshot: str  # 该版本的完整内容（支持 rollback —— full snapshot 比 reverse-patch 可靠）
    changed_by: str
    session_id: Optional[int]
    message_id: Optional[int]
    created_at: int


# ---------------------------------------------------------------------------
# enabled 三级回退（纯函数，无 I/O —— 易单测）
# ---------------------------------------------------------------------------


def resolve_enabled(
    row_enabled: Optional[bool],
    manifest_default: Optional[bool] = None,
    code_default: bool = False,
) -> bool:
    """skill 的有效启用态：``row.enabled ?? manifest.default_enabled ?? code.default``。

    - ``row_enabled`` 非 None（用户显式覆盖）→ 直接用。
    - 否则 ``manifest_default`` 非 None（manifest 编译期种子）→ 用它。
    - 否则回退 ``code_default``（builtin 代码默认；installed 缺 manifest 时的兜底）。
    """
    if row_enabled is not None:
        return row_enabled
    if manifest_default is not None:
        return manifest_default
    return code_default


# ---------------------------------------------------------------------------
# DDL —— 幂等，不进 DB_VERSION
# ---------------------------------------------------------------------------

_DDL = """
CREATE TABLE IF NOT EXISTS agent_skills (
    skill_name          TEXT PRIMARY KEY,
    source_type         TEXT NOT NULL,
    source_uri          TEXT,
    version             TEXT,
    manifest_version    TEXT,
    manifest_json       TEXT,
    enabled             INTEGER,
    granted_scopes_json TEXT,
    package_hash        TEXT,
    trusted             INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    installed_at        INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    -- S2 W2 供应链：逐文件 sha256（{relpath: sha256} JSON）+ 首跑闸记录（W1/W4 消费，本 wave 只建列）。
    files_json          TEXT,
    first_run_approved  TEXT,
    upstream_meta_json  TEXT
);

-- S2 W2 per-skill 密钥：值列只存密文（W3 填 Fernet 加解密，本 wave 只建表）。DB/审计只见名字，
-- 值永不进 prompt / manifest_json / agent_skill_events.detail_json / 日志。
CREATE TABLE IF NOT EXISTS skill_secrets (
    skill_name       TEXT NOT NULL,
    secret_name      TEXT NOT NULL,
    value_ciphertext BLOB NOT NULL,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (skill_name, secret_name)
);

-- 阶段 0a 外部服务授权凭证：**形状不可知**的通用密文 blob（OAuth token set / OAuth client_info /
-- IM 自建应用 app 凭证都装得下 —— payload 是 Fernet(JSON)，本层不解析其结构）。
-- 与 skill_secrets 的分工：那张表是**注入子进程 env** 的 per-skill 键值（故名字受 env-regex +
-- reserved deny-list 约束）；本表**永不进 env**，是外部服务的授权材料，两者物理隔离、命名规则无关。
-- 🔴 expires_at 是**明文列**（epoch 秒，NULL=不过期/未知）—— 设置页展示连接健康状态、阶段 1 懒刷新
-- 判提前量都只读这一列，**不解密 payload**（master key 不可用时这些查询照样成立）。
-- metadata_json 同为明文（账号 label / scope 列表这类非敏感展示位），**不放任何凭证值**。
CREATE TABLE IF NOT EXISTS external_credential (
    namespace          TEXT NOT NULL,   -- 'connector:notion' | 'im:feishu' —— <kind>:<provider>
    credential_key     TEXT NOT NULL,   -- 'tokens' | 'client_info' | 'app_secret'
    payload_ciphertext BLOB NOT NULL,   -- Fernet(JSON)，形状不可知
    expires_at         INTEGER,         -- 明文 epoch 秒；NULL = 不过期 / 未知
    metadata_json      TEXT,            -- 明文非敏感元数据（展示用）
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    PRIMARY KEY (namespace, credential_key)
);

CREATE TABLE IF NOT EXISTS agent_skill_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_name  TEXT NOT NULL,
    event       TEXT NOT NULL,
    detail_json TEXT,
    session_id  INTEGER,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_events_name ON agent_skill_events(skill_name, created_at DESC);

-- S2 W1 exec 策略：结构化白名单规则（ADR-001 §6 D4）。matcher_json 是 typed matcher（带 "v":1
-- 版本位），**永不**字符串前缀匹配（防 `curl good | curl evil` 类逃逸）。context_mode 绑定（红线①）
-- = manual 规则永不匹配 untrusted 触发查询。agent_id 为 S4 per-agent 规则预留（S2 恒 NULL）。
-- 规则**只**由 owner 显式动作产生（审批卡「总是允许」/ Settings），模型无任何创建通道（policy_rules
-- 不暴露任何 gateway 工具）。created_at/last_used_at 存 ISO 文本（与 skill_secrets.updated_at 同风格）。
CREATE TABLE IF NOT EXISTS policy_rules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    capability   TEXT NOT NULL,          -- 'exec' | 'file_read' | 'file_write' | 'web'
    matcher_json TEXT NOT NULL,          -- 结构化 matcher（带 "v":1 版本位）
    context_mode TEXT NOT NULL DEFAULT 'manual_chat',
    agent_id     TEXT,                   -- NULL=全局(manual)；S5 起 per-agent 规则（严格等值键，ADR-004）
    enabled      INTEGER NOT NULL DEFAULT 1,
    note         TEXT,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    use_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_policy_rules_lookup
    ON policy_rules(capability, context_mode, enabled);

-- S5 per-agent 规则查询索引（ADR-004 §3.3，codex P1-5；additive，agent_config.db 镜像 api_keys
-- 纪律不进 DB_VERSION —— DDL 幂等，老库下次 store 初始化自动补建）。
CREATE INDEX IF NOT EXISTS idx_policy_rules_agent
    ON policy_rules(capability, context_mode, agent_id, enabled);

-- 07-16 approval-mode switcher：owner 级全局设置 kv（首个键 chat_approval_mode ——
-- chat 授权模式的持久真源；08-05 WP-11 起值域收窄为 manual/bypass，acceptEdits 退役为
-- per-tool 档预设，存量值由 _migrate_additive 一次性折算）。另一键
-- send_recipient_whitelist（08-05 WP-11 D2）= send 收件人白名单 JSON 数组（空/缺行 =
-- send 恒 ask）。镜像 policy_rules 纪律：值**只**由 owner 显式 UI 动作写入（serve-api
-- verify_cf_access 端点），模型无任何 gateway 工具通道。
CREATE TABLE IF NOT EXISTS owner_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 08-05 WP-11 —— built-in 写工具的 per-tool 审批档**显式覆盖**行（出厂默认在代码：
-- src/agent_config/tool_prefs.py canonical 注册表；无行 = 跟随默认）。tier 值域 =
-- TOOL_APPROVAL_TIERS（ask|auto|deny，写侧校验，无 SQL CHECK）。镜像 policy_rules /
-- owner_settings 纪律：**只**由 owner UI 写入（/api/agent/tool-prefs 端点），无任何
-- gateway 工具可写；只作用于 manual_chat（gateway 只在 manual run 上拉取消费）。
CREATE TABLE IF NOT EXISTS tool_approval_pref (
    tool_name  TEXT PRIMARY KEY,
    tier       TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_profile_docs (
    doc_name     TEXT PRIMARY KEY,
    content      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_by   TEXT NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_profile_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_name         TEXT NOT NULL,
    old_hash         TEXT,
    new_hash         TEXT NOT NULL,
    content_snapshot TEXT NOT NULL,
    changed_by       TEXT NOT NULL,
    session_id       INTEGER,
    message_id       INTEGER,
    created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_history_doc ON agent_profile_history(doc_name, created_at DESC);

-- MCP connector 双表（08-01 阶段 1 PR1，LobeHub 双表模型）。凭证不在这——token/client_info 走
-- external_credential（namespace='connector:<id>'）；本表只装连接元数据 + 工具清单。
-- transport 留位：MVP 只实现 streamable_http，stdio 不做但 schema 不用改（PRD Assumptions）。
CREATE TABLE IF NOT EXISTS connector (
    connector_id   TEXT PRIMARY KEY,       -- 'gmail' | 'notion' | …（预置目录键，或用户自建 id）
    server_url     TEXT NOT NULL,
    transport      TEXT NOT NULL DEFAULT 'streamable_http',
    display_name   TEXT,
    -- 值域单源 = CONNECTOR_STATUSES（写侧校验，无 SQL CHECK —— 加值不需要迁移）：
    -- disconnected|authorizing|connected|needs_reauth|error（needs_reauth = 授权失效，可行动）
    status         TEXT NOT NULL DEFAULT 'disconnected',
    enabled        INTEGER NOT NULL DEFAULT 1,            -- connector 整体开关（PR2 门控整族注册）
    -- PR3 坑 3：邮件预处理分类侧的**独立**授权位（不复用 custom agent 的 grant_connectors ——
    -- 给 agent 配了 write 绝不能让分类侧跟着继承）。天花板不入库：分类侧恒 read，是「工厂只造
    -- read 工具」的结构性保证（src/connectors/llm_tools.py），没有可配 write 的入口。默认 0=关。
    preprocess_enabled INTEGER NOT NULL DEFAULT 0,
    scopes_json    TEXT,                   -- 授权拿到的 scope 列表（坑 1.5 透明展示，明文非敏感）
    last_error     TEXT,
    last_synced_at INTEGER,                -- 工具清单最后同步 epoch 秒
    -- 08-05 WP-12：装配路线（CONNECTOR_SOURCES 写侧校验，无 SQL CHECK）。
    -- 🔴 DEFAULT 'custom_mcp' 是**有意**的：_migrate_additive 补列时存量行（全是直连的
    -- Notion / Atlassian）吃这个默认值才不会被错标成 composio。见 CONNECTOR_SOURCES 注释。
    source         TEXT NOT NULL DEFAULT 'custom_mcp',
    -- composio 行的 tool-router session id（明文非敏感）；custom_mcp 行恒 NULL。
    composio_session_id TEXT,
    -- Phase 5 (WP-5B.4)：自定义 HTTP 静态 header 名与加密值；stdio 启动参数与加密 env。
    custom_header_names_json TEXT,
    custom_headers_cipher BLOB,
    stdio_command_json TEXT,
    stdio_env_cipher BLOB,
    runtime_config_json TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

-- 工具清单行 = 白名单（未同步/伪造的工具名到不了远端，LobeHub 纪律 1）。
-- 🔴 refresh 只覆盖 manifest 派生字段（description/schema×2/crud_type/last_seen_at/orphan），
-- **永不**覆盖 mode（用户配置，纪律 2；旧 enabled 死列同理不碰）；远端消失 → orphan=1
-- 保留行（纪律 4 + PRD）。
-- 🔴 crud_type 值域 = CONNECTOR_CRUD_TYPES（写侧校验，无 SQL CHECK —— 改值域不需要迁移）。
-- 'delete' 档位 08-03 已退役（annotations 无 delete 语义位 ⇒ 不可达）；危险性由 destructive
-- 独立列承担，存量 delete 行由 _migrate_additive 离线重推导成 write+destructive=1。
CREATE TABLE IF NOT EXISTS connector_tool (
    connector_id       TEXT NOT NULL,
    tool_name          TEXT NOT NULL,
    description        TEXT,
    input_schema_json  TEXT,
    output_schema_json TEXT,
    crud_type          TEXT NOT NULL DEFAULT 'read',  -- read|write|update
    destructive        INTEGER NOT NULL DEFAULT 0,    -- 裁决①：destructive_hint 单独落列（红警告位）
    -- 🔴 enabled 是 08-05 三档改判前的旧覆盖列，已退役为**死列**（agent_config 无 DROP 先例，
    -- 留列零成本）：升级时由 _migrate_additive 一次性折入 mode（0→off、1→auto、NULL 保持），
    -- 此后写侧只写 mode，读侧折算只看 mode。
    enabled            INTEGER,
    -- 08-05 per-tool 三档（CONNECTOR_TOOL_MODES 写侧校验，无 SQL CHECK）：auto|ask|off；
    -- NULL=跟随默认（折算 auto）。用户配置——refresh 永不覆盖（纪律 2）。
    mode               TEXT,
    orphan             INTEGER NOT NULL DEFAULT 0,
    first_seen_at      INTEGER NOT NULL,
    last_seen_at       INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    PRIMARY KEY (connector_id, tool_name)
);

-- P8 Skill Creator 草稿记录。文件正文只落 skills root 下的隔离目录，不进 DB。
-- 只由受控 service/gateway 工具与 owner 显式动作写入；模型没有绕过发布确认的直写通道。
CREATE TABLE IF NOT EXISTS agent_skill_draft (
    id                TEXT PRIMARY KEY,
    name              TEXT,
    status            TEXT NOT NULL,
    root_path         TEXT NOT NULL,
    manifest_json     TEXT,
    validation_json   TEXT,
    source_session_id INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    CHECK(status IN ('draft','valid','invalid','published','discarded'))
);
CREATE INDEX IF NOT EXISTS idx_agent_skill_draft_status ON agent_skill_draft(status);

-- P8 版本信任唯一真源。只由 owner Settings 显式动作写入，gateway/模型无 grant 通道。
CREATE TABLE IF NOT EXISTS agent_skill_trust (
    id            TEXT PRIMARY KEY,
    skill_name    TEXT NOT NULL,
    package_hash  TEXT NOT NULL,
    entrypoint    TEXT NOT NULL,
    policy_json   TEXT NOT NULL,
    trusted_at    INTEGER NOT NULL,
    revoked_at    INTEGER,
    UNIQUE(skill_name, package_hash, entrypoint)
);
CREATE INDEX IF NOT EXISTS idx_agent_skill_trust_name ON agent_skill_trust(skill_name);
"""



class AgentConfigStoreBase:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._ensure_schema()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        # parent dir 可能不存在（首次部署 / 裸 worktree）→ 建好再连。
        parent = os.path.dirname(os.path.abspath(self.db_path))
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        with self._connection() as conn:
            conn.executescript(_DDL)
            self._migrate_additive(conn)
            conn.commit()

    @staticmethod
    def _migrate_additive(conn: sqlite3.Connection) -> None:
        """幂等追加列 + 幂等数据回填（backend-owned db 不进 DB_VERSION —— 开库即对齐，无版本号）。

        ``_DDL`` 的 CREATE TABLE 已含新列（新库直接带）；这里只为**已存在的旧 agent_skills 表**
        补列（生产 db 建于 S2 之前）。``PRAGMA table_info`` 判存在，缺则 ALTER，重复开库无副作用。
        """
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(agent_skills)").fetchall()}
        if "files_json" not in cols:
            conn.execute("ALTER TABLE agent_skills ADD COLUMN files_json TEXT")
        if "first_run_approved" not in cols:
            conn.execute("ALTER TABLE agent_skills ADD COLUMN first_run_approved TEXT")
        if "upstream_meta_json" not in cols:
            conn.execute("ALTER TABLE agent_skills ADD COLUMN upstream_meta_json TEXT")
        # PR2 裁决① — 已存在的旧 connector_tool 表（建于 PR1）补 destructive 列。
        ct_cols = {
            r["name"] for r in conn.execute("PRAGMA table_info(connector_tool)").fetchall()
        }
        if ct_cols and "destructive" not in ct_cols:
            conn.execute(
                "ALTER TABLE connector_tool ADD COLUMN destructive INTEGER NOT NULL DEFAULT 0"
            )
        # PR3 T3 — 已存在的旧 connector 表（建于 PR1/PR2）补分类侧授权位（默认 0 = 关，
        # 升级后行为与升级前逐字节相同）。
        c_cols = {r["name"] for r in conn.execute("PRAGMA table_info(connector)").fetchall()}
        if c_cols and "preprocess_enabled" not in c_cols:
            conn.execute(
                "ALTER TABLE connector ADD COLUMN preprocess_enabled INTEGER NOT NULL DEFAULT 0"
            )
        # 08-05 WP-12（Composio 单轨）——存量 connector 表补两列。
        # 🔴 `source` 的 DEFAULT 'custom_mcp' 就是存量行的正确答案：本次改动之前**不存在**
        # composio 行，两条老行（Notion / Atlassian）都是直连的。所以这里不需要任何数据回填
        # （回填反而会猜错）。
        if c_cols and "source" not in c_cols:
            conn.execute(
                "ALTER TABLE connector ADD COLUMN source TEXT NOT NULL DEFAULT 'custom_mcp'"
            )
        if c_cols and "composio_session_id" not in c_cols:
            conn.execute("ALTER TABLE connector ADD COLUMN composio_session_id TEXT")
        if c_cols and "custom_header_names_json" not in c_cols:
            conn.execute("ALTER TABLE connector ADD COLUMN custom_header_names_json TEXT")
        if c_cols and "custom_headers_cipher" not in c_cols:
            conn.execute("ALTER TABLE connector ADD COLUMN custom_headers_cipher BLOB")
        if c_cols and "stdio_command_json" not in c_cols:
            conn.execute("ALTER TABLE connector ADD COLUMN stdio_command_json TEXT")
        if c_cols and "stdio_env_cipher" not in c_cols:
            conn.execute("ALTER TABLE connector ADD COLUMN stdio_env_cipher BLOB")
        if c_cols and "runtime_config_json" not in c_cols:
            conn.execute("ALTER TABLE connector ADD COLUMN runtime_config_json TEXT")
        # 08-03 delete 档位退役 —— 存量陈旧行**离线重推导**（不需要网络 re-sync）。
        # 🔴 可证明等价：旧映射里产出 delete 的**唯一**路径是 `destructive_hint is True`，而
        # 当前 `derive_crud_type` 对同一输入产出 write，`derive_destructive` 产出 True ⇒ 这条
        # UPDATE 就是把那次误判按新规则重算一遍，与 owner 点一次 sync 的结果逐字段相同。
        # 幂等（WHERE 后不再有 delete 行）；`enabled` 用户覆盖一列不碰（refresh 纪律 2）。
        if ct_cols:
            conn.execute(
                "UPDATE connector_tool SET crud_type='write', destructive=1, updated_at=? "
                "WHERE crud_type='delete'",
                (_now(),),
            )
        # 08-05 per-tool 三档（owner 拍板，master-plan WP-10）—— 旧 `enabled` 覆盖**一次性**
        # 折入新 `mode` 列：0→'off'（owner 显式关）、1→'auto'（owner 显式开——write 从「开但
        # 每次弹卡」变「auto 免卡」，正是本次拍板意图）、NULL 保持 NULL（跟随默认，折算 auto）。
        # 🔴 折算只在 `mode` 列**刚补上**的那次开库跑（用列缺席作一次性判据）：折算条件若写成
        # 「WHERE mode IS NULL AND enabled=…」并每次开库重跑，用户后来把 mode 清回 NULL（跟随
        # 默认）会被死列里的旧 enabled 值重新折走。此后 enabled 是死列，写侧只写 mode。
        if ct_cols and "mode" not in ct_cols:
            conn.execute("ALTER TABLE connector_tool ADD COLUMN mode TEXT")
            now = _now()
            conn.execute(
                "UPDATE connector_tool SET mode='off', updated_at=? WHERE enabled=0", (now,)
            )
            conn.execute(
                "UPDATE connector_tool SET mode='auto', updated_at=? WHERE enabled=1", (now,)
            )
        # 08-05 WP-11 —— acceptEdits 模式退役为 per-tool 档预设：存量
        # chat_approval_mode='acceptEdits' 行**一次性**行为保持折算——它当年免卡的那
        # 15 个工具（ACCEPT_EDITS_PRESET）落显式 'auto' 覆盖行，模式改回 'manual'。
        # INSERT OR IGNORE：owner 若已有同名覆盖行（理论上不可能——本迁移先于端点上线，
        # 防御性保留）不clobber。幂等判据 = 折算后 mode != 'acceptEdits'，不会重跑。
        row = conn.execute(
            "SELECT value FROM owner_settings WHERE key='chat_approval_mode'"
        ).fetchone()
        if row is not None and row["value"] == "acceptEdits":
            from src.agent_config.tool_prefs import ACCEPT_EDITS_PRESET

            now_iso = _now_iso()
            for name in ACCEPT_EDITS_PRESET:
                conn.execute(
                    "INSERT OR IGNORE INTO tool_approval_pref "
                    "(tool_name, tier, updated_at) VALUES (?, 'auto', ?)",
                    (name, now_iso),
                )
            conn.execute(
                "UPDATE owner_settings SET value='manual', updated_at=? "
                "WHERE key='chat_approval_mode'",
                (now_iso,),
            )

        # browser_use 默认模式升级：将未手工修改过的出厂 cdp_chrome 一次性迁移为
        # 内置受管持久浏览器（isolated_profile + headless=True），以 owner_settings 作幂等哨兵。
        migrated_flag = conn.execute(
            "SELECT value FROM owner_settings WHERE key='browser_use_default_isolated_v1'"
        ).fetchone()
        if migrated_flag is None:
            now_int = _now()
            now_iso = _now_iso()
            bu_row = conn.execute(
                "SELECT source, runtime_config_json FROM connector WHERE connector_id='browser_use'"
            ).fetchone()
            if bu_row is not None and bu_row["source"] == "managed_local":
                raw_bu_rc = bu_row["runtime_config_json"]
                parsed_bu_rc: Optional[dict[str, Any]] = None
                if raw_bu_rc:
                    try:
                        cand_bu_rc = json.loads(raw_bu_rc)
                        if isinstance(cand_bu_rc, dict):
                            parsed_bu_rc = cand_bu_rc
                    except (ValueError, TypeError):
                        parsed_bu_rc = None
                is_untouched_default = parsed_bu_rc is None or (
                    parsed_bu_rc.get("mode") == "cdp_chrome"
                    and (parsed_bu_rc.get("cdp_url") in (None, "chrome"))
                    and set(parsed_bu_rc).issubset({"mode", "browser_mode", "cdp_url"})
                )
                if is_untouched_default:
                    conn.execute(
                        "UPDATE connector SET runtime_config_json=?, updated_at=? WHERE connector_id='browser_use'",
                        (
                            json.dumps(
                                {"mode": "isolated_profile", "headless": True},
                                ensure_ascii=False,
                            ),
                            now_int,
                        ),
                    )
            conn.execute(
                "INSERT OR IGNORE INTO owner_settings (key, value, updated_at) "
                "VALUES ('browser_use_default_isolated_v1', '1', ?)",
                (now_iso,),
            )

        # Templates are otherwise seed-once. Upgrade only an untouched doc: exact old-default
        # equality is the guard, so any user-edited content remains authoritative. The UPDATE
        # condition also makes this idempotent across every subsequent store open.
        for doc_name, legacy, current, changed_by in (
            ("agent", LEGACY_AGENT_TEMPLATE_P0, AGENT_TEMPLATE, "migration:p0-plan-tool"),
            ("agent", LEGACY_AGENT_TEMPLATE_P1, AGENT_TEMPLATE, "migration:p1-agent-trim"),
            ("soul", LEGACY_SOUL_TEMPLATE_P0, SOUL_TEMPLATE, "migration:p1-soul-voice"),
        ):
            now = _now()
            new_hash = _hash(current)
            cur = conn.execute(
                "UPDATE agent_profile_docs SET content=?, content_hash=?, updated_by=?, updated_at=? "
                "WHERE doc_name=? AND content=?",
                (current, new_hash, changed_by, now, doc_name, legacy),
            )
            if cur.rowcount > 0:
                conn.execute(
                    "INSERT INTO agent_profile_history "
                    "(doc_name, old_hash, new_hash, content_snapshot, changed_by, "
                    " session_id, message_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
                    (doc_name, _hash(legacy), new_hash, current, changed_by, None, None, now),
                )

    # ======================================================================
    # Standing Context 文档（4 个可编辑：soul/agent/rules/user）
    # ======================================================================


    def record_event(
        self,
        skill_name: str,
        event: str,
        *,
        detail: Optional[dict[str, Any]] = None,
        session_id: Optional[int] = None,
    ) -> None:
        now = _now()
        with self._connection() as conn:
            self._record_event_conn(conn, skill_name, event, detail, session_id, now)
            conn.commit()

    def list_events(
        self, skill_name: Optional[str] = None, *, limit: int = 50
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM agent_skill_events"
        params: list[Any] = []
        if skill_name is not None:
            sql += " WHERE skill_name = ?"
            params.append(skill_name)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]


    @staticmethod
    def _validate_doc_name(doc_name: str) -> str:
        # STORABLE_DOC_NAMES = 4 份身份文档 + memory.md（memory 单独注入、不进 standing_context/
        # profile_hash，但复用同一 get/set/history/rollback 存储层）。
        if doc_name not in STORABLE_DOC_NAMES:
            raise ValueError(
                f"profile doc_name must be one of {STORABLE_DOC_NAMES}, got {doc_name!r}"
            )
        return doc_name

    @staticmethod
    def _validate_scopes(scopes: Optional[Iterable[str]]) -> tuple[str, ...]:
        """granted_scopes ⊆ KNOWN_SCOPES（复用 api_keys.validate_scopes 单一真源）。None→()。"""
        if scopes is None:
            return ()
        from src.security.api_keys import validate_scopes

        return validate_scopes(scopes)

    @staticmethod
    def _record_event_conn(
        conn: sqlite3.Connection,
        skill_name: str,
        event: str,
        detail: Optional[dict[str, Any]],
        session_id: Optional[int],
        now: int,
    ) -> None:
        conn.execute(
            "INSERT INTO agent_skill_events "
            "(skill_name, event, detail_json, session_id, created_at) VALUES (?,?,?,?,?)",
            (
                skill_name,
                event,
                json.dumps(detail, ensure_ascii=False) if detail is not None else None,
                session_id,
                now,
            ),
        )



# ---------------------------------------------------------------------------
# row → dataclass
# ---------------------------------------------------------------------------


def _to_int_bool(value: Optional[bool]) -> Optional[int]:
    """None→NULL；True→1；False→0（保留 NULL 与 0 的区分 = 无覆盖 vs 显式禁用）。"""
    if value is None:
        return None
    return 1 if value else 0


def _from_int_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    return bool(value)


def _row_to_skill(row: sqlite3.Row) -> SkillRow:
    try:
        scopes = tuple(json.loads(row["granted_scopes_json"]) or []) if row["granted_scopes_json"] else ()
    except (json.JSONDecodeError, TypeError):
        scopes = ()
    manifest: Optional[dict[str, Any]] = None
    if row["manifest_json"]:
        try:
            parsed = json.loads(row["manifest_json"])
            manifest = parsed if isinstance(parsed, dict) else None
        except (json.JSONDecodeError, TypeError):
            manifest = None
    keys = row.keys()
    upstream_meta: Optional[dict[str, Any]] = None
    if "upstream_meta_json" in keys and row["upstream_meta_json"]:
        try:
            parsed_um = json.loads(row["upstream_meta_json"])
            upstream_meta = parsed_um if isinstance(parsed_um, dict) else None
        except (json.JSONDecodeError, TypeError):
            upstream_meta = None
    return SkillRow(
        skill_name=row["skill_name"],
        source_type=row["source_type"],
        enabled=_from_int_bool(row["enabled"]),
        granted_scopes=scopes,
        trusted=bool(row["trusted"]),
        source_uri=row["source_uri"],
        version=row["version"],
        manifest_version=row["manifest_version"],
        manifest=manifest,
        package_hash=row["package_hash"],
        last_error=row["last_error"],
        installed_at=row["installed_at"],
        updated_at=row["updated_at"],
        # 新列（迁移前建的旧库经 _migrate_additive 补齐；防御性 keys() 判存在，避免 KeyError）。
        files_json=row["files_json"] if "files_json" in keys else None,
        first_run_approved=row["first_run_approved"] if "first_run_approved" in keys else None,
        upstream_meta=upstream_meta,
    )


def _row_to_policy_rule(row: sqlite3.Row) -> PolicyRuleRow:
    try:
        matcher = json.loads(row["matcher_json"])
        if not isinstance(matcher, dict):
            matcher = {}
    except (json.JSONDecodeError, TypeError):
        # 坏 matcher_json 投影成空 dict —— evaluate 侧解析空 matcher 不匹配任何动作（fail-closed）。
        matcher = {}
    return PolicyRuleRow(
        id=row["id"],
        capability=row["capability"],
        matcher=matcher,
        context_mode=row["context_mode"],
        agent_id=row["agent_id"],
        enabled=bool(row["enabled"]),
        note=row["note"],
        created_at=row["created_at"],
        last_used_at=row["last_used_at"],
        use_count=row["use_count"],
    )


def _json_object_or_none(raw: Optional[str]) -> Optional[dict[str, Any]]:
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _row_to_skill_draft(row: sqlite3.Row) -> SkillDraftRow:
    return SkillDraftRow(
        id=row["id"],
        name=row["name"] or "",
        status=row["status"],
        root_path=row["root_path"],
        manifest=_json_object_or_none(row["manifest_json"]),
        validation=_json_object_or_none(row["validation_json"]),
        source_session_id=row["source_session_id"],
        created_at=int(row["created_at"]),
        updated_at=int(row["updated_at"]),
    )


def _row_to_skill_trust(row: sqlite3.Row) -> SkillTrustRow:
    return SkillTrustRow(
        id=row["id"],
        skill_name=row["skill_name"],
        package_hash=row["package_hash"],
        entrypoint=row["entrypoint"],
        policy=_json_object_or_none(row["policy_json"]) or {},
        trusted_at=int(row["trusted_at"]),
        revoked_at=int(row["revoked_at"]) if row["revoked_at"] is not None else None,
    )


def _connector_sources() -> tuple[str, ...]:
    from src.agent_config.store import CONNECTOR_SOURCES

    return CONNECTOR_SOURCES


def _row_to_connector(row: sqlite3.Row) -> ConnectorRow:
    scopes: Optional[list[str]] = None
    raw = row["scopes_json"]
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list) and all(isinstance(s, str) for s in parsed):
                scopes = parsed
        except (ValueError, TypeError):
            scopes = None  # 坏 JSON → None（展示位缺失不阻断行读取）
    header_names: tuple[str, ...] = ()
    raw_headers = row["custom_header_names_json"] if "custom_header_names_json" in row.keys() else None
    if raw_headers:
        try:
            parsed_h = json.loads(raw_headers)
            if isinstance(parsed_h, list):
                header_names = tuple(str(h) for h in parsed_h if isinstance(h, str) and h)
        except (ValueError, TypeError):
            header_names = ()
    stdio_cmd: Optional[dict[str, Any]] = None
    stdio_env_keys: tuple[str, ...] = ()
    raw_cmd = row["stdio_command_json"] if "stdio_command_json" in row.keys() else None
    if raw_cmd:
        parsed_cmd = _json_object_or_none(raw_cmd)
        if parsed_cmd is not None and isinstance(parsed_cmd.get("command"), str):
            raw_keys = parsed_cmd.get("env_keys") or []
            if isinstance(raw_keys, list):
                stdio_env_keys = tuple(str(k) for k in raw_keys if isinstance(k, str) and k)
            stdio_cmd = {
                "command": parsed_cmd["command"],
                "args": [str(a) for a in (parsed_cmd.get("args") or []) if a is not None],
                "cwd": parsed_cmd.get("cwd") if isinstance(parsed_cmd.get("cwd"), str) else None,
            }
    raw_rc = row["runtime_config_json"] if "runtime_config_json" in row.keys() else None
    runtime_config = _json_object_or_none(raw_rc) if raw_rc else None
    return ConnectorRow(
        connector_id=row["connector_id"],
        server_url=row["server_url"],
        transport=row["transport"],
        display_name=row["display_name"],
        status=row["status"],
        enabled=bool(row["enabled"]),
        scopes=scopes,
        last_error=row["last_error"],
        last_synced_at=row["last_synced_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        preprocess_enabled=bool(row["preprocess_enabled"]),
        # 读侧宽容：值域外的 source（手改 DB）当 custom_mcp —— 不认识的路线绝不当成
        # 「Composio 托管、静态 header 直发」（那会拿一个 API key 去打一个未知端点）。
        source=(
            row["source"] if row["source"] in _connector_sources() else "custom_mcp"
        ),
        composio_session_id=row["composio_session_id"],
        custom_header_names=header_names,
        stdio_command=stdio_cmd,
        stdio_env_keys=stdio_env_keys,
        runtime_config=runtime_config,
    )


def _row_to_connector_tool(row: sqlite3.Row) -> ConnectorToolRow:
    enabled = row["enabled"]
    return ConnectorToolRow(
        connector_id=row["connector_id"],
        tool_name=row["tool_name"],
        description=row["description"] or "",
        input_schema_json=row["input_schema_json"],
        output_schema_json=row["output_schema_json"],
        crud_type=row["crud_type"],
        destructive=bool(row["destructive"]),
        enabled=None if enabled is None else bool(enabled),
        orphan=bool(row["orphan"]),
        first_seen_at=row["first_seen_at"],
        last_seen_at=row["last_seen_at"],
        updated_at=row["updated_at"],
        mode=row["mode"],
    )


def _row_to_external_credential_meta(row: sqlite3.Row) -> ExternalCredentialMeta:
    metadata: dict[str, Any] = {}
    if row["metadata_json"]:
        try:
            parsed = json.loads(row["metadata_json"])
            if isinstance(parsed, dict):
                metadata = parsed
        except (json.JSONDecodeError, TypeError):
            # 坏 metadata 投影成 {} —— 元数据是展示位，绝不因它炸掉「连接是否存在/何时过期」的查询。
            metadata = {}
    return ExternalCredentialMeta(
        namespace=row["namespace"],
        credential_key=row["credential_key"],
        expires_at=row["expires_at"],
        metadata=metadata,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_profile_doc(row: sqlite3.Row) -> ProfileDoc:
    return ProfileDoc(
        doc_name=row["doc_name"],
        content=row["content"],
        content_hash=row["content_hash"],
        updated_by=row["updated_by"],
        updated_at=row["updated_at"],
    )


def _row_to_history(row: sqlite3.Row) -> ProfileHistoryEntry:
    return ProfileHistoryEntry(
        id=row["id"],
        doc_name=row["doc_name"],
        old_hash=row["old_hash"],
        new_hash=row["new_hash"],
        content_snapshot=row["content_snapshot"],
        changed_by=row["changed_by"],
        session_id=row["session_id"],
        message_id=row["message_id"],
        created_at=row["created_at"],
    )

