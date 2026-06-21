"""email skill —— 单封邮件读 + 发信/草稿写（write 默认不授外部 key）。

读 handler 镜像 ``src/api/routers/email.py`` 的读端点（repo + ``src/services/wire.py``
投影），保证形状与既有 REST 一致。写 handler 调进程内 ``MailWriteService``（**不 fork CLI**），
``confirmation_tier='edit'`` + scope ``email:write`` 双闸。
"""

from __future__ import annotations

from typing import Any

from src.services import wire
from src.skills.errors import SkillError
from src.skills.models import ToolDef, ToolHandler
from src.skills.registry import BoundSkill, BoundTool

_VALID_INCLUDE = {"body", "attachments", "all"}
_VALID_BODY_FORMATS = {"markdown", "html", "raw"}
_THREAD_MEMBER_CAP = 100


def _parse_include(include: str) -> set[str]:
    if not include:
        return set()
    parts = {p.strip().lower() for p in include.split(",") if p.strip()}
    unknown = parts - _VALID_INCLUDE
    if unknown:
        raise SkillError("E_INVALID_ARG", f"unknown include value(s): {sorted(unknown)}")
    if "all" in parts:
        return {"body", "attachments"}
    return parts


def _email_get(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    internal_id = int(params["internal_id"])
    parts = _parse_include(str(params.get("include") or ""))
    repo = ctx.repo()
    if parts:
        full = repo.get_email_full(internal_id)
        if full is None:
            raise SkillError("E_NOT_FOUND", f"email {internal_id} not found", http_status=404)
        data = wire.meta_to_dict(full.metadata, include_important=True)
        data["body"] = wire.body_summary(full.body) if "body" in parts else None
        data["attachments"] = (
            [wire.attachment_to_dict(a) for a in full.attachments] if "attachments" in parts else []
        )
    else:
        meta = repo.get_metadata(internal_id)
        if meta is None:
            raise SkillError("E_NOT_FOUND", f"email {internal_id} not found", http_status=404)
        data = wire.meta_to_dict(meta, include_important=True)
        data["body"] = None
        data["attachments"] = []
    return data


def _email_body(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    internal_id = int(params["internal_id"])
    fmt = str(params.get("format") or "markdown").lower()
    if fmt not in _VALID_BODY_FORMATS:
        raise SkillError("E_INVALID_ARG", f"format must be one of {sorted(_VALID_BODY_FORMATS)}")
    rec = ctx.repo().get_body(internal_id)
    if rec is None:
        raise SkillError("E_NOT_FOUND", f"no body for email {internal_id}", http_status=404)
    content = rec.markdown if fmt == "markdown" else (rec.html if fmt == "html" else rec.raw_mime_sha256)
    if content is None:
        raise SkillError("E_NOT_FOUND", f"body format {fmt!r} unavailable for {internal_id}", http_status=404)
    return {
        "internal_id": internal_id,
        "format": fmt,
        "content": content,
        "size_bytes": rec.body_size_bytes if fmt != "raw" else len(content),
        "fetched_at": rec.fetched_at,
        "fetched_source": rec.fetched_source,
    }


def _email_thread(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    internal_id = int(params["internal_id"])
    repo = ctx.repo()
    meta = repo.get_metadata(internal_id)
    if meta is None:
        raise SkillError("E_NOT_FOUND", f"email {internal_id} not found", http_status=404)
    thread_id = meta.thread_id
    members: list[dict[str, Any]] = []
    if thread_id:
        for m in repo.get_thread_members(thread_id, synced_only=False)[:_THREAD_MEMBER_CAP]:
            mm = repo.get_metadata(m.internal_id)
            if mm is not None:
                members.append(wire.meta_record_to_list_item(mm))
    return {"internal_id": internal_id, "thread_id": thread_id, "members": members, "count": len(members)}


def _compose_request(params: dict[str, Any]):
    from src.services.mail_write import ComposeRequest

    def _join(v: Any):
        return ",".join(str(x) for x in v) if isinstance(v, list) and v else (v if isinstance(v, str) else None)

    mode = params.get("mode") or "reply-all"
    if mode not in {"reply", "reply-all", "forward", "new"}:
        raise SkillError("E_INVALID_ARG", f"mode must be reply|reply-all|forward|new, got {mode!r}")
    internal_id = params.get("internalId")
    if not isinstance(internal_id, int) or isinstance(internal_id, bool):
        raise SkillError("E_INVALID_ARG", "internalId (int) required")
    body_html = params.get("bodyHtml")
    body_text = params.get("bodyText")
    subject = params.get("subject")
    return ComposeRequest(
        internal_id=internal_id,
        mode=mode,
        to=_join(params.get("to")),
        cc=_join(params.get("cc")),
        bcc=_join(params.get("bcc")),
        subject=subject if isinstance(subject, str) else None,
        body_html=body_html if isinstance(body_html, str) and body_html else None,
        body_text=body_text if isinstance(body_text, str) and body_text else None,
        quote_original=bool(params.get("quoteOriginal", False)),
    )


def _email_send(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    """SMTP 真实发送（不可逆）。scope email:write + confirmation_tier=edit 双闸已在 invoke 层把住。"""
    from src.services.errors import ServiceError
    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    req = _compose_request(params)
    svc = MailWriteService(ctx.service_ctx())
    try:
        # confirm 由 invoke 层 edit-tier gate 把住后透传至 ctx.confirm；这里把真实值交给
        # service 二次校验（而非硬编码 True）→ 防御纵深：gate 若被旁路，service 仍拒发。
        result = svc.send(
            req,
            actor=Actor(kind="http", authenticated=True, label="bearer-agent"),
            confirmed=bool(getattr(ctx, "confirm", False)),
        )
    except ServiceError as exc:
        raise SkillError.from_service(exc)
    return {
        "internal_id": result.internal_id,
        "sent": True,
        "mode": result.mode,
        "message_id": result.message_id,
        "archived_to_sent": result.archived_to_sent,
        "method": result.method,
    }


def build_skill() -> BoundSkill:
    read_scopes = ["email:read"]
    write_scopes = ["email:write"]
    tools = [
        BoundTool(
            ToolDef(
                name="email_get",
                description="Fetch one email's metadata (+ optional body summary / attachments).",
                input_schema={
                    "type": "object",
                    "properties": {
                        "internal_id": {"type": "integer", "description": "email ROWID"},
                        "include": {"type": "string", "description": "csv: body,attachments,all"},
                    },
                    "required": ["internal_id"],
                },
                output_schema={"type": "object", "description": "email metadata + body summary + attachments"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=read_scopes,
                mcp_exposed=True,
                handler=ToolHandler(kind="repository", target="EmailRepository.get_email_full"),
            ),
            _email_get,
        ),
        BoundTool(
            ToolDef(
                name="email_body",
                description="Fetch one email's body in markdown|html|raw.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "internal_id": {"type": "integer"},
                        "format": {"type": "string", "enum": ["markdown", "html", "raw"]},
                    },
                    "required": ["internal_id"],
                },
                output_schema={"type": "object"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=read_scopes,
                mcp_exposed=True,
                handler=ToolHandler(kind="repository", target="EmailRepository.get_body"),
            ),
            _email_body,
        ),
        BoundTool(
            ToolDef(
                name="email_thread",
                description="List sibling emails in the same thread as the given email.",
                input_schema={
                    "type": "object",
                    "properties": {"internal_id": {"type": "integer"}},
                    "required": ["internal_id"],
                },
                output_schema={"type": "object"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=read_scopes,
                mcp_exposed=True,
                handler=ToolHandler(kind="repository", target="EmailRepository.get_thread_members"),
            ),
            _email_thread,
        ),
        BoundTool(
            ToolDef(
                name="email_send",
                description="Send an email via SMTP (irreversible). Requires email:write + confirm.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "internalId": {"type": "integer"},
                        "mode": {"type": "string", "enum": ["reply", "reply-all", "forward", "new"]},
                        "to": {"type": "array", "items": {"type": "string"}},
                        "cc": {"type": "array", "items": {"type": "string"}},
                        "bcc": {"type": "array", "items": {"type": "string"}},
                        "subject": {"type": "string"},
                        "bodyHtml": {"type": "string"},
                        "bodyText": {"type": "string"},
                    },
                    "required": ["internalId"],
                },
                output_schema={"type": "object"},
                confirmation_tier="edit",
                side_effect="send",
                auth_scopes=write_scopes,
                mcp_exposed=False,
                handler=ToolHandler(kind="service", target="MailWriteService.send"),
            ),
            _email_send,
        ),
    ]
    return BoundSkill(
        name="email",
        version="1.0.0",
        title="Email",
        description="Read MailAgent emails (metadata / body / thread); send is gated.",
        default_enabled=True,
        prompt_fragment=(
            "Use email tools to read a specific email by its internal_id: email_get for "
            "metadata, email_body for content, email_thread for the conversation. To find "
            "emails first, use the search skill. email_send is irreversible and requires "
            "explicit user confirmation."
        ),
        docs_path="skills/email/SKILL.md",
        tools=tools,
    )
