"""agent 配置面路由 — /api/agent/* (Phase -1 / 0A capability & context foundation).

Standing Context 文档（SOUL/AGENT/RULES/USER 可编辑 + MEMORY/SKILLS 投影）的读端点 +
版本历史。owner-only（本机用户的 agent 配置）→ ``Depends(verify_cf_access)``，**不**挂
Bearer（Bearer 是 ``/api/skills`` 的外部 agent 通道，agent 改自身配置不走 scoped key）。

写端点（set/rollback）+ Settings 编辑 UI + agent profile 工具在 PR6；本路由只读 + graceful。
"""


from __future__ import annotations

from fastapi import APIRouter

from src.agent_config.store import get_agent_config_store
from src.api.routers.agent_drafts import router as _drafts_router
from src.api.routers.agent_policy import (
    CHAT_APPROVAL_MODES,
    CHAT_AUTO_COMPACT_MODES,
    LABS_FLAG_VALUES,
    _derive_rule_context_mode,
)
from src.api.routers.agent_policy import router as _policy_router
from src.api.routers.agent_profile import ASSISTANT_NAME_MAX_CHARS
from src.api.routers.agent_profile import router as _profile_router
from src.api.routers.agent_skills import router as _skills_router

# Canonical matter web-face enums (parsed by tests/config/test_matter_web_face_parity.py).
MATTER_RUN_WEB_FACES: tuple[str, ...] = ("keep", "search_only", "off")
MATTER_RUN_WEB_FACE_DEFAULT = "keep"


def _custom_agents_enabled() -> bool:
    """Read ``MAILAGENT_CUSTOM_AGENTS_ENABLED`` dynamically so tests can patch on agent router."""
    from src.api.deps import get_settings

    try:
        return bool(get_settings().custom_agents_enabled)
    except Exception:  # noqa: BLE001 — config read failure fails closed
        return False


router = APIRouter(prefix="/api/agent", tags=["agent"])
router.include_router(_profile_router)
router.include_router(_drafts_router)
router.include_router(_skills_router)
router.include_router(_policy_router)

__all__ = [
    "router",
    "get_agent_config_store",
    "ASSISTANT_NAME_MAX_CHARS",
    "CHAT_APPROVAL_MODES",
    "CHAT_AUTO_COMPACT_MODES",
    "LABS_FLAG_VALUES",
    "MATTER_RUN_WEB_FACES",
    "MATTER_RUN_WEB_FACE_DEFAULT",
    "_custom_agents_enabled",
    "_derive_rule_context_mode",
]
