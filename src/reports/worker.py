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
from src.reports.store import ReportStore, cadence_of, schedule_of
from src.reports.summarizer import (
    ReportDraft,
    summarize_aggregate,
    summarize_report,
    summarize_report_agentic,
)
from src.utils import fire_marker_tz

FIRE_WINDOW_MIN = 30
TICK_INTERVAL_SEC = 60

_DEFAULT_WINDOW_HOURS = {"daily": 24, "weekly": 168, "monthly": 720}


def _report_id(agent_id: str, cadence: str, report_date: str) -> str:
    return f"{agent_id}:{cadence}:{report_date}"


# schedule_json → dict / cadence 的解析（含「解析不出 → daily」的默认）住在 store.py，
# 与 list_agents 的排序权重共用同一份定义 —— fire / 聚合语义与调度顺序不可能再分裂。
_schedule_of = schedule_of
_cadence_of = cadence_of


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


# ── fire marker 时区迁移（一次性）─────────────────────────────────────────────
# 迁移前 fire 判定恒按 UTC+8（now_fn 默认 datetime.now(UTC+8)）→ marker 里的日期是
# 「北京日」；迁移后是「本地日」。同一次真实 fire 在两种口径下可能差一天（LA 下北京
# 09:00 = 本地前一天 18:00），不换算则升级当天 _due_hour 的 catchup 分支会误判「今天
# 还没 fire 过」而多跑一次（反向也可能漏跑）。
# 换算 / 幂等 / set_state 返回值检查在 src/utils/fire_marker_tz.py（与灵动岛 digest 共用）。
_MARKER_MIGRATION_STATE_KEY = "report_fire_marker_tz_migrated"


def _migrate_fire_markers(sync_store: Any, store: ReportStore) -> None:
    """把 report_last_fire:* 从北京日口径一次性换算到本地日口径。"""
    if not fire_marker_tz.migration_pending(
        sync_store, _MARKER_MIGRATION_STATE_KEY, log_prefix="[report]"
    ):
        return
    try:
        agents = store.list_agents()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[report] marker migration skipped (list_agents failed: {e})")
        return
    fire_marker_tz.apply_migration(
        sync_store,
        flag_key=_MARKER_MIGRATION_STATE_KEY,
        # 每个 agent 按自己的时区换算（agent.timezone 空 → 本机），与 fire 判定同口径。
        entries=[(_fire_state_key(a.get("id") or ""), _zone(a)) for a in agents],
        log_prefix="[report]",
    )


