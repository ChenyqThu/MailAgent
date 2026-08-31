"""报告 worker 的执行台账 (`agent_run_log`, task 08-27 P4a run transcript)。

r10 §3.2 的核心发现: agentic 日报的 `ToolLoopResult.tool_calls` 此前只被 logger.info
打一行就丢。这里盯四件事: ① tool_calls **真进步骤表** (trig → 取数 → 逐次工具 → 摘要
→ 装配 → out); ② 空窗口 → skipped; ③ 摘要失败降级 → run 仍 completed + 摘要步骤标
✗ + error 记因; ④ trigger_kind 默认 manual, tick_loop 传 schedule。

🔴 全程 tmp_path 建库 (SyncStore 播种 daily_email_digest)。
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from src.agents.run_log import list_run_logs, list_run_steps
from src.mail.sync_store import SyncStore
from src.reports.store import ReportStore
from src.reports.summarizer import ReportDraft
from src.reports.worker import run_report_once

_BJ = timezone(timedelta(hours=8))
_NOW = datetime(2026, 6, 2, 9, 5, 0, tzinfo=_BJ)


@pytest.fixture
def db(tmp_path: Path) -> Path:
    p = tmp_path / "t.db"
    SyncStore(str(p))  # email_metadata + report_agent(种子 daily_email_digest) + report
    return p


def _seed_email(db: Path, iid: int = 1) -> None:
    import sqlite3

    now = time.time()
    with sqlite3.connect(str(db)) as conn:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, subject, sender, date_received, "
            "mailbox, sync_status, created_at, updated_at) "
            "VALUES (?,?,?,?,'收件箱','synced',?,?)",
            (iid, "S", "a@x.com", (_NOW - timedelta(hours=1)).isoformat(), now, now),
        )
        conn.commit()


def _runs(db: Path):
    return list_run_logs(str(db), agent_id="daily_email_digest")


def _draft(**kw) -> ReportDraft:
    kw.setdefault("headline", "今天 1 封")
    kw.setdefault("overview", "ov")
    kw.setdefault("model", "mk")
    return ReportDraft(**kw)


def test_daily_tool_calls_land_in_step_table(db: Path):
    _seed_email(db)
    store = ReportStore(str(db))

    async def spy(**kw):
        return _draft(
            input_tokens=1000,
            output_tokens=200,
            tool_calls=[
                {"name": "get_email_body", "input": {"internal_id": 1},
                 "output_preview": "正文……", "ms": 300},
                {"name": "search_emails", "input": {"q": "redis"},
                 "output_preview": "error: timeout", "ms": 45},
            ],
        )

    asyncio.run(run_report_once(
        store=store, db_path=str(db),
        agent=store.get_agent("daily_email_digest"), now=_NOW, agentic_fn=spy,
    ))

    rows = _runs(db)
    assert len(rows) == 1
    row = rows[0]
    assert row["status"] == "completed"
    assert row["trigger_kind"] == "manual"  # 非 tick_loop 调用面的默认档
    assert row["model"] == "mk"
    assert row["input_tokens"] == 1000 and row["output_tokens"] == 200

    steps = list_run_steps(str(db), int(row["id"]))
    kinds = [s["kind"] for s in steps]
    names = [s["name"] for s in steps]
    # trig → 取数 → agentic loop 逐次工具 → 摘要 → 装配 → out (无 think —— Python 腿
    # 没开 thinking, 没有数据就不造思考块)。
    assert kinds == ["trig", "tool", "tool", "tool", "tool", "tool", "out"]
    assert "think" not in kinds
    assert names[1] == "fetch_report_briefs"
    assert names[2:4] == ["get_email_body", "search_emails"]
    assert names[4:6] == ["summarize", "assemble_report_doc"]
    tc1 = steps[2]
    assert tc1["ok"] is True and tc1["ms"] == 300
    assert tc1["payload"]["input"] == {"internal_id": 1}
    # 工具错误在 client.py 统一编码为 "error: ..." —— 以此标 ✗。
    tc2 = steps[3]
    assert tc2["ok"] is False and tc2["payload"]["output_preview"] == "error: timeout"
    assert steps[-1]["payload"]["report_id"].startswith("daily_email_digest")


def test_empty_window_records_skipped_with_report_ref(db: Path):
    store = ReportStore(str(db))

    async def never(**kw):  # 没邮件 → 不该调 LLM
        raise AssertionError("summarize must not run on empty window")

    rid = asyncio.run(run_report_once(
        store=store, db_path=str(db),
        agent=store.get_agent("daily_email_digest"), now=_NOW, agentic_fn=never,
    ))
    rows = _runs(db)
    assert len(rows) == 1
    assert rows[0]["status"] == "skipped"
    assert rows[0]["summary"] == "这段时间没有新邮件 · 未生成报告"
    # 🔴 空分支同样 create_report 了一行 (status='empty') —— out 必带 report_id,
    # 否则记录列同一次执行出「产物 + 过程」两行 (前端按真实引用收敛, 无启发式)。
    steps = list_run_steps(str(db), int(rows[0]["id"]))
    assert steps[-1]["kind"] == "out"
    assert steps[-1]["payload"]["report_id"] == rid
    assert rows[0]["report_id"] == rid  # list_run_logs 的 SQL 抽取也拿得到


def test_aggregate_empty_period_records_skipped_with_report_ref(db: Path):
    """weekly 聚合的空分支同款: 期间无日报 → skipped + out 带 report_id。"""
    store = ReportStore(str(db))

    async def never(**kw):
        raise AssertionError("aggregate must not run on empty period")

    rid = asyncio.run(run_report_once(
        store=store, db_path=str(db),
        agent=store.get_agent("weekly_email_digest"), now=_NOW, aggregate_fn=never,
    ))
    rows = list_run_logs(str(db), agent_id="weekly_email_digest")
    assert len(rows) == 1
    assert rows[0]["status"] == "skipped"
    steps = list_run_steps(str(db), int(rows[0]["id"]))
    assert steps[-1]["kind"] == "out"
    assert steps[-1]["payload"]["report_id"] == rid
    assert rows[0]["report_id"] == rid


def test_summarize_failure_degrades_but_run_completes_with_reason(db: Path):
    _seed_email(db)
    store = ReportStore(str(db))

    async def boom(**kw):
        raise RuntimeError("llm down")

    rid = asyncio.run(run_report_once(
        store=store, db_path=str(db),
        agent=store.get_agent("daily_email_digest"), now=_NOW, agentic_fn=boom,
    ))
    # 报告本体照旧降级产出 (ready + error 记因) —— run 台账与之同口径。
    assert store.get_report(rid)["status"] == "ready"
    rows = _runs(db)
    assert len(rows) == 1
    row = rows[0]
    assert row["status"] == "completed"
    assert (row["error"] or "").startswith("summarize_failed:")
    steps = list_run_steps(str(db), int(row["id"]))
    summarize = next(s for s in steps if s["name"] == "summarize")
    assert summarize["ok"] is False
    assert "降级" in summarize["detail"] and "llm down" in summarize["detail"]
    assert next(s for s in steps if s["name"] == "assemble_fallback_doc")["ok"] is True
    assert steps[-1]["kind"] == "out"


def test_trigger_kind_schedule_is_recorded(db: Path):
    _seed_email(db)
    store = ReportStore(str(db))

    async def spy(**kw):
        return _draft()

    asyncio.run(run_report_once(
        store=store, db_path=str(db),
        agent=store.get_agent("daily_email_digest"), now=_NOW, agentic_fn=spy,
        trigger_kind="schedule",
    ))
    assert _runs(db)[0]["trigger_kind"] == "schedule"
