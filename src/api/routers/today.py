"""今日页读端点 —— ``GET /api/today``（task 08-27-l4-tab-workspace P4c）。

**只出两块**：``reply``（待回邮件）与 ``nextHardPoint``（下一个硬时间点）。
今日页另外四节（等你拍板 / 今天的会 / 临期事项 / 智能体产出）走各自的现成端点，
理由写在 ``src/today/aggregate.py`` 的模块 docstring —— 那是对 design §十
「五节一次算出来」的显式偏离，改这里之前先读那段。

鉴权：``verify_cf_access``（远程 CF Access / 本地 ephemeral token 两腿都过），与
``matters`` / ``reports`` / ``notifications`` 口径一致 —— 它是纯读面，且远程 web 的
今日页要看得见。无 flag 门控（今日页是确定要做的功能）。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.today.aggregate import REPLY_LIMIT, build_today

if TYPE_CHECKING:  # pragma: no cover
    from src.config import Config

router = APIRouter(prefix="/api", tags=["today"])


@router.get("/today", dependencies=[Depends(verify_cf_access)])
async def get_today(
    request: Request,
    cfg: "Config" = Depends(get_settings),
    tz: Optional[str] = Query(
        None, description="Olson 时区名；「今天的日末」按它算, 缺省 UTC"
    ),
    now: Optional[str] = Query(
        None, description="ISO 覆盖「此刻」(测试用); 缺省 = 服务端当前时刻"
    ),
    reply_limit: int = Query(REPLY_LIMIT, alias="replyLimit", ge=1, le=200),
):
    """``data = {reply: TodayReplyItem[], nextHardPoint: AgendaEntry | null}``。

    ``reply`` 逐条带 ``why``（「需要回复 · 等了 26 小时」）；组装不出时是**空串**，
    前端按缺席渲染 —— 不兜底成一句套话。
    """
    from src.calendar_sync.agenda import resolve_zone

    try:
        zone = resolve_zone(tz)
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc), source="sqlite") from exc

    parsed_now: Optional[datetime] = None
    if now:
        try:
            parsed_now = datetime.fromisoformat(now)
        except (TypeError, ValueError) as exc:
            raise APIError(
                "E_INVALID_ARG", f"now={now!r} is not an ISO datetime", source="sqlite"
            ) from exc
        if parsed_now.tzinfo is None:
            parsed_now = parsed_now.replace(tzinfo=timezone.utc)

    # 两块都是阻塞 sqlite3 调用，挪线程池跑（同 matters/notifications 的 `_acall`）：
    # 留在 uvicorn 单事件循环上会 head-of-line 别的并发请求。
    data = await asyncio.to_thread(
        build_today,
        str(cfg.sync_store_db_path),
        cfg=cfg,
        now=parsed_now,
        zone=zone,
        reply_limit=reply_limit,
    )
    return success_envelope(
        data,
        request=request,
        source="sqlite",
        meta_extra={"replyCount": len(data["reply"]), "tz": tz},
    )
