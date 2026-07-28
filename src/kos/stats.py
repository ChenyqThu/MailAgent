"""KOS 入库台账统计 — ``kos_ingest_log`` + ``sync_state`` 的**单源**聚合。

`mailagent kos stats` (src/cli/commands/kos.py) 与 serve-api `GET /api/kos/stats`
(src/api/routers/kos.py) 都调本模块的 :func:`collect_kos_stats`，两端只负责各自的
envelope 包装，SQL 只有这一份。

（对照 llm 的既有债：``src/api/routers/llm.py`` 的 docstring 自己写着「镜像
``src/cli/commands/llm.py`` 的 SQL」—— 两份手抄。KOS 不重蹈，见 PRD R8。）

窗口语义
--------
``days > 0`` 只统计 ``pushed_at >= now - days*86400`` 的台账行；``days = -1`` 全量；
``days = 0`` 非法 (ValueError，调用方转各自的错误类型)。

``pushed_at`` 实际语义是「最后一次尝试时间」—— 成功/失败都写 (见
``KOSBulkIngester._log`` 与 producer 侧写台账)，故它同时是失败行的窗口依据。

**积压类计数 (``pending_retry`` / ``dead_count``) 恒全量、不受窗口影响** ——
10 天前失败的行今天照样要重试、照样需要人工介入，按窗口裁掉会谎报「没有积压」。

🔴 ``total_all`` / ``by_status_all`` 同样恒全量 (issue #64 B1)。窗口计数单独摆出来会被
读成「知识库总量」：一次 bulk 灌进来的几千行是窗口里的**不动块**，增量每天几十行在四位
数基数上看不出变化；更坑的是相邻两档窗口常常算出**同一个数**（台账中间有空档期时
7d == 30d），于是「换个窗口验证一下」这个最自然的自检反而坐实误判。而等那次 bulk 滚出
窗口，同一个数字会毫无征兆地掉一个量级，看起来像知识库被清空。故窗口数与累计数必须
同时下发、由渲染侧并排呈现。

台账只有 ``internal_id`` 一个 PK、重推覆盖上一次记录 (PRD D4 的取舍)，所以按天分桶
是**当前状态**的近似分布，不是历史事件流：某封邮件昨天失败今天推成功，只会出现在
今天的 pushed 桶里。图表文案不承诺历史精确性。

降级语义 (``_source``)
----------------------
- ``live_query``  — 正常。
- ``table_missing`` — ``kos_ingest_log`` 不存在 (裸库 / 全新 install)，全零。
- ``schema_stale`` — 表在但是 v41 前的**老形状** (bulk 惰性建的 6 列, 无 ``error_code``)。
  这不是构造场景: 装了新版但后端还没重启跑迁移的窗口里，本机两个真库都是这个状态。
  此时除 ``by_error_code`` 恒空外其余照常统计 —— 老形状里 status/pushed_at 都在，
  把 7000 多行真实数据一起清零反而是谎报。
"""

from __future__ import annotations

import os
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional, Union

# sync_state 的 ``kos.*`` 键名单源在写侧 (``src/kos/ingest_log.py``) —— 读侧 import
# 而不是手抄，改键名时两侧一起动。
from src.kos.ingest_log import (
    STATE_HEALTH_CHECKED_AT,
    STATE_HEALTH_CONSEC_FAILURES,
    STATE_HEALTH_ERROR,
    STATE_HEALTH_STATUS,
    STATE_LAST_SUCCESS_AT,
)

# ``kos_ingest_log.status`` 值域 (PRD R1，跨 lane 契约)。
# pushed = 已入库 / failed = 待重试 / dead = 超重试上限需人工 / skipped = priority floor 过滤
# / pending = 等 LLM 标签就位后首推 (issue #64 Lane A deferred first-push, 分钟级瞬态)。
INGEST_STATUSES = ("pushed", "failed", "dead", "skipped", "pending")

# 计入「失败」的 status —— by_error_code 分布与 daily failed 桶都用它。
FAILURE_STATUSES = ("failed", "dead")

