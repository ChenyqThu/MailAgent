"""skills 路由 —— /api/skills (manifest) + /api/skills/invoke (统一调用面)。

对外 agent（OpenClaw / Claude Code / MCP client）经 scoped Bearer key 调 MailAgent 能力的
唯一表面。鉴权用 ``authenticate_principal``（四腿 dev→local→bearer→CF）；**只有本路由认
Bearer key** —— 其余写端点对 agent key 天然 401，越权 by construction 不可达。

invoke 主路径 **无 run_cli**（BASE-1）：``invoke_skill`` 走 ``src/skills`` registry →
handler 调 services / repository / ReportStore / run_report_once / notion_agent。
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Depends, Request

from src.api.agent_auth import Principal, authenticate_principal
from src.api.app import APIError, success_envelope
from src.api.deps import get_report_store, get_repository, get_settings
from src.security import api_keys as _api_keys
from src.skills.context import SkillContext
from src.skills.errors import SkillError
from src.skills.invoke import invoke_skill
from src.skills.registry import build_manifest

if TYPE_CHECKING:
    from src.config import Config
    from src.reports.store import ReportStore
    from src.repository import EmailRepository

router = APIRouter(prefix="/api/skills", tags=["skills"])
_log = logging.getLogger("mailagent.api.skills")


def _audit(
    principal: Principal,
    *,
    skill: Optional[str],
    tool: Optional[str],
    status: str,
    error_code: Optional[str],
    t0: float,
) -> None:
    """agent principal 调用记一行 audit + last_used（human owner 不记）。失败吞掉不阻断响应。"""
    if not getattr(principal, "is_agent", False) or not principal.key_id:
        return
    try:
        _api_keys.get_api_key_store().write_audit(
            route="/api/skills/invoke",
            status=status,
            key_id=principal.key_id,
            skill=skill,
            tool=tool,
            scopes=sorted(principal.scopes or set()),
            error_code=error_code,
            duration_ms=int((time.perf_counter() - t0) * 1000),
        )
    except Exception:  # noqa: BLE001 — audit best-effort，不能因审计失败而吞掉调用结果
        _log.warning("agent api-key audit write failed (key_id=%s, tool=%s.%s)", principal.key_id, skill, tool)


@router.get("", dependencies=[])
async def list_skills(
    request: Request,
    principal: Principal = Depends(authenticate_principal),
):
    """返回当前 principal 可见的 Skill manifest v1（按 scopes 过滤 tool）。"""
    manifest = build_manifest(principal)
    return success_envelope(
        manifest.model_dump(),
        request=request,
        source="sqlite",
        meta_extra={"skills": len(manifest.skills)},
    )


@router.post("/invoke")
async def invoke(
    request: Request,
    body: Optional[dict[str, Any]] = None,
    principal: Principal = Depends(authenticate_principal),
    repo: "EmailRepository" = Depends(get_repository),
    report_store: "ReportStore" = Depends(get_report_store),
    cfg: "Config" = Depends(get_settings),
):
    """调用一个 skill tool。body = {skill, tool, input?, confirm?}。返回统一 envelope。

    SkillContext 经 FastAPI deps 注入（repo/store/config）—— 测试可经 dependency_overrides
    指向临时 DB，与既有 email/reports 路由一致。
    """
    raw = body or {}
    skill = raw.get("skill")
    tool = raw.get("tool")
    params = raw.get("input") or {}
    confirm = bool(raw.get("confirm", False))
    if not isinstance(skill, str) or not isinstance(tool, str):
        raise APIError("E_INVALID_ARG", "body.skill and body.tool are required strings", source="cli")
    if not isinstance(params, dict):
        raise APIError("E_INVALID_ARG", "body.input must be an object", source="cli")

    ctx = SkillContext(repository=repo, report_store=report_store, config=cfg)
    t0 = time.perf_counter()
    try:
        result = await invoke_skill(principal, skill, tool, params, confirm=confirm, ctx=ctx)
    except SkillError as exc:
        _audit(principal, skill=skill, tool=tool, status="error", error_code=exc.code, t0=t0)
        raise APIError(
            exc.code, exc.message, hint=exc.hint, http_status=exc.http_status, source="cli"
        ) from exc

    _audit(principal, skill=skill, tool=tool, status="ok", error_code=None, t0=t0)
    return success_envelope(
        result, request=request, source="cli", meta_extra={"skill": skill, "tool": tool}
    )
