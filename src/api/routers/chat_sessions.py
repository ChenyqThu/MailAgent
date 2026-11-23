"""Chat session CRUD, listing, messages, and metadata routes."""

from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access

router = APIRouter()


def _chat_facade():
    from src.api.routers import chat as m

    return m


# 注意路由顺序：静态 /sessions/all 在动态 /sessions/{id}/messages 之前声明。后者 {session_id:int}
# 约束已能挡住 "all"（非 int 不匹配），此处顺序仅为可读性 + 双保险。


@router.get("/sessions/all", dependencies=[Depends(verify_cf_access)])
async def list_all_sessions(
    request: Request,
    include_archived: bool = Query(False),
    origin: Optional[Literal["interactive", "agent", "im", "team", "group", "all"]] = Query(None),
    agent_id: Optional[str] = Query(None, alias="agentId"),
    agent_job_id: Optional[str] = Query(None, alias="agentJobId"),
    trigger_id: Optional[str] = Query(None, alias="triggerId"),
    trigger_kind: Optional[str] = Query(None, alias="triggerKind"),
    created_after: Optional[int] = Query(None, alias="createdAfter"),
    created_before: Optional[int] = Query(None, alias="createdBefore"),
    archived: Optional[bool] = Query(None),
    starred: Optional[bool] = Query(None),
    matter_id: Optional[int] = Query(None, alias="matterId", ge=1),
    item_id: Optional[int] = Query(None, alias="itemId", ge=1),
    anchor_type: Optional[Literal["matter"]] = Query(None, alias="anchorType"),
    limit: int = Query(300, ge=1, le=300),
):
    """跨邮件 session 历史（含 first_user_message 预览 + message_count + join email
    subject/sender）。镜像 chat:listAllSessions → ChatSessionListItem[]。
    include_archived=true 时含归档会话（用于归档分组视图）。

    ``itemId``（L4 批次3，ai_chat.db v28）= 一条行动项名下的全部会话（执行历史反查）。

    ``anchorType``（09-02 misc05）= 按 anchor 归属取数（团队页「事项跟进」成员的会话 lane）。
    值域暂只有 ``'matter'`` —— 非法值由 ``Literal`` 拦成 E_INVALID_ARG（同 ``origin``），
    与点名单件事的 ``matterId`` 分开（后者是一件事，这里是全部事项会话）。"""
    # 🔴 ``origin`` 的缺省按查询对象分流，而不是恒 'interactive'：行动项要看的**正是** headless
    # 执行 run（``origin='agent'``），沿用旧缺省会把它们全过滤掉 —— 端点 200、列表恒空，
    # 「查不到」与「没有」又混成一个值。缺省只在**调用方没传**时生效（其余查询字节级不变；
    # 带 itemId 时也允许显式传 origin，例如只看交互会话）。
    effective_origin = origin or ("all" if item_id is not None else "interactive")
    summaries = _chat_facade().get_chat_db().list_all_sessions(
        limit=limit, include_archived=include_archived, origin=effective_origin,
        agent_id=_chat_facade()._session_scope(request, agent_id), agent_job_id=agent_job_id,
        trigger_id=trigger_id, trigger_kind=trigger_kind,
        created_after=created_after, created_before=created_before,
        archived=archived, starred=starred, matter_id=matter_id, item_id=item_id,
        anchor_type=anchor_type,
    )
    _chat_facade()._project_session_runs(summaries, _chat_facade().get_settings().sync_store_db_path)
    # codex review NIT — general sessions have email_id=None; exclude them so the
    # email metadata join doesn't query a NULL id (and skips get_settings() when no
    # real email ids remain).
    email_ids = list({s["email_id"] for s in summaries if s["email_id"] is not None})
    # email_ids 空（无 session）时不调 get_settings()（省 config 访问，codex review）。
    meta = (
        _chat_facade()._email_meta_for_sessions(email_ids, _chat_facade().get_settings().sync_store_db_path)
        if email_ids
        else {}
    )
    # matter-anchored 会话的身份（public_id/title）：同一份 sync_store.db，同样只在真有这类行时才连库。
    matter_ids = list(
        {
            s.get("anchor_id")
            for s in summaries
            if s.get("anchor_type") == "matter" and s.get("anchor_id") is not None
        }
    )
    matter_meta = (
        _chat_facade()._matter_meta_for_sessions(matter_ids, _chat_facade().get_settings().sync_store_db_path)
        if matter_ids
        else {}
    )
    def _matter_fields(summary: Dict[str, Any]) -> Dict[str, Any]:
        # 🔴 判据带上 anchor_type：email 会话的 anchor_id 与 matter.id 活在两个 id 空间里，只按
        # anchor_id 查表会把一封邮件的会话贴上别人的 MAT-xxxx。
        if summary.get("anchor_type") != "matter":
            return {"matter_public_id": None, "matter_title": None}
        row = matter_meta.get(summary.get("anchor_id"), {})
        return {
            "matter_public_id": row.get("public_id"),
            "matter_title": row.get("title"),
        }

    items = [
        {
            **_chat_facade()._with_last_message(s),
            "email_subject": meta.get(s["email_id"], {}).get("subject"),
            "email_sender": meta.get(s["email_id"], {}).get("sender"),
            **_matter_fields(s),
        }
        for s in summaries
    ]
    return success_envelope(
        items, request=request, source="sqlite", meta_extra={"count": len(items)}
    )


