"""统计 API。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from web.api.deps import verify_token
from web.api.services import email_service

router = APIRouter(prefix="/stats", tags=["统计"])


@router.get("")
async def get_stats(_token: str = Depends(verify_token)):
    """获取同步 + LLM 处理统计。"""
    return email_service.get_stats()
