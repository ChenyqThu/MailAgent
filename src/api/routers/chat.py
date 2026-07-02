"""chat 路由 — /api/chat/* (V2.1 远程 chat 历史只读 [阶段 2] + 对话 [阶段 3])。

**阶段 2（本次）**：5 读端点，镜像本地 IPC ``handlers/chat.ts`` 的 listSessions /
listAllSessions / listMessages / listToolCalls / kosAvailable。读 ai_chat.db
（``src/chat/db.py``，serve-api 新连）+ listAllSessions join sync_store.db
email_metadata（subject/sender，best-effort）。形状对齐前端 ChatSession /
ChatSessionSummary / ChatSessionListItem / ChatMessage / ChatToolCall（``types.ts``）。

**阶段 3（后续，B-pure-unified）**：llm-proxy / chat 持久化 / notion-agent spawn /
写工具端点 —— harness 在 browser 跑，serve-api 退化为数据/代理面。

鉴权：所有端点 ``Depends(verify_cf_access)``。读 graceful（库不存在/锁 → []）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response, StreamingResponse
from dotenv import dotenv_values

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_chat_db, get_env_file_path, get_settings
from src.chat.kos_save import SaveConversationError, save_conversation_to_kos
from src.chat.notion_agent import run_notion_agent, sse_encode
from src.kos.client import KOSClient, KOSError

router = APIRouter(prefix="/api/chat", tags=["chat"])

logger = logging.getLogger(__name__)

# task 06-08-chat 第二波 Bug B — reuse the email-classification context page
# (user profile / Sender Priority / focus projects / 研发课组 / 邮件风格 / 时区)
# for the custom-api chat system prompt. Lazy singleton (NOT a module-level
# instance): ContextLoader imports `src.config.config` at module load, which
# would bypass deps.py's lazy-config discipline and crash import-time when the
# required .env is absent (bare worktree / CI import self-check). The singleton
# still preserves the 1800s TTL cache across /config requests once built.
_context_loader = None  # type: ignore[var-annotated]

# /chat/config 等待 user context (Notion) 的上限 — renderer chat 引擎构造
# await 本端点, 无界等待 = chat panel 整体卡死 (dogfood round 3)。超时降级
# 空 context, shield 让加载后台跑完填 TTL 缓存。
_USER_CONTEXT_TIMEOUT_SEC = 8.0


def _get_context_loader():
    """Lazily build the ContextLoader singleton (defers the config import)."""
    global _context_loader
    if _context_loader is None:
        from src.llm_agent.context_loader import ContextLoader

        _context_loader = ContextLoader()
    return _context_loader

# 3b-1：CRS/Cloudflare 挑剔 UA（mirror custom_api.ts / electron_platform.ts llmFetch 注入侧）。
_CRS_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "Chrome/146.0.0.0 Safari/537.36"
)
# 上游 LLM 流式 deadline（与 shared custom_api REQUEST_DEADLINE_MS=60s 对齐；read 给足长
# 流式，connect/write 短）。
_LLM_PROXY_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)


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
async def list_all_sessions(request: Request, include_archived: bool = Query(False)):
    """跨邮件 session 历史（含 first_user_message 预览 + message_count + join email
    subject/sender）。镜像 chat:listAllSessions → ChatSessionListItem[]。
    include_archived=true 时含归档会话（用于归档分组视图）。"""
    summaries = get_chat_db().list_all_sessions(include_archived=include_archived)
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
    """chat 运行配置快照（V2.1 阶段 3c — renderer 构造 HttpChatPlatform 前预取）。

    serve-api 读 config.py（pydantic env_file → .env）暴露 chat 引擎运行配置；前端
    原样覆盖 DEFAULT_HTTP_CONFIG（D-3c-3：配置以 serve-api 为准）。data 形状 =
    HttpPlatformConfig（frontend/src/shared/chat/http_platform.ts），camelCase 对齐前端。

    ``kosConsumerEnabled`` = 原始开关；``kosConfigured`` = 开关 AND OAuth 凭据齐全
    （KOS_MCP_BASE + KOS_OAUTH_CLIENT_ID + KOS_OAUTH_CLIENT_SECRET 三者非空，对齐
    ``_kos_available``）。renderer createBuiltinTools 据 ``kosConfigured`` gate 9 个 KOS
    工具注册，custom_api KOS 使用指南块也同 gate —— 开关开着但未对接时都不注入，避免叫
    AI 用未注册的工具（``[✨ 保存到 KOS]`` 按钮仍单独由 ``_kos_available`` gate）。
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
    default_model = cfg.llm_model or "claude-sonnet-4-6"
    # task 06-08-chat 第二波 Bug B — user context (Notion context page markdown,
    # TTL-cached) injected into the custom-api chat system prompt so the assistant
    # knows the user's role / responsibilities / Sender Priority. Not configured
    # (LLM_CONTEXT_PAGE_ID empty) → "". Fetch failure → "" (graceful, never blocks
    # /config — chat still runs, just without the user profile).
    # dogfood round 3 — get_markdown 冷缓存时父页+子页串行打 Notion (单请求 30s
    # 上限 × N) 可达分钟级, 而 renderer chat 引擎 lazy 构造必须 await 本端点 →
    # chat panel 整体卡"加载不出"。限时 8s: 超时降级空 context (chat 照跑, 仅无
    # 用户画像); shield 让底层加载继续跑完填 TTL 缓存 → 下一次 /config 秒回。
    user_context = ""
    _ctx_task = asyncio.ensure_future(_get_context_loader().get_markdown())
    # 超时弃等后无人 await task — 吞掉 exception 防 "never retrieved" 警告
    # (get_markdown 内部已全 catch, 此处纯保险)。
    _ctx_task.add_done_callback(
        lambda t: t.exception() if not t.cancelled() else None
    )
    try:
        user_context = await asyncio.wait_for(
            asyncio.shield(_ctx_task), timeout=_USER_CONTEXT_TIMEOUT_SEC
        )
    except Exception:  # noqa: BLE001 — context is best-effort; never fail /config
        user_context = ""
    # enabledModels + KOS 开关: hot-read from .env (dotenv_values, not pydantic Config
    # singleton) so changes take effect without a serve-api restart — same pattern as
    # 155eb006 (SYNC_FOLDERS hot-read). 🔴 KOS 开关曾用 cfg.* singleton: serve-api 启动
    # 后才往 app .env 加 MAILAGENT_KOS_CONSUMER_ENABLED → import-time config 缓存 stale
    # false → /config 永远 kosConfigured:false → renderer createBuiltinTools 不注册 9 个
    # KOS 工具（chat AI "没有 kos 工具"）。热读 .env 为准、cfg.* 兜底，根治该 stale。
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
    kos_consumer = _hot_bool(env_vals, "MAILAGENT_KOS_CONSUMER_ENABLED", cfg.kos_consumer_enabled)
    kos_l1_hot = _hot_bool(env_vals, "MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED", cfg.kos_l1_hot_block_enabled)
    kos_time_decay = _hot_bool(env_vals, "MAILAGENT_KOS_TIME_DECAY_ENABLED", cfg.kos_time_decay_enabled)
    # P2b — manifest-driven read tools (off by default → builtin catalog, zero regression).
    manifest_mode = _hot_bool(env_vals, "MAILAGENT_CHAT_MANIFEST_MODE", False)
    # 🔴「只在启用 AND 对接 KOS 时才注入工具」。kosConsumerEnabled = 纯开关；kosConfigured
    # = 开关 AND OAuth 凭据齐全（endpoint + client_id + secret 三者非空，对齐 _kos_available）。
    # renderer createBuiltinTools 据 kosConfigured 决定是否注册 9 个 KOS 工具 —— 开关开着却
    # 没配凭据（新用户 / 未对接）时不注入，避免注册了必然调用失败的工具。凭据热读 .env 为准、
    # os.environ（启动注入）兜底，与 enabledModels / kos 开关同样支持改 .env 即时生效。
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
            from src.memory.memory_md import _truncate_to_budget

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
    # Gated by MAILAGENT_STANDING_CONTEXT_ENABLED (hot-read .env, default ON — same
    # discipline as manifestMode). OFF / store hiccup → "" → TS falls back to the
    # legacy SOUL_MARKDOWN (byte-identical, zero email-mode regression).
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
    try:
        from src.agent_config.projections import advertised_skill_names
        from src.agent_config.store import get_agent_config_store
        from src.skills.registry import build_manifest

        advertised_skills = advertised_skill_names(
            build_manifest(None).skills, get_agent_config_store()
        )
    except Exception:  # noqa: BLE001 — advertised skills are best-effort; never fail /config
        advertised_skills = None
    return success_envelope(
        {
            "maxIter": max_iter,
            "maxCostUsd": max_cost,
            "harnessEnabled": cfg.agent_harness_enabled,
            "kosL1HotBlockEnabled": kos_l1_hot,
            "defaultModel": default_model,
            "kosConsumerEnabled": kos_consumer,
            "kosConfigured": kos_configured,
            "kosTimeDecayEnabled": kos_time_decay,
            "userContext": user_context,
            "memorySummary": memory_summary,
            "memorySummaryMeta": memory_summary_meta,
            "enabledModels": enabled_models,
            "manifestMode": manifest_mode,
            "agentProfileHash": agent_profile_hash,
            "installedSkillsHash": installed_skills_hash,
            "standingContext": standing_context,
            "standingContextActive": standing_context_active,
            "skillOverrides": skill_overrides,
            "skillOverridesAvailable": skill_overrides_available,
            # M4a — advertised skill names for the gateway's skill→tool gating; null on
            # a store/manifest hiccup → gateway fails open (see advertised_skills above).
            "advertisedSkills": advertised_skills,
            # M3c — user.md 偏好编译按钮显隐 gate（运行时暴露，非 vite define；
            # flag-off → 前端 UserMdCompileSection return null，整个区块在 DOM 不存在）。
            # singleton 读 —— 翻 MAILAGENT_USER_MD_COMPILE 需重启 serve-api（M3 flag 无 live writer，by design）
            "userMdCompileEnabled": cfg.user_md_compile_enabled,
            # Settings 身份文档编辑器显隐 gate（默认开，运行时暴露，非 vite define；
            # flag-off → 前端 StandingDocsSection return null，整个区块在 DOM 不存在）。
            # singleton 读 —— 翻 MAILAGENT_STANDING_DOCS_EDITOR 需重启 serve-api。
            "standingDocsEditorEnabled": cfg.standing_docs_editor_enabled,
        },
        request=request,
        source="config",
    )


