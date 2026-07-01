"""ping-island 解耦 ack 通道 + harness agent 上岛端点（契约 §6 / §9-4 + Part B）.

**ack（Part A）**：ping-island fork 按钮点击时 **fire-and-forget** POST 决定到 ``/api/island/ack``
（非同步 socket，不受 envelope 3s 短连接限制）。按 ``ack_token`` 查 live pending
（``island_ack``，SQLite 跨进程）→ ``kind`` 分流：
- ``mail`` → ``island_response`` action handler → 跑 ``mailagent`` CLI（Part A）。
- ``agent`` → `POST gateway /api/ai/approval/decide`（服务端 resume）→ 追发清卡 envelope（Part B）。

**announce（Part B）**：AI SDK Gateway（Electron 主进程内嵌，Node）在 ``needsApproval`` 暂停时
`POST /api/island/agent/announce` → 组 ``AgentApproval`` envelope + 登记 agent ack pending + 发岛。

鉴权：
- ``/ack`` **不挂** ``verify_cf_access``（ping-island 是独立 Swift app，拿不到 CF JWT / 本地
  token）。改用 loopback + ``ack_token`` 能力令牌自认（单次消费 + TTL）。
- ``/agent/announce`` 挂 ``verify_local_token``（**仅**本地 token，不接受 CF JWT）——调用方是
  同机 gateway（持 ``MAILAGENT_LOCAL_API_TOKEN``），远程 CF 用户不能推 agent 上岛卡。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from src.api.auth import verify_local_token
from src.api.deps import get_settings

log = logging.getLogger("mailagent.api.island")

router = APIRouter(prefix="/api/island", tags=["island"])

# fire-and-forget 后台 handler task 的强引用集 (asyncio loop 只弱引用 task, 无强引用
# 的 pending task 可能被 GC 中途回收 —— 同 island_dispatch._bg_tasks 手法)。
_bg_tasks: set = set()

# gateway /api/ai/approval/decide 可能跑真实写工具 (create_draft 60s / send 等), 留足超时。
# serve-api 侧在后台 task 里 await 它, 不阻塞 /ack 响应 (fork POST 本就 fire-and-forget)。
_GATEWAY_DECIDE_TIMEOUT_SEC = 100.0


def _schedule_bg(coro) -> None:
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


class IslandAckBody(BaseModel):
    ack_token: str
    choice: str


class IslandAgentAnnounceBody(BaseModel):
    """gateway → serve-api：把一条 agent session/审批事件推上岛。

    ``kind="approval"`` 带 ``toolCallId`` / ``risk`` / ``resumeToken`` / ``gatewayPort``
    （登记 ack pending + resume 回灌所需）；生命周期 ``running`` / ``completed`` / ``error``
    只需 ``sessionId`` / ``summary``。
    """

    kind: str  # "approval" | "running" | "completed" | "error"
    sessionId: int
    toolName: str = ""
    inputPreview: str = ""
    risk: str = ""
    toolCallId: str = ""
    resumeToken: str = ""
    gatewayPort: int = 0
    summary: str = ""
    title: str = ""


@router.post("/ack")
async def island_ack(body: IslandAckBody, settings=Depends(get_settings)) -> dict:
    """ping-island 按钮回调入口：解析 ack_token → 按 kind 路由。

    鉴权 = ``ack_token`` 能力令牌（不可猜、只经本地 unix socket 发出、不出网、单次消费 +
    TTL）。不做 loopback host 白名单：serve-api bind 127.0.0.1（远程经 cloudflared 反代
    时 client host 亦为 127.0.0.1），且远程另有 CF Access 边缘门控（L1）—— token 才是
    真正的门，对不上 live pending 即 404。
    """
    # lazy import: 让 import src.api.app 在裸 worktree (无 notify 依赖链) 也不炸
    from src.notify import island_ack as ack_registry

    db_path = settings.sync_store_db_path
    # resolve 是同步 sqlite (busy_timeout 30s), 放线程池避免阻塞 serve-api event loop
    # (mail-sync 持写锁时 resolve 可能等 → 不能卡住整个 serve-api / chat SSE 代理)。
    pending = await run_in_threadpool(
        ack_registry.resolve, db_path, body.ack_token, body.choice
    )
    if pending is None:
        # 无效 / 过期 / choice 不匹配 —— 不泄露具体原因
        raise HTTPException(status_code=404, detail="no live pending for ack")

    if pending.kind == "mail":
        from src.notify import island_response

        # 复用现有 17 handler: 合成 BridgeResponse shape + 存储的 envelope metadata
        synthetic = {"decision": {"answer": {"choice": body.choice}}}
        # fire-and-forget: handle_response 跑真实 CLI (create_draft 60s / create-task 90s),
        # 不 await —— ① 保持 fork POST 的 fire-and-forget 语义 (fork URLSession 5s 超时不等
        # 结果); ② 防 fork 断连时 Starlette 取消 handler 致业务半执行。真实结果由 P0-4
        # ActionAcked envelope 异步回流 fork。
        _schedule_bg(island_response.handle_response(synthetic, pending.metadata))
        log.info("[island-ack] mail choice=%s internal_id=%s dispatched (bg)",
                 body.choice, pending.internal_id)
        return {"ok": True, "kind": "mail", "choice": body.choice}

    if pending.kind == "agent":
        # Part B: harness 审批回灌 —— 后台 POST gateway /decide (服务端 resume) + 追发清卡。
        meta = pending.metadata
        tool_call_id = meta.get("mailagent.agentToolCallId", "")
        resume_token = meta.get("mailagent.agentResumeToken", "")
        gateway_port = _to_int(meta.get("mailagent.agentGatewayPort"), 0)
        session_id = _to_int(
            meta.get("mailagent.agentSessionId"),
            _session_id_from_key(pending.session_key),
        )
        if not tool_call_id or gateway_port <= 0:
            log.warning("[island-ack] agent pending missing toolCallId/gatewayPort")
            raise HTTPException(status_code=422, detail="agent pending malformed")
        _schedule_bg(_agent_decide_and_complete(
            session_id=session_id,
            gateway_port=gateway_port,
            tool_call_id=tool_call_id,
            resume_token=resume_token,
            choice=body.choice,
            sock_path=getattr(settings, "island_socket_path", None),
        ))
        log.info("[island-ack] agent choice=%s session_id=%s dispatched (bg)",
                 body.choice, session_id)
        return {"ok": True, "kind": "agent", "choice": body.choice}

    log.info("[island-ack] kind=%s not handled", pending.kind)
    return {"ok": False, "kind": pending.kind, "detail": "unknown kind"}


@router.post("/agent/announce", dependencies=[Depends(verify_local_token)])
async def island_agent_announce(
    body: IslandAgentAnnounceBody, settings=Depends(get_settings)
) -> dict:
    """gateway → serve-api：把一条 agent session/审批事件推上灵动岛（Part B）。

    gated by ``island_agent_enabled`` + ``ping_island_enabled``（关时静默 no-op，与今日
    字节一致）。``approval`` 登记 ack pending（岛上点批准经 ``/ack`` kind=agent 回灌 gateway
    resume）；生命周期事件只发 envelope 清/更新卡。fail-open：ping-island 未装/未跑仍返 ok。
    """
    if not getattr(settings, "island_agent_enabled", False):
        return {"ok": False, "enabled": False, "detail": "island agent disabled"}
    if not getattr(settings, "ping_island_enabled", True):
        return {"ok": False, "enabled": False, "detail": "ping-island disabled"}

    from src.notify import island_agent

    sock_path = getattr(settings, "island_socket_path", None)
    accent = getattr(settings, "island_accent", "coral")
    theme = getattr(settings, "island_theme", "dark")

    if body.kind == "approval":
        if not body.toolCallId or body.gatewayPort <= 0 or not body.resumeToken:
            raise HTTPException(
                status_code=422,
                detail="approval announce needs toolCallId + gatewayPort + resumeToken",
            )
        ack_token = await island_agent.announce_approval(
            db_path=settings.sync_store_db_path,
            session_id=body.sessionId,
            tool_call_id=body.toolCallId,
            tool_name=body.toolName,
            input_preview=body.inputPreview,
            risk=body.risk,
            resume_token=body.resumeToken,
            gateway_port=body.gatewayPort,
            api_port=island_agent.resolve_api_port(),
            sock_path=sock_path,
            accent=accent,
            theme=theme,
        )
        return {"ok": True, "kind": "approval", "ackToken": ack_token}

    if body.kind in ("running", "completed", "error"):
        status_kind = "notification" if body.kind == "running" else body.kind
        await island_agent.announce_status(
            session_id=body.sessionId,
            status_kind=status_kind,
            title=body.title,
            summary=body.summary,
            tool_name=body.toolName,
            sock_path=sock_path,
            accent=accent,
            theme=theme,
        )
        return {"ok": True, "kind": body.kind}

    raise HTTPException(status_code=422, detail=f"unknown announce kind {body.kind}")


async def _agent_decide_and_complete(
    *,
    session_id: int,
    gateway_port: int,
    tool_call_id: str,
    resume_token: str,
    choice: str,
    sock_path: Optional[str],
) -> None:
    """后台：POST gateway /decide（服务端 resume）→ 据结果追发 AgentCompleted / AgentError 清卡。

    fork 的 ack POST 是 fire-and-forget（5s 超时不读 response），故这里可从容 await 真实
    resume（跑写工具几十秒）。gateway 不可达 / resume 失败 → 发 AgentError 明确失效回执。
    """
    from src.notify import island_agent

    decision = "reject" if choice == "reject" else "approve"
    try:
        result = await _post_gateway_decide(
            gateway_port, tool_call_id, decision, resume_token
        )
        status = str(result.get("status") or "")
        summary = str(result.get("summary") or "")
        # 🔴 codex Fix 3：resume 又停在**下一个**审批门（status="repaused"）。gateway 的
        # makePersistOnFinish 已把新审批 stash + announce 成一张**新**岛卡；此处若发 completed
        # 会把那张新 waitingForInput 卡误清掉。故 repaused = 非终态，静默返回（不追发）。
        if status == "repaused":
            log.info("[island-ack] agent resume re-paused session_id=%s "
                     "(next approval already announced)", session_id)
            return
        if status == "error" or not result.get("ok", False):
            await island_agent.announce_status(
                session_id=session_id, status_kind="error",
                summary=summary or str(result.get("error") or "resume failed"),
                sock_path=sock_path,
            )
            return
        # completed / rejected 都用 completed 卡清掉 waitingForInput（title 走 announce_status
        # 默认 "AI 已完成"；reject 的语义体现在 gateway 回的 summary，用户语言）。
        await island_agent.announce_status(
            session_id=session_id, status_kind="completed",
            summary=summary, sock_path=sock_path,
        )
    except Exception as e:  # noqa: BLE001 — gateway 不可达 / 超时 → 明确失效回执
        log.warning("[island-ack] agent resume failed session_id=%s: %s", session_id, e)
        try:
            await island_agent.announce_status(
                session_id=session_id, status_kind="error",
                summary=str(e)[:200], sock_path=sock_path,
            )
        except Exception:  # noqa: BLE001
            pass


async def _post_gateway_decide(
    gateway_port: int, tool_call_id: str, decision: str, resume_token: str
) -> dict:
    """`POST http://127.0.0.1:{gateway_port}/api/ai/approval/decide`（loopback）。"""
    import httpx

    url = f"http://127.0.0.1:{gateway_port}/api/ai/approval/decide"
    payload = {
        "toolCallId": tool_call_id,
        "decision": decision,
        "resumeToken": resume_token,
    }
    async with httpx.AsyncClient(timeout=_GATEWAY_DECIDE_TIMEOUT_SEC) as client:
        resp = await client.post(url, json=payload)
        # 4xx/5xx (stash 已消费 / 过期 / bad token) → 抛 → 上层发 AgentError。
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, dict) else {"ok": False, "status": "error"}


def _to_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _session_id_from_key(session_key: str) -> int:
    """从 ``mailagent:agent:{id}`` 抽 session_id（metadata 缺 agentSessionId 时兜底）。"""
    try:
        return int(session_key.rsplit(":", 1)[-1])
    except (ValueError, IndexError):
        return 0
