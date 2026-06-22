"""Installed skill 投影 —— agent_config.db 安装行 → BoundSkill，merge 进 registry（PR3）.

MVP 三类（plan §B + Plan review §4）：

  - **document-only**（source_type='document'）：tools=[]，只供 ``prompt_fragment`` + SKILL.md。
  - **existing-tool**（local_folder/skill_pack，manifest tool 带 ``"bind": "existing"``）：复用
    既有 builtin 工具的 BoundTool（handler + 定义），**仅限 side_effect='read'**（写工具别名
    推迟，避免「装个 skill 别名给 send-email 配个诱导 prompt」的提权），且该工具 scopes ⊆ 安装时
    授予的 ``granted_scopes``。
  - **mcp-bound**（source_type='mcp'）：schema-only —— 投影声明的 ToolDef（展示 schema）但
    ``mcp_exposed=False`` + handler 抛 E_NOT_IMPLEMENTED + skill ``availability.available=false``。
    真实外部 connector 调用 + auth 模型推迟到后续 phase。

安全：installed skill 只能请求既有 KNOWN_SCOPES（install 时 store 已校验）；任意代码型 plugin
禁止（无 handler 注入路径）。投影失败的工具被跳过（记到返回的 skipped），不静默产出坏工具。
"""

from __future__ import annotations

from typing import Any, Optional

from src.skills.errors import SkillError
from src.skills.models import SkillAvailability, ToolDef, ToolHandler
from src.skills.registry import BoundSkill, BoundTool

MCP_UNAVAILABLE_REASON = "MCP connector not configured (invocation deferred to a later phase)"


def build_builtin_tool_index(
    builtins: tuple[BoundSkill, ...],
) -> dict[str, tuple[BoundSkill, BoundTool]]:
    """existing-tool 绑定索引：tool name → (拥有它的 builtin skill, BoundTool)。首个登记者胜出。"""
    idx: dict[str, tuple[BoundSkill, BoundTool]] = {}
    for skill in builtins:
        for tool in skill.tools:
            idx.setdefault(tool.definition.name, (skill, tool))
    return idx


def _mcp_unavailable_handler(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    raise SkillError("E_NOT_IMPLEMENTED", MCP_UNAVAILABLE_REASON, http_status=400)


def _bind_existing_tool(
    entry: dict[str, Any],
    builtin_index: dict[str, tuple[BoundSkill, BoundTool]],
    granted_scopes: tuple[str, ...],
) -> Optional[BoundTool]:
    """把一个 existing-tool 引用绑到既有 builtin BoundTool（复用 handler + 定义）。

    拒绝（返回 None）：引用了未知 builtin 工具 / 非 read 工具（写别名推迟）/ 工具 scopes ⊄ granted。
    """
    name = entry.get("name")
    if not isinstance(name, str):
        return None
    found = builtin_index.get(name)
    if found is None:
        return None  # 引用了不存在的 builtin 工具
    _owner, btool = found
    bdef = btool.definition
    if bdef.side_effect != "read":
        return None  # MVP：existing-tool 只绑只读工具（写别名推迟）
    if not set(bdef.auth_scopes) <= set(granted_scopes):
        return None  # 工具要求的 scope 超出安装授权
    return btool  # 复用既有 BoundTool（同 handler，同 ToolDef）


def _tool_def_from_dict(entry: dict[str, Any]) -> ToolDef:
    """mcp-bound 声明工具 → ToolDef（schema-only：mcp_exposed 强制 False，handler=占位）。

    pydantic 校验 confirmation_tier/side_effect 合法值；缺省字段给安全默认。
    """
    return ToolDef(
        name=entry["name"],
        description=entry.get("description", ""),
        input_schema=entry.get("input_schema") or {"type": "object"},
        output_schema=entry.get("output_schema") or {"type": "object"},
        confirmation_tier=entry.get("confirmation_tier", "none"),
        side_effect=entry.get("side_effect", "external_call"),
        auth_scopes=list(entry.get("auth_scopes") or []),
        # schema-only：永不经 MCP 暴露（未实现调用），handler 占位 target 仅展示。
        mcp_exposed=False,
        handler=ToolHandler(kind="api", target=f"mcp:{entry.get('connector', 'unknown')}"),
    )


def installed_skill_to_bound(
    row: Any,
    builtin_index: dict[str, tuple[BoundSkill, BoundTool]],
) -> Optional[BoundSkill]:
    """一个 agent_skills 安装行 → BoundSkill。损坏/无 manifest → None（跳过，不崩 registry）。

    ``row`` = AgentConfigStore.SkillRow（source_type ∈ INSTALLABLE_SOURCE_TYPES；builtin 懒行
    不应进这里，由 caller 过滤）。
    """
    manifest = getattr(row, "manifest", None)
    if not isinstance(manifest, dict):
        return None
    name = manifest.get("name") or row.skill_name
    granted = tuple(getattr(row, "granted_scopes", ()) or ())

    tools_out: list[BoundTool] = []
    if row.source_type == "mcp":
        availability = SkillAvailability(available=False, reason=MCP_UNAVAILABLE_REASON)
        for entry in manifest.get("tools") or []:
            if not isinstance(entry, dict) or "name" not in entry:
                continue
            try:
                tdef = _tool_def_from_dict(entry)
            except Exception:  # noqa: BLE001 — 坏工具定义跳过，不崩整个 registry
                continue
            tools_out.append(BoundTool(tdef, _mcp_unavailable_handler))
    else:
        # document-only（tools 空）/ existing-tool（tools 带 bind='existing'）。
        availability = SkillAvailability(available=True, reason=None)
        for entry in manifest.get("tools") or []:
            if not isinstance(entry, dict):
                continue
            bound = _bind_existing_tool(entry, builtin_index, granted)
            if bound is not None:
                tools_out.append(bound)
            # 绑定失败（未知/非 read/越权）→ 跳过该工具（skill 仍以剩余工具 + fragment 存在）。

    return BoundSkill(
        name=name,
        version=str(manifest.get("version") or getattr(row, "version", None) or "0.0.0"),
        title=manifest.get("title") or name,
        description=manifest.get("description") or "",
        default_enabled=bool(manifest.get("default_enabled", False)),
        prompt_fragment=manifest.get("prompt_fragment") or "",
        docs_path=manifest.get("docs_path") or "",
        tools=tools_out,
        availability=availability,
        # R1 (GPT-5.5 review, HIGH) — user-installed skills are owner-only: their
        # private prompt_fragment must not leak to external scoped Bearer agents via
        # /api/skills + MCP. build_manifest hides external_exposed=False skills from
        # is_agent principals; the owner runtime (principal=None / local human) keeps
        # seeing them. Exposing an installed skill externally is a future feature
        # (explicit visibility scopes), not an MVP default.
        external_exposed=False,
    )