@router.post("/llm-proxy", dependencies=[Depends(verify_cf_access)])
async def llm_proxy(request: Request):
    """custom-api LLM 上游代理（V2.1 阶段 3 3b-1）：注入 key + 透传原始 SSE。

    **非 envelope**（chat 端点唯一例外）：成功 → StreamingResponse（text/event-stream，
    原始上游 SSE 字节流，shared custom_api 在 UI 进程解析）；上游非 2xx → 透传 status（空
    body，shared 据 response.ok 分类 E_QUOTA/E_UPSTREAM，不泄漏上游错误页 body）。key 注入
    在此（永不进 renderer/browser，REVIEW-LOG C-04）。

    req body = ``{protocol: 'anthropic'|'openai', body: {…上游请求体…}}``；body 由 shared
    custom_api 构造（model/max_tokens/system/messages/tools/stream:true）。
    """
    try:
        payload = await request.json()
    except Exception:
        raise APIError("E_INVALID_ARG", "llm-proxy body must be JSON")
    protocol = payload.get("protocol") if isinstance(payload, dict) else None
    upstream_body = payload.get("body") if isinstance(payload, dict) else None
    if protocol not in ("anthropic", "openai") or not isinstance(upstream_body, dict):
        raise APIError(
            "E_INVALID_ARG",
            "llm-proxy requires {protocol: 'anthropic'|'openai', body: object}",
        )

    cfg = get_settings()
    api_key = (cfg.llm_api_key or "").strip()
    if not api_key:
        raise APIError("E_NO_LLM_KEY", "LLM_API_KEY not configured on serve-api host")
    base_url = (cfg.llm_api_base or "").rstrip("/")
    if protocol == "anthropic":
        url = f"{base_url}/v1/messages"
        headers = {
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "user-agent": _CRS_USER_AGENT,
        }
    else:
        url = f"{base_url}/v1/chat/completions"
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        }

    client = httpx.AsyncClient(timeout=_LLM_PROXY_TIMEOUT)
    try:
        upstream_req = client.build_request(
            "POST", url, json=upstream_body, headers=headers
        )
        upstream_resp = await client.send(upstream_req, stream=True)
    except Exception as exc:  # noqa: BLE001 — codex review LOW
        # httpx.InvalidURL（malformed LLM_API_BASE）不是 HTTPError，旧 except httpx.HTTPError
        # 会漏它 → 跳过 aclose 泄漏 + generic 500。broad except 兜底：必 aclose + 502 envelope。
        await client.aclose()
        raise APIError(
            "E_UPSTREAM", f"LLM upstream request failed: {exc}", http_status=502
        )

    # 非 2xx 一律透传 status（空 body），shared 据 response.ok 分类，不泄漏上游 body。
    # codex review MEDIUM：含 3xx —— follow_redirects 默认 False，3xx body 非 SSE，不能当
    # streaming success 转发 redirect body。用 <200 or >=300 覆盖全部非 2xx（仅 2xx passthrough）。
    if upstream_resp.status_code < 200 or upstream_resp.status_code >= 300:
        status = upstream_resp.status_code
        await upstream_resp.aclose()
        await client.aclose()
        return Response(status_code=status)

    async def passthrough():
        # aiter_bytes 解 content-encoding → 明文 SSE（shared TextDecoder 解 UTF-8）。
        try:
            async for chunk in upstream_resp.aiter_bytes():
                yield chunk
        finally:
            await upstream_resp.aclose()
            await client.aclose()

    return StreamingResponse(
        passthrough(),
        status_code=upstream_resp.status_code,
        media_type="text/event-stream",
    )


