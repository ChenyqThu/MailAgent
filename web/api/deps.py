"""FastAPI 依赖注入：认证、DB 等。"""

from __future__ import annotations

from fastapi import Header, HTTPException

from web.api.config import web_config


async def verify_token(authorization: str = Header(default="")) -> str:
    """Bearer token 认证。token 为空时跳过认证（开发模式）。"""
    expected = web_config.web_api_token
    if not expected:
        return "dev"

    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少认证 token")

    token = authorization[7:]
    if token != expected:
        raise HTTPException(status_code=401, detail="token 无效")

    return token
