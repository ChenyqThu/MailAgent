"""Ping-island action handler whitelist (Phase 2).

PRD §5.2 / handoff §4 — 把"可在灵动岛 button click 后真触发 handler 的 action id"
集中定义为一份白名单, 防 LLM / fork / 测试 envelope 输出未支持的 id 击穿到 handler.

两层校验:
1. **Schema 层** (``src.llm_agent.schema.RECOMMENDED_ACTION_ID_ENUM``): LLM 输出 id
   必须是 enum 子集 (10 inbox + 2 sent), JSON schema 强制拒收.
2. **Handler 层** (``KNOWN_ACTION_IDS``): plugin 真能 dispatch 的 id 全集
   (10 inbox + 2 sent + 5 Phase 1 静态 fallback). dispatch 端 + response 端各按这个
   set 做 defense-in-depth filter — schema 漏过来的 / fork 测试 envelope 手写的
   未知 id 都在这里 silent drop, 永远不到达 subprocess.

改这里 → 同步改 ``island_response.handle_response`` 加对应 ``choice == "..."`` 分支
+ 改 schema (如新增 LLM dynamic id).
"""

from __future__ import annotations

from typing import Final, FrozenSet

from src.llm_agent.schema import (
    RECOMMENDED_ACTION_ID_INBOX,
    RECOMMENDED_ACTION_ID_SENT,
)


# Phase 1 静态 5 — DEFAULT_OPTION_IDS in island_dispatch.py 用 (LLM 不可推荐, 见
# schema.test_recommended_action_disjoint_from_static_5). plugin fallback path 用.
STATIC_FALLBACK_ACTION_IDS: Final[FrozenSet[str]] = frozenset({
    "open_notion",
    "create_draft",
    "mark_done",
    "snooze_1h",
    "open_mail",
})


# Phase 2 LLM-recommended dynamic ids (12 = 10 inbox + 2 sent).
RECOMMENDED_ACTION_IDS: Final[FrozenSet[str]] = frozenset({
    *RECOMMENDED_ACTION_ID_INBOX,
    *RECOMMENDED_ACTION_ID_SENT,
})


# 整体 handler 端可识别 id (17 = 5 static + 12 recommended). dispatch filter +
# response handler 都按这个 set 做 defense-in-depth.
KNOWN_ACTION_IDS: Final[FrozenSet[str]] = (
    STATIC_FALLBACK_ACTION_IDS | RECOMMENDED_ACTION_IDS
)


def is_known_action_id(action_id: str) -> bool:
    """True if ``action_id`` is in any handler tier (static fallback or dynamic)."""
    return isinstance(action_id, str) and action_id in KNOWN_ACTION_IDS


def is_recommended_action_id(action_id: str) -> bool:
    """True if ``action_id`` is in LLM dynamic whitelist (not static fallback).

    Use this to refuse echoing static-5 ids back from LLM output.
    """
    return isinstance(action_id, str) and action_id in RECOMMENDED_ACTION_IDS