@router.post("/notion-agent", dependencies=[Depends(verify_cf_access)])
async def notion_agent(request: Request):
    """notion-agent 多轮对话（V2.1 阶段 3 3b-2）：asyncio spawn ``notion-agent chat --stream``
    复刻 frontend ``notion_agent.ts`` 全语义，输出「语义 event SSE」。

    **非 envelope**（chat 流式端点，对齐 llm-proxy）：成功 → StreamingResponse
    （``text/event-stream``，每个事件一行 ``data: {ChatStreamEvent}\\n\\n``：
    tool_call / chunk / usage / done / error），client 端 ``notionAgentStream``（3b-5）fetch +
    parseSse 反序列化为 ChatStreamEvent —— 与 custom-api 后端在 UI 进程产出的 event 同形。

    req body = ChatStreamRequest 子集 ``{history, model, agentPageId, emailContext}``（去
    signal/tools/iterHistory —— notion-agent CLI 不支持工具，单遍 end_turn）。流内错误（空
    history / spawn 失败 / exit 分类）作 ``error`` 事件随流下发（对齐 TS runNotionAgent），
    仅 body 不可解析（client bug）才 pre-stream APIError envelope。
    """
    try:
        payload = await request.json()
    except Exception:
        raise APIError("E_INVALID_ARG", "notion-agent body must be JSON")
    if not isinstance(payload, dict):
        raise APIError("E_INVALID_ARG", "notion-agent body must be a JSON object")

    async def event_stream():
        async for event in run_notion_agent(payload):
            yield sse_encode(event)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/notion-agent-once", dependencies=[Depends(verify_cf_access)])
