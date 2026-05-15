"""共享邮件查询构造与行解析。

避免 email_metadata + llm_processing JOIN 在多处重复实现。
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional

# 标准 SELECT 列：基础元数据 + LLM 状态 + labels_json
EMAIL_BASE_SELECT = """
    SELECT em.*,
           lp.status as llm_status,
           lp.labels_json
    FROM email_metadata em
    LEFT JOIN llm_processing lp ON em.internal_id = lp.internal_id
"""

# 仅获取 agent 工具需要的精简字段（不带 em.*，省 token）
EMAIL_AGENT_SELECT = """
    SELECT em.internal_id, em.subject, em.sender, em.sender_name,
           em.date_received, em.mailbox, em.thread_id,
           em.is_read, em.is_flagged,
           lp.status as llm_status,
           lp.labels_json
    FROM email_metadata em
    LEFT JOIN llm_processing lp ON em.internal_id = lp.internal_id
"""


def parse_labels(labels_json: Optional[str]) -> Dict[str, Any]:
    """安全解析 llm_processing.labels_json。失败返回空 dict。"""
    if not labels_json:
        return {}
    try:
        return json.loads(labels_json)
    except (json.JSONDecodeError, TypeError):
        return {}


def build_where(conditions: Iterable[str]) -> str:
    """拼 WHERE 子句，保证至少有 sync_status='synced'。"""
    conds = list(conditions)
    if not conds:
        conds = ["em.sync_status = 'synced'"]
    return " AND ".join(conds)


def row_to_agent_dict(row: Any) -> Dict[str, Any]:
    """转 Agent 工具使用的简化 dict（含 LLM 标签字段）。"""
    labels = parse_labels(row["labels_json"] if "labels_json" in row.keys() else None)
    return {
        "internal_id": row["internal_id"],
        "subject": row["subject"],
        "sender": row["sender"],
        "sender_name": row["sender_name"] if "sender_name" in row.keys() else None,
        "date_received": row["date_received"],
        "mailbox": row["mailbox"] if "mailbox" in row.keys() else None,
        "thread_id": row["thread_id"] if "thread_id" in row.keys() else None,
        "ai_summary": labels.get("ai_summary"),
        "priority": labels.get("priority"),
        "category": labels.get("category"),
        "action_type": labels.get("action_type"),
    }


def build_search_conditions(
    search_term: str,
    *,
    use_labels: bool = True,
) -> tuple[str, List[Any]]:
    """构造关键词搜索的条件片段 + 参数。

    匹配主题 / 发件人 / 发件人名 (+ labels_json 中的 ai_summary / category)。
    """
    pattern = f"%{search_term}%"
    if use_labels:
        cond = (
            "(em.subject LIKE ? OR em.sender LIKE ? OR em.sender_name LIKE ? "
            "OR json_extract(lp.labels_json, '$.ai_summary') LIKE ? "
            "OR json_extract(lp.labels_json, '$.category') LIKE ?)"
        )
        params = [pattern] * 5
    else:
        cond = "(em.subject LIKE ? OR em.sender LIKE ? OR em.sender_name LIKE ?)"
        params = [pattern] * 3
    return cond, params
