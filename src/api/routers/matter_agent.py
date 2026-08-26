"""Matter 内部 Agent 端点（P4 decisions D6 + task 08-25 批次 3）。

两条，形状同构、鉴权同档：
- ``POST /api/matters/{public_id}/runs/{run_id}/proposal`` —— gateway
  ``matter_update_propose`` 工具（跟进 run）的**唯一**落库通道；
- ``POST /api/matters/{public_id}/item-dispatches/{dispatch_id}/report`` —— gateway
  ``matter_item_report`` 工具（行动项派发 run）的**唯一**落库通道。

🔴 鉴权 = ``verify_local_token``（仅本地 ephemeral token 腿，**不接受 CF JWT**，
Remote Web 不可调 —— 同 ``/api/agent-runs`` 纪律：唯一调用方是 Electron 主进程内嵌
gateway 的 domainClient，同机 loopback）。

body = 工具入参原样（``{summary, changes[], open_questions?, confidence?}``，
无 mutation 信封）；matter_id/run_id 全在 path —— run 语境盖章由 service 完成，
模型结构性传不进锚字段（schema extra=forbid）。每 run 至多一个提案（重复 →
409 E_PROPOSAL_EXISTS）；**不 bump matter.version**。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from src.api.app import success_envelope
from src.api.auth import verify_local_token
from src.api.routers.matters import (
    _call,
    get_matter_run_service,
)
from src.api.schemas.matters import MatterItemReportRequest, MatterProposalRequest
from src.matters.run_service import MatterRunService

router = APIRouter(
    prefix="/api/matters",
    tags=["matter-agent"],
    dependencies=[Depends(verify_local_token)],
)


@router.post("/{matter_id}/runs/{run_id}/proposal")
async def propose_matter_update(
    matter_id: str,
    run_id: int,
    body: MatterProposalRequest,
    request: Request,
    service: MatterRunService = Depends(get_matter_run_service),
):
    """校验 run 归属/在跑 → 防幻觉校验（D6 逐条）→ pending 提案落库 + UPDATE_PROPOSED
    事件。返回 ``{update_id, dropped:[...]}``（剔除明细同时暂存进 run.error_json，
    worker 终态凭它判 warn）。"""
    payload = body.model_dump(exclude_unset=True)
    result = _call(service.propose_update, matter_id, run_id, payload)
    return success_envelope(result, request=request, source="matter-agent")


@router.post("/{matter_id}/item-dispatches/{dispatch_id}/report")
async def report_item_dispatch(
    matter_id: str,
    dispatch_id: int,
    body: MatterItemReportRequest,
    request: Request,
    service: MatterRunService = Depends(get_matter_run_service),
):
    """行动项派发 run 的交付（task 08-25 批次 3）—— gateway ``matter_item_report`` 工具的
    **唯一**落库通道，鉴权与上面的提案端点同档（仅本地 token，Remote Web 不可调）。

    二选一：``needs_input`` → 派发 `running → awaiting_input`（问题落在派发行上等 owner）；
    ``summary``/``changes`` → 落成 pending 提案 + `running → proposed`，autonomous 档再
    立即按既有 accept 内核采纳。分支约束、作用范围裁剪、状态 CAS 全在 service 单判 ——
    这里只是薄转发（matter_id / dispatch_id 在 path，模型传不进锚字段）。

    返回 ``{dispatch_id, state, update_id, dropped[], accepted}``；重复交付（这一轮已经报过）
    → 409 E_INVALID_STATE。
    """
    payload = body.model_dump(exclude_unset=True)
    result = _call(service.report_item_dispatch, matter_id, dispatch_id, payload)
    return success_envelope(result, request=request, source="matter-agent")
