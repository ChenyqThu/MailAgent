"""LLM 上游多 Provider 配置面（task 07-12 P0，prd §4.1）—— ``llm_provider`` / ``llm_model``
双表 + 快照版本元行，落 ``agent_config.db``（backend-owned，**不进** ``DB_VERSION``，镜像
``store.py`` 纪律：幂等 DDL、per-call 短连接、进程内单例）。

数据语义：
  - ``llm_provider``：一行 = 一个上游服务（官方家 / 中转），``protocol`` 决定消费端用哪条
    协议腿（Node registry create 函数 / Python anthropic·openai 双腿）。``base_url`` 存
    **原样值**（协议归一化如 anthropic 补 /v1 由消费端做，prd §4.3b）。
  - ``llm_model``：provider 下的模型行（``source`` = 'fetched' 上游拉取 / 'manual' 手动），
    ``enabled`` 驱动各功能位选择器的可选集；``max_output`` = per-model clamp 依据（NULL 不 clamp）。
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
    source: str
    fetched_at: Optional[int]


# ---------------------------------------------------------------------------
# DDL —— 幂等，不进 DB_VERSION（backend-owned db，开库即对齐）
# ---------------------------------------------------------------------------

_DDL = """
CREATE TABLE IF NOT EXISTS llm_provider (
    id             TEXT PRIMARY KEY,
    protocol       TEXT NOT NULL,
    display_name   TEXT NOT NULL DEFAULT '',
    base_url       TEXT NOT NULL DEFAULT '',
    api_key_cipher BLOB,
    headers_json   TEXT,
    enabled        INTEGER NOT NULL DEFAULT 1,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_model (
    provider_id       TEXT NOT NULL,
    model_id          TEXT NOT NULL,
    display_name      TEXT,
    group_name        TEXT,
    enabled           INTEGER NOT NULL DEFAULT 0,
    capabilities_json TEXT,
    max_output        INTEGER,
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
        headers: Optional[dict[str, str]] = None,
        enabled: bool = True,
        sort_order: int = 0,
    ) -> LlmProviderRow:
        """新建 provider 行。id 必须规范 slug（不含 ':'）；protocol 必须在枚举内；重复 id →
        ``ValueError``。``api_key`` 非空则 Fernet 加密落 ``api_key_cipher``（空/None = 无 key，
        UI 后补 —— 密文列 NULL）。"""
        pid = self._validate_provider_id(provider_id)
        proto = self._validate_protocol(protocol)
        cipher = encrypt_secret(api_key) if api_key else None
        headers_json = self._validate_headers(headers)
        now = _now()
        with self._connection() as conn:
            try:
                conn.execute(
                    "INSERT INTO llm_provider "
                    "(id, protocol, display_name, base_url, api_key_cipher, headers_json, "
                    " enabled, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        pid,
                        proto,
                        display_name or "",
                        base_url or "",
                        sqlite3.Binary(cipher) if cipher is not None else None,
                        headers_json,
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
        headers: Any = _UNSET,
        enabled: Any = _UNSET,
        sort_order: Any = _UNSET,
    ) -> Optional[LlmProviderRow]:
        """部分更新（未传字段不动）。``api_key``：传非空 str = 重加密替换；传 None/空串 = 清除
        （密文列置 NULL）。行不存在返回 None。"""
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
        if headers is not _UNSET:
            sets.append("headers_json = ?")
            params.append(self._validate_headers(headers))
        if enabled is not _UNSET:
            sets.append("enabled = ?")
            params.append(1 if enabled else 0)
        if sort_order is not _UNSET:
            sets.append("sort_order = ?")
            params.append(int(sort_order))
        if not sets:
            return self.get_provider(provider_id)
        sets.append("updated_at = ?")
        params.append(_now())
        params.append(provider_id)
        with self._connection() as conn:
            cur = conn.execute(
                f"UPDATE llm_provider SET {', '.join(sets)} WHERE id = ?", params
            )
            if cur.rowcount == 0:
                return None
            self._bump_version_conn(conn)
            conn.commit()
        return self.get_provider(provider_id)

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
                " max_output, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(provider_id, model_id) DO UPDATE SET "
                " display_name=excluded.display_name, group_name=excluded.group_name, "
                " enabled=excluded.enabled, capabilities_json=excluded.capabilities_json, "
                " max_output=excluded.max_output, source=excluded.source",
                (
                    provider_id,
                    model_id,
                    display_name,
                    group_name,
                    1 if enabled else 0,
                    caps_json,
                    max_output,
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

    def merge_fetched_models(self, provider_id: str, model_ids: Iterable[str]) -> int:
        """上游拉取结果 merge 进 ``llm_model``（prd §4.4）：新 id → INSERT
        ``source='fetched', enabled=0``；已有行（含 manual）→ 只刷 ``fetched_at``，
        **不覆盖** source / enabled / 元数据。返回新插入行数。"""
        now = _now()
        inserted = 0
        # 先查存量集合再插/刷（同一连接、单事务）——upsert 的 rowcount 区分不了插入与更新，
        # 且本方法非热路径（行数 ≤ 数百），显式两步最直白。
        ids = [m.strip() for m in model_ids if (m or "").strip()]
        with self._connection() as conn:
            existing = {
                r["model_id"]
                for r in conn.execute(
                    "SELECT model_id FROM llm_model WHERE provider_id = ?", (provider_id,)
                ).fetchall()
            }
            for mid in ids:
                if mid in existing:
                    conn.execute(
                        "UPDATE llm_model SET fetched_at = ? "
                        "WHERE provider_id = ? AND model_id = ?",
                        (now, provider_id, mid),
                    )
                else:
                    conn.execute(
                        "INSERT INTO llm_model "
                        "(provider_id, model_id, enabled, source, fetched_at) "
                        "VALUES (?,?,0,'fetched',?)",
                        (provider_id, mid, now),
                    )
                    inserted += 1
            if ids:
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
                    "source": m.source,
                }
                for m in self.list_models(p.id)
            ]
            providers.append(
                {
                    "id": p.id,
                    "protocol": p.protocol,
                    "displayName": p.display_name,
                    "baseUrl": p.base_url,
                    "apiKey": self.get_provider_api_key(p.id) or "",
                    "headers": p.headers,
                    "enabled": True,
                    "models": models,
                }
            )
        return {"version": self.get_snapshot_version(), "providers": providers}

    # -- internal ----------------------------------------------------------

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
