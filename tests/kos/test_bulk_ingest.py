"""Tests for src.kos.bulk_ingest 的 priority / require_labeled 过滤门。

issue #49: `_normalize_priority(None) -> "normal"` 把「AI 从未标注」和「AI 判定
normal」当成同一件事, `--priority-floor normal` 于是把从未跑过 LLM 的历史邮件
全部当 normal 放行 (实测占候选量 ~89%)。`--require-labeled` / KOS_REQUIRE_LABELED
把「未标注」变成显式第三态。

本文件只覆盖 run() 的过滤分支 + 统计口径 —— 网络推送 (`_push_one`) 全程 dry_run,
不碰 KOSClient。bulk_ingest 此前零测试覆盖, 这是第一份。
"""

from __future__ import annotations

import sqlite3
from unittest.mock import MagicMock

import pytest

from src.kos.bulk_ingest import KOSBulkIngester


def _seed_db(path: str, rows: list[tuple[int, str | None]]) -> None:
    """rows = [(internal_id, priority | None)]；None = llm_processing 无行 (未标注)。"""
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE email_metadata (internal_id INTEGER PRIMARY KEY, sync_status TEXT)")
    conn.execute("CREATE TABLE llm_processing (internal_id INTEGER PRIMARY KEY, labels_json TEXT)")
    for iid, priority in rows:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, sync_status) VALUES (?, 'synced')", (iid,)
        )
        if priority is not None:
            conn.execute(
                "INSERT INTO llm_processing (internal_id, labels_json) VALUES (?, ?)",
                (iid, f'{{"priority": "{priority}"}}'),
            )
    conn.commit()
    conn.close()


@pytest.fixture
def ingester(tmp_path):
    """工厂: (rows, **kwargs) -> KOSBulkIngester，_build_one 打桩成恒成功。"""

    def _make(rows, **kwargs):
        db = str(tmp_path / "t.db")
        _seed_db(db, rows)
        ing = KOSBulkIngester(db_path=db, client=MagicMock(), **kwargs)
        ing._build_one = lambda iid: (f"sources/email/{iid}", "content")  # type: ignore[method-assign]
        return ing

    return _make


# 3 封已标注 (critical / normal / low) + 2 封从未标注
_ROWS = [(1, "critical"), (2, "normal"), (3, "low"), (4, None), (5, None)]


def test_default_off_lets_unlabeled_through_as_normal(ingester):
    """现状行为 (向后兼容闸): floor=normal 时未标注按 normal 放行。

    5 封里只有 low 那封被挡 → pushed=4, 其中 2 封是从未标注的。
    """
    stats = ingester(_ROWS, priority_floor="normal").run(dry_run=True, verify_canary=False)
    assert stats["pushed"] == 4
    assert stats["skipped_low_priority"] == 1
    assert stats["skipped_unlabeled"] == 0


def test_require_labeled_blocks_unlabeled(ingester):
    """issue #49 主诉: 未标注被挡进独立计数, 不再混进 skipped_low_priority。"""
    stats = ingester(_ROWS, priority_floor="normal", require_labeled=True).run(
        dry_run=True, verify_canary=False
    )
    assert stats["pushed"] == 2  # critical + normal
    assert stats["skipped_low_priority"] == 1  # low
    assert stats["skipped_unlabeled"] == 2


def test_require_labeled_independent_of_floor(ingester):
    """floor='low' (= 不按优先级过滤) 时 gate 仍生效, 否则形同虚设。"""
    stats = ingester(_ROWS, priority_floor="low", require_labeled=True).run(
        dry_run=True, verify_canary=False
    )
    assert stats["pushed"] == 3  # 三封已标注全过
    assert stats["skipped_unlabeled"] == 2


def test_no_gate_at_all_pushes_everything(ingester):
    """floor='low' + require_labeled=False = 原全量行为。"""
    stats = ingester(_ROWS, priority_floor="low").run(dry_run=True, verify_canary=False)
    assert stats["pushed"] == 5
    assert stats["skipped_low_priority"] == 0
    assert stats["skipped_unlabeled"] == 0


def test_limit_counts_pushed_not_candidates_under_gate(ingester):
    """gate 生效 + 带 limit 时, limit 作用在实际 ingest 数。

    未标注的不计入 limit —— 否则分批会被大批未标注邮件卡死 (同 floor 的既有约束)。
    """
    stats = ingester(_ROWS, priority_floor="low", require_labeled=True).run(
        limit=2, dry_run=True, verify_canary=False
    )
    assert stats["pushed"] == 2
