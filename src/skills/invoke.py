"""Skill invoke 核心 —— scope + confirmation gate → dispatch handler。

REST(``/api/skills/invoke``) 与 MCP in-process client 共用本入口（单一执行真源）。错误
一律 ``SkillError``（transport-neutral）；caller 负责转 envelope / JSON-RPC error。
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any, Optional

from src.skills.context import SkillContext
from src.skills.errors import SkillError
from src.skills.registry import find_tool


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

    顺序：找 tool → scope gate（403）→ confirmation gate（edit 层必须 confirm，403）→
    输入校验（400）→ dispatch（blocking 走 to_thread；coroutine 自动 await）。
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
