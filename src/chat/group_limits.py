"""L4 群聊 g1 — 群编排的值域词表 + 成员上限（**零依赖叶子**：只 stdlib typing，无 import 副作用）。

serve-api 的校验（``PUT /chat/sessions/{id}/group-config``、建群成员上限）与 metrics SQL 用这里
的元组，**不手抄字符串**。

🔴 同一份词表在四处存在，改一处必改四处（闸 ``tests/config/test_group_constants_parity.py``
正则抽取四侧两两对账，**抽不到任一侧必红**）：

  1. ``frontend/src/ai-gateway/groupFloors.ts``（TS 单源：调度器 / renderer）
  2. 本文件（Python 单源：serve-api 校验）
  3. ``frontend/src/electron/main/chat_db/connection.ts`` v31 迁移块的两条 ``CHECK``
  4. ``src/api/routers/chat.py`` 的校验元组（引本文件，不另抄）

地板**数值**（链上限 / 小时预算 / 窗口大小 …）不在这里：它们只有 gateway 消费，单源在
groupFloors.ts。本文件只保留 serve-api 真正要校验的两项数值（成员上限、chainCap 的允许区间）。
"""

from __future__ import annotations

from typing import Tuple

#: 群成员上限（含所有 realtime / mention 成员；狼人杀 = 法官 + 6）。v30 时是 5，g1 放宽到 8。
MAX_GROUP_MEMBERS: int = 8

#: 群设置里 chainCap 的允许区间（默认值 12 在 groupFloors.ts；这里只管「owner 能填多大」）。
CHAIN_CAP_MIN: int = 1
CHAIN_CAP_MAX: int = 60

#: ``ai_chat_group_member.response_mode`` 的值域（缺行 = 'mention'，PRD Q1）。
RESPONSE_MODES: Tuple[str, ...] = ("realtime", "mention")

#: 停止原因词表：系统行 ``metadata.reason`` / ``ai_chat_group_turn.error`` / i18n
#: ``groupChat.stopped.<reason>`` 三处共用。
GROUP_STOP_REASONS: Tuple[str, ...] = (
    "chain_cap",
    "per_agent_cap",
    "lapping",
    "hourly_turns",
    "hourly_tokens",
    "hourly_budget",
    "session_cap",
    "wall",
    "rate",
    "owner_stop",
    "labs_off",
    "error",
)

#: ``ai_chat_group_turn.outcome`` 的值域（每次唤醒一行，无论说没说话）。
GROUP_TURN_OUTCOMES: Tuple[str, ...] = (
    "spoke",
    "silent",
    "held_dup",
    "skipped",
    "failed",
    "stopped",
)

#: ``ai_chat_group_turn.trigger_kind`` 的值域（链根三类 + agent 级联）。
GROUP_TRIGGER_KINDS: Tuple[str, ...] = ("human", "main_agent", "agent", "judge_post")

#: 计入「沉默率」的 outcome（design §6：silent_run_rate 的分子）。
SILENT_OUTCOMES: Tuple[str, ...] = ("silent", "held_dup", "skipped")

#: 链根的 trigger_kind（design §6：turns_per_human_message 的分母口径）。
#: 🔴 法官在本群发言**不是**链根（父设计 §3.1 否决「法官消息开新链」）。
CHAIN_ROOT_TRIGGER_KINDS: Tuple[str, ...] = ("human", "main_agent")
