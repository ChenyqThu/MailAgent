"""通知中心值域单源 (task 08-20-notification-center, design §2.1)。

🔴 **零依赖叶子模块** —— 只放常量, 不 import SyncStore / worker / 任何项目内模块。
消费方跨层: `src/mail/sync_store.py` 的 `notification` DDL (CHECK 值域) 与后续的
`src/notify/center.py` (publish 语义) 要用同一份值集, sync_store 反向 import 一个
重模块会拖出依赖环。仓规「第二处手抄先消灭镜像」的正解是**下沉常量**, 不是照抄一份
加句「同源」注释 (issue #68 教训)。

TS 镜像 `frontend/src/shared/api/types/notifications.ts` 由跨语言闸
`tests/config/test_notification_enum_parity.py` 锁死 (随铃铛 UI 那一步落地), 改这里
两边同步。
"""

from __future__ import annotations

from typing import Dict, Tuple

#: 类别 = 面板的四个 tab (prd.md「类别映射」表; All 是前端聚合视图, 不是值)。
NOTIFICATION_CATEGORY_VALUES: Tuple[str, ...] = (
    "action_required",
    "reviews",
    "results",
    "system",
)

#: 条目状态机 (泛化 matter_attention 的 state)。🔴 **已读不在这里** ——
#: `read_at` 是与 state 正交的独立轴: 「看过了」与「处理完了」是两件事
#: (PRD 设计基线 2, 「Mark all as read」只动 read_at)。
#: `dismissed` 值域先就位, 动作端点是 M2。
NOTIFICATION_STATE_VALUES: Tuple[str, ...] = (
    "open",
    "snoozed",
    "resolved",
    "dismissed",
)

#: 严重度, 与 `MatterAttentionSeverity` (src/matters/models.py:105) 同值域 ——
#: matter 信源接入时两侧值可直接透传, 无需映射表。
NOTIFICATION_SEVERITY_VALUES: Tuple[str, ...] = ("info", "warn", "critical")

#: 计次更新时 severity **只升不降** 的比较基准 (design §3.2 规则 2;
#: 形状照抄 src/matters/attention.py:30 的同名常量)。
_SEVERITY_RANK: Dict[str, int] = {"info": 0, "warn": 1, "critical": 2}