@router.get("/sessions", dependencies=[Depends(verify_cf_access)])
async def list_sessions(request: Request, email_id: int = Query(..., alias="emailId")):
    """某邮件的 chat sessions（按 updated_at 倒序）。镜像 chat:listSessions → ChatSession[]。"""
    sessions = _chat_facade().get_chat_db().list_sessions_for_email(email_id)
    return success_envelope(
        sessions, request=request, source="sqlite", meta_extra={"count": len(sessions)}
    )


# 路由顺序：静态 /sessions/general 须在动态 /sessions/{id:int} 之前（``:int`` 已挡住非 int，
# 此处仍显式置前作双保险）。
@router.get("/sessions/general", dependencies=[Depends(verify_cf_access)])
async def list_general_sessions(request: Request):
    """P2c — general（无邮件 context）sessions（按 updated_at 倒序）。镜像 listGeneralSessions
    → ChatSession[]。general session 绝不漏进某封邮件 sidebar（与 /sessions?emailId= 分开）。"""
    sessions = _chat_facade().get_chat_db().list_general_sessions()
    return success_envelope(
        sessions, request=request, source="sqlite", meta_extra={"count": len(sessions)}
    )




@router.get("/sessions/{session_id:int}/messages", dependencies=[Depends(verify_cf_access)])
async def list_messages(request: Request, session_id: int):
    """某 session 的全部消息（按 created_at/id 升序）。镜像 chat:listMessages → ChatMessage[]。"""
    _chat_facade()._require_session_in_scope(request, session_id)
    messages = _chat_facade().get_chat_db().list_messages(session_id)
    return success_envelope(
        messages, request=request, source="sqlite", meta_extra={"count": len(messages)}
    )


@router.get("/messages/{message_id:int}/tool-calls", dependencies=[Depends(verify_cf_access)])
async def list_tool_calls(request: Request, message_id: int):
    """某 assistant 消息的工具调用审计。镜像 chat:listToolCalls → ChatToolCall[]。无 tool_use 返 []。"""
    calls = _chat_facade().get_chat_db().list_tool_calls_for_message(message_id)
    return success_envelope(
        calls, request=request, source="sqlite", meta_extra={"count": len(calls)}
    )



