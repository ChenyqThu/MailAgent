"""报告 worker —— 编排单次生成 + 定时 tick_loop（照 daily_digest 结构）。

run_report_once：fetch → counts → (LLM summarize → assemble | 失败降级 fallback)
→ 存 report 表。tick_loop：每 60s 扫 enabled 报告 agent，命中 fire window 且未
fire 过则跑（state 去重 + 开机当天补推一次）。
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional

from loguru import logger

from src.config import config
from src.reports import data as rdata
from src.reports.assembler import assemble_fallback_doc, assemble_report_doc
from src.reports.agent_tools import kos_is_available
from src.reports.store import ReportStore
from src.reports.summarizer import summarize_report, summarize_report_agentic

_BEIJING = timezone(timedelta(hours=8))

FIRE_WINDOW_MIN = 30
TICK_INTERVAL_SEC = 60

_DEFAULT_WINDOW_HOURS = {"daily": 24, "weekly": 168, "monthly": 720}


def _report_id(agent_id: str, cadence: str, report_date: str) -> str:
    return f"{agent_id}:{cadence}:{report_date}"


def _schedule_of(agent: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return json.loads(agent.get("schedule_json") or "{}") or {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _fire_hours(sched: Dict[str, Any]) -> List[int]:
    out: List[int] = []
    for h in sched.get("hours") or []:
        try:
            hi = int(h)
        except (TypeError, ValueError):
            continue
        if 0 <= hi <= 23 and hi not in out:
            out.append(hi)
    return out or [9]


def _fire_state_key(agent_id: str) -> str:
    return f"report_last_fire:{agent_id}"


def _slot_marker(now: datetime, hour: int) -> str:
    return f"{now.strftime('%Y%m%d')}-{hour:02d}"


def _due_hour(agent: Dict[str, Any], now: datetime, last_marker: Optional[str]) -> Optional[int]:
    """now 是否该 fire；返回命中的钟点 hour，否则 None。

    1) 当前落在某 fire window [HH:00, HH:00+30min) 且该 slot 未 fire → 返回 HH。
    2) catchup：当天还没 fire 过任何 slot（last_marker 非今天）→ 补当天最近一个
       已过钟点（不补多次、不补历史天）。
    周期校验：weekly 看 weekday，monthly 看 day_of_month。
    """
    sched = _schedule_of(agent)
    cadence = sched.get("cadence", "daily")
    if cadence == "weekly" and now.weekday() != int(sched.get("weekday", 0) or 0):
        return None
    if cadence == "monthly" and now.day != int(sched.get("day_of_month", 1) or 1):
        return None

    hours = sorted(_fire_hours(sched))
    today = now.strftime("%Y%m%d")

    # 1) 当前 fire window
    for h in hours:
        if now.hour == h and now.minute < FIRE_WINDOW_MIN:
            if _slot_marker(now, h) != last_marker:
                return h
            return None  # 当前 window 已 fire

    # 2) catchup：今天还没 fire 过 → 补最近一个已过钟点
    if not (last_marker or "").startswith(today):
        passed = [h for h in hours if h <= now.hour]
        if passed:
            return max(passed)
    return None


async def run_report_once(
    *,
    store: ReportStore,
    db_path: str,
    agent: Dict[str, Any],
    now: Optional[datetime] = None,
    summarize_fn: Callable[..., Awaitable[Any]] = summarize_report,
    agentic_fn: Callable[..., Awaitable[Any]] = summarize_report_agentic,
    client: Any = None,
) -> str:
    """单次生成一份报告，写 report 表，返回 report_id。

    决策：total==0 → status=empty（不调 LLM）；LLM 失败 → fallback 纯规则报告
    （status=ready + error 记因）；fetch/assemble 异常 → status=failed。
    """
    now = now or datetime.now(_BEIJING)
    sched = _schedule_of(agent)
    cadence = sched.get("cadence", "daily")
    window_hours = int(agent.get("window_hours") or _DEFAULT_WINDOW_HOURS.get(cadence, 24))
    # 遵循配置 window_hours：取「跑的时刻往前推 N 小时」的滚动窗口（24/48h…），
    # 不按物理自然日。fetch_report_briefs 的 now=窗口上界(exclusive)=运行时刻。
    # （时区正确性靠 data.py 的 julianday 比较，不受混合偏移影响。）
    win_end_dt = now
    win_start_dt = now - timedelta(hours=window_hours)
    win_start = win_start_dt.isoformat()
    win_end = win_end_dt.isoformat()
    report_date = now.strftime("%Y-%m-%d")
    rid = _report_id(agent["id"], cadence, report_date)

    store.create_report(
        report_id=rid, agent_id=agent["id"], cadence=cadence,
        report_date=report_date, window_start=win_start, window_end=win_end,
    )
    # daily 走 agentic（摘要 + 按需工具下钻 + KOS）；周月报 M5 改层级聚合，这里暂沿用单次。
    is_daily = cadence == "daily"
    body_max = int(agent.get("body_full_max") or 15) if is_daily else 0
    try:
        briefs = rdata.fetch_report_briefs(
            db_path, window_hours=window_hours,
            max_emails=config.mailagent_report_max_emails, now=win_end_dt,
            body_full_max=body_max,
        )
        counts = rdata.compute_report_counts(briefs)
        counts_json = json.dumps(counts, ensure_ascii=False)

        if counts["total"] == 0:
            store.finish_report(
                rid, status="empty", counts_json=counts_json,
                headline="这段时间没有新邮件",
            )
            logger.info(f"[report] {rid} empty (no emails in window)")
            return rid

        try:
            if is_daily:
                draft = await agentic_fn(
                    briefs=briefs, counts=counts, db_path=db_path,
                    kos_enabled=kos_is_available(), cadence=cadence, now=now,
                    persona_prompt=agent.get("prompt"), model=agent.get("model"), client=client,
                )
            else:
                draft = await summarize_fn(
                    briefs=briefs, counts=counts, cadence=cadence, now=now,
                    persona_prompt=agent.get("prompt"), model=agent.get("model"), client=client,
                )
            doc = assemble_report_doc(
                draft=draft, briefs=briefs, counts=counts, agent_id=agent["id"],
                cadence=cadence, report_date=report_date, window_start=win_start,
                window_end=win_end, generated_at=now.isoformat(), model=draft.model, now=now,
            )
            store.finish_report(
                rid, status="ready", blocks_json=doc.to_json(), counts_json=counts_json,
                headline=doc.derive_headline(), model=draft.model,
                input_tokens=draft.input_tokens, output_tokens=draft.output_tokens,
            )
            logger.info(
                f"[report] {rid} ready (model={draft.model} "
                f"in={draft.input_tokens} out={draft.output_tokens} blocks={len(doc.blocks)})"
            )
        except Exception as e:  # noqa: BLE001 — LLM 失败降级，不阻断
            logger.warning(f"[report] {rid} summarize failed → fallback: {e}")
            doc = assemble_fallback_doc(
                briefs=briefs, counts=counts, agent_id=agent["id"], cadence=cadence,
                report_date=report_date, window_start=win_start, window_end=win_end,
                generated_at=now.isoformat(), model="", now=now,
            )
            store.finish_report(
                rid, status="ready", blocks_json=doc.to_json(), counts_json=counts_json,
                headline=doc.derive_headline(), error=f"summarize_failed: {str(e)[:200]}",
            )
        return rid
    except Exception as e:  # noqa: BLE001
        logger.error(f"[report] {rid} failed: {e}")
        store.finish_report(rid, status="failed", error=str(e)[:300])
        return rid


async def tick_loop(
    *,
    sync_store: Any,
    store: ReportStore,
    db_path: str,
    shutdown_event: Optional[asyncio.Event] = None,
    interval_sec: int = TICK_INTERVAL_SEC,
    now_fn: Callable[[], datetime] = lambda: datetime.now(_BEIJING),
    run_once: Optional[Callable[..., Awaitable[Any]]] = None,
) -> None:
    """每 interval_sec 扫 enabled 报告 agent，命中 fire window 则跑（state 去重）。"""

    async def _default_run(agent: Dict[str, Any], now: datetime) -> Any:
        return await run_report_once(store=store, db_path=db_path, agent=agent, now=now)

    run_once = run_once or _default_run
    logger.info(f"[report] tick_loop started (interval={interval_sec}s)")

    while shutdown_event is None or not shutdown_event.is_set():
        try:
            for agent in store.list_agents():
                if not agent.get("enabled") or agent.get("type", "report") != "report":
                    continue
                now = now_fn()
                key = _fire_state_key(agent["id"])
                last_marker = sync_store.get_state(key)
                hour = _due_hour(agent, now, last_marker)
                if hour is None:
                    continue
                marker = _slot_marker(now, hour)
                logger.info(f"[report] firing agent={agent['id']} slot={marker}")
                try:
                    await run_once(agent, now)
                finally:
                    # 记 fire（即使失败也记，避免同 slot 每 tick 重试）
                    try:
                        sync_store.set_state(key, marker)
                    except Exception as e:  # noqa: BLE001
                        logger.debug(f"[report] set_state failed: {e}")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[report] tick error: {e}")

        try:
            if shutdown_event is None:
                await asyncio.sleep(interval_sec)
            else:
                await asyncio.wait_for(shutdown_event.wait(), timeout=interval_sec)
                break
        except asyncio.TimeoutError:
            continue
