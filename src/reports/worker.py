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

from src.agents import schedule_rule
from src.config import config
from src.notify.center import NotifyCenter
from src.reports import data as rdata
from src.reports.assembler import assemble_fallback_doc, assemble_report_doc
from src.reports.agent_tools import kos_is_available
from src.reports.matter_data import fetch_matter_briefs
from src.reports.store import ReportStore, cadence_of, schedule_of
from src.reports.wire import connector_grants_of
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

# 通知中心文案 (task 08-20-notification-center, design §7「报告生成完成」行)。
_CADENCE_LABELS = {"daily": "日报", "weekly": "周报", "monthly": "月报"}


def _notify_report_terminal(
    db_path: str, *, rid: str, cadence: str, status: str,
    headline: str = "", error: str = "",
) -> None:
    """落一条报告终态通知。dedupe_key=report:{rid} —— 同 slot 重跑 (INSERT OR REPLACE)

    对应计次。design §7 口径: ready/empty=info、failed=warn；ready 但带 error
    (LLM 失败降级) 文案与纯 ready 区分开，severity 仍是 info（降级仍产出了报告）。
    通知路径绝不影响报告生成终态 (run_worker.py:157-160 同款纪律): 整段 try 吞 + warning。
    """
    try:
        label = _CADENCE_LABELS.get(cadence, cadence)
        if status == "empty":
            title = f"{label}无新内容"
            body = headline or "这段时间没有新邮件"
            severity = "info"
        elif status == "failed":
            title = f"{label}生成失败"
            body = error or "报告生成异常"
            severity = "warn"
        elif error:
            title = f"{label}已生成（AI 摘要降级）"
            body = f"AI 摘要生成失败，已降级为基础统计。{headline}".strip()
            severity = "info"
        else:
            title = f"{label}已生成"
            body = headline or ""
            severity = "info"
        NotifyCenter(db_path).publish(
            category="results",
            source="report",
            severity=severity,
            title=title,
            body=body,
            dedupe_key=f"report:{rid}",
            payload={
                "link": {"type": "report", "reportId": rid},
                "report_id": rid,
                "cadence": cadence,
                "status": status,
            },
        )
    except Exception as e:  # noqa: BLE001 — 通知路径绝不影响报告生成终态
        logger.warning(f"[report] notify_center publish failed report_id={rid}: {e}")


def _notify_reclaimed(db_path: str, count: int) -> None:
    """回收的孤儿 generating 报告 → results/warn 聚合通知 (design §7 第二个 failed 产地)。

    reclaim_stale_generating 只返回回收行数、无具体 report_id，故用固定 dedupe_key
    聚合累计计次 (NotifyCenter 的 recurrence_no 自然承担「第几次」)，不为此新增读点
    去查具体哪些行。
    """
    try:
        NotifyCenter(db_path).publish(
            category="results",
            source="report",
            severity="warn",
            title="报告生成器异常退出",
            body=f"{count} 份报告因进程中断被自动标记为失败，可在报告列表重新生成",
            dedupe_key="report:reclaim_stale",
            payload={"link": {"type": "route", "to": "/admin/kanban"}, "count": count},
        )
    except Exception as e:  # noqa: BLE001 — 通知路径绝不影响 tick 循环
        logger.warning(f"[report] notify_center publish failed (reclaim): {e}")


def _report_id(agent_id: str, cadence: str, report_date: str) -> str:
    return f"{agent_id}:{cadence}:{report_date}"


# schedule_json → dict / cadence 的解析（含「解析不出 → daily」的默认）住在 store.py，
# 与 list_agents 的排序权重共用同一份定义 —— fire / 聚合语义与调度顺序不可能再分裂。
_schedule_of = schedule_of
_cadence_of = cadence_of


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


# 老形状惰性映射的 anchor 回看窗（天）：老规则 interval 恒 1 → anchor 无相位影响，只为
# 界定 RRULE DTSTART；45 天 > 任何月长，保证「当天应触发的 occurrence」恒在枚举范围内，
# 同时 bound 每 tick 的 rrule 枚举成本（不用固定远古日期逐年变慢）。
_LEGACY_ANCHOR_LOOKBACK_DAYS = 45


