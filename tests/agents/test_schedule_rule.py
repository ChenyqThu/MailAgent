"""schedule_rule 求值器单测（契约 schedule-contract.md §2-§4）。

⚠️ case 10-13（DST 春 / 秋 / 空洞 / 迁移星期编号）的期望值在本文件**手写死**（契约 §5
明确要求）—— fixture 只锁「两侧一致」，这里锁「正确」。fixture parity 见
``test_schedule_fixture.py``。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List

import pytest

from src.agents import schedule_rule as sr

_SH = "Asia/Shanghai"
_LA = "America/Los_Angeles"


def _rule(**over: Any) -> sr.ScheduleRule:
    base: Dict[str, Any] = {
        "freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
        "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0, "clamp": False,
    }
    base.update(over)
    return sr.parse_rule(base)


def _occ(rule: sr.ScheduleRule, tz: str, anchor: str, after: str, n: int = 5) -> List[str]:
    return [
        d.isoformat()
        for d in sr.occurrences(rule, tz, anchor, datetime.fromisoformat(after), n)
    ]


# ============================================================
# 契约 §2：星期编号双向转换（唯一最容易错的地方，双向全表锁死）
# ============================================================

class TestWeekdayConversion:
    # (契约口径, Python 口径)：0=周日↔6 / 1=周一↔0 / … / 6=周六↔5
    TABLE = [(0, 6), (1, 0), (2, 1), (3, 2), (4, 3), (5, 4), (6, 5)]

    @pytest.mark.parametrize("rule_w,py_w", TABLE)
    def test_rule_to_py(self, rule_w, py_w):
        assert sr.rule_to_py(rule_w) == py_w

    @pytest.mark.parametrize("rule_w,py_w", TABLE)
    def test_py_to_rule(self, rule_w, py_w):
        assert sr.py_to_rule(py_w) == rule_w

    @pytest.mark.parametrize("w", range(7))
    def test_round_trip(self, w):
        assert sr.py_to_rule(sr.rule_to_py(w)) == w
        assert sr.rule_to_py(sr.py_to_rule(w)) == w

    def test_semantic_pin(self):
        """语义锚：契约 1=周一（Python 0），契约 0=周日（Python 6）——数字别名防呆。"""
        monday = datetime(2026, 7, 6)  # 2026-07-06 是周一
        assert monday.weekday() == 0
        assert sr.py_to_rule(monday.weekday()) == 1


# ============================================================
# 契约 §1：parse_rule / parse_anchor 深校验
# ============================================================

class TestParseRule:
    def test_valid_full_shape(self):
        r = _rule(freq="weekly", weekdays=[4, 2, 2])
        assert r.freq == "weekly"
        assert r.weekdays == (2, 4)  # 去重 + 排序

    @pytest.mark.parametrize("key", [
        "freq", "interval", "weekdays", "monthMode", "monthDay",
        "ordinal", "weekday", "hour", "minute", "clamp",
    ])
    def test_rejects_missing_key(self, key):
        data = {
            "freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
            "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0, "clamp": False,
        }
        del data[key]
        with pytest.raises(sr.ScheduleRuleError, match="missing"):
            sr.parse_rule(data)

    def test_rejects_unknown_key(self):
        with pytest.raises(sr.ScheduleRuleError, match="unknown"):
            _rule(junk=1)

    @pytest.mark.parametrize("bad", [
        {"freq": "hourly"},
        {"interval": 0},
        {"interval": True},          # bool 混进整型字段
        {"interval": "2"},
        {"weekdays": [7]},
        {"weekdays": [-1]},
        {"weekdays": [True]},
        {"weekdays": "12"},
        {"freq": "weekly", "weekdays": []},   # weekly 至少一个 weekday
        {"monthMode": "day"},
        {"monthDay": 0},
        {"monthDay": 32},
        {"ordinal": 5},
        {"ordinal": "LAST"},
        {"ordinal": True},           # True == 1 陷阱：bool 仍拒
        {"weekday": 7},
        {"hour": 24},
        {"minute": 60},
        {"clamp": "false"},
        {"clamp": 0},
    ])
    def test_rejects_bad_values(self, bad):
        with pytest.raises(sr.ScheduleRuleError):
            _rule(**bad)

    def test_rejects_non_object(self):
        for v in (None, "", "[]", 42, [1]):
            with pytest.raises(sr.ScheduleRuleError):
                sr.parse_rule(v)


class TestParseAnchor:
    def test_valid(self):
        assert sr.parse_anchor("2026-07-24").isoformat() == "2026-07-24"

    @pytest.mark.parametrize("bad", [None, "", "20260724", "2026-7-4", "2026-13-01",
                                     "2026-02-30", "2026-07-24T00:00:00", 20260724])
    def test_rejects(self, bad):
        with pytest.raises(sr.ScheduleRuleError):
            sr.parse_anchor(bad)


# ============================================================
# 契约 §3.3 手写断言 —— case 10: DST 春季（LA 2026-03-08 02:00→03:00）
# ============================================================

class TestDstSpringForwardHandWritten:
    def test_local_9am_stays_9am_offset_changes(self):
        # 「每天 9:00」跨春季前跳恒为本地 9:00；UTC 偏移 -08 → -07（墙钟语义，非 UTC 等距）。
        assert _occ(_rule(), _LA, "2026-03-05", "2026-03-06T00:00:00-08:00") == [
            "2026-03-06T09:00:00-08:00",
            "2026-03-07T09:00:00-08:00",
            "2026-03-08T09:00:00-07:00",   # 切换日：偏移变了，墙钟没变
            "2026-03-09T09:00:00-07:00",
            "2026-03-10T09:00:00-07:00",
        ]

    def test_utc_gap_is_23_hours_across_transition(self):
        # 墙钟等距 = UTC 上 03-07 09:00-08 → 03-08 09:00-07 只隔 23 小时（春季少一小时）。
        # ⚠️ 同 tzinfo 的 aware 相减是墙钟差（PEP 495 intra-zone）→ 先转 UTC 再减。
        from datetime import timezone as _tz

        occs = sr.occurrences(
            _rule(), _LA, "2026-03-05", datetime.fromisoformat("2026-03-07T00:00:00-08:00"), 2
        )
        delta = occs[1].astimezone(_tz.utc) - occs[0].astimezone(_tz.utc)
        assert delta.total_seconds() == 23 * 3600


# ============================================================
# 契约 §3.3 手写断言 —— case 11: DST 秋季（LA 2026-11-01 02:00→01:00）
# ============================================================

class TestDstFallBackHandWritten:
    def test_local_9am_stays_9am_offset_changes(self):
        assert _occ(_rule(), _LA, "2026-10-30", "2026-10-31T00:00:00-07:00") == [
            "2026-10-31T09:00:00-07:00",
            "2026-11-01T09:00:00-08:00",   # 切换日：-07 → -08
            "2026-11-02T09:00:00-08:00",
            "2026-11-03T09:00:00-08:00",
            "2026-11-04T09:00:00-08:00",
        ]

    def test_repeated_wall_clock_takes_fold0_earlier(self):
        # 01:30 在 2026-11-01 出现两次（PDT -07 / PST -08）；契约取 fold=0 = 较早（-07:00）。
        occs = _occ(_rule(hour=1, minute=30), _LA, "2026-10-31", "2026-10-31T12:00:00-07:00", 1)
        assert occs == ["2026-11-01T01:30:00-07:00"]


# ============================================================
# 契约 §3.3 手写断言 —— case 12: DST 空洞（02:30 于 2026-03-08 不存在）
# ============================================================

class TestDstGapHandWritten:
    def test_nonexistent_wall_clock_pushed_to_first_existing_instant(self):
        # 空洞 [02:00, 03:00) → 向后推到该日首个存在的瞬间 = transition 点 03:00-07:00
        #（不是 fold 技巧给出的 03:30）。
        assert _occ(_rule(hour=2, minute=30), _LA, "2026-03-06", "2026-03-07T00:00:00-08:00") == [
            "2026-03-07T02:30:00-08:00",
            "2026-03-08T03:00:00-07:00",   # 被推到的落点
            "2026-03-09T02:30:00-07:00",
            "2026-03-10T02:30:00-07:00",
            "2026-03-11T02:30:00-07:00",
        ]


# ============================================================
# 契约 §4 手写断言 —— case 13: 迁移星期编号（锁死 Python 0=周一 → 契约 1）
# ============================================================

class TestLegacyMigrationHandWritten:
    def test_weekly_python_monday_maps_to_contract_1_and_fires_on_mondays(self):
        rules = sr.rules_from_legacy_schedule({"cadence": "weekly", "hours": [9], "weekday": 0})
        assert len(rules) == 1
        assert rules[0].weekdays == (1,)   # 契约口径周一；透传 0 会变成周日 → 本断言测红
        occs = sr.occurrences(
            rules[0], _SH, "2026-07-01", datetime.fromisoformat("2026-07-05T00:00:00+08:00"), 5
        )
        assert [d.isoformat() for d in occs] == [
            "2026-07-06T09:00:00+08:00",   # 全是周一 09:00
            "2026-07-13T09:00:00+08:00",
            "2026-07-20T09:00:00+08:00",
            "2026-07-27T09:00:00+08:00",
            "2026-08-03T09:00:00+08:00",
        ]
        assert all(d.weekday() == 0 for d in occs)  # Python 口径周一

    def test_weekly_python_sunday_wraps_to_contract_0(self):
        rules = sr.rules_from_legacy_schedule({"cadence": "weekly", "hours": [9], "weekday": 6})
        assert rules[0].weekdays == (0,)   # Python 6=周日 → 契约 0=周日（回绕）

    def test_daily_and_monthly_mapping(self):
        d = sr.rules_from_legacy_schedule({"cadence": "daily", "hours": [9]})
        assert [(r.freq, r.hour, r.minute, r.interval) for r in d] == [("daily", 9, 0, 1)]
        m = sr.rules_from_legacy_schedule({"cadence": "monthly", "hours": [9], "day_of_month": 28})
        assert [(r.freq, r.month_day, r.clamp) for r in m] == [("monthly", 28, False)]

    def test_multi_hours_preserved_and_sanitized(self):
        rules = sr.rules_from_legacy_schedule({"cadence": "daily", "hours": [9, "18", 99, 9]})
        assert sorted(r.hour for r in rules) == [9, 18]   # 滤非法 / 去重，多 hour 不丢
        assert [r.hour for r in sr.rules_from_legacy_schedule({"cadence": "daily"})] == [9]

    def test_out_of_range_legacy_never_fires_maps_to_empty(self):
        # 老 worker 对越界 weekday/day_of_month 是「恒不 fire」（now.day==32 恒 False）→
        # 映射为空列表保持等价。
        assert sr.rules_from_legacy_schedule({"cadence": "weekly", "weekday": 7}) == []
        assert sr.rules_from_legacy_schedule({"cadence": "monthly", "day_of_month": 32}) == []
        assert sr.rules_from_legacy_schedule({"cadence": "monthly", "day_of_month": -5}) == []

    def test_falsy_legacy_values_keep_or_default_semantics(self):
        # 老 worker 是 `int(sched.get("day_of_month", 1) or 1)` —— 0/None/"" 经 `or` 落默认
        # （day_of_month 0 → 1 号 fire、weekday "" → 周一），不是「恒不 fire」；逐字保留。
        m = sr.rules_from_legacy_schedule({"cadence": "monthly", "day_of_month": 0})
        assert [r.month_day for r in m] == [1]
        w = sr.rules_from_legacy_schedule({"cadence": "weekly", "weekday": ""})
        assert [r.weekdays for r in w] == [(1,)]

    def test_unknown_cadence_falls_back_to_daily(self):
        # store.DEFAULT_CADENCE 同款语义：解析不出 cadence → daily。
        assert sr.rules_from_legacy_schedule({})[0].freq == "daily"
        assert sr.rules_from_legacy_schedule({"cadence": "yearly"})[0].freq == "daily"


# ============================================================
# anchor 相位（interval>1 重启不漂）
# ============================================================

class TestAnchorPhase:
    RULE = dict(freq="weekly", interval=2, weekdays=[1])  # 每 2 周周一
    LATTICE = ["2026-07-06", "2026-07-20", "2026-08-03", "2026-08-17", "2026-08-31",
               "2026-09-14", "2026-09-28", "2026-10-12", "2026-10-26",
               "2026-11-09", "2026-11-23"]  # anchor 2026-07-06（周一）定义的格点

    def test_occurrences_stay_on_anchor_lattice_regardless_of_when_computed(self):
        """「重启 / 改配置后从任意时刻重算」都落在同一格点 —— 相位由 anchor 而非 now 决定
        （上游组件 computeRuns 从 now 起算的缺陷正是契约加 anchor 要修的）。"""
        rule = _rule(**self.RULE)
        for after in ("2026-07-07T00:00:00+08:00",   # 首格点后一天
                      "2026-07-21T12:00:00+08:00",   # 跳过两个格点后
                      "2026-08-30T23:59:00+08:00"):  # 更晚
            occs = _occ(rule, _SH, "2026-07-06", after)
            assert all(o[:10] in self.LATTICE for o in occs), (after, occs)

    def test_anchor_shift_flips_phase(self):
        rule = _rule(**self.RULE)
        base = _occ(rule, _SH, "2026-07-06", "2026-07-14T00:00:00+08:00")
        shifted = _occ(rule, _SH, "2026-07-13", "2026-07-14T00:00:00+08:00")
        assert base[0] == "2026-07-20T09:00:00+08:00"
        assert shifted[0] == "2026-07-27T09:00:00+08:00"   # 相位翻转一周
        assert not set(base) & set(shifted)

    def test_interval1_anchor_is_irrelevant(self):
        # 契约 §4：interval=1 时 anchor 对结果无影响（迁移行随便填的依据）。
        rule = _rule(freq="weekly", weekdays=[1])
        a = _occ(rule, _SH, "2026-01-01", "2026-07-07T00:00:00+08:00")
        b = _occ(rule, _SH, "2026-06-30", "2026-07-07T00:00:00+08:00")
        assert a == b

    def test_monthly_interval_respected(self):
        # 契约 §5 case 9：上游 monthly 分支忽略 interval 是缺陷，我们修——隔月触发。
        occs = _occ(_rule(freq="monthly", interval=2, monthDay=15), _SH,
                    "2026-01-10", "2026-01-01T00:00:00+08:00")
        assert [o[:10] for o in occs] == [
            "2026-01-15", "2026-03-15", "2026-05-15", "2026-07-15", "2026-09-15"]


# ============================================================
# prev_occurrence（worker fire 判定用）
# ============================================================

class TestPrevOccurrence:
    def _prev(self, rule, tz, anchor, before):
        occ = sr.prev_occurrence(rule, tz, anchor, datetime.fromisoformat(before))
        return None if occ is None else occ.isoformat()

    def test_basic_and_inclusive(self):
        r = _rule()
        assert self._prev(r, _SH, "2026-07-01", "2026-07-03T09:10:00+08:00") \
            == "2026-07-03T09:00:00+08:00"
        # <= before（含恰好落点）：worker 语义「occurrence 落在 (marker, now]」。
        assert self._prev(r, _SH, "2026-07-01", "2026-07-03T09:00:00+08:00") \
            == "2026-07-03T09:00:00+08:00"
        assert self._prev(r, _SH, "2026-07-01", "2026-07-03T08:59:00+08:00") \
            == "2026-07-02T09:00:00+08:00"

    def test_none_before_anchor(self):
        # anchor 之前无 occurrence（首个 fire 点还没到）。
        assert self._prev(_rule(), _SH, "2026-07-01", "2026-06-30T23:00:00+08:00") is None
        assert self._prev(_rule(), _SH, "2026-07-01", "2026-07-01T08:59:00+08:00") is None

    def test_interval_phase(self):
        r = _rule(freq="weekly", interval=2, weekdays=[1])
        # off-week 周一（2026-07-13 不在 anchor=07-06 的偶数周格点）→ prev 是 07-06。
        assert self._prev(r, _SH, "2026-07-06", "2026-07-13T09:10:00+08:00") \
            == "2026-07-06T09:00:00+08:00"
        assert self._prev(r, _SH, "2026-07-06", "2026-07-20T09:10:00+08:00") \
            == "2026-07-20T09:00:00+08:00"

    def test_clamp_branch(self):
        r = _rule(freq="monthly", monthDay=31, clamp=True)
        # 2 月被夹到 28 日（2026 非闰）。
        assert self._prev(r, _SH, "2026-01-01", "2026-03-01T00:00:00+08:00") \
            == "2026-02-28T09:00:00+08:00"
        r2 = _rule(freq="monthly", monthDay=31, clamp=False)
        # skip 语义：2 月无 31 → prev 停在 1 月 31。
        assert self._prev(r2, _SH, "2026-01-01", "2026-03-01T00:00:00+08:00") \
            == "2026-01-31T09:00:00+08:00"

    def test_requires_aware_datetime(self):
        with pytest.raises(sr.ScheduleRuleError, match="aware"):
            sr.prev_occurrence(_rule(), _SH, "2026-07-01", datetime(2026, 7, 3, 9, 0))

    def test_rejects_bad_timezone(self):
        with pytest.raises(sr.ScheduleRuleError, match="timezone"):
            sr.prev_occurrence(
                _rule(), "Mars/Olympus", "2026-07-01",
                datetime.fromisoformat("2026-07-03T09:00:00+08:00"),
            )