def _due_hour(agent: Dict[str, Any], now: datetime, last_marker: Optional[str]) -> Optional[int]:
    """now 是否该 fire；返回命中的钟点 hour，否则 None。

    1) 当前落在某 fire window [HH:00, HH:00+30min) 且该 slot 未 fire → 返回 HH。
    2) catchup：当天还没 fire 过任何 slot（last_marker 非今天）→ 补当天最近一个
       已过钟点（不补多次、不补历史天）。
    周期校验：weekly 看 weekday，monthly 看 day_of_month。
    """
    sched = _schedule_of(agent)
    cadence = _cadence_of(agent)
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
    now = now or datetime.now(timezone.utc)
    cadence = _cadence_of(agent)
    # 时区：agent.timezone（IANA）或本机系统时区。窗口边界 / 自然日 / 自然周月 / 叙述
    # 时刻都按它算（tick_loop 的 fire 判定同口径，见 _agent_local）。
    n = _agent_local(agent, now)

    # 周 / 月报走层级聚合（综合下层报告，不读原始邮件）。
    if cadence in ("weekly", "monthly"):
        return await _run_aggregate(
            store=store, agent=agent, cadence=cadence, n=n, gen_now=n,
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
    body_priorities = _parse_body_priorities(agent.get("body_full_priorities"))
    try:
        briefs = rdata.fetch_report_briefs(
            db_path, window_hours=window_hours,
            max_emails=config.mailagent_report_max_emails, now=win_end_dt,
            body_priorities=body_priorities,
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
                kos_enabled=kos_is_available(), cadence=cadence, now=n,
                persona_prompt=agent.get("prompt"), model=agent.get("model"),
                context_docs=_parse_context_docs(agent.get("context_docs_json")),
                client=client,
            )
            doc = assemble_report_doc(
                draft=draft, briefs=briefs, counts=counts, agent_id=agent["id"],
                cadence=cadence, report_date=report_date, window_start=win_start,
                window_end=win_end, generated_at=n.isoformat(), model=draft.model, now=n,
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
                generated_at=n.isoformat(), model="", now=n,
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


def _agent_local(agent: Dict[str, Any], now: datetime) -> datetime:
    """任意 tz-aware 时刻 → agent 的本地时刻（fire 判定 / 窗口 / 叙述唯一口径）。

    agent.timezone（IANA）非空 → 该时区；空 / 非法 → 本机系统时区（owner 拍板：
    「跟随电脑时区」，出差时报告时刻跟着漂是接受的代价）。
    """
    zone = _zone(agent)
    return now.astimezone(zone) if zone is not None else now.astimezone()


def _parse_context_docs(raw: Any) -> Optional[List[str]]:
    """agent.context_docs_json（JSON 数组字符串）→ list[str]。
    NULL / 缺失 / 非法 → None（运行时用默认文档集 soul+user）；'[]' 保留为 []（用户
    显式取消全部 = 不注入）。语义对齐 get_preprocess_config / wire.resolve_agent。"""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    if isinstance(parsed, list):
        return [str(x) for x in parsed]
    return None


_DEFAULT_BODY_PRIORITIES = ["🔴 紧急", "🟡 重要"]


def _parse_body_priorities(raw: Any) -> List[str]:
    """agent.body_full_priorities（JSON 数组字符串）→ list[str]。
    解析失败 / 为空 → 默认 ['🔴 紧急', '🟡 重要']（带正文的优先级集合）。"""
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        parsed = None
    if isinstance(parsed, list):
        labels = [str(x) for x in parsed if isinstance(x, str) and x.strip()]
        if labels:
            return labels
    return list(_DEFAULT_BODY_PRIORITIES)


def _daily_window(agent: Dict[str, Any], n: datetime) -> Tuple[datetime, datetime, str]:
    """daily 窗口 (start, end, report_date)。n = 配置时区的当前时刻。

    rolling_24h：固定回溯 24 小时 [n - 24h, n)，report_date = 今天（不可配窗口）。
    natural_day：指定时区昨天 [00:00, 24:00)，report_date = 昨天。
    """
    if (agent.get("trigger_mode") or "rolling_24h") == "natural_day":
        today0 = n.replace(hour=0, minute=0, second=0, microsecond=0)
        start = today0 - timedelta(days=1)
        return start, today0, start.strftime("%Y-%m-%d")
    return n - timedelta(hours=24), n, n.strftime("%Y-%m-%d")


def _period_bounds(cadence: str, n: datetime) -> Tuple[str, str, str, int]:
    """周 / 月报聚合窗口 (sub_start, sub_end, report_date, expected_count)，全 'YYYY-MM-DD'。
    weekly = 过去 7 个完整日（rolling）；monthly = 上一个自然月。report_date 字典序与
    日期序一致，可直接比较。"""
    d: date = n.date()
    if cadence == "weekly":
        # 「过去 7 个完整日」[今天-7, 今天-1]（含）—— rolling，而非固定自然周。
        # 周一 9:00 定时跑时这 7 天恰好 = 上周一~周日（与旧「上一完整周」结果一致）；
        # 周中手动「立即运行」则给真正最近 7 天（用户预期），不再回退到更早的整周。
        # report_date = 窗口起始日：周一定时跑仍标上周一，与历史报告 + fire 去重兼容。
        end = d - timedelta(days=1)
        start = d - timedelta(days=7)
        return start.isoformat(), end.isoformat(), start.isoformat(), 7
    # monthly：上一个自然月（方案 A：聚合整月日报，expected = 当月天数）
    first_this = d.replace(day=1)
    prev_end = first_this - timedelta(days=1)
    first_prev = prev_end.replace(day=1)
    expected = (prev_end - first_prev).days + 1  # 上月天数 = 期望日报数
    return first_prev.isoformat(), prev_end.isoformat(), first_prev.isoformat(), max(expected, 1)


def _shift_date(day: str, days: int) -> str:
    """'YYYY-MM-DD' ± days → 'YYYY-MM-DD'。"""
    return (date.fromisoformat(day) + timedelta(days=days)).isoformat()


def _parse_window_bound(raw: Any, tzinfo: Any) -> Optional[datetime]:
    """report.window_start / window_end → tz-aware datetime；解析不了 → None。

    daily 存 tz-aware ISO（'2026-07-19T18:00:00-07:00'），weekly / monthly 存
    'YYYY-MM-DD'（当天 00:00）；早期行可能是任意占位串 → None。
    """
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=tzinfo)


def _window_midpoint(s: Dict[str, Any], tzinfo: Any) -> Optional[datetime]:
    """子报告内容窗口的中点；窗口列解析不了 / 非正区间 → None（= 老行，无窗口口径）。"""
    start = _parse_window_bound(s.get("window_start"), tzinfo)
    end = _parse_window_bound(s.get("window_end"), tzinfo)
    if start is None or end is None or end <= start:
        return None
    return start + (end - start) / 2


def _select_period_subreports(
    subs: List[Dict[str, Any]], *, start_date: str, end_date: str, n: datetime
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """按子报告的**内容窗口**（而非 report_date 字符串）挑本周期的子报告。

    返回 ``(selected, dropped_legacy)``；``dropped_legacy`` = 因窗口判据已生效而被排除的
    「report_date 落在本周期但没有可解析窗口」的老行（调用方负责记日志）。

    rolling_24h 日报的 report_date = 生成当天，内容窗口却是 [当天-24h, 当天) —— 主体
    是前一天。旧实现按 report_date 落在 [start_date, end_date] 取，整批系统性前移一天
    （owner 实报「拉上周 7 天，输出的是上上周」）。

    新判据：子报告窗口的**中点**落在期间 [start_date 00:00, end_date+1 00:00)（agent
    时区）内。取中点而非「有交集」是因为交集会把两端各多算半天的日报也捞进来 →
    _sum_counts 重复计数；中点让每份日报恰好归属一个期间，不重不漏，且对 rolling_24h
    / natural_day 两种日报窗口都成立。

    🔴 窗口判据与 report_date 老判据**互斥，不是并集**：只要本周期里有窗口可解析的行命中，
    就完全不启用 report_date fallback。并集会让「7 份正常行 + 1 份窗口不可解析但
    report_date 落在期内的历史行」选出 8 份 → _sum_counts 多算一天，而 missing 又被
    max(0, …) 压成 0 → 静默输出错误总数。宁可如实少算并把被排除的行打进日志。
    """
    period_start = datetime.fromisoformat(start_date).replace(tzinfo=n.tzinfo)
    period_end = datetime.fromisoformat(_shift_date(end_date, 1)).replace(tzinfo=n.tzinfo)
    windowed: List[Dict[str, Any]] = []
    legacy: List[Dict[str, Any]] = []
    for s in subs:
        mid = _window_midpoint(s, n.tzinfo)
        if mid is None:
            if start_date <= str(s.get("report_date") or "") <= end_date:
                legacy.append(s)
        elif period_start <= mid < period_end:
            windowed.append(s)
    if windowed:
        return windowed, legacy
    # 本周期一份可解析窗口的行都没有（纯历史库）→ 退回 report_date 判据，不丢子报告。
    return legacy, []


def _warn_if_last_day_missing(
    subs: List[Dict[str, Any]], *, rid: str, cadence: str, end_date: str,
    sub_unit: str, n: datetime,
) -> None:
    """周期最后一天的子报告缺席 → 显式 warning（而不是静默计入 missing）。

    新的中点归属口径下，周期最后一天那格由**跑周 / 月报当天早些时候生成的日报**填充
    （rolling_24h 日报窗口 [d-1 HH, d HH) 的中点落在 d-1）。因此周 / 月报的触发钟点必须
    晚于（或等于、且排在其后）日报的钟点。日报钟点若配得比周报晚，周报每次都会稳定少一份
    且不会重算 —— 这是**配置问题**，不是数据缺失，运营者得能从日志分辨。
    """
    covered = {
        (mid.date().isoformat() if mid is not None else str(s.get("report_date") or ""))
        for s, mid in ((s, _window_midpoint(s, n.tzinfo)) for s in subs)
    }
    if end_date in covered:
        return
    logger.warning(
        f"[report] {rid} 周期最后一天 {end_date} 的{sub_unit}缺席 —— {cadence} 是层级聚合，"
        f"依赖当天先跑完的{sub_unit}；请确认 daily 的触发钟点不晚于 {cadence}"
    )


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
    # 方案 A：周报和月报都聚合「日报」—— 每份日报 report_date=当天、明确归月，无跨月周
    # 归属歧义；月报综合整月 ~30 份日报，context 充足（远低于 LLM 上限）。
    sub_cadence = "daily"
    sub_unit = "日报"
    rid = _report_id(agent["id"], cadence, report_date)
    store.create_report(
        report_id=rid, agent_id=agent["id"], cadence=cadence,
        report_date=report_date, window_start=start_date, window_end=end_date,
    )
    try:
        # 先按 report_date 多取一天的余量（rolling_24h 日报的 report_date 比内容主体日
        # 晚一天），真正的归属判定交给 _select_period_subreports（按窗口中点）。
        subs, dropped = _select_period_subreports(
            store.list_reports_in_range(
                cadence=sub_cadence,
                start_date=_shift_date(start_date, -1),
                end_date=_shift_date(end_date, 1),
            ),
            start_date=start_date, end_date=end_date, n=n,
        )
        if dropped:
            logger.warning(
                f"[report] {rid} 排除 {len(dropped)} 份窗口不可解析的历史{sub_unit}"
                f"（窗口判据已生效 → 不再叠加 report_date 判据，避免重复计数）："
                f"{[str(s.get('id')) for s in dropped][:5]}"
            )
        if not subs:
            store.finish_report(
                rid, status="empty", headline=f"这段时间没有可综合的{sub_unit}"
            )
            logger.info(f"[report] {rid} empty (no {sub_cadence} reports in period)")
            return rid
        _warn_if_last_day_missing(
            subs, rid=rid, cadence=cadence, end_date=end_date, sub_unit=sub_unit, n=n
        )

        counts = _sum_counts(subs)
        counts_json = json.dumps(counts, ensure_ascii=False)
        missing = expected - len(subs)
        if missing < 0:
            # 期间内的子报告比该周期的天数还多 = 归属判定出了问题（重复计数的信号）。
            # 改前这里被 max(0, …) 压成 0，异常就此静默 —— 至少要能从日志看出来。
            logger.warning(
                f"[report] {rid} 综合了 {len(subs)} 份{sub_unit}，超出本周期期望的 {expected} 份"
                f" —— 疑似子报告归属重复，统计可能偏高"
            )
            missing = 0
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
                context_docs=_parse_context_docs(agent.get("context_docs_json")),
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
    now_fn: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    run_once: Optional[Callable[..., Awaitable[Any]]] = None,
) -> None:
    """每 interval_sec 扫 enabled 报告 agent，命中 fire window 则跑（state 去重）。

    now_fn 给 UTC 时刻，fire 判定前按 agent 时区（空则本机）转本地 —— 与 _window /
    _period_bounds 同口径，也与 src/agents/trigger_worker 的 cron 范式对齐。
    """

    async def _default_run(agent: Dict[str, Any], now: datetime) -> Any:
        return await run_report_once(store=store, db_path=db_path, agent=agent, now=now)

    run_once = run_once or _default_run
    _migrate_fire_markers(sync_store, store)
    logger.info(f"[report] tick_loop started (interval={interval_sec}s)")

    while shutdown_event is None or not shutdown_event.is_set():
        try:
            # 孤儿回收: 进程在生成中途被杀的 generating 行 → failed (UI 可重试)。
            # cheap UPDATE, 幂等, 每 tick 一次。
            try:
                reclaimed = store.reclaim_stale_generating()
                if reclaimed:
                    logger.warning(
                        f"[report] reclaimed {reclaimed} orphaned generating report(s) → failed"
                    )
            except Exception as e:  # noqa: BLE001 — 回收失败不阻塞正常 tick
                logger.debug(f"[report] reclaim_stale_generating failed: {e}")
            for agent in store.list_agents():
                if not agent.get("enabled") or agent.get("type", "report") != "report":
                    continue
                now = now_fn()
                local = _agent_local(agent, now)   # fire 判定按本地钟点 / 本地日
                key = _fire_state_key(agent["id"])
                last_marker = sync_store.get_state(key)
                hour = _due_hour(agent, local, last_marker)
                if hour is None:
                    continue
                marker = _slot_marker(local, hour)
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
