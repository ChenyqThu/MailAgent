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

import hashlib
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable, Iterator, Optional

from src.agent_config.templates import SEED_TEMPLATES

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
# 可存储（落表 + get/set/history/rollback）的全部 doc 名 = 4 份身份 + memory.md。
STORABLE_DOC_NAMES: tuple[str, ...] = PROFILE_DOC_NAMES + (MEMORY_DOC_NAME,)
# 投影文档（只读视图，SKILLS 来自 skill registry）—— 不存表。
PROJECTION_DOC_NAMES: tuple[str, ...] = ("skills",)

# 可安装 skill 的来源类型（builtin 来自代码，不算"安装"）。
INSTALLABLE_SOURCE_TYPES: tuple[str, ...] = ("local_folder", "skill_pack", "document", "mcp")
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


@dataclass(frozen=True)
class ConnectorToolRow:
    """``connector_tool`` 行投影（远端工具清单一行；schema 保持 JSON 字符串，读方自解）。"""

    connector_id: str
    tool_name: str
    description: str
    input_schema_json: Optional[str]
    output_schema_json: Optional[str]
    crud_type: str
    #: 裁决①（PR2）：manifest ``destructive_hint`` 单独落列（破坏性**更新**语义位，不再当
    #: delete 档位）——审批卡红警告消费；manifest 派生字段，refresh 覆盖。
    destructive: bool
    enabled: Optional[bool]  # 用户覆盖；None = 未覆盖（跟随 crud 默认）
    orphan: bool
    first_seen_at: int
    last_seen_at: int
    updated_at: int


#: connector.status 值域（写侧校验）。
CONNECTOR_STATUSES = ("disconnected", "authorizing", "connected", "error")

#: connector_tool.crud_type 值域单源（client.derive_crud_type 的产出、写侧校验、以及
#: PR2 注册期过滤都以此为准）。'delete' 是保留位：可入库，不可置启用态（Q3=B / Q16=A）。
CONNECTOR_CRUD_TYPES = ("read", "write", "update", "delete")


def connector_tool_effective_enabled(crud_type: str, enabled_override: Optional[bool]) -> bool:
    """工具的有效启用态（纯函数，镜像 ``resolve_enabled`` 风格）。

    - ``delete`` 类恒 False —— 读侧防御纵深（写侧 ``set_connector_tool_enabled`` 已拒，
      这里再兜手改 DB 的行：任何 override 都压不开）。
    - 其余：用户覆盖优先；无覆盖时 **read 默认开、write/update 默认关**（PRD Q3 缓解项）。
    """
    if crud_type == "delete":
        return False
    if enabled_override is not None:
        return enabled_override
    return crud_type == "read"


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
    first_run_approved  TEXT
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
-- chat 授权模式 manual/acceptEdits/bypass 的持久真源）。镜像 policy_rules 纪律：值**只**由
-- owner 显式 UI 动作写入（serve-api verify_cf_access 端点），模型无任何 gateway 工具通道。
CREATE TABLE IF NOT EXISTS owner_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
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
    connector_id   TEXT PRIMARY KEY,       -- 'notion' | 'atlassian'（registry.CONNECTORS 键）
    server_url     TEXT NOT NULL,
    transport      TEXT NOT NULL DEFAULT 'streamable_http',
    display_name   TEXT,
    status         TEXT NOT NULL DEFAULT 'disconnected',  -- disconnected|authorizing|connected|error
    enabled        INTEGER NOT NULL DEFAULT 1,            -- connector 整体开关（PR2 门控整族注册）
    scopes_json    TEXT,                   -- 授权拿到的 scope 列表（坑 1.5 透明展示，明文非敏感）
    last_error     TEXT,
    last_synced_at INTEGER,                -- 工具清单最后同步 epoch 秒
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

