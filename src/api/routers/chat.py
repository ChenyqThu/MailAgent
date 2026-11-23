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

import json
import logging
import os
from typing import Any, Dict, List, Literal, Optional

from dotenv import dotenv_values
from fastapi import APIRouter, Depends, Query, Request

from src.agent_config.enabled_models import (
    FALLBACK_DEFAULT_MODEL,
    build_enabled_model_catalog,
)
from src.agents.run_state import derive_agent_run_state
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_chat_db, get_env_file_path, get_report_store, get_settings
from src.api.routers.chat_groups import router as _groups_router
from src.api.routers.chat_memory import router as _memory_router
from src.api.routers.chat_search import router as _search_router
from src.api.routers.chat_sessions import router as _sessions_router
from src.chat.db import parse_group_member_ids
from src.chat.group_limits import (
    CHAIN_CAP_MAX,
    CHAIN_CAP_MIN,
    MAIN_AGENT_MEMBER_ID,
    MATTER_FOLLOWUP_MEMBER_ID,
    MAX_GROUP_MEMBERS,
    MODEL_OVERRIDE_MAX_CHARS,
    RESPONSE_MODES,
    SESSION_INVOKED_BY,
    THREAD_TITLE_MAX_CHARS,
    TOPIC_MAX_CHARS,
    group_scope_hash,
)
from src.chat.kos_save import save_conversation_to_kos
from src.kos.client import KOSClient

router = APIRouter(prefix="/api/chat", tags=["chat"])

logger = logging.getLogger(__name__)

# code-owned builtin skill 里，其 ``prompt_fragment`` 允许进 gateway system prompt 的白名单
# （``/chat/config.trustedSkillFragments``）。安装态第三方 skill 的 fragment 永不进这里 —— 那是
# 恒注入的可信面。加名字前先问：这段文字该不该对**每一轮**对话说话。
TRUSTED_PROMPT_FRAGMENT_SKILLS = frozenset(
    {"custom_agent", "matters", "artifact_studio"}
)


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
    from src.sync.async_jobs import fetch_jobs_by_ids

    job_ids = [
        int(s["agent_job_id"])
        for s in items
        if s.get("origin") == "agent" and str(s.get("agent_job_id") or "").isdigit()
    ]
    by_id = fetch_jobs_by_ids(sync_db_path, job_ids)
    if not by_id:
        return
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
    """批量取 session 所属邮件的 subject/sender（下沉至 email_repository)."""
    from src.repository.email_repository import fetch_email_meta_by_ids

    return fetch_email_meta_by_ids(sync_db_path, email_ids)


def _matter_meta_for_sessions(
    matter_ids: List[int], sync_db_path: str
) -> Dict[int, Dict[str, Any]]:
    """批量取 matter-anchored session 的 public_id/title（下沉至 matters.repository)."""
    from src.matters.repository import fetch_matter_meta_by_ids

    return fetch_matter_meta_by_ids(sync_db_path, matter_ids)


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



def _read_hot_env_cred(env_vals: Dict[str, Any], key: str) -> str:
    """Read credential hot from .env first, falling back to process env only when absent."""
    return ((env_vals[key] if key in env_vals else os.environ.get(key)) or "").strip()


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
        return _read_hot_env_cred(env_vals, k)

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



_CHAT_CAPABLE_AGENT_TYPES = ("report", "contact_profile", "contact_governance", "custom")


def _require_chat_capable(agent_id: str, *, what: str) -> None:
    """agent 必须存在且「能对话」，否则 400。``what`` 只进 message（建群 / 加人两个入口的措辞）。"""
    # 主 agent 与事项跟进是保留成员 id：都没有 report_agent 行（身份分别在
    # owner_settings.assistant_identity / 事项域），走下面的 get_agent 必然 None → 400。放行判据是
    # **逐字相等**，不是前缀 / 命名空间 —— 保留字与真实 agent id 的碰撞在 ReportStore.create_agent
    # （唯一写点）那里拒掉。
    if agent_id in (MAIN_AGENT_MEMBER_ID, MATTER_FOLLOWUP_MEMBER_ID):
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



router.include_router(_sessions_router)
router.include_router(_groups_router)
router.include_router(_search_router)
router.include_router(_memory_router)

__all__ = [
    "router",
    "CHAIN_CAP_MAX",
    "CHAIN_CAP_MIN",
    "MAIN_AGENT_MEMBER_ID",
    "MATTER_FOLLOWUP_MEMBER_ID",
    "MAX_GROUP_MEMBERS",
    "MODEL_OVERRIDE_MAX_CHARS",
    "RESPONSE_MODES",
    "SESSION_INVOKED_BY",
    "THREAD_TITLE_MAX_CHARS",
    "TOPIC_MAX_CHARS",
    "TRUSTED_PROMPT_FRAGMENT_SKILLS",
    "group_scope_hash",
    "save_conversation_to_kos",
]
