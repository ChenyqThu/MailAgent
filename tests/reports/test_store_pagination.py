"""ReportStore 分页 —— task 07-21：list_reports(offset) + count_reports(total)。

独立文件（不并入 test_reports.py）：避免与并行改 data/summarizer/prompts/assembler/worker
的另一 agent 抢同一个大测试文件。只测 store.py 新增/改动的两个方法。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.mail.sync_store import SyncStore
from src.reports.store import ReportStore


@pytest.fixture
def store(tmp_path: Path) -> ReportStore:
    db = tmp_path / "t.db"
    SyncStore(str(db))
    return ReportStore(str(db))


def _seed_reports(store: ReportStore, n: int, *, cadence: str = "daily", agent_id: str = "a") -> None:
    for i in range(n):
        rid = f"{agent_id}:{cadence}:2026-06-{i + 1:02d}"
        store.create_report(
            report_id=rid,
            agent_id=agent_id,
            cadence=cadence,
            report_date=f"2026-06-{i + 1:02d}",
            window_start="s",
            window_end="e",
        )
        store.finish_report(rid, status="ready", headline=f"h{i}")


def test_count_reports_empty_table(store: ReportStore) -> None:
    assert store.count_reports() == 0
    assert store.list_reports() == []


def test_count_reports_matches_list_reports_filters(store: ReportStore) -> None:
    _seed_reports(store, 3, cadence="daily", agent_id="a")
    _seed_reports(store, 2, cadence="weekly", agent_id="a")
    _seed_reports(store, 1, cadence="daily", agent_id="b")

    assert store.count_reports() == 6
    assert store.count_reports(cadence="daily") == 4
    assert store.count_reports(cadence="weekly") == 2
    assert store.count_reports(agent_id="a") == 5
    assert store.count_reports(cadence="daily", agent_id="a") == 3
    assert store.count_reports(cadence="monthly") == 0


def test_list_reports_offset_pagination(store: ReportStore) -> None:
    _seed_reports(store, 5, cadence="daily", agent_id="a")

    total = store.count_reports(cadence="daily")
    assert total == 5

    page1 = store.list_reports(cadence="daily", limit=2, offset=0)
    page2 = store.list_reports(cadence="daily", limit=2, offset=2)
    page3 = store.list_reports(cadence="daily", limit=2, offset=4)
    assert [r["id"] for r in page1] != [r["id"] for r in page2]
    assert len(page1) == 2 and len(page2) == 2 and len(page3) == 1
    # 三页拼起来去重后覆盖全部（report_date/created_at 排序稳定，无重叠/遗漏）。
    all_ids = {r["id"] for r in page1} | {r["id"] for r in page2} | {r["id"] for r in page3}
    assert len(all_ids) == 5


def test_list_reports_offset_out_of_range_returns_empty(store: ReportStore) -> None:
    _seed_reports(store, 2, cadence="daily", agent_id="a")
    assert store.list_reports(cadence="daily", limit=10, offset=100) == []
