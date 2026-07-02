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


def _hash(text: str) -> str:
    """文本 → sha256 hex（content_hash / profile_hash 用，与 api_keys._hash_key 同算法）。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


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

    @property
    def is_builtin(self) -> bool:
        return self.source_type == "builtin"


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
    updated_at          INTEGER NOT NULL
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
            conn.commit()

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
        session_id: Optional[int] = None,
    ) -> SkillRow:
        """安装/更新一个用户来源 skill（source_type ∈ INSTALLABLE_SOURCE_TYPES）。

        ``granted_scopes`` 写时校验 ⊆ KNOWN_SCOPES（复用 api_keys.validate_scopes）—— 非法 scope
        ``ValueError``，不静默产出 manifest 里调不动的死工具。记一条 install 事件。
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
                " enabled, granted_scopes_json, package_hash, trusted, last_error, installed_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(skill_name) DO UPDATE SET "
                " source_type=excluded.source_type, source_uri=excluded.source_uri, "
                " version=excluded.version, manifest_version=excluded.manifest_version, "
                " manifest_json=excluded.manifest_json, enabled=excluded.enabled, "
                " granted_scopes_json=excluded.granted_scopes_json, package_hash=excluded.package_hash, "
                " trusted=excluded.trusted, last_error=NULL, updated_at=excluded.updated_at",
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
                ),
            )
            self._record_event_conn(
                conn, skill_name, "install", {"source_type": source_type}, session_id, now
            )
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
