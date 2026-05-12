"""路由注册。"""

from fastapi import APIRouter

from .actions import router as actions_router
from .agent import router as agent_router
from .dashboard import router as dashboard_router
from .emails import router as emails_router
from .events import router as events_router
from .stats import router as stats_router

api_router = APIRouter(prefix="/api")
api_router.include_router(emails_router)
api_router.include_router(stats_router)
api_router.include_router(events_router)
api_router.include_router(actions_router)
api_router.include_router(agent_router)
api_router.include_router(dashboard_router)
