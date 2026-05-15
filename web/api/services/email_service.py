"""邮件查询服务。只读 sync_store.db + llm_processing。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from web.api.models.email import EmailDetail, EmailFilter, EmailListItem
from web.api.services.db import get_db
from web.api.services.email_queries import (
    EMAIL_BASE_SELECT,
    build_search_conditions,
    parse_labels,
)


def _row_to_list_item(
    row: dict,
    labels: Dict[str, Any],
    thread_count: int = 0,
) -> EmailListItem:
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
        thread_id=row.get("thread_id"),
        thread_count=thread_count,
    )


_VIEW_BROWSE_EXCLUDE_PRIORITY = "⚪ 低"


def _apply_view_conditions(
    view: Optional[str],
    conditions: List[str],
    params: List[Any],
) -> Optional[str]:
    """根据 view 参数追加 SQL 条件，返回 labels 后过滤的视图名（browse 需后过滤）。"""
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
        cond, search_params = build_search_conditions(filter.search, use_labels=False)
        conditions.append(cond)
        params.extend(search_params)

    where = " AND ".join(conditions)
    needs_post_filter = view_post is not None or filter.priority or filter.action_type or filter.category

    with get_db() as conn:
        if needs_post_filter:
            # 后过滤视图：拉全量 SQL 结果，内存过滤+分页（数据量小，~200 条）
            rows = conn.execute(
                f"{EMAIL_BASE_SELECT} WHERE {where} ORDER BY em.internal_id DESC",
                params,
            ).fetchall()
        else:
            count_sql = (
                f"SELECT COUNT(*) as cnt FROM email_metadata em "
                f"LEFT JOIN llm_processing lp ON em.internal_id = lp.internal_id "
                f"WHERE {where}"
            )
            sql_total = conn.execute(count_sql, params).fetchone()["cnt"]

            offset = (page - 1) * page_size
            rows = conn.execute(
                f"{EMAIL_BASE_SELECT} WHERE {where} "
                f"ORDER BY em.internal_id DESC LIMIT ? OFFSET ?",
                params + [page_size, offset],
            ).fetchall()

    # 先收集所有行和 thread_ids
    row_dicts = []
    thread_ids: set[str] = set()
    for row in rows:
        rd = dict(row)
        tid = rd.get("thread_id")
        if tid:
            thread_ids.add(tid)
        row_dicts.append(rd)

    # 批量查 thread_count（一次 SQL）
    thread_counts: Dict[str, int] = {}
    if thread_ids:
        with get_db() as conn2:
            placeholders = ",".join("?" for _ in thread_ids)
            tc_rows = conn2.execute(
                f"""
                SELECT thread_id, COUNT(*) as cnt
                FROM email_metadata
                WHERE thread_id IN ({placeholders})
                  AND sync_status = 'synced'
                GROUP BY thread_id
                """,
                list(thread_ids),
            ).fetchall()
            thread_counts = {r["thread_id"]: r["cnt"] for r in tc_rows}

    all_items = []
    for row_dict in row_dicts:
        labels = parse_labels(row_dict.pop("labels_json", None))
        tid = row_dict.get("thread_id")
        tc = thread_counts.get(tid, 0) if tid else 0
        item = _row_to_list_item(row_dict, labels, thread_count=tc)

        # view 后过滤（browse 依赖 labels_json 内字段）
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
            """,
        ).fetchall()

    pending = 0
    browse = 0
    total = len(rows)

    for row in rows:
        flagged = bool(row["is_flagged"])
        proc_status = row["processing_status"] or ""
        llm_ok = row["llm_status"] == "success"
        labels = parse_labels(row["labels_json"])
        priority = labels.get("priority")
        action_type = labels.get("action_type")

        if flagged and llm_ok and proc_status != "已完成":
            pending += 1
        elif not flagged and llm_ok:
            if action_type == "仅供参考" and priority is not None and priority != _VIEW_BROWSE_EXCLUDE_PRIORITY:
                if proc_status not in ("已浏览", "已完成"):
                    browse += 1

    return {"pending": pending, "browse": browse, "all": total}


def get_email_detail(internal_id: int) -> Optional[EmailDetail]:
    """获取单封邮件详情。"""
    with get_db() as conn:
        row = conn.execute(
            f"{EMAIL_BASE_SELECT} WHERE em.internal_id = ?",
            (internal_id,),
        ).fetchone()

        if not row:
            return None

        row_dict = dict(row)
        labels = parse_labels(row_dict.pop("labels_json", None))

        # 线程计数
        thread_id = row_dict.get("thread_id")
        thread_count = 0
        if thread_id:
            tc = conn.execute(
                "SELECT COUNT(*) as cnt FROM email_metadata WHERE thread_id = ? AND sync_status = 'synced'",
                (thread_id,),
            ).fetchone()
            thread_count = tc["cnt"] if tc else 0

    detail = EmailDetail(
        **_row_to_list_item(row_dict, labels, thread_count=thread_count).model_dump(),
        cc_addr=row_dict.get("cc_addr"),
    )
    return detail


def get_thread_emails(thread_id: str) -> List[EmailListItem]:
    """获取同一线程内所有邮件（按时间正序，用于展开线程）。"""
    if not thread_id:
        return []

    with get_db() as conn:
        rows = conn.execute(
            f"{EMAIL_BASE_SELECT} "
            "WHERE em.thread_id = ? AND em.sync_status = 'synced' "
            "ORDER BY em.date_received ASC",
            (thread_id,),
        ).fetchall()

    thread_count = len(rows)
    items = []
    for row in rows:
        row_dict = dict(row)
        labels = parse_labels(row_dict.pop("labels_json", None))
        items.append(_row_to_list_item(row_dict, labels, thread_count=thread_count))
    return items


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
