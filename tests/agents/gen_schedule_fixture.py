"""黄金 fixture 生成器：``tests/fixtures/schedule_occurrences.json``（契约 §5）。

跨语言 occurrence 对齐 fixture 的**唯一来源**：Python 求值器（``src/agents/schedule_rule``）
生成，前端 schedule-builder 预览逐条比对。改契约语义后重新生成：

    venv/bin/python -m tests.agents.gen_schedule_fixture

⚠️ fixture 只锁「两侧一致」；case 10-13（DST 春/秋/空洞/迁移星期编号）的**正确性**由
``tests/agents/test_schedule_rule.py`` 的手写断言另行锁死（契约 §5 明确要求，不能只靠
「生成什么就断言什么」）。``tests/agents/test_schedule_fixture.py`` 则校验本文件定义与
落盘 fixture、求值器输出三者一致（防止改了定义忘了重新生成）。
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from src.agents import schedule_rule as sr

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "schedule_occurrences.json"

_OCCURRENCE_COUNT = 5


def _rule(**over: Any) -> Dict[str, Any]:
    """契约 §1 wire 形状（camelCase、10 键全量）；按需覆写。"""
    base: Dict[str, Any] = {
        "freq": "daily",
        "interval": 1,
        "weekdays": [],
        "monthMode": "date",
        "monthDay": 1,
        "ordinal": 1,
        "weekday": 0,
        "hour": 9,
        "minute": 0,
        "clamp": False,
    }
    base.update(over)
    return base


# 契约 §5 的 14 个必覆盖 case（case 2 / 4 各含 anchor 移位对照 → 16 条）。
# expected 由求值器生成；case 10-13 的正确性另有手写断言（见模块 docstring）。
CASES: List[Dict[str, Any]] = [
    {   # case 1: daily interval=1 基线
        "id": "daily-interval1-baseline",
        "case": 1,
        "rule": _rule(),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-07-01",
        "after": "2026-07-01T10:00:00+08:00",
    },
    {   # case 2: daily interval=3 —— 相位以 anchor 为准
        "id": "daily-interval3-anchor-phase",
        "case": 2,
        "rule": _rule(interval=3),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-07-01",
        "after": "2026-07-02T00:00:00+08:00",
    },
    {   # case 2b: 同 rule、anchor 差一天 → expected 必须不同（锁 anchor 生效）
        "id": "daily-interval3-anchor-shifted",
        "case": 2,
        "rule": _rule(interval=3),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-07-02",
        "after": "2026-07-02T00:00:00+08:00",
    },
    {   # case 3: weekly interval=1 多 weekday（周二+周四）
        "id": "weekly-multi-weekday",
        "case": 3,
        "rule": _rule(freq="weekly", weekdays=[2, 4]),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-07-01",
        "after": "2026-07-01T00:00:00+08:00",
    },
    {   # case 4: weekly interval=2 —— WKST=SU 相位（weekdays=[0]=周日 + anchor 周一，
        # 若实现误用 RFC 默认 WKST=MO 会整周错位 → 本条直接测红）
        "id": "weekly-interval2-wkst-phase",
        "case": 4,
        "rule": _rule(freq="weekly", interval=2, weekdays=[0]),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-07-06",
        "after": "2026-07-07T00:00:00+08:00",
    },
    {   # case 4b: anchor 移一周 → 相位翻转
        "id": "weekly-interval2-anchor-shifted",
        "case": 4,
        "rule": _rule(freq="weekly", interval=2, weekdays=[0]),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-07-13",
        "after": "2026-07-07T00:00:00+08:00",
    },
    {   # case 5: monthly day=31 clamp=false —— 2/4/6 月被跳过（RRULE 语义）
        "id": "monthly-day31-skip",
        "case": 5,
        "rule": _rule(freq="monthly", monthDay=31),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-01-01",
        "after": "2026-01-01T00:00:00+08:00",
    },
    {   # case 6: monthly day=31 clamp=true —— 2 月落 28 日（2026 非闰）
        "id": "monthly-day31-clamp",
        "case": 6,
        "rule": _rule(freq="monthly", monthDay=31, clamp=True),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-01-01",
        "after": "2026-01-01T00:00:00+08:00",
    },
    {   # case 7: 每月第 2 个周二
        "id": "monthly-nth-2nd-tuesday",
        "case": 7,
        "rule": _rule(freq="monthly", monthMode="nth", ordinal=2, weekday=2),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-01-01",
        "after": "2026-01-01T00:00:00+08:00",
    },
    {   # case 8: 每月最后一个周五
        "id": "monthly-nth-last-friday",
        "case": 8,
        "rule": _rule(freq="monthly", monthMode="nth", ordinal="last", weekday=5),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-01-01",
        "after": "2026-01-01T00:00:00+08:00",
    },
    {   # case 9: monthly interval=2 —— 上游组件 monthly 分支忽略 interval（上游缺陷），
        # 契约拍板修正：相位以 anchor 月为原点隔月触发
        "id": "monthly-interval2-phase",
        "case": 9,
        "rule": _rule(freq="monthly", interval=2, monthDay=15),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-01-10",
        "after": "2026-01-01T00:00:00+08:00",
    },
    {   # case 10: DST 春季（LA 2026-03-08 02:00→03:00）—— 恒本地 9:00，UTC 偏移 -08→-07
        "id": "dst-spring-forward-la",
        "case": 10,
        "rule": _rule(),
        "timezone": "America/Los_Angeles",
        "anchor": "2026-03-05",
        "after": "2026-03-06T00:00:00-08:00",
    },
    {   # case 11: DST 秋季（LA 2026-11-01 02:00→01:00）—— 恒本地 9:00，偏移 -07→-08
        "id": "dst-fall-back-la",
        "case": 11,
        "rule": _rule(),
        "timezone": "America/Los_Angeles",
        "anchor": "2026-10-30",
        "after": "2026-10-31T00:00:00-07:00",
    },
    {   # case 12: DST 空洞（02:30 在 2026-03-08 不存在）→ 向后推到首个存在瞬间 03:00-07:00
        "id": "dst-gap-0230-la",
        "case": 12,
        "rule": _rule(hour=2, minute=30),
        "timezone": "America/Los_Angeles",
        "anchor": "2026-03-06",
        "after": "2026-03-07T00:00:00-08:00",
    },
    {   # case 13: 迁移等价 —— 老 weekly weekday=0（Python 口径=周一）映射后必须全落周一
        # 09:00（锁死星期编号转换 0→1）。legacy 键给 Python 侧验映射函数；前端只读 rule。
        "id": "legacy-weekly-monday-mapping",
        "case": 13,
        "legacy": {"cadence": "weekly", "hours": [9], "weekday": 0},
        "rule": _rule(freq="weekly", weekdays=[1]),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-07-01",
        "after": "2026-07-05T00:00:00+08:00",
    },
    {   # case 14: 无 DST 时区不被 DST 特殊逻辑污染（时段刻意横跨美区 DST 切换日）
        "id": "no-dst-shanghai",
        "case": 14,
        "rule": _rule(),
        "timezone": "Asia/Shanghai",
        "anchor": "2026-03-06",
        "after": "2026-03-06T12:00:00+08:00",
    },
]


def compute_expected(case: Dict[str, Any]) -> List[str]:
    rule = sr.parse_rule(case["rule"])
    occs = sr.occurrences(
        rule,
        case["timezone"],
        case["anchor"],
        datetime.fromisoformat(case["after"]),
        _OCCURRENCE_COUNT,
    )
    return [d.isoformat() for d in occs]


def build_fixture() -> Dict[str, Any]:
    cases = []
    for case in CASES:
        if "legacy" in case:
            # 迁移映射自洽性：legacy → rule 的映射必须与 fixture 里写死的 rule 一致。
            mapped = sr.rules_from_legacy_schedule(case["legacy"])
            assert len(mapped) == 1 and mapped[0] == sr.parse_rule(case["rule"]), (
                f"legacy mapping drifted for {case['id']}: {mapped}"
            )
        cases.append({**case, "expected": compute_expected(case)})
    return {
        "note": (
            "跨语言 occurrence 对齐 fixture（契约 schedule-contract.md §5）。"
            "Python 求值器（src/agents/schedule_rule.py）与前端 schedule-builder 预览"
            "都必须逐条通过。由 tests/agents/gen_schedule_fixture.py 生成，勿手改。"
        ),
        "occurrences_per_case": _OCCURRENCE_COUNT,
        "cases": cases,
    }


def main() -> None:
    FIXTURE_PATH.write_text(
        json.dumps(build_fixture(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {FIXTURE_PATH} ({len(CASES)} entries)")


if __name__ == "__main__":
    main()
