"""fire marker 的「北京日 → 本地日」一次性迁移（report worker + 灵动岛 digest 共用）。

两处 tick_loop 在时区化之前，fire 判定恒按硬编码 UTC+8 —— 落库的 slot marker
（``"YYYYMMDD-HH"``）里的日期因此是**北京日**。改成「跟随本机/agent 时区」后，同一次真实
fire 在两种口径下可能差一天（LA 下北京 09:00 = 本地前一天 18:00），不换算则升级当天会
多跑一次（marker 看起来是「明天」→ catchup 误判还没跑）或漏跑一次（反向）。

抽在这里而不是各写一份：``src/reports/worker.py`` 与 ``src/notify/daily_digest.py`` 是同一批
同构改动（marker 形状、换算规则、幂等策略完全一致），复制两份换算逻辑早晚漂。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any, Iterable, Optional, Tuple

from loguru import logger

# 迁移前的隐式口径：两处 now_fn 都取 datetime.now(UTC+8)。
LEGACY_MARKER_TZ = timezone(timedelta(hours=8))

# (state_key, 目标时区 | None=本机系统时区)
MarkerEntry = Tuple[str, Optional[tzinfo]]


def migrated_marker(old: Optional[str], zone: Optional[tzinfo] = None) -> Optional[str]:
    """旧口径 marker ``"YYYYMMDD-HH"`` → 新口径；无需改写 / 解析不了 → ``None``。

    换算依据：marker 的日期 + 钟点还原成 UTC+8 下那次真实 fire 的时刻，再转到新口径取
    **本地日期**；钟点保持配置值不变（marker 的 HH 是配置钟点，不是墙钟小时）。
    ``zone`` 为 None → 本机系统时区（``astimezone()`` 无参）。
    """
    text = (old or "").strip()
    try:
        fired_at = datetime.strptime(text, "%Y%m%d-%H").replace(tzinfo=LEGACY_MARKER_TZ)
    except ValueError:
        return None
    local = fired_at.astimezone(zone) if zone is not None else fired_at.astimezone()
    new = f"{local.strftime('%Y%m%d')}-{fired_at.hour:02d}"
    return new if new != text else None


def migration_pending(sync_store: Any, flag_key: str, *, log_prefix: str) -> bool:
    """是否还没迁移过。读不到状态 → False（读不到就别乱改 marker）。"""
    try:
        return not sync_store.get_state(flag_key)
    except Exception as e:  # noqa: BLE001
        logger.debug(f"{log_prefix} marker migration probe failed: {e}")
        return False


def apply_migration(
    sync_store: Any,
    *,
    flag_key: str,
    entries: Iterable[MarkerEntry],
    log_prefix: str,
) -> int:
    """把 ``entries`` 里的 marker 从北京日口径换算到本地日口径，返回改写条数。

    调用方须先用 ``migration_pending`` 判过（本函数不重复探测）。

    幂等靠 ``flag_key`` 标记位「只跑一次」—— 换算本身**不**幂等（重复跑会一路往前漂一天），
    所以标记位是必需的，不是优化。运行期状态键（镜像 ``davmail.*`` / ``alert.*`` 先例），
    不进 ``DB_VERSION``。

    **先落标记位再改 marker**：写不进标记位就整体放弃（宁可不迁移，也不能让下次启动拿已迁移
    的 marker 再换算一次）。残留风险（已知、有界）：标记位落库后进程崩在循环中间 → 剩余 key
    保持旧口径且不会重试，最坏是那个 agent 在升级当天多跑 / 漏跑一次，下一次 fire 写入新口径
    marker 即自愈。反向（标记位后落）会在每次重启把 marker 再往前漂一天，那才是不可自愈的。

    🔴 ``SyncStore.set_state`` **吞** ``sqlite3.Error`` 并返回 ``False``（不抛），所以每处写
    都必须看返回值：只 catch 异常等于这道保护对生产 store 形同虚设。
    """
    try:
        flag_ok = sync_store.set_state(flag_key, "1")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"{log_prefix} marker migration skipped (flag not persisted: {e})")
        return 0
    if flag_ok is False:  # 鸭子类型：只认显式 False（fake store 可能返回 None）
        logger.warning(f"{log_prefix} marker migration skipped (flag write returned False)")
        return 0

    changed = 0
    for key, zone in entries:
        try:
            old = sync_store.get_state(key)
            new = migrated_marker(old, zone)
            if new is None:
                continue
            if sync_store.set_state(key, new) is False:
                # 同上：写失败不抛。标记位已落 → 这个 key 保持旧口径，最坏当天多跑 / 漏跑一次
                # 后被下一次 fire 自愈；不能假装迁移成功。
                logger.warning(f"{log_prefix} marker migration write failed for {key} (kept {old})")
                continue
        except Exception as e:  # noqa: BLE001 — 单个 key 失败不阻断其余
            logger.warning(f"{log_prefix} marker migration failed for {key}: {e}")
            continue
        changed += 1
        logger.info(f"{log_prefix} fire marker migrated {key}: {old} → {new} (北京日 → 本地日)")
    logger.info(f"{log_prefix} fire marker tz migration done (rewritten={changed})")
    return changed