@router.post("/sessions", dependencies=[Depends(verify_cf_access)])
async def open_session(request: Request, body: Optional[Dict[str, Any]] = None):
    """getOrCreateSession：复用既有 session 或新建。镜像 chat:getOrCreateSession → ChatSession。
    body = OpenSessionInput（camelCase；anchorType: 'email'|'general'|'matter'，缺省 'email'）。"""
    opts = body or {}
    anchor_type, email_id, matter_id, backend_kind = _chat_facade()._validate_session_opts(opts, "sessions")
    session = _chat_facade().get_chat_db().get_or_create_session(
        email_id=email_id,
        backend_kind=backend_kind,
        backend_model=opts.get("backendModel"),
        backend_agent_page_id=opts.get("backendAgentPageId"),
        anchor_type=anchor_type,
        matter_id=matter_id,
    )
    return success_envelope(session, request=request, source="sqlite")



@router.post("/sessions/new", dependencies=[Depends(verify_cf_access)])
async def new_session(request: Request, body: Optional[Dict[str, Any]] = None):
    """校验与写入全在 create_session_validated；这里只取 body → 调它 → 包 envelope。"""
    return success_envelope(
        await _chat_facade().create_session_validated(body or {}), request=request, source="sqlite"
    )


@router.get("/sessions/{session_id:int}", dependencies=[Depends(verify_cf_access)])
async def get_session(request: Request, session_id: int):
    """单 session 行。镜像 chat_db getSession → ChatSession | null（data=null 当不存在，不 404）。

    🔴 matter-anchored 行同样投影 ``matter_public_id`` / ``matter_title``（与 ``/sessions/all``
    共用 ``_matter_meta_for_sessions``，不写第二份 join）。少了它，凡是走这条单行读的入口
    （远程 / fullscreen 跳转 / ``/sessions/all`` 暂时不含该行）拿到的事项会话就只剩一个内部
    ``anchor_id``，前端认不出身份 → 退化成"普通会话"：没有事项 chip、没有缺口卡、没有写入回执，
    且请求不带 matter 快照 ⇒ 模型手里没有这件事的任何上下文，用户以为在这件事里说话，
    模型却在全局范围跑。
    """
    session = _chat_facade().get_chat_db().get_session(session_id)
    if isinstance(session, dict) and session.get("anchor_type") == "matter":
        anchor_id = session.get("anchor_id")
        row = (
            _chat_facade()._matter_meta_for_sessions(
                [anchor_id], _chat_facade().get_settings().sync_store_db_path
            ).get(anchor_id, {})
            if isinstance(anchor_id, int)
            else {}
        )
        # join 读不到（库缺 / 表缺 / 锁）→ 两键为 None。读侧据此进入「上下文未就绪」，
        # 而**不是**当成普通会话 —— 「缺元数据」与「不是事项」绝不能是同一个值。
        session = {
            **session,
            "matter_public_id": row.get("public_id"),
            "matter_title": row.get("title"),
        }
    return success_envelope(session, request=request, source="sqlite")


@router.delete("/sessions/{session_id:int}", dependencies=[Depends(verify_cf_access)])
async def delete_session(request: Request, session_id: int):
    """deleteSession：删整个 session（其消息 + 工具调用经 FK CASCADE 连带删）。镜像 chat_db
    deleteSession（fire-and-forget，删不存在的 id 也返 {deleted: True}）。3c-2 补：cutover 后
    renderer ChatRuntime.deleteSession 经此删（取代 electron chat:deleteSession IPC）。"""
    _chat_facade().get_chat_db().delete_session(session_id)
    return success_envelope({"deleted": True}, request=request, source="sqlite")


