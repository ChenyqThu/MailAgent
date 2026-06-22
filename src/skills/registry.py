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
    # R1 (GPT-5.5 review, HIGH) — whether this skill may be advertised to EXTERNAL
    # scoped agent principals (Bearer keys) via /api/skills + MCP. builtin skills are
    # product-shipped → exposed. User-INSTALLED skills (document-only / existing-tool /
    # mcp) carry private prompt_fragment guidance + are owner-runtime oriented in the
    # MVP, so they are owner-only (build_manifest hides them from is_agent principals).
    external_exposed: bool = True


def _server_version() -> str:
    try:
        return importlib.metadata.version("mailagent")
    except importlib.metadata.PackageNotFoundError:
        return "3.0.0"


@lru_cache(maxsize=1)
def code_builtin_skills() -> tuple[BoundSkill, ...]:
    """代码内置 builtin skills（进程内缓存 —— 不随运行时变化）。新增 builtin 在此登记 builder。"""
    from src.skills.builtin import calendar, email, notion_agent, report, search

    return (
        email.build_skill(),
        search.build_skill(),
        report.build_skill(),
        calendar.build_skill(),
        notion_agent.build_skill(),
    )


def _load_installed_skills(builtins: tuple[BoundSkill, ...]) -> list[BoundSkill]:
    """从 agent_config.db 读安装行 → BoundSkill（PR3 merge）。

    **不缓存合并结果**（Plan review §7.1：lru_cache 在多 worker 下会陈旧 —— 一个 worker 装的
    skill 别的 worker 看不到直到重启）。按 ``api_keys`` 的 per-call 短连接纪律，每次重查使
    install/uninstall 即时可见。best-effort：agent_config 不可达 → []（退化为纯 builtin，never
    崩 /api/skills）。过滤 builtin 懒行（只承载 enable 覆盖）+ 与 builtin 同名的安装行（builtin
    胜出，installed 不得 shadow）。
    """
    try:
        from src.agent_config.store import get_agent_config_store

        rows = get_agent_config_store().list_skills()
    except Exception:  # noqa: BLE001 — agent_config 不可达 → 纯 builtin（never 崩 manifest）
        return []
    from src.skills.installed import build_builtin_tool_index, installed_skill_to_bound

    idx = build_builtin_tool_index(builtins)
    seen = {s.name for s in builtins}
    out: list[BoundSkill] = []
    for row in rows:
        if row.source_type == "builtin":
            continue  # 懒 enable-覆盖行，不是 skill 定义（manifest 来自代码）
        if row.skill_name in seen:
            continue  # 与 builtin / 已加载 installed 同名 → 跳过（builtin 胜出）
        bound = installed_skill_to_bound(row, idx)
        if bound is None or bound.name in seen:
            continue
        out.append(bound)
        seen.add(bound.name)
    return out


def all_skills() -> tuple[BoundSkill, ...]:
    """code builtin + installed（agent_config.db）的合并视图。

    **不缓存** installed 部分 —— 每次重查使 install/uninstall 即时可见，且多 worker 无陈旧
    （Plan review §7.1）。code builtin 部分仍缓存（运行时不变）。``build_manifest`` / ``find_tool``
    经此拿到完整 skill 集，installed skill 自动流向 ``/api/skills`` + MCP（无需改那两层）。
    """
    builtins = code_builtin_skills()
    return builtins + tuple(_load_installed_skills(builtins))


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
        # R1 (GPT-5.5 review, HIGH) — hide owner-only (user-installed) skills from
        # EXTERNAL scoped agent principals (Bearer keys), so their private prompt
        # fragments / docs never leak through /api/skills + MCP. The owner paths are
        # unaffected: principal=None (internal build_manifest(None) — chat_config /
        # projections) and the local/CF human principal (is_agent=False, the desktop
        # harness's own /api/skills fetch) both still see installed skills, so the
        # Custom AI runtime keeps getting their skillFragments (PR3 behaviour intact).
        if (
            principal is not None
            and getattr(principal, "is_agent", False)
            and not skill.external_exposed
        ):
            continue
        visible = [
            t.definition
            for t in skill.tools
            if _principal_allows(principal, t.definition.auth_scopes)
        ]
        # PR3 — keep legitimately tool-less skills (document-only installed skills):
        # only hide a skill whose tools were ALL scope-filtered out (had tools, none
        # visible to this principal). A zero-tool skill stays so its prompt_fragment /
        # docs reach the manifest consumer (else build_manifest silently drops it,
        # losing the document-only skill's fragment from the harness skillFragments).
        if skill.tools and not visible:
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
    """test-only：清 code builtin 缓存（installed 部分不缓存，无需清）。"""
    code_builtin_skills.cache_clear()
