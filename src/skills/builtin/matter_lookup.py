"""matter_lookup skill —— 事项只读（找事项 / 读一个事项 / 列告警信号）。

skill 名不叫 ``matters``：那个名字已是零工具的方法论 skill（``builtin/matters.py``，prompt 片段 +
SKILL.md 都写明「不解锁任何工具」），不往里挂工具。

取数走 ``src/matters/service.py::MatterService`` 与 ``src/matters/attention.py::AttentionService``
（只持 db_path，每次新建无状态问题）。

**返回字段对照 gateway 同名工具**（``frontend/src/ai-gateway/tools/matters.ts``）：
  - ``matter_find`` 与 gateway 同一份 12 字段摘要。
  - ``matter_attention_list`` 与 gateway 同形（``count`` / ``truncated`` / ``items``）。
  - ``matter_get``：gateway 原样透传服务端返回；对外更严 —— ``matter`` 走白名单，去掉跟进 agent
    的配置与指令（``matter_instructions`` / ``schedule_json`` / ``agent_profile_id`` /
    ``agent_enabled``）和操作者 / 内部关联列；``include`` 不开放 ``followup``（那就是跟进配置本身）；
    ``timeline`` 去掉 ``agent_binding_changed`` 事件（payload 带跟进指令的前后值）；
    每个子列表封顶 ``_SUBLIST_CAP`` 条并在 ``truncated`` 里标出被裁的。
"""

from __future__ import annotations

from typing import Any

from src.matters.events import AGENT_BINDING_CHANGED
from src.skills.builtin._common import cap_list, domain_error, enum_arg, int_arg, str_arg
from src.skills.errors import SkillError
from src.skills.models import ToolDef, ToolHandler
from src.skills.registry import BoundSkill, BoundTool

_FIND_LIMIT_MAX = 50  # == gateway matterFindSchema.limit.max
_ATTENTION_LIMIT_MAX = 100  # == gateway matterAttentionListSchema.limit.max
_SUBLIST_CAP = 50
_TEXT_MAX_CHARS = 500
_PUBLIC_ID_MAX_CHARS = 64
# 对外开放的 include（= MatterService.get_matter 的分支名去掉 followup）。顺序即文档顺序。
_INCLUDES = ("items", "resources", "stakeholders", "timeline", "relations", "updates", "progress")
_DEFAULT_INCLUDES = ("items", "stakeholders")
_MATTER_FIELDS = (
    "public_id", "title", "background", "goal", "matter_type", "tags", "goal_checks",
    "status", "health", "priority", "source", "due_at", "waiting_context",
    "next_attention_at", "attention_reason", "last_activity_at", "current_summary",
    "summary_at", "version", "archived_at", "deleted_at", "created_at", "updated_at",
)
_ATTENTION_FIELDS = (
    "id", "kind", "subject_key", "state", "severity", "why", "recurrence_no",
    "first_opened_at", "last_observed_at", "snoozed_until", "resolved_at", "dismissed_at",
    "cleared_at", "last_notified_at", "payload", "matter",
)


def _values(enum_cls: Any) -> tuple[str, ...]:
    return tuple(member.value for member in enum_cls)


def _repository(ctx: Any) -> Any:
    from src.matters.repository import MatterRepository

    return MatterRepository(ctx.config().sync_store_db_path)


def _bool_arg(params: dict[str, Any], key: str) -> Any:
    value = params.get(key)
    if value is not None and not isinstance(value, bool):
        raise SkillError("E_INVALID_ARG", f"{key} must be a boolean")
    return value


def _project_find_row(matter: dict[str, Any]) -> dict[str, Any]:
    return {
        "public_id": matter.get("public_id"),
        "title": matter.get("title"),
        "type": matter.get("matter_type"),
        "tags": matter.get("tags"),
        "status": matter.get("status"),
        "health": matter.get("health"),
        "priority": matter.get("priority"),
        "due_at": matter.get("due_at"),
        "current_summary": matter.get("current_summary"),
        "version": matter.get("version"),
        "matched_fields": matter.get("matched_fields"),
        "snippet": matter.get("snippet"),
    }


