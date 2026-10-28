"""email_organize skill —— 旗标 / 置顶 / 归档（``email:organize``，默认不授外部 key）。

与读邮件分开一个 skill：scope 单独一档，外部客户端（如 Notion）里可以整组开关。

三个 handler 调进程内 ``MailWriteService``，与 REST ``POST /api/email/{id}/flag|pin|archive``
（应用内同名操作）走同一个 service 方法、同样的参数：

- ``email_flag`` → ``set_flags([id], is_flagged=…, allow_concurrent=True)``（写 SQLite + outbox 双
  target；REST 同样恒 ``allow_concurrent``，mail-sync 在线时 pm2 检测会拒写）。
- ``email_pin`` → ``set_pin(id, pinned=…)``（只写本地 is_pinned）。
- ``email_archive`` → ``archive(id)``（IMAP MOVE 到 Archive，davmail-only）。

参数名对齐应用内 gateway 的同名工具（``frontend/src/ai-gateway/tools/write.ts``），但只开放旗标，
不开放 is_read / processing_status。三个 handler 都是 ``blocking``：archive 里有
``asyncio.run``（Notion 镜像），不能在事件循环线程里跑。
"""

from __future__ import annotations

from typing import Any

from src.skills.builtin._common import mcp_actor_label
from src.skills.errors import SkillError
from src.skills.models import ToolDef, ToolHandler
from src.skills.registry import BoundSkill, BoundTool

_SCOPES = ["email:organize"]
# 可逆的本地整理：每把 key 每小时 60 次。
_RATE_LIMIT = {"limit": 60, "per_seconds": 3600, "scope": "principal"}

_CONFIRM_PROP = {
    "type": "boolean",
    "description": "must be JSON true (explicit intent marker; anything else fails closed with 403)",
}


def _internal_id(params: dict[str, Any]) -> int:
    value = params.get("internal_id")
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise SkillError("E_INVALID_ARG", "internal_id must be a non-negative integer")
    return value


def _bool(params: dict[str, Any], key: str) -> bool:
    value = params.get(key)
    if not isinstance(value, bool):
        raise SkillError("E_INVALID_ARG", f"{key} must be a JSON boolean")
    return value


def _service(ctx: Any) -> Any:
    from src.services.mail_write import MailWriteService

    return MailWriteService(ctx.service_ctx())


def _actor(ctx: Any) -> Any:
    from src.services.guards import Actor

    return Actor(kind="http", authenticated=True, label=mcp_actor_label(ctx))


def _email_flag(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    internal_id = _internal_id(params)
    flagged = _bool(params, "is_flagged")
    from src.services.errors import ServiceError

    try:
        result = _service(ctx).set_flags(
            [internal_id], is_flagged=flagged, actor=_actor(ctx), allow_concurrent=True
        )
    except ServiceError as exc:
        raise SkillError.from_service(exc) from exc
    # set_flags 对不存在的 id 是软失败（不写、记 not_found）——对外如实报 404，不报成功。
    if internal_id in result.not_found:
        raise SkillError("E_NOT_FOUND", f"email {internal_id} not found", http_status=404)
    return {
        "internal_id": internal_id,
        "is_flagged": flagged,
        "updated_ids": result.updated_ids,
        "outbox_entries": result.outbox_entries,
    }


def _email_pin(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    internal_id = _internal_id(params)
    pinned = _bool(params, "pinned")
    from src.services.errors import ServiceError

    try:
        result = _service(ctx).set_pin(internal_id, pinned=pinned, actor=_actor(ctx))
    except ServiceError as exc:
        raise SkillError.from_service(exc) from exc
    return {"internal_id": result.internal_id, "is_pinned": result.is_pinned, "changed": result.changed}


def _email_archive(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    internal_id = _internal_id(params)
    from src.services.errors import ServiceError

    try:
        result = _service(ctx).archive(internal_id, actor=_actor(ctx))
    except ServiceError as exc:
        raise SkillError.from_service(exc) from exc
    return {
        "internal_id": result.internal_id,
        "archived": True,
        "from_mailbox": result.from_mailbox,
        "to_mailbox": result.to_mailbox,
        "notion_updated": result.notion_updated,
    }


def build_skill() -> BoundSkill:
    id_prop = {"type": "integer", "minimum": 0, "description": "email ROWID (from email_search)"}
    tools = [
        BoundTool(
            ToolDef(
                name="email_flag",
                title="Flag Email",
                description=(
                    "Set or clear the follow-up flag on one email (is_flagged=true / false). "
                    "Reversible: call again with the opposite value. Requires email:organize + "
                    "confirm=true; rate limited to 60 calls per hour per key."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "internal_id": id_prop,
                        "is_flagged": {"type": "boolean"},
                        "confirm": _CONFIRM_PROP,
                    },
                    "required": ["internal_id", "is_flagged"],
                },
                output_schema={"type": "object"},
                confirmation_tier="preview",
                side_effect="write",
                auth_scopes=_SCOPES,
                mcp_exposed=True,
                rate_limit=_RATE_LIMIT,
                idempotent=True,
                handler=ToolHandler(kind="service", target="MailWriteService.set_flags"),
            ),
            _email_flag,
            blocking=True,
        ),
        BoundTool(
            ToolDef(
                name="email_pin",
                title="Pin Email",
                description=(
                    "Pin or unpin one email so it stays at the top of the list (pinned=true / "
                    "false). Local to MailAgent, fully reversible. Requires email:organize + "
                    "confirm=true; rate limited to 60 calls per hour per key."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "internal_id": id_prop,
                        "pinned": {"type": "boolean"},
                        "confirm": _CONFIRM_PROP,
                    },
                    "required": ["internal_id", "pinned"],
                },
                output_schema={"type": "object"},
                confirmation_tier="preview",
                side_effect="write",
                auth_scopes=_SCOPES,
                mcp_exposed=True,
                rate_limit=_RATE_LIMIT,
                idempotent=True,
                handler=ToolHandler(kind="service", target="MailWriteService.set_pin"),
            ),
            _email_pin,
            blocking=True,
        ),
        BoundTool(
            ToolDef(
                name="email_archive",
                title="Archive Email",
                description=(
                    "Move one email into the Archive folder so it leaves the inbox. Not a "
                    "delete: the message, body and attachments are kept, and it can be moved "
                    "back. Fails if the email is already archived. Requires email:organize + "
                    "confirm=true; rate limited to 60 calls per hour per key."
                ),
                input_schema={
                    "type": "object",
                    "properties": {"internal_id": id_prop, "confirm": _CONFIRM_PROP},
                    "required": ["internal_id"],
                },
                output_schema={"type": "object"},
                confirmation_tier="preview",
                side_effect="write",
                auth_scopes=_SCOPES,
                mcp_exposed=True,
                rate_limit=_RATE_LIMIT,
                idempotent=True,
                handler=ToolHandler(kind="service", target="MailWriteService.archive"),
            ),
            _email_archive,
            blocking=True,
        ),
    ]
    return BoundSkill(
        name="email_organize",
        version="1.0.0",
        title="Email Organize",
        description="Flag, pin and archive MailAgent emails (reversible; email:organize scope).",
        default_enabled=True,
        prompt_fragment=(
            "Use email_flag to set or clear the follow-up flag, email_pin to keep an email at "
            "the top of the list, and email_archive to move it out of the inbox. All three are "
            "reversible and need an explicit boolean confirm=true. Find the internal_id with "
            "the search skill first."
        ),
        docs_path="skills/email_organize/SKILL.md",
        tools=tools,
    )
