"""agent 配置面路由 — /api/agent/* (Phase -1 / 0A capability & context foundation).

Standing Context 文档（SOUL/AGENT/RULES/USER 可编辑 + MEMORY/SKILLS 投影）的读端点 +
版本历史。owner-only（本机用户的 agent 配置）→ ``Depends(verify_cf_access)``，**不**挂
Bearer（Bearer 是 ``/api/skills`` 的外部 agent 通道，agent 改自身配置不走 scoped key）。

写端点（set/rollback）+ Settings 编辑 UI + agent profile 工具在 PR6；本路由只读 + graceful。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import secrets
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request, Response
from loguru import logger

from src.agent_config.projections import (
    resolved_skills,
    skills_doc_projection,
)
from src.agent_config.store import (
    CONTACT_AGENT_DOC_NAME,
    CONTACT_ORG_FRAME_DOC_NAME,
    INSTALLABLE_SOURCE_TYPES,
    MATTER_AGENT_DOC_NAME,
    MEMORY_DOC_NAME,
    STORABLE_DOC_NAMES,
    get_agent_config_store,
)
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access, verify_local_token

router = APIRouter(prefix="/api/agent", tags=["agent"])


def _manifest_skill_names() -> set[str]:
    """当前 manifest 里的全部 skill 名（builtin + installed），用于 enable 端点的存在性校验。"""
    from src.skills.registry import build_manifest

    return {s.name for s in build_manifest(None).skills}

# 文档展示顺序：5 个可编辑（soul/agent/rules/user/memory）+ SKILLS 投影。
# memory.md（task 07-01）是可编辑的**有界记忆**（auto-capture 自动改写 + 用户可手编），落
# agent_config.db 同一 profile-doc 存储层，但排除出 PROFILE_DOC_NAMES（不进 standing_context /
# profile_hash）——它单独经 /chat/config 的 memorySummary（MEMORY fence，untrusted 背景）注入。
_DOC_ORDER = list(STORABLE_DOC_NAMES) + ["skills"]


def _editable_doc_dict(doc: Any) -> dict[str, Any]:
    return {
        "docName": doc.doc_name,
        "content": doc.content,
        "contentHash": doc.content_hash,
        "updatedBy": doc.updated_by,
        "updatedAt": doc.updated_at,
        "editable": True,
    }


def _editable_doc_with_default(name: str, doc: Any) -> dict[str, Any]:
    payload = _editable_doc_dict(doc)
    if name == MATTER_AGENT_DOC_NAME:
        from src.matters.run_spec import default_task_contract

        payload["defaultContent"] = default_task_contract()
    elif name == CONTACT_AGENT_DOC_NAME:
        from src.contacts.governance import default_governance_prompt

        payload["defaultContent"] = default_governance_prompt()
    return payload


def _projection_doc_dict(doc_name: str, content: str) -> dict[str, Any]:
    return {
        "docName": doc_name,
        "content": content,
        "contentHash": None,
        "updatedBy": "projection",
        "updatedAt": None,
        "editable": False,
    }


def _memory_budget() -> int:
    """memory.md 硬字符预算（config.memory_md_budget_chars，默认 5000）。lazy import 守
    chat.py 同款 lazy-config 纪律（裸 worktree / CI import self-check 不炸）。"""
    from src.config import config as cfg

    return cfg.memory_md_budget_chars


def _memory_doc_dict(doc: Any) -> dict[str, Any]:
    """memory.md doc dict = 可编辑 doc + ``budgetChars``（恒注入预算，前端显著显示长度/占比）
    + 已分层时的 ``layers``（阶段 0.5-③ PR-2：每层 chars/budget，Settings 分层预算条）。

    ``layers`` 判据是**文档结构**（``memory_layer_stats`` → ``has_layer_structure``）而非 flag：
    未分层（flag 从没开过 / 老文档）→ 该键缺席，前端退回单条总预算条（现状）。
    🔴 PUT 仍只校**总**预算（``write_profile_doc``）—— 分层信息是展示，不是新的校验闸：逐节报错
    会把手编用户堵死在一份自动维护的文档上。lazy import 守 chat.py 同款 lazy-config 纪律。"""
    from src.memory.memory_md import memory_layer_stats

    d = _editable_doc_dict(doc)
    budget = _memory_budget()
    d["budgetChars"] = budget
    layers = memory_layer_stats(doc.content, budget)
    if layers is not None:
        d["layers"] = layers
    return d


def _skills_projection() -> str:
    """SKILLS.md 投影（manifest skills，PR3 后含 installed）。best-effort：失败 → 空占位。"""
    try:
        from src.skills.registry import build_manifest

        return skills_doc_projection(build_manifest(None).skills)
    except Exception:  # noqa: BLE001 — projection best-effort
        return skills_doc_projection([])


@router.get("/profile/docs", dependencies=[Depends(verify_cf_access)])
async def list_profile_docs(request: Request):
    """列出全部文档：4 份可信身份 + memory.md（可编辑，带预算，seed-on-read）+ SKILLS 投影。"""
    store = get_agent_config_store()
    docs = [_editable_doc_dict(d) for d in store.list_profile_docs()]  # soul/agent/rules/user
    docs.append(_memory_doc_dict(store.get_profile_doc(MEMORY_DOC_NAME)))
    docs.append(_projection_doc_dict("skills", _skills_projection()))
    return success_envelope({"docs": docs}, request=request, source="sqlite",
                            meta_extra={"count": len(docs)})


@router.get("/profile/docs/{name}", dependencies=[Depends(verify_cf_access)])
async def get_profile_doc(name: str, request: Request):
    """读单个文档。skills → 投影；soul/agent/rules/user/memory → store（seed-on-read）。"""
    if name == "skills":
        return success_envelope(_projection_doc_dict("skills", _skills_projection()),
                                request=request, source="sqlite")
    if name not in STORABLE_DOC_NAMES:
        raise APIError(
            "E_NOT_FOUND",
            f"unknown profile doc: {name} (expected one of {_DOC_ORDER})",
            http_status=404,
            source="sqlite",
        )
    doc = get_agent_config_store().get_profile_doc(name)
    if name == MEMORY_DOC_NAME:
        return success_envelope(_memory_doc_dict(doc), request=request, source="sqlite")
    return success_envelope(
        _editable_doc_with_default(name, doc), request=request, source="sqlite"
    )


@router.get("/profile/history", dependencies=[Depends(verify_cf_access)])
async def list_profile_history(
    request: Request,
    doc_name: Optional[str] = Query(None, alias="docName"),
    limit: int = Query(50, ge=1, le=500),
):
    """profile 文档版本历史（DESC，可按 docName 过滤）。供 rollback / 审计。"""
    if doc_name is not None and doc_name not in STORABLE_DOC_NAMES:
        raise APIError(
            "E_INVALID_ARG",
            f"docName must be one of {list(STORABLE_DOC_NAMES)}",
            http_status=400,
            source="sqlite",
        )
    entries = get_agent_config_store().list_profile_history(doc_name, limit=limit)
    data = [
        {
            "id": e.id,
            "docName": e.doc_name,
            "oldHash": e.old_hash,
            "newHash": e.new_hash,
            "changedBy": e.changed_by,
            "sessionId": e.session_id,
            "messageId": e.message_id,
            "createdAt": e.created_at,
        }
        for e in entries
    ]
    return success_envelope({"history": data}, request=request, source="sqlite",
                            meta_extra={"count": len(data)})


# ── profile 写（PR6 —— agent/用户经确认编辑 SOUL/AGENT/RULES/USER + rollback）──────────


@router.post("/profile/docs/{name}", dependencies=[Depends(verify_cf_access)])
async def write_profile_doc(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    """覆盖一个可编辑文档（SOUL/AGENT/RULES/USER/memory）。RULES.md 过 validator（deny-list
    拦截露骨的安全颠覆指令）；memory.md 过硬字符预算（恒注入每轮 prompt，拒超预算防撑爆）。
    body = {content, updatedBy?, sessionId?, messageId?}。"""
    if name not in STORABLE_DOC_NAMES:
        raise APIError("E_NOT_FOUND", f"unknown or non-editable profile doc: {name}",
                       http_status=404, source="sqlite")
    raw = body or {}
    content = raw.get("content")
    if not isinstance(content, str):
        raise APIError("E_INVALID_ARG", "body.content must be a string",
                       http_status=400, source="sqlite")
    # 身份文档为空会让恒注入的 prompt 缺一段，所以拒空；但 matter_agent 相反 ——
    # 空内容**就是**「恢复默认」的表示法（run_spec 回落代码里的任务契约），
    # 拒空等于把「恢复默认」这个动作从 API 上抹掉。
    if not content.strip() and name not in {
        MATTER_AGENT_DOC_NAME,
        CONTACT_AGENT_DOC_NAME,
        CONTACT_ORG_FRAME_DOC_NAME,
    }:
        raise APIError("E_INVALID_ARG", "body.content must be a non-empty string",
                       http_status=400, source="sqlite")
    updated_by = raw.get("updatedBy") if raw.get("updatedBy") in ("user", "agent_proposed") else "user"
    if name == "rules":
        # 安全 floor 结构上不可弱化（前端 prepend PRODUCT_SAFETY_FLOOR）；validator 是
        # belt-and-suspenders，拦截把「忽略前文 / 绕过确认」写进 RULES 的露骨尝试。
        from src.agent_config.validator import validate_rules_content

        reason = validate_rules_content(content)
        if reason:
            raise APIError("E_INVALID_ARG", reason, http_status=400, source="sqlite")
    elif name == MEMORY_DOC_NAME:
        # memory.md 恒注入每轮 system prompt（MEMORY fence）→ enforce 硬字符预算，防用户粘贴
        # 巨文撑爆每轮 prompt。非 RULES → **不**套 validate_rules_content（那是身份约束校验）；
        # memory 作 untrusted 背景注入、结构上无法弱化 PRODUCT_SAFETY_FLOOR。
        budget = _memory_budget()
        if len(content) > budget:
            raise APIError(
                "E_INVALID_ARG",
                f"memory.md exceeds the {budget}-character budget (got {len(content)}); "
                "trim it before saving",
                http_status=400, source="sqlite",
            )
    doc = get_agent_config_store().set_profile_doc(
        name, content, updated_by=updated_by,
        session_id=raw.get("sessionId"), message_id=raw.get("messageId"),
    )
    if name == MEMORY_DOC_NAME:
        return success_envelope(_memory_doc_dict(doc), request=request, source="sqlite")
    return success_envelope(
        _editable_doc_with_default(name, doc), request=request, source="sqlite"
    )


@router.post("/profile/docs/{name}/rollback", dependencies=[Depends(verify_cf_access)])
async def rollback_profile_doc(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    """把文档回滚到某历史版本（按 targetHash 定位 content_snapshot）。body = {targetHash, updatedBy?}。

    回滚**不**重复 budget 校验：历史快照落库时已在预算内（capture 截断 / 写端点 guard），恢复
    已知良好版本是显式用户操作；即便后来调小了预算，也允许恢复历史（下轮 capture 会自动再压回）。
    RULES 例外（S1 R2）：目标快照仍过 validate_rules_content（store 层），拒把越权版本回滚复活。"""
    if name not in STORABLE_DOC_NAMES:
        raise APIError("E_NOT_FOUND", f"unknown or non-editable profile doc: {name}",
                       http_status=404, source="sqlite")
    raw = body or {}
    target = raw.get("targetHash")
    if not isinstance(target, str) or not target:
        raise APIError("E_INVALID_ARG", "body.targetHash is required", http_status=400, source="sqlite")
    updated_by = raw.get("updatedBy") if raw.get("updatedBy") in ("user", "agent_proposed") else "user"
    try:
        doc = get_agent_config_store().rollback_profile_doc(
            name, target, updated_by=updated_by, session_id=raw.get("sessionId")
        )
    except KeyError as exc:
        raise APIError("E_NOT_FOUND", str(exc), http_status=404, source="sqlite") from exc
    except ValueError as exc:
        # S1 R2 — RULES 回滚目标含越权指令（store 层 validate_rules_content 拒）→ 400。
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc
    if name == MEMORY_DOC_NAME:
        return success_envelope(_memory_doc_dict(doc), request=request, source="sqlite")
    return success_envelope(
        _editable_doc_with_default(name, doc), request=request, source="sqlite"
    )


# ── chat 授权模式（07-16 approval-mode switcher；08-05 WP-11 二档化）───────────────────
#
# owner 级全局设置：manual（默认——per-tool 审批档决定弹不弹卡）/ bypass（完全授权，
# D1=a：压过 per-tool ask，无例外）。**acceptEdits 已退役**（08-05 WP-11）：它的按名
# 集合降级为 per-tool 档的「编辑放行」一键预设（POST /tool-prefs/preset）；存量存储值
# 由 store._migrate_additive 一次性行为保持折算（15 工具落显式 auto + 模式改 manual）。
# 持久真源 = agent_config.db owner_settings 行；gateway 判定时经 GET 热读（读失败
# fail-closed 回落 manual）。写入**只**来自 owner UI（verify_cf_access 双腿：本地 token
# + CF JWT，桌面与远程 web 同端点）——刻意不暴露任何 gateway 工具（防注入自我提权，
# policy_rules 同款纪律）。

CHAT_APPROVAL_MODES: tuple[str, ...] = ("manual", "bypass")
_APPROVAL_MODE_KEY = "chat_approval_mode"
CHAT_AUTO_COMPACT_MODES: tuple[str, ...] = ("on", "off")
_AUTO_COMPACT_KEY = "chat_auto_compact"

# ── 跟进 run 的网页检索档（0812 dogfood）────────────────────────────────────────────────
#
# Matter 跟进 run（matter_followup 场地）的 web class 工具面，owner 可配三档：
#   keep        —— web_search + web_fetch 都给（默认，0812 owner 拍板的现状）
#   search_only —— 只给 web_search，丢掉 web_fetch（URL 编码外传通道）
#   off         —— 整个 web class 都不给
# 语义单源在 gateway（frontend/src/ai-gateway/agentRun.ts 的 matterRunAdmitsWeb 腰带）；
# 本端点只负责**持久化 + 值域把关**，形状逐条抄 auto-compact 先例。
#
# 🔴 越域值一律 400、绝不静默回落：静默回落会让 UI 显示的档与实际生效的档劈叉，而这是
# 一个「无人值守 run 能不能出网」的安全档 —— 劈叉比报错危险得多。
# 缺省（从未设置）= 'keep'（= gateway 侧同一个默认值；gateway 读失败也 fail-safe 到它，
# 一次瞬时故障绝不静默砍掉无人值守 run 的能力）。
MATTER_RUN_WEB_FACES: tuple[str, ...] = ("keep", "search_only", "off")
MATTER_RUN_WEB_FACE_DEFAULT = "keep"
_MATTER_WEB_FACE_KEY = "matter_run_web_face"


@router.get("/approval-mode", dependencies=[Depends(verify_cf_access)])
async def get_approval_mode(request: Request):
    """读全局 chat 授权模式。无行 / 脏值 / 退役的 'acceptEdits' → 'manual'（fail-closed）。"""
    raw = get_agent_config_store().get_owner_setting(_APPROVAL_MODE_KEY)
    mode = raw if raw in CHAT_APPROVAL_MODES else "manual"
    return success_envelope({"mode": mode}, request=request, source="sqlite")


@router.put("/approval-mode", dependencies=[Depends(verify_cf_access)])
async def set_approval_mode(request: Request, body: Optional[dict[str, Any]] = None):
    """写全局 chat 授权模式。body = {mode: 'manual'|'bypass'}；越域值（含退役的
    'acceptEdits'——08-05 WP-11，降级归宿是 POST /tool-prefs/preset）一律 400。

    切换（尤其 bypass）落一条 INFO 审计日志 —— 这是所有 HITL 弹卡语义的全局越权开关。"""
    mode = (body or {}).get("mode")
    if mode not in CHAT_APPROVAL_MODES:
        raise APIError(
            "E_INVALID_ARG",
            f"body.mode must be one of {CHAT_APPROVAL_MODES}",
            http_status=400,
            source="sqlite",
        )
    store = get_agent_config_store()
    previous = store.get_owner_setting(_APPROVAL_MODE_KEY) or "manual"
    store.set_owner_setting(_APPROVAL_MODE_KEY, mode)

    logger.info(f"chat approval mode switched: {previous} → {mode} (owner UI)")
    return success_envelope({"mode": mode}, request=request, source="sqlite")


@router.get("/auto-compact", dependencies=[Depends(verify_cf_access)])
async def get_auto_compact(request: Request):
    """读 owner 自动 Compact 开关。缺行/脏值按冻结决策缺省为 on。"""
    raw = get_agent_config_store().get_owner_setting(_AUTO_COMPACT_KEY)
    mode = raw if raw in CHAT_AUTO_COMPACT_MODES else "on"
    return success_envelope({"mode": mode}, request=request, source="sqlite")


@router.put("/auto-compact", dependencies=[Depends(verify_cf_access)])
async def set_auto_compact(request: Request, body: Optional[dict[str, Any]] = None):
    """写 owner 自动 Compact 开关；仅 owner UI 可达，越域值一律 400。"""
    mode = (body or {}).get("mode")
    if mode not in CHAT_AUTO_COMPACT_MODES:
        raise APIError(
            "E_INVALID_ARG",
            f"body.mode must be one of {CHAT_AUTO_COMPACT_MODES}",
            http_status=400,
            source="sqlite",
        )
    store = get_agent_config_store()
    previous = store.get_owner_setting(_AUTO_COMPACT_KEY) or "on"
    store.set_owner_setting(_AUTO_COMPACT_KEY, mode)
    logger.info(f"chat auto compact switched: {previous} → {mode} (owner UI)")
    return success_envelope({"mode": mode}, request=request, source="sqlite")


# ── labs 实验开关（g1 群聊，task 09-01）────────────────────────────────────────────────
#
# owner_settings 型实验开关（**不新增 MAILAGENT_* env**，父设计拍板 C / 红线 6）：出厂 off，
# owner 在设置-实验室里打开。今天只有一项：
#   labs_group_agents —— 群聊多 agent 服务端编排。on = gateway 接管发言循环（候选集 / 地板 /
#   台账）；off = 退回 v1（renderer 自己的循环），v31 的表与列保留不删（AC9）。
#
# 🔴 gateway 侧读失败 **fail-closed 到 off**（lifecycle 的 resolveLabsFlags）：够不着 serve-api
# 不能变成「服务端悄悄开始编排」——那会在 owner 完全不知情时开始烧 token。
# 写入只来自 owner UI（verify_cf_access），没有任何 gateway 工具够得着（policy_rules 同款纪律）。

LABS_FLAG_VALUES: tuple[str, ...] = ("on", "off")
_LABS_GROUP_AGENTS_KEY = "labs_group_agents"


@router.get("/labs", dependencies=[Depends(verify_cf_access)])
async def get_labs_flags(request: Request):
    """读 labs 实验开关。缺行 / 脏值 → 'off'（fail-closed，同 gateway 侧的兜底值）。"""
    raw = get_agent_config_store().get_owner_setting(_LABS_GROUP_AGENTS_KEY)
    return success_envelope(
        {"groupAgents": raw if raw in LABS_FLAG_VALUES else "off"},
        request=request,
        source="sqlite",
    )


@router.put("/labs", dependencies=[Depends(verify_cf_access)])
async def set_labs_flags(request: Request, body: Optional[dict[str, Any]] = None):
    """写 labs 实验开关。body = {groupAgents: 'on'|'off'}（只写传了的键）；越域值一律 400。

    切换落一条 INFO 审计日志 —— 打开它等于把「谁来驱动群里的发言」从 renderer 换成服务端。"""
    opts = body or {}
    if "groupAgents" not in opts:
        raise APIError(
            "E_INVALID_ARG",
            "body must carry at least one labs flag (groupAgents)",
            http_status=400,
            source="sqlite",
        )
    value = opts.get("groupAgents")
    if value not in LABS_FLAG_VALUES:
        raise APIError(
            "E_INVALID_ARG",
            f"body.groupAgents must be one of {LABS_FLAG_VALUES}",
            http_status=400,
            source="sqlite",
        )
    store = get_agent_config_store()
    previous = store.get_owner_setting(_LABS_GROUP_AGENTS_KEY) or "off"
    store.set_owner_setting(_LABS_GROUP_AGENTS_KEY, value)
    logger.info(f"labs group-agents switched: {previous} → {value} (owner UI)")
    return success_envelope({"groupAgents": value}, request=request, source="sqlite")


# ── 狼人杀实验（g3）：一键建局 ────────────────────────────────────────────────────────
#
# 群聊多 agent 机制的集成验收入口：七个 agent 行（跨局复用）+ 三个群 + 三份群设置。
# 三道 404 门（labs → agent_plugins → custom_agents）与 reports.py 的导入端点同口径；
# 后两道**刻意不跨 router import** 它的私有函数（reports.py 头注纪律），各自内联薄读法。
#
# 🔴 owner 连点两次 = 两局六群（会话行不去重），故整段建局串行在一把进程内锁里。
# 🔴 日志只打 session id / seed / reusedAgents：roles 是身份表，进日志就是一次泄漏。

_WEREWOLF_LOCK = asyncio.Lock()
_WEREWOLF_TITLE_PREFIX_DEFAULT = "狼人杀"
_WEREWOLF_TITLE_PREFIX_MAX_CHARS = 40
_WEREWOLF_SEED_MAX = 2**31 - 1


@router.post("/labs/werewolf/new-game", dependencies=[Depends(verify_cf_access)])
async def werewolf_new_game(request: Request, body: Optional[dict[str, Any]] = None):
    """建一局狼人杀（labs 实验）。body 全部可选：seed / judgeModel / playerModel / titlePrefix。

    模型引用的 provider 未配置 → 400（**不静默回落全局默认**：回落的代价是第三个 turn 整局死）。
    """
    if get_agent_config_store().get_owner_setting(_LABS_GROUP_AGENTS_KEY) != "on":
        raise APIError(
            "E_NOT_FOUND",
            "group agents lab is disabled",
            http_status=404,
            hint="到设置 → 实验室打开「群聊多 agent」",
            source="sqlite",
        )
    from src.skills.flags import agent_plugins_enabled

    if not agent_plugins_enabled():
        raise APIError(
            "E_NOT_FOUND", "agent plugins feature is disabled", http_status=404, source="sqlite"
        )
    if not _custom_agents_enabled():
        raise APIError(
            "E_NOT_FOUND", "custom agents feature is disabled", http_status=404, source="sqlite"
        )

    opts = body or {}
    seed = opts.get("seed")
    if seed is None:
        seed = secrets.randbits(31)
    elif not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= _WEREWOLF_SEED_MAX:
        raise APIError(
            "E_INVALID_ARG",
            f"body.seed must be an integer within [0, {_WEREWOLF_SEED_MAX}]",
            http_status=400,
            source="sqlite",
        )
    raw_prefix = opts.get("titlePrefix")
    if raw_prefix is not None and not isinstance(raw_prefix, str):
        raise APIError(
            "E_INVALID_ARG", "body.titlePrefix must be a string", http_status=400, source="sqlite"
        )
    title_prefix = (raw_prefix or "").strip() or _WEREWOLF_TITLE_PREFIX_DEFAULT
    if len(title_prefix) > _WEREWOLF_TITLE_PREFIX_MAX_CHARS:
        raise APIError(
            "E_INVALID_ARG",
            f"body.titlePrefix must be at most {_WEREWOLF_TITLE_PREFIX_MAX_CHARS} characters",
            http_status=400,
            source="sqlite",
        )

    from src.agents import werewolf_lab

    async with _WEREWOLF_LOCK:
        result = await werewolf_lab.new_game(
            seed=seed,
            judge_model=opts.get("judgeModel"),
            player_model=opts.get("playerModel"),
            title_prefix=title_prefix,
        )
    logger.info(
        "labs werewolf new-game: main={} wolf={} seer={} seed={} reused={}".format(
            result["mainSessionId"],
            result["wolfSessionId"],
            result["seerSessionId"],
            result["seed"],
            result["reusedAgents"],
        )
    )
    return success_envelope(result, request=request, source="sqlite")


# ── 主 agent 身份（0813）：名字 + 头像 ──────────────────────────────────────────────
#
# owner 级全局设置：默认助手（interactive chat）的显示名与头像。
#   name   —— 进「{{name}} 思考中…」文案与 AiChatPanel 标题（如 Jarvis）；null = 默认 "AI 助手"
#   avatar —— 与 report_agent.avatar_json 同款 bot/image 形状；null = 官方形象 sphere/orange
# 持久真源 = agent_config.db owner_settings 行（JSON）。纯显示型配置（不进任何 prompt /
# 权限面）；系统提示词的配置面是 Standing Docs 编辑器（/api/agent/profile/docs），这里不重复。
# 校验单源：bot 词表 import 自 src/reports/wire.py（跨语言 parity 闸的 Python canonical），
# image 复用同处的 _normalize_avatar_image —— 不手抄第二份规则。

_ASSISTANT_IDENTITY_KEY = "assistant_identity"
ASSISTANT_NAME_MAX_CHARS = 40


def _normalize_assistant_avatar(avatar: Any) -> Optional[dict[str, Any]]:
    """assistant 头像校验：None / bot / image 三态（legacy oreo 不适用——主 agent 无存量行）。
    越域一律 ValueError（调用方折 400）。"""
    from src.reports.wire import (
        BOT_AVATAR_COLORS,
        BOT_AVATAR_SHAPES,
        _normalize_avatar_image,
    )

    if avatar is None:
        return None
    if not isinstance(avatar, dict):
        raise ValueError("avatar must be an object or null")
    if avatar.get("type") == "image":
        return _normalize_avatar_image(avatar)
    if avatar.get("type") == "bot":
        shape = avatar.get("shape")
        color = avatar.get("color")
        if shape not in BOT_AVATAR_SHAPES:
            raise ValueError("avatar.shape must be a supported bot shape")
        if color not in BOT_AVATAR_COLORS:
            raise ValueError("avatar.color must be a supported bot color")
        if set(avatar) != {"type", "shape", "color"}:
            raise ValueError("avatar with type=bot accepts only keys: type, shape, color")
        return {"type": "bot", "shape": shape, "color": color}
    raise ValueError("avatar.type must be 'bot' or 'image'")


def _read_assistant_identity() -> dict[str, Any]:
    """缺行/坏 JSON/坏形状 → 默认 {name: None, avatar: None}（显示型数据 fail-open 到默认脸）。"""
    raw = get_agent_config_store().get_owner_setting(_ASSISTANT_IDENTITY_KEY)
    default: dict[str, Any] = {"name": None, "avatar": None}
    if not raw:
        return default
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return default
    if not isinstance(parsed, dict):
        return default
    name = parsed.get("name")
    avatar = parsed.get("avatar")
    return {
        "name": name if isinstance(name, str) and name.strip() else None,
        "avatar": avatar if isinstance(avatar, dict) else None,
    }


@router.get("/assistant-identity", dependencies=[Depends(verify_cf_access)])
async def get_assistant_identity(request: Request):
    """读主 agent 身份（名字 + 头像）。"""
    return success_envelope(_read_assistant_identity(), request=request, source="sqlite")


@router.put("/assistant-identity", dependencies=[Depends(verify_cf_access)])
async def set_assistant_identity(request: Request, body: Optional[dict[str, Any]] = None):
    """写主 agent 身份（全量替换）。body = {name: str|null, avatar: dict|null}；
    name 去首尾空白、空串折 null、超长 400；avatar 越域 400（校验同 report agent）。"""
    payload = body or {}
    name = payload.get("name")
    if name is not None and not isinstance(name, str):
        raise APIError(
            "E_INVALID_ARG", "name must be a string or null", http_status=400, source="sqlite"
        )
    normalized_name: Optional[str] = None
    if isinstance(name, str):
        stripped = name.strip()
        if len(stripped) > ASSISTANT_NAME_MAX_CHARS:
            raise APIError(
                "E_INVALID_ARG",
                f"name must be <= {ASSISTANT_NAME_MAX_CHARS} chars",
                http_status=400,
                source="sqlite",
            )
        normalized_name = stripped or None
    try:
        normalized_avatar = _normalize_assistant_avatar(payload.get("avatar"))
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc

    identity = {"name": normalized_name, "avatar": normalized_avatar}
    get_agent_config_store().set_owner_setting(
        _ASSISTANT_IDENTITY_KEY, json.dumps(identity, ensure_ascii=False)
    )
    logger.info(
        f"assistant identity updated: name={normalized_name!r} "
        f"avatar={'set' if normalized_avatar else 'default'} (owner UI)"
    )
    return success_envelope(identity, request=request, source="sqlite")


@router.get("/matter-web-face", dependencies=[Depends(verify_cf_access)])
async def get_matter_web_face(request: Request):
    """读跟进 run 的网页检索档。缺行/脏值 → 'keep'（= gateway 侧同一个默认值）。"""
    raw = get_agent_config_store().get_owner_setting(_MATTER_WEB_FACE_KEY)
    mode = raw if raw in MATTER_RUN_WEB_FACES else MATTER_RUN_WEB_FACE_DEFAULT
    return success_envelope({"mode": mode}, request=request, source="sqlite")


@router.put("/matter-web-face", dependencies=[Depends(verify_cf_access)])
async def set_matter_web_face(request: Request, body: Optional[dict[str, Any]] = None):
    """写跟进 run 的网页检索档；仅 owner UI 可达，越域值一律 400（绝不静默回落 —— 见上方
    常量处的说明：UI 显示的档与实际生效的档劈叉，比一个 400 危险得多）。"""
    mode = (body or {}).get("mode")
    if mode not in MATTER_RUN_WEB_FACES:
        raise APIError(
            "E_INVALID_ARG",
            f"body.mode must be one of {MATTER_RUN_WEB_FACES}",
            http_status=400,
            source="sqlite",
        )
    store = get_agent_config_store()
    previous = store.get_owner_setting(_MATTER_WEB_FACE_KEY) or MATTER_RUN_WEB_FACE_DEFAULT
    store.set_owner_setting(_MATTER_WEB_FACE_KEY, mode)
    logger.info(f"matter run web face switched: {previous} → {mode} (owner UI)")
    return success_envelope({"mode": mode}, request=request, source="sqlite")


# ── built-in 写工具的 per-tool 审批档（08-05 WP-11）──────────────────────────────────
#
# canonical 注册表 = src/agent_config/tool_prefs.py（出厂默认档 + configurable +
# danger_auto）；显式覆盖行 = tool_approval_pref 表。**只作用于 manual_chat**——gateway
# 只在 manual run 上拉取（chatRun.resolveToolApprovalPrefs），headless/im 结构性拿不到。
# owner-UI 专属写面（verify_cf_access；无任何 gateway 工具可写——policy_rules 同款纪律）。

_SEND_WHITELIST_KEY = "send_recipient_whitelist"


def _send_whitelist(store) -> list[str]:
    """读 send 收件人白名单（owner_settings JSON 数组）；缺行/坏 JSON → []（= 恒 ask）。"""
    raw = store.get_owner_setting(_SEND_WHITELIST_KEY)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return []
    return [e for e in data if isinstance(e, str)] if isinstance(data, list) else []


def _tool_prefs_payload(store) -> dict[str, Any]:
    """GET /tool-prefs 的数据形状：全部注册表工具（分组有序）+ send 白名单 + 预设成员表。"""
    from src.agent_config.tool_prefs import (
        ACCEPT_EDITS_PRESET,
        BUILTIN_TOOL_POLICIES,
        effective_tool_tier,
    )

    overrides = store.get_tool_approval_prefs()
    tools = [
        {
            "toolName": p.tool_name,
            "group": p.group,
            "defaultTier": p.default_tier,
            "tier": overrides.get(p.tool_name),  # 显式覆盖（null = 跟随默认）
            "effectiveTier": effective_tool_tier(p.tool_name, overrides.get(p.tool_name)),
            "configurable": p.configurable,
            "dangerAuto": p.danger_auto,
        }
        for p in BUILTIN_TOOL_POLICIES
    ]
    return {
        "tools": tools,
        "sendWhitelist": _send_whitelist(store),
        "acceptEditsPreset": list(ACCEPT_EDITS_PRESET),
    }


def _require_configurable(tool_name: str):
    """PUT/bulk 的业务校验：工具在注册表且 configurable。返回 policy 行；否则 APIError。"""
    from src.agent_config.tool_prefs import BUILTIN_TOOL_POLICY_BY_NAME

    policy = BUILTIN_TOOL_POLICY_BY_NAME.get(tool_name)
    if policy is None:
        raise APIError(
            "E_NOT_FOUND",
            f"unknown built-in write tool: {tool_name}",
            http_status=404,
            source="sqlite",
        )
    if not policy.configurable:
        raise APIError(
            "E_INVALID_ARG",
            f"{tool_name} is not tier-configurable (its approval shape is fixed; "
            "send uses the recipient whitelist, run_command uses policy rules)",
            http_status=400,
            source="sqlite",
        )
    return policy


@router.get("/tool-prefs", dependencies=[Depends(verify_cf_access)])
async def get_tool_prefs(request: Request):
    """全部 built-in 写工具的审批档（出厂默认 + 显式覆盖 + 折算 effective）+ send 白名单。"""
    payload = _tool_prefs_payload(get_agent_config_store())
    return success_envelope(payload, request=request, source="sqlite",
                            meta_extra={"count": len(payload["tools"])})


@router.put("/tool-prefs/{tool_name}", dependencies=[Depends(verify_cf_access)])
async def set_tool_pref(tool_name: str, request: Request,
                        body: Optional[dict[str, Any]] = None):
    """写/清一个工具的显式档位。body = {tier: 'ask'|'auto'|'deny'|null}（null = 回默认）。

    危险工具（dangerAuto）设 auto 的红警告 + 一次性确认在前端（WP-10 destructive
    confirm 同款）——服务端不重复拦（owner UI 是唯一调用方）。"""
    from src.agent_config.tool_prefs import TOOL_APPROVAL_TIERS

    _require_configurable(tool_name)
    tier = (body or {}).get("tier")
    if tier is not None and tier not in TOOL_APPROVAL_TIERS:
        raise APIError(
            "E_INVALID_ARG",
            f"body.tier must be one of {TOOL_APPROVAL_TIERS} or null",
            http_status=400,
            source="sqlite",
        )
    store = get_agent_config_store()
    store.set_tool_approval_pref(tool_name, tier)
    logger.info(f"tool approval pref: {tool_name} → {tier or 'default'} (owner UI)")
    return success_envelope(_tool_prefs_payload(store), request=request, source="sqlite")


@router.post("/tool-prefs/bulk", dependencies=[Depends(verify_cf_access)])
async def bulk_set_tool_prefs(request: Request, body: Optional[dict[str, Any]] = None):
    """组级批量设档。body = {tier: 'ask'|'auto'|'deny'|null, group?: str, tools?: [names]}。

    ``group`` 与 ``tools`` 二选一（都缺 = 全部可配置工具）。目标集合里不可配置的工具
    **跳过**（组级批量把 send/run_command 也改了会静默打穿它们的专属形状）；显式
    ``tools`` 名单里出现不可配置/未知名则整批 400（显式点名必须精确）。"""
    from src.agent_config.tool_prefs import (
        BUILTIN_TOOL_POLICIES,
        TOOL_APPROVAL_TIERS,
        TOOL_PREF_GROUPS,
    )

    raw = body or {}
    tier = raw.get("tier")
    if tier is not None and tier not in TOOL_APPROVAL_TIERS:
        raise APIError(
            "E_INVALID_ARG",
            f"body.tier must be one of {TOOL_APPROVAL_TIERS} or null",
            http_status=400,
            source="sqlite",
        )
    group = raw.get("group")
    explicit = raw.get("tools")
    if group is not None and explicit is not None:
        raise APIError("E_INVALID_ARG", "pass either body.group or body.tools, not both",
                       http_status=400, source="sqlite")
    if group is not None:
        if group not in TOOL_PREF_GROUPS:
            raise APIError(
                "E_INVALID_ARG",
                f"body.group must be one of {TOOL_PREF_GROUPS}",
                http_status=400,
                source="sqlite",
            )
        names = [p.tool_name for p in BUILTIN_TOOL_POLICIES
                 if p.group == group and p.configurable]
    elif explicit is not None:
        if not isinstance(explicit, list) or not all(isinstance(n, str) for n in explicit):
            raise APIError("E_INVALID_ARG", "body.tools must be a list of tool names",
                           http_status=400, source="sqlite")
        for name in explicit:
            _require_configurable(name)  # 显式点名必须逐个合法（未知/不可配置 → 4xx）
        names = list(dict.fromkeys(explicit))
    else:
        names = [p.tool_name for p in BUILTIN_TOOL_POLICIES if p.configurable]
    store = get_agent_config_store()
    updated = store.bulk_set_tool_approval_prefs(names, tier)
    logger.info(
        f"tool approval prefs bulk: {updated} tools → {tier or 'default'} "
        f"(group={group or '-'}, owner UI)"
    )
    payload = _tool_prefs_payload(store)
    payload["updated"] = updated
    return success_envelope(payload, request=request, source="sqlite")


@router.post("/tool-prefs/preset", dependencies=[Depends(verify_cf_access)])
async def apply_tool_prefs_preset(request: Request, body: Optional[dict[str, Any]] = None):
    """套用一键预设。body = {preset: 'acceptEdits'}——07-16 acceptEdits 集合的降级归宿：
    把 15 个预设成员批量设**显式 auto**（成员表 canonical 在 tool_prefs.py，前端不手抄）。"""
    from src.agent_config.tool_prefs import ACCEPT_EDITS_PRESET

    preset = (body or {}).get("preset")
    if preset != "acceptEdits":
        raise APIError("E_INVALID_ARG", "body.preset must be 'acceptEdits'",
                       http_status=400, source="sqlite")
    store = get_agent_config_store()
    updated = store.bulk_set_tool_approval_prefs(ACCEPT_EDITS_PRESET, "auto")
    logger.info(f"tool approval prefs preset 'acceptEdits' applied ({updated} tools, owner UI)")
    payload = _tool_prefs_payload(store)
    payload["updated"] = updated
    return success_envelope(payload, request=request, source="sqlite")


@router.post("/tool-prefs/reset", dependencies=[Depends(verify_cf_access)])
async def reset_tool_prefs(request: Request):
    """Reset permissions —— 清空全部显式覆盖，所有工具回出厂默认档。"""
    store = get_agent_config_store()
    removed = store.reset_tool_approval_prefs()
    logger.info(f"tool approval prefs reset ({removed} overrides cleared, owner UI)")
    payload = _tool_prefs_payload(store)
    payload["removed"] = removed
    return success_envelope(payload, request=request, source="sqlite")


@router.put("/send-whitelist", dependencies=[Depends(verify_cf_access)])
async def set_send_whitelist(request: Request, body: Optional[dict[str, Any]] = None):
    """写 send 收件人白名单（D2=a：send 唯一的免卡形状）。body = {recipients: [str]}。

    条目 = 完整邮箱或 '@domain' 域名形状（tool_prefs.validate_send_whitelist 校验 +
    小写归一去重）；空数组 = 清空 = send 恒 ask。非法条目整批 400。"""
    from src.agent_config.tool_prefs import validate_send_whitelist

    recipients = (body or {}).get("recipients")
    try:
        normalized = validate_send_whitelist(recipients)
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc
    store = get_agent_config_store()
    store.set_owner_setting(_SEND_WHITELIST_KEY, json.dumps(normalized, ensure_ascii=False))
    logger.info(f"send recipient whitelist updated ({len(normalized)} entries, owner UI)")
    return success_envelope({"sendWhitelist": normalized}, request=request, source="sqlite")


# ── skill 管理（PR5 —— enablement 迁后端 + install/uninstall）────────────────────────


def _require_skill_creator() -> None:
    from src.skills.flags import skill_creator_enabled

    if not skill_creator_enabled():
        raise APIError(
            "E_NOT_FOUND", "skill creator feature is disabled", http_status=404, source="sqlite"
        )


def _require_agent_plugins() -> None:
    from src.skills.flags import agent_plugins_enabled

    if not agent_plugins_enabled():
        raise APIError(
            "E_NOT_FOUND", "agent plugins feature is disabled", http_status=404, source="sqlite"
        )


def _draft_dict(row: Any, *, include_tree: bool = False) -> dict[str, Any]:
    payload = {
        "id": row.id,
        "name": row.name,
        "status": row.status,
        "manifest": row.manifest,
        "validation": row.validation,
        "sourceSessionId": row.source_session_id,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    }
    if include_tree:
        from src.skills.draft import list_draft_tree

        payload["files"] = list_draft_tree(row.id) if row.status != "discarded" else []
        installed = get_agent_config_store().get_skill(row.name)
        payload["replacesInstalled"] = bool(installed and installed.files_json)
        payload["currentPackageHash"] = installed.package_hash if installed else None
    return payload


def _pack_api_error(exc: Exception) -> APIError:
    from src.skills.pack_verify import PackError

    if isinstance(exc, PackError):
        return APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite")
    return APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite")


@router.post("/skills/plugin/import", dependencies=[Depends(verify_cf_access)])
async def import_agent_plugin(request: Request, body: Optional[dict[str, Any]] = None):
    _require_agent_plugins()
    raw = body or {}
    local_path = raw.get("localPath")
    zip_base64 = raw.get("zipBase64")
    if (isinstance(local_path, str)) == (isinstance(zip_base64, str)):
        raise APIError("E_INVALID_ARG", "provide exactly one of localPath or zipBase64", http_status=400, source="sqlite")
    try:
        zip_bytes = base64.b64decode(zip_base64, validate=True) if isinstance(zip_base64, str) else None
    except (binascii.Error, ValueError) as exc:
        raise APIError("E_INVALID_ARG", "zipBase64 is invalid", http_status=400, source="sqlite") from exc
    try:
        from src.skills.plugin_import import import_plugin

        result = import_plugin(local_path=local_path, zip_bytes=zip_bytes)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope(result, request=request, source="sqlite")


@router.get("/skills/{name}/export", dependencies=[Depends(verify_cf_access)])
async def export_agent_skill(name: str, format: str = Query("skill")):
    _require_agent_plugins()
    try:
        from src.skills.plugin_export import export_skill

        payload = export_skill(name, format=format)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    suffix = "plugin" if format == "plugin" else "skill"
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}-{suffix}.zip"'},
    )


@router.get("/skills/drafts", dependencies=[Depends(verify_cf_access)])
async def list_skill_drafts(request: Request):
    _require_skill_creator()
    drafts = [_draft_dict(row) for row in get_agent_config_store().list_skill_drafts()]
    return success_envelope(
        {"drafts": drafts}, request=request, source="sqlite", meta_extra={"count": len(drafts)}
    )


@router.post("/skills/drafts", dependencies=[Depends(verify_cf_access)])
async def create_skill_draft(request: Request, body: Optional[dict[str, Any]] = None):
    _require_skill_creator()
    raw = body or {}
    name = raw.get("name")
    manifest = raw.get("manifest")
    if not isinstance(name, str):
        raise APIError("E_INVALID_ARG", "body.name is required", http_status=400, source="sqlite")
    if manifest is not None and not isinstance(manifest, dict):
        raise APIError("E_INVALID_ARG", "body.manifest must be an object", http_status=400, source="sqlite")
    try:
        from src.skills.draft import create_draft

        row = create_draft(
            name,
            manifest=manifest,
            source_session_id=raw.get("sourceSessionId")
            if isinstance(raw.get("sourceSessionId"), int) else None,
        )
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope(_draft_dict(row, include_tree=True), request=request, source="sqlite")


@router.get("/skills/drafts/{draft_id}", dependencies=[Depends(verify_cf_access)])
async def get_skill_draft(draft_id: str, request: Request):
    _require_skill_creator()
    try:
        from src.skills.draft import draft_dir

        draft_dir(draft_id)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    row = get_agent_config_store().get_skill_draft(draft_id)
    if row is None:
        raise APIError("E_NOT_FOUND", f"skill draft not found: {draft_id}", http_status=404, source="sqlite")
    return success_envelope(_draft_dict(row, include_tree=True), request=request, source="sqlite")


@router.get("/skills/drafts/{draft_id}/file", dependencies=[Depends(verify_cf_access)])
async def get_skill_draft_file(draft_id: str, request: Request, path: str = Query(...)):
    _require_skill_creator()
    try:
        from src.skills.draft import read_draft_file

        content = read_draft_file(draft_id, path)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope({"path": path, "content": content}, request=request, source="sqlite")


@router.put("/skills/drafts/{draft_id}/file", dependencies=[Depends(verify_cf_access)])
async def put_skill_draft_file(
    draft_id: str, request: Request, body: Optional[dict[str, Any]] = None
):
    _require_skill_creator()
    raw = body or {}
    path = raw.get("path")
    content = raw.get("content")
    if not isinstance(path, str) or not isinstance(content, str):
        raise APIError("E_INVALID_ARG", "body.path and body.content must be strings", http_status=400, source="sqlite")
    try:
        from src.skills.draft import write_draft_file

        result = write_draft_file(draft_id, path, content)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope(result, request=request, source="sqlite")


@router.delete("/skills/drafts/{draft_id}/file", dependencies=[Depends(verify_cf_access)])
async def remove_skill_draft_file(draft_id: str, request: Request, path: str = Query(...)):
    _require_skill_creator()
    try:
        from src.skills.draft import delete_draft_file

        removed = delete_draft_file(draft_id, path)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope({"path": path, "removed": removed}, request=request, source="sqlite")


@router.post("/skills/drafts/{draft_id}/validate", dependencies=[Depends(verify_cf_access)])
async def validate_skill_draft(draft_id: str, request: Request):
    _require_skill_creator()
    try:
        from src.skills.draft import validate_draft

        validation = validate_draft(draft_id)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope({"draftId": draft_id, "validation": validation}, request=request, source="sqlite")


@router.post("/skills/drafts/{draft_id}/publish", dependencies=[Depends(verify_cf_access)])
async def publish_skill_draft(
    draft_id: str, request: Request, body: Optional[dict[str, Any]] = None
):
    _require_skill_creator()
    enabled = (body or {}).get("enabled", True)
    if not isinstance(enabled, bool):
        raise APIError("E_INVALID_ARG", "body.enabled must be boolean", http_status=400, source="sqlite")
    try:
        from src.skills.draft import publish_draft

        result = publish_draft(draft_id, enabled)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope(result, request=request, source="sqlite")


@router.post("/skills/drafts/{draft_id}/discard", dependencies=[Depends(verify_cf_access)])
async def discard_skill_draft(draft_id: str, request: Request):
    _require_skill_creator()
    try:
        from src.skills.draft import discard_draft

        row = discard_draft(draft_id)
    except Exception as exc:  # noqa: BLE001
        raise _pack_api_error(exc) from exc
    return success_envelope(_draft_dict(row), request=request, source="sqlite")


@router.get("/skills", dependencies=[Depends(verify_cf_access)])
async def list_agent_skills(request: Request):
    """Settings 面的解析后 skill 列表：manifest skill ⋈ store 启用覆盖 + source_type。"""
    from src.skills.registry import build_manifest

    store = get_agent_config_store()
    data = resolved_skills(build_manifest(None).skills, store)
    return success_envelope({"skills": data}, request=request, source="sqlite",
                            meta_extra={"count": len(data)})


@router.get("/skills/entrypoints", dependencies=[Depends(verify_cf_access)])
async def list_skill_entrypoints(request: Request):
    """Settings per-agent「自动化策略」exec 规则构造器的数据源（S5 W5b，ADR-004 D5）。

    只列**供应链 installed** skill（``files_json`` 非空 = confirm 落库事实；builtin/声明行
    无逐文件清单，构造不出 pinned-entrypoint）：``{name, dir, files}`` —— 前端据此组装
    matcher（``argv[1]`` pin = ``dir/relpath``、可选 ``cwd_scope`` pin = ``dir``），不在 TS
    手抄 skills root。flag off → 404（该面只服务 per-agent 建规，S4 纪律）。
    """
    if not _custom_agents_enabled():
        raise APIError("E_NOT_FOUND", "custom agents feature is disabled",
                       http_status=404, source="sqlite")
    from src.skills.pack_fetch import skill_dir

    out: list[dict[str, Any]] = []
    for row in get_agent_config_store().list_skills():
        if not row.files_json:
            continue
        try:
            files = json.loads(row.files_json)
        except (ValueError, TypeError):
            continue
        if not isinstance(files, dict) or not files:
            continue
        out.append({
            "name": row.skill_name,
            "dir": skill_dir(row.skill_name),
            "files": sorted(files.keys()),
        })
    out.sort(key=lambda x: x["name"])
    return success_envelope({"skills": out}, request=request, source="sqlite",
                            meta_extra={"count": len(out)})


def _skill_trust_dict(trust: Any, current_hash: Optional[str]) -> dict[str, Any]:
    state = (
        "revoked"
        if trust.revoked_at is not None
        else "trusted"
        if current_hash and trust.package_hash == current_hash
        else "stale"
    )
    return {
        "id": trust.id,
        "skillName": trust.skill_name,
        "packageHash": trust.package_hash,
        "entrypoint": trust.entrypoint,
        "policy": trust.policy,
        "trustedAt": trust.trusted_at,
        "revokedAt": trust.revoked_at,
        "state": state,
    }


def _validated_trust_policy(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise APIError("E_INVALID_ARG", "body.policy must be an object", http_status=400, source="sqlite")
    allowed = {
        "argvPattern", "cwdScope", "readScopes", "writeScopes", "networkMode", "secretNames"
    }
    unknown = set(raw) - allowed
    if unknown:
        raise APIError(
            "E_INVALID_ARG", f"unknown policy fields: {sorted(unknown)}", http_status=400, source="sqlite"
        )
    policy: dict[str, Any] = {}
    for key in ("argvPattern", "cwdScope", "readScopes", "writeScopes", "secretNames"):
        value = raw.get(key, [])
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise APIError("E_INVALID_ARG", f"policy.{key} must be a string array", http_status=400, source="sqlite")
        policy[key] = value
    network_mode = raw.get("networkMode", "off")
    if network_mode not in {"off", "gated"}:
        raise APIError("E_INVALID_ARG", "policy.networkMode must be off or gated", http_status=400, source="sqlite")
    policy["networkMode"] = network_mode
    return policy


@router.get("/skills/{name}/trust", dependencies=[Depends(verify_cf_access)])
async def list_skill_trust(name: str, request: Request):
    _require_skill_creator()
    store = get_agent_config_store()
    row = store.get_skill(name)
    if row is None:
        raise APIError("E_NOT_FOUND", f"skill not installed: {name}", http_status=404, source="sqlite")
    trusts = [_skill_trust_dict(item, row.package_hash) for item in store.list_skill_trust(name)]
    return success_envelope(
        {"skillName": name, "currentPackageHash": row.package_hash, "trusts": trusts},
        request=request,
        source="sqlite",
        meta_extra={"count": len(trusts)},
    )


@router.post("/skills/{name}/trust", dependencies=[Depends(verify_cf_access)])
async def grant_skill_trust(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    _require_skill_creator()
    raw = body or {}
    entrypoint = raw.get("entrypoint")
    if not isinstance(entrypoint, str) or not os.path.isabs(entrypoint):
        raise APIError("E_INVALID_ARG", "body.entrypoint must be an absolute path", http_status=400, source="sqlite")
    policy = _validated_trust_policy(raw.get("policy"))
    store = get_agent_config_store()
    row = store.get_skill(name)
    if row is None or not row.package_hash or not row.files_json:
        raise APIError("E_NOT_FOUND", f"supply-chain skill not installed: {name}", http_status=404, source="sqlite")
    try:
        files = json.loads(row.files_json)
    except (TypeError, ValueError):
        files = None
    if not isinstance(files, dict) or not files:
        raise APIError("E_INVALID_ARG", "skill has no file manifest", http_status=400, source="sqlite")
    from src.skills.pack_fetch import skill_dir

    root = os.path.realpath(skill_dir(name))
    rp = os.path.realpath(entrypoint)
    rel = rp[len(root) + 1:].replace(os.sep, "/") if rp.startswith(root + os.sep) else None
    if rel is None or rel not in files:
        raise APIError("E_INVALID_ARG", "entrypoint is not in the current skill file manifest", http_status=400, source="sqlite")
    trust = store.grant_skill_trust(uuid.uuid4().hex, name, row.package_hash, rp, policy)
    return success_envelope(_skill_trust_dict(trust, row.package_hash), request=request, source="sqlite")


@router.delete("/skills/{name}/trust/{trust_id}", dependencies=[Depends(verify_cf_access)])
async def revoke_skill_trust(name: str, trust_id: str, request: Request):
    _require_skill_creator()
    store = get_agent_config_store()
    if not any(item.id == trust_id for item in store.list_skill_trust(name)):
        raise APIError("E_NOT_FOUND", f"skill trust not found: {trust_id}", http_status=404, source="sqlite")
    revoked = store.revoke_skill_trust(trust_id)
    return success_envelope({"id": trust_id, "revoked": revoked}, request=request, source="sqlite")


@router.post("/skills/{name}/enabled", dependencies=[Depends(verify_cf_access)])
async def set_skill_enabled(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    """启用/禁用一个 skill（builtin 懒建覆盖行 / installed 更新行）。body = {enabled: bool}。"""
    raw = body or {}
    enabled = raw.get("enabled")
    if not isinstance(enabled, bool):
        raise APIError("E_INVALID_ARG", "body.enabled must be a JSON boolean",
                       http_status=400, source="sqlite")
    if name not in _manifest_skill_names():
        raise APIError("E_NOT_FOUND", f"unknown skill: {name}", http_status=404, source="sqlite")
    store = get_agent_config_store()
    # builtin skill 懒建 source_type='builtin'；installed skill 已有行 → set_enabled 只更 enabled。
    existing = store.get_skill(name)
    source_type = existing.source_type if existing else "builtin"
    store.set_enabled(name, enabled, source_type=source_type)
    return success_envelope({"name": name, "enabled": enabled}, request=request, source="sqlite")


@router.post("/skills", dependencies=[Depends(verify_cf_access)])
async def install_agent_skill(request: Request, body: Optional[dict[str, Any]] = None):
    """安装一个用户来源 skill。body = {name, sourceType, manifest, version?, sourceUri?,
    grantedScopes?, packageHash?, trusted?, enabled?}。grantedScopes 写时校验 ⊆ KNOWN_SCOPES。"""
    raw = body or {}
    name = raw.get("name")
    source_type = raw.get("sourceType")
    manifest = raw.get("manifest")
    if not isinstance(name, str) or not name.strip():
        raise APIError("E_INVALID_ARG", "body.name is required", http_status=400, source="sqlite")
    if source_type not in INSTALLABLE_SOURCE_TYPES:
        raise APIError("E_INVALID_ARG",
                       f"body.sourceType must be one of {list(INSTALLABLE_SOURCE_TYPES)}",
                       http_status=400, source="sqlite")
    if manifest is not None and not isinstance(manifest, dict):
        raise APIError("E_INVALID_ARG", "body.manifest must be an object", http_status=400,
                       source="sqlite")
    store = get_agent_config_store()
    try:
        skill = store.install_skill(
            name.strip(),
            source_type=source_type,
            manifest=manifest,
            manifest_version=raw.get("manifestVersion"),
            version=raw.get("version"),
            source_uri=raw.get("sourceUri"),
            granted_scopes=raw.get("grantedScopes"),
            package_hash=raw.get("packageHash"),
            trusted=bool(raw.get("trusted", False)),
            enabled=raw.get("enabled") if isinstance(raw.get("enabled"), bool) else None,
        )
    except ValueError as exc:  # 非法 scope / source_type
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc
    return success_envelope(
        {"name": skill.skill_name, "sourceType": skill.source_type},
        request=request, source="sqlite", status_code=201,
    )


def _full_uninstall(name: str) -> dict[str, Any]:
    """全清理卸载单源（W4 收口）：删 agent_skills 行 + 删 ``<skills>/<name>/`` 落盘目录 + 删
    skill_secrets 行。``POST /skills/uninstall`` 与旧 ``DELETE /skills/{name}`` 的 pack 分支共用
    —— 两条路径必须同一份清理集，否则同名重装会收养 stale secrets（W2 review P2-2）。幂等。"""
    from src.skills.pack_fetch import remove_skill_dir

    store = get_agent_config_store()
    removed_row = store.uninstall_skill(name)
    removed_dir = remove_skill_dir(name)
    removed_secrets = store.delete_skill_secrets(name)
    return {
        "name": name,
        "removed": removed_row or removed_dir,
        "removedDir": removed_dir,
        "removedSecrets": removed_secrets,
    }


@router.delete("/skills/{name}", dependencies=[Depends(verify_cf_access)])
async def uninstall_agent_skill(name: str, request: Request):
    """卸载一个 skill 行。**deprecated-for-packs**（W4 收口，W2 review P2-2）：pack 安装行
    （判据 = ``files_json`` 非空 —— 只有供应链 confirm 会写它；document/mcp 声明行与 builtin
    懒行都不写）→ 委托与 ``POST /skills/uninstall`` 相同的全清路径（行+目录+secrets），防
    「仅删行 → 同名重装收养 stale secrets/目录」。非 pack 行为不变：builtin 懒行删除 = 回退
    代码默认；document/mcp 声明行只删行（本就无目录/secrets 生命周期）。幂等。"""
    store = get_agent_config_store()
    existing = store.get_skill(name)
    if existing is not None and existing.files_json:
        return success_envelope(_full_uninstall(name), request=request, source="sqlite")
    removed = store.uninstall_skill(name)
    return success_envelope({"name": name, "removed": removed}, request=request, source="sqlite")


# ── skill 供应链（S2 W2 —— 两段式安装：fetch → confirm，+ 全清理 uninstall）─────────────────
# owner-only（verify_cf_access）。gateway W4 的 skill_install/confirm/uninstall 工具经这三个端点执行；
# Settings 安装 UI 也走同一族。业务权威在 Python（下载 SSRF 硬化 / 安全解包 / hash 实算 / re-hash
# TOCTOU 校验全在此），gateway 只做 schema + 审批接线。


# SKILL.md 节选上限（preview 卡片显示；全文经 W4 skill_read 围栏读）。
_SKILL_MD_EXCERPT_MAX = 4096


@router.post("/skills/fetch", dependencies=[Depends(verify_cf_access)])
async def fetch_agent_skill(request: Request, body: Optional[dict[str, Any]] = None):
    """两段式第一段：下载（URL）/ 导入（本地 zip 或目录）skill 包 → quarantine → 安全解包 + manifest
    v2 校验 + hash。**不安装**（仅落 quarantine）。body = {sourceUrl?} 或 {localPath?}（二选一）。

    返回 preview：quarantineId + packageHash + 文件表（路径+每文件 sha256）+ manifest 摘要 + 声明的
    secret 名 + SKILL.md 节选。owner 审阅后带 quarantineId + packageHash + files 调 /confirm 真安装。"""
    from src.skills.pack_fetch import fetch_pack
    from src.skills.pack_verify import PackError

    raw = body or {}
    source_url = raw.get("sourceUrl")
    local_path = raw.get("localPath")
    if bool(source_url) == bool(local_path):
        raise APIError(
            "E_INVALID_ARG",
            "exactly one of body.sourceUrl / body.localPath is required",
            http_status=400,
            source="sqlite",
        )
    if source_url is not None and not isinstance(source_url, str):
        raise APIError("E_INVALID_ARG", "body.sourceUrl must be a string", http_status=400, source="sqlite")
    if local_path is not None and not isinstance(local_path, str):
        raise APIError("E_INVALID_ARG", "body.localPath must be a string", http_status=400, source="sqlite")

    try:
        res = fetch_pack(
            source_url=source_url if source_url else None,
            local_path=local_path if local_path else None,
        )
    except PackError as exc:
        # 结构化 code（E_PACK_* / E_UPSTREAM / E_CONTENT_TYPE …）+ 各自 http_status 透传，供 W4 壳展示。
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc

    m = res.manifest_dict
    secret_names = [
        s.get("name") for s in (m.get("secrets") or []) if isinstance(s, dict) and s.get("name")
    ]
    preview = {
        "quarantineId": res.quarantine_id,
        "sourceType": res.source_type,
        "sourceUri": res.source_uri,
        "packageHash": res.package_hash,
        "files": res.files,  # {relpath: sha256} —— confirm 时原样回传作 expectedFiles
        "manifest": {
            "name": m.get("name"),
            "type": m.get("type"),
            "version": m.get("version"),
            "title": m.get("title"),
            "description": m.get("description"),
            "entryHint": m.get("entry_hint"),
            "manifestVersion": m.get("manifest_version"),
        },
        "secretNames": secret_names,
        "skillMdExcerpt": res.skill_md[:_SKILL_MD_EXCERPT_MAX],
    }
    return success_envelope(preview, request=request, source="sqlite")


@router.post("/skills/confirm", dependencies=[Depends(verify_cf_access)])
async def confirm_agent_skill(request: Request, body: Optional[dict[str, Any]] = None):
    """两段式第二段：按 quarantineId **重算** quarantine content 的 hash 比对 owner 批准的事实
    （expectedPackageHash + expectedFiles，TOCTOU 防 preview→落盘间被替换）→ 落 agent_skills 行 →
    atomic rename content 到 <skills>/<name>。hash 不符 → 409。body = {quarantineId, expectedPackageHash,
    expectedFiles?}。"""
    from src.skills.pack_fetch import confirm_pack, promote_content
    from src.skills.pack_verify import PackError

    raw = body or {}
    qid = raw.get("quarantineId")
    expected_hash = raw.get("expectedPackageHash")
    expected_files = raw.get("expectedFiles")
    if not isinstance(qid, str) or not qid:
        raise APIError("E_INVALID_ARG", "body.quarantineId is required", http_status=400, source="sqlite")
    if not isinstance(expected_hash, str) or not expected_hash:
        raise APIError(
            "E_INVALID_ARG", "body.expectedPackageHash is required", http_status=400, source="sqlite"
        )
    if expected_files is not None and not isinstance(expected_files, dict):
        raise APIError("E_INVALID_ARG", "body.expectedFiles must be an object", http_status=400, source="sqlite")

    try:
        result = confirm_pack(qid, expected_hash, expected_files)
    except PackError as exc:
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc

    store = get_agent_config_store()
    # 先落新行数据（含 manifest/hash/files），再 atomic swap 目录（升级语义，失败不留半成品）。
    try:
        store.install_skill(
            result.name,
            source_type=result.source_type,
            manifest=result.manifest_dict,
            manifest_version=result.manifest_version,
            version=result.manifest_dict.get("version"),
            source_uri=result.source_uri,
            package_hash=result.package_hash,
            files_json=json.dumps(result.files, ensure_ascii=False, sort_keys=True),
        )
    except ValueError as exc:  # slug / manifest.name 不一致 / 非法 scope
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc

    try:
        promote_content(qid, result.name)
    except PackError as exc:
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc

    return success_envelope(
        {"name": result.name, "sourceType": result.source_type, "packageHash": result.package_hash},
        request=request,
        source="sqlite",
        status_code=201,
    )


# ── per-skill 密钥（S2 W3 —— Settings 后端；UI 是 W4）──────────────────────────────────
# owner-only（verify_cf_access）。值经 Fernet 加密落 agent_config.db（master key 单条进 Keychain），
# **永不**回显：GET 只出名字 + updated_at；PUT 写后不返回值；脚本执行时经 exec 端点注入子进程 env
# （src/agent_config/secrets.py + src/api/routers/exec.py）。secret 名过 env-regex + reserved deny
# （防覆盖执行环境 / 冒充全局密钥），skill 存在性对齐 set_skill_enabled 的 manifest 校验。


@router.get("/skills/{name}/secrets", dependencies=[Depends(verify_cf_access)])
async def list_skill_secrets(name: str, request: Request):
    """列一个 skill 已存储的密钥 —— **只名字 + updatedAt，永无值**（Settings 抽屉 write-only 蒙版）。"""
    meta = get_agent_config_store().skill_secret_meta(name)
    data = [{"name": n, "updatedAt": ts} for n, ts in meta]
    return success_envelope(
        {"secrets": data}, request=request, source="sqlite", meta_extra={"count": len(data)}
    )


@router.put(
    "/skills/{name}/secrets/{secret_name}", dependencies=[Depends(verify_cf_access)]
)
async def set_skill_secret(
    name: str, secret_name: str, request: Request, body: Optional[dict[str, Any]] = None
):
    """写/替换一个 per-skill 密钥（Fernet 加密落库）。body = {value}（write-only，响应**不回显值**）。
    双重校验：skill 存在（manifest 名） + secret 名合法（env-regex + reserved deny）。"""
    from src.agent_config.secrets import set_secret
    from src.skills.secret_names import validate_secret_name

    if name not in _manifest_skill_names():
        raise APIError("E_NOT_FOUND", f"unknown skill: {name}", http_status=404, source="sqlite")
    reason = validate_secret_name(secret_name)
    if reason:
        raise APIError("E_INVALID_ARG", reason, http_status=400, source="sqlite")
    raw = body or {}
    value = raw.get("value")
    if not isinstance(value, str) or not value:
        raise APIError("E_INVALID_ARG", "body.value must be a non-empty string",
                       http_status=400, source="sqlite")
    set_secret(name, secret_name, value)  # 值不进响应/日志
    meta = dict(get_agent_config_store().skill_secret_meta(name))
    return success_envelope(
        {"name": name, "secretName": secret_name, "updatedAt": meta.get(secret_name)},
        request=request, source="sqlite",
    )


@router.delete(
    "/skills/{name}/secrets/{secret_name}", dependencies=[Depends(verify_cf_access)]
)
async def delete_skill_secret(name: str, secret_name: str, request: Request):
    """删一个 per-skill 密钥。幂等（无行 removed=false）。secret 名过校验（防畸形 path 触发 500）。"""
    from src.agent_config.secrets import delete_secret
    from src.skills.secret_names import validate_secret_name

    reason = validate_secret_name(secret_name)
    if reason:
        raise APIError("E_INVALID_ARG", reason, http_status=400, source="sqlite")
    removed = delete_secret(name, secret_name)
    return success_envelope(
        {"name": name, "secretName": secret_name, "removed": removed},
        request=request, source="sqlite",
    )


@router.post("/skills/uninstall", dependencies=[Depends(verify_cf_access)])
async def uninstall_agent_skill_full(request: Request, body: Optional[dict[str, Any]] = None):
    """全清理卸载（S2 W2）：删 agent_skills 行 + 删 <skills>/<name>/ 落盘目录 + 删 skill_secrets 行。
    body = {name}。密钥 Keychain master key 不动（W3 拥有加解密生命周期）。幂等。W4 起清理集
    收敛进 ``_full_uninstall``（与旧 DELETE 的 pack 分支单源）。"""
    raw = body or {}
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise APIError("E_INVALID_ARG", "body.name is required", http_status=400, source="sqlite")
    return success_envelope(_full_uninstall(name.strip()), request=request, source="sqlite")


# ── skill 供应链读面（S2 W4 —— 审批卡服务端事实渲染 + skill_read 文档 + per-skill 配置）────────


@router.get("/skills/quarantine/{qid}", dependencies=[Depends(verify_cf_access)])
async def get_quarantine_facts(qid: str, request: Request):
    """SkillInstallConfirmCard 的服务端事实源（ADR-002 §4：模型无法在卡上谎报包内容）——按
    quarantine_id **重算** ``verify_content_dir``（卡上 hash = 盘上真相，非读 meta 缓存），返回
    与 fetch preview 同形状的事实。qid 非法 → 400；quarantine 不存在 → 404。"""
    from src.skills.pack_fetch import _quarantine_dir, _read_meta
    from src.skills.pack_verify import PackError, verify_content_dir

    try:
        qdir = _quarantine_dir(qid)  # _QID_RE + realpath 含界闸（pack_fetch 单源）
    except PackError as exc:
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc
    content = os.path.join(qdir, "content")
    if not os.path.isdir(content):
        raise APIError("E_NOT_FOUND", f"quarantine not found: {qid}", http_status=404, source="sqlite")
    try:
        vp = verify_content_dir(content)  # 重算 —— 与 fetch/confirm 同一算法
    except PackError as exc:
        raise APIError(exc.code, exc.message, http_status=exc.http_status, source="sqlite") from exc

    meta = _read_meta(qdir)
    m = vp.manifest_dict
    secret_names = [
        s.get("name") for s in (m.get("secrets") or []) if isinstance(s, dict) and s.get("name")
    ]
    return success_envelope(
        {
            "quarantineId": qid,
            "sourceType": meta.get("source_type"),
            "sourceUri": meta.get("source_uri"),
            "packageHash": vp.package_hash,
            "files": vp.files,
            "manifest": {
                "name": m.get("name"),
                "type": m.get("type"),
                "version": m.get("version"),
                "title": m.get("title"),
                "description": m.get("description"),
                "entryHint": m.get("entry_hint"),
                "manifestVersion": m.get("manifest_version"),
            },
            "secretNames": secret_names,
            "skillMdExcerpt": vp.skill_md[:_SKILL_MD_EXCERPT_MAX],
        },
        request=request,
        source="sqlite",
    )


# SKILL.md 服务器侧读取上限（防怪物文件一口气进内存/响应；TS 进模型上下文前再截 32KB + 围栏）。
_SKILL_DOC_CAP_BYTES = 64 * 1024
# config.json 写入上限。
_SKILL_CONFIG_CAP_BYTES = 64 * 1024


def _installed_skill_dir(name: str) -> str:
    """name 过 ``_SKILL_NAME_RE`` + realpath 含界 → ``<skills>/<name>`` 绝对路径。非法名 → 400。"""
    from src.agent_config.store import _SKILL_NAME_RE
    from src.skills.pack_fetch import skill_dir, skills_data_root

    if not _SKILL_NAME_RE.match(name or ""):
        raise APIError("E_INVALID_ARG", f"invalid skill name: {name!r}", http_status=400, source="sqlite")
    d = skill_dir(name)
    root = os.path.realpath(skills_data_root())
    rd = os.path.realpath(d)
    if rd != root and not rd.startswith(root + os.sep):  # belt-and-suspenders（正则已挡 / 与 .）
        raise APIError("E_INVALID_ARG", "skill name escapes skills root", http_status=400, source="sqlite")
    return d


@router.get("/skills/{name}/doc", dependencies=[Depends(verify_cf_access)])
async def get_skill_doc(name: str, request: Request):
    """读一个已落盘 skill 的 SKILL.md **原文**（W4 ``skill_read`` 工具的数据源）。第三方文本的
    围栏（``UNTRUSTED_SKILL_DOC`` + 32KB 截断 + 警示头）是 TS 壳进模型上下文时的职责 —— 本端点
    不围栏（Settings 等 owner 面也读原文）。服务器侧 cap 64KB 防怪物文件。无文件 → 404。

    ``installDir``（issue #62）= 该 skill 的**绝对**安装目录。SKILL.md 普遍写「在安装目录下执行」，
    而工具此前不给绝对路径 → 模型只能推断出 ``sh -lc "cd <dir> && python3 f.py"`` 的壳包装写法，
    正是 exec 端点会 409 硬拒（且此前会静默丢掉 secret 注入）的形状。路径由 Python 权威给出，
    TS 不手抄 skills root（同 ``/skills/entrypoints`` 的 ``dir``）。

    **builtin fallback**（阶段 0.5 技能可发现性）：code-owned builtin skill 的文档在仓内
    ``src/skills/docs/<name>/SKILL.md``，此前对 ``skill_read`` 是 404 —— 6 份 builtin 说明书模型
    一个字都读不到。命中 builtin 时返回其原文，且 ``installDir=None``（builtin 没有可执行的落盘
    目录；给个假路径会污染 issue #62 的 run_hint 语义）。``source`` 字段让 TS 壳能**明确**区分
    builtin 与 installed，而不是拿 ``installDir is None`` 去反推（老服务端没有该字段时也是 None，
    两种情形长得一样）。builtin 先于 installed 判定，与 registry 的「同名 builtin 胜出」一致。"""
    from src.skills.registry import builtin_doc_file

    # 非法名（BAD..NAME）不匹配任何 builtin → None → 落到 _installed_skill_dir 抛 400（既有契约不变）。
    builtin_path = builtin_doc_file(name)
    if builtin_path is not None:
        return _skill_doc_envelope(name, builtin_path, install_dir=None, source="builtin", request=request)
    d = _installed_skill_dir(name)
    path = os.path.join(d, "SKILL.md")
    if not os.path.isfile(path):
        raise APIError("E_NOT_FOUND", f"skill doc not found: {name}", http_status=404, source="sqlite")
    return _skill_doc_envelope(name, path, install_dir=d, source="installed", request=request)


def _skill_doc_envelope(name: str, path: str, *, install_dir: Optional[str], source: str, request: Request):
    """读一份 SKILL.md（64KB cap）→ 统一 envelope。builtin / installed 两条路共用。"""
    try:
        with open(path, "rb") as f:
            raw = f.read(_SKILL_DOC_CAP_BYTES + 1)
    except OSError as exc:
        raise APIError("E_INTERNAL", f"cannot read skill doc: {exc}", http_status=500, source="sqlite") from exc
    truncated = len(raw) > _SKILL_DOC_CAP_BYTES
    content = raw[:_SKILL_DOC_CAP_BYTES].decode("utf-8", errors="replace")
    return success_envelope(
        {
            "name": name,
            "content": content,
            "truncated": truncated,
            "installDir": install_dir,
            "source": source,
        },
        request=request,
        source="sqlite",
    )


@router.get("/skills/{name}/config", dependencies=[Depends(verify_cf_access)])
async def get_skill_config(name: str, request: Request):
    """读一个已安装 skill 的非敏感配置 ``<skills>/<name>/config.json``（明文 owner 面，脚本共读；
    密钥**不在**这 —— 密钥走 W3 的 secrets 端点/Fernet）。skill 目录不存在 → 404；无 config.json
    → 空配置 ``{}``。W4b Settings 消费。"""
    d = _installed_skill_dir(name)
    if not os.path.isdir(d):
        raise APIError("E_NOT_FOUND", f"skill not installed: {name}", http_status=404, source="sqlite")
    path = os.path.join(d, "config.json")
    config: dict[str, Any] = {}
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                config = data
        except (OSError, json.JSONDecodeError):
            config = {}  # 坏文件 → 空配置（owner 可 PUT 覆盖修复）
    return success_envelope({"name": name, "config": config}, request=request, source="sqlite")


@router.put("/skills/{name}/config", dependencies=[Depends(verify_cf_access)])
async def put_skill_config(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    """写一个已安装 skill 的非敏感配置（整体覆盖 ``config.json``）。body 必须是 JSON object 且
    序列化 ≤64KB；skill 目录不存在 → 404。"""
    d = _installed_skill_dir(name)
    if not os.path.isdir(d):
        raise APIError("E_NOT_FOUND", f"skill not installed: {name}", http_status=404, source="sqlite")
    if not isinstance(body, dict):
        raise APIError("E_INVALID_ARG", "body must be a JSON object", http_status=400, source="sqlite")
    serialized = json.dumps(body, ensure_ascii=False, sort_keys=True)
    if len(serialized.encode("utf-8")) > _SKILL_CONFIG_CAP_BYTES:
        raise APIError(
            "E_INVALID_ARG",
            f"config exceeds {_SKILL_CONFIG_CAP_BYTES} bytes",
            http_status=400,
            source="sqlite",
        )
    try:
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            f.write(serialized)
    except OSError as exc:
        raise APIError("E_INTERNAL", f"cannot write config: {exc}", http_status=500, source="sqlite") from exc
    return success_envelope({"name": name, "config": body}, request=request, source="sqlite")


# ── exec 策略白名单（S2 W1 —— PolicyRule CRUD + evaluate；S5 ADR-004 扩 per-agent）──────────
# 结构化白名单规则（ADR-001 §6 D4）：owner 经审批卡「总是允许」/ Settings 管理页产生，模型**无**
# 创建通道（policy_rules 不暴露任何 gateway 工具）。evaluate 供 gateway W1b 的 needsApproval 前置调用
# 决定免卡；exec 端点内部也调它作审计透传。业务权威在 Python，评估 fail-closed（异常→ask）。
# S5 per-agent（ADR-004 §3.3/§4.3）：create 收 agentId → headless 规则分支（flag 门控 + 归属校验 +
# context_mode 从 agent trigger.kind 派生 + exec 只认 pinned-entrypoint 形状）；全局（无 agentId）
# 分支词汇与语义 S2 逐字不变。


def _custom_agents_enabled() -> bool:
    """读 ``MAILAGENT_CUSTOM_AGENTS_ENABLED``（对齐 agent_runs 路由的 lazy 读法）。异常 →
    fail-closed False。"""
    from src.api.deps import get_settings

    try:
        return bool(get_settings().custom_agents_enabled)
    except Exception:  # noqa: BLE001 — 配置读失败 → 保守当 feature off
        return False


# per-agent 规则的 capability 面：domain_write（ADR-004 D1 免卡）+ exec（D2 pinned-entrypoint）+
# web（S6 W3, ADR-004 rev3.1 D2/F#1 —— gated web_fetch 的域名白名单，matcher = WebMatcher
# {v:1, origin}，无 headless 专用形状闸：origin 白名单对 manual 与 headless 同样合法，双键隔离
# 即唯一结构约束）。file_read/file_write 不在设计面（无形状约束设计），建规拒 —— 需要时随对应
# grant 键另立 ADR。
_PER_AGENT_CAPABILITIES: tuple[str, ...] = ("domain_write", "exec", "web")


def _derive_rule_context_mode(agent: dict[str, Any]) -> str:
    """per-agent 规则的 context_mode **只**从 agent trigger.kind 派生（ADR-004 §3.3：表单/请求
    不可选 —— 用户没有机会配出跨上下文规则）：email_filter → untrusted_trigger /
    cron|schedule → cron_headless（schedule = schedule-builder 结构化定时，与 cron 同为
    无攻击者可控输入的定时 headless）/ im → im_chat（阶段 0b 预置，harness-expansion epic
    grill Q10=A —— 阶段 2 飞书对话的第四场合）。坏 trigger → ValueError（400）。

    🔴 本表共 **三份镜像**，改任何一份必须同批改齐（漏改 = 盖章与求值失配 → 免卡规则
    永不命中 / 抽屉全 dormant）：① 本函数（建规盖章权威）② gateway
    ``frontend/src/ai-gateway/agentRun.ts::deriveContextMode``（运行时求值）③ 抽屉
    ``frontend/src/shared/components/agents/custom-agent/shared.ts::deriveHeadlessMode``
    （展示）。跨表一致性闸：``tests/api/test_context_mode_consistency.py``（canonical 表
    在闸里，TS 两份从源码抽取比对 —— 改这里先改闸）。"""
    from src.agents.trigger import _as_dict, parse_trigger, parse_trigger_set, trigger_v2_enabled

    # 阶段 0b 预置映射行：kind='im' → 'im_chat'。parse_trigger 尚不认识 'im'（保存面在阶段 2
    # 才放开，validate_agent_config_patch 仍拒 → 这种行当前存不进库，本分支 dormant），故在
    # parse 前 peek 原始 kind；``_as_dict`` 是有意的私有 import（trigger_json 归一化单源，
    # 镜像 test_trigger_kind_parity 对 ``_RULE_KEYS`` 的处理）。阶段 2 给 parse_trigger 加
    # im 分支后应把此 peek 收回 post-parse。
    raw = _as_dict(agent.get("trigger_json")) or {}
    if raw.get("kind") == "im" or any(
        isinstance(item, dict) and item.get("kind") == "im"
        for item in (raw.get("triggers") if isinstance(raw.get("triggers"), list) else [])
    ):
        return "im_chat"
    if trigger_v2_enabled() and raw.get("v") == 2:
        entries = parse_trigger_set(raw)
        if not entries:
            raise ValueError("trigger_json is empty or not an object")
        return (
            "cron_headless"
            if all(entry.trigger.kind in ("cron", "schedule") for entry in entries)
            else "untrusted_trigger"
        )
    trig = parse_trigger(agent.get("trigger_json"))  # TriggerValidationError（ValueError）on 坏配置
    return "cron_headless" if trig.kind in ("cron", "schedule") else "untrusted_trigger"


def _policy_rule_dict(r: Any) -> dict[str, Any]:
    from src.agent_config.policy import rule_is_dangerously_wide

    return {
        "id": r.id,
        "capability": r.capability,
        "matcher": r.matcher,
        "contextMode": r.context_mode,
        "agentId": r.agent_id,
        "enabled": r.enabled,
        "note": r.note,
        "createdAt": r.created_at,
        "lastUsedAt": r.last_used_at,
        "useCount": r.use_count,
        # 危险宽规则（危险 argv0 + {any} 通配）标红供 W1b UI 警告——入库不拒（owner 可手动放宽）。
        "dangerous": rule_is_dangerously_wide(r.matcher),
    }


@router.get("/policy/rules", dependencies=[Depends(verify_cf_access)])
async def list_policy_rules(
    request: Request,
    capability: Optional[str] = Query(default=None),
    context_mode: Optional[str] = Query(default=None, alias="contextMode"),
    agent_id: Optional[str] = Query(default=None, alias="agentId"),
):
    """列策略规则（可选按 capability / contextMode / agentId 过滤），最新在前，带 dangerous 标志。
    agentId 缺省 = 全部行（现状）；有值 = 该 agent 的 per-agent 规则（Settings per-agent 面用）。"""
    store = get_agent_config_store()
    rules = store.list_policy_rules(
        capability=capability, context_mode=context_mode, agent_id=agent_id
    )
    data = [_policy_rule_dict(r) for r in rules]
    return success_envelope(
        {"rules": data}, request=request, source="sqlite", meta_extra={"count": len(data)}
    )


@router.post("/policy/rules", dependencies=[Depends(verify_cf_access)])
async def create_policy_rule(request: Request, body: Optional[dict[str, Any]] = None):
    """建一条结构化白名单规则。body = {capability, matcher, contextMode?, note?, agentId?}。

    无 agentId（全局/manual 分支，S2 语义逐字不变）：matcher 经 parse_matcher 校验（非法 →
    422）；contextMode 默认 manual_chat；capability 限 S2 四族（domain_write 是 per-agent 专属）。

    有 agentId（per-agent headless 分支，ADR-004 §3.3/§4.3）：
      - flag ``MAILAGENT_CUSTOM_AGENTS_ENABLED`` off → 404（S4 纪律，feature 不存在）；
      - agentId 须指向 sync_store 现存 ``type='custom'`` agent（拒空串/悬空归属，codex P1-5）；
      - contextMode **从 agent trigger.kind 派生**，请求显式传 → 400（表单不可选，防跨上下文规则）；
      - capability 限 domain_write / exec / web；exec matcher 须过 pinned-entrypoint 形状闸
        （raw ``{any}`` / 非 installed-skill entrypoint → 400，evaluate 侧另有 skip 复核双防线）；
        web matcher = ``{v:1, origin}``（canonical origin 校验，无 headless 专用形状闸，rev3.1）。
    """
    import json

    from src.agent_config.policy import (
        CAPABILITIES,
        CONTEXT_MODES,
        headless_exec_rule_problem,
        parse_matcher,
    )

    raw = body or {}
    capability = raw.get("capability")
    matcher = raw.get("matcher")
    note = raw.get("note")
    agent_id = raw.get("agentId")
    if capability not in CAPABILITIES:
        raise APIError("E_INVALID_ARG", f"capability must be one of {list(CAPABILITIES)}",
                       http_status=400, source="sqlite")
    if not isinstance(matcher, dict):
        raise APIError("E_INVALID_ARG", "matcher must be an object", http_status=400, source="sqlite")
    if note is not None and not isinstance(note, str):
        raise APIError("E_INVALID_ARG", "note must be a string", http_status=400, source="sqlite")

    if agent_id is not None:
        # ── per-agent headless 分支（ADR-004）────────────────────────────────
        if not _custom_agents_enabled():
            raise APIError("E_NOT_FOUND", "custom agents feature is disabled",
                           http_status=404, source="sqlite")
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise APIError("E_INVALID_ARG", "agentId must be a non-empty string",
                           http_status=400, source="sqlite")
        agent_id = agent_id.strip()
        if capability not in _PER_AGENT_CAPABILITIES:
            raise APIError(
                "E_INVALID_ARG",
                f"per-agent rules only support capabilities {list(_PER_AGENT_CAPABILITIES)}",
                http_status=400, source="sqlite",
            )
        if "contextMode" in raw:
            raise APIError(
                "E_INVALID_ARG",
                "contextMode is derived from the agent trigger for per-agent rules; do not pass it",
                http_status=400, source="sqlite",
            )
        from src.api.deps import get_report_store

        agent = get_report_store().get_agent(agent_id)
        if agent is None or (agent.get("type") or "") != "custom":
            raise APIError(
                "E_INVALID_ARG",
                f"agentId must reference an existing custom agent, got {agent_id!r}",
                http_status=400, source="sqlite",
            )
        try:
            context_mode = _derive_rule_context_mode(agent)
        except ValueError as exc:
            raise APIError(
                "E_INVALID_ARG",
                f"agent {agent_id!r} has invalid trigger_json ({exc}); fix the agent first",
                http_status=400, source="sqlite",
            ) from exc
    else:
        # ── 全局（manual）分支 —— S2 语义逐字不变 ─────────────────────────────
        if capability == "domain_write":
            raise APIError(
                "E_INVALID_ARG",
                "domain_write rules are per-agent only (agentId required)",
                http_status=400, source="sqlite",
            )
        context_mode = raw.get("contextMode", "manual_chat")
        if context_mode not in CONTEXT_MODES:
            raise APIError("E_INVALID_ARG", f"contextMode must be one of {list(CONTEXT_MODES)}",
                           http_status=400, source="sqlite")

    store = get_agent_config_store()
    try:
        parsed = parse_matcher(capability, matcher)
    except Exception as exc:  # noqa: BLE001 — pydantic ValidationError / ValueError → 422
        raise APIError("E_INVALID_ARG", f"invalid matcher: {exc}", http_status=422, source="sqlite") from exc
    if capability == "web":
        # canonical origin 归一入库（ADR-004 rev3.1 §4.2 ① —— 唯一权威实现 _normalize_origin）：
        # parse_matcher 已过 _valid_origin ⇒ 归一必非 None。入库存 canonical（Settings/PIN 回显归一
        # 值 + redirect 聚合集/策略匹配对同一 host 恒等值），完整 URL 提交也塌成 scheme://host:port。
        from src.agent_config.policy import _normalize_origin

        canonical = _normalize_origin(matcher.get("origin", ""))
        if canonical is not None:
            matcher = {**matcher, "origin": canonical}
    if agent_id is not None and capability == "exec":
        problem = headless_exec_rule_problem(store, parsed)
        if problem is not None:
            raise APIError(
                "E_INVALID_ARG", f"invalid headless exec rule: {problem}",
                http_status=400, source="sqlite",
            )
        # S6 W3（rev3.1 §5.2）挂载归属闸（建规侧防线之一，evaluate 侧同判 skip）：exec 规则
        # 引用的 installed skill 必须 ∈ 该 agent 挂载集（skills NULL → 默认挂载集）。形状闸
        # 已过 ⇒ entrypoint 归属可解析；解析不出（并发卸载等竞态）同样拒 —— fail-closed。
        from src.agent_config.policy import exec_entrypoint_skill
        from src.api.routers.agent_runs import resolve_mounted_skills

        skill_name = exec_entrypoint_skill(parsed)
        if skill_name is None or skill_name not in resolve_mounted_skills(agent):
            raise APIError(
                "E_INVALID_ARG",
                f"installed skill {skill_name!r} is not mounted on agent {agent_id!r}; "
                "add it to the agent's skills first",
                http_status=400, source="sqlite",
            )
    rule = store.create_policy_rule(
        capability,
        json.dumps(matcher, ensure_ascii=False, sort_keys=True),
        context_mode=context_mode,
        note=note,
        agent_id=agent_id,
    )
    return success_envelope(_policy_rule_dict(rule), request=request, source="sqlite", status_code=201)


@router.patch("/policy/rules/{rule_id}", dependencies=[Depends(verify_cf_access)])
async def patch_policy_rule(rule_id: int, request: Request, body: Optional[dict[str, Any]] = None):
    """启用/停用 + 改备注（matcher 不可 patch —— 放宽 = 删旧建新）。不存在 → 404。"""
    raw = body or {}
    enabled = raw.get("enabled")
    note = raw.get("note")
    if enabled is not None and not isinstance(enabled, bool):
        raise APIError("E_INVALID_ARG", "enabled must be a boolean", http_status=400, source="sqlite")
    if note is not None and not isinstance(note, str):
        raise APIError("E_INVALID_ARG", "note must be a string", http_status=400, source="sqlite")
    rule = get_agent_config_store().set_policy_rule(rule_id, enabled=enabled, note=note)
    if rule is None:
        raise APIError("E_NOT_FOUND", f"policy rule not found: {rule_id}", http_status=404, source="sqlite")
    return success_envelope(_policy_rule_dict(rule), request=request, source="sqlite")


@router.delete("/policy/rules/{rule_id}", dependencies=[Depends(verify_cf_access)])
async def delete_policy_rule(rule_id: int, request: Request):
    """删一条规则。幂等（不存在 removed=false）。"""
    removed = get_agent_config_store().delete_policy_rule(rule_id)
    return success_envelope({"id": rule_id, "removed": removed}, request=request, source="sqlite")


def _library_path_resolver():
    """``file_id`` → 该文件**当前**的虚拟路径（``<根 slug>/<相对路径>``）；判不了就 None。

    P2-L3 B 的目标路径判据（design §5.3）。只认 ``status == 'present'`` 的行 —— 行不存在 / 已软删 /
    磁盘上丢了都返 None，policy 侧据此 ask（「读不到就放行」等于把地板拆了）。走 ``files()`` 而不是
    ``file()``：后者会把文本类文件整个读进内存，而这里只要一列元数据。
    """

    def _resolve(file_id: int):
        from src.api.routers.library import get_library_service

        rows = get_library_service().files([int(file_id)])
        if not rows:
            return None
        row = rows[0]
        if row.get("status") != "present":
            return None
        path = row.get("path")
        return path if isinstance(path, str) and path else None

    return _resolve


@router.post("/policy/evaluate", dependencies=[Depends(verify_local_token)])
async def evaluate_policy(request: Request, body: Optional[dict[str, Any]] = None):
    """评估一次动作是否命中白名单 → {decision: auto_allow|ask, ruleId}。gateway W1b 的 needsApproval
    前置调用。body = {capability, action, contextMode?, agentId?}。contextMode 缺省/非法 →
    fail-closed 到 untrusted_trigger（manual 规则不匹配 → ask）；agentId 缺省 = manual 现状，
    有值 = headless per-agent 双键候选（ADR-004 §3.3）。

    🔴 鉴权 = ``verify_local_token``（**仅**本地 token，不接受 CF JWT）——唯一调用方是 in-process
    gateway domainClient（同机 loopback，恒带 ``X-MailAgent-Local-Token``），与 exec 三端点同形状。
    收窄理由：evaluate 是执行放行判定的前置门，若挂 ``verify_cf_access`` 则远程 CF 会话可探/预热
    白名单判决。**注**：``/policy/rules`` CRUD 仍走 ``verify_cf_access``（Settings UI 远程管理规则）。"""
    from src.agent_config.policy import CAPABILITIES, CONTEXT_MODES, evaluate

    raw = body or {}
    capability = raw.get("capability")
    action = raw.get("action")
    context_mode = raw.get("contextMode")
    agent_id = raw.get("agentId")
    if capability not in CAPABILITIES:
        raise APIError("E_INVALID_ARG", f"capability must be one of {list(CAPABILITIES)}",
                       http_status=400, source="sqlite")
    if not isinstance(action, dict):
        raise APIError("E_INVALID_ARG", "action must be an object", http_status=400, source="sqlite")
    if context_mode not in CONTEXT_MODES:
        context_mode = "untrusted_trigger"
    # agentId（S5 ADR-004 §3.3）：可选；不传 = manual 现状（候选 agent_id IS NULL）。非法类型
    # → 400（gateway 调用方 bug 早暴露；空串由 store 层拒 → evaluate 兜底 ask）。
    if agent_id is not None and not isinstance(agent_id, str):
        raise APIError("E_INVALID_ARG", "agentId must be a string", http_status=400, source="sqlite")
    # S6 W3（rev3.1 §5.2）：per-agent exec 评估须带该 agent 挂载集（evaluate 对未挂载/未接线
    # 的 installed-skill 规则 skip → dormant）。agent_config 不触 sync_store（模块边界），
    # 挂载集在本调用方从 agent 行解析；读失败 → 空集（fail-closed，全 dormant）。
    mounted_skills = None
    if agent_id is not None and capability == "exec":
        try:
            from src.api.deps import get_report_store
            from src.api.routers.agent_runs import resolve_mounted_skills

            # flag off = custom agents 不存在 → 不读 store（None → evaluate 恒 dormant）。
            if _custom_agents_enabled():
                mounted_skills = resolve_mounted_skills(get_report_store().get_agent(agent_id))
        except Exception:  # noqa: BLE001 — store 读失败 → 空集（dormant，绝不放行）
            mounted_skills = frozenset()
    # P2-L3 B（design §5.3）：资料库无人值守免卡按**服务端事实**判目标路径 —— `file_id` 在这里反查
    # 成当前虚拟路径再交给 policy。agent_config 不触 library.db（模块边界），故是注入的回调；
    # 先例 = src/library/resource_resolver.py 给 matters 的那一个。只在 domain_write 上构造，
    # 其余 capability 一趟 LibraryService 都不建。
    library_path_resolver = _library_path_resolver() if capability == "domain_write" else None
    # 返回 {decision, rule_id}（snake）= policy 判决单一 verdict 形状，与 exec 端点响应的 policy 字段
    # 一致（W1b 一个 verdict 类型消费两处：/evaluate 前置调用 + exec 响应审计）。
    result = evaluate(get_agent_config_store(), capability, action, context_mode,
                      agent_id=agent_id, mounted_skills=mounted_skills,
                      library_path_resolver=library_path_resolver)
    return success_envelope(result, request=request, source="sqlite")
