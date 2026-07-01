"""ping-island 解耦 ack 通道端点（契约 §6 / §9-4）.

ping-island fork 按钮点击时 **fire-and-forget** POST 决定到这里（非同步 socket，不受
envelope 3s 短连接限制）。按 ``ack_token`` 查 live pending（``island_ack``，SQLite 跨进程）
→ 路由 ``island_response`` action handler → 跑 ``mailagent`` CLI。

鉴权：**不挂** ``verify_cf_access``（ping-island 是独立 Swift app，拿不到 CF JWT / 本地
token）。改用 loopback + ``ack_token`` 能力令牌自认——token 由 MailAgent 生成、只经**本地**
unix socket 发给 ping-island（不出网、不进 Notion/远程 API），对不上 live pending 即拒；
单次消费 + TTL。远程经 cloudflared 时另有 CF Access 边缘门控（L1）兜底。

``kind="agent"`` 分支留给 Part B（harness 上岛，本 session 只出设计，未实现）。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from src.api.deps import get_settings

log = logging.getLogger("mailagent.api.island")

router = APIRouter(prefix="/api/island", tags=["island"])


class IslandAckBody(BaseModel):
    ack_token: str
    choice: str


@router.post("/ack")
async def island_ack(body: IslandAckBody, settings=Depends(get_settings)) -> dict:
    """ping-island 按钮回调入口：解析 ack_token → 路由 action handler。

    鉴权 = ``ack_token`` 能力令牌（不可猜、只经本地 unix socket 发出、不出网、单次消费 +
    TTL）。不做 loopback host 白名单：serve-api bind 127.0.0.1（远程经 cloudflared 反代
    时 client host 亦为 127.0.0.1，无法区分本地/远程），且远程另有 CF Access 边缘门控（L1）
    —— token 才是真正的门，对不上 live pending 即 404。
    """
    # lazy import: 让 import src.api.app 在裸 worktree (无 notify 依赖链) 也不炸
    from src.notify import island_ack as ack_registry
    from src.notify import island_response

    db_path = settings.sync_store_db_path
    pending = ack_registry.resolve(db_path, body.ack_token, body.choice)
    if pending is None:
        # 无效 / 过期 / choice 不匹配 —— 不泄露具体原因
        raise HTTPException(status_code=404, detail="no live pending for ack")

    if pending.kind == "mail":
        # 复用现有 17 handler: 合成 BridgeResponse shape + 存储的 envelope metadata
        synthetic = {"decision": {"answer": {"choice": body.choice}}}
        await island_response.handle_response(synthetic, pending.metadata)
        log.info("[island-ack] mail choice=%s internal_id=%s handled",
                 body.choice, pending.internal_id)
        return {"ok": True, "kind": "mail", "choice": body.choice}

    # kind == "agent" → Part B harness 上岛 (本 session 只出设计, 未接线)
    log.info("[island-ack] kind=%s not handled yet (Part B pending)", pending.kind)
    return {"ok": False, "kind": pending.kind, "detail": "not implemented"}
