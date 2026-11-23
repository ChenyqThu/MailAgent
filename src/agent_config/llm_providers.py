"""LLM 上游多 Provider 配置面（task 07-12 P0，prd §4.1）—— ``llm_provider`` / ``llm_model``
双表 + 快照版本元行，落 ``agent_config.db``（backend-owned，**不进** ``DB_VERSION``，镜像
``store.py`` 纪律：幂等 DDL、per-call 短连接、进程内单例）。

数据语义：
  - ``llm_provider``：一行 = 一个上游服务（官方家 / 中转），``protocol`` 决定消费端用哪条
    协议腿（Node registry create 函数 / Python anthropic·openai 双腿）。``base_url`` 存
    **原样值**（协议归一化如 anthropic 补 /v1 由消费端做，prd §4.3b）。
  - ``llm_model``：provider 下的模型行（``source`` = 'fetched' 上游拉取 / 'manual' 手动），
    ``enabled`` 驱动各功能位选择器的可选集；``max_output`` = per-model clamp 依据；
    ``context_window`` = 可选上下文窗口元数据（两者 NULL 都表示未知）。
  - ``llm_provider_meta``：``snapshot_version`` 单行计数 —— 任何 provider/model CRUD 写后 +1，
    gateway 按 version 缓存 registry 实例（prd §4.3b）。

**API key 加密**：复用 S2 per-skill secret 的 Fernet + Keychain master key 机制
（``src/agent_config/secrets.py`` 的 ``encrypt_secret``/``decrypt_secret``，同一把 master key，
不造第二套）。``api_key_cipher`` 只存密文；明文只在 snapshot（local-token 端点）与连通性
测试时解出，永不落日志。

**模型引用格式（providerRef，prd §4.3b）**：全链路 ``providerId:modelId``；无冒号的 legacy id
→ ``('default', 整串)`` —— 解析单源 = 本模块 ``parse_provider_ref``（双端契约锚点）。
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable, Iterator, Optional

from loguru import logger

from src.agent_config.secrets import decrypt_secret, encrypt_secret
from src.agent_config.store import resolve_agent_config_db_path

# ---------------------------------------------------------------------------
# 概念常量
# ---------------------------------------------------------------------------

# legacy 无冒号模型 id 归属的 provider（seed 迁移把现有 env 配置落成这一行）。
DEFAULT_PROVIDER_ID = "default"

# protocol 枚举（存储层只校验枚举，不做协议行为 —— 协议差异归消费端，prd §4.1）。
PROVIDER_PROTOCOLS: tuple[str, ...] = (
    "anthropic",
    "openai",
    "openai-compatible",
    "google",
    "deepseek",
    "openrouter",
)

MODEL_SOURCES: tuple[str, ...] = ("fetched", "manual")

PRIVACY_BUILTIN_CATEGORIES: tuple[str, ...] = (
    "secret",
    "id_card",
    "phone",
    "email",
    "bank_card",
)
_PRIVACY_CONFIG_KEY = "privacy_mask_config"
_PRIVACY_TAG_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,23}$")
_REDOS_NESTED_RE = re.compile(r"\([^)]*[+*][^)]*\)[+*?{]")

# provider id = registry key + providerRef 前半 —— 必须是规范 slug（不含 ':'，否则
# parse_provider_ref 切分歧义）。镜像 store.py _SKILL_NAME_RE 纪律。
_PROVIDER_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,40}$")

_SNAPSHOT_VERSION_KEY = "snapshot_version"

# update_provider 的「未传」哨兵（None 是合法值：api_key=None 表示清除）。
_UNSET: Any = object()


def parse_provider_ref(ref: str) -> tuple[str, str]:
    """providerRef → ``(provider_id, model_id)``（prd §4.3b，双端一致的解析规则）。

    按**第一个** ``:`` 切分；无 ``:`` → ``('default', 整串)``（legacy 兼容——report_agent 行 /
    localStorage 偏好 / .env 老值零迁移可用）。model_id 内含 ``:`` 合法（切分只认第一个）。
    """
    if ":" in ref:
        provider_id, model_id = ref.split(":", 1)
        return provider_id, model_id
    return DEFAULT_PROVIDER_ID, ref


def _now() -> int:
    return int(time.time())


def _fetched_meta_columns(
    meta: Optional[dict[str, Any]],
) -> tuple[Optional[str], Optional[str], Optional[int], Optional[int]]:
    """上游 meta dict → ``(display_name, capabilities_json, max_output, context_window)``。

    任何一项拿不到（缺席 / None / 空串 / 非正整数）都落 None —— merge 侧用 COALESCE 写，
    None = 这一列不动。**不臆造**：上游没标注能力就是 NULL，不是「全 false」。"""
    meta = meta or {}
    name = meta.get("display_name")
    name = name.strip() if isinstance(name, str) and name.strip() else None
    caps = meta.get("capabilities")
    caps_json = (
        json.dumps(caps, ensure_ascii=False, sort_keys=True) if isinstance(caps, dict) else None
    )

    def _positive_int(value: Any) -> Optional[int]:
        ok = isinstance(value, int) and not isinstance(value, bool) and value > 0
        return value if ok else None

    max_output = _positive_int(meta.get("max_output"))
    context_window = _positive_int(meta.get("context_window"))
    return name, caps_json, max_output, context_window


# ---------------------------------------------------------------------------
# 行投影 dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LlmProviderRow:
    """``llm_provider`` 行投影。``has_key`` 只暴露有无（明文经 store.get_provider_api_key 单点解）。"""

    id: str
    protocol: str
    display_name: str
    base_url: str
    has_key: bool
    headers: dict[str, str]
    enabled: bool
    sort_order: int
    created_at: int
    updated_at: int
    has_extra_keys: bool = False
    custom_icon: Optional[str] = None
    privacy_mask_enabled: bool = False


@dataclass(frozen=True)
class LlmModelRow:
    """``llm_model`` 行投影。``capabilities`` 已解析（NULL = 未标注，消费端自行兜底）。"""

    provider_id: str
    model_id: str
    display_name: Optional[str]
    group_name: Optional[str]
    enabled: bool
    capabilities: Optional[dict[str, Any]]
    max_output: Optional[int]
    context_window: Optional[int]
    source: str
    fetched_at: Optional[int]


# ---------------------------------------------------------------------------
# DDL —— 幂等，不进 DB_VERSION（backend-owned db，开库即对齐）
# ---------------------------------------------------------------------------

_DDL = """
CREATE TABLE IF NOT EXISTS llm_provider (
    id                    TEXT PRIMARY KEY,
    protocol              TEXT NOT NULL,
    display_name          TEXT NOT NULL DEFAULT '',
    base_url              TEXT NOT NULL DEFAULT '',
    api_key_cipher        BLOB,
    extra_api_keys_cipher BLOB,
    headers_json          TEXT,
    custom_icon           TEXT,
    privacy_mask_enabled  INTEGER NOT NULL DEFAULT 0,
    enabled               INTEGER NOT NULL DEFAULT 1,
    sort_order            INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_model (
    provider_id       TEXT NOT NULL,
    model_id          TEXT NOT NULL,
    display_name      TEXT,
    group_name        TEXT,
    enabled           INTEGER NOT NULL DEFAULT 0,
    capabilities_json TEXT,
    max_output        INTEGER,
    context_window    INTEGER,
    source            TEXT NOT NULL DEFAULT 'manual',
    fetched_at        INTEGER,
    PRIMARY KEY (provider_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_llm_model_provider ON llm_model(provider_id, enabled);

-- 快照版本元行（snapshot_version）：任何 provider/model CRUD 写后 +1（prd §4.3b）。
CREATE TABLE IF NOT EXISTS llm_provider_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Phase 4 WP-4D — 诊断探测日志（环形保留最近 200 条；写它不 bump snapshot_version）。
CREATE TABLE IF NOT EXISTS llm_probe_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT,
    protocol    TEXT,
    model       TEXT,
    kind        TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    status_code INTEGER,
    error_code  TEXT,
    latency_ms  INTEGER,
    message     TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_probe_created ON llm_probe_log(created_at);

-- Phase 4 WP-4D — Python 后台辅助表面（memory_capture / user_md_compile / contact_profile / task_extract）
-- 走直连降级腿时的用量审计表；走 gateway loopback 时由 ai_chat.db.ai_llm_usage_log 记。
CREATE TABLE IF NOT EXISTS py_llm_usage_log (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    surface            TEXT NOT NULL,
    model              TEXT NOT NULL,
    protocol           TEXT,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    cost_usd           REAL,
    latency_ms         INTEGER,
    status             TEXT NOT NULL DEFAULT 'ok',
    created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_py_llm_usage_created ON py_llm_usage_log(created_at);

-- Phase 5 WP-5A — 本地隐私占位符脱敏命中计数（只落类别与计数，绝不落任何命中明文或占位符）。
CREATE TABLE IF NOT EXISTS privacy_mask_hits (
    category   TEXT PRIMARY KEY,
    hit_count  INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
"""


class LlmProviderStore:
    """SQLite-backed LLM provider 配置存储（per-call 短连接，WAL 友好）。

    与 ``AgentConfigStore`` 同款纪律：只持 db_path，连接 per-op open/close，进程内共享单例
    零风险。写方法一律在同一事务内 ``_bump_version_conn``。
    """

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._ensure_schema()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
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
            provider_cols = {
                row["name"] for row in conn.execute("PRAGMA table_info(llm_provider)").fetchall()
            }
            if "extra_api_keys_cipher" not in provider_cols:
                conn.execute("ALTER TABLE llm_provider ADD COLUMN extra_api_keys_cipher BLOB")
            if "custom_icon" not in provider_cols:
                conn.execute("ALTER TABLE llm_provider ADD COLUMN custom_icon TEXT")
            if "privacy_mask_enabled" not in provider_cols:
                conn.execute(
                    "ALTER TABLE llm_provider ADD COLUMN privacy_mask_enabled INTEGER NOT NULL DEFAULT 0"
                )
            columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(llm_model)").fetchall()
            }
            if "context_window" not in columns:
                conn.execute("ALTER TABLE llm_model ADD COLUMN context_window INTEGER")
            conn.commit()

    # ======================================================================
    # 快照版本
    # ======================================================================

    def get_snapshot_version(self) -> int:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT value FROM llm_provider_meta WHERE key = ?", (_SNAPSHOT_VERSION_KEY,)
            ).fetchone()
        if row is None:
            return 0
        try:
            return int(row["value"])
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _bump_version_conn(conn: sqlite3.Connection) -> None:
        """同事务内 version +1（不存在则落 1）。所有写方法在 commit 前调用。"""
        conn.execute(
            "INSERT INTO llm_provider_meta (key, value) VALUES (?, '1') "
            "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
            (_SNAPSHOT_VERSION_KEY,),
        )

    # ======================================================================
    # provider CRUD
    # ======================================================================

    def has_providers(self) -> bool:
        with self._connection() as conn:
            row = conn.execute("SELECT 1 FROM llm_provider LIMIT 1").fetchone()
        return row is not None

    def list_providers(self) -> list[LlmProviderRow]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM llm_provider ORDER BY sort_order ASC, created_at ASC, id ASC"
            ).fetchall()
        return [_row_to_provider(r) for r in rows]

    def get_provider(self, provider_id: str) -> Optional[LlmProviderRow]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM llm_provider WHERE id = ?", (provider_id,)
            ).fetchone()
        return _row_to_provider(row) if row else None

    def create_provider(
        self,
        provider_id: str,
        *,
        protocol: str,
        display_name: str = "",
        base_url: str = "",
        api_key: Optional[str] = None,
        extra_api_keys: Optional[list[str]] = None,
        headers: Optional[dict[str, str]] = None,
        custom_icon: Optional[str] = None,
        privacy_mask_enabled: bool = False,
        enabled: bool = True,
        sort_order: int = 0,
    ) -> LlmProviderRow:
        """新建 provider 行。id 必须规范 slug（不含 ':'）；protocol 必须在枚举内；重复 id →
        ``ValueError``。``api_key`` 非空则 Fernet 加密落 ``api_key_cipher``（空/None = 无 key，
        UI 后补 —— 密文列 NULL）。"""
        pid = self._validate_provider_id(provider_id)
        proto = self._validate_protocol(protocol)
        cipher = encrypt_secret(api_key) if api_key else None
        extra_cipher = self._encrypt_extra_keys(extra_api_keys)
        headers_json = self._validate_headers(headers)
        icon = self._validate_custom_icon(custom_icon)
        now = _now()
        with self._connection() as conn:
            try:
                conn.execute(
                    "INSERT INTO llm_provider "
                    "(id, protocol, display_name, base_url, api_key_cipher, "
                    " extra_api_keys_cipher, headers_json, custom_icon, privacy_mask_enabled, "
                    " enabled, sort_order, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        pid,
                        proto,
                        display_name or "",
                        base_url or "",
                        sqlite3.Binary(cipher) if cipher is not None else None,
                        sqlite3.Binary(extra_cipher) if extra_cipher is not None else None,
                        headers_json,
                        icon,
                        1 if privacy_mask_enabled else 0,
                        1 if enabled else 0,
                        int(sort_order),
                        now,
                        now,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"provider id already exists: {pid!r}") from exc
            self._bump_version_conn(conn)
            conn.commit()
        created = self.get_provider(pid)
        assert created is not None  # 刚插入
        return created

    def update_provider(
        self,
        provider_id: str,
        *,
        protocol: Any = _UNSET,
        display_name: Any = _UNSET,
        base_url: Any = _UNSET,
        api_key: Any = _UNSET,
        extra_api_keys: Any = _UNSET,
        headers: Any = _UNSET,
        header_patch: Any = _UNSET,
        custom_icon: Any = _UNSET,
        privacy_mask_enabled: Any = _UNSET,
        enabled: Any = _UNSET,
        sort_order: Any = _UNSET,
    ) -> Optional[LlmProviderRow]:
        """部分更新（未传字段不动）。``api_key``：传非空 str = 重加密替换；传 None/空串 = 清除
        （密文列置 NULL）。``header_patch``：单键增量修改（str 写 / None 删，不影响未传的已有 header）。
        行不存在返回 None。"""
        if headers is not _UNSET and header_patch is not _UNSET:
            raise ValueError("cannot specify both headers and header_patch")
        sets: list[str] = []
        params: list[Any] = []
        if protocol is not _UNSET:
            sets.append("protocol = ?")
            params.append(self._validate_protocol(protocol))
        if display_name is not _UNSET:
            sets.append("display_name = ?")
            params.append(display_name or "")
        if base_url is not _UNSET:
            sets.append("base_url = ?")
            params.append(base_url or "")
        if api_key is not _UNSET:
            cipher = encrypt_secret(api_key) if api_key else None
            sets.append("api_key_cipher = ?")
            params.append(sqlite3.Binary(cipher) if cipher is not None else None)
        if extra_api_keys is not _UNSET:
            extra_cipher = self._encrypt_extra_keys(extra_api_keys)
            sets.append("extra_api_keys_cipher = ?")
            params.append(sqlite3.Binary(extra_cipher) if extra_cipher is not None else None)
        if headers is not _UNSET:
            sets.append("headers_json = ?")
            params.append(self._validate_headers(headers))
        if custom_icon is not _UNSET:
            sets.append("custom_icon = ?")
            params.append(self._validate_custom_icon(custom_icon))
        if privacy_mask_enabled is not _UNSET:
            sets.append("privacy_mask_enabled = ?")
            params.append(1 if privacy_mask_enabled else 0)
        if enabled is not _UNSET:
            sets.append("enabled = ?")
            params.append(1 if enabled else 0)
        if sort_order is not _UNSET:
            sets.append("sort_order = ?")
            params.append(int(sort_order))
        if header_patch is not _UNSET:
            if not isinstance(header_patch, dict) or not all(
                isinstance(k, str) and (v is None or isinstance(v, str))
                for k, v in header_patch.items()
            ):
                raise ValueError("header_patch must map string keys to string or None")
        if not sets and header_patch is _UNSET:
            return self.get_provider(provider_id)
        with self._connection() as conn:
            if header_patch is not _UNSET:
                existing_row = conn.execute(
                    "SELECT headers_json FROM llm_provider WHERE id = ?", (provider_id,)
                ).fetchone()
                if existing_row is None:
                    return None
                merged_headers: dict[str, str] = {}
                if existing_row["headers_json"]:
                    try:
                        parsed = json.loads(existing_row["headers_json"])
                        if isinstance(parsed, dict):
                            merged_headers = {
                                str(k): str(v) for k, v in parsed.items()
                            }
                    except (json.JSONDecodeError, TypeError):
                        merged_headers = {}
                for hk, hv in header_patch.items():
                    if hv is None:
                        merged_headers.pop(hk, None)
                    else:
                        merged_headers[hk] = hv
                sets.append("headers_json = ?")
                params.append(self._validate_headers(merged_headers) if merged_headers else None)
            sets.append("updated_at = ?")
            params.append(_now())
            params.append(provider_id)
            cur = conn.execute(
                f"UPDATE llm_provider SET {', '.join(sets)} WHERE id = ?", params
            )
            if cur.rowcount == 0:
                return None
            self._bump_version_conn(conn)
            conn.commit()
        return self.get_provider(provider_id)

    def reorder_providers(self, ordered_ids: list[str]) -> list[LlmProviderRow]:
        """按 ordered_ids 重排 sort_order（未在清单内的现有行顺延排在后面，零丢行）。"""
        now = _now()
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT id FROM llm_provider ORDER BY sort_order ASC, created_at ASC, id ASC"
            ).fetchall()
            existing = [r["id"] for r in rows]
            existing_set = set(existing)
            seen: set[str] = set()
            final_order: list[str] = []
            for pid in ordered_ids:
                if pid in existing_set and pid not in seen:
                    seen.add(pid)
                    final_order.append(pid)
            for pid in existing:
                if pid not in seen:
                    seen.add(pid)
                    final_order.append(pid)
            for idx, pid in enumerate(final_order):
                conn.execute(
                    "UPDATE llm_provider SET sort_order = ?, updated_at = ? WHERE id = ?",
                    (idx, now, pid),
                )
            if final_order:
                self._bump_version_conn(conn)
            conn.commit()
        return self.list_providers()

    def delete_provider(self, provider_id: str) -> bool:
        """删 provider 行 + 级联删其 ``llm_model`` 行。``default`` 行禁删（legacy 无冒号
        providerRef 解析到它，删了 = 老配置引用悬空）→ ``ValueError``。幂等：无行返回 False。"""
        if provider_id == DEFAULT_PROVIDER_ID:
            raise ValueError("the 'default' provider cannot be deleted")
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM llm_provider WHERE id = ?", (provider_id,))
            removed = cur.rowcount > 0
            if removed:
                conn.execute("DELETE FROM llm_model WHERE provider_id = ?", (provider_id,))
                self._bump_version_conn(conn)
            conn.commit()
        return removed

    def get_provider_api_key(self, provider_id: str) -> Optional[str]:
        """解密取 provider 的 API key 明文（无行/无密文 → None）。解密失败（master key 轮换 /
        密文损坏）→ None + warning（镜像 secrets.get_secrets_for_skill 的 graceful 纪律），
        值任何形态不进日志。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT api_key_cipher FROM llm_provider WHERE id = ?", (provider_id,)
            ).fetchone()
        if row is None or row["api_key_cipher"] is None:
            return None
        try:
            return decrypt_secret(bytes(row["api_key_cipher"]))
        except Exception:  # noqa: BLE001 — 值不进异常消息/日志
            logger.warning(
                "failed to decrypt llm provider api key (provider={}) — treating as absent",
                provider_id,
            )
            return None

    def get_provider_extra_api_keys(self, provider_id: str) -> list[str]:
        """解密取 provider 的备用 API key 池（无行/无密文/损坏 → []）。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT extra_api_keys_cipher FROM llm_provider WHERE id = ?",
                (provider_id,),
            ).fetchone()
        if row is None or row["extra_api_keys_cipher"] is None:
            return []
        try:
            raw = decrypt_secret(bytes(row["extra_api_keys_cipher"]))
            parsed = json.loads(raw)
        except Exception:  # noqa: BLE001 — 值不进日志
            logger.warning(
                "failed to decrypt extra llm provider api keys (provider={}) — treating as empty",
                provider_id,
            )
            return []
        if not isinstance(parsed, list):
            return []
        return [k.strip() for k in parsed if isinstance(k, str) and k.strip()]

    def get_provider_api_keys(self, provider_id: str) -> list[str]:
        """返回去重后的全部可用 API key 序列（主 key 在前，备用池在后）。"""
        keys: list[str] = []
        seen: set[str] = set()
        primary = self.get_provider_api_key(provider_id)
        for cand in ([primary] if primary else []) + self.get_provider_extra_api_keys(provider_id):
            c = cand.strip()
            if c and c not in seen:
                seen.add(c)
                keys.append(c)
        return keys

    def model_counts_by_provider(self) -> dict[str, tuple[int, int]]:
        """返回 ``{provider_id: (total_count, enabled_count)}`` 聚合计数（一次 SQL 避免 N+1）。"""
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT provider_id, COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled_count "
                "FROM llm_model GROUP BY provider_id"
            ).fetchall()
        return {
            r["provider_id"]: (int(r["total"] or 0), int(r["enabled_count"] or 0))
            for r in rows
        }

    # ======================================================================
    # model CRUD
    # ======================================================================

    def list_models(self, provider_id: str) -> list[LlmModelRow]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM llm_model WHERE provider_id = ? ORDER BY model_id ASC",
                (provider_id,),
            ).fetchall()
        return [_row_to_model(r) for r in rows]

    def upsert_model(
        self,
        provider_id: str,
        model_id: str,
        *,
        display_name: Optional[str] = None,
        group_name: Optional[str] = None,
        enabled: bool = False,
        capabilities: Optional[dict[str, Any]] = None,
        max_output: Optional[int] = None,
        context_window: Optional[int] = None,
        source: str = "manual",
    ) -> LlmModelRow:
        """写/覆盖一个模型行（手动添加 / seed 用；upsert = 全字段覆盖）。"""
        model_id = (model_id or "").strip()
        if not model_id:
            raise ValueError("model_id is required")
        if source not in MODEL_SOURCES:
            raise ValueError(f"model source must be one of {MODEL_SOURCES}, got {source!r}")
        caps_json = (
            json.dumps(capabilities, ensure_ascii=False, sort_keys=True)
            if capabilities is not None
            else None
        )
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO llm_model "
                "(provider_id, model_id, display_name, group_name, enabled, capabilities_json, "
                " max_output, context_window, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(provider_id, model_id) DO UPDATE SET "
                " display_name=excluded.display_name, group_name=excluded.group_name, "
                " enabled=excluded.enabled, capabilities_json=excluded.capabilities_json, "
                " max_output=excluded.max_output, context_window=excluded.context_window, "
                " source=excluded.source",
                (
                    provider_id,
                    model_id,
                    display_name,
                    group_name,
                    1 if enabled else 0,
                    caps_json,
                    max_output,
                    context_window,
                    source,
                    None,
                ),
            )
            self._bump_version_conn(conn)
            conn.commit()
            row = conn.execute(
                "SELECT * FROM llm_model WHERE provider_id = ? AND model_id = ?",
                (provider_id, model_id),
            ).fetchone()
        return _row_to_model(row)

    def set_model_enabled(self, provider_id: str, model_id: str, enabled: bool) -> bool:
        with self._connection() as conn:
            cur = conn.execute(
                "UPDATE llm_model SET enabled = ? WHERE provider_id = ? AND model_id = ?",
                (1 if enabled else 0, provider_id, model_id),
            )
            if cur.rowcount > 0:
                self._bump_version_conn(conn)
            conn.commit()
        return cur.rowcount > 0

    def delete_model(self, provider_id: str, model_id: str) -> bool:
        with self._connection() as conn:
            cur = conn.execute(
                "DELETE FROM llm_model WHERE provider_id = ? AND model_id = ?",
                (provider_id, model_id),
            )
            if cur.rowcount > 0:
                self._bump_version_conn(conn)
            conn.commit()
        return cur.rowcount > 0

    def batch_update_models(
        self,
        provider_id: str,
        *,
        action: str,
        model_ids: Optional[list[str]] = None,
    ) -> int:
        """批量启停或清理未启用拉取模型（单事务 + version +1）。"""
        if action not in ("enable", "disable", "clear_unenabled_fetched"):
            raise ValueError(
                f"invalid batch action {action!r}; must be enable/disable/clear_unenabled_fetched"
            )
        cleaned_ids: Optional[list[str]] = None
        if model_ids is not None:
            cleaned_ids = [m.strip() for m in model_ids if isinstance(m, str) and m.strip()]
            if not cleaned_ids:
                return 0
        affected = 0
        chunk_size = 400
        with self._connection() as conn:
            if action in ("enable", "disable"):
                val = 1 if action == "enable" else 0
                if cleaned_ids is None:
                    cur = conn.execute(
                        "UPDATE llm_model SET enabled = ? WHERE provider_id = ? AND enabled != ?",
                        (val, provider_id, val),
                    )
                    affected += int(cur.rowcount or 0)
                else:
                    for idx in range(0, len(cleaned_ids), chunk_size):
                        chunk = cleaned_ids[idx : idx + chunk_size]
                        placeholders = ",".join("?" for _ in chunk)
                        cur = conn.execute(
                            f"UPDATE llm_model SET enabled = ? "
                            f"WHERE provider_id = ? AND enabled != ? AND model_id IN ({placeholders})",
                            [val, provider_id, val, *chunk],
                        )
                        affected += int(cur.rowcount or 0)
            else:
                if cleaned_ids is None:
                    cur = conn.execute(
                        "DELETE FROM llm_model WHERE provider_id = ? AND enabled = 0 AND source = 'fetched'",
                        (provider_id,),
                    )
                    affected += int(cur.rowcount or 0)
                else:
                    for idx in range(0, len(cleaned_ids), chunk_size):
                        chunk = cleaned_ids[idx : idx + chunk_size]
                        placeholders = ",".join("?" for _ in chunk)
                        cur = conn.execute(
                            f"DELETE FROM llm_model WHERE provider_id = ? "
                            f"AND enabled = 0 AND source = 'fetched' AND model_id IN ({placeholders})",
                            [provider_id, *chunk],
                        )
                        affected += int(cur.rowcount or 0)
            if affected > 0:
                self._bump_version_conn(conn)
            conn.commit()
        return affected

    def merge_fetched_models(
        self, provider_id: str, models: Iterable[tuple[str, Optional[dict[str, Any]]]]
    ) -> int:
        """上游拉取结果 merge 进 ``llm_model``（prd §4.4）：新 id → INSERT
        ``source='fetched', enabled=0`` 并落上游给出的元数据；已有行（含 manual）→ 刷
        ``fetched_at`` + **只填 NULL 列**（COALESCE），**不覆盖** source / enabled /
        用户手填过的元数据。返回新插入行数。

        每项是 ``(model_id, meta)``；``meta`` 的键是列名子集
        （``display_name`` / ``capabilities`` / ``max_output`` / ``context_window``），
        缺席或 None = 上游没给这一项，不写（**不写 = 保留原值**，不是清空）。"""
        now = _now()
        inserted = 0
        # 先查存量集合再插/刷（同一连接、单事务）——upsert 的 rowcount 区分不了插入与更新，
        # 且本方法非热路径（行数 ≤ 数百），显式两步最直白。
        items = [
            (mid.strip(), _fetched_meta_columns(meta))
            for mid, meta in models
            if (mid or "").strip()
        ]
        with self._connection() as conn:
            existing = {
                r["model_id"]
                for r in conn.execute(
                    "SELECT model_id FROM llm_model WHERE provider_id = ?", (provider_id,)
                ).fetchall()
            }
            for mid, cols in items:
                if mid in existing:
                    conn.execute(
                        "UPDATE llm_model SET fetched_at = ?, "
                        " display_name = COALESCE(display_name, ?), "
                        " capabilities_json = COALESCE(capabilities_json, ?), "
                        " max_output = COALESCE(max_output, ?), "
                        " context_window = COALESCE(context_window, ?) "
                        "WHERE provider_id = ? AND model_id = ?",
                        (now, *cols, provider_id, mid),
                    )
                else:
                    conn.execute(
                        "INSERT INTO llm_model "
                        "(provider_id, model_id, enabled, source, fetched_at, "
                        " display_name, capabilities_json, max_output, context_window) "
                        "VALUES (?,?,0,'fetched',?,?,?,?,?)",
                        (provider_id, mid, now, *cols),
                    )
                    inserted += 1
            if items:
                self._bump_version_conn(conn)
            conn.commit()
        return inserted

    # ======================================================================
    # seed 迁移（prd §4.1：首次表空时把 env 老配置落成 default provider 行）
    # ======================================================================

    def seed_default_from_env(
        self,
        *,
        api_base: str,
        api_key: str,
        model: str,
        enabled_models: Iterable[str],
    ) -> bool:
        """表空时 seed ``id='default', protocol='anthropic'`` provider 行 + 其下模型行
        （``enabled_models`` ∪ ``model``，enabled=1 / source='manual' / max_output=NULL）。

        幂等：``llm_provider`` 已有**任何**行 → 直接返回 False 零副作用（seed 后行权威，
        env 键降级为首次默认 —— 镜像项目周报 trigger 配置模式）。``api_key`` 空 → 密文列
        NULL（UI 后补）。并发首 seed 用 INSERT OR IGNORE 兜底，最多落一次。
        """
        if self.has_providers():
            return False
        seen: set[str] = set()
        model_ids: list[str] = []
        for mid in list(enabled_models) + [model]:
            mid = (mid or "").strip()
            if mid and mid not in seen:
                seen.add(mid)
                model_ids.append(mid)
        cipher = encrypt_secret(api_key) if api_key else None
        now = _now()
        with self._connection() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO llm_provider "
                "(id, protocol, display_name, base_url, api_key_cipher, headers_json, "
                " enabled, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    DEFAULT_PROVIDER_ID,
                    "anthropic",
                    "Default",
                    (api_base or "").strip(),
                    sqlite3.Binary(cipher) if cipher is not None else None,
                    None,
                    1,
                    0,
                    now,
                    now,
                ),
            )
            if cur.rowcount == 0:
                # 并发 race：别人已 seed —— 本调用零副作用。
                conn.rollback()
                return False
            for mid in model_ids:
                conn.execute(
                    "INSERT OR IGNORE INTO llm_model "
                    "(provider_id, model_id, enabled, source, fetched_at) "
                    "VALUES (?,?,1,'manual',NULL)",
                    (DEFAULT_PROVIDER_ID, mid),
                )
            self._bump_version_conn(conn)
            conn.commit()
        return True

    # ======================================================================
    # snapshot（prd §4.3b 契约 —— gateway 消费，含解密 key）
    # ======================================================================

    def snapshot(self) -> dict[str, Any]:
        """§4.3b 快照：``{version, providers:[{id,protocol,displayName,baseUrl,apiKey,headers,
        enabled,models:[{id,displayName,enabled,capabilities,maxOutput,source}]}]}``。

        只含 enabled provider；每 provider 含**全部**模型行（带 enabled 字段，消费端自筛）。
        ``apiKey`` 为解密明文（无 key → ""）；``baseUrl`` 原样存储值（归一化归消费端）。
        ``capabilities``/``maxOutput`` 未标注 → null（不臆造能力位）。
        """
        providers: list[dict[str, Any]] = []
        any_privacy = False
        for p in self.list_providers():
            if not p.enabled:
                continue
            models = [
                {
                    "id": m.model_id,
                    "displayName": m.display_name,
                    "enabled": m.enabled,
                    "capabilities": m.capabilities,
                    "maxOutput": m.max_output,
                    "contextWindow": m.context_window,
                    "source": m.source,
                }
                for m in self.list_models(p.id)
            ]
            all_keys = self.get_provider_api_keys(p.id)
            primary_key = self.get_provider_api_key(p.id) or ""
            entry: dict[str, Any] = {
                "id": p.id,
                "protocol": p.protocol,
                "displayName": p.display_name,
                "baseUrl": p.base_url,
                "apiKey": primary_key if primary_key else (all_keys[0] if all_keys else ""),
                "headers": p.headers,
                "enabled": True,
                "models": models,
            }
            if len(all_keys) > 1 or p.has_extra_keys:
                entry["apiKeys"] = all_keys
            if p.custom_icon:
                entry["customIcon"] = p.custom_icon
            if p.privacy_mask_enabled:
                entry["privacyMaskEnabled"] = True
                any_privacy = True
            providers.append(entry)
        result: dict[str, Any] = {"version": self.get_snapshot_version(), "providers": providers}
        if any_privacy:
            result["privacyMask"] = self.get_privacy_mask_config()
        return result

    # ======================================================================
    # Phase 5 WP-5A — Privacy Mask Config & Zero-Plaintext Hit Counts
    # ======================================================================

    @staticmethod
    def default_privacy_mask_config() -> dict[str, Any]:
        return {
            "builtIn": {cat: True for cat in PRIVACY_BUILTIN_CATEGORIES},
            "customRules": [],
        }

    def get_privacy_mask_config(self) -> dict[str, Any]:
        default = self.default_privacy_mask_config()
        with self._connection() as conn:
            row = conn.execute(
                "SELECT value FROM llm_provider_meta WHERE key = ?", (_PRIVACY_CONFIG_KEY,)
            ).fetchone()
        if row is None or not row["value"]:
            return default
        try:
            parsed = json.loads(row["value"])
        except (json.JSONDecodeError, TypeError):
            return default
        if not isinstance(parsed, dict):
            return default
        try:
            return self._validate_privacy_mask_config(parsed)
        except ValueError:
            return default

    @staticmethod
    def _validate_privacy_mask_config(raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise ValueError("privacy mask config must be an object")
        unknown_top = set(raw.keys()) - {"builtIn", "customRules"}
        if unknown_top:
            raise ValueError(f"unknown privacy config field(s): {sorted(unknown_top)}")

        built_in: dict[str, bool] = {cat: True for cat in PRIVACY_BUILTIN_CATEGORIES}
        raw_builtin = raw.get("builtIn")
        if raw_builtin is not None:
            if not isinstance(raw_builtin, dict):
                raise ValueError("'builtIn' must be an object mapping category -> bool")
            unknown_cats = set(raw_builtin.keys()) - set(PRIVACY_BUILTIN_CATEGORIES)
            if unknown_cats:
                raise ValueError(f"unknown builtIn categories: {sorted(unknown_cats)}")
            for cat, val in raw_builtin.items():
                if not isinstance(val, bool):
                    raise ValueError(f"builtIn[{cat!r}] must be a boolean")
                built_in[cat] = val

        rules_out: list[dict[str, Any]] = []
        raw_rules = raw.get("customRules", [])
        if raw_rules is not None:
            if not isinstance(raw_rules, list):
                raise ValueError("'customRules' must be an array")
            if len(raw_rules) > 32:
                raise ValueError("at most 32 custom privacy rules are allowed")
            seen_ids: set[str] = set()
            for idx, item in enumerate(raw_rules):
                if not isinstance(item, dict):
                    raise ValueError(f"customRules[{idx}] must be an object")
                unknown_r = set(item.keys()) - {"id", "name", "pattern", "tag", "enabled"}
                if unknown_r:
                    raise ValueError(f"customRules[{idx}] unknown keys: {sorted(unknown_r)}")
                rid = item.get("id")
                if not isinstance(rid, str) or not rid.strip() or len(rid.strip()) > 64:
                    raise ValueError(f"customRules[{idx}].id must be a non-empty string (<=64 chars)")
                rid = rid.strip()
                if rid in seen_ids:
                    raise ValueError(f"duplicate custom rule id: {rid!r}")
                seen_ids.add(rid)

                name = item.get("name")
                if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80:
                    raise ValueError(f"customRules[{idx}].name must be a non-empty string (<=80 chars)")

                pattern = item.get("pattern")
                if not isinstance(pattern, str) or not pattern or len(pattern) > 256:
                    raise ValueError(
                        f"customRules[{idx}].pattern must be a non-empty string (<=256 chars)"
                    )
                if _REDOS_NESTED_RE.search(pattern):
                    raise ValueError(
                        f"customRules[{idx}].pattern contains unsafe nested quantifiers"
                    )
                try:
                    compiled = re.compile(pattern)
                except re.error as exc:
                    raise ValueError(f"customRules[{idx}].pattern is invalid regex: {exc}") from exc
                if compiled.match("") is not None:
                    raise ValueError(
                        f"customRules[{idx}].pattern must not match the empty string"
                    )

                raw_tag = item.get("tag", "CUSTOM")
                if not isinstance(raw_tag, str) or not raw_tag.strip():
                    raise ValueError(f"customRules[{idx}].tag must be a non-empty string")
                tag = raw_tag.strip().upper()
                if not _PRIVACY_TAG_RE.match(tag):
                    raise ValueError(
                        f"customRules[{idx}].tag must match ^[A-Z][A-Z0-9_]{{0,23}}$"
                    )

                enabled = item.get("enabled", True)
                if not isinstance(enabled, bool):
                    raise ValueError(f"customRules[{idx}].enabled must be a boolean")

                rules_out.append(
                    {
                        "id": rid,
                        "name": name.strip(),
                        "pattern": pattern,
                        "tag": tag,
                        "enabled": enabled,
                    }
                )

        return {"builtIn": built_in, "customRules": rules_out}

    def set_privacy_mask_config(self, raw: Any) -> dict[str, Any]:
        validated = self._validate_privacy_mask_config(raw)
        encoded = json.dumps(validated, ensure_ascii=False, sort_keys=True)
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO llm_provider_meta (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (_PRIVACY_CONFIG_KEY, encoded),
            )
            self._bump_version_conn(conn)
            conn.commit()
        return validated

    def record_privacy_hits(self, counts: dict[str, int]) -> None:
        """Increment category hit counters (NEVER stores plaintext or placeholders)."""
        if not isinstance(counts, dict) or not counts:
            return
        now = _now()
        clean: list[tuple[str, int]] = []
        for cat, delta in counts.items():
            if not isinstance(cat, str) or not cat.strip():
                continue
            if isinstance(delta, bool) or not isinstance(delta, int) or delta <= 0:
                continue
            clean.append((cat.strip().upper()[:32], min(delta, 100_000)))
        if not clean:
            return
        with self._connection() as conn:
            for cat, delta in clean:
                conn.execute(
                    "INSERT INTO privacy_mask_hits (category, hit_count, updated_at) "
                    "VALUES (?, ?, ?) "
                    "ON CONFLICT(category) DO UPDATE SET "
                    "hit_count = privacy_mask_hits.hit_count + excluded.hit_count, "
                    "updated_at = excluded.updated_at",
                    (cat, delta, now),
                )
            conn.commit()

    def get_privacy_hits(self) -> dict[str, Any]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT category, hit_count, updated_at FROM privacy_mask_hits "
                "ORDER BY hit_count DESC, category ASC"
            ).fetchall()
        items = [
            {
                "category": str(r["category"]),
                "count": int(r["hit_count"] or 0),
                "updatedAt": int(r["updated_at"] or 0),
            }
            for r in rows
        ]
        return {"total": sum(item["count"] for item in items), "byCategory": items}

    def clear_privacy_hits(self) -> int:
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM privacy_mask_hits")
            conn.commit()
            return int(cur.rowcount or 0)

    # -- internal ----------------------------------------------------------

    @staticmethod
    def _encrypt_extra_keys(extra_api_keys: Optional[list[str]]) -> Optional[bytes]:
        if extra_api_keys is None:
            return None
        if not isinstance(extra_api_keys, list) or not all(
            isinstance(k, str) for k in extra_api_keys
        ):
            raise ValueError("extra_api_keys must be a list of strings")
        cleaned: list[str] = []
        seen: set[str] = set()
        for raw in extra_api_keys:
            k = raw.strip()
            if k and k not in seen:
                seen.add(k)
                cleaned.append(k)
        if not cleaned:
            return None
        return encrypt_secret(json.dumps(cleaned, ensure_ascii=False))

    @staticmethod
    def _validate_custom_icon(custom_icon: Optional[str]) -> Optional[str]:
        if custom_icon is None:
            return None
        if not isinstance(custom_icon, str):
            raise ValueError("custom_icon must be a string or None")
        cleaned = custom_icon.strip()
        if not cleaned:
            return None
        if len(cleaned) > 200:
            raise ValueError("custom_icon exceeds 200 characters")
        return cleaned

    @staticmethod
    def _validate_provider_id(provider_id: str) -> str:
        pid = (provider_id or "").strip()
        if not _PROVIDER_ID_RE.match(pid):
            raise ValueError(
                f"provider id must be a lowercase slug matching {_PROVIDER_ID_RE.pattern!r} "
                f"(no ':' — it is the providerRef separator), got {provider_id!r}"
            )
        return pid

    @staticmethod
    def _validate_protocol(protocol: str) -> str:
        if protocol not in PROVIDER_PROTOCOLS:
            raise ValueError(
                f"protocol must be one of {PROVIDER_PROTOCOLS}, got {protocol!r}"
            )
        return protocol

    @staticmethod
    def _validate_headers(headers: Optional[dict[str, str]]) -> Optional[str]:
        if headers is None:
            return None
        if not isinstance(headers, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in headers.items()
        ):
            raise ValueError("headers must be a flat string→string mapping")
        return json.dumps(headers, ensure_ascii=False, sort_keys=True)

    # ======================================================================
    # Phase 4 WP-4D — probe diagnostic log (ring 200) & Python fallback usage log
    # ======================================================================

    def append_probe_log(
        self,
        *,
        kind: str,
        ok: bool,
        provider_id: Optional[str] = None,
        protocol: Optional[str] = None,
        model: Optional[str] = None,
        status_code: Optional[int] = None,
        error_code: Optional[str] = None,
        latency_ms: Optional[int] = None,
        message: Optional[str] = None,
        created_at: Optional[int] = None,
    ) -> int:
        """Append one redacted connectivity/runtime diagnostic entry and prune beyond 200 rows."""
        ts = int(created_at if created_at is not None else time.time() * 1000)
        trimmed_msg = message[:300] if isinstance(message, str) else None
        with self._connection() as conn:
            cur = conn.execute(
                """
                INSERT INTO llm_probe_log (
                    provider_id, protocol, model, kind, ok, status_code,
                    error_code, latency_ms, message, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    provider_id,
                    protocol,
                    model,
                    kind,
                    1 if ok else 0,
                    status_code,
                    error_code,
                    latency_ms,
                    trimmed_msg,
                    ts,
                ),
            )
            conn.execute(
                "DELETE FROM llm_probe_log WHERE id NOT IN "
                "(SELECT id FROM llm_probe_log ORDER BY id DESC LIMIT 200)"
            )
            conn.commit()
            return int(cur.lastrowid or 0)

    def list_probe_logs(self, *, limit: int = 50) -> list[dict[str, Any]]:
        """Return newest diagnostic probe logs (default 50, max 200)."""
        bounded = max(1, min(int(limit), 200))
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT id, provider_id, protocol, model, kind, ok,
                       status_code, error_code, latency_ms, message, created_at
                FROM llm_probe_log
                ORDER BY id DESC
                LIMIT ?
                """,
                (bounded,),
            ).fetchall()
        return [
            {
                "id": int(r["id"]),
                "providerId": r["provider_id"],
                "protocol": r["protocol"],
                "model": r["model"],
                "kind": r["kind"],
                "ok": bool(r["ok"]),
                "statusCode": r["status_code"],
                "errorCode": r["error_code"],
                "latencyMs": r["latency_ms"],
                "message": r["message"],
                "createdAt": int(r["created_at"]),
            }
            for r in rows
        ]

    def clear_probe_logs(self) -> int:
        """Delete all entries from llm_probe_log; returns deleted row count."""
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM llm_probe_log")
            conn.commit()
            return int(cur.rowcount or 0)

    def append_py_usage(
        self,
        *,
        surface: str,
        model: str,
        protocol: Optional[str] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
        cache_write_tokens: Optional[int] = None,
        cost_usd: Optional[float] = None,
        latency_ms: Optional[int] = None,
        status: str = "ok",
        created_at: Optional[int] = None,
    ) -> int:
        """Record one auxiliary Python direct-fallback LLM call (uncached input convention)."""
        ts = int(created_at if created_at is not None else time.time() * 1000)
        with self._connection() as conn:
            cur = conn.execute(
                """
                INSERT INTO py_llm_usage_log (
                    surface, model, protocol, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, cost_usd,
                    latency_ms, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    surface,
                    model,
                    protocol,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_write_tokens,
                    cost_usd,
                    latency_ms,
                    status,
                    ts,
                ),
            )
            conn.commit()
            return int(cur.lastrowid or 0)


# ---------------------------------------------------------------------------
# row → dataclass
# ---------------------------------------------------------------------------


def _row_to_provider(row: sqlite3.Row) -> LlmProviderRow:
    headers: dict[str, str] = {}
    if row["headers_json"]:
        try:
            parsed = json.loads(row["headers_json"])
            headers = parsed if isinstance(parsed, dict) else {}
        except (json.JSONDecodeError, TypeError):
            headers = {}
    cols = set(row.keys())
    return LlmProviderRow(
        id=row["id"],
        protocol=row["protocol"],
        display_name=row["display_name"] or "",
        base_url=row["base_url"] or "",
        has_key=row["api_key_cipher"] is not None,
        headers=headers,
        enabled=bool(row["enabled"]),
        sort_order=int(row["sort_order"] or 0),
        created_at=int(row["created_at"] or 0),
        updated_at=int(row["updated_at"] or 0),
        has_extra_keys=("extra_api_keys_cipher" in cols and row["extra_api_keys_cipher"] is not None),
        custom_icon=row["custom_icon"] if "custom_icon" in cols else None,
        privacy_mask_enabled=(
            bool(row["privacy_mask_enabled"]) if "privacy_mask_enabled" in cols else False
        ),
    )


def _row_to_model(row: sqlite3.Row) -> LlmModelRow:
    capabilities: Optional[dict[str, Any]] = None
    if row["capabilities_json"]:
        try:
            parsed = json.loads(row["capabilities_json"])
            capabilities = parsed if isinstance(parsed, dict) else None
        except (json.JSONDecodeError, TypeError):
            capabilities = None
    return LlmModelRow(
        provider_id=row["provider_id"],
        model_id=row["model_id"],
        display_name=row["display_name"],
        group_name=row["group_name"],
        enabled=bool(row["enabled"]),
        capabilities=capabilities,
        max_output=int(row["max_output"]) if row["max_output"] is not None else None,
        context_window=(
            int(row["context_window"]) if row["context_window"] is not None else None
        ),
        source=row["source"],
        fetched_at=int(row["fetched_at"]) if row["fetched_at"] is not None else None,
    )


# ---------------------------------------------------------------------------
# 进程内单例（lazy，镜像 store.py / api_keys 纪律）
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def get_llm_provider_store() -> LlmProviderStore:
    """进程内 LlmProviderStore 单例（lazy）。与 AgentConfigStore 同库不同表，路径解析共用
    ``resolve_agent_config_db_path``（env 覆盖 → sync_store 同目录 → DATA_ROOT）。"""
    return LlmProviderStore(db_path=resolve_agent_config_db_path())


def reset_llm_provider_store_cache() -> None:
    """test-only：清单例缓存，让测试切换 ``MAILAGENT_AGENT_CONFIG_DB_PATH`` 后重建。"""
    get_llm_provider_store.cache_clear()


def best_effort_append_probe_log(**kwargs: Any) -> None:
    """Safely record a probe/runtime diagnostic entry without ever interrupting callers."""
    try:
        get_llm_provider_store().append_probe_log(**kwargs)
    except Exception as exc:  # noqa: BLE001
        logger.debug(f"[llm-providers] best_effort_append_probe_log ignored: {exc}")


def best_effort_append_py_usage(**kwargs: Any) -> None:
    """Safely record a Python fallback auxiliary usage entry without ever interrupting callers."""
    try:
        get_llm_provider_store().append_py_usage(**kwargs)
    except Exception as exc:  # noqa: BLE001
        logger.debug(f"[llm-providers] best_effort_append_py_usage ignored: {exc}")
