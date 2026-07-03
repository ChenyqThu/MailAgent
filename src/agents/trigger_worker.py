"""``AgentTriggerWorker`` —— custom agent cron 定时触发（S4 W1, ADR D5 rev1）。

形状抄 ``src/reports/worker.py`` tick_loop（60s tick + shutdown_event + state 去重），但
调度语义按 ADR D5 精确化（不复刻 report 的本地时区小时判定，DST 下有边界洞）：

  - **croniter** 解析标准 5-field cron（``parse_trigger`` 已校验合法性 + timezone）；
  - **UTC last_fire marker**：``sync_store.set_state(agent_trigger_last_fire:{id}, {fired_at_utc, cron_hash})``。
    cron 表达式或时区变更 → cron_hash 失配 → marker 失效（防旧 marker 吞掉新配置首 fire）；
  - **fire 判定**：``croniter.get_prev(now)`` 得最近一次 occurrence，落在 ``(last_fire, now]`` 且
    距 now ≤ 30min（单窗宽）→ fire。**单 tick 至多补最近一次**（不补历史序列 / 不补 >30min 的错过窗口）；
  - fire = ``enqueue_agent_run``（runs/day 门 + 幂等）→ 记 marker（即使超限/失败也记，防同 occurrence 每 tick 重试）。

只调度 ``type='custom'`` 且 ``enabled`` 且 ``trigger_json.kind='cron'`` 的行；email_filter 由
new_watcher 第 5 hook 负责。report/preprocess/search 的调度**一字不动**（本 worker 不碰它们）。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Optional
from zoneinfo import ZoneInfo

from loguru import logger

from src.agents.run_queue import enqueue_agent_run
from src.agents.trigger import (
    CronTrigger,
    TriggerValidationError,
    parse_budget,
    parse_trigger,
)

FIRE_WINDOW_MIN = 30  # 单窗宽（沿 report worker FIRE_WINDOW_MIN 常量）：>此值的错过 occurrence 不补
TICK_INTERVAL_SEC = 60


def _marker_key(agent_id: str) -> str:
    return f"agent_trigger_last_fire:{agent_id}"


def _cron_hash(trigger: CronTrigger) -> str:
    """cron 表达式 + 时区的短哈希；变更即失配 → marker 失效重算。"""
    return hashlib.sha1(f"{trigger.cron}|{trigger.timezone}".encode()).hexdigest()[:12]


def _make_marker(fired_at_utc: datetime, cron_hash: str) -> str:
    return json.dumps(
        {"fired_at_utc": fired_at_utc.astimezone(timezone.utc).isoformat(), "cron_hash": cron_hash}
    )


def _parse_marker(raw: Optional[str]) -> Optional[Dict[str, Any]]:
    if not raw:
        return None
    try:
        v = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    return v if isinstance(v, dict) else None


def _parse_iso_utc(raw: Any) -> Optional[datetime]:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _due_fire(
    trigger: CronTrigger, now_utc: datetime, last_marker: Optional[str]
) -> Optional[datetime]:
    """判定是否 fire；返回要 fire 的 occurrence（UTC，用作幂等 fire_key）或 None。

    纯函数（注入 now_utc + marker 即可完整测试 UTC marker / cron_hash 失效 / catch-up / DST）。
    """
    from croniter import croniter

    tz = ZoneInfo(trigger.timezone)
    now_local = now_utc.astimezone(tz)
    # 最近一次 occurrence（croniter get_prev 严格 < now → 恰在 fire 点会等下一 tick，60s 内自然赶上）。
    prev_utc = croniter(trigger.cron, now_local).get_prev(datetime).astimezone(timezone.utc)

    cur_hash = _cron_hash(trigger)
    last_fire_utc: Optional[datetime] = None
    marker = _parse_marker(last_marker)
    if marker and marker.get("cron_hash") == cur_hash:
        last_fire_utc = _parse_iso_utc(marker.get("fired_at_utc"))

    # 已 fire 过这个（或更早）occurrence → 不重复。
    if last_fire_utc is not None and prev_utc <= last_fire_utc:
        return None
    # 错过窗口 >30min（app 离线太久）→ 不补（ADR：距 now ≤ 单窗宽才 fire）。
    if (now_utc - prev_utc) > timedelta(minutes=FIRE_WINDOW_MIN):
        return None
    return prev_utc


async def tick_loop(
    *,
    sync_store: Any,
    store: Any,
    repo: Any,
    shutdown_event: Optional[asyncio.Event] = None,
    interval_sec: int = TICK_INTERVAL_SEC,
    now_fn: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> None:
    """每 interval_sec 扫 enabled 的 type='custom' cron agent，命中 fire window 则入队 agent_run。"""
    logger.info(f"[agent-trigger] cron tick_loop started (interval={interval_sec}s)")

    while shutdown_event is None or not shutdown_event.is_set():
        try:
            for agent in store.list_agents():
                if not agent.get("enabled") or agent.get("type") != "custom":
                    continue
                try:
                    trig = parse_trigger(agent.get("trigger_json"))
                except TriggerValidationError as e:
                    logger.warning(
                        f"[agent-trigger] skip agent={agent.get('id')} bad trigger_json: {e}"
                    )
                    continue
                if not isinstance(trig, CronTrigger):
                    continue  # email_filter → new_watcher 第 5 hook 负责，本 worker 不碰
                now = now_fn()
                key = _marker_key(agent["id"])
                last_marker = sync_store.get_state(key)
                fire_at = _due_fire(trig, now, last_marker)
                if fire_at is None:
                    continue
                budget = parse_budget(agent.get("budget_json"))
                fire_key = fire_at.strftime("%Y%m%dT%H%M%SZ")
                logger.info(f"[agent-trigger] firing cron agent={agent['id']} occurrence={fire_key}")
                try:
                    enqueue_agent_run(
                        repo,
                        agent_id=agent["id"],
                        trigger_kind="cron",
                        fire_key=fire_key,
                        budget=budget,
                    )
                except Exception as e:  # noqa: BLE001 — 单 agent 入队失败不杀 loop
                    logger.warning(f"[agent-trigger] enqueue failed agent={agent['id']}: {e}")
                finally:
                    # 记 marker（即使超限/失败也记，避免同 occurrence 每 tick 重试）。
                    try:
                        sync_store.set_state(key, _make_marker(fire_at, _cron_hash(trig)))
                    except Exception as e:  # noqa: BLE001
                        logger.debug(f"[agent-trigger] set_state failed agent={agent['id']}: {e}")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — list_agents / tick 整体异常不杀 loop
            logger.warning(f"[agent-trigger] tick error: {e}")

        try:
            if shutdown_event is None:
                await asyncio.sleep(interval_sec)
            else:
                await asyncio.wait_for(shutdown_event.wait(), timeout=interval_sec)
                break
        except asyncio.TimeoutError:
            continue

    logger.info("[agent-trigger] cron tick_loop stopped")
