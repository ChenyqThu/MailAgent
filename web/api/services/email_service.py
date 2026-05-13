"""邮件查询服务。只读 sync_store.db + llm_processing。"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from web.api.models.email import EmailDetail, EmailFilter, EmailListItem
from web.api.services.db import get_db

# Priority 排序映射
_PRIORITY_ORDER = {
    "🔴 紧急": 1,
    "🟡 重要": 2,
    "🟢 一般": 3,
    "⚪ 低": 4,
}


def _parse_labels(labels_json: Optional[str]) -> Dict[str, Any]:
    """安全解析 llm_processing.labels_json。"""
    if not labels_json:
        return {}
    try:
        return json.loads(labels_json)
    except (json.JSONDecodeError, TypeError):
        return {}


def _row_to_list_item(row: dict, labels: Dict[str, Any]) -> EmailListItem:
    return EmailListItem(
        internal_id=row["internal_id"],
        message_id=row.get("message_id"),
        subject=row.get("subject"),
        sender=row.get("sender"),
        sender_name=row.get("sender_name"),
        to_addr=row.get("to_addr"),
        date_received=row.get("date_received"),
        mailbox=row.get("mailbox"),
        is_read=bool(row.get("is_read")),
        is_flagged=bool(row.get("is_flagged")),
        has_attachments=bool(row.get("has_attachments", 0)),
        notion_page_id=row.get("notion_page_id"),
        ai_summary=labels.get("ai_summary"),
        key_points=labels.get("key_points"),
        category=labels.get("category"),
        priority=labels.get("priority"),
        action_type=labels.get("action_type"),
        action_required=bool(labels.get("action_required")),
        sender_priority=labels.get("sender_priority"),
        language=labels.get("language"),
        urgency_reason=labels.get("urgency_reason"),
        mail_actions=labels.get("mail_actions"),
        reply_suggestion=labels.get("reply_suggestion_md"),
        related_project=labels.get("related_project"),
        llm_status=row.get("llm_status"),
    )


_VIEW_BROWSE_EXCLUDE_PRIORITY = "⚪ 低"


def _apply_view_conditions(
    view: Optional[str],
    conditions: List[str],
    params: List[Any],
) -> Optional[str]:
    """根据 view 参数追加 SQL 条件，返回 labels 后过滤的视图名（browse/ignore 需后过滤）。"""
    if view == "pending":
        conditions.append("em.is_flagged = 1")
        conditions.append("lp.status = 'success'")
        conditions.append("COALESCE(em.processing_status, '') != '已完成'")
        return None
    if view == "browse":
        conditions.append("em.is_flagged = 0")
        conditions.append("lp.status = 'success'")
        conditions.append("COALESCE(em.processing_status, '') NOT IN ('已浏览', '已完成')")
        return "browse"  # 需后过滤：action_type=仅供参考 + priority 非 ⚪低
    if view == "ignore":
        conditions.append("em.is_flagged = 0")
        conditions.append("lp.status = 'success'")
        return "ignore"  # 需后过滤：priority=⚪低
    # view=all 或 None
    return None


def _post_filter_by_view(item: EmailListItem, view_post: Optional[str]) -> bool:
    """labels 层后过滤，返回 True 表示保留。"""
    if view_post == "browse":
        return (
            item.action_type == "仅供参考"
            and item.priority is not None
            and item.priority != _VIEW_BROWSE_EXCLUDE_PRIORITY
        )
    if view_post == "ignore":
        return item.priority == _VIEW_BROWSE_EXCLUDE_PRIORITY
    return True


def list_emails(
    filter: EmailFilter,
    page: int = 1,
    page_size: int = 50,
) -> Tuple[List[EmailListItem], int]:
    """查询邮件列表（智能排序：Priority + 时间倒序）。"""
    conditions = ["em.sync_status = 'synced'"]
    params: List[Any] = []

    # view 优先；无 view 时降级到旧 pending_only 逻辑
    view = filter.view
    if not view:
        view = "pending" if filter.pending_only else "all"

    view_post = _apply_view_conditions(view, conditions, params)

    if filter.mailbox:
        conditions.append("em.mailbox = ?")
        params.append(filter.mailbox)
    if view == "all" and filter.is_flagged is not None:
        conditions.append("em.is_flagged = ?")
        params.append(int(filter.is_flagged))
    if filter.search:
        conditions.append("(em.subject LIKE ? OR em.sender LIKE ? OR em.sender_name LIKE ?)")
        q = f"%{filter.search}%"
        params.extend([q, q, q])

    where = " AND ".join(conditions)
    join_clause = "LEFT JOIN llm_processing lp ON em.internal_id = lp.internal_id"

    needs_post_filter = view_post is not None or filter.priority or filter.action_type or filter.category

    with get_db() as conn:
        if needs_post_filter:
            # 后过滤视图：拉全量 SQL 结果，内存过滤+分页（数据量小，~200 条）
            list_sql = f"""
                SELECT em.*,
                       lp.status as llm_status,
                       lp.labels_json
                FROM email_metadata em
                {join_clause}
                WHERE {where}
                ORDER BY em.internal_id DESC
            """
            rows = conn.execute(list_sql, params).fetchall()
        else:
            # 无后过滤：SQL 分页
            count_sql = f"""
                SELECT COUNT(*) as cnt
                FROM email_metadata em
                {join_clause}
                WHERE {where}
            """
            sql_total = conn.execute(count_sql, params).fetchone()["cnt"]

            offset = (page - 1) * page_size
            list_sql = f"""
                SELECT em.*,
                       lp.status as llm_status,
                       lp.labels_json
                FROM email_metadata em
                {join_clause}
                WHERE {where}
                ORDER BY em.internal_id DESC
                LIMIT ? OFFSET ?
            """
            rows = conn.execute(list_sql, params + [page_size, offset]).fetchall()

    all_items = []
    for row in rows:
        row_dict = dict(row)
        labels = _parse_labels(row_dict.pop("labels_json", None))
        item = _row_to_list_item(row_dict, labels)

        # view 后过滤（browse/ignore 依赖 labels_json 内字段）
        if not _post_filter_by_view(item, view_post):
            continue
        # 叠加筛选（快捷标签过滤）
        if filter.priority and item.priority != filter.priority:
            continue
        if filter.action_type and item.action_type != filter.action_type:
            continue
        if filter.category and item.category != filter.category:
            continue

        all_items.append(item)

    if needs_post_filter:
        total = len(all_items)
        offset = (page - 1) * page_size
        items = all_items[offset : offset + page_size]
    else:
        total = sql_total  # type: ignore[possibly-undefined]
        items = all_items

    return items, total


def get_view_counts() -> Dict[str, int]:
    """返回各视图邮件数量（供 tab badge 用）。"""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT em.is_flagged, em.processing_status,
                   lp.status as llm_status,
                   lp.labels_json
            FROM email_metadata em
            LEFT JOIN llm_processing lp ON em.internal_id = lp.internal_id
            WHERE em.sync_status = 'synced'
            """
        ).fetchall()

    pending = 0
    browse = 0
    ignore = 0
    total = len(rows)

    for row in rows:
        flagged = bool(row["is_flagged"])
        proc_status = row["processing_status"] or ""
        llm_ok = row["llm_status"] == "success"
        labels = _parse_labels(row["labels_json"])
        priority = labels.get("priority")
        action_type = labels.get("action_type")

        if flagged and llm_ok and proc_status != "已完成":
            pending += 1
        elif not flagged and llm_ok:
            if priority == _VIEW_BROWSE_EXCLUDE_PRIORITY:
                ignore += 1
            elif action_type == "仅供参考" and priority is not None:
                if proc_status not in ("已浏览", "已完成"):
                    browse += 1

    return {"pending": pending, "browse": browse, "ignore": ignore, "all": total}


