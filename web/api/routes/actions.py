"""邮件操作端点：单封 / 批量 / 视图全量。"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from web.api.deps import verify_token
from web.api.models.action import ActionRequest, BatchActionRequest, ViewActionRequest
from web.api.models.email import EmailFilter
from web.api.services import email_service, redis_service
from web.api.services.db import get_db, get_db_rw

router = APIRouter(dependencies=[Depends(verify_token)])


ACTION_EVENT_MAP: dict[str, str | None] = {
    "mark_done": "completed",
    "mark_browsed": None,  # 纯本地操作，不需要 Redis/Mail.app
    "toggle_flag": "flag_changed",
    "toggle_read": "flag_changed",
}

# 单 SQL 表达式，参数顺序: [now, internal_id]。mark_done 多一个 now（is_flagged + processing_status 同时更新）
_UPDATE_SQL: dict[str, str] = {
    "mark_done": (
        "UPDATE email_metadata SET is_flagged = 0, is_read = 1, "
        "processing_status = '已完成', web_action_at = ?, updated_at = ? "
        "WHERE internal_id = ?"
    ),
    "mark_browsed": (
        "UPDATE email_metadata SET processing_status = '已浏览', updated_at = ? "
        "WHERE internal_id = ?"
    ),
    "toggle_flag": (
        "UPDATE email_metadata SET is_flagged = 1 - is_flagged, web_action_at = ? "
        "WHERE internal_id = ?"
    ),
    "toggle_read": (
        "UPDATE email_metadata SET is_read = 1 - is_read, web_action_at = ? "
        "WHERE internal_id = ?"
    ),
}


def _apply_action_single(conn, action: str, internal_id: int, now: float) -> None:
    if action == "mark_done":
        conn.execute(_UPDATE_SQL[action], (now, now, internal_id))
    else:
        conn.execute(_UPDATE_SQL[action], (now, internal_id))


def _get_email_meta(email_id: int) -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT message_id, mailbox, notion_page_id, is_read, is_flagged "
            "FROM email_metadata WHERE internal_id = ?",
            (email_id,),
        ).fetchone()
    return dict(row) if row else {}


def _get_email_metas_batch(email_ids: list[int]) -> dict[int, dict[str, Any]]:
    """一次性查多封邮件的元数据，避免 N+1。"""
    if not email_ids:
        return {}
    placeholders = ",".join("?" * len(email_ids))
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT internal_id, message_id, mailbox, notion_page_id, is_read, is_flagged "
            f"FROM email_metadata WHERE internal_id IN ({placeholders})",
            email_ids,
        ).fetchall()
    return {r["internal_id"]: dict(r) for r in rows}


def _build_event(action: str, eid: int, meta: dict[str, Any]) -> dict[str, Any] | None:
    """构造给 Redis handler 的事件 payload。返回 None 表示该 action 不需要推事件。"""
    event_type = ACTION_EVENT_MAP.get(action)
    if not event_type:
        return None

    base = {
        "type": event_type,
        "internal_id": eid,
        "page_id": meta.get("notion_page_id", ""),
        "source": "web",
        "properties": {
            "message_id": meta.get("message_id", ""),
            "mailbox": meta.get("mailbox", ""),
        },
    }
    if action == "toggle_flag":
        base["properties"]["is_flagged"] = not meta.get("is_flagged", False)
    elif action == "toggle_read":
        base["properties"]["is_read"] = not meta.get("is_read", False)
    return base


@router.post("/emails/{email_id}/action")
async def perform_action(email_id: int, req: ActionRequest):
    if req.action not in ACTION_EVENT_MAP:
        raise HTTPException(status_code=400, detail=f"未知操作: {req.action}")

    meta = _get_email_meta(email_id)
    if not meta:
        raise HTTPException(status_code=404, detail="邮件不存在")

    now = time.time()
    with get_db_rw() as conn:
        _apply_action_single(conn, req.action, email_id, now)

    event = _build_event(req.action, email_id, meta)
    if event:
        await redis_service.push_event(event)

    return {"ok": True, "action": req.action, "email_id": email_id}


@router.post("/emails/batch-action")
async def perform_batch_action(req: BatchActionRequest):
    """批量操作多封邮件（线程级或多选用）。"""
    if req.action not in ACTION_EVENT_MAP:
        raise HTTPException(status_code=400, detail=f"未知操作: {req.action}")
    if not req.email_ids:
        raise HTTPException(status_code=400, detail="email_ids 不能为空")
    if len(req.email_ids) > 100:
        raise HTTPException(status_code=400, detail="单次最多 100 封")

    metas = _get_email_metas_batch(req.email_ids)
    valid_ids = [eid for eid in req.email_ids if eid in metas]
    if not valid_ids:
        return {"ok": True, "action": req.action, "processed": []}

    now = time.time()
    with get_db_rw() as conn:
        for eid in valid_ids:
            _apply_action_single(conn, req.action, eid, now)

    events = [_build_event(req.action, eid, metas[eid]) for eid in valid_ids]
    push_tasks = [redis_service.push_event(ev) for ev in events if ev]
    if push_tasks:
        await asyncio.gather(*push_tasks)

    return {"ok": True, "action": req.action, "processed": valid_ids}


@router.post("/emails/view-action")
async def perform_view_action(req: ViewActionRequest):
    """对整个视图的所有邮件执行操作（如：browse 视图全部已阅）。"""
    allowed = {"mark_browsed": ["browse"], "mark_done": ["pending"]}
    if req.action not in allowed:
        raise HTTPException(status_code=400, detail=f"视图操作不支持: {req.action}")
    if req.view not in allowed[req.action]:
        raise HTTPException(status_code=400, detail=f"{req.action} 不能用于 {req.view} 视图")

    items, _ = email_service.list_emails(
        EmailFilter(view=req.view), page=1, page_size=5000,
    )
    if not items:
        return {"ok": True, "action": req.action, "count": 0}

    ids = [item.internal_id for item in items]
    now = time.time()
    placeholders = ",".join("?" * len(ids))

    with get_db_rw() as conn:
        if req.action == "mark_browsed":
            conn.execute(
                f"UPDATE email_metadata SET processing_status = '已浏览', updated_at = ? "
                f"WHERE internal_id IN ({placeholders})",
                [now] + ids,
            )
        elif req.action == "mark_done":
            conn.execute(
                f"UPDATE email_metadata SET is_flagged = 0, is_read = 1, "
                f"processing_status = '已完成', web_action_at = ?, updated_at = ? "
                f"WHERE internal_id IN ({placeholders})",
                [now, now] + ids,
            )

    if ACTION_EVENT_MAP.get(req.action):
        metas = _get_email_metas_batch(ids)
        events = [_build_event(req.action, eid, metas[eid]) for eid in ids if eid in metas]
        push_tasks = [redis_service.push_event(ev) for ev in events if ev]
        if push_tasks:
            await asyncio.gather(*push_tasks)

    return {"ok": True, "action": req.action, "count": len(ids)}
