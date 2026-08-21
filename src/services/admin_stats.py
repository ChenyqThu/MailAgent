"""admin stats 的**共享读侧组装块**（CLI ↔ serve-api 单源）。

``mailagent admin stats`` 与 ``GET /api/admin/stats`` 是同一份运行统计的两个传输端。
桌面看板 (``/admin/kanban``) 此前经 IPC fork CLI 取这份数据, 现改走常驻 serve-api
(task 08-20-perf-dashboards), 于是两端**必须给出同一份 section**——否则换个传输端
v4_rollout / outbox 两块卡就凭空消失。故这两段的组装逻辑落在此处一份, CLI 与 router
各自只做 envelope 包装。

🔴 全部是**只读**读取: 短命 ``sqlite3.connect`` + 纯 SELECT, 绝不 CREATE/ALTER/迁移。
router 侧的 C6 约束 (读端点不得改 schema, 见 admin.py::admin_stats) 对本模块同样成立,
所以这里不碰 ``SyncStore``——它的 __init__ 会跑 129 条 CREATE IF NOT EXISTS + 迁移梯,
等于每刷新一次看板就跟 mail-sync 抢一次写锁。

表缺失 (全新 install / trimmed 库) 一律汇成结构化占位 (``_source``), 不抛。
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional, Union

__all__ = [
    "build_outbox_section",
    "build_v4_rollout_section",
    "V4_TREND_HOURS",
]

# v4 路由趋势的回看窗口 (小时) —— 按小时分桶, 故 24 = 24 个点。
V4_TREND_HOURS = 24

# 快照超过这个秒数就带 _warn_stale (mail-sync 的 flush loop 每 60s 写一条)。
_V4_STALE_THRESHOLD_SEC = 300


def _connect(db_path: Union[str, Path]) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


# ============================================================
# outbox section
# ============================================================
def build_outbox_section(db_path: Union[str, Path]) -> dict:
    """``email_outbox`` 队列分布 (Sprint 15 Stage 4)。

    返回 {_source, total, by_status, by_target, age_buckets}; 读不到 (表缺失 / DB
    不可达) → {_source: 'error', _error}. OutboxRepository 只在 ``_connect`` 里开
    连接跑 SELECT, 构造函数不建表 —— 读端点安全。
    """
    try:
        from src.sync.outbox import OutboxRepository

        stats = OutboxRepository(str(db_path)).get_stats()
        return {
            "_source": "live_query",
            "total": stats.total,
            "by_status": stats.by_status,
            "by_target": stats.by_target,
            "age_buckets": stats.age_buckets,
        }
    except Exception as exc:  # noqa: BLE001 — 任何读故障都汇成诊断字段, 不阻断整份 stats
        return {
            "_source": "error",
            "_error": f"{type(exc).__name__}: {exc}",
        }


# ============================================================
# v4_rollout section
# ============================================================
def _read_latest_v4_row(conn: sqlite3.Connection) -> Optional[dict]:
    row = conn.execute(
        """
        SELECT flushed_at, from_sqlite_hit, fallback_miss, fallback_error,
               route_latency_p99_ms, body_miss_internal_ids, window_seconds
          FROM v4_rollout_stats
         ORDER BY flushed_at DESC
         LIMIT 1
        """
    ).fetchone()
    if row is None:
        return None
    out = dict(row)
    raw_ids = out.get("body_miss_internal_ids")
    if raw_ids:
        try:
            out["body_miss_internal_ids"] = json.loads(raw_ids)
        except (TypeError, ValueError):
            out["body_miss_internal_ids"] = []
    else:
        out["body_miss_internal_ids"] = []
    return out


def _read_v4_trend(conn: sqlite3.Connection, now: float) -> list[dict]:
    """近 ``V4_TREND_HOURS`` 小时的按小时分桶序列 (看板 sparkline 用)。

    每桶给两个数:
      - ``p99_ms``: 桶内**最大**的窗口 p99 (对 p99 求平均没有意义; 要看的是最坏那一分钟)
      - ``fallback_pct``: (fallback_miss + fallback_error) / 总路由数 × 100

    60s 窗口 × 24h ≈ 1440 行 → 24 个点, 不把原始行铺到 wire 上。
    """
    since = now - V4_TREND_HOURS * 3600
    rows = conn.execute(
        """
        SELECT CAST(flushed_at / 3600 AS INTEGER)     AS bucket,
               MAX(route_latency_p99_ms)              AS p99_ms,
               SUM(from_sqlite_hit)                   AS hit,
               SUM(fallback_miss)                     AS miss,
               SUM(fallback_error)                    AS err,
               COUNT(*)                               AS samples
          FROM v4_rollout_stats
         WHERE flushed_at >= ?
         GROUP BY bucket
         ORDER BY bucket
        """,
        (since,),
    ).fetchall()

    trend: list[dict] = []
    for r in rows:
        hit = int(r["hit"] or 0)
        miss = int(r["miss"] or 0)
        err = int(r["err"] or 0)
        routed = hit + miss + err
        trend.append({
            "bucket_start": int(r["bucket"]) * 3600,
            "p99_ms": round(float(r["p99_ms"] or 0.0), 1),
            "fallback_pct": round(100.0 * (miss + err) / routed, 1) if routed else 0.0,
            "samples": int(r["samples"] or 0),
        })
    return trend


def build_v4_rollout_section(db_path: Union[str, Path]) -> dict:
    """最新一条 v4_rollout 快照 + staleness + 近 24h 趋势。

    无数据 (从没 flush 过 / 表还没建) → ``{_source: 'no_data_yet'}``;
    DB 故障 → ``{_source: 'error', _error}``。快照字段与 ``SyncStore.get_latest_v4_rollout``
    的列一一对应 (同一张表, 同一份 JSON 解析)。
    """
    now = time.time()
    try:
        conn = _connect(db_path)
        try:
            latest = _read_latest_v4_row(conn)
            trend = _read_v4_trend(conn, now) if latest is not None else []
        finally:
            conn.close()
    except sqlite3.Error as exc:
        # 表不存在也走这里 (OperationalError: no such table) —— 与「还没 flush 过」
        # 同一句提示: 都要等 mail-sync 起来写第一条。
        if "no such table" in str(exc).lower():
            return {
                "_source": "no_data_yet",
                "_hint": "PM2 mail-sync 启动后约 1 min 会写第一条快照",
            }
        return {"_source": "error", "_error": f"{type(exc).__name__}: {exc}"}
    except Exception as exc:  # noqa: BLE001 — 同 outbox: 汇成诊断字段
        return {"_source": "error", "_error": f"{type(exc).__name__}: {exc}"}

    if latest is None:
        return {
            "_source": "no_data_yet",
            "_hint": "PM2 mail-sync 启动后约 1 min 会写第一条快照",
        }

    flushed_at = latest.get("flushed_at") or 0
    staleness = max(0, int(now - flushed_at)) if flushed_at else None

    out: dict[str, Any] = {
        "from_sqlite_hit": latest.get("from_sqlite_hit", 0),
        "fallback_miss": latest.get("fallback_miss", 0),
        "fallback_error": latest.get("fallback_error", 0),
        "route_latency_p99_ms": latest.get("route_latency_p99_ms", 0.0),
        "body_miss_internal_ids": latest.get("body_miss_internal_ids", []),
        "window_seconds": latest.get("window_seconds", 60),
        "trend": trend,
        "trend_hours": V4_TREND_HOURS,
        "_snapshot_at": flushed_at,
        "_staleness_seconds": staleness,
        "_source": "stats_reporter_last_snapshot",
    }
    if staleness is not None and staleness > _V4_STALE_THRESHOLD_SEC:
        out["_warn_stale"] = (
            f"Last snapshot is {staleness}s old (> {_V4_STALE_THRESHOLD_SEC}s threshold); "
            f"check if mail-sync watcher / flush loop is alive"
        )
    return out
