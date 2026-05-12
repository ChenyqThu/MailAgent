"""Dashboard 数据服务。

支持 day/month/quarter/year 四种时间范围视图。
时区跟随系统（UTC+8）。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from web.api.services.db import get_db

# 系统时区 UTC+8
_TZ = timezone(timedelta(hours=8))

# 合法 range 值
_VALID_RANGES = {"day", "month", "quarter", "year"}


def _range_start(range_: str) -> float:
    """根据 range 返回起始 unix timestamp（UTC+8 本地日零点）。"""
    now = datetime.now(_TZ)

    if range_ == "day":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif range_ == "month":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    elif range_ == "quarter":
        q_month = ((now.month - 1) // 3) * 3 + 1
        start = now.replace(month=q_month, day=1, hour=0, minute=0, second=0, microsecond=0)
    elif range_ == "year":
        start = now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    return start.timestamp()


def _range_label(range_: str) -> str:
    """趋势图 SQL 里的日期聚合表达式。"""
    if range_ in ("day", "month"):
        return "date(em.date_received)"
    elif range_ == "quarter":
        # 按周聚合
        return "strftime('%Y-W%W', em.date_received)"
    else:
        # 按月聚合
        return "strftime('%Y-%m', em.date_received)"


def _trend_days(range_: str) -> int:
    """趋势图回溯天数。"""
    if range_ == "day":
        return 7
    elif range_ == "month":
        return 31
    elif range_ == "quarter":
        return 92
    else:
        return 366


def _normalize_range(range_: str | None) -> str:
    if range_ and range_ in _VALID_RANGES:
        return range_
    return "day"


def get_overview_stats(range_: str | None = None) -> dict[str, Any]:
    """统计卡片数据。"""
    range_ = _normalize_range(range_)
    since_ts = _range_start(range_)

    with get_db() as conn:
        total = conn.execute(
            "SELECT COUNT(*) as n FROM email_metadata WHERE sync_status='synced'"
        ).fetchone()["n"]

        pending = conn.execute(
            "SELECT COUNT(*) as n FROM email_metadata WHERE sync_status='synced' AND is_flagged=1"
        ).fetchone()["n"]

        # 范围内新增
        range_new = conn.execute(
            "SELECT COUNT(*) as n FROM email_metadata WHERE sync_status='synced' AND created_at > ?",
            (since_ts,),
        ).fetchone()["n"]

        # 范围内 AI 已审核
        ai_reviewed = conn.execute(
            "SELECT COUNT(*) as n FROM llm_processing WHERE status='success' AND updated_at > ?",
            (since_ts,),
        ).fetchone()["n"]

        # 范围内紧急数
        urgent = conn.execute("""
            SELECT COUNT(*) as n FROM llm_processing
            WHERE status='success'
            AND updated_at > ?
            AND json_extract(labels_json, '$.priority') LIKE '%紧急%'
        """, (since_ts,)).fetchone()["n"]

        # 范围内 LLM 成本
        cost_row = conn.execute("""
            SELECT
                COALESCE(SUM(input_tokens), 0) as input_tok,
                COALESCE(SUM(output_tokens), 0) as output_tok,
                COALESCE(SUM(cache_read_input_tokens), 0) as cache_read
            FROM llm_processing
            WHERE status='success'
            AND updated_at > ?
        """, (since_ts,)).fetchone()

        # Sonnet 4.6: $3/M input, $15/M output, cache_read 0.1x
        input_cost = (cost_row["input_tok"] / 1_000_000) * 3
        cache_cost = (cost_row["cache_read"] / 1_000_000) * 0.3
        output_cost = (cost_row["output_tok"] / 1_000_000) * 15
        total_cost = round(input_cost + cache_cost + output_cost, 2)

    return {
        "total": total,
        "pending": pending,
        "urgent": urgent,
        "range_new": range_new,
        "ai_reviewed": ai_reviewed,
        "llm_cost": total_cost,
        "range": range_,
    }


def get_attention_emails(range_: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
    """需要关注的邮件（紧急+重要，按优先级+时间排序）。"""
    range_ = _normalize_range(range_)
    since_ts = _range_start(range_)

    with get_db() as conn:
        rows = conn.execute("""
            SELECT em.internal_id, em.subject, em.sender, em.sender_name,
                   em.date_received, em.mailbox, em.is_flagged,
                   lp.labels_json
            FROM email_metadata em
            JOIN llm_processing lp ON em.internal_id = lp.internal_id
            WHERE em.sync_status = 'synced'
            AND lp.status = 'success'
            AND em.created_at > ?
            AND (
                json_extract(lp.labels_json, '$.priority') LIKE '%紧急%'
                OR json_extract(lp.labels_json, '$.priority') LIKE '%重要%'
            )
            ORDER BY
                CASE
                    WHEN json_extract(lp.labels_json, '$.priority') LIKE '%紧急%' THEN 1
                    ELSE 2
                END,
                em.internal_id DESC
            LIMIT ?
        """, (since_ts, limit)).fetchall()

    result = []
    for row in rows:
        d = dict(row)
        labels = {}
        try:
            labels = json.loads(d.pop("labels_json", "{}") or "{}")
        except (json.JSONDecodeError, TypeError):
            pass
        d["priority"] = labels.get("priority")
        d["action_type"] = labels.get("action_type")
        d["ai_summary"] = labels.get("ai_summary")
        d["category"] = labels.get("category")
        result.append(d)
    return result


def get_digest(range_: str | None = None) -> dict[str, Any]:
    """范围内邮件摘要。"""
    range_ = _normalize_range(range_)
    since_ts = _range_start(range_)

    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                json_extract(lp.labels_json, '$.category') as category,
                COUNT(*) as count
            FROM email_metadata em
            JOIN llm_processing lp ON em.internal_id = lp.internal_id
            WHERE em.sync_status = 'synced'
            AND lp.status = 'success'
            AND em.created_at > ?
            GROUP BY category
            ORDER BY count DESC
        """, (since_ts,)).fetchall()

        categories = [{"category": r["category"] or "未分类", "count": r["count"]} for r in rows]

        prio_rows = conn.execute("""
            SELECT
                json_extract(lp.labels_json, '$.priority') as priority,
                COUNT(*) as count
            FROM email_metadata em
            JOIN llm_processing lp ON em.internal_id = lp.internal_id
            WHERE em.sync_status = 'synced'
            AND lp.status = 'success'
            AND em.created_at > ?
            GROUP BY priority
        """, (since_ts,)).fetchall()

        priorities = {r["priority"] or "未知": r["count"] for r in prio_rows}

    return {
        "categories": categories,
        "priorities": priorities,
        "range": range_,
    }


