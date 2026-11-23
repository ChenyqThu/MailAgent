"""Mem0 capture, search, and USER.md memory compilation routes."""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access

router = APIRouter()
logger = logging.getLogger(__name__)



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
