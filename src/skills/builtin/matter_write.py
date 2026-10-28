"""matter_write skill —— 事项写（``matters:write``，默认不授外部 key）。

读在 ``matter_lookup``，写单独一个 skill：scope 单独一档，外部客户端里可以整组开关。

四个 handler 调 ``MatterService``，与 REST（应用内同名操作）走同一个方法、同样的数据形状：

- ``matter_create`` → ``create_matter``（= ``POST /api/matters``）
- ``matter_add_note`` → ``add_note``（= ``POST /api/matters/{id}/notes``，标题缺省取正文）
- ``matter_item_add`` → ``create_item``，kind 固定 ``action``（= ``POST /api/matters/{id}/items``）
- ``matter_item_update`` → ``update_item``，只开放 title / status / due_at
  （= ``PATCH /api/matters/{id}/items/{item_id}``）

参数名对齐应用内 gateway 的同名工具（``frontend/src/ai-gateway/tools/{matters,schemas}.ts``）：
``public_id`` / ``item_id`` / ``expected_version`` / epoch 毫秒的 ``due_at``。

操作人：``Actor(kind='agent', actor_id='mcp:<密钥名>')``，mutation ``source='mcp'``。时间线
（``matter_event.actor_kind`` / ``actor_id`` / ``source``）据此显示为「MCP · 密钥名」。

返回值里的 ``matter`` 走 ``matter_lookup`` 的同一份白名单（去掉跟进 agent 的配置与指令）。
不开放：删除事项 / 删除行动项 / 归档 / 跟进配置 / 行动项派发。
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from src.skills.builtin._common import (
    domain_error,
    enum_arg,
    int_arg,
    mcp_actor_label,
    str_arg,
)
from src.skills.builtin.matter_lookup import _MATTER_FIELDS
from src.skills.errors import SkillError
from src.skills.models import ToolDef, ToolHandler
from src.skills.registry import BoundSkill, BoundTool

_SCOPES = ["matters:write"]
_RATE_LIMIT = {"limit": 60, "per_seconds": 3600, "scope": "principal"}
_PUBLIC_ID_MAX_CHARS = 64
_TITLE_MAX_CHARS = 500
_TEXT_MAX_CHARS = 20000
_IDEMPOTENCY_MAX_CHARS = 128

_CONFIRM_PROP = {
    "type": "boolean",
    "description": "must be JSON true (explicit intent marker; anything else fails closed with 403)",
}
_PUBLIC_ID_PROP = {"type": "string", "maxLength": _PUBLIC_ID_MAX_CHARS, "description": "e.g. MAT-0001"}
_VERSION_PROP = {
    "type": "integer",
    "minimum": 1,
    "description": (
        "the matter version you last read (matter_get / matter_find or a previous write result). "
        "Appends and edits of untouched items are auto-rebased; E_VERSION_CONFLICT means the same "
        "object changed concurrently — re-read before retrying."
    ),
}
_DUE_AT_PROP = {"type": "integer", "minimum": 0, "description": "due date as epoch MILLISECONDS"}
_IDEMPOTENCY_PROP = {
    "type": "string",
    "maxLength": _IDEMPOTENCY_MAX_CHARS,
    "description": "optional; repeat a call with the same key to avoid writing twice",
}


def _service(ctx: Any) -> Any:
    from src.matters.repository import MatterRepository
    from src.matters.service import MatterService

    return MatterService(MatterRepository(ctx.config().sync_store_db_path))


def _mutation(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    from src.matters.models import MatterActorKind
    from src.matters.service import Actor

    actor_id = mcp_actor_label(ctx)
    key = str_arg(params, "idempotency_key", max_len=_IDEMPOTENCY_MAX_CHARS)
    # 幂等键在 matter_event 里是全局命名空间（应用内、gateway、其他密钥共用）。调用方给的键加上
    # 操作人前缀：撞上别人的键时不会重放出别人的那次写入结果。
    # source 写成字面量：前端 matterTimelineModel.test.ts 从源码抽 `source="…"` 校验 locale 覆盖。
    return dict(
        idempotency_key=f"{actor_id}:{key}" if key else uuid.uuid4().hex,
        source="mcp",
        actor=Actor(kind=MatterActorKind.AGENT.value, actor_id=actor_id),
    )


def _expected_version(params: dict[str, Any]) -> int:
    value = int_arg(params, "expected_version", default=None, lo=1)
    if value is None:
        raise SkillError("E_INVALID_ARG", "expected_version is required")
    return value


def _due_at(params: dict[str, Any]) -> Optional[int]:
    return int_arg(params, "due_at", default=None, lo=0)


def _project_matter(matter: Optional[dict[str, Any]]) -> dict[str, Any]:
    matter = matter or {}
    return {key: matter.get(key) for key in _MATTER_FIELDS}


def _call(fn: Any, *args: Any, **kwargs: Any) -> dict[str, Any]:
    from src.matters.service import MatterError

    try:
        return fn(*args, **kwargs)
    except MatterError as exc:
        raise domain_error(exc) from exc


def _item_result(result: dict[str, Any]) -> dict[str, Any]:
    return {"matter": _project_matter(result.get("matter")), "item": result.get("item")}


def _matter_create(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    data: dict[str, Any] = {
        "title": str_arg(params, "title", max_len=_TITLE_MAX_CHARS, required=True),
        "background": str_arg(params, "background", max_len=_TEXT_MAX_CHARS) or "",
        "goal": str_arg(params, "goal", max_len=_TEXT_MAX_CHARS) or "",
        "due_at": _due_at(params),
    }
    mutation = _mutation(ctx, params)
    result = _call(_service(ctx).create_matter, data, **mutation)
    return {"matter": _project_matter(result.get("matter")), "warnings": result.get("warnings") or []}


def _matter_add_note(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    public_id = str_arg(params, "public_id", max_len=_PUBLIC_ID_MAX_CHARS, required=True)
    text = str_arg(params, "text", max_len=_TEXT_MAX_CHARS, required=True)
    title = str_arg(params, "title", max_len=_TITLE_MAX_CHARS)
    version = _expected_version(params)
    mutation = _mutation(ctx, params)
    # 同 REST POST /notes：没给标题时正文同时当标题（service 会截断用于时间线句子）。
    data = {"title": title or text, "description": text}
    result = _call(_service(ctx).add_note, public_id, data, expected_version=version, **mutation)
    return _item_result(result)


def _matter_item_add(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    public_id = str_arg(params, "public_id", max_len=_PUBLIC_ID_MAX_CHARS, required=True)
    data: dict[str, Any] = {
        "kind": "action",
        "title": str_arg(params, "title", max_len=_TITLE_MAX_CHARS, required=True),
        "description": str_arg(params, "description", max_len=_TEXT_MAX_CHARS),
        "due_at": _due_at(params),
    }
    version = _expected_version(params)
    mutation = _mutation(ctx, params)
    result = _call(_service(ctx).create_item, public_id, data, expected_version=version, **mutation)
    return _item_result(result)


def _matter_item_update(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    from src.matters.models import MATTER_ITEM_STATUSES

    public_id = str_arg(params, "public_id", max_len=_PUBLIC_ID_MAX_CHARS, required=True)
    item_id = int_arg(params, "item_id", default=None, lo=1)
    if item_id is None:
        raise SkillError("E_INVALID_ARG", "item_id is required")
    patch: dict[str, Any] = {}
    title = str_arg(params, "title", max_len=_TITLE_MAX_CHARS)
    if title is not None:
        patch["title"] = title
    status = enum_arg(params, "status", tuple(MATTER_ITEM_STATUSES), None)
    if status is not None:
        patch["status"] = status
    due_at = _due_at(params)
    if due_at is not None:
        patch["due_at"] = due_at
    if not patch:
        raise SkillError("E_INVALID_ARG", "at least one of title / status / due_at is required")
    version = _expected_version(params)
    mutation = _mutation(ctx, params)
    result = _call(
        _service(ctx).update_item, public_id, item_id, patch, expected_version=version, **mutation
    )
    return _item_result(result)


def build_skill() -> BoundSkill:
    from src.matters.models import MATTER_ITEM_STATUSES

    def _tool(name: str, title: str, description: str, properties: dict, required: list, handler, target: str, **kw):
        return BoundTool(
            ToolDef(
                name=name,
                title=title,
                description=description,
                input_schema={
                    "type": "object",
                    "properties": {**properties, "idempotency_key": _IDEMPOTENCY_PROP, "confirm": _CONFIRM_PROP},
                    "required": required,
                },
                output_schema={"type": "object"},
                confirmation_tier="preview",
                side_effect="write",
                auth_scopes=_SCOPES,
                mcp_exposed=True,
                rate_limit=_RATE_LIMIT,
                handler=ToolHandler(kind="service", target=target),
                **kw,
            ),
            handler,
            blocking=True,
        )

    suffix = " Requires matters:write + confirm=true; rate limited to 60 calls per hour per key."
    tools = [
        _tool(
            "matter_create",
            "Create Matter",
            "Create a Matter (a tracked piece of work). background = how it came about and what "
            "constrains it; goal = what must be true when it is done (leave empty rather than "
            "inventing one)." + suffix,
            {
                "title": {"type": "string", "maxLength": _TITLE_MAX_CHARS},
                "background": {"type": "string", "maxLength": _TEXT_MAX_CHARS},
                "goal": {"type": "string", "maxLength": _TEXT_MAX_CHARS},
                "due_at": _DUE_AT_PROP,
            },
            ["title"],
            _matter_create,
            "MatterService.create_matter",
        ),
        _tool(
            "matter_add_note",
            "Add Matter Note",
            "Append a note to a Matter — the lightest way to record progress or a learning. "
            "Write it for a future reader (conclusion / blocker first, then next step)." + suffix,
            {
                "public_id": _PUBLIC_ID_PROP,
                "text": {"type": "string", "maxLength": _TEXT_MAX_CHARS},
                "title": {"type": "string", "maxLength": _TITLE_MAX_CHARS},
                "expected_version": _VERSION_PROP,
            },
            ["public_id", "text", "expected_version"],
            _matter_add_note,
            "MatterService.add_note",
        ),
        _tool(
            "matter_item_add",
            "Add Matter Action Item",
            "Add one action item (a trackable to-do) to a Matter." + suffix,
            {
                "public_id": _PUBLIC_ID_PROP,
                "title": {"type": "string", "maxLength": _TITLE_MAX_CHARS},
                "description": {"type": "string", "maxLength": _TEXT_MAX_CHARS},
                "due_at": _DUE_AT_PROP,
                "expected_version": _VERSION_PROP,
            },
            ["public_id", "title", "expected_version"],
            _matter_item_add,
            "MatterService.create_item",
        ),
        _tool(
            "matter_item_update",
            "Update Matter Action Item",
            "Change the title, status or due date of one action item (item_id from matter_get "
            "include=[items]). Send only the fields that change." + suffix,
            {
                "public_id": _PUBLIC_ID_PROP,
                "item_id": {"type": "integer", "minimum": 1},
                "title": {"type": "string", "maxLength": _TITLE_MAX_CHARS},
                "status": {"type": "string", "enum": list(MATTER_ITEM_STATUSES)},
                "due_at": _DUE_AT_PROP,
                "expected_version": _VERSION_PROP,
            },
            ["public_id", "item_id", "expected_version"],
            _matter_item_update,
            "MatterService.update_item",
            idempotent=True,
        ),
    ]
    return BoundSkill(
        name="matter_write",
        version="1.0.0",
        title="Matter Write",
        description="Create Matters, add notes, and add or update action items (matters:write scope).",
        default_enabled=True,
        prompt_fragment=(
            "Use matter_create to start tracking a new piece of work, matter_add_note to record "
            "progress, and matter_item_add / matter_item_update for action items. Read the "
            "Matter first with matter_get (matter_lookup skill) to get public_id, item ids and "
            "the current version; every write needs an explicit boolean confirm=true."
        ),
        docs_path="skills/matter_write/SKILL.md",
        tools=tools,
    )
