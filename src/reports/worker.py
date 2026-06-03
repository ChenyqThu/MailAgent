"""报告 worker —— 编排单次生成 + 定时 tick_loop（照 daily_digest 结构）。

run_report_once：fetch → counts → (LLM summarize → assemble | 失败降级 fallback)
→ 存 report 表。tick_loop：每 60s 扫 enabled 报告 agent，命中 fire window 且未
fire 过则跑（state 去重 + 开机当天补推一次）。
"""

from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from loguru import logger

from src.config import config
from src.reports import data as rdata
from src.reports.assembler import assemble_fallback_doc, assemble_report_doc
from src.reports.agent_tools import kos_is_available
from src.reports.store import ReportStore
from src.reports.summarizer import (
    ReportDraft,
    summarize_aggregate,
    summarize_report,
    summarize_report_agentic,
)

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
    aggregate_fn: Callable[..., Awaitable[Any]] = summarize_aggregate,
    client: Any = None,
) -> str:
    """单次生成一份报告，写 report 表，返回 report_id。

    决策：total==0 → status=empty（不调 LLM）；LLM 失败 → fallback 纯规则报告
    （status=ready + error 记因）；fetch/assemble 异常 → status=failed。
    """
    now = now or datetime.now(_BEIJING)
    sched = _schedule_of(agent)
    cadence = sched.get("cadence", "daily")
    # 时区：agent.timezone（IANA）或本地系统时区。窗口边界 / 自然日 / 自然周月 都按它算。
    zone = _zone(agent)
    n = now.astimezone(zone) if zone is not None else now.astimezone()

    # 周 / 月报走层级聚合（综合下层报告，不读原始邮件）。
    if cadence in ("weekly", "monthly"):
        return await _run_aggregate(
            store=store, agent=agent, cadence=cadence, n=n, gen_now=now,
            aggregate_fn=aggregate_fn, client=client,
        )

    # ===== daily：agentic（摘要 + 按需工具下钻 + KOS）=====
    # 触发模式 rolling_24h（跑的时刻往前推 window_hours）/ natural_day（指定时区昨天整天）；
    # 时区正确性靠 data.py julianday 比较，窗口边界传 tz-aware ISO。
    win_start_dt, win_end_dt, report_date = _daily_window(agent, n)
    window_hours = max(1, int((win_end_dt - win_start_dt).total_seconds() // 3600))
    win_start = win_start_dt.isoformat()
    win_end = win_end_dt.isoformat()
    rid = _report_id(agent["id"], cadence, report_date)

    store.create_report(
        report_id=rid, agent_id=agent["id"], cadence=cadence,
        report_date=report_date, window_start=win_start, window_end=win_end,
    )
    body_max = int(agent.get("body_full_max") or 15)
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
            draft = await agentic_fn(
                briefs=briefs, counts=counts, db_path=db_path,
                kos_enabled=kos_is_available(), cadence=cadence, now=now,
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


# ── 时区 / 窗口 / 周期 helper ─────────────────────────────────────────────────

def _zone(agent: Dict[str, Any]) -> Optional[ZoneInfo]:
    """agent.timezone（IANA）→ ZoneInfo；空 / 非法 → None（用本地系统时区）。"""
    tz = (agent.get("timezone") or "").strip()
    if not tz:
        return None
    try:
        return ZoneInfo(tz)
    except Exception as e:  # noqa: BLE001 — 非法时区名退回本地
        logger.warning(f"[report] bad timezone {tz!r} ({e}); using local")
        return None


def _daily_window(agent: Dict[str, Any], n: datetime) -> Tuple[datetime, datetime, str]:
    """daily 窗口 (start, end, report_date)。n = 配置时区的当前时刻。

    rolling_24h：[n - window_hours, n)，report_date = 今天。
    natural_day：指定时区昨天 [00:00, 24:00)，report_date = 昨天。
    """
    if (agent.get("trigger_mode") or "rolling_24h") == "natural_day":
        today0 = n.replace(hour=0, minute=0, second=0, microsecond=0)
        start = today0 - timedelta(days=1)
        return start, today0, start.strftime("%Y-%m-%d")
    wh = int(agent.get("window_hours") or 24)
    return n - timedelta(hours=wh), n, n.strftime("%Y-%m-%d")


def _period_bounds(cadence: str, n: datetime) -> Tuple[str, str, str, int]:
    """周 / 月报聚合的**上一个完整周期** (sub_start, sub_end, report_date, expected_count)，
    全 'YYYY-MM-DD'。report_date 字典序与日期序一致，可直接比较。"""
    d: date = n.date()
    if cadence == "weekly":
        this_mon = d - timedelta(days=d.weekday())  # 本周一
        last_mon = this_mon - timedelta(days=7)
        last_sun = this_mon - timedelta(days=1)
        return last_mon.isoformat(), last_sun.isoformat(), last_mon.isoformat(), 7
    # monthly：上一个自然月
    first_this = d.replace(day=1)
    prev_end = first_this - timedelta(days=1)
    first_prev = prev_end.replace(day=1)
    expected = sum(  # 上月内的周一数 ≈ 期望周报数
        1
        for i in range((prev_end - first_prev).days + 1)
        if (first_prev + timedelta(days=i)).weekday() == 0
    )
    return first_prev.isoformat(), prev_end.isoformat(), first_prev.isoformat(), max(expected, 1)


def _sum_counts(subs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """汇总子报告 counts_json（total/unread/urgent/replied/sent/ai_handled/flagged 求和）。"""
    keys = ("total", "unread", "urgent", "replied", "sent", "ai_handled", "flagged")
    out: Dict[str, Any] = {k: 0 for k in keys}
    for s in subs:
        try:
            c = json.loads(s.get("counts_json") or "{}")
        except (json.JSONDecodeError, TypeError):
            c = {}
        for k in keys:
            out[k] += int(c.get(k) or 0)
    return out


async def _run_aggregate(
    *,
    store: ReportStore,
    agent: Dict[str, Any],
    cadence: str,
    n: datetime,
    gen_now: datetime,
    aggregate_fn: Callable[..., Awaitable[Any]],
    client: Any,
) -> str:
    """周 / 月报层级聚合：读上一个完整周期的子报告 → LLM 综合 → ReportDoc。缺则跳过 + 标注。"""
    start_date, end_date, report_date, expected = _period_bounds(cadence, n)
    sub_cadence = "daily" if cadence == "weekly" else "weekly"
    sub_unit = "日报" if sub_cadence == "daily" else "周报"
    rid = _report_id(agent["id"], cadence, report_date)
    store.create_report(
        report_id=rid, agent_id=agent["id"], cadence=cadence,
        report_date=report_date, window_start=start_date, window_end=end_date,
    )
    try:
        subs = store.list_reports_in_range(
            cadence=sub_cadence, start_date=start_date, end_date=end_date
        )
        if not subs:
            store.finish_report(
                rid, status="empty", headline=f"这段时间没有可综合的{sub_unit}"
            )
            logger.info(f"[report] {rid} empty (no {sub_cadence} reports in period)")
            return rid

        counts = _sum_counts(subs)
        counts_json = json.dumps(counts, ensure_ascii=False)
        missing = max(0, expected - len(subs))
        period_cn = "周" if cadence == "weekly" else "月"
        missing_note = (
            f"本{period_cn}有 {missing} 份{sub_unit}缺失，下面只综合已有的 {len(subs)} 份。"
            if missing > 0
            else ""
        )
        try:
            draft = await aggregate_fn(
                sub_reports=subs, cadence=cadence, now=gen_now,
                persona_prompt=agent.get("prompt"), model=agent.get("model"),
                missing_note=missing_note, client=client,
            )
            model_used = draft.model
        except Exception as e:  # noqa: BLE001 — LLM 失败降级为纯统计 + 缺失说明
            logger.warning(f"[report] {rid} aggregate failed → fallback: {e}")
            draft = ReportDraft(
                overview=(missing_note + " AI 综合暂不可用，请查看各子报告。").strip(),
                model="",
            )
            model_used = ""

        doc = assemble_report_doc(
            draft=draft, briefs=[], counts=counts, agent_id=agent["id"],
            cadence=cadence, report_date=report_date, window_start=start_date,
            window_end=end_date, generated_at=gen_now.isoformat(), model=model_used, now=gen_now,
        )
        store.finish_report(
            rid, status="ready", blocks_json=doc.to_json(), counts_json=counts_json,
            headline=doc.derive_headline(), model=model_used,
            input_tokens=draft.input_tokens, output_tokens=draft.output_tokens,
            error=("" if model_used else "aggregate_fallback"),
        )
        logger.info(
            f"[report] {rid} ready (aggregate {len(subs)} {sub_cadence}, missing={missing})"
        )
        return rid
    except Exception as e:  # noqa: BLE001
        logger.error(f"[report] {rid} aggregate failed: {e}")
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
