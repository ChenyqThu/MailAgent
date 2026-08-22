"""统一通知中心 REST 端点 (task 08-20-notification-center 步骤 6, design §5)。

M1 四端点: list / unread-count / read-all / {id}/read；M2 动作面追加
{id}/snooze、{id}/resolve 与 internal 的 publish。**无 flag 门控**——通知中心
是确定要做的功能，直接默认生效 (owner 2026-08-20 拍板, design §8.e)；不设
`MAILAGENT_NOTIFY_CENTER` 之类的灰度开关。

鉴权：owner-facing 端点整个 router 挂 `verify_cf_access`（远程 CF Access / 本地
ephemeral token 两腿都过——`auth.py` 里本地 token 是它内置的第一腿），与
`matters.router` / `reports.router` / `jobs.router` 口径一致；`POST /publish` 是
Electron main 侧信源专用的 internal face，挂 **`verify_local_token` 单腿**（不接受
CF JWT → 远程用户无法凭空写通知行），走独立 `_internal_router` 再 `routes.extend`
到主 router（`matters.py` 的 `/attention/{id}/notified` 同款写法）。

写面全部经 `src.notify.center.NotifyCenter`（发布入口单源, PRD 基线 4）; 本文件只做
query/body 解析 + `NotifyCenterError` → `APIError` 的错误码转换 + 投影转 camelCase wire。
"""

from __future__ import annotations

import asyncio
from functools import lru_cache
from typing import Any, Callable

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import Field

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access, verify_local_token
from src.api.deps import get_settings

