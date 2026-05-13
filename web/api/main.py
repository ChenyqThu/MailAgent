"""MailAgent Web 工作台 — FastAPI 入口。

启动: uvicorn web.api.main:app --port 8200
PM2:  pm2 start web/ecosystem.config.js
"""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from pathlib import Path

# 确保项目根目录在 sys.path
ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from web.api.config import web_config
from web.api.routes import api_router
from web.api.services.db import ensure_web_columns
from web.api.services.redis_service import close_redis


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        f"[web-api] 启动 port={web_config.web_api_port} "
        f"db={web_config.sync_store_db_path}"
    )
    ensure_web_columns()
    yield
    await close_redis()
    logger.info("[web-api] 关闭")


app = FastAPI(
    title="MailAgent Web 工作台",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS（Tailscale 内网 + 本地开发）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Health（在 StaticFiles 之前注册）
@app.get("/api/health")
async def health():
    return {"status": "ok", "port": web_config.web_api_port}


# API 路由
app.include_router(api_router)

# 静态文件 + SPA fallback
frontend_dist = ROOT / "web" / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=str(frontend_dist / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(request: Request, full_path: str):
        """SPA fallback: 非 API/assets 路径都返回 index.html。"""
        file_path = frontend_dist / full_path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(frontend_dist / "index.html")
