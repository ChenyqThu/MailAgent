"""Scoped Bearer API keys for headless external-agent access (Phase 1).

第三方 agent（OpenClaw / Claude Code / 其他 MCP client）无浏览器、拿不到 CF Access
OAuth cookie，需要一条 ``Authorization: Bearer <key>`` 通道。本模块是该通道的存储 +
策略真源：

  - **Scoped principal**：key 不是「全能密码」，绑定一组 scopes，默认只读
    (``READ_ONLY_SCOPES``)；写/执行 scope 必须显式授予。
  - **只存 hash**：DB 不存明文，明文只在 ``create_key`` 返回时显示一次。
  - **可撤销 / 轮换**：``revoke`` / ``rotate``，撤销立即 fail-closed。
  - **可审计**：``write_audit`` 记录 key / route / skill / tool / scope / 状态 / 耗时。

**存储位置铁律**：backend-owned SQLite（默认 ``<sync_store 同目录>/api_auth.db``，
可经 ``MAILAGENT_API_AUTH_DB_PATH`` 覆盖）。**绝不**写 ``ai_chat.db`` —— 其 schema
owner 是前端 ``chat_db.ts``（Phase 0 BASE-4 不变式）。表自带 ``CREATE TABLE IF NOT
EXISTS`` 幂等初始化，不参与 ``sync_store.db`` 的 ``DB_VERSION`` 体系，故无需同步前端
``EXPECTED_DB_VERSION``。
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable, Iterator, Optional

# 明文 key 前缀（便于人/日志一眼识别 + grep 泄漏）。token 主体走 secrets.token_urlsafe。
KEY_PREFIX = "mak_"  # MailAgent (agent) Key

# ---------------------------------------------------------------------------
# Scope catalog —— 与 Skill manifest 的 tool.auth_scopes 对齐（src/skills）。
# write / execute / external-call scope **不**进 READ_ONLY 默认，必须显式授予。
# ---------------------------------------------------------------------------
KNOWN_SCOPES: frozenset[str] = frozenset(
    {
        "email:read",
        "attachment:read",
        "report:read",
        "report:run",
        "calendar:read",
        "calendar:write",
        "email:draft",
        "email:write",
        "notion_agent:invoke",
    }
)

# create_key 不传 scopes 时的默认 = 纯只读（最小权限）。
READ_ONLY_SCOPES: tuple[str, ...] = (
    "email:read",
    "attachment:read",
    "report:read",
    "calendar:read",
)

# P1 handoff 推荐 key（只读 + 报告执行）。CLI ``api-key create --preset handoff`` 用。
# **不含** email:write / notion_agent:invoke（发信 / notion-agent 默认不授外部 key）。
HANDOFF_SCOPES: tuple[str, ...] = (
    "email:read",
    "attachment:read",
    "report:read",
    "report:run",
)

# 起草专用 key（issue #50）：能读 + 能建草稿，**不能发信**（无 email:write → email_send 在
# manifest / MCP 投影里都看不见，直调 403）。
DRAFTER_SCOPES: tuple[str, ...] = (
    "email:read",
    "attachment:read",
    "email:draft",
)

# 完整写 key：发信 + 起草。``email:write`` **不隐含** ``email:draft``（has_scopes 是精确
# AND 判定，不做层级/OR），所以「能发信也该能起草」这件事在 preset 这一层显式兜住 —— 用
# ``--scopes email:write`` 手工授权则按字面来，不做隐式扩权。
WRITER_SCOPES: tuple[str, ...] = (
    "email:read",
    "attachment:read",
    "email:draft",
    "email:write",
)

_DDL = """
CREATE TABLE IF NOT EXISTS agent_api_keys (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    key_prefix  TEXT NOT NULL,
    key_hash    TEXT NOT NULL UNIQUE,
    scopes_json TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at  INTEGER,
    revoked_at  INTEGER
);

CREATE TABLE IF NOT EXISTS agent_api_key_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id      TEXT,
    route       TEXT NOT NULL,
    skill       TEXT,
    tool        TEXT,
    scopes_json TEXT,
    status      TEXT NOT NULL,
    error_code  TEXT,
    duration_ms INTEGER,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_key ON agent_api_key_audit(key_id, created_at DESC);