async def notion_agent_once(request: Request, body: Optional[Dict[str, Any]] = None):
    """notion_agent_chat tool 的**非流式**面（P2g）：跑 ``run_notion_agent`` 收集成
    ``{text, threadId, status, metadata}``。复用串行 gate / idle timeout / thread_id 续接
    （extract_turn 从构造的 assistant.metadata.thread_id 取已有 thread_id）。envelope（非 SSE）。

    body = ``{message, threadId?, model?, agentPageId?}``。旧流式 ``/notion-agent`` 端点 + 旧
    ``backend_kind='notion-agent'`` 不动（Phase 3 再退役 UI 入口）。
    """
    opts = body or {}
    message = opts.get("message")
    if not isinstance(message, str) or not message:
        raise APIError("E_INVALID_ARG", "notion-agent-once requires message:str")
    thread_id = opts.get("threadId")
    thread_id = thread_id if isinstance(thread_id, str) and thread_id else None
    model = opts.get("model")
    agent_page_id = opts.get("agentPageId")

    # 构造 history 让 extract_turn 取到 message + 已有 thread_id（续轮 → assistant.metadata.thread_id）。
    history: List[Dict[str, Any]] = []
    if thread_id:
        history.append(
            {"role": "assistant", "content": "", "metadata": json.dumps({"thread_id": thread_id})}
        )
    history.append({"role": "user", "content": message})
    payload = {
        "history": history,
        "model": model,
        "agentPageId": agent_page_id,
        "emailContext": None,
    }

    text = ""
    out_thread_id: Optional[str] = thread_id
    status = "ok"
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    async for event in run_notion_agent(payload):
        etype = event.get("type")
        if etype == "chunk":
            text += event.get("delta") or ""
        elif etype in ("done", "usage"):
            if etype == "done":
                fc = event.get("finalContent")
                if isinstance(fc, str):
                    text = fc
            md = event.get("metadata")
            if isinstance(md, dict):
                metadata = md
                tid = md.get("thread_id")
                if isinstance(tid, str) and tid:
                    out_thread_id = tid
        elif etype == "error":
            status = "error"
            error_code = event.get("code")
            error_message = event.get("message")

    result: Dict[str, Any] = {
        "text": text,
        "threadId": out_thread_id,
        "status": status,
        "metadata": metadata,
    }
    if status == "error":
        result["errorCode"] = error_code
        result["errorMessage"] = error_message
    return success_envelope(result, request=request, source="cli")


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