def get_system_status() -> dict[str, Any]:
    """系统状态（不受 range 影响）。"""
    with get_db() as conn:
        last_sync = conn.execute(
            "SELECT value FROM sync_state WHERE key='last_sync_time'"
        ).fetchone()

        sync_rows = conn.execute(
            "SELECT sync_status, COUNT(*) as cnt FROM email_metadata GROUP BY sync_status"
        ).fetchall()

        llm_rows = conn.execute(
            "SELECT status, COUNT(*) as cnt FROM llm_processing GROUP BY status"
        ).fetchall()

    return {
        "last_sync_time": last_sync["value"] if last_sync else None,
        "sync_stats": {r["sync_status"]: r["cnt"] for r in sync_rows},
        "llm_stats": {r["status"]: r["cnt"] for r in llm_rows},
    }


def get_trend(range_: str | None = None) -> list[dict[str, Any]]:
    """处理趋势（粒度随 range 自动调整）。"""
    range_ = _normalize_range(range_)
    days = _trend_days(range_)
    group_expr = _range_label(range_)

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT
                {group_expr} as period,
                COUNT(*) as total,
                SUM(CASE WHEN lp.status='success' THEN 1 ELSE 0 END) as ai_processed
            FROM email_metadata em
            LEFT JOIN llm_processing lp ON em.internal_id = lp.internal_id
            WHERE em.sync_status = 'synced'
            AND em.date_received >= date('now', ? || ' days')
            GROUP BY period
            ORDER BY period
        """, (f"-{days}",)).fetchall()

    return [{"day": r["period"], "total": r["total"], "ai_processed": r["ai_processed"]} for r in rows]
