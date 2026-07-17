"""EWS 限流 pause flag 的单一读写面 (producer + 两个消费点共享单源)。

davmail_watchdog 检测到 EWS throttle burst 时置 sync_state:
  - ``davmail_uid_backfill_paused``    = 'true' / 'false'
  - ``davmail_uid_backfill_paused_at`` = 置 pause 的 float epoch (str), 清除时 ''

两个消费点 —— uid-mapper backfill 循环 + watcher poll 整轮 —— 统一调
``is_uid_backfill_paused()`` 判断是否挂起, 不许各写一份。

🔴 staleness 兜底 (pr-43 review 强烈建议): pause 的业务语义是**分钟级临时态**。
若 watchdog 彻底死掉 (进程崩 / 复位路径永不再跑), 持久 flag 会永久卡 'true' →
两个消费者永久停摆 = 整个邮件同步静默停止。故消费侧对超龄 (默认 30min) 或无时间戳
的 pause 一律忽略 (自愈优先, 因为真实限流早已过去; 下一次真限流 producer 会重写
flag + fresh 时间戳, 不受影响)。
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
    - flag == 'true' 但时间戳超龄 / 无时间戳 / 坏时间戳 → False + warning (节流)
      (按陈旧 pause 处理, 自愈优先, 防 watchdog 死掉后整同步永久停摆)。
    - flag == 'true' 且时间戳在有效期内 → True (真暂停)。
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