def _rule_entries(
    agent: Dict[str, Any], now: datetime
) -> List[Tuple[schedule_rule.ScheduleRule, Any, date]]:
    """schedule_json → ``[(rule, tzinfo/tz名, anchor)]`` 求值输入（fire 判定唯一入口）。

    - 新 ``kind:'schedule'`` 形状：payload 的 rule/timezone/anchor 权威（契约 §1，timezone
      必填）；坏 payload → 空列表 + warning（skip 不猜，镜像 trigger_worker 坏配置纪律）。
    - 老形状（``{cadence, hours[], ...}``）→ 契约 §4 就地映射（**不回写 DB**）：每个 fire
      hour 一条 rule；时区写实 = 调用方已按「列 timezone 或宿主机本地」把 ``now`` 转成
      agent 本地（``_agent_local``），直接取 ``now.tzinfo`` —— 与老 ``_due_hour`` 读
      ``now.hour``/``now.weekday()`` 的墙钟语义逐字等价；anchor 回看 45 天（interval=1
      无相位影响）。
    """
    sched = _schedule_of(agent)
    if sched.get("kind") == "schedule":
        try:
            rule = schedule_rule.parse_rule(sched.get("rule"))
            anchor = schedule_rule.parse_anchor(sched.get("anchor"))
            tz = str(sched.get("timezone") or "")
            if not tz:
                # timezone 必填（契约 §1）；合法性由求值器 _tzinfo_of 把关（野名 → 求值抛）。
                raise schedule_rule.ScheduleRuleError("schedule timezone is required")
            return [(rule, tz, anchor)]
        except schedule_rule.ScheduleRuleError as e:
            logger.warning(
                f"[report] agent={agent.get('id')} bad schedule payload ({e}) — skip fire"
            )
            return []
    anchor = (now - timedelta(days=_LEGACY_ANCHOR_LOOKBACK_DAYS)).date()
    return [
        (r, now.tzinfo, anchor) for r in schedule_rule.rules_from_legacy_schedule(sched)
    ]


def _due_occurrence(
    agent: Dict[str, Any], now: datetime, last_marker: Optional[str]
) -> Optional[datetime]:
    """now 是否该 fire；返回命中的 occurrence（aware，agent/规则本地时区），否则 None。

    occurrence 计算走共享求值器 ``src/agents/schedule_rule``（与 custom trigger_worker
    同一份实现，契约 §6）；判定语义保持原 ``_due_hour`` 两分支逐字等价：

    1) 当前落在 fire window [occ, occ+30min) 且该 slot 未 fire → fire。
    2) catchup：当天（规则本地日）还没 fire 过任何 slot（last_marker 非今天）→ 补当天
       最近一个已过 occurrence（不补多次、不补历史天）。
    weekly/monthly 的周期校验由求值器天然覆盖（不匹配的日子 prev occurrence 落在过去
    的别的天 → 两分支都不命中）。
    """
    best: Optional[datetime] = None
    for rule, tz, anchor in _rule_entries(agent, now):
        try:
            occ = schedule_rule.prev_occurrence(rule, tz, anchor, now)
        except schedule_rule.ScheduleRuleError as e:  # 求值期坏输入（如野时区名）
            logger.warning(f"[report] agent={agent.get('id')} schedule eval failed: {e}")
            continue
        if occ is None:
            continue
        if occ <= now < occ + timedelta(minutes=FIRE_WINDOW_MIN):
            # 1) 当前 fire window；marker 按 occurrence 自己的本地日+钟点（老行为等价：
            # 老形状 minute 恒 0，窗口不跨日 → 与旧「now 的日期」逐字节相同）。
            if _slot_marker(occ, occ.hour) == last_marker:
                continue  # 当前 window 已 fire
        else:
            # 2) catchup：occurrence 在「今天」（规则时区口径）更早时刻，且今天还没 fire。
            now_local = now.astimezone(occ.tzinfo)
            if occ.date() != now_local.date():
                continue
            if (last_marker or "").startswith(now_local.strftime("%Y%m%d")):
                continue
        if best is None or occ > best:
            best = occ
    return best


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
            store=store, db_path=db_path, agent=agent, cadence=cadence, n=n, gen_now=n,
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
            _notify_report_terminal(
                db_path, rid=rid, cadence=cadence, status="empty",
                headline="这段时间没有新邮件",
            )
            logger.info(f"[report] {rid} empty (no emails in window)")
            return rid

        # 事项取数放在 empty 早退之后：没邮件的那天报告整份都不生成，事项也无处可放。
        matter_briefs = _safe_matter_briefs(db_path, win_start_dt, win_end_dt, rid)
        try:
            draft = await agentic_fn(
                briefs=briefs, counts=counts, db_path=db_path,
                matter_briefs=matter_briefs,
                kos_enabled=kos_is_available(), cadence=cadence, now=n,
                persona_prompt=agent.get("prompt"), model=agent.get("model"),
                context_docs=_parse_context_docs(agent.get("context_docs_json")),
                # MCP connector PR3：报告 Agent 的 per-connector 天花板（行的
                # tool_policy.grant_connectors；未配 → () → 不挂任何 connector 工具）。
                connector_grants=connector_grants_of(agent),
                client=client,
            )
            doc = assemble_report_doc(
                draft=draft, briefs=briefs, counts=counts, agent_id=agent["id"],
                cadence=cadence, report_date=report_date, window_start=win_start,
                window_end=win_end, generated_at=n.isoformat(), model=draft.model, now=n,
                matter_briefs=matter_briefs,
            )
            store.finish_report(
                rid, status="ready", blocks_json=doc.to_json(), counts_json=counts_json,
                headline=doc.derive_headline(), model=draft.model,
                input_tokens=draft.input_tokens, output_tokens=draft.output_tokens,
            )
            _notify_report_terminal(
                db_path, rid=rid, cadence=cadence, status="ready",
                headline=doc.derive_headline(),
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
                matter_briefs=matter_briefs,
            )
            store.finish_report(
                rid, status="ready", blocks_json=doc.to_json(), counts_json=counts_json,
                headline=doc.derive_headline(), error=f"summarize_failed: {str(e)[:200]}",
            )
            _notify_report_terminal(
                db_path, rid=rid, cadence=cadence, status="ready",
                headline=doc.derive_headline(),
                error=f"summarize_failed: {str(e)[:200]}",
            )
        return rid
    except Exception as e:  # noqa: BLE001
        logger.error(f"[report] {rid} failed: {e}")
        store.finish_report(rid, status="failed", error=str(e)[:300])
        _notify_report_terminal(
            db_path, rid=rid, cadence=cadence, status="failed", error=str(e)[:300],
        )
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