@router.patch("/sessions/{session_id:int}/title", dependencies=[Depends(verify_cf_access)])
async def update_session_title(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """updateSessionTitle：设置 session 标题（手动改名）。镜像 chat_db updateSessionTitle（刻意不
    bump updated_at → 改名不重排历史）。body = {title: str}。改不存在的 id 也返 {updated: True}。"""
    opts = body or {}
    title = opts.get("title")
    if not isinstance(title, str):
        raise APIError("E_INVALID_ARG", "title requires title:str", source="sqlite")
    _chat_facade().get_chat_db().update_session_title(session_id, title)
    return success_envelope({"updated": True}, request=request, source="sqlite")



@router.patch("/sessions/{session_id:int}/read", dependencies=[Depends(verify_cf_access)])
async def update_session_read(request: Request, session_id: int):
    """markSessionRead（harness-chat lane A B4，task 07-15）：置 last_read_at=now（ai_chat.db v20）。
    未读徽标判定 = updated_at > last_read_at；刻意不 bump updated_at（已读不重排历史）。
    改不存在的 id / pre-v20 库缺列均静默返 {updated: True}（best-effort UX 面，绝不 500）。"""
    _chat_facade().get_chat_db().update_session_last_read(session_id)
    return success_envelope({"updated": True}, request=request, source="sqlite")


@router.patch("/sessions/{session_id:int}/model", dependencies=[Depends(verify_cf_access)])
async def update_session_model(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """W8 per-session 模型偏好（task 08-04 WP2）：composer 换模型 → 落该会话的 backend_model。

    body = {model: str | null}（null/'' = 清空，回落全局默认）。值是完整 providerRef
    （``providerId:modelId``，裸 id = legacy default provider），与 /sessions/new 的
    backendModel 同一词汇。刻意不 bump updated_at（换模型不重排历史，同 title/archived
    纪律）。改不存在的 id 也返 {updated: True}。"""
    opts = body or {}
    model = opts.get("model")
    if model is not None and not isinstance(model, str):
        raise APIError("E_INVALID_ARG", "model requires model:str|null", source="sqlite")
    _chat_facade().get_chat_db().update_session_model(session_id, model or None)
    return success_envelope({"updated": True}, request=request, source="sqlite")


@router.patch("/sessions/{session_id:int}/archived", dependencies=[Depends(verify_cf_access)])
async def update_session_archived(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """updateSessionArchived：设置 session 归档状态（软删）。镜像 chat_db updateSessionArchived（刻意不
    bump updated_at → 归档不重排历史）。body = {archived: bool}。改不存在的 id 也返 {updated: True}。"""
    opts = body or {}
    archived = opts.get("archived")
    if not isinstance(archived, bool):
        raise APIError("E_INVALID_ARG", "archived requires archived:bool", source="sqlite")
    _chat_facade().get_chat_db().update_session_archived(session_id, archived)
    return success_envelope({"updated": True}, request=request, source="sqlite")


@router.patch("/sessions/{session_id:int}/pinned", dependencies=[Depends(verify_cf_access)])
async def update_session_pinned(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """设置置顶状态；置顶时间决定 pinned 分组顺序，不 bump updated_at。"""
    opts = body or {}
    pinned = opts.get("pinned")
    if not isinstance(pinned, bool):
        raise APIError("E_INVALID_ARG", "pinned requires pinned:bool", source="sqlite")
    _chat_facade().get_chat_db().update_session_pinned(session_id, pinned)
    return success_envelope({"updated": True}, request=request, source="sqlite")


@router.patch("/sessions/{session_id:int}/starred", dependencies=[Depends(verify_cf_access)])
async def update_session_starred(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """设置独立星标 icon 状态；不改变分组或 updated_at。"""
    opts = body or {}
    starred = opts.get("starred")
    if not isinstance(starred, bool):
        raise APIError("E_INVALID_ARG", "starred requires starred:bool", source="sqlite")
    _chat_facade().get_chat_db().update_session_starred(session_id, starred)
    return success_envelope({"updated": True}, request=request, source="sqlite")


@router.delete(
    "/sessions/{session_id:int}/messages/from/{from_message_id:int}",
    dependencies=[Depends(verify_cf_access)],
)
async def delete_messages_from(request: Request, session_id: int, from_message_id: int):
    """deleteMessagesFromId：删 from_message_id 及之后所有消息（行内编辑重跑）。镜像 chat_db
    deleteMessagesFromId → {deleted: count}。"""
    count = _chat_facade().get_chat_db().delete_messages_from_id(session_id, from_message_id)
    return success_envelope({"deleted": count}, request=request, source="sqlite")