_STATE_KEYS = (
    STATE_LAST_SUCCESS_AT,
    STATE_HEALTH_STATUS,
    STATE_HEALTH_CHECKED_AT,
    STATE_HEALTH_ERROR,
    STATE_HEALTH_CONSEC_FAILURES,
)

_NULL_KEY = "(null)"  # 与 CLI llm stats 的 by_status 空值约定一致

# ---- enabled 判据的 env 键 (producer 面, 不是 consumer 面) --------------------
# 🔴 producer 走 ``make_bulk_kos_client()`` (src/kos/producer.py), 读的是
# MAILAGENT_BULK_CLIENT_ID/SECRET; chat 读 KOS 的 consumer 判据 (_kos_available,
# src/api/routers/chat.py) 读的是 KOS_OAUTH_CLIENT_* —— **两套凭据**。用错会让
# 「chat 能读但从没推送过」的机器显示一个恒空的监控区。
_ENV_INGEST_ENABLED = "MAILAGENT_KOS_INGEST_ENABLED"
_ENV_MCP_BASE = "KOS_MCP_BASE"
_ENV_BULK_CLIENT_ID = "MAILAGENT_BULK_CLIENT_ID"
_ENV_BULK_CLIENT_SECRET = "MAILAGENT_BULK_CLIENT_SECRET"

# 顺序 = 下发给 UI 的缺失键展示顺序 (稳定，不随 set/dict 迭代漂)。
_CREDENTIAL_KEYS = (_ENV_MCP_BASE, _ENV_BULK_CLIENT_ID, _ENV_BULK_CLIENT_SECRET)

# gate 三态 (issue #64) —— 渲染侧「整区不渲染 / 显因 / 正常」的**唯一**判据。
# 判据在后端算好下发，前端不拼 (照 DavMailHealthCard 的 enabled 先例)。
INGEST_GATE_ACTIVE = "active"
INGEST_GATE_FLAG_OFF = "flag_off"
INGEST_GATE_MISSING_CREDENTIALS = "missing_credentials"

_TRUTHY = frozenset({"1", "true", "yes", "on"})


def collect_kos_stats(
    db_path: Union[str, Path],
    days: int = 7,
    *,
    now: Optional[float] = None,
) -> dict[str, Any]:
    """聚合 KOS 入库台账 → dict (CLI / serve-api 共用)。

    Args:
        db_path: sync_store.db 路径。
        days: 窗口天数；``-1`` = 全量，``0`` 非法 (ValueError)。
        now: 注入「当前时刻」(epoch)，仅测试用；默认 ``time.time()``。

    Returns:
        ``{enabled, gate, missing_keys, days, since_ts, total, total_all, by_status,
        by_status_all, by_error_code, pending_retry, dead_count, last_success_ts,
        health, daily, _source}``

        ``gate`` = ``'active'`` | ``'flag_off'`` | ``'missing_credentials'``
        (见 :func:`resolve_ingest_gate`)；``_source`` = ``'live_query'`` |
        ``'table_missing'`` | ``'schema_stale'`` (见模块 docstring 的降级语义)。
    """
    if days == 0:
        raise ValueError("days 0 invalid; use -1 (all) or >=1")

    now_ts = time.time() if now is None else now
    since_ts: Optional[float] = now_ts - days * 86400 if days > 0 else None
    gate, missing_keys = resolve_ingest_gate()
    enabled = gate == INGEST_GATE_ACTIVE

    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        state = _read_state(conn)

        cols = _table_columns(conn, "kos_ingest_log")
        if not cols:
            return _empty_stats(
                days, since_ts, state, now_ts, gate, missing_keys,
                source="table_missing",
            )
        # v41 前的老形状缺 error_code —— 少了这个判断, 下面那条 SELECT 会抛
        # OperationalError, CLI 吐 traceback 而非 JSON, 前端直接进「加载失败」。
        has_error_code = "error_code" in cols

        where = "WHERE pushed_at >= ?" if since_ts is not None else ""
        params: list = [since_ts] if since_ts is not None else []

        by_status = _status_histogram(conn, where, params)
        # 恒全量, 不受 days 影响 —— 见模块 docstring 的 total_all 注释。
        by_status_all = _status_histogram(conn)

        by_error_code: dict[str, int] = {}
        if has_error_code:
            failure_in = ", ".join("?" * len(FAILURE_STATUSES))
            for row in conn.execute(
                f"SELECT error_code, COUNT(*) AS n FROM kos_ingest_log "
                f"{where} {'AND' if where else 'WHERE'} status IN ({failure_in}) "
                f"GROUP BY error_code",
                [*params, *FAILURE_STATUSES],
            ).fetchall():
                by_error_code[row["error_code"] or _NULL_KEY] = int(row["n"])

        # 积压类恒全量 (见模块 docstring)。
        pending_retry = _count_status(conn, "failed")
        dead_count = _count_status(conn, "dead")

        daily = _daily_buckets(conn, since_ts, days, now_ts)
    finally:
        conn.close()

    return {
        "enabled": enabled,
        "gate": gate,
        "missing_keys": missing_keys,
        "days": days,
        "since_ts": since_ts,
        "total": sum(by_status.values()),
        "total_all": sum(by_status_all.values()),
        "by_status": by_status,
        "by_status_all": by_status_all,
        "by_error_code": by_error_code,
        "pending_retry": pending_retry,
        "dead_count": dead_count,
        "last_success_ts": _parse_ts(state.get(STATE_LAST_SUCCESS_AT)),
        "health": _health_block(state),
        "daily": daily,
        "_source": "live_query" if has_error_code else "schema_stale",
    }


