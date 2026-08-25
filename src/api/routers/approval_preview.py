"""approval-preview 路由 —— ``POST /api/approval/preview``（L4 批次 1 #6）。

审批卡上那行「AI 要做什么」的**事实来源**。调用方是同机 embedded gateway：暂停在
审批门时（announce 腿）与记录页 live 查 pending 时（pending 腿）各调一次，拿到服务端
按真实 payload 生成的一行摘要；返回 ``preview: null`` 或调用失败时 gateway 回落自己
那份模型自述文案（fail-open，见 ``chatRun.ts::resolveApprovalPreview``）。

派生逻辑全在 ``src/services/approval_preview.py``（覆盖面 / 为什么不覆盖某工具，看那里
的模块 docstring）；本路由只做形状校验 + 线程池调度。

路径为什么**不是** ``/api/ai/approval/preview``：``/api/ai/approval/*`` 已经整段是
``ai_gateway_proxy`` 的代理地盘（resolve / pending / decide 三个都转发到 gateway 的
8300）。往同一段路径底下塞一个 serve-api **自有**端点，下一个人只会把它也加进代理清单
然后打自己一个转发环。serve-api 自有的东西就挂在自己的路径下。

鉴权：``verify_local_token``（**只**本地 token，不接受 CF JWT）—— 调用方恒是同机
gateway，且这行摘要会摊开真实收件人 / 日程现值，没有理由对远程 CF 用户开放一个可以按
任意 ``internal_id`` / ``ical_uid`` 探测库内事实的口子（同 ``/api/island/agent/announce``
的姿态）。
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from src.api.app import success_envelope
from src.api.auth import verify_local_token
from src.api.deps import get_service_ctx, get_settings

router = APIRouter(prefix="/api/approval", tags=["approval"])


class ApprovalPreviewBody(BaseModel):
    """gateway → serve-api：``{toolName, input}``（input = 模型给的 tool args 原样）。

    ``input`` 用 ``Any``（不是 ``dict``）：模型可以给出任何形状，形状不对**不该 422**
    —— 那会让 gateway 侧多一条错误分支去处理一个本就该降级的情形。非 dict 一律走
    ``preview: null`` 的正常降级路径。
    """

    toolName: str = ""
    input: Any = None


@router.post("/preview")
async def approval_preview(
    body: ApprovalPreviewBody,
    request: Request,
    settings=Depends(get_settings),
    ctx=Depends(get_service_ctx),
    _auth=Depends(verify_local_token),
) -> Any:
    """按 ``{toolName, input}`` 产出一行服务端事实摘要（无派生器 → ``preview: null``）。

    读端点纪律：sqlite 读一律 ``run_in_threadpool``（serve-api 单 worker 单事件循环，
    裸阻塞读留在循环上就是 head-of-line）。
    """
    from src.services.approval_preview import build_approval_preview

    preview: Optional[str] = await run_in_threadpool(
        build_approval_preview,
        body.toolName,
        body.input,
        ctx=ctx,
        settings=settings,
    )
    return success_envelope(
        {"toolName": body.toolName, "preview": preview}, request=request
    )