-- 工具清单行 = 白名单（未同步/伪造的工具名到不了远端，LobeHub 纪律 1）。
-- 🔴 refresh 只覆盖 manifest 派生字段（description/schema×2/crud_type/last_seen_at/orphan），
-- **永不**覆盖 enabled（用户配置，纪律 2）；远端消失 → orphan=1 保留行（纪律 4 + PRD）。
-- 🔴 crud_type 含 'delete' 保留位：照常入库（清单完整，Q16=A），但写侧拒置启用态
-- （set_connector_tool_enabled），未来放开只动开关不改 schema（Q3=B）。
CREATE TABLE IF NOT EXISTS connector_tool (
    connector_id       TEXT NOT NULL,
    tool_name          TEXT NOT NULL,
    description        TEXT,
    input_schema_json  TEXT,
    output_schema_json TEXT,
    crud_type          TEXT NOT NULL DEFAULT 'read',  -- read|write|update|delete
    destructive        INTEGER NOT NULL DEFAULT 0,    -- 裁决①：destructive_hint 单独落列（红警告位）
    enabled            INTEGER,        -- 用户覆盖：NULL=默认（read 开，write/update/delete 关）
    orphan             INTEGER NOT NULL DEFAULT 0,
    first_seen_at      INTEGER NOT NULL,
    last_seen_at       INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    PRIMARY KEY (connector_id, tool_name)
);
"""


class AgentConfigStore:
    """SQLite-backed Capability & Context 配置存储（per-call 短连接，WAL 友好）。

    与 ``ApiKeyStore`` 同款：只持 db_path，连接 per-op open/close，进程内共享单例零风险。
    """

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._ensure_schema()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        # parent dir 可能不存在（首次部署 / 裸 worktree）→ 建好再连。
        parent = os.path.dirname(os.path.abspath(self.db_path))
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
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
        """幂等追加列（backend-owned db 不进 DB_VERSION —— 开库即对齐，无版本号）。

        ``_DDL`` 的 CREATE TABLE 已含新列（新库直接带）；这里只为**已存在的旧 agent_skills 表**
        补列（生产 db 建于 S2 之前）。``PRAGMA table_info`` 判存在，缺则 ALTER，重复开库无副作用。
        """
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(agent_skills)").fetchall()}
        if "files_json" not in cols:
            conn.execute("ALTER TABLE agent_skills ADD COLUMN files_json TEXT")
        if "first_run_approved" not in cols:
            conn.execute("ALTER TABLE agent_skills ADD COLUMN first_run_approved TEXT")
        # PR2 裁决① — 已存在的旧 connector_tool 表（建于 PR1）补 destructive 列。
        ct_cols = {
            r["name"] for r in conn.execute("PRAGMA table_info(connector_tool)").fetchall()
        }
        if ct_cols and "destructive" not in ct_cols:
            conn.execute(
                "ALTER TABLE connector_tool ADD COLUMN destructive INTEGER NOT NULL DEFAULT 0"
            )

    # ======================================================================
    # Standing Context 文档（4 个可编辑：soul/agent/rules/user）
    # ======================================================================

    def get_profile_doc(self, doc_name: str, *, seed_if_absent: bool = True) -> ProfileDoc:
        """读一个 profile 文档；缺失且 ``seed_if_absent`` 时落默认 seed 并记一条初始 history。

        seed 落库是 **幂等 + 一次性**（INSERT OR IGNORE on PK）；并发首读最多一次建行。
        """
        name = self._validate_doc_name(doc_name)
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM agent_profile_docs WHERE doc_name = ?", (name,)
            ).fetchone()
            if row is not None:
                return _row_to_profile_doc(row)
            if not seed_if_absent:
                raise KeyError(f"profile doc not found: {name}")
            # memory.md 无 seed 模板（不在 SEED_TEMPLATES）→ 空串；4 份身份文档取其模板。
            seed = SEED_TEMPLATES.get(name, "")
            seed_hash = _hash(seed)
            now = _now()
            cur = conn.execute(
                "INSERT OR IGNORE INTO agent_profile_docs "
                "(doc_name, content, content_hash, updated_by, updated_at) VALUES (?,?,?,?,?)",
                (name, seed, seed_hash, "seed", now),
            )
            # 仅当本调用真正建了行才记初始 history（并发 race 下别人建的就不重复记）。
            if cur.rowcount > 0:
                conn.execute(
                    "INSERT INTO agent_profile_history "
                    "(doc_name, old_hash, new_hash, content_snapshot, changed_by, "
                    " session_id, message_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
                    (name, None, seed_hash, seed, "seed", None, None, now),
                )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM agent_profile_docs WHERE doc_name = ?", (name,)
            ).fetchone()
        return _row_to_profile_doc(row)

    def list_profile_docs(self) -> list[ProfileDoc]:
        """4 个可编辑文档（缺失的先 seed），按 PROFILE_DOC_NAMES 顺序返回。"""
        return [self.get_profile_doc(name) for name in PROFILE_DOC_NAMES]

    def set_profile_doc(
        self,
        doc_name: str,
        content: str,
        *,
        updated_by: str = "user",
        session_id: Optional[int] = None,
        message_id: Optional[int] = None,
    ) -> ProfileDoc:
        """覆盖一个 profile 文档内容 + 记一条 history（old_hash→new_hash + 完整快照）。

        ``updated_by`` ∈ {'user','agent_proposed'}。内容未变（hash 相同）则 no-op 不记 history。
        """
        name = self._validate_doc_name(doc_name)
        if not isinstance(content, str) or content == "":
            raise ValueError("profile doc content must be a non-empty string")
        new_hash = _hash(content)
        now = _now()
        with self._connection() as conn:
            prev = conn.execute(
                "SELECT content_hash FROM agent_profile_docs WHERE doc_name = ?", (name,)
            ).fetchone()
            old_hash = prev["content_hash"] if prev is not None else None
            if old_hash == new_hash:
                # 内容未变 → 不写历史，直接返回当前行。
                row = conn.execute(
                    "SELECT * FROM agent_profile_docs WHERE doc_name = ?", (name,)
                ).fetchone()
                return _row_to_profile_doc(row)
            conn.execute(
                "INSERT INTO agent_profile_docs "
                "(doc_name, content, content_hash, updated_by, updated_at) VALUES (?,?,?,?,?) "
                "ON CONFLICT(doc_name) DO UPDATE SET content=excluded.content, "
                " content_hash=excluded.content_hash, updated_by=excluded.updated_by, "
                " updated_at=excluded.updated_at",
                (name, content, new_hash, updated_by, now),
            )
            conn.execute(
                "INSERT INTO agent_profile_history "
                "(doc_name, old_hash, new_hash, content_snapshot, changed_by, "
                " session_id, message_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (name, old_hash, new_hash, content, updated_by, session_id, message_id, now),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM agent_profile_docs WHERE doc_name = ?", (name,)
            ).fetchone()
        return _row_to_profile_doc(row)

    def list_profile_history(
        self, doc_name: Optional[str] = None, *, limit: int = 50
    ) -> list[ProfileHistoryEntry]:
        sql = "SELECT * FROM agent_profile_history"
        params: list[Any] = []
        if doc_name is not None:
            sql += " WHERE doc_name = ?"
            params.append(self._validate_doc_name(doc_name))
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_history(r) for r in rows]

    def rollback_profile_doc(
        self,
        doc_name: str,
        target_hash: str,
        *,
        updated_by: str = "user",
        session_id: Optional[int] = None,
    ) -> ProfileDoc:
        """把文档回滚到某历史版本（按其 ``new_hash`` 定位 content_snapshot）。

        回滚本身记一条新 history（changed_by 透传）。找不到 target_hash → KeyError。
        RULES 目标内容不过 validator → ValueError（S1 R2：历史里可能存在 validator 收紧前
        / 绕过 router 落库的版本，回滚=一次普通写，享受同一 deny-list 闸——此前只有写端点
        agent.py 校验，rollback 路径可把越权 RULES 快照重新激活）。
        """
        name = self._validate_doc_name(doc_name)
        with self._connection() as conn:
            hist = conn.execute(
                "SELECT content_snapshot FROM agent_profile_history "
                "WHERE doc_name = ? AND new_hash = ? ORDER BY id DESC LIMIT 1",
                (name, target_hash),
            ).fetchone()
        if hist is None:
            raise KeyError(f"no history version {target_hash} for doc {name}")
        if name == "rules":
            from src.agent_config.validator import validate_rules_content

            reason = validate_rules_content(hist["content_snapshot"])
            if reason:
                raise ValueError(reason)
        # 复用 set_profile_doc 写当前 + 记新 history（回滚=一次普通写，内容=历史快照）。
        return self.set_profile_doc(
            name, hist["content_snapshot"], updated_by=updated_by, session_id=session_id
        )

    def profile_hash(self) -> str:
        """4 个可编辑文档的确定性聚合 hash（agent_profile_hash 用）。

        canonical：按 doc_name 排序，``name:content_hash`` 行 join，再 sha256。文档缺失先 seed
        （故同一默认种群 hash 稳定）。
        """
        docs = {d.doc_name: d.content_hash for d in self.list_profile_docs()}
        canonical = "\n".join(f"{name}:{docs[name]}" for name in sorted(docs))
        return _hash(canonical)

    # ======================================================================
    # 统一 skill registry
    # ======================================================================

    def list_skills(self) -> list[SkillRow]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM agent_skills ORDER BY skill_name"
            ).fetchall()
        return [_row_to_skill(r) for r in rows]

    def get_skill(self, skill_name: str) -> Optional[SkillRow]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM agent_skills WHERE skill_name = ?", (skill_name,)
            ).fetchone()
        return _row_to_skill(row) if row else None

    def install_skill(
        self,
        skill_name: str,
        *,
        source_type: str,
        manifest: Optional[dict[str, Any]] = None,
        manifest_version: Optional[str] = None,
        version: Optional[str] = None,
        source_uri: Optional[str] = None,
        granted_scopes: Optional[Iterable[str]] = None,
        package_hash: Optional[str] = None,
        trusted: bool = False,
        enabled: Optional[bool] = None,
        files_json: Optional[str] = None,
        session_id: Optional[int] = None,
    ) -> SkillRow:
        """安装/更新一个用户来源 skill（source_type ∈ INSTALLABLE_SOURCE_TYPES）。

        ``granted_scopes`` 写时校验 ⊆ KNOWN_SCOPES（复用 api_keys.validate_scopes）—— 非法 scope
        ``ValueError``，不静默产出 manifest 里调不动的死工具。``files_json`` = S2 供应链的逐文件
        sha256（confirm 落库）。记一条 install 事件（detail 含 package_hash/manifest_version，
        **绝不含 secret 值**）。
        """
        if source_type not in INSTALLABLE_SOURCE_TYPES:
            raise ValueError(
                f"install_skill source_type must be one of {INSTALLABLE_SOURCE_TYPES}, got {source_type!r}"
            )
        skill_name = (skill_name or "").strip()
        if not skill_name:
            raise ValueError("skill_name is required")
        # R5 — strict slug + manifest.name agreement (so the registry projection,
        # @mention parsing, and enable/disable all key off the same canonical name).
        if not _SKILL_NAME_RE.match(skill_name):
            raise ValueError(
                f"skill_name must be a lowercase slug matching {_SKILL_NAME_RE.pattern!r}, "
                f"got {skill_name!r}"
            )
        if manifest is not None:
            mname = manifest.get("name")
            if mname is not None and mname != skill_name:
                raise ValueError(
                    f"manifest.name ({mname!r}) must be absent or equal skill_name ({skill_name!r})"
                )
        scopes = self._validate_scopes(granted_scopes)
        manifest_json = (
            json.dumps(manifest, ensure_ascii=False, sort_keys=True) if manifest is not None else None
        )
        now = _now()
        with self._connection() as conn:
            existing = conn.execute(
                "SELECT installed_at FROM agent_skills WHERE skill_name = ?", (skill_name,)
            ).fetchone()
            installed_at = existing["installed_at"] if existing else now
            conn.execute(
                "INSERT INTO agent_skills "
                "(skill_name, source_type, source_uri, version, manifest_version, manifest_json, "
                " enabled, granted_scopes_json, package_hash, trusted, last_error, installed_at, updated_at, "
                " files_json) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(skill_name) DO UPDATE SET "
                " source_type=excluded.source_type, source_uri=excluded.source_uri, "
                " version=excluded.version, manifest_version=excluded.manifest_version, "
                " manifest_json=excluded.manifest_json, enabled=excluded.enabled, "
                " granted_scopes_json=excluded.granted_scopes_json, package_hash=excluded.package_hash, "
                " trusted=excluded.trusted, last_error=NULL, updated_at=excluded.updated_at, "
                " files_json=excluded.files_json",
                (
                    skill_name,
                    source_type,
                    source_uri,
                    version,
                    manifest_version,
                    manifest_json,
                    _to_int_bool(enabled),
                    json.dumps(list(scopes), ensure_ascii=False),
                    package_hash,
                    1 if trusted else 0,
                    None,
                    installed_at,
                    now,
                    files_json,
                ),
            )
            # detail 记 source_type + package_hash + manifest_version（供应链溯源）；**绝不含 secret 值**。
            detail: dict[str, Any] = {"source_type": source_type}
            if package_hash is not None:
                detail["package_hash"] = package_hash
            if manifest_version is not None:
                detail["manifest_version"] = manifest_version
            self._record_event_conn(conn, skill_name, "install", detail, session_id, now)
            conn.commit()
        skill = self.get_skill(skill_name)
        assert skill is not None  # 刚插入
        return skill

    def set_enabled(
        self,
        skill_name: str,
        enabled: bool,
        *,
        source_type: str = "builtin",
        session_id: Optional[int] = None,
    ) -> None:
        """设置 skill 的启用覆盖。builtin 无行时懒建一行（只存 enable 覆盖，manifest 来自代码）。

        installed skill 已有行 → 仅更新 enabled。记 enable/disable 事件。
        """
        skill_name = (skill_name or "").strip()
        if not skill_name:
            raise ValueError("skill_name is required")
        now = _now()
        with self._connection() as conn:
            existing = conn.execute(
                "SELECT skill_name FROM agent_skills WHERE skill_name = ?", (skill_name,)
            ).fetchone()
            if existing is None:
                # 懒建 builtin 覆盖行：manifest_json=NULL（manifest 来自代码），只承载 enabled。
                conn.execute(
                    "INSERT INTO agent_skills "
                    "(skill_name, source_type, enabled, granted_scopes_json, trusted, installed_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (skill_name, source_type, _to_int_bool(enabled), "[]", 0, now, now),
                )
            else:
                conn.execute(
                    "UPDATE agent_skills SET enabled = ?, updated_at = ? WHERE skill_name = ?",
                    (_to_int_bool(enabled), now, skill_name),
                )
            self._record_event_conn(
                conn, skill_name, "enable" if enabled else "disable", None, session_id, now
            )
            conn.commit()

    def uninstall_skill(self, skill_name: str, *, session_id: Optional[int] = None) -> bool:
        """删一个 skill 行（installed → 卸载；builtin 懒行 → 回退代码默认）。幂等：无行返回 False。"""
        now = _now()
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM agent_skills WHERE skill_name = ?", (skill_name,))
            removed = cur.rowcount > 0
            if removed:
                self._record_event_conn(conn, skill_name, "uninstall", None, session_id, now)
            conn.commit()
        return removed

    def set_skill_last_error(self, skill_name: str, error: Optional[str]) -> None:
        """落/清一个 skill 的 ``last_error``（W4 完整性闸：``tampered:<relpath>``）。无行 no-op。

        Settings 据此标红 + 提供「重新信任（re-hash）」入口；install_skill upsert 时自动清
        （``last_error=NULL``，见上）。
        """
        with self._connection() as conn:
            conn.execute(
                "UPDATE agent_skills SET last_error = ?, updated_at = ? WHERE skill_name = ?",
                (error, _now(), skill_name),
            )
            conn.commit()

    def merge_first_run_approved(self, skill_name: str, updates: dict[str, dict]) -> None:
        """把首跑记录 merge 进 ``first_run_approved`` JSON（W4 首跑闸，ADR-002 §5）。

        形状 ``{<entrypoint_realpath>: {version, entrypoint_hash, approved_at}}`` —— 绑
        version + entrypoint hash（非裸时间戳）：skill 升级 / 换脚本后旧记录自动失效、
        首跑闸重新触发。``approved_at`` 缺失时由本层补当前 epoch。无行 no-op（供应链外
        内容根本过不了完整性闸，不会走到这）。
        """
        if not updates:
            return
        now = _now()
        with self._connection() as conn:
            row = conn.execute(
                "SELECT first_run_approved FROM agent_skills WHERE skill_name = ?",
                (skill_name,),
            ).fetchone()
            if row is None:
                return
            try:
                existing = json.loads(row["first_run_approved"] or "{}")
                if not isinstance(existing, dict):
                    existing = {}
            except (ValueError, TypeError):
                existing = {}
            for entrypoint, rec in updates.items():
                merged = dict(rec)
                merged.setdefault("approved_at", now)
                existing[entrypoint] = merged
            conn.execute(
                "UPDATE agent_skills SET first_run_approved = ?, updated_at = ? WHERE skill_name = ?",
                (json.dumps(existing, ensure_ascii=False, sort_keys=True), now, skill_name),
            )
            conn.commit()

    def list_skill_secret_names(self, skill_name: str) -> list[str]:
        """一个 skill 已存储的密钥**名**列表（永不返回值 —— 值列是密文，W3 解密专属）。"""
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT secret_name FROM skill_secrets WHERE skill_name = ? ORDER BY secret_name",
                (skill_name,),
            ).fetchall()
        return [r["secret_name"] for r in rows]

    def delete_skill_secrets(self, skill_name: str) -> int:
        """删一个 skill 的全部 skill_secrets 行（uninstall 清理钩子）。返回删除行数。

        W2 只做结构清理（删行）；Keychain master key 不动（W3 拥有加解密 + master key 生命周期）。
        """
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM skill_secrets WHERE skill_name = ?", (skill_name,))
            conn.commit()
            return cur.rowcount

    # -- skill secret 密文 CRUD（W3 —— 加解密在 src/agent_config/secrets.py，store 只存/取密文）──

    def upsert_skill_secret(
        self, skill_name: str, secret_name: str, value_ciphertext: bytes
    ) -> None:
        """写/替换一个 skill secret 的密文（``value_ciphertext`` = Fernet ciphertext，本层不解密）。

        值列**只存密文**（明文永不落库）；``updated_at`` = ISO 文本（与 policy_rules 同风格）。
        secret 名合法性由调用方（``secrets.set_secret`` + 端点）校验，本层只落盘。
        """
        now = _now_iso()
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO skill_secrets (skill_name, secret_name, value_ciphertext, updated_at) "
                "VALUES (?,?,?,?) "
                "ON CONFLICT(skill_name, secret_name) DO UPDATE SET "
                " value_ciphertext=excluded.value_ciphertext, updated_at=excluded.updated_at",
                (skill_name, secret_name, sqlite3.Binary(value_ciphertext), now),
            )
            conn.commit()

    def get_skill_secret_ciphertext(
        self, skill_name: str, secret_name: str
    ) -> Optional[bytes]:
        """取一个 skill secret 的密文（无 → None）。解密归 ``secrets.get_secret``。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT value_ciphertext FROM skill_secrets WHERE skill_name = ? AND secret_name = ?",
                (skill_name, secret_name),
            ).fetchone()
        return bytes(row["value_ciphertext"]) if row else None

    def list_skill_secret_ciphertexts(self, skill_name: str) -> list[tuple[str, bytes]]:
        """一个 skill 的全部 (secret_name, 密文) 对（按名排序）。供 ``secrets.get_secrets_for_skill``
        批量解密注入。返回密文，本层不解密。"""
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT secret_name, value_ciphertext FROM skill_secrets "
                "WHERE skill_name = ? ORDER BY secret_name",
                (skill_name,),
            ).fetchall()
        return [(r["secret_name"], bytes(r["value_ciphertext"])) for r in rows]

    def skill_secret_meta(self, skill_name: str) -> list[tuple[str, str]]:
        """一个 skill 已存储密钥的 (secret_name, updated_at) 对 —— **只名 + 时间戳，永不返回值**
        （owner Settings ``GET .../secrets`` 用）。"""
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT secret_name, updated_at FROM skill_secrets "
                "WHERE skill_name = ? ORDER BY secret_name",
                (skill_name,),
            ).fetchall()
        return [(r["secret_name"], r["updated_at"]) for r in rows]

    def delete_skill_secret(self, skill_name: str, secret_name: str) -> bool:
        """删一个 skill 的单个 secret 行（owner ``DELETE .../secrets/{name}``）。幂等（无行 False）。"""
        with self._connection() as conn:
            cur = conn.execute(
                "DELETE FROM skill_secrets WHERE skill_name = ? AND secret_name = ?",
                (skill_name, secret_name),
            )
            conn.commit()
        return cur.rowcount > 0

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

    def installed_rows_fingerprint(self) -> str:
        """安装行的确定性指纹串（installed_skills_hash 的 store 半部）。

        canonical：``ORDER BY skill_name``，每行 ``name|source_type|version|manifest_version`` join。
        **不含** enabled（启用态属于 active_skills_hash，不进 installed_skills_hash —— 见 plan §F）。
        PR2 把它与代码 builtin 签名拼接后 sha256 成最终 installed_skills_hash。
        """
        parts: list[str] = []
        for r in self.list_skills():
            parts.append(
                f"{r.skill_name}|{r.source_type}|{r.version or ''}|{r.manifest_version or ''}"
            )
        return "\n".join(parts)

    # ======================================================================
    # 外部服务授权凭证（external_credential，阶段 0a）
    # ——（加解密在 src/agent_config/credentials.py，store 只存/取密文，镜像 skill_secrets 分工）
    # ======================================================================

    def upsert_external_credential(
        self,
        namespace: str,
        credential_key: str,
        payload_ciphertext: bytes,
        *,
        expires_at: Optional[int] = None,
        metadata_json: Optional[str] = None,
    ) -> None:
        """写/替换一条外部凭证（``payload_ciphertext`` = Fernet ciphertext，本层不解密）。

        **整行替换语义**：``expires_at`` / ``metadata_json`` 不传即写 NULL（一次 token 刷新是
        payload 与到期时间**一起**换掉，留旧到期时间 = 谎报健康状态）。``created_at`` 是唯一例外
        —— 冲突时保留首次落库时间（镜像 ``install_skill`` 保 ``installed_at``）。
        键/形状合法性由调用方（``credentials.set_credential``）校验，本层只落盘。
        """
        now = _now()
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO external_credential "
                "(namespace, credential_key, payload_ciphertext, expires_at, metadata_json, "
                " created_at, updated_at) VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(namespace, credential_key) DO UPDATE SET "
                " payload_ciphertext=excluded.payload_ciphertext, expires_at=excluded.expires_at, "
                " metadata_json=excluded.metadata_json, updated_at=excluded.updated_at",
                (
                    namespace,
                    credential_key,
                    sqlite3.Binary(payload_ciphertext),
                    expires_at,
                    metadata_json,
                    now,
                    now,
                ),
            )
            conn.commit()

    def get_external_credential_ciphertext(
        self, namespace: str, credential_key: str
    ) -> Optional[bytes]:
        """取一条外部凭证的密文（无 → None）。解密归 ``credentials.get_credential``。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT payload_ciphertext FROM external_credential "
                "WHERE namespace = ? AND credential_key = ?",
                (namespace, credential_key),
            ).fetchone()
        return bytes(row["payload_ciphertext"]) if row else None

    def get_external_credential_meta(
        self, namespace: str, credential_key: str
    ) -> Optional[ExternalCredentialMeta]:
        """取一条外部凭证的**明文元数据**（含 expires_at）—— 不读密文列、不解密。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT namespace, credential_key, expires_at, metadata_json, created_at, "
                " updated_at FROM external_credential WHERE namespace = ? AND credential_key = ?",
                (namespace, credential_key),
            ).fetchone()
        return _row_to_external_credential_meta(row) if row else None

    def list_external_credential_meta(
        self, namespace: Optional[str] = None
    ) -> list[ExternalCredentialMeta]:
        """列外部凭证的明文元数据（``namespace`` 有值 = 严格等值过滤；None = 全部）。

        不读密文列、不解密（设置页「已连接的服务」清单用）。PK 前缀即 namespace，故等值过滤走
        主键索引，无需额外 index。
        """
        sql = (
            "SELECT namespace, credential_key, expires_at, metadata_json, created_at, updated_at "
            "FROM external_credential"
        )
        params: list[Any] = []
        if namespace is not None:
            sql += " WHERE namespace = ?"
            params.append(namespace)
        sql += " ORDER BY namespace, credential_key"
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_external_credential_meta(r) for r in rows]

    def delete_external_credential(self, namespace: str, credential_key: str) -> bool:
        """删一条外部凭证。幂等（无行 False）。"""
        with self._connection() as conn:
            cur = conn.execute(
                "DELETE FROM external_credential WHERE namespace = ? AND credential_key = ?",
                (namespace, credential_key),
            )
            conn.commit()
        return cur.rowcount > 0

    # ======================================================================
    # MCP connector 双表（08-01 阶段 1 PR1）
    # —— 凭证在 external_credential（credentials.py），这里只管连接元数据 + 工具清单
    # ======================================================================

    def upsert_connector(
        self,
        connector_id: str,
        *,
        server_url: str,
        display_name: Optional[str] = None,
        transport: str = "streamable_http",
    ) -> None:
        """建/刷 connector 行的**静态定义**字段。冲突时只更新 server_url/display_name/
        transport/updated_at —— status/enabled/scopes 等运行态一律不动（另走
        ``update_connector_state``）。"""
        if not connector_id or not isinstance(connector_id, str):
            raise ValueError("connector_id must be a non-empty string")
        now = _now()
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO connector (connector_id, server_url, transport, display_name,"
                " created_at, updated_at) VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(connector_id) DO UPDATE SET server_url=excluded.server_url,"
                " transport=excluded.transport, display_name=excluded.display_name,"
                " updated_at=excluded.updated_at",
                (connector_id, server_url, transport, display_name, now, now),
            )
            conn.commit()

    def update_connector_state(
        self,
        connector_id: str,
        *,
        status: Optional[str] = None,
        last_error: Any = _UNSET,
        scopes: Any = _UNSET,
        last_synced_at: Optional[int] = None,
        enabled: Optional[bool] = None,
    ) -> None:
        """部分更新运行态列。``last_error`` / ``scopes`` 用哨兵区分「不动」与「显式清空 None」。
        坏 status **入库时拒**（ValueError），不靠读侧宽容。"""
        sets: list[str] = []
        params: list[Any] = []
        if status is not None:
            if status not in CONNECTOR_STATUSES:
                raise ValueError(
                    f"connector status {status!r} not in {CONNECTOR_STATUSES}"
                )
            sets.append("status=?")
            params.append(status)
        if last_error is not _UNSET:
            sets.append("last_error=?")
            params.append(last_error)
        if scopes is not _UNSET:
            if scopes is not None and not (
                isinstance(scopes, list) and all(isinstance(s, str) for s in scopes)
            ):
                raise ValueError("connector scopes must be a list[str] or None")
            sets.append("scopes_json=?")
            params.append(json.dumps(scopes, ensure_ascii=False) if scopes is not None else None)
        if last_synced_at is not None:
            sets.append("last_synced_at=?")
            params.append(int(last_synced_at))
        if enabled is not None:
            sets.append("enabled=?")
            params.append(1 if enabled else 0)
        if not sets:
            return
        sets.append("updated_at=?")
        params.append(_now())
        params.append(connector_id)
        with self._connection() as conn:
            cur = conn.execute(
                f"UPDATE connector SET {', '.join(sets)} WHERE connector_id=?", params
            )
            conn.commit()
        if cur.rowcount == 0:
            raise KeyError(f"connector not found: {connector_id}")

    def get_connector(self, connector_id: str) -> Optional[ConnectorRow]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM connector WHERE connector_id=?", (connector_id,)
            ).fetchone()
        return _row_to_connector(row) if row else None

    def list_connectors(self) -> list[ConnectorRow]:
        with self._connection() as conn:
            rows = conn.execute("SELECT * FROM connector ORDER BY connector_id").fetchall()
        return [_row_to_connector(r) for r in rows]

    def sync_connector_tools(
        self, connector_id: str, tools: list[dict[str, Any]]
    ) -> dict[str, int]:
        """远端工具清单 → ``connector_tool`` 落库（refresh 纪律的唯一实现点）。

        - 🔴 只覆盖 manifest 派生字段（description / input_schema_json / output_schema_json /
          crud_type / destructive / last_seen_at / orphan=0），**永不**覆盖 ``enabled``
          （用户配置）与 ``first_seen_at``。crud_type 属 manifest 派生 ⇒ 全量 upsert 重跑
          derive 即自愈存量误判行（裁决①：owner 点一次 sync 就把旧 delete 误判刷成新推导）。
        - 本轮清单里没有的既有行 → ``orphan=1``（保留用户配置，PR2 不注册 orphan）。
        - 🔴 delete 类照常入库（Q16=A：清单完整）；坏 ``crud_type`` / 空 name **入库时拒**。
        """
        now = _now()
        prepared: list[tuple] = []
        seen: set[str] = set()
        for t in tools:
            name = t.get("name")
            if not name or not isinstance(name, str):
                raise ValueError(f"connector tool name must be a non-empty string: {t!r}")
            crud = t.get("crud_type", "read")
            if crud not in CONNECTOR_CRUD_TYPES:
                raise ValueError(
                    f"connector tool {name!r} crud_type {crud!r} not in {CONNECTOR_CRUD_TYPES}"
                )
            if name in seen:
                raise ValueError(f"duplicate tool name in manifest: {name!r}")
            seen.add(name)
            input_schema = t.get("input_schema")
            output_schema = t.get("output_schema")
            prepared.append(
                (
                    connector_id,
                    name,
                    t.get("description") or "",
                    json.dumps(input_schema, ensure_ascii=False) if input_schema is not None else None,
                    json.dumps(output_schema, ensure_ascii=False) if output_schema is not None else None,
                    crud,
                    1 if t.get("destructive") is True else 0,
                    now,
                    now,
                    now,
                )
            )
        with self._connection() as conn:
            existing = {
                r["tool_name"]
                for r in conn.execute(
                    "SELECT tool_name FROM connector_tool WHERE connector_id=?",
                    (connector_id,),
                ).fetchall()
            }
            for row in prepared:
                conn.execute(
                    "INSERT INTO connector_tool (connector_id, tool_name, description,"
                    " input_schema_json, output_schema_json, crud_type, destructive,"
                    " first_seen_at, last_seen_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(connector_id, tool_name) DO UPDATE SET"
                    " description=excluded.description,"
                    " input_schema_json=excluded.input_schema_json,"
                    " output_schema_json=excluded.output_schema_json,"
                    " crud_type=excluded.crud_type,"
                    " destructive=excluded.destructive,"
                    " orphan=0,"
                    " last_seen_at=excluded.last_seen_at,"
                    " updated_at=excluded.updated_at",
                    row,
                )
            orphaned = 0
            for name in existing - seen:
                conn.execute(
                    "UPDATE connector_tool SET orphan=1, updated_at=? "
                    "WHERE connector_id=? AND tool_name=?",
                    (now, connector_id, name),
                )
                orphaned += 1
            conn.commit()
        return {
            "total": len(prepared),
            "inserted": len(seen - existing),
            "updated": len(seen & existing),
            "orphaned": orphaned,
        }

    def list_connector_tools(self, connector_id: str) -> list[ConnectorToolRow]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM connector_tool WHERE connector_id=? ORDER BY tool_name",
                (connector_id,),
            ).fetchall()
        return [_row_to_connector_tool(r) for r in rows]

    def set_connector_tool_enabled(
        self, connector_id: str, tool_name: str, enabled: Optional[bool]
    ) -> None:
        """用户 per-tool 启用覆盖（None = 清除覆盖回默认）。

        🔴 ``crud_type='delete'`` 的行不可置启用态 —— **写侧拒**（ValueError），界面恒灰只是
        表象、这里才是闸（Q16=A；不靠读侧宽容，读侧 ``connector_tool_effective_enabled``
        只是防御纵深）。
        """
        with self._connection() as conn:
            row = conn.execute(
                "SELECT crud_type FROM connector_tool WHERE connector_id=? AND tool_name=?",
                (connector_id, tool_name),
            ).fetchone()
            if row is None:
                raise KeyError(f"connector tool not found: {connector_id}/{tool_name}")
            if enabled is True and row["crud_type"] == "delete":
                raise ValueError(
                    f"tool {tool_name!r} is delete-class and cannot be enabled "
                    "(delete tools are recorded for completeness but stay disabled in MVP)"
                )
            conn.execute(
                "UPDATE connector_tool SET enabled=?, updated_at=? "
                "WHERE connector_id=? AND tool_name=?",
                (
                    None if enabled is None else (1 if enabled else 0),
                    _now(),
                    connector_id,
                    tool_name,
                ),
            )
            conn.commit()

    # ======================================================================
    # exec 策略白名单（policy_rules，ADR-001 §6 D4）
    # ======================================================================

    def create_policy_rule(
        self,
        capability: str,
        matcher_json: str,
        *,
        context_mode: str = "manual_chat",
        note: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> PolicyRuleRow:
        """落一条结构化白名单规则。``matcher_json`` 已是校验过的 typed matcher 序列化串
        （合法性由 policy.py 的 pydantic 模型在 API 层把关，store 不二次解析——只存原样）。

        ``agent_id``（S5 per-agent，ADR-004 §3.3）：store 层只拒**空串/空白**（``agent_id=''``
        既非 NULL 也匹配不到任何 run，纯脏数据，codex P1-5）；「agent 存在且 type='custom'」的
        归属校验在 API 层做 —— agent 行在 sync_store（另一库），store 保持单库零跨库依赖
        （镜像 api_keys 纪律）。
        """
        if agent_id is not None and (not isinstance(agent_id, str) or not agent_id.strip()):
            raise ValueError("policy rule agent_id must be a non-empty string or None")
        now = _now_iso()
        with self._connection() as conn:
            cur = conn.execute(
                "INSERT INTO policy_rules "
                "(capability, matcher_json, context_mode, agent_id, enabled, note, created_at, "
                " last_used_at, use_count) VALUES (?,?,?,?,?,?,?,?,?)",
                (capability, matcher_json, context_mode, agent_id, 1, note, now, None, 0),
            )
            conn.commit()
            rule_id = int(cur.lastrowid)
            row = conn.execute("SELECT * FROM policy_rules WHERE id = ?", (rule_id,)).fetchone()
        return _row_to_policy_rule(row)

    def list_policy_rules(
        self,
        *,
        capability: Optional[str] = None,
        context_mode: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> list[PolicyRuleRow]:
        """列全部规则（可选按 capability / context_mode / agent_id 过滤），最新在前。
        ``agent_id=None`` = 不过滤（现状，含全局与 per-agent 全部行）；有值 = 严格等值。"""
        sql = "SELECT * FROM policy_rules"
        clauses: list[str] = []
        params: list[Any] = []
        if capability is not None:
            clauses.append("capability = ?")
            params.append(capability)
        if context_mode is not None:
            clauses.append("context_mode = ?")
            params.append(context_mode)
        if agent_id is not None:
            clauses.append("agent_id = ?")
            params.append(agent_id)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY id DESC"
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_policy_rule(r) for r in rows]

    def get_policy_rule(self, rule_id: int) -> Optional[PolicyRuleRow]:
        with self._connection() as conn:
            row = conn.execute("SELECT * FROM policy_rules WHERE id = ?", (rule_id,)).fetchone()
        return _row_to_policy_rule(row) if row else None

    def set_policy_rule(
        self, rule_id: int, *, enabled: Optional[bool] = None, note: Optional[str] = None
    ) -> Optional[PolicyRuleRow]:
        """启用/停用 + 改备注（owner 管理页用）。不存在返回 None。matcher 不可 patch
        （放宽 = 删旧建新，防原地把窄规则悄悄改宽）。"""
        sets: list[str] = []
        params: list[Any] = []
        if enabled is not None:
            sets.append("enabled = ?")
            params.append(1 if enabled else 0)
        if note is not None:
            sets.append("note = ?")
            params.append(note)
        if not sets:
            return self.get_policy_rule(rule_id)
        params.append(rule_id)
        with self._connection() as conn:
            cur = conn.execute(
                f"UPDATE policy_rules SET {', '.join(sets)} WHERE id = ?", params
            )
            conn.commit()
            if cur.rowcount == 0:
                return None
            row = conn.execute("SELECT * FROM policy_rules WHERE id = ?", (rule_id,)).fetchone()
        return _row_to_policy_rule(row)

    def delete_policy_rule(self, rule_id: int) -> bool:
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM policy_rules WHERE id = ?", (rule_id,))
            conn.commit()
            return cur.rowcount > 0

    def candidate_policy_rules(
        self, capability: str, context_mode: str, agent_id: Optional[str] = None
    ) -> list[PolicyRuleRow]:
        """评估候选规则（双键，ADR-004 §3.3）：

        - ``agent_id=None``（manual 消费方现状）→ ``AND agent_id IS NULL``，查询串与 S2
          **逐字节相同**（tests/agent_config 有源文本锚定断言，勿改动该字符串）；
        - ``agent_id='<id>'``（headless per-agent）→ ``AND agent_id = ?`` **严格等值** ——
          全局（NULL）规则永不进 headless 候选集，headless 规则永不进 manual 候选集
          （红线①双向物理隔离，绝无 ``IS NULL OR``）；
        - ``agent_id`` 空串/空白 → 空候选（脏实参拒绝，evaluate 兜底 ask，codex P1-5）。

        **context_mode 严格等值绑定**（红线①）：manual_chat 规则永不进 untrusted_trigger 查询的
        候选集，反之亦然。
        """
        if agent_id is None:
            sql = (
                "SELECT * FROM policy_rules WHERE enabled = 1 AND capability = ? "
                "AND context_mode = ? AND agent_id IS NULL ORDER BY id ASC"
            )
            params: tuple[Any, ...] = (capability, context_mode)
        else:
            if not isinstance(agent_id, str) or not agent_id.strip():
                return []
            sql = (
                "SELECT * FROM policy_rules WHERE enabled = 1 AND capability = ? "
                "AND context_mode = ? AND agent_id = ? ORDER BY id ASC"
            )
            params = (capability, context_mode, agent_id)
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_policy_rule(r) for r in rows]

    def delete_policy_rules_for_agent(self, agent_id: str) -> int:
        """agent 删除级联（ADR-004 §3.3 ④）：清该 agent 的全部 policy_rules —— 悬空规则虽匹配
        不到 run，但会在 Settings 留鬼行。返回删除行数。空/空白 agent_id → 0（**绝不**误删
        agent_id IS NULL 的全局规则）。reports 的 delete_agent 路径调用。"""
        if not isinstance(agent_id, str) or not agent_id.strip():
            return 0
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM policy_rules WHERE agent_id = ?", (agent_id,))
            conn.commit()
            return cur.rowcount

    def bump_policy_rule_use(self, rule_id: int) -> None:
        """规则命中（auto_allow）→ last_used_at=now + use_count+1（审计 + 管理页展示）。"""
        with self._connection() as conn:
            conn.execute(
                "UPDATE policy_rules SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?",
                (_now_iso(), rule_id),
            )
            conn.commit()

    # ======================================================================
    # owner 级全局设置（owner_settings，07-16 approval-mode switcher）
    # ======================================================================

    def get_owner_setting(self, key: str) -> Optional[str]:
        """读一个 owner 设置值；无行 → None（调用方自带默认，如 approval mode 回落 manual）。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT value FROM owner_settings WHERE key = ?", (key,)
            ).fetchone()
        return row["value"] if row else None

    def set_owner_setting(self, key: str, value: str) -> None:
        """写/覆盖一个 owner 设置值（upsert）。合法性（值域校验）由 API 层把关，本层只落盘。"""
        if not isinstance(key, str) or not key.strip():
            raise ValueError("owner setting key must be a non-empty string")
        if not isinstance(value, str):
            raise ValueError("owner setting value must be a string")
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO owner_settings (key, value, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                " updated_at=excluded.updated_at",
                (key, value, _now_iso()),
            )
            conn.commit()

    # -- internal ----------------------------------------------------------

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
