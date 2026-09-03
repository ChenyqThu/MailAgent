"""chat 路由 — /api/chat/* (V2.1 远程 chat 历史只读 [阶段 2] + 对话 [阶段 3])。

**阶段 2（本次）**：5 读端点，镜像本地 IPC ``handlers/chat.ts`` 的 listSessions /
listAllSessions / listMessages / listToolCalls / kosAvailable。读 ai_chat.db
（``src/chat/db.py``，serve-api 新连）+ listAllSessions join sync_store.db
email_metadata（subject/sender，best-effort）。形状对齐前端 ChatSession /
ChatSessionSummary / ChatSessionListItem / ChatMessage / ChatToolCall（``types.ts``）。

**阶段 3（后续，B-pure-unified）**：chat 持久化 / 写工具端点 —— harness 在 browser
跑，serve-api 退化为数据/代理面。

鉴权：所有端点 ``Depends(verify_cf_access)``。读 graceful（库不存在/锁 → []）。
"""

from __future__ import annotations

import logging
import os
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from dotenv import dotenv_values

from src.agent_config.enabled_models import (
    FALLBACK_DEFAULT_MODEL,
    build_enabled_model_catalog,
)
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_chat_db, get_env_file_path, get_report_store, get_settings
from src.chat.group_limits import (
    CHAIN_CAP_MAX,
    CHAIN_CAP_MIN,
    MAIN_AGENT_MEMBER_ID,
    MAX_GROUP_MEMBERS,
    MODEL_OVERRIDE_MAX_CHARS,
    RESPONSE_MODES,
    SESSION_INVOKED_BY,
    THREAD_TITLE_MAX_CHARS,
    TOPIC_MAX_CHARS,
    group_scope_hash,
)
from src.chat.db import parse_group_member_ids
from src.chat.kos_save import SaveConversationError, save_conversation_to_kos
from src.agents.run_state import derive_agent_run_state
from src.kos.client import KOSClient, KOSError

router = APIRouter(prefix="/api/chat", tags=["chat"])

logger = logging.getLogger(__name__)

# code-owned builtin skill 里，其 ``prompt_fragment`` 允许进 gateway system prompt 的白名单
# （``/chat/config.trustedSkillFragments``）。安装态第三方 skill 的 fragment 永不进这里 —— 那是
# 恒注入的可信面。加名字前先问：这段文字该不该对**每一轮**对话说话。
TRUSTED_PROMPT_FRAGMENT_SKILLS = frozenset({"custom_agent", "matters"})


def _session_scope(request: Request, requested_agent_id: Optional[str]) -> Optional[str]:
    current = (request.headers.get("X-MailAgent-Agent-Id") or "").strip()
    if not current:
        return requested_agent_id
    allow_all = request.headers.get("X-MailAgent-Allow-All-History") == "1"
    return requested_agent_id if allow_all else current


def _require_session_in_scope(request: Request, session_id: int) -> None:
    """``_session_scope`` 的单会话版：headless own 半径下，别的 agent 的会话正文读不到。

    无 header（manual chat / renderer 直读）或 ``Allow-All-History=1`` → 不校验；own 半径下
    会话存在且 ``agent_id != current`` → E_NOT_FOUND（与列表面「看不见」同口径，不做存在性
    oracle）；会话不存在 → 放行，维持端点「读不到返 []」的既有契约。"""
    current = (request.headers.get("X-MailAgent-Agent-Id") or "").strip()
    if not current or request.headers.get("X-MailAgent-Allow-All-History") == "1":
        return
    session = get_chat_db().get_session(session_id)
    if session is not None and (session.get("agent_id") or "") != current:
        raise APIError(
            "E_NOT_FOUND",
            f"session {session_id} is outside this agent's history scope",
            hint="only this agent's own sessions are readable without the sessions=all grant",
            source="sqlite",
        )