def get_email_detail(internal_id: int) -> Optional[EmailDetail]:
    """获取单封邮件详情。"""
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT em.*,
                   lp.status as llm_status,
                   lp.labels_json
            FROM email_metadata em
            LEFT JOIN llm_processing lp ON em.internal_id = lp.internal_id
            WHERE em.internal_id = ?
            """,
            (internal_id,),
        ).fetchone()

        if not row:
            return None

        row_dict = dict(row)
        labels = _parse_labels(row_dict.pop("labels_json", None))

        # 线程计数
        thread_id = row_dict.get("thread_id")
        thread_count = 0
        if thread_id:
            tc = conn.execute(
                "SELECT COUNT(*) as cnt FROM email_metadata WHERE thread_id = ?",
                (thread_id,),
            ).fetchone()
            thread_count = tc["cnt"] if tc else 0

    detail = EmailDetail(
        **_row_to_list_item(row_dict, labels).model_dump(),
        thread_id=row_dict.get("thread_id"),
        cc_addr=row_dict.get("cc_addr"),
        thread_count=thread_count,
    )
    return detail


def get_stats() -> Dict[str, Any]:
    """获取同步统计。"""
    with get_db() as conn:
        # 同步状态分布
        sync_rows = conn.execute(
            "SELECT sync_status, COUNT(*) as cnt FROM email_metadata GROUP BY sync_status"
        ).fetchall()
        sync_stats = {r["sync_status"]: r["cnt"] for r in sync_rows}

        # LLM 处理状态
        llm_rows = conn.execute(
            "SELECT status, COUNT(*) as cnt FROM llm_processing GROUP BY status"
        ).fetchall()
        llm_stats = {r["status"]: r["cnt"] for r in llm_rows}

        # 今日处理量
        today_count = conn.execute(
            """
            SELECT COUNT(*) as cnt FROM llm_processing
            WHERE status = 'success'
            AND updated_at > strftime('%s', 'now', 'start of day')
            """
        ).fetchone()["cnt"]

        # 邮箱分布
        mailbox_rows = conn.execute(
            "SELECT mailbox, COUNT(*) as cnt FROM email_metadata GROUP BY mailbox"
        ).fetchall()
        mailbox_stats = {r["mailbox"]: r["cnt"] for r in mailbox_rows}

    return {
        "sync_status": sync_stats,
        "llm_status": llm_stats,
        "today_processed": today_count,
        "mailbox": mailbox_stats,
        "total_emails": sum(sync_stats.values()),
    }
