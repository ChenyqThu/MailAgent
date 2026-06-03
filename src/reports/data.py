"""报告数据层 —— 取数 + 分组 + counts（确定性，无 LLM）。

平行 src/notify/digest_query（灵动岛），但投影更富（含 sender_addr + date）
且按报告语义分组（attention / handled / fyi）。**counts 与分组由代码确定，
LLM 不碰** —— 防幻觉（同 DailyDigest 纪律）。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from loguru import logger

from src.llm_agent.schema import PRIORITY_ENUM
from src.notify.island_dispatch import ACTION_NEEDS_FLAG, URGENT_PRIORITY_LABELS

_BEIJING = timezone(timedelta(hours=8))

# FYI 语义（与 digest_query 一致）：系统通知类 + "仅供参考/已完结" action。
_FYI_ACTION_TYPES = {"仅供参考", "已完结"}
_FYI_CATEGORIES = {"🔔 系统通知"}

# priority DESC 排序权重（越前越紧急）。
_PRIORITY_RANK: Dict[str, int] = {
    label: len(PRIORITY_ENUM) - i for i, label in enumerate(PRIORITY_ENUM)
}


@dataclass
class ReportEmailBrief:
    """报告投影：metadata + AI 字段（够 email_item block 用）。"""

    internal_id: int
    subject: str
    sender_name: str
    sender_addr: str
    date_received: str
    category: str
    priority: str
    action_type: str
    ai_summary: str
    is_read: bool
    notion_page_id: Optional[str]


def _parse_labels(raw: Any) -> Dict[str, Any]:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def fetch_report_briefs(
    db_path: str,
    *,
    window_hours: int = 24,
    max_emails: int = 80,
    now: Optional[datetime] = None,
) -> List[ReportEmailBrief]:
    """取窗口 ``[now - window_hours, now)`` 内邮件 brief（metadata + AI 字段）。

    ``now`` = 窗口**上界**（exclusive）。worker 传「今天 00:00（北京）」→ daily 即
    昨天一整天、weekly 即过去 7 个完整日（见 worker 锚定逻辑）。

    JOIN email_metadata + llm_processing（labels_json）。LEFT JOIN：没跑过 LLM 的
    邮件 AI 字段为空仍计入。

    **时区**：``date_received`` 存的是**各封邮件原始本地时区**（混合 -08/-07/+00…，
    未归一化），所以**不能字符串比较**——用 SQLite ``julianday()`` 按真实时刻比
    （它能正确解析 ±HH:MM 偏移转 UTC）。窗口边界传 tz-aware ISO，julianday 同样归一。
    """
    if max_emails <= 0:
        return []
    now = now or datetime.now(_BEIJING)
    since_iso = (now - timedelta(hours=window_hours)).isoformat()
    until_iso = now.isoformat()

    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT m.internal_id        AS internal_id,
                   COALESCE(m.subject, '') AS subject,
                   m.sender_name        AS sender_name,
                   m.sender             AS sender_addr,
                   m.date_received      AS date_received,
                   m.is_read            AS is_read,
                   m.notion_page_id     AS notion_page_id,
                   l.labels_json        AS labels_json
              FROM email_metadata m
              LEFT JOIN llm_processing l ON l.internal_id = m.internal_id
             WHERE m.date_received IS NOT NULL
               AND julianday(m.date_received) >= julianday(?)
               AND julianday(m.date_received) <  julianday(?)
            """,
            (since_iso, until_iso),
        ).fetchall()
    except sqlite3.OperationalError as e:
        logger.warning(f"[report] fetch_report_briefs query failed: {e}")
        return []
    finally:
        conn.close()

    briefs: List[ReportEmailBrief] = []
    for r in rows:
        labels = _parse_labels(r["labels_json"])
        briefs.append(
            ReportEmailBrief(
                internal_id=int(r["internal_id"]),
                subject=r["subject"] or "",
                sender_name=(r["sender_name"] or ""),
                sender_addr=(r["sender_addr"] or ""),
                date_received=(r["date_received"] or ""),
                category=(labels.get("category") or "").strip(),
                priority=(labels.get("priority") or "").strip(),
                action_type=(labels.get("action_type") or "").strip(),
                ai_summary=(labels.get("ai_summary") or "").strip(),
                is_read=bool(r["is_read"]),
                notion_page_id=r["notion_page_id"],
            )
        )

    briefs.sort(
        key=lambda b: (_PRIORITY_RANK.get(b.priority, 0), b.date_received),
        reverse=True,
    )
    return briefs[:max_emails]


def is_attention(b: ReportEmailBrief) -> bool:
    """需要用户亲自关注（**fallback 分组用**；主分组由 LLM 在 summarizer 里决定）。

    严格规则：priority 命中 URGENT_PRIORITY_LABELS 且 action 命中 ACTION_NEEDS_FLAG
    —— 与灵动岛 / 飞书 "urgent" 定义一致，避免把大半邮件都塞进"需关注"。
    """
    return b.priority in URGENT_PRIORITY_LABELS and b.action_type in ACTION_NEEDS_FLAG


def is_fyi(b: ReportEmailBrief) -> bool:
    """FYI / 系统通知 / 仅供参考 / 已完结 —— 看过即可。"""
    return b.category in _FYI_CATEGORIES or b.action_type in _FYI_ACTION_TYPES


def group_for_report(
    briefs: List[ReportEmailBrief],
) -> Dict[str, List[ReportEmailBrief]]:
    """分三组（互斥，按 attention → fyi → handled 优先级）。"""
    attention: List[ReportEmailBrief] = []
    fyi: List[ReportEmailBrief] = []
    handled: List[ReportEmailBrief] = []
    for b in briefs:
        if is_attention(b):
            attention.append(b)
        elif is_fyi(b):
            fyi.append(b)
        else:
            handled.append(b)
    return {"attention": attention, "handled": handled, "fyi": fyi}


def compute_report_counts(briefs: List[ReportEmailBrief]) -> Dict[str, Any]:
    """确定性 counts：total / unread / urgent(=attention) / ai_handled / todo / by_category。"""
    total = len(briefs)
    unread = sum(1 for b in briefs if not b.is_read)
    urgent = sum(1 for b in briefs if is_attention(b))
    ai_handled = sum(1 for b in briefs if b.priority)  # priority 非空 = 跑过 LLM
    by_category: Dict[str, int] = {}
    for b in briefs:
        if b.category:
            by_category[b.category] = by_category.get(b.category, 0) + 1
    return {
        "total": total,
        "unread": unread,
        "urgent": urgent,
        "ai_handled": ai_handled,
        "todo": urgent,
        "by_category": by_category,
    }
