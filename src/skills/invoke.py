"""Skill invoke 核心 —— scope + confirmation gate → dispatch handler。

REST(``/api/skills/invoke``) 与 MCP in-process client 共用本入口（单一执行真源）。错误
一律 ``SkillError``（transport-neutral）；caller 负责转 envelope / JSON-RPC error。
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any, Optional

from src.skills import rate_limit
from src.skills.context import SkillContext
from src.skills.errors import SkillError
from src.skills.registry import find_tool


def _skill_enabled_override(skill_name: str) -> Optional[bool]:
    """agent_config.db 里该 skill 的启用覆盖（``None``=无覆盖 / store 不可达）。

    best-effort（镜像 registry._load_installed_skills 的降级纪律）：store 不可达时返 None，
    交由 ``resolve_enabled`` 回退 skill 的 default_enabled —— 对 notion_agent（default off）即
    fail-closed 拒直调，安全地板正确一侧。
    """
    try:
        from src.agent_config.store import get_agent_config_store

        for row in get_agent_config_store().list_skills():
            if row.skill_name == skill_name:
                return row.enabled
    except Exception:  # noqa: BLE001 — store 不可达 → 无覆盖（回退 default）
        return None
    return None


def _validate_input(input_schema: dict[str, Any], params: dict[str, Any]) -> None:
    """轻量校验：required 字段必须在场（不引 jsonschema 运行时依赖）。"""
    required = input_schema.get("required") or []
    missing = [k for k in required if k not in params or params[k] is None]
    if missing:
        raise SkillError(
            "E_INVALID_ARG",
            f"missing required field(s): {missing}",
            http_status=400,
        )


async def invoke_skill(
    principal: Any,
    skill_name: str,
    tool_name: str,
    params: Optional[dict[str, Any]] = None,
    *,
    confirm: bool = False,
    ctx: Optional[SkillContext] = None,
) -> dict[str, Any]:
    """执行一个 skill tool。

    顺序：找 tool → scope gate（403）→ enabled gate（仅 notion_agent，disabled → 409）→
    confirmation gate（edit 层必须 confirm，403）→ 输入校验（400）→ 配额判定（声明了
    rate_limit 的 tool，429）→ dispatch（blocking 走 to_thread；coroutine 自动 await）→
    **成功后**记一次配额。
    """
    params = params or {}
    found = find_tool(skill_name, tool_name)
    if found is None:
        raise SkillError(
            "E_NOT_FOUND",
            f"unknown skill/tool: {skill_name}.{tool_name}",
            http_status=404,
            hint="GET /api/skills to list available tools",
        )
    _skill, tool = found
    tdef = tool.definition

    # scope gate（read-only key 调 write/execute tool → 403；先于 confirmation）。
    if not _principal_has_scopes(principal, tdef.auth_scopes):
        raise SkillError(
            "E_AUTH_FAILED",
            f"tool {skill_name}.{tool_name} requires scope(s): {tdef.auth_scopes}",
            http_status=403,
            hint="this API key is not authorized for that scope",
        )

    # 07-21 (codex HIGH-2 ④) — enabled gate，**仅对 notion_agent**：直调面须尊重 Settings→Custom
    # AI→Skills 的启用开关，否则一个持 notion_agent:invoke scope 的外部 key 能在 owner 关掉该
    # skill 后仍直调这个外呼第三方 AI、副作用落 Notion 侧不可撤回的工具（gateway 侧靠
    # advertisedSkills 门控，直调面此前无门）。**有意只判 notion_agent**：把 enabled 闸推广到全部
    # skill 会把「Skills 开关」耦合进对外 Skill Delivery API，破坏其它 default-on skill
    # （email/search/report/calendar）的既有外部消费面（owner 关某 skill = 外部 key 也调不动）——
    # 残余面：那些 skill 的直调仍不受启用开关约束（对外契约不变，需显式授予其 scope 方可达）。
    # store 不可达 → resolve_enabled(None, default_enabled=False) = False = fail-closed 拒。
    if skill_name == "notion_agent":
        from src.agent_config.store import resolve_enabled

        if not resolve_enabled(_skill_enabled_override(skill_name), _skill.default_enabled):
            raise SkillError(
                "E_SKILL_DISABLED",
                f"skill {skill_name} is disabled (enable it in Settings → Custom AI → Skills)",
                http_status=409,
                hint="the notion_agent skill must be enabled before it can be invoked",
            )

    # confirmation gate：edit 层（发信/草稿等）必须显式布尔 True（永远 edit confirmation）。
    # 🔴 用 `is not True`（严格身份），**绝不** truthiness：否则 confirm="false" / "no" / 1
    # 等真值字符串/数字会击穿确认闸（codex review blocker）。本层是 REST + MCP 共用的唯一
    # chokepoint，严格判定在此一处把死。
    if tdef.confirmation_tier == "edit" and confirm is not True:
        raise SkillError(
            "E_AUTH_FAILED",
            f"tool {skill_name}.{tool_name} is confirmation_tier=edit; "
            "caller must pass confirm=true (JSON boolean)",
            http_status=403,
            hint="send/draft tools always require an explicit boolean true confirmation",
        )

    _validate_input(tdef.input_schema, params)

    # 配额闸（只对显式声明 rate_limit 的 tool 生效，当前 = email_draft）：这里只**判定**
    # 额度够不够，计数放到 handler 成功返回之后 —— _validate_input 只查 required，形状错
    # （如 mode='bogus'）或 service 连不上等**没有副作用**的调用，都不该吃掉草稿额度。
    rate_limit.check(principal, skill_name, tool_name, tdef.rate_limit)

    if ctx is None:
        ctx = SkillContext()
    # 把本次 confirm 透传给 handler（发信/草稿 handler 据此让 service 二次校验，防御纵深）。
    # 归一成严格布尔，下游 handler 看到的恒是 True/False。
    ctx.confirm = confirm is True

    if tool.blocking:
        # 同步阻塞 handler（如 report_run 跑 LLM）：放线程池，别堵 event loop。
        result = await asyncio.to_thread(tool.handler, ctx, params)
    else:
        result = tool.handler(ctx, params)
        if inspect.isawaitable(result):
            result = await result

    # 副作用已经发生（草稿已 APPEND）→ 此刻计数。返回值形状不对（下面的 E_INTERNAL）也照记，
    # 因为写已经落地了。
    rate_limit.record(principal, skill_name, tool_name, tdef.rate_limit)

    if not isinstance(result, dict):
        raise SkillError(
            "E_INTERNAL",
            f"tool {skill_name}.{tool_name} returned non-dict result",
            http_status=500,
        )
    return result


def _principal_has_scopes(principal: Any, scopes: list[str]) -> bool:
    if principal is None:
        return True  # 无鉴权上下文（仅内部/导出场景）
    return principal.has_scopes(scopes)