def _project_session_runs(items: List[Dict[str, Any]], sync_db_path: str) -> None:
    job_ids = [int(s["agent_job_id"]) for s in items if s.get("origin") == "agent" and str(s.get("agent_job_id") or "").isdigit()]
    if not job_ids or not os.path.exists(sync_db_path):
        return
    try:
        conn = sqlite3.connect(sync_db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            placeholders = ",".join("?" * len(job_ids))
            rows = conn.execute(f"SELECT * FROM async_jobs WHERE job_id IN ({placeholders})", job_ids).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return
    by_id = {int(r["job_id"]): dict(r) for r in rows}
    for item in items:
        raw_id = str(item.get("agent_job_id") or "")
        row = by_id.get(int(raw_id)) if raw_id.isdigit() else None
        if not row:
            continue
        try:
            result = json.loads(row.get("result_json") or "{}")
        except (json.JSONDecodeError, TypeError):
            result = {}
        item["run"] = {
            "state": derive_agent_run_state(row),
            "outcome": result.get("outcome"),
            "approvalState": result.get("approval_state"),
            "finishedAt": row.get("finished_at"),
            "error": row.get("last_error"),
        }

# task 07-21 —— chat system prompt 不再注入 Notion context page（``LLM_CONTEXT_PAGE_ID``）。
# 用户身份/画像已由 Standing Context（backend agent_config.db 的 SOUL/AGENT/RULES/USER，恒
# 注入）单源承担，旧的 ContextLoader user_context 段是与之重叠的双注入，已移除。
# ContextLoader 本体保留给 llm_agent 预处理分类用（``LLM_PREPROCESS_CONTEXT_SOURCE`` =
# notion_context 时生效）。


def _kos_available() -> bool:
    """KOS OAuth 凭据齐全（对齐前端 ``isKosSaveAvailable`` / chat:kosAvailable）。

    三 env 都非空才算可用 —— 决定远程 [✨ 保存到 KOS] 按钮是否渲染。
    """
    return bool(
        os.environ.get("KOS_MCP_BASE")
        and os.environ.get("KOS_OAUTH_CLIENT_ID")
        and os.environ.get("KOS_OAUTH_CLIENT_SECRET")
    )


def _email_meta_for_sessions(
    email_ids: List[int], sync_db_path: str
) -> Dict[int, Dict[str, Any]]:
    """批量取 session 所属邮件的 subject/sender（join sync_store.db email_metadata）。

    best-effort：sync_store.db 不可用 / FDA 未授权 → 空 map（端点降级 nulls），
    对齐 chat:listAllSessions「降级 preview-only 行」。
    """
    if not email_ids:
        return {}
    # serve-api 只读：库不存在直接短路，不让 connect 建空库（与 ChatDb._read_all 一致）。
    if not os.path.exists(sync_db_path):
        return {}
    meta: Dict[int, Dict[str, Any]] = {}
    try:
        conn = sqlite3.connect(sync_db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            placeholders = ",".join("?" * len(email_ids))
            rows = conn.execute(
                f"SELECT internal_id, subject, sender_name, sender FROM email_metadata "
                f"WHERE internal_id IN ({placeholders})",
                email_ids,
            ).fetchall()
            for r in rows:
                # sender_name ?? sender（对齐 chat.ts：仅 NULL 回退 sender，空字符串 "" 保留）。
                sender_name = r["sender_name"]
                meta[r["internal_id"]] = {
                    "subject": r["subject"],
                    "sender": sender_name if sender_name is not None else r["sender"],
                }
        finally:
            conn.close()
    except sqlite3.Error:
        pass
    return meta


def _matter_meta_for_sessions(
    matter_ids: List[int], sync_db_path: str
) -> Dict[int, Dict[str, Any]]:
    """批量取 matter-anchored session 的 public_id/title（join sync_store.db matter）。

    ``anchor_id`` 是 matter 的**内部** id，而事项的所有 REST 面（context-snapshot / undo）都按
    ``MAT-xxxx`` 寻址 —— 不带上 public_id，前端从历史里选中一个事项会话时就只剩一个数字，
    既拿不到上下文也标不出身份（收口进主 chat 前这条路由根本不存在，因为事项对话是另一套面板）。

    形状与 ``_email_meta_for_sessions`` 逐条对齐（同库、同 best-effort：库缺 / 表缺 / 锁 → 空 map，
    端点降级成 nulls 而不是 500）。
    """
    if not matter_ids:
        return {}
    if not os.path.exists(sync_db_path):
        return {}
    meta: Dict[int, Dict[str, Any]] = {}
    try:
        conn = sqlite3.connect(sync_db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            placeholders = ",".join("?" * len(matter_ids))
            rows = conn.execute(
                f"SELECT id, public_id, title FROM matter WHERE id IN ({placeholders})",
                matter_ids,
            ).fetchall()
            for r in rows:
                meta[r["id"]] = {"public_id": r["public_id"], "title": r["title"]}
        finally:
            conn.close()
    except sqlite3.Error:
        pass
    return meta


def _with_last_message(summary: Dict[str, Any]) -> Dict[str, Any]:
    """把 ``list_all_sessions`` 的五个 ``last_message_*`` 列折成一个 ``last_message`` 对象。

    五列全 None（会话一条消息都没有 —— 群可以先建后说话）→ ``None``。``via`` 来自消息
    ``metadata.$.via``：主助理投递进群的行是 ``role='user' + via='main_agent'``，列表预览据此
    写「主助理：」而不是「你：」（同一条 user 行，只有这一个字段能区分）。"""
    fields = {
        "content": summary.pop("last_message_content", None),
        "role": summary.pop("last_message_role", None),
        "speaker_agent_id": summary.pop("last_message_speaker_agent_id", None),
        "via": summary.pop("last_message_via", None),
        "created_at": summary.pop("last_message_created_at", None),
    }
    return {**summary, "last_message": None if all(v is None for v in fields.values()) else fields}


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
    summaries = get_chat_db().list_all_sessions(
        limit=limit, include_archived=include_archived, origin=effective_origin,
        agent_id=_session_scope(request, agent_id), agent_job_id=agent_job_id,
        trigger_id=trigger_id, trigger_kind=trigger_kind,
        created_after=created_after, created_before=created_before,
        archived=archived, starred=starred, matter_id=matter_id, item_id=item_id,
        anchor_type=anchor_type,
    )
    _project_session_runs(summaries, get_settings().sync_store_db_path)
    # codex review NIT — general sessions have email_id=None; exclude them so the
    # email metadata join doesn't query a NULL id (and skips get_settings() when no
    # real email ids remain).
    email_ids = list({s["email_id"] for s in summaries if s["email_id"] is not None})
    # email_ids 空（无 session）时不调 get_settings()（省 config 访问，codex review）。
    meta = (
        _email_meta_for_sessions(email_ids, get_settings().sync_store_db_path)
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
        _matter_meta_for_sessions(matter_ids, get_settings().sync_store_db_path)
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
            **_with_last_message(s),
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
    sessions = get_chat_db().list_sessions_for_email(email_id)
    return success_envelope(
        sessions, request=request, source="sqlite", meta_extra={"count": len(sessions)}
    )


# 路由顺序：静态 /sessions/general 须在动态 /sessions/{id:int} 之前（``:int`` 已挡住非 int，
# 此处仍显式置前作双保险）。
@router.get("/sessions/general", dependencies=[Depends(verify_cf_access)])
async def list_general_sessions(request: Request):
    """P2c — general（无邮件 context）sessions（按 updated_at 倒序）。镜像 listGeneralSessions
    → ChatSession[]。general session 绝不漏进某封邮件 sidebar（与 /sessions?emailId= 分开）。"""
    sessions = get_chat_db().list_general_sessions()
    return success_envelope(
        sessions, request=request, source="sqlite", meta_extra={"count": len(sessions)}
    )


@router.get("/sessions/search", dependencies=[Depends(verify_cf_access)])
async def search_sessions(
    request: Request,
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(20, ge=1, le=20),
    origin: Literal["interactive", "agent", "im", "team", "group", "all"] = Query("all"),
    agent_id: Optional[str] = Query(None, alias="agentId"),
    agent_job_id: Optional[str] = Query(None, alias="agentJobId"),
    trigger_id: Optional[str] = Query(None, alias="triggerId"),
    trigger_kind: Optional[str] = Query(None, alias="triggerKind"),
    created_after: Optional[int] = Query(None, alias="createdAfter"),
    created_before: Optional[int] = Query(None, alias="createdBefore"),
    archived: Optional[bool] = Query(None),
    starred: Optional[bool] = Query(None),
):
    """S1 R1 — 按消息内容检索历史会话（FTS5 trigram，短 query/未迁移库 LIKE 降级）。按 session
    聚合返回 {session 元数据 + 命中 snippet 列表}（条数/字节 cap 在 ChatDb.search_sessions）。
    消费方 = gateway chat_session_search 工具（domainClient）；鉴权与本 router 其余 session
    端点一致（verify_cf_access：本地 token 腿 / CF JWT 腿）。"""
    results = get_chat_db().search_sessions(
        q, session_limit=limit, origin=origin,
        agent_id=_session_scope(request, agent_id), agent_job_id=agent_job_id,
        trigger_id=trigger_id, trigger_kind=trigger_kind,
        created_after=created_after, created_before=created_before,
        archived=archived, starred=starred,
    )
    for hit in results:
        session = hit.get("session")
        if isinstance(session, dict):
            _project_session_runs([session], get_settings().sync_store_db_path)
            if "run" in session:
                hit["run"] = session.pop("run")
    return success_envelope(
        results, request=request, source="sqlite", meta_extra={"count": len(results)}
    )


@router.get("/sessions/{session_id:int}/messages", dependencies=[Depends(verify_cf_access)])
async def list_messages(request: Request, session_id: int):
    """某 session 的全部消息（按 created_at/id 升序）。镜像 chat:listMessages → ChatMessage[]。"""
    _require_session_in_scope(request, session_id)
    messages = get_chat_db().list_messages(session_id)
    return success_envelope(
        messages, request=request, source="sqlite", meta_extra={"count": len(messages)}
    )


@router.get("/messages/{message_id:int}/tool-calls", dependencies=[Depends(verify_cf_access)])
async def list_tool_calls(request: Request, message_id: int):
    """某 assistant 消息的工具调用审计。镜像 chat:listToolCalls → ChatToolCall[]。无 tool_use 返 []。"""
    calls = get_chat_db().list_tool_calls_for_message(message_id)
    return success_envelope(
        calls, request=request, source="sqlite", meta_extra={"count": len(calls)}
    )


@router.get("/kos-available", dependencies=[Depends(verify_cf_access)])
async def kos_available(request: Request):
    """KOS 可用性（OAuth 凭据齐全）。镜像 chat:kosAvailable → boolean。"""
    return success_envelope(_kos_available(), request=request, source="sqlite")


@router.post("/kos-doctor", dependencies=[Depends(verify_cf_access)])
async def kos_doctor(request: Request):
    """KOS 连接检查（issue #54）：分步 凭据→health→token→list_pages，逐步 ok/fail+detail。

    data = ``[{status:'ok'|'fail', check, detail}]``（形状对齐 notion-agent doctor）。
    凭据热读 .env（对齐 chat_config 的 _kos_cred：.env 显式存在即以 .env 为准——用户刚
    在 Settings 保存/清空的凭据立即生效），并用热读值新建 KOSClient —— 不用 kos-call 的
    _get_kos_client 单例（其凭据在首次构造时固化 + token cache 会掩盖凭据失效）。
    分步逻辑在 src/kos/doctor.py（client 可注入，单测 stub）。
    """
    from src.kos.doctor import KOS_CRED_KEYS, run_kos_doctor

    env_vals: Dict[str, Any] = {}
    try:
        env_path = get_env_file_path()
        if env_path:
            env_vals = dotenv_values(env_path) or {}
    except Exception:  # noqa: BLE001 — best-effort; 回退 os.environ
        env_vals = {}

    def _cred(k: str) -> str:
        return ((env_vals[k] if k in env_vals else os.environ.get(k)) or "").strip()

    creds = {k: _cred(k) for k in KOS_CRED_KEYS}
    missing = [k for k in KOS_CRED_KEYS if not creds[k]]
    consumer_enabled = _hot_bool(
        env_vals, "MAILAGENT_KOS_CONSUMER_ENABLED", get_settings().kos_consumer_enabled
    )
    client = KOSClient(
        base_url=creds["KOS_MCP_BASE"] or None,
        client_id=creds["KOS_OAUTH_CLIENT_ID"] or None,
        client_secret=creds["KOS_OAUTH_CLIENT_SECRET"] or None,
    )
    checks = await run_in_threadpool(
        run_kos_doctor, client, missing_keys=missing, consumer_enabled=consumer_enabled
    )
    return success_envelope(
        checks, request=request, source="kos", meta_extra={"count": len(checks)}
    )


def _hot_bool(env_vals: Dict[str, Any], key: str, fallback: bool) -> bool:
    """从 dotenv_values dict 热读 bool（.env 为准），未设/空/malformed → fallback
    （cfg singleton 值，不漂移）。对齐 electron readEnvBool（'1'/'true' → true），
    并容 yes/on/0/false/no/off。用于 KOS 开关：serve-api 启动后才改 .env 也即时生效。"""
    raw = (env_vals.get(key) or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return fallback


@router.get("/config", dependencies=[Depends(verify_cf_access)])
async def chat_config(request: Request):
    """chat 运行配置快照（S3 后两类消费方，均非 HttpChatPlatform ——该抽象已随 W3-A 删除）。

    serve-api 读 config.py（pydantic env_file → .env）暴露 chat 引擎运行配置。消费方：
    ① 嵌入式 AI SDK Gateway（`ai_gateway_lifecycle.ts` 启动前 TTL 缓存预取一次，投影进
    `GatewaySystemPromptConfig` 驱动 system prompt 组装 + 工具门控，见
    `frontend/src/ai-gateway/{systemPrompt,config}.ts`）；② renderer Settings UI 直接
    fetch（`CustomAiSection.tsx` / `useLlmModels.ts`，非经引擎）。camelCase 对齐两端。

    ``kosConsumerEnabled`` = 原始开关；``kosConfigured`` = 开关 AND OAuth 凭据齐全
    （KOS_MCP_BASE + KOS_OAUTH_CLIENT_ID + KOS_OAUTH_CLIENT_SECRET 三者非空，对齐
    ``_kos_available``）。🔴 ``kosConfigured`` gate 的是 **KOS 使用指南块是否注入 system
    prompt**（`stable_prompt.ts` ``buildKosGuidanceBlock``），**不是工具注册** —— gateway 的
    6 个 KOS 只读工具（issue #57：kos_query / kos_search / kos_get_page / kos_find_experts /
    kos_list_pages / kos_get_backlinks）在 `tools/index.ts` 由 ``createKosReadTools`` **无条件**
    展开进 ToolSet，未对接时调用返 ``E_KOS_NOT_CONFIGURED`` 工具错误（``[✨ 保存到 KOS]``
    按钮仍单独由 ``_kos_available`` gate）。
    """
    cfg = get_settings()
    # 归一化对齐 electron chat/config.ts getter 的防御（malformed/empty env 不漂移 ——
    # cutover 后 serve-api 单源，但过渡期 3c-2/3c-3 与 electron getter 并存须等价）：
    #   getMaxIter = max(1, floor(n)); getMaxCostUsd = n>0 ? n : 0.5; getLlmModel '' → fallback。
    # bool 字段：pydantic 已解析（1/true/yes/on → true）。electron readEnvBool 仅 '1'/'true'
    # → true、未设/空 → default、其余非空（含 yes/on）→ false。两者对标准 true/false/1/0
    # 一致，差异仅在 yes/on 等非标准值（罕见）+ cutover 后 serve-api 单源无漂移，不额外归一化
    # （codex 3c-1 review MEDIUM/nit 已记此微差）。
    max_iter = max(1, int(cfg.agent_max_iter))
    max_cost = cfg.agent_max_cost_usd if cfg.agent_max_cost_usd > 0 else 0.5
    default_model = cfg.llm_model or FALLBACK_DEFAULT_MODEL
    # task 07-21 —— Notion context page 不再注入 chat system prompt（见文件头注释：
    # 与 Standing Context 双注入冗余，已移除）。ContextLoader 保留给 llm_agent 预处理用。
    # enabledModels + KOS 开关: hot-read from .env (dotenv_values, not pydantic Config
    # singleton) so changes take effect without a serve-api restart — same pattern as
    # 155eb006 (SYNC_FOLDERS hot-read). 🔴 KOS 开关曾用 cfg.* singleton: serve-api 启动
    # 后才往 app .env 加 MAILAGENT_KOS_CONSUMER_ENABLED → import-time config 缓存 stale
    # false → /config 永远 kosConfigured:false → gateway 不注入 KOS 使用指南块（chat AI
    # 不知道有知识大脑可查）。热读 .env 为准、cfg.* 兜底，根治该 stale。
    enabled_models: list = []
    env_vals: Dict[str, Any] = {}
    try:
        env_path = get_env_file_path()
        if env_path:
            env_vals = dotenv_values(env_path) or {}
            raw = env_vals.get("LLM_ENABLED_MODELS") or ""
            enabled_models = [m.strip() for m in raw.split(",") if m.strip()]
    except Exception:  # noqa: BLE001 — best-effort; never fail /config
        enabled_models = []
        env_vals = {}
    # task 07-12 P0 (LLM 多 provider 化) — flag on 时 enabledModels 改为聚合 agent_config.db
    # 的 llm_provider/llm_model 表：全部 enabled provider 的 enabled 模型；default provider
    # 输出裸 model id（legacy 兼容——chat 面板 localStorage 偏好 / report_agent 行零迁移），
    # 其余输出 'providerId:modelId'（providerRef，prd §4.3b）。default 恒排最前。
    # flag off（显式 false 应急回退——默认 on 自 2026-07-13 cutover；pydantic 冻结单例读，
    # 翻 flag 需重启 serve-api）→ 上面的 .env 热读路径字节级不变；聚合失败 → 回退 env 值
    # （never fail /config）。getattr 防御老 stub cfg（fallback 取 False = fail-safe 走 legacy）。
    # 🔴 聚合本体已抽成 src/agent_config/enabled_models.py（08-04）：飞书 ``/model`` 指令要用
    # **同一份**清单校验用户输入（透传不在册的 ref 会让 gateway 抛裸 Error、响应永不写出），
    # 照抄一份必漂移。本处行为逐字节不变（顺序、flag off 回退、聚合失败回退全同）。
    enabled_models = build_enabled_model_catalog(
        registry_enabled=bool(getattr(cfg, "llm_provider_registry_enabled", False)),
        env_models=enabled_models,
        default_model=default_model,
    ).refs
    kos_consumer = _hot_bool(env_vals, "MAILAGENT_KOS_CONSUMER_ENABLED", cfg.kos_consumer_enabled)
    kos_l1_hot = _hot_bool(env_vals, "MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED", cfg.kos_l1_hot_block_enabled)
    kos_time_decay = _hot_bool(env_vals, "MAILAGENT_KOS_TIME_DECAY_ENABLED", cfg.kos_time_decay_enabled)
    # 🔴「只在启用 AND 对接 KOS 时才注入使用指南」。kosConsumerEnabled = 纯开关；kosConfigured
    # = 开关 AND OAuth 凭据齐全（endpoint + client_id + secret 三者非空，对齐 _kos_available）。
    # gateway 据 kosConfigured 决定是否把 KOS 使用指南块注入 system prompt —— 开关开着却没配
    # 凭据（新用户 / 未对接）时不注入，避免叫 AI 去查一个必然失败的知识大脑。**工具本身不受此
    # gate**：6 个 KOS 只读工具恒注册（`tools/index.ts` 无条件展开 createKosReadTools），未对接
    # 时调用返 E_KOS_NOT_CONFIGURED。凭据热读 .env 为准、os.environ（启动注入）兜底，
    # 与 enabledModels / kos 开关同样支持改 .env 即时生效。
    def _kos_cred(k: str) -> str:
        # .env 显式存在该 key（含空字符串）即以 .env 为准 → 用户在 Settings 清空某凭据即时
        # 禁用（kosConfigured 翻 False）；仅 key 完全不在 .env 时才回退 os.environ（serve-api
        # 启动注入值）。修 review LOW：旧 `env_vals.get(k) or os.environ.get(k)` 会让 .env
        # 显式空被 os.environ stale 值覆盖、清不掉。
        return ((env_vals[k] if k in env_vals else os.environ.get(k)) or "").strip()

    kos_creds = all(
        _kos_cred(k) for k in ("KOS_MCP_BASE", "KOS_OAUTH_CLIENT_ID", "KOS_OAUTH_CLIENT_SECRET")
    )
    kos_configured = kos_consumer and kos_creds
    # memory.md（Hermes 式有界记忆，task 07-01）恒注入。auto-capture 每轮把持久事实合并进
    # agent_config.db 的 MEMORY doc；这里读它进 memorySummary → 前端经现成 MEMORY fence（untrusted
    # 背景）注入每轮 system prompt。gate = MAILAGENT_MEM0_RETRIEVAL（语义从 M2「按 query 召回」改为
    # 「恒注入 memory.md」，复用同 flag，热读 .env；默认开 —— 2026-07-02 cutover，env 显式 false
    # 仍可关，应急回退）。
    # 🔴 flag-off 或 memory.md 空 → memory_summary="" + retired meta（与 M5b 现状字节级一致：前端
    # custom_api.ts:290 `if (cfg.memorySummary && ...)` 真值门控不注入；meta 纯诊断，前端不读）。
    memory_summary = ""
    memory_summary_meta = {
        "injected": 0,
        "total": 0,
        "chars": 0,
        "truncated": False,
        "max_entries": 20,
        "max_chars": 2000,
        "retired": True,
    }
    if _hot_bool(env_vals, "MAILAGENT_MEM0_RETRIEVAL", True):
        try:
            from src.agent_config.store import MEMORY_DOC_NAME, get_agent_config_store
            from src.memory.memory_md import _truncate_to_budget, memory_layer_stats

            _mem_raw = get_agent_config_store().get_profile_doc(MEMORY_DOC_NAME).content.strip()
            # 读侧 budget clamp（belt-and-suspenders，codex 步3 LOW）：capture 写侧已把 memory.md
            # 压回 budget，注入时再 clamp 一次，保证恒注入 ≤ 当前 memory_md_budget_chars —— 唯一
            # 超预算路径 = 用户调低 budget 后 rollback 到旧的大版本（自伤、仅成本、下轮 capture 自愈，
            # 故 LOW）。_truncate_to_budget 对 ≤budget 内容是恒等 no-op（行边界 + 闭合 code fence）。
            _mem_md = _truncate_to_budget(_mem_raw, cfg.memory_md_budget_chars)
            if _mem_md:
                memory_summary = _mem_md
                memory_summary_meta = {
                    "injected": 1,
                    "total": 1,
                    "chars": len(_mem_md),
                    "truncated": len(_mem_md) < len(_mem_raw),
                    "source": "memory.md",
                    "retired": False,
                }
                # 阶段 0.5-③（PR-2）读侧诊断：注入的这份文档已分层 → 每层 chars/budget
                # （identity 前置，与 fence 里的落盘序一致）。未分层（flag 从没开过 / 老文档）
                # → 不加这个键，别硬造一排 0。纯诊断，前端不读（同 meta 其余字段）。
                _layers = memory_layer_stats(_mem_md, cfg.memory_md_budget_chars)
                if _layers is not None:
                    memory_summary_meta["layers"] = _layers
        except Exception:  # noqa: BLE001 — best-effort; keep "" + retired meta（byte-identical to flag-off）
            pass
    # Phase -1 / 0A — config snapshot hashes for Phase 0 eval trace (reproducible
    # baseline). agentProfileHash = hash of the 4 editable profile docs' content
    # hashes; installedSkillsHash = builtin name|version signature + installed-rows
    # fingerprint. active_skills_hash is NOT here — it's client-side (depends on the
    # @mention session overlay + collision-exempt logic, plan §F). Best-effort: a
    # store/manifest hiccup → None (never fail /config — same discipline as memory).
    agent_profile_hash = None
    installed_skills_hash = None
    try:
        from src.agent_config.projections import compute_installed_skills_hash
        from src.agent_config.store import get_agent_config_store
        from src.skills.registry import build_manifest

        _agent_store = get_agent_config_store()
        agent_profile_hash = _agent_store.profile_hash()
        installed_skills_hash = compute_installed_skills_hash(
            build_manifest(None).skills, _agent_store
        )
    except Exception:  # noqa: BLE001 — hashes are best-effort; never fail /config
        agent_profile_hash = None
        installed_skills_hash = None
    # PR4 (task 06-22) — Standing Context assembled into ONE field: the 4 editable
    # docs SOUL+AGENT+RULES+USER joined in order (no per-request-varying bytes →
    # stable prompt-cache prefix). The TS harness prepends PRODUCT_SAFETY_FLOOR (a
    # code-owned const) ahead of this, so user docs can never weaken the floor.
    # Gated by MAILAGENT_STANDING_CONTEXT_ENABLED (hot-read .env, default ON). OFF /
    # store hiccup → "" → TS falls back to the legacy SOUL_MARKDOWN (byte-identical,
    # zero email-mode regression).
    standing_context = ""
    if _hot_bool(env_vals, "MAILAGENT_STANDING_CONTEXT_ENABLED", True):
        try:
            from src.agent_config.store import PROFILE_DOC_NAMES, get_agent_config_store

            _acs = get_agent_config_store()
            _parts = [_acs.get_profile_doc(n).content.strip() for n in PROFILE_DOC_NAMES]
            standing_context = "\n\n".join(p for p in _parts if p)
        except Exception:  # noqa: BLE001 — standing context is best-effort; never fail /config
            standing_context = ""
    # R4 (GPT-5.5 review) — observability: layered prompt is IN EFFECT iff standing_context
    # actually assembled (flag on AND store readable). When false, the TS harness falls back
    # to the byte-identical legacy SOUL_MARKDOWN. Lets dogfood / debug confirm which prompt
    # path a session ran without inspecting bytes.
    standing_context_active = bool(standing_context)
    # PR5 (task 06-22) — per-skill enable overrides (backend SSoT in agent_config.db,
    # replacing the old per-surface localStorage source). The runtime feeds these to
    # computeSkillEnablement instead of readSkillOverrides(). Only explicitly-toggled
    # skills appear (enabled non-null); absent → runtime falls back to the manifest
    # default_enabled. Best-effort: store hiccup → {} (never fail /config).
    # R6 (GPT-5.5 review) — on a store hiccup we ALSO flag skillOverridesAvailable=false.
    # An empty {} is ambiguous ("user toggled nothing" vs "store down"); the runtime must
    # not silently re-enable a user-DISABLED skill just because the override store blipped.
    # The flag lets the runtime reuse its last-known-good overrides instead of broadening.
    skill_overrides: Dict[str, bool] = {}
    skill_overrides_available = True
    try:
        from src.agent_config.projections import skill_overrides_map
        from src.agent_config.store import get_agent_config_store

        skill_overrides = skill_overrides_map(get_agent_config_store())
    except Exception:  # noqa: BLE001 — skill overrides are best-effort; never fail /config
        skill_overrides = {}
        skill_overrides_available = False
    # M4a (task 06-23) — advertised skill names for the AI SDK Gateway's skill→tool
    # gating (flag MAILAGENT_SKILL_SELF_MOUNT, read in electron main). = resolved
    # skills with enabled(override ?? default) AND available. Data-ownership split:
    # business state (which skills are visible to the model) is owned by Python; the
    # gateway owns the gateway-tool→skill map and drops a disabled skill's tools.
    # Best-effort: a store/manifest hiccup → None (NOT [] — [] means "all skills
    # disabled" = gate everything; None means "unknown" → the gateway fails OPEN,
    # no gating). The gated set is read-only tools; write/send keep flag+approval.
    advertised_skills: Optional[List[str]] = None
    trusted_skill_fragments: Optional[str] = None
    try:
        from src.agent_config.projections import advertised_skill_names
        from src.agent_config.store import get_agent_config_store
        from src.skills.registry import build_manifest, code_builtin_skills

        advertised_skills = advertised_skill_names(
            build_manifest(None).skills, get_agent_config_store()
        )
        # W6: only CODE-OWNED workflow skills are prompt-injected. Installed third-party fragments
        # remain excluded from the post-cutover gateway prompt. Reusing the advertised-skill result
        # makes the Settings toggle authoritative for both visibility and workflow guidance; an
        # empty string means every trusted skill is deliberately disabled.
        # 🔴 白名单是**集合**，不是再串一个 `or`：这里每加一个名字都是在扩大恒注入 prompt 的可信面，
        #    集合让「有哪些」一眼可数（漏改这里 = 新 builtin 的 prompt_fragment 进不了 system prompt，
        #    skill 挂了等于白挂）。
        advertised_set = set(advertised_skills)
        trusted_skill_fragments = "\n\n".join(
            skill.prompt_fragment.strip()
            for skill in code_builtin_skills()
            if skill.name in TRUSTED_PROMPT_FRAGMENT_SKILLS
            and skill.name in advertised_set
            and skill.prompt_fragment.strip()
        )
    except Exception:  # noqa: BLE001 — advertised skills are best-effort; never fail /config
        advertised_skills = None
        trusted_skill_fragments = None
    # 阶段 0.5「技能可发现性」—— 恒注入名单的数据源。渐进披露的第一级：模型先看见**有哪些技能**
    # （名 + 一句话 + 开关/可用态），要用时再 skill_read 拿全文。复用 resolved_skills（Settings 列表
    # / advertisedSkills 同一投影，不重写 enabled/available 判定），只出 prompt 需要的六个字段 ——
    # installDir / scopes / toolCount 属工具面，不进 system prompt。
    # 🔴 关掉的 skill **仍留在名单里**（enabled=false），不是消失：模型据此能回答「为什么做不了」，
    # 并提议 set_skill_enabled；名单消失 = 能力事实凭空蒸发（对齐 LobeHub pinned 防呆）。
    # 独立 try（不与 advertised 合并）：名单投影出岔不能顺带把 advertisedSkills 打成 None ——
    # 那会让 gateway 的 skill→tool 门控 fail-open，副作用远大于少一段 prompt。null = 未知 → TS 侧
    # 不渲染任何名单区块（prompt 字节级回退）。
    skill_catalog: Optional[List[Dict[str, Any]]] = None
    try:
        from src.agent_config.projections import resolved_skills
        from src.agent_config.store import get_agent_config_store
        from src.skills.registry import build_manifest

        skill_catalog = [
            {
                "name": s["name"],
                "title": s["title"],
                "description": s["description"],
                "enabled": s["enabled"],
                "available": s["available"],
                "unavailableReason": s["unavailableReason"],
            }
            for s in resolved_skills(build_manifest(None).skills, get_agent_config_store())
        ]
    except Exception:  # noqa: BLE001 — skill catalog is best-effort; never fail /config
        skill_catalog = None
    return success_envelope(
        {
            "maxIter": max_iter,
            "maxCostUsd": max_cost,
            "kosL1HotBlockEnabled": kos_l1_hot,
            "defaultModel": default_model,
            "kosConsumerEnabled": kos_consumer,
            "kosConfigured": kos_configured,
            "kosTimeDecayEnabled": kos_time_decay,
            "memorySummary": memory_summary,
            "memorySummaryMeta": memory_summary_meta,
            "enabledModels": enabled_models,
            "agentProfileHash": agent_profile_hash,
            "installedSkillsHash": installed_skills_hash,
            "standingContext": standing_context,
            "standingContextActive": standing_context_active,
            "skillOverrides": skill_overrides,
            "skillOverridesAvailable": skill_overrides_available,
            # M4a — advertised skill names for the gateway's skill→tool gating; null on
            # a store/manifest hiccup → gateway fails open (see advertised_skills above).
            "advertisedSkills": advertised_skills,
            # W6 — trusted, code-owned workflow guidance only. null means the enablement snapshot
            # was unavailable; "" means custom_agent is intentionally disabled. Never includes
            # user-installed prompt fragments.
            "trustedSkillFragments": trusted_skill_fragments,
            # 阶段 0.5 — 技能名单（全部 skill，含关掉的）。字段恒发；null = 投影不可得 → gateway 不
            # 渲染名单区块。是否真的进 system prompt 由 Node 侧 flag MAILAGENT_SKILL_CATALOG_PROMPT
            # 决定（main-env-only，默认 off）—— 本端点只负责给数据，不读那个 flag。
            "skillCatalog": skill_catalog,
            # M3c — user.md 偏好编译按钮显隐 gate（运行时暴露，非 vite define；
            # flag-off → 前端 UserMdCompileSection return null，整个区块在 DOM 不存在）。
            # singleton 读 —— 翻 MAILAGENT_USER_MD_COMPILE 需重启 serve-api（M3 flag 无 live writer，by design）
            "userMdCompileEnabled": cfg.user_md_compile_enabled,
            # Settings 身份文档编辑器显隐 gate（默认开，运行时暴露，非 vite define；
            # flag-off → 前端 StandingDocsSection return null，整个区块在 DOM 不存在）。
            # singleton 读 —— 翻 MAILAGENT_STANDING_DOCS_EDITOR 需重启 serve-api。
            "standingDocsEditorEnabled": cfg.standing_docs_editor_enabled,
            # task 08-20 — 设置页/onboarding「连接 Notion」OAuth 入口显隐 gate（kill-switch；
            # 不影响已写入的 NOTION_TOKEN / 库 ID 配置生效）。默认开。
            # singleton 读 —— 翻 MAILAGENT_NOTION_OAUTH 需重启 serve-api。
            "notionOauthEnabled": cfg.notion_oauth_enabled,
            # S2 W1 — Settings「自动化策略」区显隐 gate。MAILAGENT_OPENNESS_EXEC_TOOLS 是 main-env-only
            # flag（gateway 在 electron main 读，非 pydantic）；这里 hot-read 同一 .env 供前端显隐用
            # （flag-off → 前端 ExecPolicySection return null，整个区块在 DOM 不存在；字段恒发）。
            # 注意：这个字段只驱动「策略管理页」显隐，不改变 gateway 是否注册 exec 工具（那由 gateway
            # 自己读 flag 决定）。
            "execPolicyEnabled": _hot_bool(env_vals, "MAILAGENT_OPENNESS_EXEC_TOOLS", True),
            # S2 W4b — Settings「Skill 安装」区显隐 gate。MAILAGENT_OPENNESS_SKILL_INSTALL 同为
            # main-env-only flag（gateway 的 skill_install* 工具注册在 electron main 读，非 pydantic）；
            # 这里 hot-read 同一 .env 供前端显隐（flag-off → 前端 SkillPacksSection return null，
            # 整个区块在 DOM 不存在；字段恒发）。只驱动安装/管理 UI 显隐，不改变 gateway 是否注册工具。
            "skillInstallEnabled": _hot_bool(env_vals, "MAILAGENT_OPENNESS_SKILL_INSTALL", True),
            "skillCreatorEnabled": _hot_bool(env_vals, "MAILAGENT_SKILL_CREATOR", True),
            "agentPluginsEnabled": _hot_bool(env_vals, "MAILAGENT_AGENT_PLUGINS", True),
            # S5 — Settings「Custom AI Agents」建/改/run 历史入口显隐 gate。custom agent 内核 flag
            # MAILAGENT_CUSTOM_AGENTS_ENABLED（gateway CRUD 工具注册在 electron main 读，Python worker/
            # 端点走 pydantic）；这里 hot-read 同一 .env 供前端显隐（flag-off → 前端 CustomAgent 入口/
            # run 历史区不渲染；字段恒发）。镜像 skillInstallEnabled 的热读语义（默认取 pydantic 值）。
            "customAgentsEnabled": _hot_bool(
                env_vals, "MAILAGENT_CUSTOM_AGENTS_ENABLED", cfg.custom_agents_enabled
            ),
            "customAgentCallEnabled": _hot_bool(
                env_vals, "MAILAGENT_CUSTOM_AGENT_CALL", True
            ),
            "chatCompactEnabled": _hot_bool(env_vals, "MAILAGENT_CHAT_COMPACT", True),
            "chatAutoCompactEnabled": _hot_bool(
                env_vals, "MAILAGENT_CHAT_AUTO_COMPACT", True
            ),
            "chatQueuedInputEnabled": _hot_bool(
                env_vals, "MAILAGENT_CHAT_QUEUED_INPUT", True
            ),
            # R3 (task 07-05) — S1 openness 三分面 flag 的前端可观测投影。均为 main-env-only
            # flag（gateway 工具注册在 electron main 读 env，非 pydantic）；这里 hot-read 同一
            # .env，完全镜像 execPolicyEnabled 的读法。消费方：CustomAgentDrawer 的 grant_web
            # 控件（webToolsEnabled=false → 禁用 + 提示，消除「UI 授权但 gateway 未注册 web
            # 工具」的静默 no-op）+ Settings「系统能力」区显隐（R4）。字段恒发。
            "sessionToolsEnabled": _hot_bool(env_vals, "MAILAGENT_OPENNESS_SESSION_TOOLS", True),
            "configToolsEnabled": _hot_bool(env_vals, "MAILAGENT_OPENNESS_CONFIG_TOOLS", True),
            "webToolsEnabled": _hot_bool(env_vals, "MAILAGENT_OPENNESS_WEB_TOOLS", True),
            # P1 — 未读 UI 对 main-env-only MAILAGENT_SESSION_PROVENANCE 的只读投影。
            # Electron main 仍是 gateway 注册/身份注入的唯一决策点；这里仅镜像同一 .env，
            # 避免 renderer 通过 env snapshot 绕过 MANAGED_ENV_KEYS 白名单。
            "sessionProvenanceEnabled": _hot_bool(
                env_vals, "MAILAGENT_SESSION_PROVENANCE", True
            ),
            # 2026-08-19 cutover 后五个 venue env 闸退役；兼容旧 renderer，投影键保留恒 true。
            "mattersEnabled": True,
            "matterAgentEnabled": True,
            "contactsEnabled": True,
            "contactProfileEnabled": True,
            "contactAgentEnabled": True,
            "triggerV2Enabled": _hot_bool(env_vals, "MAILAGENT_TRIGGER_V2", True),
            "calendarTriggerEnabled": _hot_bool(
                env_vals, "MAILAGENT_CALENDAR_TRIGGER", True
            ),
            # task 07-12 P3 — Settings「模型服务」区（provider 管理 UI）+ 功能位选择器分组
            # 显隐 gate。与上面 enabledModels 的聚合投影**同源同语义**（pydantic 冻结单例读，
            # 翻 MAILAGENT_LLM_PROVIDER_REGISTRY 需重启 serve-api）——UI 门控与投影行为
            # 永不劈叉。flag off（显式 false 应急回退；默认 on 自 2026-07-13 cutover）→
            # 前端渲染旧 LLM 网关区，字节级现状。
            "providerRegistryEnabled": bool(
                getattr(cfg, "llm_provider_registry_enabled", False)
            ),
            # 08-01 阶段 1 PR4 — Settings「MCP 连接」区显隐 gate。MAILAGENT_MCP_CONNECTORS
            # 是 **pydantic** flag（不是 main-env-only）：/api/connector/* 的 _require_enabled
            # 读的就是这个单例，故这里同源 getattr 读（不走 _hot_bool —— 热读会与端点的
            # 冻结单例劈叉：UI 以为开着、端点照样 409）。翻开关需重启 serve-api。
            # flag off → 前端连接区不渲染；字段恒发。
            "connectorToolsEnabled": bool(getattr(cfg, "mcp_connectors_enabled", False)),
        },
        request=request,
        source="config",
    )


# ── chat 持久化写端点（V2.1 阶段 3 3b-3：ChatPersistPort 写面）──────────────
#
# serve-api 镜像 chat_db.ts 写函数（ChatDb 写方法 SQL verbatim 镜像）。**envelope**（非 SSE）。
# ai_chat.db schema 归前端 owns（chat_db.ts migrate），serve-api 只写既有表、不建 schema。
# 单读端点（getSession/getMessage/getToolCallByUseId）返 envelope data=row|null（不 404）——
# ChatPersistPort 契约是 ``| null``，null 是正常结果（尤其 getToolCallByUseId「没见过此
# tool_use_id」），区别于 reports.py「找不到=错误」的 404 语义。
# 写校验缺失 → APIError E_INVALID_ARG（malformed JSON 由全局 RequestValidationError handler
# → E_INVALID_ARG）。3b 不接 renderer（http persist 仅 3b-5 mock-fetch 测）→ 生产单 writer。
#
# 路由顺序：静态段（/sessions/new、/sessions/all[阶段2]）须在动态 {id:int} 之前能被匹配；
# ``:int`` 转换器已挡住非 int（"new"/"all" 不匹配 {id:int}），此处顺序兼顾可读性。


# P2c / Matters MVP P3 — anchor-aware session 入参校验。email（默认）→ emailId 必须非负
# int；general → 无 emailId；matter → matterId 必须正整数且无 emailId。下沉到
# db._resolve_anchor 仍 defense-in-depth，绝不接受 sentinel。
_SESSION_ANCHOR_TYPES = ("email", "general", "matter")


def _validate_session_opts(
    opts: Dict[str, Any], route: str
) -> tuple[str, Optional[int], Optional[int], str]:
    anchor_type = opts.get("anchorType") or "email"
    if anchor_type not in _SESSION_ANCHOR_TYPES:
        raise APIError(
            "E_INVALID_ARG",
            f"{route} requires anchorType in {{email, general, matter}}",
            source="sqlite",
        )
    email_id = opts.get("emailId")
    matter_id = opts.get("matterId")
    if anchor_type == "email":
        if not isinstance(email_id, int) or isinstance(email_id, bool) or email_id < 0:
            raise APIError(
                "E_INVALID_ARG",
                f"{route} email anchor requires emailId:int (non-negative)",
                source="sqlite",
            )
    elif anchor_type == "general":
        # codex review HIGH — reject a general anchor carrying ANY emailId (incl. 0);
        # don't silently drop it (that's the banned sentinel).
        if email_id is not None:
            raise APIError(
                "E_INVALID_ARG",
                f"{route} general anchor must not carry an emailId",
                source="sqlite",
            )
        # general session 无 emailId（CHECK 强制 email_id IS NULL）。
    else:
        if email_id is not None:
            raise APIError(
                "E_INVALID_ARG",
                f"{route} matter anchor must not carry an emailId",
                http_status=422,
                source="sqlite",
            )
        if (
            not isinstance(matter_id, int)
            or isinstance(matter_id, bool)
            or matter_id <= 0
        ):
            raise APIError(
                "E_INVALID_ARG",
                f"{route} matter anchor requires matterId:int (positive)",
                http_status=422,
                source="sqlite",
            )
    backend_kind = opts.get("backendKind")
    # P4 Phase 06a (cutover) — 'ai-sdk' is a valid persistable session kind (chat_db v13 widened the
    # CHECK); a chat authored through the embedded AI SDK Gateway. The serve-api only PERSISTS the
    # row here (the gateway runs the turn), so the allow-list must admit it in lock-step with the
    # SQLite CHECK, else creating an ai-sdk session over serve-api 400s.
    if backend_kind not in ("notion-agent", "custom-api", "ai-sdk"):
        raise APIError(
            "E_INVALID_ARG",
            f"{route} requires backendKind in {{notion-agent, custom-api, ai-sdk}}",
            source="sqlite",
        )
    return anchor_type, email_id, matter_id, backend_kind


@router.post("/sessions", dependencies=[Depends(verify_cf_access)])
async def open_session(request: Request, body: Optional[Dict[str, Any]] = None):
    """getOrCreateSession：复用既有 session 或新建。镜像 chat:getOrCreateSession → ChatSession。
    body = OpenSessionInput（camelCase；anchorType: 'email'|'general'|'matter'，缺省 'email'）。"""
    opts = body or {}
    anchor_type, email_id, matter_id, backend_kind = _validate_session_opts(opts, "sessions")
    session = get_chat_db().get_or_create_session(
        email_id=email_id,
        backend_kind=backend_kind,
        backend_model=opts.get("backendModel"),
        backend_agent_page_id=opts.get("backendAgentPageId"),
        anchor_type=anchor_type,
        matter_id=matter_id,
    )
    return success_envelope(session, request=request, source="sqlite")


# P4b —「能对话」成员的判据单源是前端 teamMembers.ts（canChat：design §8.0「接对话的
# 只剩四类」）。服务端不信前端，这里按同判据校验 —— 两处集合漂移时团队页能建的会话
# 服务端会拒（400 可见），不会静默放行一个不该有对话面的 agent（如 preprocess/search）。
_CHAT_CAPABLE_AGENT_TYPES = ("report", "contact_profile", "contact_governance", "custom")


def _require_chat_capable(agent_id: str, *, what: str) -> None:
    """agent 必须存在且「能对话」，否则 400。``what`` 只进 message（建群 / 加人两个入口的措辞）。"""
    # 主 agent 是保留成员 id：它没有 report_agent 行（身份在 owner_settings.assistant_identity），
    # 走下面的 get_agent 必然 None → 400。放行判据是**逐字相等**，不是前缀 / 命名空间 ——
    # 保留字与真实 agent id 的碰撞在 ReportStore.create_agent（唯一写点）那里拒掉。
    if agent_id == MAIN_AGENT_MEMBER_ID:
        return
    agent = get_report_store().get_agent(agent_id)
    if agent is None or (agent.get("type") or "") not in _CHAT_CAPABLE_AGENT_TYPES:
        raise APIError(
            "E_INVALID_ARG",
            f"{what} {agent_id!r} missing or not chat-capable",
            source="sqlite",
        )


async def create_session_validated(opts: Dict[str, Any]) -> Dict[str, Any]:
    """POST /chat/sessions/new 的权威校验 + create_new_session（红线 5：群校验只有这一条路径）。
    opts 键 = HTTP body 键（anchorType / emailId / backendKind / agentId / groupMembers / title / parentSessionId / invokedBy）。

    createNewSession：无条件 INSERT 新 session（绕过复用）。镜像 chat:newSession → ChatSession。
    P2c / Matters MVP P3：支持 general 与 matter anchor。

    P4b：``agentId`` 非空 = 团队页「以指定 agent 身份」的交互式会话 → 行落
    origin='team' + agent_id（恒 general anchor）。身份此后由 gateway 按 sessionId
    反查（S2 W0：绝不从 chat body 读）。

    v30（群聊）：``groupMembers`` 非空 = custom agents 群聊会话 → 行落 origin='group' +
    members_json（恒 general anchor；与 agentId 互斥）。逐成员按 _CHAT_CAPABLE_AGENT_TYPES
    校验（不接对话的三位 preprocess/project_progress/search 在此被拒），成员数上限
    MAX_GROUP_MEMBERS。``title`` = 建群初始标题（可选；仅 str 转发）。

    g2（agent 群工具面）：``parentSessionId`` 非空 = 子群 —— 父必须是群、成员必须 ⊆ 父群、
    只允许一层嵌套；``invokedBy`` ∈ SESSION_INVOKED_BY = 这条会话由谁发起。两者的权威校验
    全在这里（红线 5：gateway 的建群工厂不复制成员 / 子集 / 嵌套判定），失败一律
    E_INVALID_ARG + hint。子群数上限（SUBGROUPS_PER_FAMILY_CAP）**不在这里判**：那是法官
    一轮之内的配额，只有 gateway 的工厂实例数得清。"""
    anchor_type, email_id, matter_id, backend_kind = _validate_session_opts(
        opts, "sessions/new"
    )
    agent_id = opts.get("agentId")
    if agent_id is not None:
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise APIError(
                "E_INVALID_ARG",
                "sessions/new agentId must be a non-empty string",
                source="sqlite",
            )
        if anchor_type != "general":
            raise APIError(
                "E_INVALID_ARG",
                "sessions/new agent sessions must use the general anchor",
                source="sqlite",
            )
        _require_chat_capable(agent_id, what="agent")
    group_members = opts.get("groupMembers")
    if group_members is not None:
        if agent_id is not None:
            raise APIError(
                "E_INVALID_ARG",
                "sessions/new groupMembers and agentId are mutually exclusive",
                source="sqlite",
            )
        if (
            not isinstance(group_members, list)
            or not group_members
            or any(not isinstance(m, str) or not m.strip() for m in group_members)
        ):
            raise APIError(
                "E_INVALID_ARG",
                "sessions/new groupMembers must be a non-empty string array",
                source="sqlite",
            )
        if len(group_members) > MAX_GROUP_MEMBERS:
            raise APIError(
                "E_INVALID_ARG",
                f"sessions/new groupMembers supports at most {MAX_GROUP_MEMBERS} members",
                source="sqlite",
            )
        if len(set(group_members)) != len(group_members):
            raise APIError(
                "E_INVALID_ARG",
                "sessions/new groupMembers must be unique",
                source="sqlite",
            )
        if anchor_type != "general":
            raise APIError(
                "E_INVALID_ARG",
                "sessions/new group sessions must use the general anchor",
                source="sqlite",
            )
        for member_id in group_members:
            _require_chat_capable(member_id, what="group member")
    parent_session_id = opts.get("parentSessionId")
    invoked_by = opts.get("invokedBy")
    if parent_session_id is not None:
        if group_members is None:
            raise APIError(
                "E_INVALID_ARG",
                "sessions/new parentSessionId requires groupMembers",
                hint="只有群会话能有父群",
                source="sqlite",
            )
        if (
            not isinstance(parent_session_id, int)
            or isinstance(parent_session_id, bool)
            or parent_session_id <= 0
        ):
            raise APIError(
                "E_INVALID_ARG",
                "sessions/new parentSessionId must be a positive integer",
                source="sqlite",
            )
        # 🔴 父不存在也是 400（不复用 _require_group_session：它对缺失 id 抛 404，而
        # 「父群写错了」与「这条路由不存在」是两回事，UI 拿 404 只会显示通用错误）。
        parent = get_chat_db().get_session(parent_session_id)
        if parent is None or (parent.get("origin") or "") != "group":
            raise APIError(
                "E_INVALID_ARG",
                f"sessions/new parentSessionId {parent_session_id} is not a group session",
                hint="父会话必须是一个群（origin='group'）",
                source="sqlite",
            )
        if parent.get("parent_session_id") is not None:
            raise APIError(
                "E_INVALID_ARG",
                "sessions/new subgroups may not nest (parent already has a parent)",
                hint="子群不能再有子群（只允许一层嵌套）",
                source="sqlite",
            )
        parent_members = set(parse_group_member_ids(parent.get("members_json")))
        extra = [m for m in group_members if m not in parent_members]
        if extra:
            raise APIError(
                "E_INVALID_ARG",
                f"sessions/new subgroup members must be a subset of the parent group: {extra}",
                hint="子群成员必须都在父群里",
                source="sqlite",
            )
    if invoked_by is not None and invoked_by not in SESSION_INVOKED_BY:
        raise APIError(
            "E_INVALID_ARG",
            f"sessions/new invokedBy must be one of {list(SESSION_INVOKED_BY)}",
            source="sqlite",
        )
    title = opts.get("title")
    session = get_chat_db().create_new_session(
        email_id=email_id,
        backend_kind=backend_kind,
        backend_model=opts.get("backendModel"),
        backend_agent_page_id=opts.get("backendAgentPageId"),
        anchor_type=anchor_type,
        matter_id=matter_id,
        agent_id=agent_id,
        group_members=group_members,
        title=title if isinstance(title, str) and title.strip() else None,
        parent_session_id=parent_session_id,
        invoked_by=invoked_by,
    )
    return session


@router.post("/sessions/new", dependencies=[Depends(verify_cf_access)])
async def new_session(request: Request, body: Optional[Dict[str, Any]] = None):
    """校验与写入全在 create_session_validated；这里只取 body → 调它 → 包 envelope。"""
    return success_envelope(
        await create_session_validated(body or {}), request=request, source="sqlite"
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
    session = get_chat_db().get_session(session_id)
    if isinstance(session, dict) and session.get("anchor_type") == "matter":
        anchor_id = session.get("anchor_id")
        row = (
            _matter_meta_for_sessions(
                [anchor_id], get_settings().sync_store_db_path
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
    get_chat_db().delete_session(session_id)
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
    get_chat_db().update_session_title(session_id, title)
    return success_envelope({"updated": True}, request=request, source="sqlite")


def _require_group_session(session_id: int) -> Dict[str, Any]:
    """群端点的共用前置：会话必须存在且 origin='group'，返回该行。

    🔴 非群会话一律 400 而不是「按空群处理」——群设置写到普通会话行上是静默的数据污染
    （那一列在别的读面上不显示，谁都不会发现）。"""
    session = get_chat_db().get_session(session_id)
    if session is None:
        raise APIError("E_NOT_FOUND", f"session {session_id} not found", source="sqlite")
    if (session.get("origin") or "") != "group":
        raise APIError(
            "E_INVALID_ARG", f"session {session_id} is not a group session", source="sqlite"
        )
    return session


def _group_member_ids(session: Dict[str, Any]) -> List[str]:
    """``members_json`` → 成员 id 列表（宽容解析，与 TS ``parseGroupMemberIds`` 同口径：
    坏 JSON / 非数组 / 非字符串项一律丢弃 → 空名单 = 任何 modes 键都不合法）。"""
    return parse_group_member_ids(session.get("members_json"))


def _require_id_list(value: Any, field: str) -> List[str]:
    """``{add, remove}`` 的一项 → 去空白后的 id 列表。非数组 / 非字符串项 / 组内重复 → 400。"""
    if value is None:
        return []
    if not isinstance(value, list) or any(
        not isinstance(m, str) or not m.strip() for m in value
    ):
        raise APIError(
            "E_INVALID_ARG",
            f"group-members {field} must be an array of agent ids",
            hint=f"{field} 只接受非空字符串数组（省略该键 = 不动）",
            source="sqlite",
        )
    ids = [m.strip() for m in value]
    if len(set(ids)) != len(ids):
        raise APIError(
            "E_INVALID_ARG",
            f"group-members {field} must not repeat an agent id",
            hint=f"{field} 里有重复的成员 id",
            source="sqlite",
        )
    return ids


@router.patch(
    "/sessions/{session_id:int}/group-members", dependencies=[Depends(verify_cf_access)]
)
async def patch_group_members(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """群成员写面：加人 / 踢人。body = ``{add?: [agentId], remove?: [agentId]}``（至少一项非空）。

    **权威校验全在这里**（红线 5：UI 只是礼貌提示）：会话必须 origin='group'；add 的每一位
    必须存在且 chat-capable；add 不许已在群里；remove 必须都在群里；add ∩ remove = ∅；
    结果名单 1 ≤ len ≤ MAX_GROUP_MEMBERS（空群拒 —— 没有成员的群谁都唤不醒，只会静默不回）。
    全部 4xx 走 ``E_INVALID_ARG`` + ``hint``，**不新增错误码**：没在 ERROR_CODE_TO_HTTP 登记的
    码会被 app.py 兜底成 500，UI 拿到的就是「服务器错误」而不是「这个人已经在群里了」。

    新名单 = 原序 − remove + add（append 到尾）—— 成员序就是无 @ 时的回复序，加人不该打乱
    既有顺序。踢掉法官 → ``judgeAgentId`` 与 ``judgeScopeHash`` 一并清空（没有法官就没有免卡
    锚）；踢的不是法官 → hash **不动**，于是自然失配 = ``judgeScopeStale``，UI 提示重新确认。
    """
    session = _require_group_session(session_id)
    opts = body or {}
    add = _require_id_list(opts.get("add"), "add")
    remove = _require_id_list(opts.get("remove"), "remove")
    if not add and not remove:
        raise APIError(
            "E_INVALID_ARG",
            "group-members requires a non-empty add or remove",
            hint="body 至少要有一个非空的 add 或 remove",
            source="sqlite",
        )
    overlap = [m for m in add if m in remove]
    if overlap:
        raise APIError(
            "E_INVALID_ARG",
            f"group-members add and remove overlap: {overlap}",
            hint="同一个成员不能同时加和踢",
            source="sqlite",
        )
    members = _group_member_ids(session)
    for member_id in add:
        _require_chat_capable(member_id, what="group member")
        if member_id in members:
            raise APIError(
                "E_INVALID_ARG",
                f"group-members {member_id!r} is already a member",
                hint="该成员已经在群里了",
                source="sqlite",
            )
    missing = [m for m in remove if m not in members]
    if missing:
        raise APIError(
            "E_INVALID_ARG",
            f"group-members cannot remove non-members: {missing}",
            hint="要移出的成员不在这个群里（名单可能刚被别处改过，刷新再试）",
            source="sqlite",
        )
    next_members = [m for m in members if m not in remove] + add
    if not next_members:
        raise APIError(
            "E_INVALID_ARG",
            "group-members cannot remove the last member",
            hint="群至少要留一位成员；不要这个群就整个删掉",
            source="sqlite",
        )
    if len(next_members) > MAX_GROUP_MEMBERS:
        raise APIError(
            "E_INVALID_ARG",
            f"group-members supports at most {MAX_GROUP_MEMBERS} members",
            hint=f"已达成员上限（{MAX_GROUP_MEMBERS}）",
            source="sqlite",
        )

    db = get_chat_db()
    config = dict(db.get_group_config(session_id)["config"])
    # 🔴 cleared = remove ∪ add：add 也删行，清掉 gateway 在踢人窗口里 INSERT OR IGNORE 重建的
    # 残留游标行（见 ChatDb.update_group_members 的头注）。
    db.update_group_members(session_id, next_members, [*remove, *add])
    if config.get("judgeAgentId") in remove:
        config["judgeAgentId"] = None
        config["judgeScopeHash"] = None
        db.update_group_config(session_id, config)
    return success_envelope(db.get_group_config(session_id), request=request, source="sqlite")


@router.get(
    "/sessions/{session_id:int}/group-turns", dependencies=[Depends(verify_cf_access)]
)
async def get_group_turns(
    request: Request,
    session_id: int,
    limit: int = Query(200, ge=1, le=500),
    before: Optional[int] = Query(None, ge=1),
    since: Optional[int] = Query(None, ge=0),
):
    """turn 台账只读分页（新→旧）：``{turns, hasMore}``。

    renderer 靠它在刷新后还原「沉默 / 重复折叠 / 跳过 / 失败 / 停止」那些**没有落库消息**的
    turn（红线 1：在场态只能来自服务端事实，前端不推断）。``before`` = 上一页最旧一行的 id；
    ``since`` = 只要 ``started_at >= since`` 的行，renderer 恒传「最早一条落库消息的时间」，
    使清空历史后旧 meta 行不再回到对话里。未迁移的旧库 → 空结果。"""
    _require_group_session(session_id)
    return success_envelope(
        get_chat_db().list_group_turns(
            session_id, limit=limit, before_id=before, since_ms=since
        ),
        request=request,
        source="sqlite",
    )


@router.get("/sessions/{session_id:int}/group-config", dependencies=[Depends(verify_cf_access)])
async def get_group_config(request: Request, session_id: int):
    """群设置读面（g1，CHAT_DB v31）：``{modes, config}``。

    ``modes`` 只含**有行**的成员（缺行 = 'mention'，PRD Q1，读侧兜底）；``config`` 为
    ``group_config_json`` 解析结果，NULL / 脏 JSON → ``{"v": 1}`` = 全取出厂默认（默认值单源在
    ``ai-gateway/groupFloors.ts``，服务端不抄一份数值）。非群会话 400。"""
    _require_group_session(session_id)
    return success_envelope(
        get_chat_db().get_group_config(session_id), request=request, source="sqlite"
    )


@router.put("/sessions/{session_id:int}/group-config", dependencies=[Depends(verify_cf_access)])
async def put_group_config(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """群设置写面（g1）：响应模式 + 法官位 + 链上限 / 小时预算 + 用途 / 全群模型 / 通知。

    body = ``{modes?, judgeAgentId?, chainCap?, hourlyTurns?, hourlyTokens?, hourlyUsd?,
    sessionTurnCap?, topic?, modelOverride?, notify?}``（全部可选，只写传了的键）。
    **权威校验在服务端**：会话必须 origin='group'；modes 的键必须 ⊆ 本群 members_json；
    judgeAgentId 必须 ∈ members 或 null；响应模式值域按 ``group_limits.RESPONSE_MODES``；
    chainCap ∈ [CHAIN_CAP_MIN, CHAIN_CAP_MAX]。

    **显式 null = 删键**（不是存 None）：五个数值键 + topic / modelOverride / notify 传 null
    （或空白字符串）都从 JSON 里 pop 掉 = 恢复出厂默认。存 None 会让读侧分不清「owner 清回
    默认」与「owner 设了个空值」，且默认值副本一旦落库就与 groupFloors.ts 的单源脱钩。

    🔴 judgeAgentId 只要**传了**就重写 ``judgeScopeHash = sha256(members_json 原文)`` —— 这是
    g2 法官免卡的锚（成员名单一变 hash 就失配，法官的建群/投递工具直接拒绝而不是弹一张无人
    在场的卡）。传同值也重写 = 群详情面「重新确认法官位」的写法（g1 只在变更时写，那样
    owner 就没有任何办法在改完名单后重新确认）。

    modes 走**列级 UPSERT**（``upsert_group_member_modes``，语句里没有 seen_through_id）——
    见 src/chat/db.py 头注的两写者纪律。"""
    session = _require_group_session(session_id)
    opts = body or {}
    members = _group_member_ids(session)
    db = get_chat_db()
    current = db.get_group_config(session_id)
    config: Dict[str, Any] = dict(current["config"])

    modes = opts.get("modes")
    if modes is not None:
        if not isinstance(modes, dict):
            raise APIError("E_INVALID_ARG", "group-config modes must be an object", source="sqlite")
        for agent_id, mode in modes.items():
            if agent_id not in members:
                raise APIError(
                    "E_INVALID_ARG",
                    f"group-config modes key {agent_id!r} is not a member of this group",
                    source="sqlite",
                )
            if mode not in RESPONSE_MODES:
                raise APIError(
                    "E_INVALID_ARG",
                    f"group-config response mode must be one of {list(RESPONSE_MODES)}",
                    source="sqlite",
                )

    if "judgeAgentId" in opts:
        judge = opts.get("judgeAgentId")
        if judge is not None and (not isinstance(judge, str) or judge not in members):
            raise APIError(
                "E_INVALID_ARG",
                "group-config judgeAgentId must be a member of this group or null",
                source="sqlite",
            )
        config["judgeAgentId"] = judge
        # 名单原文（不是解析后再序列化）—— hash 要钉的就是「owner 确认时看到的那份名单」。
        raw_members = session.get("members_json") or ""
        config["judgeScopeHash"] = (
            group_scope_hash(raw_members) if judge is not None else None
        )

    for key, low, high in (
        ("chainCap", CHAIN_CAP_MIN, CHAIN_CAP_MAX),
        ("hourlyTurns", 1, 100_000),
        ("hourlyTokens", 1, 100_000_000),
        ("sessionTurnCap", 1, 100_000),
    ):
        if key not in opts:
            continue
        value = opts.get(key)
        if value is None:
            config.pop(key, None)
            continue
        if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
            raise APIError(
                "E_INVALID_ARG",
                f"group-config {key} must be an integer in [{low}, {high}]",
                source="sqlite",
            )
        config[key] = value

    if "hourlyUsd" in opts:
        usd = opts.get("hourlyUsd")
        if usd is None:
            config.pop("hourlyUsd", None)
        elif isinstance(usd, bool) or not isinstance(usd, (int, float)) or not 0 < usd <= 1000:
            raise APIError(
                "E_INVALID_ARG",
                "group-config hourlyUsd must be a number in (0, 1000]",
                source="sqlite",
            )
        else:
            config["hourlyUsd"] = float(usd)

    for key, max_chars in (
        ("topic", TOPIC_MAX_CHARS),
        ("modelOverride", MODEL_OVERRIDE_MAX_CHARS),
    ):
        if key not in opts:
            continue
        value = opts.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            # 空白 = 没填 = 删键（UI 的输入框清空与显式 null 走同一条路，读侧只有「有值 / 没值」）。
            config.pop(key, None)
            continue
        if not isinstance(value, str):
            raise APIError(
                "E_INVALID_ARG",
                f"group-config {key} must be a string or null",
                hint=f"{key} 只接受字符串；清空传 null",
                source="sqlite",
            )
        trimmed = value.strip()
        if len(trimmed) > max_chars:
            raise APIError(
                "E_INVALID_ARG",
                f"group-config {key} must be at most {max_chars} characters",
                hint=f"最多 {max_chars} 个字符（当前 {len(trimmed)}）",
                source="sqlite",
            )
        config[key] = trimmed

    if "notify" in opts:
        notify = opts.get("notify")
        if notify is None:
            config.pop("notify", None)
        elif not isinstance(notify, bool):
            raise APIError(
                "E_INVALID_ARG",
                "group-config notify must be a boolean or null",
                hint="notify 只接受 true / false；恢复默认传 null",
                source="sqlite",
            )
        else:
            config["notify"] = notify

    db.update_group_config(session_id, config)
    if modes:
        db.upsert_group_member_modes(session_id, modes)
    return success_envelope(db.get_group_config(session_id), request=request, source="sqlite")


@router.get("/sessions/{session_id:int}/group-metrics", dependencies=[Depends(verify_cf_access)])
async def get_group_metrics(request: Request, session_id: int):
    """群成本两指标 + 两个滚动窗口（g1，只读 ``ai_chat_group_turn``，design §6）。

    先于级联上线（红线 4：先量得出来再让 agent 互相唤醒）。指标口径见
    ``ChatDb.group_metrics``；未迁移的旧库返空窗口而不是报错。"""
    _require_group_session(session_id)
    return success_envelope(
        get_chat_db().group_metrics(session_id), request=request, source="sqlite"
    )


# ── 话题 thread（T3，CHAT_DB v32）───────────────────────────────────────────
#
# 话题 = 从群里某一条消息开出来的**独立上下文子会话**（``invoked_by='thread'``）。发言 / 停止 /
# 已读 / 改名 / 删除 / 列消息全部复用既有的会话端点（话题 id 与群 id 同一个命名空间），所以这里
# 只有两个新端点：建话题、列本群的话题。
#
# 🔴 契约：
#   • 顶层群限定 —— 父群必须 ``parent_session_id IS NULL``；在子群 / 话题上开话题一律 400
#     （单层嵌套校验不放宽：family 的定义与停止通道都建立在「至多一层」上）。
#   • 根消息必须属于该群且 ``role in ('user','assistant')``。
#   • 同一条根消息重复 POST 是**幂等**的：返回已有话题（200），不是 409，也不建第二个
#     —— 落库根据是 v32 的唯一部分索引 ``idx_chat_sessions_thread_root``。
#   • 建行走 ``create_session_validated``（members 取父群快照、``group_config_json`` 复制父群、
#     title = 根消息前 ``THREAD_TITLE_MAX_CHARS`` 字），**不复制** ``ai_chat_group_member`` 行
#     （话题内的唤醒是参与者制，由 gateway 按事实推导）。
#   • 创建者的 ``last_read_at`` 写成 now —— 否则「没打开过不算未读」的口径会让别人回的第一条
#     永远不亮。
def _thread_title(content: Any) -> str:
    """根消息正文 → 话题标题（连续空白折成一个空格后截 ``THREAD_TITLE_MAX_CHARS`` 字）。

    截在**服务端**：标题作为 ``title`` 列落库，前端只显示那一列，不自己再截一刀（没有第二处
    手抄，所以 THREAD_TITLE_MAX_CHARS 不进 parity 闸）。正文为空（只带附件的消息）→ 空串，
    ``create_session_validated`` 会把它落成 NULL —— 读侧照 ``title or ''`` 拿到空串，由前端
    决定显示什么，这里不编一个服务端中文兜底字符串。"""
    return " ".join(str(content or "").split())[:THREAD_TITLE_MAX_CHARS]


def _thread_summary(row: Dict[str, Any]) -> Dict[str, Any]:
    """``ChatDb.list_threads`` 的一行 → ``GroupThreadSummary``（形状见 shared/chat_model.ts）。

    ``unread`` 与群行同口径：``last_read_at IS NOT NULL`` 且 ``updated_at > last_read_at``
    —— 「从没打开过」不算未读（建话题时创建者的 last_read_at 已写成 now）。"""
    updated_at = int(row.get("updated_at") or 0)
    last_read_at = row.get("last_read_at")
    content = row.get("last_message_content")
    role = row.get("last_message_role")
    return {
        "sessionId": int(row["session_id"]),
        "rootMessageId": int(row["root_message_id"]),
        "title": row.get("title") or "",
        "replyCount": int(row.get("reply_count") or 0),
        # 两列任一为 NULL = 话题里还没有 user/assistant 行（刚开出来的话题）。
        "lastMessage": None
        if content is None or role is None
        else {
            "role": role,
            "content": content,
            "speakerAgentId": row.get("last_message_speaker_agent_id"),
            "createdAt": int(row.get("last_message_created_at") or 0),
        },
        "updatedAt": updated_at,
        "unread": last_read_at is not None and updated_at > int(last_read_at),
    }


@router.post("/sessions/{session_id:int}/threads", dependencies=[Depends(verify_cf_access)])
async def create_group_thread(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """建话题（body ``{rootMessageId: int}``）→ ``{sessionId, rootMessageId, title}``。"""
    db = get_chat_db()
    group = _require_group_session(session_id)
    if group.get("parent_session_id") is not None:
        raise APIError(
            "E_INVALID_ARG",
            f"session {session_id} is not a top-level group",
            hint="话题只能开在顶层群（子群 / 话题里不能再开话题）",
            source="sqlite",
        )
    root_message_id = (body or {}).get("rootMessageId")
    if (
        not isinstance(root_message_id, int)
        or isinstance(root_message_id, bool)
        or root_message_id <= 0
    ):
        raise APIError(
            "E_INVALID_ARG",
            "threads requires rootMessageId:int (positive)",
            source="sqlite",
        )
    message = db.get_message(root_message_id)
    # 🔴 「消息不存在」与「消息属于**别的**会话」是同一个 400：话题的根必须在这个群里，
    # 否则话题卡会挂到一条谁都看不见的消息下面（而且 family 预算算到别人头上）。
    if message is None or int(message.get("session_id") or 0) != session_id:
        raise APIError(
            "E_INVALID_ARG",
            f"message {root_message_id} does not belong to group {session_id}",
            hint="根消息必须是这个群里的一条消息",
            source="sqlite",
        )
    if (message.get("role") or "") not in ("user", "assistant"):
        raise APIError(
            "E_INVALID_ARG",
            f"message {root_message_id} is not a user/assistant message",
            hint="只能在人或成员说的话上开话题（system 行是编排痕迹）",
            source="sqlite",
        )
    existing = db.find_thread_by_root(session_id, root_message_id)
    if existing is not None:
        # 幂等：「开话题」与「进已有话题」是同一个动作，重复 POST 返回已有的那个（不是 409）。
        return success_envelope(
            {
                "sessionId": int(existing["id"]),
                "rootMessageId": root_message_id,
                "title": existing.get("title") or "",
            },
            request=request,
            source="sqlite",
        )
    title = _thread_title(message.get("content"))
    thread = await create_session_validated(
        {
            "anchorType": "general",
            "emailId": None,
            "backendKind": group.get("backend_kind") or "ai-sdk",
            # 父群名单的**快照**（此后加人 / 踢人不追平话题：话题是那一刻这群人的一段讨论）。
            "groupMembers": _group_member_ids(group),
            "title": title,
            "parentSessionId": session_id,
            "invokedBy": "thread",
        }
    )
    thread_id = int(thread["id"])
    try:
        db.attach_thread_root(thread_id, root_message_id, group.get("group_config_json"))
    except sqlite3.IntegrityError:
        # 并发的第二个 POST：唯一部分索引挡住了第二个话题（先查再建的检查挡不住这个窗口）。
        # 回收刚 INSERT 的空壳行，返回先到的那一个 —— 幂等对并发同样成立。
        db.delete_session(thread_id)
        winner = db.find_thread_by_root(session_id, root_message_id)
        if winner is None:
            raise
        return success_envelope(
            {
                "sessionId": int(winner["id"]),
                "rootMessageId": root_message_id,
                "title": winner.get("title") or "",
            },
            request=request,
            source="sqlite",
        )
    return success_envelope(
        {"sessionId": thread_id, "rootMessageId": root_message_id, "title": title},
        request=request,
        source="sqlite",
    )


@router.get("/sessions/{session_id:int}/threads", dependencies=[Depends(verify_cf_access)])
async def list_group_threads(request: Request, session_id: int):
    """列本群的话题（新→旧）→ ``GroupThreadSummary[]``（形状见 shared/chat_model.ts）。

    子群 / 话题上调用返回 ``[]``（它们底下不可能有话题）—— 读面不因此报错。"""
    _require_group_session(session_id)
    items = [_thread_summary(row) for row in get_chat_db().list_threads(session_id)]
    return success_envelope(
        items, request=request, source="sqlite", meta_extra={"count": len(items)}
    )


@router.patch("/sessions/{session_id:int}/read", dependencies=[Depends(verify_cf_access)])
async def update_session_read(request: Request, session_id: int):
    """markSessionRead（harness-chat lane A B4，task 07-15）：置 last_read_at=now（ai_chat.db v20）。
    未读徽标判定 = updated_at > last_read_at；刻意不 bump updated_at（已读不重排历史）。
    改不存在的 id / pre-v20 库缺列均静默返 {updated: True}（best-effort UX 面，绝不 500）。"""
    get_chat_db().update_session_last_read(session_id)
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
    get_chat_db().update_session_model(session_id, model or None)
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
    get_chat_db().update_session_archived(session_id, archived)
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
    get_chat_db().update_session_pinned(session_id, pinned)
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
    get_chat_db().update_session_starred(session_id, starred)
    return success_envelope({"updated": True}, request=request, source="sqlite")


@router.post("/sessions/{session_id:int}/messages", dependencies=[Depends(verify_cf_access)])
async def append_message(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """appendMessage：INSERT 一条消息 + bump session updated_at。镜像 chat_db appendMessage →
    ChatMessage。body = AppendMessageInput（camelCase，去 sessionId — 取自 path）。"""
    opts = body or {}
    role = opts.get("role")
    content = opts.get("content")
    status = opts.get("status")
    if not isinstance(role, str) or not role:
        raise APIError("E_INVALID_ARG", "messages requires role:str", source="sqlite")
    if not isinstance(content, str):  # "" 合法（NOT NULL 不是 non-empty）
        raise APIError("E_INVALID_ARG", "messages requires content:str", source="sqlite")
    if not isinstance(status, str) or not status:
        raise APIError("E_INVALID_ARG", "messages requires status:str", source="sqlite")
    msg = get_chat_db().append_message(
        session_id=session_id,
        role=role,
        content=content,
        status=status,
        model=opts.get("model"),
        tokens_input=opts.get("tokensInput"),
        tokens_output=opts.get("tokensOutput"),
        cost_usd=opts.get("costUsd"),
        error_message=opts.get("errorMessage"),
        metadata=opts.get("metadata"),
    )
    return success_envelope(msg, request=request, source="sqlite")


@router.patch("/messages/{message_id:int}/stream", dependencies=[Depends(verify_cf_access)])
async def stream_content(
    request: Request, message_id: int, body: Optional[Dict[str, Any]] = None
):
    """streamContent：仅更新 content（流式增量）。镜像 chat_db updateMessage 的 content-only 子集。
    HttpChatPlatform 在此端点上做 debounce（~1/s 合并 PATCH，3b-5）。"""
    opts = body or {}
    content = opts.get("content")
    if not isinstance(content, str):
        raise APIError("E_INVALID_ARG", "stream requires content:str", source="sqlite")
    get_chat_db().update_message(message_id, {"content": content})
    return success_envelope({"ok": True}, request=request, source="sqlite")


@router.patch("/messages/{message_id:int}", dependencies=[Depends(verify_cf_access)])
async def finalize_message(
    request: Request, message_id: int, body: Optional[Dict[str, Any]] = None
):
    """finalizeMessage：终态 patch（status/content/token/cost/model/metadata/error 任意子集）。
    镜像 chat_db updateMessage 全字段。body = UpdateMessagePatch（camelCase；省略的 key 不更新
    = TS undefined 语义）。**缺 body（None / JSON null）→ E_INVALID_ARG**（PATCH 必须带 patch
    对象，对齐写端点「body 校验缺失→E_INVALID_ARG」纪律）；显式空对象 {} → no-op（对齐
    chat_db.ts updateMessage 无字段早返）。codex review LOW。"""
    if body is None:
        raise APIError(
            "E_INVALID_ARG", "messages PATCH requires a patch object body", source="sqlite"
        )
    get_chat_db().update_message(message_id, body)
    return success_envelope({"ok": True}, request=request, source="sqlite")


@router.delete(
    "/sessions/{session_id:int}/messages/from/{from_message_id:int}",
    dependencies=[Depends(verify_cf_access)],
)
async def delete_messages_from(request: Request, session_id: int, from_message_id: int):
    """deleteMessagesFromId：删 from_message_id 及之后所有消息（行内编辑重跑）。镜像 chat_db
    deleteMessagesFromId → {deleted: count}。"""
    count = get_chat_db().delete_messages_from_id(session_id, from_message_id)
    return success_envelope({"deleted": count}, request=request, source="sqlite")


@router.post("/sessions/{session_id:int}/abort", dependencies=[Depends(verify_cf_access)])
async def abort_streaming(request: Request, session_id: int):
    """abortStreamingMessages：把 pending/streaming 消息标 aborted。镜像 chat_db
    abortStreamingMessages → {aborted: count}。"""
    count = get_chat_db().abort_streaming_messages(session_id)
    return success_envelope({"aborted": count}, request=request, source="sqlite")


@router.post("/messages/{message_id:int}/tool-calls", dependencies=[Depends(verify_cf_access)])
async def append_tool_call(
    request: Request, message_id: int, body: Optional[Dict[str, Any]] = None
):
    """appendToolCall：INSERT 一条工具调用审计行。镜像 chat_db appendToolCall → ChatToolCall
    （ChatPersistPort 仅需 .id，返回全行 = 超集）。body = AppendToolCallInput（camelCase，
    去 messageId — 取自 path）。"""
    opts = body or {}
    tool_use_id = opts.get("toolUseId")
    tool_name = opts.get("toolName")
    input_json = opts.get("inputJson")
    confirmation_tier = opts.get("confirmationTier")
    status = opts.get("status")
    if not isinstance(tool_use_id, str) or not tool_use_id:
        raise APIError("E_INVALID_ARG", "tool-calls requires toolUseId:str", source="sqlite")
    if not isinstance(tool_name, str) or not tool_name:
        raise APIError("E_INVALID_ARG", "tool-calls requires toolName:str", source="sqlite")
    if not isinstance(input_json, str):
        raise APIError("E_INVALID_ARG", "tool-calls requires inputJson:str", source="sqlite")
    if not isinstance(confirmation_tier, str) or not confirmation_tier:
        raise APIError(
            "E_INVALID_ARG", "tool-calls requires confirmationTier:str", source="sqlite"
        )
    if not isinstance(status, str) or not status:
        raise APIError("E_INVALID_ARG", "tool-calls requires status:str", source="sqlite")
    # contentOffset（task 06-08-chat Bug 2）= 可选 int（工具卡在 content 里的插入偏移）；
    # 缺省 / null → None（持久化 NULL，前端 degrade 到「工具卡在正文后」）。非 int 拒绝。
    content_offset = opts.get("contentOffset")
    if content_offset is not None and not isinstance(content_offset, int):
        raise APIError(
            "E_INVALID_ARG", "tool-calls contentOffset must be an int", source="sqlite"
        )
    call = get_chat_db().append_tool_call(
        message_id=message_id,
        tool_use_id=tool_use_id,
        tool_name=tool_name,
        input_json=input_json,
        confirmation_tier=confirmation_tier,
        status=status,
        content_offset=content_offset,
    )
    return success_envelope(call, request=request, source="sqlite")


@router.patch("/tool-calls/{tool_call_id:int}", dependencies=[Depends(verify_cf_access)])
async def update_tool_call(
    request: Request, tool_call_id: int, body: Optional[Dict[str, Any]] = None
):
    """updateToolCall：patch 工具调用（status/outputJson/durationMs/userEditedInputJson/
    confirmedAt 任意子集）。镜像 chat_db updateToolCall。**缺 body（None / JSON null）→
    E_INVALID_ARG**（同 finalize_message）；显式空对象 {} → no-op。codex review LOW。"""
    if body is None:
        raise APIError(
            "E_INVALID_ARG",
            "tool-calls PATCH requires a patch object body",
            source="sqlite",
        )
    get_chat_db().update_tool_call(tool_call_id, body)
    return success_envelope({"ok": True}, request=request, source="sqlite")


@router.get(
    "/messages/{message_id:int}/tool-calls/{tool_use_id}",
    dependencies=[Depends(verify_cf_access)],
)
async def get_tool_call_by_use_id(request: Request, message_id: int, tool_use_id: str):
    """单工具调用（by message + tool_use_id）。镜像 chat_db getToolCallByUseId →
    ChatToolCall | null（data=null 当不存在，不 404）。"""
    call = get_chat_db().get_tool_call_by_use_id(message_id, tool_use_id)
    return success_envelope(call, request=request, source="sqlite")


@router.get("/messages/{message_id:int}", dependencies=[Depends(verify_cf_access)])
async def get_message(request: Request, message_id: int):
    """单消息行。镜像 chat_db getMessage → ChatMessage | null（data=null 当不存在，不 404）。"""
    msg = get_chat_db().get_message(message_id)
    return success_envelope(msg, request=request, source="sqlite")


# ── KOS 代理端点（V2.1 阶段 3 3b-4：工具板 kosCallTool / saveToKos 的 http 面）─────────────
#
# 前端 KOS 工具全收敛成一个通用透传 kosCall(name, args) → 本端点 → src/kos/client.py
# KOSClient.call_tool；chat:saveToKos → save-to-kos（复刻 kos_save.ts：读 chat_db +
# summarize LLM + put_page）。KOSClient 同步（httpx.Client），用 run_in_threadpool 避免阻塞
# event loop。
# 🔴 调用方现状（2026-07-24，issue #57）：V2.1 写的 ChatToolPlatform / HttpChatPlatform 那套
# legacy TS runtime 已于 2026-07-02（S3）删除；现在的调用方是 embedded AI SDK Gateway 的
# 6 个只读 KOS 工具（frontend/src/ai-gateway/tools/kos.ts，domain.kosCall），**不是** 9 个。
#
# KOSClient 单例（复用 OAuth token cache 跨请求；env KOS_MCP_BASE/CLIENT_ID/SECRET 由 serve-api
# 注入）。与 chat:kosAvailable 的 _kos_available() env 检查同源。

_kos_client_singleton: Optional[KOSClient] = None


def _get_kos_client() -> KOSClient:
    global _kos_client_singleton
    if _kos_client_singleton is None:
        _kos_client_singleton = KOSClient()
    return _kos_client_singleton


# 🔴 服务端只读边界（codex review HIGH，2026-07-24）：mailagent 的 KOS OAuth client 是
# **read+write** scope，所以本端点若通用透传，任何能触达 serve-api 的调用方都能提交
# put_page / delete_page / add_link / add_tag / extract_facts / forget_fact 等写工具名 ——
# "gateway 只注册只读工具"只约束**模型工具面**，不构成系统层边界。故按**精确 allowlist**
# 收口：只有 gateway 6 个只读 KOS 工具对应的 MCP 名放行，其余一律 E_KOS_TOOL_NOT_ALLOWED(403)。
#
# 🔴 新增 gateway KOS 只读工具时必须同步此表（名字 = frontend/src/ai-gateway/tools/kos.ts
#    里 domain.kosCall(<mcp name>) 的第一参，不带 kos_ 前缀），否则新工具静默 403。
#    写工具的开放须重新走安全评审 + ADR（见 report-agent-prd.md §3.5），不是在此加一行。
_KOS_READ_TOOL_ALLOWLIST = frozenset(
    {
        "query",
        "search",
        "get_page",
        "find_experts",
        "list_pages",
        "get_backlinks",
    }
)


@router.post("/kos-call", dependencies=[Depends(verify_cf_access)])
async def kos_call(request: Request):
    """KOS 只读工具代理（3b-4）：``{name, args}`` → KOSClient.call_tool → caller-friendly value。

    **只读白名单端点**：``name`` 必须命中 ``_KOS_READ_TOOL_ALLOWLIST``（gateway 的 6 个只读
    KOS 工具，issue #57：query / search / get_page / find_experts / list_pages /
    get_backlinks），否则 E_KOS_TOOL_NOT_ALLOWED(403)。**写工具（put_page / delete_page /
    extract_facts / …）与 skill 发现（list_skills / get_skill / recall）都不放行** —— OAuth
    client 本身是 read+write scope，只读边界必须由服务端结构性保证，不能只靠"gateway 没注册"。
    （chat 一键存档走 /save-to-kos 的专用 put_page 路径，不经本端点。）data = call_tool 返回
    （list/dict/str）。KOS 不可达 → KOSError 转 502 envelope（code=E_KOS_*，前端工具 duck-type
    读 code → LLM fallback 本地 FTS5）。
    """
    try:
        payload = await request.json()
    except Exception:
        raise APIError("E_INVALID_ARG", "kos-call body must be JSON")
    if not isinstance(payload, dict):
        raise APIError("E_INVALID_ARG", "kos-call body must be a JSON object")
    name = payload.get("name")
    args = payload.get("args")
    if not isinstance(name, str) or not name:
        raise APIError("E_INVALID_ARG", "kos-call requires name:str")
    if name not in _KOS_READ_TOOL_ALLOWLIST:
        raise APIError(
            "E_KOS_TOOL_NOT_ALLOWED",
            f"kos-call refuses '{name}': only KOS read tools may be proxied",
            hint="allowed: " + ", ".join(sorted(_KOS_READ_TOOL_ALLOWLIST)),
            http_status=403,
            source="kos",
        )
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise APIError("E_INVALID_ARG", "kos-call requires args:object")
    try:
        result = await run_in_threadpool(_get_kos_client().call_tool, name, args)
    except KOSError as e:
        raise APIError(e.code, str(e), http_status=502)
    return success_envelope(result, request=request, source="kos")


@router.post("/save-to-kos", dependencies=[Depends(verify_cf_access)])
async def save_to_kos(request: Request, body: Optional[Dict[str, Any]] = None):
    """chat 一键保存对话到 KOS（3b-4）：复刻 kos_save.ts（读 chat_db + summarize LLM + put_page）。

    body = SaveConversationInput ``{messageId, slug?, title?}``。data = {slug, status, contentBytes}。
    summarize LLM 失败非致命（fallback raw transcript）；校验 / KOS 错误 → 对应 status envelope
    （E_NOT_FOUND→404 / E_INVALID_ARG→400 / E_KOS_*→502）。 """
    opts = body or {}
    message_id = opts.get("messageId")
    if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id < 0:
        raise APIError("E_INVALID_ARG", "save-to-kos requires messageId:int (non-negative)")
    slug = opts.get("slug")
    title = opts.get("title")
    cfg = get_settings()
    # saved_at（动态；frontmatter saved_at 行，非字节对齐字段）。ISO 8601 + 真实毫秒 + Z
    # （仿 TS new Date().toISOString()，codex review NIT）。
    _now = datetime.now(timezone.utc)
    saved_at_iso = _now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{_now.microsecond // 1000:03d}Z"
    try:
        result = await run_in_threadpool(
            save_conversation_to_kos,
            chat_db=get_chat_db(),
            kos_client=_get_kos_client(),
            message_id=message_id,
            slug=slug if isinstance(slug, str) and slug else None,
            title=title if isinstance(title, str) and title else None,
            sync_db_path=cfg.sync_store_db_path,
            saved_at_iso=saved_at_iso,
            llm_api_key=(cfg.llm_api_key or "").strip(),
            llm_api_base=(cfg.llm_api_base or ""),
            llm_model=(cfg.llm_model or ""),
        )
    except SaveConversationError as e:
        if e.code == "E_NOT_FOUND":
            status = 404
        elif e.code == "E_INVALID_ARG":
            status = 400
        else:
            status = 502
        raise APIError(e.code, str(e), http_status=status)
    return success_envelope(result, request=request, source="kos")


# ── mem0 端点（M1/M2/M3 — auto-capture / search / compile-user-md）────────────
#
# M5b 后记忆唯一存储 = mem0 独立 FAISS store（DATA_ROOT/mem0/）+ user.md（M3 恒注入）。
# agent_memory_kv 表 + 其 4 个 KV 端点（GET/POST/DELETE /memory）已随 M5b 删除。
#
# 触发链：Node gateway onFinish fire-and-forget（**永不 await**）→ /memory/capture →
# memory.md 合并（Hermes 式有界记忆，task 07-01）。合并逻辑（读现 memory.md + 本轮 → LLM 输出
# 更新版 + 超预算淘汰）在 src/memory/memory_md.py。抽取每轮一调（durable-only 约束在其系统提示）。
# flag MAILAGENT_MEM0_CAPTURE 关时 Node 端根本不触发本端点，故本端点不自检 flag。


@router.post("/memory/capture", dependencies=[Depends(verify_cf_access)])
async def capture_memory(request: Request, body: Optional[Dict[str, Any]] = None):
    """从一个完成的 chat turn 把持久事实合并进 memory.md（Hermes 式有界记忆，task 07-01）。

    body = ``{userText:str, assistantText:str, sessionId?:int, messageId?:int}``。
    data = ``{changed:bool, captured:[], count:0}``（``captured``/``count`` 保留形状兼容 Node
    fire-and-forget 的 ``{captured, count}`` 返回类型；memory.md 是单文档、无 per-item id，故恒空）。

    best-effort：合并/写入失败**不 raise**（调用方 fire-and-forget 不重试）→ 记 warning +
    返回 ``changed=False``。空 turn 直接短路，不触发模型调用。
    """
    opts = body or {}
    user_text = opts.get("userText")
    assistant_text = opts.get("assistantText")
    if not isinstance(user_text, str) or not isinstance(assistant_text, str):
        # contract violation = Node onFinish 侧 bug（本不该发生）。调用方 fire-and-forget
        # 看不到这个 400，故 server 侧 log 让它可观测（best-effort 路径唯一的硬失败）。
        logger.warning(
            "capture got malformed body (need userText+assistantText:str), keys=%s",
            list(opts.keys()),
        )
        raise APIError(
            "E_INVALID_ARG",
            "capture requires userText:str + assistantText:str",
            source="memory",
        )
    user_text = user_text.strip()
    assistant_text = assistant_text.strip()
    # 空 turn（无实质内容）→ 无可合并，短路（省一次模型调用）。
    if not user_text and not assistant_text:
        return success_envelope(
            {"changed": False, "captured": [], "count": 0}, request=request, source="memory"
        )

    # provenance（可选）→ 透传给 save_memory_md 的 history（撤销/审计可溯源）。bool 是 int 子类，显式排除。
    session_id = opts.get("sessionId")
    if not (isinstance(session_id, int) and not isinstance(session_id, bool)):
        session_id = None
    message_id = opts.get("messageId")
    if not (isinstance(message_id, int) and not isinstance(message_id, bool)):
        message_id = None

    # 懒 import：守 chat.py 的 lazy-config 纪律（顶部 import memory_md 会触发 src.config
    # import-time，裸 worktree / CI import self-check 会炸）。memory_md 无重依赖（只 LLMClient +
    # agent_config store），但仍函数内 import 对齐既有纪律。
    from src.config import config as cfg
    from src.memory.memory_md import capture_turn

    # capture_turn 串行化 load→merge→save（asyncio.Lock 按 doc 名 keyed），防并发 capture 各读
    # 同一 base、后写覆盖先写（丢更新）。合并 = 一次 LLM 调用（capture model，默认 haiku），读现
    # memory.md + 本轮 → 输出更新版（去重 + 超预算淘汰）。LLMClient 走 streaming、不发 temperature，
    # 结构上规避 mem0 raw-anthropic 的 temperature-400 / 非流式 max_tokens 坑（详见 memory_md.py）。
    try:
        result = await capture_turn(
            user_text=user_text,
            assistant_text=assistant_text,
            budget=cfg.memory_md_budget_chars,
            session_id=session_id,
            message_id=message_id,
        )
    except Exception:  # noqa: BLE001 — best-effort，读/合并/落库失败都不阻断（turn 已流式）
        logger.warning("memory.md auto-capture failed (turn already streamed)", exc_info=True)
        return success_envelope(
            {"changed": False, "captured": [], "count": 0}, request=request, source="memory"
        )

    # 07-15 harness-chat lane C — `result.truncated` 此前只回填进响应 meta 后被丢弃（Node 端
    # fire-and-forget 只读 data，meta 无人消费；serve-api 自己也从不记这件事）。这里补一条
    # server 侧可观测的 warning（带文档长度上下文），使「haiku 合并产出超预算被硬截断」不再
    # 是纯粹的静默事件。stdlib logger 在 serve-api 常驻进程下静默不出，故用 loguru（同目录其余
    # router 的既有纪律）。
    if result.truncated:
        from loguru import logger as loguru_logger

        loguru_logger.warning(
            "memory.md auto-capture output exceeded the {}-char budget and was hard-truncated "
            "(final length={}, model={}, sessionId={})",
            cfg.memory_md_budget_chars, len(result.content), result.model, session_id,
        )

    return success_envelope(
        {"changed": result.changed, "captured": [], "count": 0},
        request=request,
        source="memory",
        meta_extra={"truncated": result.truncated, "model": result.model},
    )


@router.post("/memory/search", dependencies=[Depends(verify_cf_access)])
async def search_memory(request: Request, body: Optional[Dict[str, Any]] = None):
    """[已退役 task 07-01] mem0 按-query 召回（M2）已被 memory.md 恒注入取代。

    memory.md（Hermes 式有界记忆）现经 /chat/config 的 ``memorySummary`` 恒注入每轮 system
    prompt（不再按 query 召回）。保留端点返回空 ``{memories:[], count:0}``（退役 stub，不碰
    mem0/FAISS）——过渡期若 Node 仍调用（步2 前）→ 空召回 → context-light，安全；步2 起 Node
    停止调用本端点、删 retrieveMemory 回调。
    """
    return success_envelope({"memories": [], "count": 0}, request=request, source="memory")


# ── memory.md 偏好编译端点（M3 — user.md 偏好编译闭环）────────────────────────
#
# 与 capture（写）/search（读）的关键差异：那两个由 Node gateway 触发（onFinish /
# prepareChatRun），flag 关时 Node 根本不调（字节级 flag-off），故端点不自检 flag。
# 本端点是 **Settings 按钮手动触发**（HTTP 直达）→ 必须**自检 flag**（flag-off → E_DISABLED，
# 防按钮以外的直接调用）。且是**用户主动操作** → 编译/落库失败 raise（区别 search 的 best-effort
# 降级）。memory.md 源（agent_config.db 的 MEMORY doc）+ user.md 读写均碰 SQLite 短连接（同步即可，无 faiss/threadpool）。


@router.post("/memory/compile-user-md", dependencies=[Depends(verify_cf_access)])
async def compile_user_md_endpoint(request: Request):
    """从 memory.md 编译合并持久偏好进 user.md（M3 偏好编译闭环，手动触发；task 07-01 步4 换源）。

    ``load_memory_md`` → LLM 合并现有 user.md（保留手编）+ memory.md 偏好 → 仅 ``changed`` 时
    ``set_profile_doc('user', updated_by='agent_proposed')``（agent_config history/rollback 兜底）。
    data = ``{before, after, changed, itemCount}``（前端展示 before/after diff + 一键 rollback）。
    flag ``MAILAGENT_USER_MD_COMPILE`` 关 → E_DISABLED。
    """
    # 懒 import：守 chat.py lazy-config 纪律（顶层 import src.config 会在裸 worktree / CI
    # import self-check 时炸）。memory.md 读只碰 agent_config.db（SQLite 短连接，无 faiss）。
    from src.config import config as cfg

    if not cfg.user_md_compile_enabled:
        raise APIError(
            "E_DISABLED",
            "user.md compile is disabled (set MAILAGENT_USER_MD_COMPILE=true)",
            source="memory",
            http_status=403,
        )

    from src.agent_config.store import get_agent_config_store
    from src.memory.memory_md import load_memory_md
    from src.memory.user_md_compiler import UserMdCompileError, compile_user_md

    store = get_agent_config_store()
    current_doc = store.get_profile_doc("user")  # seed-on-read 保证非空
    current = current_doc.content

    # memory.md（agent_config.db 的 MEMORY doc，seed-on-read → 首次 ''）= 偏好源。读只碰 SQLite
    # 短连接（fast，无 faiss），无需 threadpool；空 memory.md → compile 短路 unchanged（不崩）。
    # 不可用 = 编译失败（用户主动操作）→ raise（区别 search 的 best-effort 降级空）。
    try:
        memory_md = load_memory_md()
    except Exception as exc:  # noqa: BLE001
        logger.warning("load_memory_md failed during user.md compile", exc_info=True)
        raise APIError(
            "E_INTERNAL", f"memory store unavailable: {exc}", source="memory", http_status=500
        )

    try:
        result = await compile_user_md(current_user_md=current, memory_md=memory_md)
    except UserMdCompileError as exc:
        raise APIError("E_INTERNAL", f"compile failed: {exc}", source="memory", http_status=500)

    # 仅 changed 时落库（set_profile_doc 本身也 hash 短路 no-op，此处显式跳过 + 返回准确 after）。
    after = current
    if result.changed:
        doc = store.set_profile_doc("user", result.content, updated_by="agent_proposed")
        after = doc.content

    return success_envelope(
        {
            "before": current,
            "after": after,
            "changed": result.changed,
            "itemCount": result.item_count,
            # M3c — 前端 rollback 用：写前 doc 的 content_hash，传给
            # POST /api/agent/profile/docs/user/rollback body.targetHash。
            "beforeHash": current_doc.content_hash,
        },
        request=request,
        source="memory",
        meta_extra={"model": result.model, "outputTokens": result.output_tokens},
    )
