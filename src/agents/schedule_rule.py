"""排程规则求值器（schedule-builder 后端内核）。

契约 = ``.trellis/tasks/07-24-custom-agents-tab-agents-schedule-builder-custom-cron-agent/
research/schedule-contract.md``，本模块逐字实现其 §1-§4；前端 schedule-builder 预览按同一份
契约实现 TS 侧，黄金 fixture ``tests/fixtures/schedule_occurrences.json`` 是两侧的裁判。
**改语义先改契约，再两侧同步** —— 禁止单方面"优化"。

这是 ``kind:'schedule'`` 结构化排程在**两个 worker**（``src/agents/trigger_worker`` custom
定时面 / ``src/reports/worker`` 报告面）共用的唯一 occurrence 计算实现，禁止各写一份。

语义要点（契约 §2/§3）：
- 星期编号：**0=周日 … 6=周六**（JS ``getDay()`` / cron 口径）；Python ``weekday()`` 0=周一
  → 必须经 ``rule_to_py`` / ``py_to_rule`` 转换，不可透传。
- 全程在 timezone 的**墙钟**上跑 naive RRULE（DTSTART = anchor 本地日期 + hour:minute），
  出口才贴时区 —— 「每天 9:00」跨 DST 恒为本地 9:00。
- interval 相位以 **anchor（本地日历日期，非 UTC）** 为原点（RRULE DTSTART 天然语义）；
  ``WKST=SU`` 显式指定（RFC 5545 默认 MO 会让 interval>1 的周规则相位差一周）。
- 月末：``clamp=false`` = RRULE BYMONTHDAY 天然跳过无该日的月份；``clamp=true`` = 唯一非
  RRULE 分支（逐候选月取 ``min(monthDay, 当月天数)``，**不用** BYSETPOS 技巧）。
- DST 落点：不存在的墙钟 → 向后推到该日首个存在的瞬间（transition 点）；重复的墙钟 →
  fold=0 取较早那次。

依赖：``dateutil``（croniter 的既有传递依赖，requirements.lock 已 pin）+ 标准库。零 transport。
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any, Iterator, List, Optional, Tuple, Union
from zoneinfo import ZoneInfo

from dateutil.rrule import DAILY, FR, MO, MONTHLY, SA, SU, TH, TU, WE, WEEKLY, rrule

__all__ = [
    "ScheduleRule",
    "ScheduleRuleError",
    "occurrences",
    "parse_anchor",
    "parse_rule",
    "prev_occurrence",
    "py_to_rule",
    "rule_to_py",
    "rules_from_legacy_schedule",
]


class ScheduleRuleError(ValueError):
    """schedule 规则校验 / 求值输入非法。"""


# 契约 §2：dateutil 的周常量按**契约顺序**（0=周日）索引。
WEEKDAY_CONSTS = (SU, MO, TU, WE, TH, FR, SA)

_VALID_FREQ = ("daily", "weekly", "monthly")
_VALID_MONTH_MODE = ("date", "nth")
_VALID_ORDINALS = (1, 2, 3, 4, "last")

# 契约 §1：freq 不用的字段仍需存在且合法 —— 全 10 键必填，多 / 少键都拒
# （避免两侧对「缺字段」的兜底不一致）。
_RULE_KEYS = frozenset(
    {"freq", "interval", "weekdays", "monthMode", "monthDay",
     "ordinal", "weekday", "hour", "minute", "clamp"}
)

_ANCHOR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def rule_to_py(w: int) -> int:
    """契约口径（0=周日）→ Python ``weekday()`` 口径（0=周一）。"""
    return (w + 6) % 7


def py_to_rule(w: int) -> int:
    """Python ``weekday()`` 口径（0=周一）→ 契约口径（0=周日）。"""
    return (w + 1) % 7


@dataclass(frozen=True)
class ScheduleRule:
    """契约 §1 的 ``rule`` 对象（已校验；字段名 snake_case，wire 层是 camelCase）。"""

    freq: str
    interval: int
    weekdays: Tuple[int, ...]
    month_mode: str
    month_day: int
    ordinal: Union[int, str]
    weekday: int
    hour: int
    minute: int
    clamp: bool


def _int_field(data: dict, key: str, lo: int, hi: int) -> int:
    v = data[key]
    # bool 是 int 子类 —— true/false 混进整型字段是两侧序列化分叉的信号，拒。
    if isinstance(v, bool) or not isinstance(v, int):
        raise ScheduleRuleError(f"{key} must be an integer")
    if not (lo <= v <= hi):
        raise ScheduleRuleError(f"{key} out of range [{lo}, {hi}]: {v}")
    return v


def parse_rule(data: Any) -> ScheduleRule:
    """契约 §1 深校验：dict → ``ScheduleRule``。值域之外一律拒（``ScheduleRuleError``）。"""
    if not isinstance(data, dict):
        raise ScheduleRuleError("rule must be a JSON object")
    missing = _RULE_KEYS - set(data)
    if missing:
        raise ScheduleRuleError(f"rule missing keys: {sorted(missing)}")
    unknown = set(data) - _RULE_KEYS
    if unknown:
        raise ScheduleRuleError(f"rule has unknown keys: {sorted(unknown)}")

    freq = data["freq"]
    if freq not in _VALID_FREQ:
        raise ScheduleRuleError(f"freq must be one of {list(_VALID_FREQ)}, got {freq!r}")

    interval = data["interval"]
    if isinstance(interval, bool) or not isinstance(interval, int) or interval < 1:
        raise ScheduleRuleError(f"interval must be an integer >= 1, got {interval!r}")

    weekdays_raw = data["weekdays"]
    if not isinstance(weekdays_raw, list) or not all(
        isinstance(w, int) and not isinstance(w, bool) and 0 <= w <= 6 for w in weekdays_raw
    ):
        raise ScheduleRuleError("weekdays must be a list of integers in [0, 6]")
    weekdays = tuple(sorted(set(weekdays_raw)))
    if freq == "weekly" and not weekdays:
        raise ScheduleRuleError("weekly rule needs at least one weekday")

    month_mode = data["monthMode"]
    if month_mode not in _VALID_MONTH_MODE:
        raise ScheduleRuleError(
            f"monthMode must be one of {list(_VALID_MONTH_MODE)}, got {month_mode!r}"
        )

    ordinal = data["ordinal"]
    if isinstance(ordinal, bool) or ordinal not in _VALID_ORDINALS:
        raise ScheduleRuleError(f"ordinal must be one of {list(_VALID_ORDINALS)}, got {ordinal!r}")

    clamp = data["clamp"]
    if not isinstance(clamp, bool):
        raise ScheduleRuleError("clamp must be a JSON boolean")

    return ScheduleRule(
        freq=freq,
        interval=interval,
        weekdays=weekdays,
        month_mode=month_mode,
        month_day=_int_field(data, "monthDay", 1, 31),
        ordinal=ordinal,
        weekday=_int_field(data, "weekday", 0, 6),
        hour=_int_field(data, "hour", 0, 23),
        minute=_int_field(data, "minute", 0, 59),
        clamp=clamp,
    )


def parse_anchor(value: Any) -> date:
    """anchor（``YYYY-MM-DD``，**本地日历日期**，契约 §1）→ ``date``。"""
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not _ANCHOR_RE.match(value):
        raise ScheduleRuleError(f"anchor must be a YYYY-MM-DD date string, got {value!r}")
    try:
        return date.fromisoformat(value)
    except ValueError as e:
        raise ScheduleRuleError(f"anchor is not a valid date: {value!r}") from e


def _tzinfo_of(tz: Union[str, tzinfo]) -> tzinfo:
    """IANA 名 → ``ZoneInfo``；tzinfo 实例原样透传（报告 worker 惰性迁移路径会传
    调用方已解析好的本地 tzinfo）。"""
    if isinstance(tz, tzinfo):
        return tz
    if not isinstance(tz, str) or not tz.strip():
        raise ScheduleRuleError("timezone must be a non-empty IANA name")
    try:
        return ZoneInfo(tz)
    except Exception as e:  # noqa: BLE001 — ZoneInfoNotFoundError/ValueError/KeyError
        raise ScheduleRuleError(f"invalid IANA timezone: {tz!r}") from e


# ── 墙钟 naive → aware（契约 §3.3 的两种 DST 落点）───────────────────────────

def _wall(t_utc: datetime, tz: tzinfo) -> datetime:
    return t_utc.astimezone(tz).replace(tzinfo=None)


def _localize(naive: datetime, tz: tzinfo) -> datetime:
    """naive 墙钟 → aware。重复的墙钟取 fold=0（较早）；不存在的墙钟向后推到该日首个
    存在的瞬间（= DST transition 点，如 LA 2026-03-08 02:30 → 03:00-07:00）。"""
    dt0 = naive.replace(tzinfo=tz, fold=0)
    rt = dt0.astimezone(timezone.utc).astimezone(tz)
    if rt.replace(tzinfo=None) == naive:
        return dt0  # 存在（重复墙钟时 fold=0 已是较早那次）
    # 不存在的墙钟：fold=1 用 transition 后偏移（UTC 较早），fold=0 用 transition 前偏移
    # （UTC 较晚）；首个 wall >= naive 的 UTC 瞬间正是 transition 点，在两者之间二分。
    lo = naive.replace(tzinfo=tz, fold=1).astimezone(timezone.utc)
    hi = dt0.astimezone(timezone.utc)
    lo_s, hi_s = 0, int((hi - lo).total_seconds())
    while lo_s < hi_s:
        mid = (lo_s + hi_s) // 2
        if _wall(lo + timedelta(seconds=mid), tz) >= naive:
            hi_s = mid
        else:
            lo_s = mid + 1
    return (lo + timedelta(seconds=hi_s)).astimezone(tz)


# ── RRULE 构造（契约 §3.1）────────────────────────────────────────────────────

def _rrule_for(rule: ScheduleRule, dtstart: datetime) -> rrule:
    if rule.freq == "daily":
        return rrule(DAILY, interval=rule.interval, dtstart=dtstart)
    if rule.freq == "weekly":
        byday = [WEEKDAY_CONSTS[w] for w in rule.weekdays]
        # WKST=SU 必须显式：RFC 5545 默认 MO，interval>1 的周规则相位会差一周。
        return rrule(WEEKLY, interval=rule.interval, byweekday=byday, wkst=SU, dtstart=dtstart)
    if rule.month_mode == "date":
        # BYMONTHDAY=31 天然跳过没有 31 号的月份 —— 即 clamp=false 语义。
        return rrule(MONTHLY, interval=rule.interval, bymonthday=rule.month_day, dtstart=dtstart)
    pos = -1 if rule.ordinal == "last" else int(rule.ordinal)
    return rrule(
        MONTHLY, interval=rule.interval,
        byweekday=WEEKDAY_CONSTS[rule.weekday](pos), dtstart=dtstart,
    )


def _clamped_monthly_iter(rule: ScheduleRule, dtstart: datetime) -> Iterator[datetime]:
    """契约 §3.2：clamp=true 是唯一非 RRULE 分支 —— 按 interval 相位逐候选月枚举，
    取 ``min(monthDay, 当月天数)``（不用 BYSETPOS 技巧）。产出 naive、升序、>= dtstart。"""
    y, m = dtstart.year, dtstart.month
    while True:
        days_in_month = calendar.monthrange(y, m)[1]
        cand = datetime(y, m, min(rule.month_day, days_in_month), rule.hour, rule.minute)
        if cand >= dtstart:
            yield cand
        m += rule.interval
        y += (m - 1) // 12
        m = (m - 1) % 12 + 1


def _is_clamped_branch(rule: ScheduleRule) -> bool:
    # clamp 只对 monthMode=date 有意义；nth 时忽略（1st-4th 与 last 必然存在，契约 §3.2）。
    return rule.freq == "monthly" and rule.month_mode == "date" and rule.clamp


def _dtstart(rule: ScheduleRule, anchor: date) -> datetime:
    return datetime(anchor.year, anchor.month, anchor.day, rule.hour, rule.minute)


def _to_wall_naive(dt: datetime, tz: tzinfo, name: str) -> datetime:
    if dt.tzinfo is None:
        raise ScheduleRuleError(f"{name} must be timezone-aware")
    return dt.astimezone(tz).replace(tzinfo=None)


# ── 公共 API（契约 §3）────────────────────────────────────────────────────────

def occurrences(
    rule: ScheduleRule,
    tz: Union[str, tzinfo],
    anchor: Union[str, date],
    after: datetime,
    count: int,
) -> List[datetime]:
    """严格晚于 ``after`` 的前 ``count`` 次运行时刻（aware，按 ``tz``）。

    比较在 ``tz`` 的墙钟上做（契约 §3：after 先转墙钟 naive 再比），出口才贴时区。
    """
    tzi = _tzinfo_of(tz)
    dtstart = _dtstart(rule, parse_anchor(anchor))
    after_naive = _to_wall_naive(after, tzi, "after")
    out: List[datetime] = []
    if _is_clamped_branch(rule):
        for cand in _clamped_monthly_iter(rule, dtstart):
            if cand <= after_naive:
                continue
            out.append(_localize(cand, tzi))
            if len(out) >= count:
                break
    else:
        rr = _rrule_for(rule, dtstart)
        for cand in rr.xafter(after_naive, count=count, inc=False):
            out.append(_localize(cand, tzi))
    return out


def prev_occurrence(
    rule: ScheduleRule,
    tz: Union[str, tzinfo],
    anchor: Union[str, date],
    before: datetime,
) -> Optional[datetime]:
    """最近一次 ``<= before`` 的运行时刻（aware，按 ``tz``）；anchor 之前无 occurrence
    → ``None``。worker 的 fire 判定（「最近 occurrence 落在 (marker, now] 且距今 ≤ 窗宽」）
    用它。"""
    tzi = _tzinfo_of(tz)
    dtstart = _dtstart(rule, parse_anchor(anchor))
    before_naive = _to_wall_naive(before, tzi, "before")
    if _is_clamped_branch(rule):
        last: Optional[datetime] = None
        for cand in _clamped_monthly_iter(rule, dtstart):
            if cand > before_naive:
                break
            last = cand
        return _localize(last, tzi) if last is not None else None
    occ = _rrule_for(rule, dtstart).before(before_naive, inc=True)
    return _localize(occ, tzi) if occ is not None else None


# ── 老形状惰性映射（契约 §4）──────────────────────────────────────────────────

def rules_from_legacy_schedule(sched: dict) -> List[ScheduleRule]:
    """报告 agent 老 ``schedule_json``（``{cadence, hours[], weekday, day_of_month}``）→
    等价 ``ScheduleRule`` 列表（每个 fire hour 一条；interval 恒 1，anchor 由调用方随便给）。

    **就地映射不回写 DB**（契约 §4）。星期编号必须转换：老 ``weekday`` 是 Python 口径
    （0=周一），映射 ``(W+1)%7``。越界的 weekday / day_of_month 在老 worker 里是「永不
    fire」（``now.weekday()==7`` 恒 False）→ 映射为空列表，保持行为等价。
    多 hour 行（生产无、但契约要求老行不丢配置）→ 每 hour 一条 rule，触发面完全等价。
    """
    cadence = str(sched.get("cadence") or "daily")
    # hours 清洗镜像 reports/worker._fire_hours：滤非法、去重、空则兜底 [9]。
    hours: List[int] = []
    for h in sched.get("hours") or []:
        try:
            hi = int(h)
        except (TypeError, ValueError):
            continue
        if 0 <= hi <= 23 and hi not in hours:
            hours.append(hi)
    hours = hours or [9]

    base = dict(
        interval=1, weekdays=(), month_mode="date", month_day=1,
        ordinal=1, weekday=0, minute=0, clamp=False,
    )
    if cadence == "weekly":
        try:
            py_w = int(sched.get("weekday", 0) or 0)
        except (TypeError, ValueError):
            return []
        if not (0 <= py_w <= 6):
            return []  # 老 worker 恒不 fire → 等价：无规则
        base.update(freq="weekly", weekdays=(py_to_rule(py_w),))
    elif cadence == "monthly":
        try:
            dom = int(sched.get("day_of_month", 1) or 1)
        except (TypeError, ValueError):
            return []
        if not (1 <= dom <= 31):
            return []  # 老 worker 恒不 fire → 等价：无规则
        base.update(freq="monthly", month_day=dom)
    else:
        # 未知 / 缺省 cadence 在老 worker 里走 daily 分支（store.DEFAULT_CADENCE 同款语义）。
        base.update(freq="daily")
    return [ScheduleRule(hour=h, **base) for h in hours]