def _matter_find(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    limit = int_arg(params, "limit", default=20, lo=1, hi=_FIND_LIMIT_MAX)
    from src.matters.models import MatterHealth, MatterPriority, MatterStatus

    filters = {
        "q": str_arg(params, "q", max_len=_TEXT_MAX_CHARS),
        "status": enum_arg(params, "status", _values(MatterStatus), None),
        "health": enum_arg(params, "health", _values(MatterHealth), None),
        "priority": enum_arg(params, "priority", _values(MatterPriority), None),
        "type": str_arg(params, "type", max_len=128),
        "tag": str_arg(params, "tag", max_len=128),
        "view": str_arg(params, "view", max_len=64),
        "archived": _bool_arg(params, "archived"),
        "deleted": _bool_arg(params, "deleted"),
    }
    from src.matters.service import MatterError, MatterService

    try:
        result = MatterService(_repository(ctx)).list_matters(
            filters=filters, cursor=None, limit=limit, sort="updated_at"
        )
    except MatterError as exc:
        raise domain_error(exc) from exc
    items = result.get("items") or []
    return {"count": len(items), "items": [_project_find_row(m) for m in items]}


def _matter_get(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    public_id = str_arg(params, "public_id", max_len=_PUBLIC_ID_MAX_CHARS, required=True)
    raw_include = params.get("include")
    if raw_include is None:
        include = list(_DEFAULT_INCLUDES)
    else:
        if not isinstance(raw_include, list) or not all(isinstance(v, str) for v in raw_include):
            raise SkillError("E_INVALID_ARG", "include must be an array of strings")
        unknown = sorted(set(raw_include) - set(_INCLUDES))
        if unknown:
            raise SkillError("E_INVALID_ARG", f"unknown include value(s) {unknown}; allowed: {list(_INCLUDES)}")
        include = [v for v in _INCLUDES if v in raw_include]
    from src.matters.service import MatterError, MatterService

    try:
        detail = MatterService(_repository(ctx)).get_matter(public_id, include=include)
    except MatterError as exc:
        raise domain_error(exc) from exc
    matter = detail.get("matter") or {}
    out: dict[str, Any] = {"matter": {key: matter.get(key) for key in _MATTER_FIELDS}}
    truncated: dict[str, bool] = {}
    for key in include:
        rows = detail.get(key)
        if key == "timeline":
            # 改跟进配置落的事件 payload 带 matter_instructions 前后值，等于从时间线绕回跟进指令。
            rows = [e for e in rows or [] if e.get("kind") != AGENT_BINDING_CHANGED]
        out[key], truncated[key] = cap_list(rows, _SUBLIST_CAP)
    out["truncated"] = truncated
    return out


def _matter_attention_list(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    limit = int_arg(params, "limit", default=50, lo=1, hi=_ATTENTION_LIMIT_MAX)
    public_id = str_arg(params, "public_id", max_len=_PUBLIC_ID_MAX_CHARS)
    from src.matters.models import MATTER_ATTENTION_STATES

    state = enum_arg(params, "state", tuple(MATTER_ATTENTION_STATES), "open")
    from src.matters.attention import AttentionService
    from src.matters.service import MatterError

    try:
        rows = AttentionService(_repository(ctx)).list_attention(public_id=public_id, state=state)
    except MatterError as exc:
        raise domain_error(exc) from exc
    items, cut = cap_list(rows, limit)
    return {
        "count": len(items),
        "truncated": cut,
        "items": [{key: row.get(key) for key in _ATTENTION_FIELDS} for row in items],
    }


def build_skill() -> BoundSkill:
    from src.matters.models import (
        MATTER_ATTENTION_STATES,
        MatterHealth,
        MatterPriority,
        MatterStatus,
    )

    public_id_prop = {"type": "string", "maxLength": _PUBLIC_ID_MAX_CHARS, "description": "e.g. MAT-0001"}
    tools = [
        BoundTool(
            ToolDef(
                name="matter_find",
                title="Find Matters",
                description=(
                    "Find Matters (tracked pieces of work) by text and structured filters. Returns "
                    "compact summaries; use matter_get for detail."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "q": {"type": "string", "maxLength": _TEXT_MAX_CHARS},
                        "status": {"type": "string", "enum": list(_values(MatterStatus))},
                        "health": {"type": "string", "enum": list(_values(MatterHealth))},
                        "priority": {"type": "string", "enum": list(_values(MatterPriority))},
                        "type": {"type": "string", "maxLength": 128},
                        "tag": {"type": "string", "maxLength": 128},
                        "view": {"type": "string", "maxLength": 64},
                        "archived": {"type": "boolean"},
                        "deleted": {"type": "boolean"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": _FIND_LIMIT_MAX},
                    },
                },
                output_schema={"type": "object", "description": "{count, items}"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=["matters:read"],
                mcp_exposed=True,
                handler=ToolHandler(kind="service", target="MatterService.list_matters"),
            ),
            _matter_find,
        ),
        BoundTool(
            ToolDef(
                name="matter_get",
                title="Get Matter",
                description=(
                    "Read one Matter plus a bounded subset of its items, resources, stakeholders, "
                    "timeline, relations, updates (pending proposals) and progress. Each sub-list "
                    f"is capped at {_SUBLIST_CAP}; truncated says which were cut."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "public_id": public_id_prop,
                        "include": {
                            "type": "array",
                            "items": {"type": "string", "enum": list(_INCLUDES)},
                            "description": "defaults to [items, stakeholders]",
                        },
                    },
                    "required": ["public_id"],
                },
                output_schema={"type": "object", "description": "{matter, <include...>, truncated}"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=["matters:read"],
                mcp_exposed=True,
                handler=ToolHandler(kind="service", target="MatterService.get_matter"),
            ),
            _matter_get,
        ),
        BoundTool(
            ToolDef(
                name="matter_attention_list",
                title="List Matters Needing Attention",
                description=(
                    "List attention signals Matters are raising (overdue waits / actions, approaching "
                    "deadlines, health drops, proposals awaiting review, failed follow-up runs). "
                    "Omit public_id to sweep every Matter. Newest first; truncated says whether "
                    "more signals exist beyond limit."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "public_id": public_id_prop,
                        "state": {"type": "string", "enum": list(MATTER_ATTENTION_STATES)},
                        "limit": {"type": "integer", "minimum": 1, "maximum": _ATTENTION_LIMIT_MAX},
                    },
                },
                output_schema={"type": "object", "description": "{count, truncated, items}"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=["matters:read"],
                mcp_exposed=True,
                handler=ToolHandler(kind="service", target="AttentionService.list_attention"),
            ),
            _matter_attention_list,
        ),
    ]
    return BoundSkill(
        name="matter_lookup",
        version="1.0.0",
        title="Matter Lookup",
        description="Read MailAgent Matters: find them, read one in detail, list the attention signals they raise.",
        default_enabled=True,
        prompt_fragment=(
            "Use matter_find to look up Matters by the user's own words, matter_get to read one "
            "with its action items and stakeholders, and matter_attention_list (without public_id) "
            "to answer what needs attention right now. Read-only: Matters cannot be changed here."
        ),
        docs_path="skills/matter_lookup/SKILL.md",
        tools=tools,
    )
