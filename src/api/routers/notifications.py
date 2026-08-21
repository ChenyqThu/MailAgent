"""统一通知中心 REST 端点 (task 08-20-notification-center 步骤 6, design §5)。

M1 四端点: list / unread-count / read-all / {id}/read。**无 flag 门控**——通知中心
是确定要做的功能，直接默认生效 (owner 2026-08-20 拍板, design §8.e)；不设
`MAILAGENT_NOTIFY_CENTER` 之类的灰度开关。

鉴权：整个 router 挂 `verify_cf_access`（远程 CF Access / 本地 ephemeral token 两腿
都过——`auth.py` 里本地 token 是它内置的第一腿），与 `matters.router` / `reports.router`
/ `jobs.router` 等 owner-facing 端点口径一致；`POST /publish`（Electron main 侧信源专用
的 internal face，`verify_local_token` 单腿）是 M2，不在本次改动范围。

写面全部经 `src.notify.center.NotifyCenter`（发布入口单源, PRD 基线 4）; 本文件只做
query/body 解析 + `NotifyCenterError` → `APIError` 的错误码转换 + 投影转 camelCase wire。
"""

from __future__ import annotations

import asyncio
from functools import lru_cache
from typing import Any, Callable

from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.notify.center import NotifyCenter, NotifyCenterError

router = APIRouter(
    prefix="/api/notifications",
    tags=["notifications"],
    dependencies=[Depends(verify_cf_access)],
)


@lru_cache(maxsize=4)
def _build_notify_center(db_path: str) -> NotifyCenter:
    """按 db_path 缓存 (`matters.py:_build_matter_service` 同形): 缓存的是对象不是
    连接——`NotifyCenter` 只持 db_path, 每次调用短命 `sqlite3.connect`。"""
    return NotifyCenter(db_path)


def get_notify_center(settings=Depends(get_settings)) -> NotifyCenter:
    return _build_notify_center(str(settings.sync_store_db_path))


def _call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    try:
        return fn(*args, **kwargs)
    except NotifyCenterError as exc:
        raise APIError(exc.code, exc.message, source="sqlite") from exc


async def _acall(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """读端点挪线程池跑 (`matters.py:_acall` 同形): NotifyCenter 是阻塞 sqlite3 调用,
    留在 uvicorn 单事件循环上会 head-of-line 别的并发请求。"""
    return await asyncio.to_thread(_call, fn, *args, **kwargs)


def _to_wire(item: dict[str, Any]) -> dict[str, Any]:
    """NotifyCenter 投影 (snake_case) → wire 单条投影 (camelCase, design §5)。

    🔴 `dedupe_key` 有意不上线——它是服务端去重实现细节, design §5 的单条投影样例
    未列它, 不为不存在的消费点开一个字段。
    """
    return {
        "id": item["id"],
        "category": item["category"],
        "source": item["source"],
        "severity": item["severity"],
        "state": item["state"],
        "title": item["title"],
        "body": item["body"],
        "payload": item.get("payload"),
        "recurrenceNo": item["recurrence_no"],
        "firstCreatedAt": item["first_created_at"],
        "lastEventAt": item["last_event_at"],
        "readAt": item.get("read_at"),
        "snoozedUntil": item.get("snoozed_until"),
        "resolvedAt": item.get("resolved_at"),
        "dismissedAt": item.get("dismissed_at"),
    }


@router.get("")
async def list_notifications(
    request: Request,
    category: str | None = None,
    state: str = "open",
    unread_only: bool = Query(default=False, alias="unreadOnly"),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    center: NotifyCenter = Depends(get_notify_center),
):
    """通知列表 (design §5 `GET ""`)。非法 category/state 由 `NotifyCenter.list`
    抛 `E_INVALID_ARG` → 400, 不静默忽略/回落默认值。"""
    result = await _acall(
        center.list,
        category=category,
        state=state,
        unread_only=unread_only,
        limit=limit,
        offset=offset,
    )
    items = [_to_wire(item) for item in result.items]
    return success_envelope(
        items,
        request=request,
        meta_extra={
            "count": len(items),
            "total": result.total,
            "limit": limit,
            "offset": offset,
            "unread": result.unread,
        },
    )


@router.get("/unread-count")
async def get_unread_count(
    request: Request,
    center: NotifyCenter = Depends(get_notify_center),
):
    """铃铛徽标数据源 (design §5 `GET /unread-count`, `agent_runs.py` 的
    `{total, byAgent}` 形状同款)。"""
    result = await _acall(center.unread_count)
    return success_envelope(
        {"total": result["total"], "byCategory": result["by_category"]},
        request=request,
    )


@router.post("/read-all")
async def read_all_notifications(
    request: Request,
    body: dict[str, Any] | None = None,
    center: NotifyCenter = Depends(get_notify_center),
):
    """全部已读 (design §5 `POST /read-all`); body `{category?}` 可选。天然幂等,
    不挂 mutation 信封 (`matters.py::set_matter_notify_level` 裸 dict body 同形)。"""
    category = (body or {}).get("category")
    updated = _call(center.mark_all_read, category=category)
    return success_envelope({"updated": updated}, request=request)


@router.post("/{notification_id:int}/read")
async def read_notification(
    notification_id: int,
    request: Request,
    center: NotifyCenter = Depends(get_notify_center),
):
    """单条已读 (design §5 `POST /{id}/read`); 天然幂等; 不存在 id → 404。"""
    result = _call(center.mark_read, notification_id)
    return success_envelope(_to_wire(result), request=request)
