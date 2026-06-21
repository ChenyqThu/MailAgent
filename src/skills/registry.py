"""Skill registry —— 把 builtin skills 的 (ToolDef + 可调用 handler) 收成单一真源。

manifest 序列化时只出 ``ToolDef``（不含 callable）。``build_manifest(principal)`` 按 principal
的 scopes 过滤可见 tool（agent 只看到自己 scope 内的 tool，降低误用；owner 看全部）。
"""

from __future__ import annotations

import importlib.metadata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Optional, Union

from src.skills.models import (
    SkillAvailability,
    SkillDef,
    SkillManifest,
    ToolDef,
)

if TYPE_CHECKING:
    from src.skills.context import SkillContext

# handler 签名：(ctx, params) -> dict | awaitable[dict]
HandlerFn = Callable[["SkillContext", dict[str, Any]], Union[dict[str, Any], Awaitable[dict[str, Any]]]]


@dataclass
class BoundTool:
    """ToolDef + 实际 callable handler（+ 可用性元数据）。"""

    definition: ToolDef
    handler: HandlerFn
    blocking: bool = False  # True → invoke 用 asyncio.to_thread 跑（同步阻塞，如 LLM）


@dataclass
class BoundSkill:
    name: str
    version: str
    title: str
    description: str
    default_enabled: bool
    prompt_fragment: str
    docs_path: str
    tools: list[BoundTool]
    availability: SkillAvailability = field(
        default_factory=lambda: SkillAvailability(available=True, reason=None)
    )


def _server_version() -> str:
    try:
        return importlib.metadata.version("mailagent")
    except importlib.metadata.PackageNotFoundError:
        return "3.0.0"


@lru_cache(maxsize=1)
def all_skills() -> tuple[BoundSkill, ...]:
    """收集全部 builtin skills（进程内缓存）。新增 skill 在此登记 builder。"""
    from src.skills.builtin import calendar, email, notion_agent, report, search

    return (
        email.build_skill(),
        search.build_skill(),
        report.build_skill(),
        calendar.build_skill(),
        notion_agent.build_skill(),
    )


def find_tool(skill_name: str, tool_name: str) -> Optional[tuple[BoundSkill, BoundTool]]:
    for skill in all_skills():
        if skill.name != skill_name:
            continue
        for tool in skill.tools:
            if tool.definition.name == tool_name:
                return skill, tool
        return None  # skill 命中但 tool 不存在
    return None


def _principal_allows(principal: Any, scopes: list[str]) -> bool:
    """principal=None（无鉴权上下文，如 pack 导出）→ 全可见；否则 principal.has_scopes。"""
    if principal is None:
        return True
    return principal.has_scopes(scopes)


def build_manifest(principal: Any = None, *, generated_at: Optional[str] = None) -> SkillManifest:
    """组装 manifest v1。按 principal scopes 过滤可见 tool；无可见 tool 的 skill 整体省略。

    ``generated_at`` 可注入（测试用固定值 → snapshot 稳定）；默认 = 当前 UTC ISO。
    """
    stamp = generated_at or datetime.now(timezone.utc).isoformat()
    skills_out: list[SkillDef] = []
    for skill in all_skills():
        visible = [
            t.definition
            for t in skill.tools
            if _principal_allows(principal, t.definition.auth_scopes)
        ]
        if not visible:
            continue
        skills_out.append(
            SkillDef(
                name=skill.name,
                version=skill.version,
                title=skill.title,
                description=skill.description,
                default_enabled=skill.default_enabled,
                availability=skill.availability,
                prompt_fragment=skill.prompt_fragment,
                docs_path=skill.docs_path,
                tools=visible,
            )
        )
    return SkillManifest(
        generated_at=stamp,
        server_version=_server_version(),
        capabilities={"invoke": True, "mcp": True, "manifest_version": "1.0"},
        skills=skills_out,
    )


def reset_registry_cache() -> None:
    """test-only：清 skill 缓存。"""
    all_skills.cache_clear()
