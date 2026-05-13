import time

from fastapi import APIRouter, Depends, HTTPException

from web.api.deps import verify_token
from web.api.models.action import ActionRequest
from web.api.services import redis_service
from web.api.services.db import get_db, get_db_rw

router = APIRouter(dependencies=[Depends(verify_token)])

ACTION_EVENT_MAP = {
    "mark_done": "completed",
    "mark_browsed": None,  # 纯本地操作，不需要 Redis/Mail.app
    "toggle_flag": "flag_changed",
    "toggle_read": "flag_changed",
}


def _get_email_meta(email_id: int) -> dict:
    """从 SQLite 读取 handler 需要的字段。"""
    with get_db() as conn:
        row = conn.execute(
            "SELECT message_id, mailbox, notion_page_id, is_read, is_flagged "
            "FROM email_metadata WHERE internal_id = ?",
            (email_id,),
        ).fetchone()
    if not row:
        return {}
    return dict(row)


@router.post("/emails/{email_id}/action")
async def perform_action(email_id: int, req: ActionRequest):
    if req.action not in ACTION_EVENT_MAP:
        raise HTTPException(status_code=400, detail=f"未知操作: {req.action}")
    event_type = ACTION_EVENT_MAP[req.action]

    meta = _get_email_meta(email_id)
    if not meta:
        raise HTTPException(status_code=404, detail="邮件不存在")

    mailbox = meta.get("mailbox", "")
    message_id = meta.get("message_id", "")
    page_id = meta.get("notion_page_id", "")

    # 1. 即时更新 SQLite + web_action_at 抑制正向同步竞态
    now = time.time()
    with get_db_rw() as conn:
        if req.action == "mark_done":
            conn.execute(
                "UPDATE email_metadata SET is_flagged = 0, is_read = 1, processing_status = '已完成', web_action_at = ?, updated_at = ? WHERE internal_id = ?",
                (now, now, email_id),
            )
        elif req.action == "mark_browsed":
            conn.execute(
                "UPDATE email_metadata SET processing_status = '已浏览', updated_at = ? WHERE internal_id = ?",
                (now, email_id),
            )
        elif req.action == "toggle_flag":
            conn.execute(
                "UPDATE email_metadata SET is_flagged = 1 - is_flagged, web_action_at = ? WHERE internal_id = ?",
                (now, email_id),
            )
        elif req.action == "toggle_read":
            conn.execute(
                "UPDATE email_metadata SET is_read = 1 - is_read, web_action_at = ? WHERE internal_id = ?",
                (now, email_id),
            )

    # 2. Redis 事件（handler 负责 Mail.app + Notion 同步）
    if req.action == "mark_done":
        await redis_service.push_event({
            "type": "completed",
            "internal_id": email_id,
            "page_id": page_id,
            "source": "web",
            "properties": {
                "message_id": message_id,
                "mailbox": mailbox,
            },
        })
    elif req.action == "toggle_flag":
        new_flagged = not meta.get("is_flagged", False)
        await redis_service.push_event({
            "type": "flag_changed",
            "internal_id": email_id,
            "page_id": page_id,
            "source": "web",
            "properties": {
                "message_id": message_id,
                "mailbox": mailbox,
                "is_flagged": new_flagged,
            },
        })
    elif req.action == "toggle_read":
        new_read = not meta.get("is_read", False)
        await redis_service.push_event({
            "type": "flag_changed",
            "internal_id": email_id,
            "page_id": page_id,
            "source": "web",
            "properties": {
                "message_id": message_id,
                "mailbox": mailbox,
                "is_read": new_read,
            },
        })

    return {"ok": True, "action": req.action, "email_id": email_id}
