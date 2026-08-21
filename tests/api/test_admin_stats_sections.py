"""GET /api/admin/stats 的 outbox / v4_rollout 两段 + GET /api/llm/stats 的 by_model。

task 08-20-perf-dashboards：桌面看板从 fork CLI 改走本机 serve-api 取这两份数据，
所以**这两段必须在**——少一段就是看板上少一块卡（而不是「数字不准」这种显眼故障）。

组装体单源 ``src.services.admin_stats``（CLI 的 ``_build_outbox_section`` /
``_build_v4_rollout_section`` 现在也只是转发），故这里测的是「router 把它接上了」+
「读端点仍然不建表」（C6）。
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from src.api.deps import get_repository
from src.repository import AttachmentStore, EmailRepository

_OUTBOX_DDL = """
CREATE TABLE email_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    internal_id INTEGER,
    target TEXT NOT NULL,
    op TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at REAL,
    last_error TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE v4_rollout_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flushed_at REAL NOT NULL,
    from_sqlite_hit INTEGER NOT NULL DEFAULT 0,
    fallback_miss INTEGER NOT NULL DEFAULT 0,
    fallback_error INTEGER NOT NULL DEFAULT 0,
    route_latency_p99_ms REAL NOT NULL DEFAULT 0,
    body_miss_internal_ids TEXT,
    window_seconds INTEGER NOT NULL DEFAULT 60
);
"""


@pytest.fixture()
def queue_client(client, tmp_path: Path):
    """指向一个只有 outbox / v4 两张表的私有 DB 的 client。

    sync_store 段在这个库上会汇成 0（email_metadata 不存在）——那不是本文件的被测对象。
    """
    from src.api.app import app

    db = tmp_path / "queues.db"
    conn = sqlite3.connect(str(db))
    try:
        conn.executescript(_OUTBOX_DDL)
        now = time.time()
        rows = [
            # pending: 一条刚进队列、一条卡了 45 分钟（age_buckets 的两端）
            (1, "notion", "flag", "pending", now - 5, now - 5),
            (2, "mailapp", "flag", "pending", now - 2700, now - 2700),
            (3, "notion", "flag", "failed", now - 100, now - 100),
            (4, "mailapp", "flag", "done", now - 500, now - 500),
        ]
        conn.executemany(
            "INSERT INTO email_outbox "
            "(internal_id, target, op, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
        # 两个小时桶 → trend 至少两个点（一个点画不出趋势, 前端会说「快照不够」）
        conn.executemany(
            "INSERT INTO v4_rollout_stats (flushed_at, from_sqlite_hit, fallback_miss, "
            "fallback_error, route_latency_p99_ms, body_miss_internal_ids, window_seconds) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (now - 3700, 90, 10, 0, 30.0, "[1]", 60),
                (now - 60, 100, 0, 0, 12.5, None, 60),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    repo = EmailRepository(
        db_path=str(db),
        attachment_store=AttachmentStore(base_dir=str(tmp_path / "att")),
    )
    app.dependency_overrides[get_repository] = lambda: repo
    yield client
    app.dependency_overrides.pop(get_repository, None)


def test_admin_stats_returns_outbox_section(queue_client):
    r = queue_client.get("/api/admin/stats")
    assert r.status_code == 200
    outbox = r.json()["data"]["outbox"]
    assert outbox["_source"] == "live_query"
    assert outbox["total"] == 4
    assert outbox["by_status"] == {"pending": 2, "failed": 1, "done": 1}
    # by_target 只数 pending/processing/failed —— done 的那条 mailapp 不该混进来。
    assert outbox["by_target"] == {"notion": 2, "mailapp": 1}
    # 🔴 年龄档只统计 pending：一条 <1min、一条 >30min。
    assert outbox["age_buckets"]["lt_1m"] == 1
    assert outbox["age_buckets"]["gt_30m"] == 1
    assert outbox["age_buckets"]["lt_5m"] == 0


def test_admin_stats_returns_v4_section_with_trend(queue_client):
    r = queue_client.get("/api/admin/stats")
    assert r.status_code == 200
    v4 = r.json()["data"]["v4_rollout"]
    assert v4["_source"] == "stats_reporter_last_snapshot"
    # 快照 = 最新一条（12.5ms 那条），不是两条的合计。
    assert v4["route_latency_p99_ms"] == pytest.approx(12.5)
    assert v4["from_sqlite_hit"] == 100
    assert v4["_staleness_seconds"] is not None

    trend = v4["trend"]
    assert len(trend) == 2, "两个小时桶应各出一个点"
    assert trend[0]["bucket_start"] < trend[1]["bucket_start"], "按时间升序"
    # 老桶 90 hit + 10 miss = 10% 回落；新桶全命中 = 0%。
    assert trend[0]["fallback_pct"] == pytest.approx(10.0)
    assert trend[1]["fallback_pct"] == pytest.approx(0.0)
    assert trend[0]["p99_ms"] == pytest.approx(30.0)


def test_admin_stats_sections_degrade_without_tables(client, tmp_path: Path):
    """表不存在（trimmed 库）→ 结构化占位，不抛也不建表。

    C6 的延伸：新加的两段跟 sync_store 段一样只跑 SELECT。整份 stats 不能因为
    某个队列表缺失就 500 —— 那会让整个看板白屏。
    """
    from src.api.app import app

    db = tmp_path / "bare2.db"
    sqlite3.connect(str(db)).close()
    repo = EmailRepository(
        db_path=str(db),
        attachment_store=AttachmentStore(base_dir=str(tmp_path / "att")),
    )
    app.dependency_overrides[get_repository] = lambda: repo
    try:
        r = client.get("/api/admin/stats")
    finally:
        app.dependency_overrides.pop(get_repository, None)

    assert r.status_code == 200
    data = r.json()["data"]
    assert data["v4_rollout"]["_source"] == "no_data_yet"
    assert data["outbox"]["_source"] == "error"
    assert "no such table" in data["outbox"]["_error"]

    # 决定性断言：读端点没有 materialise 任何 schema。
    conn = sqlite3.connect(str(db))
    try:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    finally:
        conn.close()
    assert tables == set()


# ---------------------------------------------------------------------------
# GET /api/llm/stats — by_model
# ---------------------------------------------------------------------------

_LLM_DDL = """
CREATE TABLE llm_processing (
    internal_id INTEGER PRIMARY KEY,
    notion_page_id TEXT,
    mailbox TEXT,
    status TEXT,
    retry_count INTEGER DEFAULT 0,
    next_retry_at REAL,
    last_error TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    latency_ms INTEGER,
    labels_json TEXT,
    created_at REAL,
    updated_at REAL
);
"""


@pytest.fixture()
def llm_client(client, tmp_path: Path):
    from src.api.app import app

    db = tmp_path / "llm.db"
    conn = sqlite3.connect(str(db))
    try:
        conn.executescript(_LLM_DDL)
        now = time.time()
        conn.executemany(
            "INSERT INTO llm_processing (internal_id, status, model, input_tokens, "
            "output_tokens, cache_read_input_tokens, cache_creation_input_tokens, "
            "latency_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (1, "success", "haiku", 100, 10, 0, 0, 500, now, now),
                (2, "success", "haiku", 200, 20, 50, 0, 700, now, now),
                (3, "success", "sonnet", 1000, 100, 0, 0, 2000, now, now),
                # 老行没记 model → 不该被丢掉
                (4, "success", None, 5, 1, 0, 0, 100, now, now),
                # 失败行不进成本口径（与全表 rollup 同一条判据）
                (5, "failed", "sonnet", 9999, 9999, 0, 0, 100, now, now),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    repo = EmailRepository(
        db_path=str(db),
        attachment_store=AttachmentStore(base_dir=str(tmp_path / "att")),
    )
    app.dependency_overrides[get_repository] = lambda: repo
    yield client
    app.dependency_overrides.pop(get_repository, None)


def test_llm_stats_by_model_split(llm_client):
    r = llm_client.get("/api/llm/stats?days=7")
    assert r.status_code == 200
    by_model = r.json()["data"]["by_model"]

    # tokens 降序：sonnet(1100) > haiku(330) > (unknown)(6)
    assert [m["model"] for m in by_model] == ["sonnet", "haiku", "(unknown)"]

    haiku = next(m for m in by_model if m["model"] == "haiku")
    assert haiku["rows"] == 2
    assert haiku["input_tokens"] == 300
    assert haiku["output_tokens"] == 30
    assert haiku["cache_read_input_tokens"] == 50
    assert haiku["avg_latency_ms"] == 600

    sonnet = next(m for m in by_model if m["model"] == "sonnet")
    # 🔴 那条 status='failed' 的 9999 token 行不该混进来（成本 = 成功调用的成本）。
    assert sonnet["rows"] == 1
    assert sonnet["input_tokens"] == 1000

    # 拆分的合计必须等于全表 rollup —— 两个数并排摆在看板上，对不上就是谎报。
    cost = r.json()["data"]["cost"]
    assert sum(m["input_tokens"] for m in by_model) == cost["input_tokens"]
    assert sum(m["output_tokens"] for m in by_model) == cost["output_tokens"]
    assert sum(m["rows"] for m in by_model) == cost["success_rows"]