def resolve_ingest_gate() -> tuple[str, list[str]]:
    """producer 面门控三态 + 缺失键名 (issue #64) —— env 派生, 与 DB 无关。

    Returns:
        ``(gate, missing_keys)``

        - ``'flag_off'`` —— ``MAILAGENT_KOS_INGEST_ENABLED`` 未开; ``missing_keys`` 恒空。
          用户压根没打开入库 (默认 false), 渲染侧整区不渲染 —— 给所有不用 KOS 的机器
          挂一块「未启用」只是噪音。
        - ``'missing_credentials'`` —— 开关开着但 producer 凭据缺; ``missing_keys`` 是
          缺哪几个。🔴 issue #64 主诉正是这一支原本也 ``return null``: 从 ≤v1.19.0 升上来
          的用户 ``.env`` 里必然没有 v1.19.1 才引入的两个 bulk 键 (``.env.example``
          只对新装用户有效), 于是看板整区凭空消失、零线索。此支必须**显因**
          (对齐 v1.16.1 为 issue #54 给 consumer 面做的 gate 显因)。
        - ``'active'`` —— 四条件齐。

    🔴 ``missing_keys`` 只含**键名**、永不含键值 —— 它要穿过 IPC / HTTP 到 renderer,
    而这三个里两个是凭据 (与 ``SECRET_ENV_KEYS`` 的脱敏纪律同源)。

    🔴 读法 = ``os.environ`` 优先、否则热读 ``.env`` (抄 ``src/skills/invoke.py``
    的既有 pattern): 后三个键**只有裸 ``os.getenv``、不在 ``config.py``**,
    而 ``mailagent kos stats`` 是 Electron spawn 的独立进程、未必 ``load_dotenv`` 过
    —— 只读 environ 会让桌面端恒判 disabled (见 memory「env-only flags/load_dotenv 坑」)。
    """
    env = _EnvResolver()
    if (env.get(_ENV_INGEST_ENABLED) or "").strip().lower() not in _TRUTHY:
        return INGEST_GATE_FLAG_OFF, []
    missing = [key for key in _CREDENTIAL_KEYS if not (env.get(key) or "").strip()]
    if missing:
        return INGEST_GATE_MISSING_CREDENTIALS, missing
    return INGEST_GATE_ACTIVE, []


def resolve_ingest_enabled() -> bool:
    """producer 面的「KOS 入库已启用」判据 = gate 三态折成 bool。

    ``MAILAGENT_KOS_INGEST_ENABLED`` 为真 **且** 三个 producer 凭据
    (``KOS_MCP_BASE`` / ``MAILAGENT_BULK_CLIENT_ID`` / ``MAILAGENT_BULK_CLIENT_SECRET``)
    都非空。判据细节见 :func:`resolve_ingest_gate`。
    """
    return resolve_ingest_gate()[0] == INGEST_GATE_ACTIVE