def _period_window(start_date: str, end_date: str, n: datetime) -> Tuple[datetime, datetime]:
    """周 / 月报的日期边界（'YYYY-MM-DD'，两端含）→ 事项取数窗口 [起始日 00:00, 末日次日 00:00)。

    时区取 ``n``（agent 时区或本机），与 _period_bounds / fire 判定同口径。
    """
    tz = n.tzinfo
    start = datetime.fromisoformat(start_date).replace(tzinfo=tz)
    end = datetime.fromisoformat(end_date).replace(tzinfo=tz) + timedelta(days=1)
    return start, end


def _safe_matter_briefs(
    db_path: str, window_start: datetime, window_end: datetime, rid: str
) -> List[Any]:
    """事项取数的守护壳：**任何**异常都降级为「本次没有事项」。

    报告不能因为事项挂了而生不出来 —— 邮件才是这份报告的主体，事项是增益。
    flag off / 窗口内无事项同样返回空列表，assembler 据此整段不渲染（不是空框）。
    """
    try:
        return fetch_matter_briefs(db_path, window_start, window_end)
    except Exception as e:  # noqa: BLE001 — 事项取数不得影响报告生成
        logger.warning(f"[report] {rid} 事项取数失败 → 本次报告不含事项区: {e}")
        return []


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
    db_path: str,
    agent: Dict[str, Any],
    cadence: str,
    n: datetime,
    gen_now: datetime,
    aggregate_fn: Callable[..., Awaitable[Any]],
    client: Any,
) -> str:
    """周 / 月报层级聚合：读上一个完整周期的子报告 → LLM 综合 → ReportDoc。缺则跳过 + 标注。

    🔴 事项部分**不走**子报告转述：``db_path`` 就是为它而来 —— 事项数据直接按本周期
    窗口从库里取（``_safe_matter_briefs``）。让模型从 7 份日报的文字里重新归纳「推进到
    哪、卡在哪」，等于把库里已有的结构化主线降级成二手印象。
    """
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
            _notify_report_terminal(
                db_path, rid=rid, cadence=cadence, status="empty",
                headline=f"这段时间没有可综合的{sub_unit}",
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
        matter_briefs = _safe_matter_briefs(
            db_path, *_period_window(start_date, end_date, n), rid
        )
        try:
            draft = await aggregate_fn(
                sub_reports=subs, cadence=cadence, now=gen_now,
                matter_briefs=matter_briefs,
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
            matter_briefs=matter_briefs,
        )
        store.finish_report(
            rid, status="ready", blocks_json=doc.to_json(), counts_json=counts_json,
            headline=doc.derive_headline(), model=model_used,
            input_tokens=draft.input_tokens, output_tokens=draft.output_tokens,
            error=("" if model_used else "aggregate_fallback"),
        )
        _notify_report_terminal(
            db_path, rid=rid, cadence=cadence, status="ready",
            headline=doc.derive_headline(),
            error=("" if model_used else "aggregate_fallback"),
        )
        logger.info(
            f"[report] {rid} ready (aggregate {len(subs)} {sub_cadence}, missing={missing})"
        )
        return rid
    except Exception as e:  # noqa: BLE001
        logger.error(f"[report] {rid} aggregate failed: {e}")
        store.finish_report(rid, status="failed", error=str(e)[:300])
        _notify_report_terminal(
            db_path, rid=rid, cadence=cadence, status="failed", error=str(e)[:300],
        )
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
                    _notify_reclaimed(db_path, reclaimed)
            except Exception as e:  # noqa: BLE001 — 回收失败不阻塞正常 tick
                logger.debug(f"[report] reclaim_stale_generating failed: {e}")
            for agent in store.list_agents():
                if not agent.get("enabled") or agent.get("type", "report") != "report":
                    continue
                now = now_fn()
                local = _agent_local(agent, now)   # fire 判定按本地钟点 / 本地日
                key = _fire_state_key(agent["id"])
                last_marker = sync_store.get_state(key)
                occ = _due_occurrence(agent, local, last_marker)
                if occ is None:
                    continue
                # marker 按 occurrence 的本地日+钟点（跨午夜窗口时与去重判据一致；
                # 老形状 minute 恒 0 → 与旧「local 的日期」字节相同）。
                marker = _slot_marker(occ, occ.hour)
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
