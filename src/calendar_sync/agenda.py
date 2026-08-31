"""日历三源聚合读面（``GET /api/calendar/agenda`` 的实现体）。

三源（design.md §7）：

  - ``mail``   邮箱日历 = ``calendar_event``（RRULE 已由 ``CalendarService`` 展开）
  - ``matter`` 事项日历 = ``matter.due_at`` + ``matter_item.due_at``（``kind='action'``）
  - ``agent``  Agent 日历 = ``report_agent`` 里**用户配置的排程语义**展开成未来时刻

纪律：

  - **只读**。三源全部直读 SQLite，不写任何 marker、不参与任何 fire 判定。
  - Agent 源是 ``src/agents/schedule_rule`` 的**纯消费方**（契约 §6.3）—— 只调
    ``occurrences()`` / ``rules_from_legacy_schedule()``，不改它们的语义。
  - 后端不掺前端路由知识：条目只带定位字段（``eventId`` / ``icalUid`` /
    ``recurrenceId`` / ``matterId`` / ``itemId`` / ``agentId``），跳哪去前端自己拼。

🔴 **两源的时间单位不同，合并前必须各自换算**（核实过写侧，不是推断）：

  - ``matter.due_at`` / ``matter_item.due_at`` = **epoch 毫秒**。写侧
    ``MatterService._require_epoch_ms``（``src/matters/service.py``）强制 13 位，对
    10 位值直接报「看着像 epoch 秒，乘 1000」；读侧 ``src/matters/attention.py``
    一律 ``/1000`` 转 datetime。
  - ``calendar_event.dtstart_utc`` = **epoch 秒**（REAL）。``repository._from_epoch``
    直接 ``datetime.fromtimestamp(ts)``，``sync_store.py`` 的 contact 列注释也点名
    「calendar_event 存的是 epoch 秒 REAL，边界处换算」。

本模块不直接读 ``dtstart_utc``（邮箱日历经 ``CalendarService`` 出 ISO 串），事项侧
显式 ``/1000``；三源在排序前全部是 aware UTC datetime，不存在混单位比较。
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timedelta, timezone, tzinfo
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Optional, Sequence, Set
from zoneinfo import ZoneInfo

if TYPE_CHECKING:
    from src.config import Config

logger = logging.getLogger("mailagent.calendar.agenda")

#: 聚合层的源枚举。**不是** ``calendar_event.source``（那是 caldav/email_ics/legacy），
#: 两者值域无交集，别混。
AGENDA_SOURCES = ("mail", "matter", "agent")

#: 单条排程规则在一个窗口内的展开上限。长窗口 + 每日规则会无界增长（一年 365 条），
#: 月视图一次只画 6 周 ⇒ 100 足够；超出直接截断（宁可少画，不拖垮请求）。
MAX_OCCURRENCES_PER_RULE = 100

#: 邮箱日历子查询的 occurrence 上限（不对外暴露；对照 ``/events`` 的默认 1000 / 上限 5000）。
AGENDA_EVENT_LIMIT = 2000

#: 「重要邮箱日程」判据 —— 源邮件的 LLM 分类结果。值域单源
#: ``src/llm_agent/schema.PRIORITY_ENUM``；同款字面量集在
#: ``src/llm_agent/schema.URGENT_PRIORITY_LABELS`` /
#: ``src/mail/reverse_sync.NOTIFY_PRIORITIES`` 已有先例。
HOT_PRIORITY_LABELS = ("🔴 紧急", "🟡 重要")

#: 已收尾的事项 / 行动项业务态（不进日历 —— 画一件已经完结的事的截止日没有意义）。
#: 与 ``src/matters/service.CLOSED_ITEM_STATUSES`` / ``src/matters/attention.py``
#: 的 live 集判据同口径。
_CLOSED_STATUSES = ("done", "canceled")

#: 单条 SQL 的 IN 参数分片（SQLite 默认变量上限 999）。
_SQL_PARAM_CHUNK = 500


# ===========================================================================
# 通用小工具
# ===========================================================================


def _validated_sources(sources: Iterable[str]) -> List[str]:
    """校验 + 去重，按 ``AGENDA_SOURCES`` 的稳定顺序返回（结果也进 meta，顺序不该抖）。"""
    wanted = set(sources)
    bad = sorted(wanted - set(AGENDA_SOURCES))
    if bad:
        raise ValueError(
            f"sources must be a subset of {list(AGENDA_SOURCES)}, got {bad}"
        )
    return [s for s in AGENDA_SOURCES if s in wanted]


def parse_sources(raw: Optional[str]) -> List[str]:
    """``"mail,agent"`` → ``["mail", "agent"]``；空 / None → 全部三源。

    Raises:
        ValueError: 出现 ``AGENDA_SOURCES`` 之外的值。
    """
    if raw is None or not raw.strip():
        return list(AGENDA_SOURCES)
    wanted = [part.strip() for part in raw.split(",") if part.strip()]
    if not wanted:
        return list(AGENDA_SOURCES)
    return _validated_sources(wanted)


def resolve_zone(tz: Optional[str]) -> tzinfo:
    """Olson 名 → tzinfo；空 → UTC。``multiDay`` 的日界判定用。

    Raises:
        ValueError: 非法时区名。
    """
    if not tz or not tz.strip():
        return timezone.utc
    try:
        return ZoneInfo(tz.strip())
    except Exception as exc:  # noqa: BLE001 — ZoneInfoNotFoundError/ValueError/KeyError
        raise ValueError(f"tz={tz!r} is not a valid IANA timezone name") from exc


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _is_multi_day(start: datetime, end: Optional[datetime], zone: tzinfo) -> bool:
    """按 ``zone`` 的日界判定跨天。

    结束时刻按 **排他** 解释（iCalendar 语义）：全天事件的 ``DTEND`` 是次日 00:00，
    22:00→次日 00:00 的普通事件同理 —— 两者都不该算跨天，所以比日期前先退 1 微秒。
    """
    if end is None or end <= start:
        return False
    effective_end = end - timedelta(microseconds=1)
    return start.astimezone(zone).date() != effective_end.astimezone(zone).date()


# ===========================================================================
# 源 1：邮箱日历（calendar_event）
# ===========================================================================


def _hot_email_ids(db_path: str, internal_ids: Set[int]) -> Set[int]:
    """一次批量 JOIN 出「源邮件被标成紧急 / 重要」的 internal_id 集合。

    🔴 逐条调 ``get_event_source_email`` 会在一个月视图里打出上百次查询 —— 这里按
    分片 IN 一次问完。命中率天然受限：只有 ``source='email_ics'`` 的行才挂得上源邮件，
    且要那封邮件跑过 LLM 分类（``ai_priority`` 才非空）。
    """
    if not internal_ids:
        return set()
    hot: Set[int] = set()
    ordered = sorted(internal_ids)
    conn = sqlite3.connect(db_path, timeout=30.0)
    try:
        priority_marks = ",".join("?" * len(HOT_PRIORITY_LABELS))
        for offset in range(0, len(ordered), _SQL_PARAM_CHUNK):
            chunk = ordered[offset : offset + _SQL_PARAM_CHUNK]
            marks = ",".join("?" * len(chunk))
            rows = conn.execute(
                f"SELECT internal_id FROM email_metadata "
                f"WHERE internal_id IN ({marks}) AND ai_priority IN ({priority_marks})",
                (*chunk, *HOT_PRIORITY_LABELS),
            ).fetchall()
            hot.update(int(r[0]) for r in rows)
    finally:
        conn.close()
    return hot


def _mail_entries(
    *,
    db_path: str,
    cfg: Optional["Config"],
    window_start: datetime,
    window_end: datetime,
    calendar_name: Optional[str],
    zone: tzinfo,
) -> List[Dict[str, Any]]:
    from src.calendar_sync.service import CalendarService

    svc = CalendarService(db_path=db_path, cfg=cfg)
    data = svc.list_events_in_window(
        window_start=window_start,
        window_end=window_end,
        calendar_name=calendar_name,
        limit=AGENDA_EVENT_LIMIT,
        expand_recurrences=True,
    )
    events = data["events"]

    related = {
        int(ev["related_email_internal_id"])
        for ev in events
        if ev.get("related_email_internal_id") is not None
    }
    hot_ids = _hot_email_ids(db_path, related)

    out: List[Dict[str, Any]] = []
    for ev in events:
        start = datetime.fromisoformat(ev["occurrence_start_iso"])
        end_raw = ev.get("occurrence_end_iso")
        end = datetime.fromisoformat(end_raw) if end_raw else None
        rid = ev.get("recurrence_id")
        email_id = ev.get("related_email_internal_id")
        out.append(
            {
                # 🔴 尾段是 occurrence 起点：同一条 RRULE master 在窗口内展开出的多次
                # occurrence 共享 (ical_uid, recurrence_id)，不带起点的 id 会整串重复。
                "id": f"mail:{ev['ical_uid']}:{rid or ''}:{ev['occurrence_start_iso']}",
                "source": "mail",
                "hot": email_id is not None and int(email_id) in hot_ids,
                "title": ev.get("summary") or "",
                "startIso": _iso(start),
                "endIso": _iso(end) if end else None,
                "allDay": bool(ev.get("is_all_day")),
                "multiDay": _is_multi_day(start, end, zone),
                "eventId": ev.get("id"),
                "icalUid": ev.get("ical_uid"),
                "recurrenceId": rid,
                # 「按日历筛选」的前端判据 (mail-only): matter/agent 条目不带此键,
                # 前端筛选对它们恒不生效。
                "calendarName": ev.get("calendar_name"),
            }
        )
    return out


# ===========================================================================
# 源 2：事项日历（matter.due_at + matter_item.due_at）
# ===========================================================================


def _matter_entries(
    *, db_path: str, window_start: datetime, window_end: datetime
) -> List[Dict[str, Any]]:
    """事项截止日 + 有计划时间的行动项。

    live 集判据照搬 ``src/matters/attention.py::_collect_facts``：事项未删除、未归档、
    状态不在 ``done/canceled``；行动项 ``kind='action'`` 且未删除、状态不在
    ``done/canceled``（``status`` 可为 NULL = 未定状态，仍算未完成）。
    """
    # 🔴 due_at 是 epoch **毫秒**（见模块 docstring 的单位核实）—— calendar_event 那边
    # 是秒，两处不能互抄。
    start_ms = int(window_start.timestamp() * 1000)
    end_ms = int(window_end.timestamp() * 1000)
    closed_marks = ",".join("?" * len(_CLOSED_STATUSES))

    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        matters = conn.execute(
            f"SELECT public_id, title, due_at FROM matter "
            f"WHERE deleted_at IS NULL AND archived_at IS NULL "
            f"AND status NOT IN ({closed_marks}) "
            f"AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?",
            (*_CLOSED_STATUSES, start_ms, end_ms),
        ).fetchall()
        items = conn.execute(
            f"SELECT i.id AS item_id, i.title AS title, i.due_at AS due_at, "
            f"m.public_id AS public_id "
            f"FROM matter_item i JOIN matter m ON m.id = i.matter_id "
            f"WHERE i.kind = 'action' AND i.deleted_at IS NULL "
            f"AND i.due_at IS NOT NULL AND i.due_at >= ? AND i.due_at < ? "
            f"AND (i.status IS NULL OR i.status NOT IN ({closed_marks})) "
            f"AND m.deleted_at IS NULL AND m.archived_at IS NULL "
            f"AND m.status NOT IN ({closed_marks})",
            (start_ms, end_ms, *_CLOSED_STATUSES, *_CLOSED_STATUSES),
        ).fetchall()
    finally:
        conn.close()

    out: List[Dict[str, Any]] = []
    for row in matters:
        due = datetime.fromtimestamp(int(row["due_at"]) / 1000, tz=timezone.utc)
        out.append(
            {
                "id": f"matter:{row['public_id']}",
                "source": "matter",
                "hot": False,
                "title": row["title"] or "",
                "startIso": _iso(due),
                # 截止日是时间点，没有跨度 ⇒ endIso 恒 null、multiDay 恒 false。
                "endIso": None,
                "allDay": False,
                "multiDay": False,
                "matterId": row["public_id"],
            }
        )
    for row in items:
        due = datetime.fromtimestamp(int(row["due_at"]) / 1000, tz=timezone.utc)
        out.append(
            {
                "id": f"matter-item:{row['item_id']}",
                "source": "matter",
                "hot": False,
                "title": row["title"] or "",
                "startIso": _iso(due),
                "endIso": None,
                "allDay": False,
                "multiDay": False,
                "matterId": row["public_id"],
                "itemId": str(row["item_id"]),
            }
        )
    return out


# ===========================================================================
# 源 3：Agent 排程（report_agent 的两型）
# ===========================================================================


def _agent_zone(agent: Dict[str, Any]) -> tzinfo:
    """``report_agent.timezone``（IANA）→ tzinfo；空 / 非法 → 宿主机本地。

    与 ``src/reports/worker._zone`` / ``_agent_local`` 同口径（报告 worker 的 fire
    判定就按这个时区跑），差别只在这里必须交出一个具体 tzinfo。

    ⚠️ 回落到宿主机本地时拿到的是**固定偏移快照**（``astimezone()`` 无参的语义），
    跨 DST 边界的窗口里，切换之后的时刻会差一小时。worker 每 tick 用新的 ``now``
    取快照所以从不暴露这一点；这里是显示面，接受这个已知偏差，不为它引第三方
    tzlocal 依赖。
    """
    raw = str(agent.get("timezone") or "").strip()
    if raw:
        try:
            return ZoneInfo(raw)
        except Exception as exc:  # noqa: BLE001 — 非法时区名退回本地（镜像 worker._zone）
            logger.debug(f"[agenda] agent={agent.get('id')} bad timezone {raw!r}: {exc}")
    local = datetime.now(timezone.utc).astimezone().tzinfo
    return local or timezone.utc


def _expand_schedule(
    rule: Any,
    tz: Any,
    anchor: Any,
    window_start: datetime,
    window_end: datetime,
    *,
    agent_id: str,
) -> List[datetime]:
    """一条 ``ScheduleRule`` 在 ``[window_start, window_end)`` 内的运行时刻（UTC）。

    ``occurrences()`` 是 **严格晚于** ``after``，所以退 1 微秒让恰好落在窗口起点的
    那次也进来。坏配置 → debug 日志 + 跳过（镜像两个 worker 的「不猜」纪律）。
    """
    from src.agents import schedule_rule

    try:
        occs = schedule_rule.occurrences(
            rule,
            tz,
            anchor,
            window_start - timedelta(microseconds=1),
            MAX_OCCURRENCES_PER_RULE,
        )
    except schedule_rule.ScheduleRuleError as exc:
        logger.debug(f"[agenda] agent={agent_id} schedule eval failed: {exc}")
        return []
    out: List[datetime] = []
    for occ in occs:
        occ_utc = occ.astimezone(timezone.utc)
        if occ_utc >= window_end:
            break  # occurrences() 升序返回
        out.append(occ_utc)
    return out


def _expand_cron(
    expr: str,
    tz_name: str,
    window_start: datetime,
    window_end: datetime,
    *,
    agent_id: str,
) -> List[datetime]:
    """cron 表达式在窗口内的运行时刻（UTC）。

    cron 型 custom agent 走 croniter（``schedule_rule`` 不覆盖 cron —— 契约 §8），
    与 ``trigger_worker._due_fire`` 的 cron 支同一个库、同一套时区语义。
    """
    from croniter import croniter

    try:
        zone: tzinfo = ZoneInfo(tz_name) if tz_name else timezone.utc
    except Exception as exc:  # noqa: BLE001 — 野时区名 → 跳过这条规则
        logger.debug(f"[agenda] agent={agent_id} bad cron timezone {tz_name!r}: {exc}")
        return []

    out: List[datetime] = []
    try:
        it = croniter(expr, window_start.astimezone(zone) - timedelta(microseconds=1))
        for _ in range(MAX_OCCURRENCES_PER_RULE):
            nxt = it.get_next(datetime).astimezone(timezone.utc)
            if nxt >= window_end:
                break
            out.append(nxt)
    except Exception as exc:  # noqa: BLE001 — 坏 cron 不该拖垮整个聚合
        logger.debug(f"[agenda] agent={agent_id} cron expand failed: {exc}")
        return []
    return out


def _custom_agent_occurrences(
    agent: Dict[str, Any],
    window_start: datetime,
    window_end: datetime,
    *,
    v2_enabled: bool,
) -> List[datetime]:
    """``type='custom'`` 的定时族 trigger 展开（``kind='schedule'`` + ``kind='cron'``）。

    v1/v2 分流逐字镜像 ``trigger_worker.tick_loop`` —— 显示必须等于「真的会跑」，
    否则日历上画着一条 flag-off 之后根本不 fire 的排程。事件型 trigger
    （email_filter / calendar_*）没有可预知的时刻，不进日历。
    """
    from src.agents.trigger import (
        CronTrigger,
        ScheduleTrigger,
        TriggerValidationError,
        parse_trigger,
        parse_trigger_set,
    )

    agent_id = str(agent.get("id") or "")
    try:
        if v2_enabled:
            pairs = [
                (bool(e.enabled), e.trigger)
                for e in parse_trigger_set(agent.get("trigger_json"))
            ]
        else:
            pairs = [(True, parse_trigger(agent.get("trigger_json")))]
    except TriggerValidationError as exc:
        # 「不定时 · 你找它才动」（trigger_json 为 NULL）也走这条 —— 它本来就没有
        # 可画的时刻，不是错误。
        logger.debug(f"[agenda] agent={agent_id} no usable trigger_json: {exc}")
        return []

    out: List[datetime] = []
    for enabled, trig in pairs:
        if not enabled:
            continue
        if isinstance(trig, ScheduleTrigger):
            out.extend(
                _expand_schedule(
                    trig.rule, trig.timezone, trig.anchor,
                    window_start, window_end, agent_id=agent_id,
                )
            )
        elif isinstance(trig, CronTrigger):
            out.extend(
                _expand_cron(
                    trig.cron, trig.timezone, window_start, window_end, agent_id=agent_id,
                )
            )
    return out


def _report_agent_occurrences(
    agent: Dict[str, Any], window_start: datetime, window_end: datetime
) -> List[datetime]:
    """``type='report'`` 的排程展开：新 ``kind:'schedule'`` 形状 + 老形状惰性映射。

    🔴 老形状必须走 ``rules_from_legacy_schedule()`` —— 存量报告 agent 只要没在新
    UI 里保存过就还是 ``{cadence, hours[], ...}``，漏了这一支它们整批不上日历。
    """
    from src.agents import schedule_rule
    from src.reports.store import schedule_of

    agent_id = str(agent.get("id") or "")
    sched = schedule_of(agent)

    if sched.get("kind") == "schedule":
        try:
            rule = schedule_rule.parse_rule(sched.get("rule"))
            anchor = schedule_rule.parse_anchor(sched.get("anchor"))
            tz = str(sched.get("timezone") or "")
            if not tz:
                # timezone 必填（契约 §1），镜像 reports/worker._rule_entries。
                raise schedule_rule.ScheduleRuleError("schedule timezone is required")
        except schedule_rule.ScheduleRuleError as exc:
            logger.debug(f"[agenda] agent={agent_id} bad schedule payload: {exc}")
            return []
        return _expand_schedule(
            rule, tz, anchor, window_start, window_end, agent_id=agent_id
        )

    zone = _agent_zone(agent)
    # 老形状映射出的规则 interval 恒 1 ⇒ anchor 只影响相位、对 interval=1 无影响，
    # 取窗口起点前一天即可（worker 的 45 天回看是为了 bound 每 tick 的枚举成本，
    # 这里枚举本来就以窗口为界）。
    anchor = (window_start.astimezone(zone) - timedelta(days=1)).date()
    out: List[datetime] = []
    for rule in schedule_rule.rules_from_legacy_schedule(sched):
        out.extend(
            _expand_schedule(rule, zone, anchor, window_start, window_end, agent_id=agent_id)
        )
    return out


def _agent_entries(
    *, db_path: str, window_start: datetime, window_end: datetime
) -> List[Dict[str, Any]]:
    """把「用户配置的排程语义」展开成日历条目。

    覆盖面 = ``type='custom'`` 的定时族 trigger + ``type='report'`` 的排程。其余 type
    （preprocess / search / contact_profile / contact_governance）**有意不进** ——
    它们要么跟着收信跑、要么由命令面板调用、要么走 ``new_watcher`` 主 tick 的整点
    自检，都不是用户在排程构建器里配出来的时刻，画进日历只会制造「这是什么」。
    """
    from src.agents.trigger import trigger_v2_enabled
    from src.reports.store import ReportStore

    store = ReportStore(db_path=db_path)
    agents = store.list_agents()
    # flag 每请求读一次（热读 .env），不要放进 per-agent 循环。
    v2_enabled = trigger_v2_enabled()

    out: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for agent in agents:
        if not agent.get("enabled"):
            continue
        agent_id = str(agent.get("id") or "")
        agent_type = str(agent.get("type") or "report")
        if agent_type == "custom":
            occs = _custom_agent_occurrences(
                agent, window_start, window_end, v2_enabled=v2_enabled
            )
        elif agent_type == "report":
            occs = _report_agent_occurrences(agent, window_start, window_end)
        else:
            continue
        title = str(agent.get("title") or agent_id)
        for occ in occs:
            iso = _iso(occ)
            entry_id = f"agent:{agent_id}:{iso}"
            # 同一个 agent 的多条规则可能撞到同一时刻 —— 它在日历上就是一格，去重。
            if entry_id in seen:
                continue
            seen.add(entry_id)
            out.append(
                {
                    "id": entry_id,
                    "source": "agent",
                    "hot": False,
                    "title": title,
                    "startIso": iso,
                    "endIso": None,
                    "allDay": False,
                    "multiDay": False,
                    "agentId": agent_id,
                }
            )
    return out


# ===========================================================================
# 聚合入口
# ===========================================================================


def build_agenda(
    *,
    db_path: str,
    cfg: Optional["Config"] = None,
    window_start: datetime,
    window_end: datetime,
    sources: Sequence[str] = AGENDA_SOURCES,
    calendar_name: Optional[str] = None,
    zone: tzinfo = timezone.utc,
) -> Dict[str, Any]:
    """三源聚合，按 ``startIso`` 升序返回。

    Args:
        window_start / window_end: tz-aware，半开区间 ``[start, end)``。
        sources: ``AGENDA_SOURCES`` 的子集。
        zone: ``multiDay`` 的日界判定时区（``resolve_zone`` 的产物）。

    Raises:
        ValueError: ``window_end <= window_start`` 或 sources 非法。
    """
    if window_end <= window_start:
        raise ValueError(
            f"window_end ({window_end.isoformat()}) must be > "
            f"window_start ({window_start.isoformat()})"
        )
    selected = _validated_sources(sources)

    entries: List[Dict[str, Any]] = []
    if "mail" in selected:
        entries.extend(
            _mail_entries(
                db_path=db_path,
                cfg=cfg,
                window_start=window_start,
                window_end=window_end,
                calendar_name=calendar_name,
                zone=zone,
            )
        )
    if "matter" in selected:
        entries.extend(
            _matter_entries(
                db_path=db_path, window_start=window_start, window_end=window_end
            )
        )
    if "agent" in selected:
        entries.extend(
            _agent_entries(
                db_path=db_path, window_start=window_start, window_end=window_end
            )
        )

    # id 是次键：同一时刻的条目要有稳定顺序，否则前端每次刷新都在重排。
    entries.sort(key=lambda e: (e["startIso"], e["id"]))
    return {
        "entries": entries,
        "total": len(entries),
        "sources": selected,
        "window": {
            "from_iso": window_start.isoformat(),
            "to_iso": window_end.isoformat(),
        },
    }