"""


def _now() -> int:
    return int(time.time())


def _hash_key(plaintext: str) -> str:
    """明文 key → sha256 hex。DB 只存这个，永不存明文。"""
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def validate_scopes(scopes: Iterable[str]) -> tuple[str, ...]:
    """校验 scopes ⊆ KNOWN_SCOPES，去重排序返回；非法 scope → ValueError。"""
    cleaned = sorted({str(s).strip() for s in scopes if str(s).strip()})
    unknown = [s for s in cleaned if s not in KNOWN_SCOPES]
    if unknown:
        raise ValueError(
            f"unknown scope(s): {unknown}; valid scopes: {sorted(KNOWN_SCOPES)}"
        )
    return tuple(cleaned)


@dataclass(frozen=True)
class ApiKeyRecord:
    """agent_api_keys 行投影（**不含** key_hash —— 永不出库）。"""

    id: str
    label: str
    key_prefix: str
    scopes: tuple[str, ...]
    created_at: int
    last_used_at: Optional[int]
    expires_at: Optional[int]
    revoked_at: Optional[int]

    @property
    def is_active(self) -> bool:
        if self.revoked_at is not None:
            return False
        if self.expires_at is not None and self.expires_at <= _now():
            return False
        return True


def _row_to_record(row: sqlite3.Row) -> ApiKeyRecord:
    try:
        scopes = tuple(json.loads(row["scopes_json"]) or [])
    except (json.JSONDecodeError, TypeError):
        scopes = ()
    return ApiKeyRecord(
        id=row["id"],
        label=row["label"],
        key_prefix=row["key_prefix"],
        scopes=scopes,
        created_at=row["created_at"],
        last_used_at=row["last_used_at"],
        expires_at=row["expires_at"],
        revoked_at=row["revoked_at"],
    )


class ApiKeyStore:
    """SQLite-backed scoped API key store（per-call 短命连接，WAL 友好）。

    与 ``ReportStore`` 同款：只持 db_path，连接 per-op open/close，进程内共享单例零风险。
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

    # -- create / verify ---------------------------------------------------
    def create_key(
        self,
        label: str,
        *,
        scopes: Optional[Iterable[str]] = None,
        expires_at: Optional[int] = None,
    ) -> tuple[ApiKeyRecord, str]:
        """新建一个 scoped key。返回 (record, plaintext)。明文仅此一次可见。

        scopes=None → READ_ONLY_SCOPES（最小权限默认）。非法 scope → ValueError。
        """
        label = (label or "").strip()
        if not label:
            raise ValueError("label is required")
        resolved_scopes = validate_scopes(
            scopes if scopes is not None else READ_ONLY_SCOPES
        )
        plaintext = KEY_PREFIX + secrets.token_urlsafe(32)
        key_id = uuid.uuid4().hex
        key_prefix = plaintext[: len(KEY_PREFIX) + 8]  # mak_ + 8 chars（非密，仅展示）
        now = _now()
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO agent_api_keys "
                "(id, label, key_prefix, key_hash, scopes_json, created_at, "
                " last_used_at, expires_at, revoked_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    key_id,
                    label,
                    key_prefix,
                    _hash_key(plaintext),
                    json.dumps(list(resolved_scopes), ensure_ascii=False),
                    now,
                    None,
                    expires_at,
                    None,
                ),
            )
            conn.commit()
        record = ApiKeyRecord(
            id=key_id,
            label=label,
            key_prefix=key_prefix,
            scopes=resolved_scopes,
            created_at=now,
            last_used_at=None,
            expires_at=expires_at,
            revoked_at=None,
        )
        return record, plaintext

    def verify(self, plaintext: str) -> Optional[ApiKeyRecord]:
        """明文 key → active record，或 None（无此 key / 已撤销 / 已过期）。

        按 sha256(plaintext) 查 UNIQUE key_hash 列（哈希查找，明文不入比较）。
        撤销 / 过期一律返回 None → 调用方 fail-closed。
        """
        if not plaintext:
            return None
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM agent_api_keys WHERE key_hash = ?",
                (_hash_key(plaintext),),
            ).fetchone()
        if row is None:
            return None
        record = _row_to_record(row)
        return record if record.is_active else None

    # -- list / get / revoke / rotate -------------------------------------
    def list_keys(self, *, include_revoked: bool = True) -> list[ApiKeyRecord]:
        sql = "SELECT * FROM agent_api_keys"
        if not include_revoked:
            sql += " WHERE revoked_at IS NULL"
        sql += " ORDER BY created_at DESC"
        with self._connection() as conn:
            rows = conn.execute(sql).fetchall()
        return [_row_to_record(r) for r in rows]

    def get_key(self, key_id: str) -> Optional[ApiKeyRecord]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM agent_api_keys WHERE id = ?", (key_id,)
            ).fetchone()
        return _row_to_record(row) if row else None

    def revoke(self, key_id: str) -> bool:
        """撤销 key（幂等：已撤销再撤返回 False）。撤销后 verify 立即返回 None。"""
        with self._connection() as conn:
            cur = conn.execute(
                "UPDATE agent_api_keys SET revoked_at = ? "
                "WHERE id = ? AND revoked_at IS NULL",
                (_now(), key_id),
            )
            conn.commit()
            return cur.rowcount > 0

    def rotate(self, key_id: str) -> Optional[str]:
        """轮换：同 id/label/scopes 换新明文（旧明文立即失效），清 last_used。

        返回新明文（仅此一次可见）；key 不存在 **或已撤销** → None（撤销是终态，rotate 不复活
        revoked key —— 要重新启用须显式 create 新 key，避免「rotate 复活」误操作）。
        """
        plaintext = KEY_PREFIX + secrets.token_urlsafe(32)
        key_prefix = plaintext[: len(KEY_PREFIX) + 8]
        with self._connection() as conn:
            cur = conn.execute(
                "UPDATE agent_api_keys SET key_hash = ?, key_prefix = ?, "
                "last_used_at = NULL WHERE id = ? AND revoked_at IS NULL",
                (_hash_key(plaintext), key_prefix, key_id),
            )
            conn.commit()
            if cur.rowcount == 0:
                return None
        return plaintext

    # -- usage + audit -----------------------------------------------------
    def record_use(self, key_id: str) -> None:
        with self._connection() as conn:
            conn.execute(
                "UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?",
                (_now(), key_id),
            )
            conn.commit()

    def write_audit(
        self,
        *,
        route: str,
        status: str,
        key_id: Optional[str] = None,
        skill: Optional[str] = None,
        tool: Optional[str] = None,
        scopes: Optional[Iterable[str]] = None,
        error_code: Optional[str] = None,
        duration_ms: Optional[int] = None,
    ) -> None:
        scopes_json = (
            json.dumps(sorted(set(scopes)), ensure_ascii=False)
            if scopes is not None
            else None
        )
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO agent_api_key_audit "
                "(key_id, route, skill, tool, scopes_json, status, error_code, "
                " duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    key_id,
                    route,
                    skill,
                    tool,
                    scopes_json,
                    status,
                    error_code,
                    duration_ms,
                    _now(),
                ),
            )
            conn.commit()

    def list_audit(self, *, key_id: Optional[str] = None, limit: int = 50) -> list[dict[str, Any]]:
        """读审计行（测试 / 运维诊断用）。"""
        sql = "SELECT * FROM agent_api_key_audit"
        params: list[Any] = []
        if key_id is not None:
            sql += " WHERE key_id = ?"
            params.append(key_id)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# 路径解析 + 进程内单例（lazy，镜像 deps.py 的 lazy-config 纪律）