# P2c — anchor-aware session 入参校验。email（默认）→ emailId 必须非负 int；general → 无
# emailId（**绝不**接受 emailId sentinel，下沉到 db._resolve_anchor 也 defense-in-depth）。
def _validate_session_opts(opts: Dict[str, Any], route: str) -> tuple[str, Optional[int], str]:
    anchor_type = opts.get("anchorType") or "email"
    if anchor_type not in ("email", "general"):
        raise APIError(
            "E_INVALID_ARG",
            f"{route} requires anchorType in {{email, general}}",
            source="sqlite",
        )
    email_id = opts.get("emailId")
    if anchor_type == "email":
        if not isinstance(email_id, int) or isinstance(email_id, bool) or email_id < 0:
            raise APIError(
                "E_INVALID_ARG",
                f"{route} email anchor requires emailId:int (non-negative)",
                source="sqlite",
            )
    else:
        # codex review HIGH — reject a general anchor carrying ANY emailId (incl. 0);
        # don't silently drop it (that's the banned sentinel).
        if email_id is not None:
            raise APIError(
                "E_INVALID_ARG",
                f"{route} general anchor must not carry an emailId",
                source="sqlite",
            )
        # general session 无 emailId（CHECK 强制 email_id IS NULL）。
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
    return anchor_type, email_id, backend_kind


@router.post("/sessions", dependencies=[Depends(verify_cf_access)])
async def open_session(request: Request, body: Optional[Dict[str, Any]] = None):
    """getOrCreateSession：复用既有 session 或新建。镜像 chat:getOrCreateSession → ChatSession。
    body = OpenSessionInput（camelCase；P2c 加 anchorType: 'email'|'general'，缺省 'email'）。"""
    opts = body or {}
    anchor_type, email_id, backend_kind = _validate_session_opts(opts, "sessions")
    session = get_chat_db().get_or_create_session(
        email_id=email_id,
        backend_kind=backend_kind,
        backend_model=opts.get("backendModel"),
        backend_agent_page_id=opts.get("backendAgentPageId"),
        anchor_type=anchor_type,
    )
    return success_envelope(session, request=request, source="sqlite")


@router.post("/sessions/new", dependencies=[Depends(verify_cf_access)])
async def new_session(request: Request, body: Optional[Dict[str, Any]] = None):
    """createNewSession：无条件 INSERT 新 session（绕过复用）。镜像 chat:newSession → ChatSession。
    P2c：支持 anchorType（general session 无 emailId）。"""
    opts = body or {}
    anchor_type, email_id, backend_kind = _validate_session_opts(opts, "sessions/new")
    session = get_chat_db().create_new_session(
        email_id=email_id,
        backend_kind=backend_kind,
        backend_model=opts.get("backendModel"),
        backend_agent_page_id=opts.get("backendAgentPageId"),
        anchor_type=anchor_type,
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
# 镜像前端 chat 工具板（ChatToolPlatform）KOS 成员：9 KOS 工具全收敛 kosCallTool(name,args)
# → 本端点 → src/kos/client.py KOSClient.call_tool；chat:saveToKos → save-to-kos（复刻
# kos_save.ts：读 chat_db + summarize LLM + put_page）。KOSClient 同步（httpx.Client），用
# run_in_threadpool 避免阻塞 event loop。HttpChatPlatform（3b-5）fetch 这俩端点。
#
# KOSClient 单例（复用 OAuth token cache 跨请求；env KOS_MCP_BASE/CLIENT_ID/SECRET 由 serve-api
# 注入）。与 chat:kosAvailable 的 _kos_available() env 检查同源。

_kos_client_singleton: Optional[KOSClient] = None


def _get_kos_client() -> KOSClient:
    global _kos_client_singleton
    if _kos_client_singleton is None:
        _kos_client_singleton = KOSClient()
    return _kos_client_singleton


@router.post("/kos-call", dependencies=[Depends(verify_cf_access)])
async def kos_call(request: Request):
    """KOS 通用工具代理（3b-4）：``{name, args}`` → KOSClient.call_tool → caller-friendly value。

    镜像前端工具板 kosCallTool（query/put_page/recall/find_experts/get_page/list_skills/
    get_skill/extract_facts 全收敛 tools/call）。data = call_tool 返回（list/dict/str）。KOS 不可达
    → KOSError 转 502 envelope（code=E_KOS_*，前端工具 duck-type 读 code → LLM fallback 本地 FTS5）。
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