# mutation 信封与 snooze 预设**复用 matters 既有单源**，不在本域另造镜像：
# `MutationEnvelope` / `MutationOnly` / `StrictModel` 是通用 mutation DTO（历史上
# 落在 matters 的 schema 模块里），`SNOOZE_3D_MS` 是「稍后提醒」的既有预设换算。
from src.api.schemas.matters import MutationEnvelope, MutationOnly, StrictModel
from src.matters.attention import SNOOZE_3D_MS
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
    `{total, byAgent}` 形状同款)。

    三轴同出一条 GROUP BY, 口径按构造一致:

    - `byCategory` / `bySeverity`: **未读**轴 (`bySeverity.critical > 0` → 铃铛红点档);
    - `openByCategory`: **活跃**轴 (不带 read 过滤) —— 收编 `AgentPendingBadge` 后铃铛
      要保留一档 level 型指示: 未读读掉了、待办还挂着时仍要看得见 (M3 批 C5)。
    """
    result = await _acall(center.unread_count)
    return success_envelope(
        {
            "total": result["total"],
            "byCategory": result["by_category"],
            "bySeverity": result["by_severity"],
            "openByCategory": result["open_by_category"],
        },
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


# ==================== M2 动作面 (design §5) ====================

#: snooze 预设集: 与 matters attention 的 preset **同源** —— `matters.py` 的
#: `snooze_attention` 只认 `"3d"` 并在路由层换算成 `clock + SNOOZE_3D_MS`。这里不
#: 自造第二套预设/换算 (两处各写一份 = 改一处漏一处)。
_SNOOZE_PRESETS: dict[str, int] = {"3d": SNOOZE_3D_MS}


class NotificationSnoozeRequest(StrictModel):
    """`POST /{id}/snooze` body: mutation 信封 + `until` / `preset` 二选一。"""

    mutation: MutationEnvelope
    until: int | None = Field(default=None, ge=1)  # epoch ms
    preset: str | None = None


class NotificationPublishRequest(StrictModel):
    """internal `POST /publish` body。

    🔴 与 design §3.3 的一处偏离: 请求体键**用 snake_case**, 不是 camelCase。
    理由是本仓的既有分工 —— **请求体 snake_case**(`mutation.idempotency_key`、
    `internal_id`、`link_scope`…, 含 main 进程 loopback client `domainClient.ts`
    发出的 body)、**响应与 query 参数 camelCase**(`_to_wire` / `unreadOnly`)。
    同一批的 snooze/resolve body 里躺着 snake_case 的 `idempotency_key`, 隔壁
    publish 写 `dedupeKey` 等于让调用方记两套拼法; 另外 pydantic 2.13 对 body 模型
    里的 `alias=` 会告警 (FastAPI 逐字段建 TypeAdapter 时 alias 不生效)。

    枚举 (`category` / `severity`) 有意**不写成 Literal**: 值域单源在
    `src/notify/center_models.py`, 由 `NotifyCenter.publish` 校验 → 非法值统一
    `E_INVALID_ARG` → 400 (写成 Literal 会变成 422 且在这里抄一份值集)。
    """

    category: str
    source: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=500)
    dedupe_key: str = Field(min_length=1, max_length=256)
    body: str = ""
    severity: str = "info"
    payload: dict[str, Any] | None = None


def _check_idempotency(mutation: MutationEnvelope, header_key: str | None) -> None:
    """Idempotency-Key header 与 body 一致校验 (`matters.py::_mutation_args` 同款守卫)。

    🔴 通知中心**没有事件账本** —— matters 的重放靠 `matter_event` 按 dedupe_key 查回
    上次结果, 通知表没有对应物 (也不为此加表)。所以 `idempotency_key` 在这里只是
    「同一次动作」的一致性标识, 重放安全由 core 的 CAS 兜底: 同 `until` 的 snooze
    重放落到同一终态; 已关条目的二次 resolve 被 CAS 拒 (E_INVALID_STATE) —— 两者都
    不会二次生效。
    """
    if header_key is not None and header_key != mutation.idempotency_key:
        raise APIError(
            "E_IDEMPOTENCY_CONFLICT",
            "Idempotency-Key header does not match mutation.idempotency_key",
            source="sqlite",
        )


def _resolve_snooze_until(
    body: NotificationSnoozeRequest, center: NotifyCenter
) -> int:
    """preset → until 的换算在**路由层** (matters `snooze_attention` 同位置)。"""
    if (body.until is None) == (body.preset is None):
        raise APIError(
            "E_INVALID_ARG",
            "exactly one of 'until' or 'preset' is required",
            source="sqlite",
        )
    if body.preset is not None:
        delta = _SNOOZE_PRESETS.get(body.preset)
        if delta is None:
            # 未知 preset 不静默忽略 (否则会以「until 缺失」的错误信息报出来)
            raise APIError(
                "E_INVALID_ARG",
                f"unknown snooze preset: {body.preset!r} "
                f"(supported: {', '.join(_SNOOZE_PRESETS)})",
                source="sqlite",
            )
        return center.clock_ms() + delta
    return int(body.until)


@router.post("/{notification_id:int}/snooze")
async def snooze_notification(
    notification_id: int,
    body: NotificationSnoozeRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    center: NotifyCenter = Depends(get_notify_center),
):
    """稍后提醒 (design §5 `POST /{id}/snooze`)。

    到期唤醒是**读侧语义** (design §8.d): 不改回 `state='open'`, `_OPEN_PREDICATE`
    把过期 snoozed 视同 open。已关条目 (resolved/dismissed) 由 core CAS 拒 →
    `E_INVALID_STATE` → 409; 不存在 id → 404; until 不在未来 → 400。
    """
    _check_idempotency(body.mutation, idempotency_key)
    until = _resolve_snooze_until(body, center)
    result = _call(center.snooze, notification_id, until_ms=until)
    return success_envelope(_to_wire(result), request=request)


@router.post("/{notification_id:int}/resolve")
async def resolve_notification(
    notification_id: int,
    body: MutationOnly,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    center: NotifyCenter = Depends(get_notify_center),
):
    """标记已处理 (design §5 `POST /{id}/resolve`); CAS 同 snooze。

    resolve 与 read 是**两个独立轴**: resolve 不顺手标已读 (read_at 不动), 未读数
    的口径本就不含 resolved 行, 该条目从徽标里消失是 state 的效果不是 read 的。
    """
    _check_idempotency(body.mutation, idempotency_key)
    result = _call(center.resolve, notification_id)
    return success_envelope(_to_wire(result), request=request)


async def publish_notification(
    body: NotificationPublishRequest,
    request: Request,
    center: NotifyCenter = Depends(get_notify_center),
):
    """internal 发布面 (design §3.3 / §5 `POST /publish`)。

    消费方是 Electron main 侧的信源 (应用更新就绪 / chat detached run 完成) ——
    它们没有 Python 写点, 走 loopback + `X-MailAgent-Local-Token`。发布语义 (dedupe
    计次 / severity 只升不降 / commit 后发事件) 全在 `NotifyCenter.publish`, 这里
    只做 body 解析: **不复制**任何发布逻辑 (PRD 基线 4 发布入口单源)。
    """
    result = _call(
        center.publish,
        category=body.category,
        source=body.source,
        title=body.title,
        dedupe_key=body.dedupe_key,
        body=body.body,
        severity=body.severity,
        payload=body.payload,
    )
    projected = _call(center.get, result.id)  # publish 只回 id/created/计次
    return success_envelope(_to_wire(projected), request=request)


# internal face 单独一条路由: 主 router 整体挂 `verify_cf_access`, 而 publish 只认
# 本地 token (远程 CF 用户不得凭空写通知行) —— 同一 prefix 下换鉴权只能这样拆
# (`matters.py` 的 `/attention/{signal_id}/notified` 先例)。
_internal_router = APIRouter(prefix="/api/notifications", tags=["notifications"])
_internal_router.add_api_route(
    "/publish",
    publish_notification,
    methods=["POST"],
    dependencies=[Depends(verify_local_token)],
)
router.routes.extend(_internal_router.routes)