class _EnvResolver:
    """``os.environ`` 优先 + 惰性 ``.env`` 兜底 (整个 .env 只解析一次)。"""

    def __init__(self) -> None:
        self._dotenv: Optional[dict] = None

    def get(self, key: str) -> Optional[str]:
        if key in os.environ:
            return os.environ[key]
        if self._dotenv is None:
            self._dotenv = self._load_dotenv()
        return self._dotenv.get(key)

    @staticmethod
    def _load_dotenv() -> dict:
        try:
            from dotenv import dotenv_values

            from src.api.deps import get_env_file_path

            return {
                k: v for k, v in (dotenv_values(get_env_file_path()) or {}).items()
                if v is not None
            }
        except Exception:  # noqa: BLE001 — .env 不可读 → 当作未配置, 不炸统计
            return {}


# ============================================================
# internals
# ============================================================

def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _table_columns(conn: sqlite3.Connection, name: str) -> set[str]:
    """表的列名集合；表不存在 → 空集 (``PRAGMA table_info`` 对不存在的表返空)。"""
    return {row[1] for row in conn.execute(f"PRAGMA table_info({name})").fetchall()}


def _read_state(conn: sqlite3.Connection) -> dict[str, str]:
    """读 ``kos.*`` sync_state 键。表不存在 / 查询失败 → 空 dict (不抛)。

    台账表和 sync_state 是两条独立链路: 台账还没建但探活已经落过盘 (或反之) 都合法，
    故两边各自防御，不互相拖累。
    """
    if not _table_exists(conn, "sync_state"):
        return {}
    placeholders = ", ".join("?" * len(_STATE_KEYS))
    try:
        rows = conn.execute(
            f"SELECT key, value FROM sync_state WHERE key IN ({placeholders})",
            list(_STATE_KEYS),
        ).fetchall()
    except sqlite3.Error:
        return {}
    return {r["key"]: r["value"] for r in rows if r["value"] is not None}


def _status_histogram(
    conn: sqlite3.Connection,
    where: str = "",
    params: Optional[list] = None,
) -> dict[str, int]:
    """``status -> COUNT(*)``；``where`` 空 = 全量。缺席的 status 补 0。

    窗口版与全量版 (``total_all``/``by_status_all``) 共用这一份 —— 两处各写一遍 SQL
    正是「同一口径两份手抄」的起点。
    """
    counts = {s: 0 for s in INGEST_STATUSES}
    for row in conn.execute(
        f"SELECT status, COUNT(*) AS n FROM kos_ingest_log {where} GROUP BY status",
        params or [],
    ).fetchall():
        key = row["status"] or _NULL_KEY
        counts[key] = counts.get(key, 0) + int(row["n"])
    return counts


def _count_status(conn: sqlite3.Connection, status: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM kos_ingest_log WHERE status = ?", (status,)
    ).fetchone()
    return int(row["n"]) if row else 0


def _daily_buckets(
    conn: sqlite3.Connection,
    since_ts: Optional[float],
    days: int,
    now_ts: float,
) -> list[dict[str, Any]]:
    """按本地日期分桶的 ``[{date, pushed, failed}]``，升序。

    ``days > 0`` 时补齐窗口内的空日 (Sparkline 需要等距序列)；``days = -1`` 只返有
    数据的日子 —— 从最早一行补到今天可能是几千个点，对图表无意义。
    """
    failure_in = ", ".join("?" * len(FAILURE_STATUSES))
    where = "WHERE pushed_at IS NOT NULL"
    params: list = []
    if since_ts is not None:
        where += " AND pushed_at >= ?"
        params.append(since_ts)

    rows = conn.execute(
        f"""SELECT date(pushed_at, 'unixepoch', 'localtime') AS d,
                   SUM(CASE WHEN status = 'pushed' THEN 1 ELSE 0 END) AS pushed,
                   SUM(CASE WHEN status IN ({failure_in}) THEN 1 ELSE 0 END) AS failed
              FROM kos_ingest_log
              {where}
             GROUP BY d
             ORDER BY d""",
        [*FAILURE_STATUSES, *params],
    ).fetchall()
    found = {
        r["d"]: {"date": r["d"], "pushed": int(r["pushed"] or 0), "failed": int(r["failed"] or 0)}
        for r in rows
        if r["d"]
    }

    if days <= 0:
        return [found[d] for d in sorted(found)]

    today = datetime.fromtimestamp(now_ts).date()
    return [
        found.get(key, {"date": key, "pushed": 0, "failed": 0})
        for key in (
            (today - timedelta(days=offset)).isoformat()
            for offset in range(days - 1, -1, -1)
        )
    ]


