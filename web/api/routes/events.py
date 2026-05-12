"""SSE 实时事件推送。

轮询 sync_store.db 变化，推送给前端：
- email_new: 新邮件到达
- email_updated: 邮件字段变化
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from web.api.deps import verify_token
from web.api.services.db import get_db

router = APIRouter(tags=["事件"])


def _get_recent_changes(since: float) -> list:
    """查询 since 时间戳之后有变化的邮件。"""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT internal_id, subject, sender, mailbox, sync_status,
                   is_read, is_flagged, updated_at
            FROM email_metadata
            WHERE updated_at > ?
            ORDER BY updated_at DESC
            LIMIT 20
            """,
            (since,),
        ).fetchall()
    return [dict(r) for r in rows]


async def _event_stream(request: Request) -> AsyncGenerator[str, None]:
    """SSE 事件流生成器（每连接独立 timestamp）。"""
    last_check = time.time()

    yield f"data: {json.dumps({'type': 'connected', 'ts': last_check})}\n\n"

    while True:
        if await request.is_disconnected():
            break

        await asyncio.sleep(2)

        now = time.time()
        changes = _get_recent_changes(last_check)
        last_check = now

        if changes:
            for change in changes:
                event = {
                    "type": "email_updated",
                    "data": change,
                }
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@router.get("/events")
async def sse_events(
    request: Request,
    _token: str = Depends(verify_token),
):
    """SSE 事件流。前端通过 EventSource 连接。"""
    return StreamingResponse(
        _event_stream(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
