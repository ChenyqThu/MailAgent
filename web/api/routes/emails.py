"""邮件列表 + 详情 API。"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from web.api.deps import verify_token
from web.api.models.common import PagedResponse
from web.api.models.email import EmailDetail, EmailFilter, EmailListItem
from web.api.services import email_service

router = APIRouter(prefix="/emails", tags=["邮件"])


@router.get("", response_model=PagedResponse[EmailListItem])
async def list_emails(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    view: Optional[str] = None,
    mailbox: Optional[str] = None,
    priority: Optional[str] = None,
    action_type: Optional[str] = None,
    category: Optional[str] = None,
    is_flagged: Optional[bool] = None,
    pending_only: bool = True,
    search: Optional[str] = None,
    _token: str = Depends(verify_token),
):
    """获取邮件列表（智能排序）。"""
    filter = EmailFilter(
        view=view,
        mailbox=mailbox,
        priority=priority,
        action_type=action_type,
        category=category,
        is_flagged=is_flagged,
        pending_only=pending_only,
        search=search,
    )
    items, total = email_service.list_emails(filter, page, page_size)
    return PagedResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        has_more=(page * page_size) < total,
    )


@router.get("/view-counts")
async def view_counts(
    _token: str = Depends(verify_token),
):
    """各视图邮件数量（供 tab badge 用）。"""
    return email_service.get_view_counts()


@router.get("/thread/{thread_id}", response_model=list[EmailListItem])
async def get_thread_emails(
    thread_id: str,
    _token: str = Depends(verify_token),
):
    """获取同一线程内所有邮件（按时间正序）。"""
    return email_service.get_thread_emails(thread_id)


@router.get("/{internal_id}", response_model=EmailDetail)
async def get_email(
    internal_id: int,
    _token: str = Depends(verify_token),
):
    """获取邮件详情。"""
    detail = email_service.get_email_detail(internal_id)
    if not detail:
        raise HTTPException(status_code=404, detail="邮件不存在")
    return detail


@router.get("/{internal_id}/body")
async def get_email_body(
    internal_id: int,
    _token: str = Depends(verify_token),
):
    """从 Notion 实时获取邮件正文。"""
    from web.api.services import notion_service

    detail = email_service.get_email_detail(internal_id)
    if not detail:
        raise HTTPException(status_code=404, detail="邮件不存在")
    if not detail.notion_page_id:
        raise HTTPException(status_code=404, detail="该邮件未同步到 Notion")

    body = await notion_service.get_page_body(detail.notion_page_id)
    return {"internal_id": internal_id, "body": body}