# ---------------------------------------------------------------------------


def api_auth_db_for(sync_store_db_path: str) -> str:
    """从 sync_store.db 路径推 api_auth.db（同目录并列）。CLI 用（带 --db-path 覆盖时也对）。"""
    return os.path.join(os.path.dirname(os.path.abspath(sync_store_db_path)), "api_auth.db")


def resolve_api_auth_db_path(sync_store_db_path: Optional[str] = None) -> str:
    """api_auth.db 绝对路径 —— **serve-api 与 CLI 的统一解析真源**（必须一致，否则 CLI 建的 key
    serve-api 看不见）。

    优先级：env ``MAILAGENT_API_AUTH_DB_PATH``（serve-api / CLI 都认，最高优先 → 设了就一致）→
    显式 ``sync_store_db_path`` 同目录（CLI 传 cli_config 路径，尊重 --db-path/--config）→
    config.sync_store_db_path 同目录（serve-api 不传参时）→ config 构造失败回退
    ``<DATA_ROOT>/data/api_auth.db``。
    """
    override = os.environ.get("MAILAGENT_API_AUTH_DB_PATH")
    if override:
        return os.path.abspath(os.path.expanduser(override))
    if sync_store_db_path:
        return api_auth_db_for(sync_store_db_path)
    try:
        from src.config import config as _config_singleton

        return api_auth_db_for(_config_singleton.sync_store_db_path)
    except Exception:  # noqa: BLE001 — 裸 worktree / 缺 .env：回退 DATA_ROOT
        data_root = os.environ.get("MAILAGENT_DATA_ROOT") or "."
        return os.path.join(os.path.abspath(data_root), "data", "api_auth.db")


@lru_cache(maxsize=1)
def get_api_key_store() -> ApiKeyStore:
    """进程内 ApiKeyStore 单例（lazy）。store 无状态（只持 db_path），WAL 下并发安全。"""
    return ApiKeyStore(db_path=resolve_api_auth_db_path())


def reset_api_key_store_cache() -> None:
    """test-only：清单例缓存，让测试切换 ``MAILAGENT_API_AUTH_DB_PATH`` 后重建。"""
    get_api_key_store.cache_clear()
