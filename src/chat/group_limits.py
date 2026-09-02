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
狼人杀预设五个 int 例外——消费点是 manual 脚本判据 + 模板 pytest 闸，与 groupFloors.ts 同名
同值，闸 test_group_constants_parity.py。
"""

from __future__ import annotations

import hashlib
from typing import Optional, Tuple

#: 群成员上限（含所有 realtime / mention 成员；狼人杀 = 法官 + 6）。v30 时是 5，g1 放宽到 8。
MAX_GROUP_MEMBERS: int = 8

#: 群设置里 chainCap 的允许区间（默认值 12 在 groupFloors.ts；这里只管「owner 能填多大」）。
CHAIN_CAP_MIN: int = 1
CHAIN_CAP_MAX: int = 60

#: 群用途（``GroupConfig.topic``，注入每位成员身份块）与全群模型覆写的长度上限。
#: 🔴 **serve-api 独占消费**：renderer 不设 maxLength、只显示 400 的 hint，所以这不是跨语言
#: 手抄，不进 parity 闸。加第二个消费点（前端也想自己拦一下）之前先想清楚要不要建闸。
TOPIC_MAX_CHARS: int = 200
MODEL_OVERRIDE_MAX_CHARS: int = 200

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

#: ``ai_chat_sessions.invoked_by`` 的值域（v25 已有列，无 CHECK）。'user'/'main_agent' 来自
#: custom_agent_call（harness P2）；g2/g3 建子群加 'judge'/'setup'。
#: 🔴 **serve-api 独占消费**，TS 侧无同名常量，故与 TOPIC_MAX_CHARS 同例不进
#: tests/config/test_group_constants_parity.py 的 VOCABULARIES。
SESSION_INVOKED_BY: Tuple[str, ...] = ("user", "main_agent", "judge", "setup")

#: g3 狼人杀预设地板（与 groupFloors.ts 的 WEREWOLF_* 同名同值；闸 test_group_constants_parity.py）。
#: gateway 在 config.preset == 'werewolf' 时把它们当缺省；Python 侧只服务 manual 脚本判据与模板闸，
#: **不写进** group_config_json。
WEREWOLF_CHAIN_CAP: int = 24
WEREWOLF_HOURLY_TURNS: int = 150
WEREWOLF_HOURLY_TOKENS: int = 1_500_000
WEREWOLF_HOURLY_USD: int = 3
WEREWOLF_SESSION_TURN_CAP: int = 120
#: 法官宣布终局的前缀（机制判据；模板 duty 的措辞与它逐字一致，由 tests/agents 钉）。
GAME_OVER_PREFIX: str = "【游戏结束】"
#: 🔴 脚本独占消费（silent 率判据）；TS 无同名常量，同 TOPIC_MAX_CHARS 体例不进 parity 闸。
WEREWOLF_SILENT_RATE_MAX_PCT: int = 30


def group_scope_hash(raw_members_json: Optional[str]) -> str:
    """sha256(members_json 列原文 utf-8).hexdigest —— 法官免卡锚的**写侧**单源（put_group_config + 建局端点）。
    🔴 db.py::get_group_config 里的读侧表达式保持字面不动：tests/config/test_judge_scope_hash_parity.py 逐字扫那个函数体。"""
    return hashlib.sha256((raw_members_json or "").encode("utf-8")).hexdigest()