def _health_block(state: dict[str, str]) -> Optional[dict[str, Any]]:
    """``kos.health.*`` → 健康块；**从未探活 → ``None``**（不是字段全 null 的对象）。

    🔴 这个 None 是契约的一部分，不是省事：前端判据是
    ``health == null ? 「未探测」 : health.ok ? 「正常」 : 「异常」``。返回一个
    ``ok`` 缺席的对象会让 ``health == null`` 为 false、``health.ok`` 为 undefined →
    falsy → **刚升级、从未探活过的机器全部显示「KOS 异常」**。判据 = ``kos.health.status``
    键在不在（写侧 ``record_health`` 是 status/checked_at 一起落的）。

    ``ok`` 由写侧 ``'ok' | 'error'`` 折成 bool —— 三态里的「从未探活」已经由外层
    的 None 表达，这里不需要再留一个 str 值域。``checked_at`` 与 ``last_success_ts``
    同样归一成 epoch float，前端两个时间戳同型。

    ``detail`` / ``consecutive_failed_rounds`` 是契约外的附加字段（排查用，前端可选
    消费）；wire 名与 sync_state 键名不同 (``kos.health.error`` /
    ``kos.health.consecutive_failures``)，这里做一次显式映射。
    """
    status = (state.get(STATE_HEALTH_STATUS) or "").strip()
    if not status:
        return None
    return {
        "ok": status == "ok",
        "checked_at": _parse_ts(state.get(STATE_HEALTH_CHECKED_AT)),
        "detail": state.get(STATE_HEALTH_ERROR) or None,
        "consecutive_failed_rounds": _parse_int(
            state.get(STATE_HEALTH_CONSEC_FAILURES)
        ),
    }


def _parse_ts(raw: Optional[str]) -> Optional[float]:
    """sync_state 的时间戳字符串 → epoch float。

    优先按 epoch 解析；解析失败再试 ISO (``davmail.last_probe_at`` 用的是 ISO 格式，
    写侧若沿用该先例也能读)。都不行 → None。
    """
    if not raw:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(raw).timestamp()
    except (TypeError, ValueError):
        return None


def _parse_int(raw: Optional[str]) -> int:
    try:
        return int(raw) if raw else 0
    except (TypeError, ValueError):
        return 0


def _empty_stats(
    days: int,
    since_ts: Optional[float],
    state: dict[str, str],
    now_ts: float,
    gate: str,
    missing_keys: list[str],
    *,
    source: str,
) -> dict[str, Any]:
    """台账表不存在时的零值形状 —— 字段与 live_query 完全一致，前端不必分支。"""
    return {
        "enabled": gate == INGEST_GATE_ACTIVE,
        "gate": gate,
        "missing_keys": missing_keys,
        "days": days,
        "since_ts": since_ts,
        "total": 0,
        "total_all": 0,
        "by_status": {s: 0 for s in INGEST_STATUSES},
        "by_status_all": {s: 0 for s in INGEST_STATUSES},
        "by_error_code": {},
        "pending_retry": 0,
        "dead_count": 0,
        "last_success_ts": _parse_ts(state.get(STATE_LAST_SUCCESS_AT)),
        "health": _health_block(state),
        "daily": _empty_daily(days, now_ts),
        "_source": source,
    }


def _empty_daily(days: int, now_ts: float) -> list[dict[str, Any]]:
    if days <= 0:
        return []
    today = datetime.fromtimestamp(now_ts).date()
    return [
        {"date": (today - timedelta(days=offset)).isoformat(), "pushed": 0, "failed": 0}
        for offset in range(days - 1, -1, -1)
    ]
