"""EWS 限流 pause flag 的单一读写面 (producer + 两个消费点共享单源)。

davmail_watchdog 检测到 EWS throttle burst 时置 sync_state:
  - ``davmail_uid_backfill_paused``    = 'true' / 'false'
  - ``davmail_uid_backfill_paused_at`` = watchdog **存活心跳** 时间戳 (float epoch
    str, 清除时 ''); 见下方心跳语义。

两个消费点 —— uid-mapper backfill 循环 + watcher poll 整轮 —— 统一调
``is_uid_backfill_paused()`` 判断是否挂起, 不许各写一份。

🔴 staleness 兜底 + 心跳语义 (pr-43 review + follow-up): pause 的业务语义是
**分钟级临时态**。``_paused_at`` 记的不是「进入 pause 的时刻」而是 **watchdog 每轮
tick 刷新的存活心跳** —— burst 持续期间时间戳恒新鲜 (哪怕限流已超 30min), 只有
watchdog 彻底死掉 (进程崩 / 复位路径永不再跑) 心跳才停更。故消费侧对超龄 (默认
30min = 心跳停更足够久) 或无时间戳的 pause 一律忽略 (自愈优先: 只有 watchdog 死了
才会超龄, 此时无从判活, 放行防整同步静默停摆; 下一次真限流 producer 会重写 flag +
fresh 心跳, 不受影响)。

⚠️ 唯一放行窗口: 旧版无时间戳的 paused=true 进程重启且仍在 burst → 到下一轮 watchdog
tick 补写心跳前 (≤一个 tick 间隔), 消费侧会按无时间戳短暂放行一轮。可接受。

⚠️ 心跳写入独立于 alerter: watchdog 的置位/心跳/复位在 ALERT_ENABLED=false (生产
默认) 下仍会跑 (见 davmail_watchdog._update_throttle_pause 从 _tick 直调, 不经
_evaluate_alerts 的 alerter-None 早退)。
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from loguru import logger

if TYPE_CHECKING:
    from src.mail.sync_store import SyncStore

# sync_state keys —— 单一定义点, producer (watchdog) + 两个消费点都引这里。
PAUSE_KEY = "davmail_uid_backfill_paused"
PAUSE_AT_KEY = "davmail_uid_backfill_paused_at"

# pause 超过这个上限视为 watchdog 死掉留下的陈旧 flag, 忽略以自愈。
_DEFAULT_MAX_AGE_SEC = 1800.0
# 陈旧 pause 的告警节流: 忽略动作可能每轮 poll (数秒一次) 命中, 只每 N 秒 warn 一次,
# 保留 operator 可见性又不刷屏。
_STALE_WARN_INTERVAL_SEC = 300.0
_last_stale_warn_at = 0.0


def is_uid_backfill_paused(
    sync_store: "SyncStore", *, max_age_sec: float = _DEFAULT_MAX_AGE_SEC
) -> bool:
    """限流 pause flag 是否生效 (带 staleness 兜底)。

    - flag != 'true' → False (未暂停)。
    - flag == 'true' 但时间戳 (watchdog 存活心跳) 超龄 / 无时间戳 / 坏时间戳 → False
      + warning (节流) —— 按陈旧 pause 处理, 自愈优先: 心跳停更 = watchdog 已死,
      放行防整同步永久静默停摆。
    - flag == 'true' 且心跳在有效期内 → True (真暂停; burst 持续期间 watchdog 每轮
      tick 刷新心跳, 故长限流也恒新鲜, 不会被 30min 上限误放行)。
    """
    if sync_store.get_state(PAUSE_KEY) != "true":
        return False

    raw_at = sync_store.get_state(PAUSE_AT_KEY)
    paused_at = None
    if raw_at:
        try:
            paused_at = float(raw_at)
        except (TypeError, ValueError):
            paused_at = None

    # 无时间戳 (老数据) 按超龄处理 —— 无从证明 pause 仍新鲜, 自愈优先于卡死面。
    age = None if paused_at is None else time.time() - paused_at
    if age is None or age > max_age_sec:
        _warn_stale(age, max_age_sec)
        return False
    return True


def _warn_stale(age: "float | None", max_age_sec: float) -> None:
    global _last_stale_warn_at
    now = time.time()
    if now - _last_stale_warn_at < _STALE_WARN_INTERVAL_SEC:
        return
    _last_stale_warn_at = now
    age_str = "unknown" if age is None else f"{age:.0f}s"
    logger.warning(
        "[throttle-pause] 忽略陈旧的 davmail_uid_backfill_paused "
        f"(age={age_str} > {max_age_sec:.0f}s) — watchdog 可能已死, 按自愈放行"
    )
