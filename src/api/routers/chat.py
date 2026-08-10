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
from src.api.deps import get_chat_db, get_env_file_path, get_settings
from src.chat.kos_save import SaveConversationError, save_conversation_to_kos
from src.agents.run_state import derive_agent_run_state
from src.kos.client import KOSClient, KOSError

router = APIRouter(prefix="/api/chat", tags=["chat"])

logger = logging.getLogger(__name__)


def _session_scope(request: Request, requested_agent_id: Optional[str]) -> Optional[str]:
    current = (request.headers.get("X-MailAgent-Agent-Id") or "").strip()
    if not current:
        return requested_agent_id
    allow_all = request.headers.get("X-MailAgent-Allow-All-History") == "1"
    return requested_agent_id if allow_all else current


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


# 注意路由顺序：静态 /sessions/all 在动态 /sessions/{id}/messages 之前声明。后者 {session_id:int}
# 约束已能挡住 "all"（非 int 不匹配），此处顺序仅为可读性 + 双保险。


@router.get("/sessions/all", dependencies=[Depends(verify_cf_access)])
async def list_all_sessions(
    request: Request,
    include_archived: bool = Query(False),
    origin: Literal["interactive", "agent", "im", "all"] = Query("interactive"),
    agent_id: Optional[str] = Query(None, alias="agentId"),
    agent_job_id: Optional[str] = Query(None, alias="agentJobId"),
    trigger_id: Optional[str] = Query(None, alias="triggerId"),
    trigger_kind: Optional[str] = Query(None, alias="triggerKind"),
    created_after: Optional[int] = Query(None, alias="createdAfter"),
    created_before: Optional[int] = Query(None, alias="createdBefore"),
    archived: Optional[bool] = Query(None),
    starred: Optional[bool] = Query(None),
    limit: int = Query(300, ge=1, le=300),
):
    """跨邮件 session 历史（含 first_user_message 预览 + message_count + join email
    subject/sender）。镜像 chat:listAllSessions → ChatSessionListItem[]。
    include_archived=true 时含归档会话（用于归档分组视图）。"""
    summaries = get_chat_db().list_all_sessions(
        limit=limit, include_archived=include_archived, origin=origin,
        agent_id=_session_scope(request, agent_id), agent_job_id=agent_job_id,
        trigger_id=trigger_id, trigger_kind=trigger_kind,
        created_after=created_after, created_before=created_before,
        archived=archived, starred=starred,
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
    items = [
        {
            **s,
            "email_subject": meta.get(s["email_id"], {}).get("subject"),
            "email_sender": meta.get(s["email_id"], {}).get("sender"),
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
    origin: Literal["interactive", "agent", "im", "all"] = Query("all"),
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
        # W6: only the code-owned Custom Agent builder workflow is prompt-injected. Installed
        # third-party fragments remain excluded from the post-cutover gateway prompt. Reusing the
        # advertised-skill result makes the Settings toggle authoritative for both visibility and
        # workflow guidance; an empty string means the trusted skill is deliberately disabled.
        advertised_set = set(advertised_skills)
        trusted_skill_fragments = "\n\n".join(
            skill.prompt_fragment.strip()
            for skill in code_builtin_skills()
            if skill.name == "custom_agent"
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
            # Matters P1 lane ② — pydantic 根开关的 renderer 投影。必须与
            # /api/matters/* 的 require_matters_enabled 读取同一个冻结 settings
            # 单例；不做 hot-read，避免 UI 显示入口但端点仍按旧值返回 E_DISABLED。
            "mattersEnabled": bool(getattr(cfg, "matters_enabled", False)),
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


@router.post("/sessions/new", dependencies=[Depends(verify_cf_access)])
async def new_session(request: Request, body: Optional[Dict[str, Any]] = None):
    """createNewSession：无条件 INSERT 新 session（绕过复用）。镜像 chat:newSession → ChatSession。
    P2c / Matters MVP P3：支持 general 与 matter anchor。"""
    opts = body or {}
    anchor_type, email_id, matter_id, backend_kind = _validate_session_opts(
        opts, "sessions/new"
    )
    session = get_chat_db().create_new_session(
        email_id=email_id,
        backend_kind=backend_kind,
        backend_model=opts.get("backendModel"),
        backend_agent_page_id=opts.get("backendAgentPageId"),
        anchor_type=anchor_type,
        matter_id=matter_id,
    )
    return success_envelope(session, request=request, source="sqlite")


@router.get("/sessions/{session_id:int}", dependencies=[Depends(verify_cf_access)])
async def get_session(request: Request, session_id: int):
    """单 session 行。镜像 chat_db getSession → ChatSession | null（data=null 当不存在，不 404）。"""
    session = get_chat_db().get_session(session_id)
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
