"""黄金 fixture parity（契约 §5）：落盘 fixture ↔ Python 求值器逐条一致。

「正确性」由 ``test_schedule_rule.py`` 的手写断言锁（case 10-13）；本文件锁的是
① fixture 文件与求值器当前输出零漂移（改实现忘了重新生成 → 红）；
② 生成器定义（``gen_schedule_fixture.CASES``）与落盘文件同步（改定义忘了跑生成 → 红）；
③ 契约 §5 要求的 14 个 case 一个不缺。
前端侧从同一文件读 parity（frontend/tests 下相对路径上来）。
"""
from __future__ import annotations

import json

import pytest

from src.agents import schedule_rule as sr
from tests.agents.gen_schedule_fixture import CASES, FIXTURE_PATH, build_fixture, compute_expected


@pytest.fixture(scope="module")
def fixture_doc() -> dict:
    assert FIXTURE_PATH.exists(), f"fixture missing: {FIXTURE_PATH} — 跑 gen_schedule_fixture 生成"
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_all_14_contract_cases_present(fixture_doc):
    covered = {c["case"] for c in fixture_doc["cases"]}
    assert covered == set(range(1, 15)), f"契约 §5 case 缺失: {sorted(set(range(1, 15)) - covered)}"
    # case 2 / 4 必须各有 anchor 移位对照（契约原文「再给一条 anchor 差一天/移位版」）。
    for case_no in (2, 4):
        entries = [c for c in fixture_doc["cases"] if c["case"] == case_no]
        assert len(entries) == 2, f"case {case_no} 缺 anchor 移位对照"
        assert entries[0]["expected"] != entries[1]["expected"], (
            f"case {case_no} 两条 expected 相同 —— anchor 没生效"
        )


def test_fixture_matches_evaluator(fixture_doc):
    for case in fixture_doc["cases"]:
        assert case["expected"] == compute_expected(case), f"drift in {case['id']}"


def test_fixture_file_in_sync_with_generator(fixture_doc):
    assert fixture_doc == build_fixture(), (
        "fixture 文件与 gen_schedule_fixture.CASES 不同步 —— "
        "跑 `venv/bin/python -m tests.agents.gen_schedule_fixture` 重新生成"
    )
    assert len(fixture_doc["cases"]) == len(CASES)


def test_legacy_case_mapping_locked(fixture_doc):
    """case 13：fixture 里的 legacy 形状经映射函数必须得到 fixture 里写死的 rule。"""
    legacy_cases = [c for c in fixture_doc["cases"] if "legacy" in c]
    assert legacy_cases, "case 13 缺 legacy 键"
    for case in legacy_cases:
        mapped = sr.rules_from_legacy_schedule(case["legacy"])
        assert len(mapped) == 1
        assert mapped[0] == sr.parse_rule(case["rule"])
