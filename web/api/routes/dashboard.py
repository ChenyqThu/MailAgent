"""Dashboard API。"""

from typing import Optional

from fastapi import APIRouter, Depends, Query

from web.api.deps import verify_token
from web.api.services import dashboard_service

router = APIRouter(prefix="/dashboard", tags=["看板"], dependencies=[Depends(verify_token)])


@router.get("/stats")
async def stats(range: Optional[str] = Query(None)):
    return dashboard_service.get_overview_stats(range)


@router.get("/attention")
async def attention(range: Optional[str] = Query(None)):
    return dashboard_service.get_attention_emails(range)


@router.get("/digest")
async def digest(range: Optional[str] = Query(None)):
    return dashboard_service.get_digest(range)


@router.get("/system")
async def system():
    return dashboard_service.get_system_status()


@router.get("/trend")
async def trend(range: Optional[str] = Query(None)):
    return dashboard_service.get_trend(range)
