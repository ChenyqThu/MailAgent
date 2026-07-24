"""``AgentTriggerWorker`` —— custom agent cron 定时触发（S4 W1, ADR D5 rev1）。

形状抄 ``src/reports/worker.py`` tick_loop（60s tick + shutdown_event + state 去重），但
调度语义按 ADR D5 精确化（不复刻 report 的本地时区小时判定，DST 下有边界洞）：

  - **croniter** 解析标准 5-field cron（``parse_trigger`` 已校验合法性 + timezone）；
  - **UTC last_fire marker**：``sync_store.set_state(agent_trigger_last_fire:{id}, {fired_at_utc, cron_hash})``。
    cron 表达式或时区变更 → cron_hash 失配 → marker 失效（防旧 marker 吞掉新配置首 fire）；
  - **fire 判定**：``croniter.get_prev(now)`` 得最近一次 occurrence，落在 ``(last_fire, now]`` 且
    距 now ≤ 30min（单窗宽）→ fire。**单 tick 至多补最近一次**（不补历史序列 / 不补 >30min 的错过窗口）；
  - fire = ``enqueue_agent_run``（runs/day 门 + 幂等）→ 记 marker（即使超限/失败也记，防同 occurrence 每 tick 重试）。

只调度 ``type='custom'`` 且 ``enabled`` 且 ``trigger_json.kind`` ∈ ``cron|schedule`` 的行
（schedule = schedule-builder 结构化规则，occurrence 走共享求值器
``src/agents/schedule_rule``，marker/追赶窗机制与 cron 完全同构；下游 ``trigger_kind``
仍报 ``"cron"`` —— 定时族语义，run_worker 标签 / gateway contextMode / firedAt 解析零改动）；
email_filter 由 new_watcher 第 5 hook 负责。report/preprocess/search 的调度**一字不动**
（本 worker 不碰它们）。
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Optional, Union
from zoneinfo import ZoneInfo

from loguru import logger

from src.agents.run_queue import enqueue_agent_run
from src.agents.trigger import (
    CronTrigger,
    EmailFilterTrigger,
    ScheduleTrigger,
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


def _trigger_hash(trigger: Union[CronTrigger, ScheduleTrigger]) -> str:
    """定时触发配置的短哈希（marker 失效判据）。CronTrigger 保持与历史 ``_cron_hash``
    字节一致（升级不重置存量 marker）；ScheduleTrigger 用 rule+anchor+timezone 的
    canonical JSON（任一字段变更 → marker 失效 → 追赶起点重算，语义同 cron_hash）。"""
    if isinstance(trigger, CronTrigger):
        return _cron_hash(trigger)
    canon = json.dumps(
        {
            "rule": dataclasses.asdict(trigger.rule),
            "anchor": trigger.anchor,
            "timezone": trigger.timezone,
        },
        sort_keys=True,
    )
    return hashlib.sha1(canon.encode()).hexdigest()[:12]


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
    trigger: Union[CronTrigger, ScheduleTrigger],
    now_utc: datetime,
    last_marker: Optional[str],
) -> Optional[datetime]:
    """判定是否 fire；返回要 fire 的 occurrence（UTC，用作幂等 fire_key）或 None。

    纯函数（注入 now_utc + marker 即可完整测试 UTC marker / cron_hash 失效 / catch-up / DST）。
    kind='schedule' 走共享求值器 ``src/agents/schedule_rule``（与报告 worker 同一份实现，
    契约 §6）；kind='cron' 保持 croniter 路径逐字不变。marker / 30min 追赶窗语义两者共享。
    """
    if isinstance(trigger, ScheduleTrigger):
        from src.agents import schedule_rule

        occ = schedule_rule.prev_occurrence(
            trigger.rule, trigger.timezone, trigger.anchor, now_utc
        )
        if occ is None:
            return None  # anchor 之前无 occurrence（首个 fire 点还没到）
        prev_utc = occ.astimezone(timezone.utc)
    else:
        from croniter import croniter

        tz = ZoneInfo(trigger.timezone)
        now_local = now_utc.astimezone(tz)
        # 最近一次 occurrence（croniter get_prev 严格 < now → 恰在 fire 点会等下一 tick，60s 内自然赶上）。
        prev_utc = croniter(trigger.cron, now_local).get_prev(datetime).astimezone(timezone.utc)

    cur_hash = _trigger_hash(trigger)
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
                if isinstance(trig, EmailFilterTrigger):
                    continue  # email_filter → new_watcher 第 5 hook 负责，本 worker 不碰
                # cron / schedule 都是定时 headless，同走本 worker（fire_key/marker 同机制）。
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
                        # schedule 也报 "cron"：下游（run_worker 标签 / gateway contextMode
                        # cron_headless / _fired_at_iso 的 fire_key 解析）按定时族处理，零改动。
                        trigger_kind="cron",
                        fire_key=fire_key,
                        budget=budget,
                    )
                except Exception as e:  # noqa: BLE001 — 单 agent 入队失败不杀 loop
                    logger.warning(f"[agent-trigger] enqueue failed agent={agent['id']}: {e}")
                finally:
                    # 记 marker（即使超限/失败也记，避免同 occurrence 每 tick 重试）。
                    try:
                        sync_store.set_state(key, _make_marker(fire_at, _trigger_hash(trig)))
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
