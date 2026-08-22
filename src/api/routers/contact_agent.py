"""通讯录治理 Agent 内部提案端点（仅本地 token，不接受 CF JWT）。"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Request

from src.api.app import success_envelope
from src.api.auth import verify_local_token
from src.api.routers.contacts import (
    _call,
    get_contact_repository,
)
from src.api.schemas.contacts import ContactGovernanceProposalRequest
from src.contacts.governance import create_suggestion, notify_pending_suggestion
from src.contacts.repository import ContactRepository

router = APIRouter(
    prefix="/api/contacts/agent",
    tags=["contact-agent"],
    dependencies=[Depends(verify_local_token)],
)


@router.post("/proposals")
async def propose_contact_governance(
    body: ContactGovernanceProposalRequest,
    request: Request,
    repo: ContactRepository = Depends(get_contact_repository),
):
    with repo.transaction() as conn:
        result = _call(
            create_suggestion,
            conn,
            suggestion_type=body.type,
            contact_ids=body.contact_ids,
            payload=body.payload,
            evidence=[item.model_dump() for item in body.evidence],
            confidence=body.confidence,
            now_ms=int(time.time() * 1000),
        )
    # 通知中心: 必须在 with 块 commit 之后调用 —— repo.transaction() 是
    # BEGIN IMMEDIATE 立即持写锁, 块内调用 NotifyCenter (独立连接自己的
    # BEGIN IMMEDIATE) 会与这把锁循环等待死锁 (governance.create_suggestion 头注)。
    if result.get("created"):
        notify_pending_suggestion(repo.db_path)
    return success_envelope(result, request=request, source="contact-agent")
