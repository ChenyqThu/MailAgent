"""项目周报 runner 的执行台账 (`agent_run_log`, task 08-27 P4a run transcript)。

零 LLM 的确定性流程, transcript 形态恒为 触发 → 工具步骤 → 输出, **无 think**
(design §8.1)。此前 per-project 结果在 tally 累加完就丢 (r10 §2.3), 这里盯:
① 完整一轮: trig / fetch_xlsx / parse_xlsx / 逐项目 upsert / mark_done 逐条 / out;
② 解析失败 → failed + 步骤写清「为什么整批跳过」;
③ 幂等跳过 (已处理过) → skipped 留痕;
④ dry_run 不落账;
⑤ `_upsert_steps` 的折叠上限 (失败恒逐条, 成功超上限折叠)。

🔴 全程 tmp_path 建库; Notion 交互全 mock (不出网)。
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass, field
from datetime import date
from typing import List

import pytest

from src.agents.run_log import list_run_logs, list_run_steps
from src.project_progress import runner as runner_mod
from src.project_progress.agent_config import PROJECT_PROGRESS_AGENT_ID
from src.project_progress.detector import ProjectProgressDetector
from src.project_progress.runner import (
    ProjectProgressRunner,
    UpsertAllResult,
    _PP_STEP_DETAIL_CAP,
    _upsert_steps,
)
from src.project_progress.xlsx_parser import ParseResult, SheetKind
from src.mail.sync_store import SyncStore

EMAIL_ID = 101


@pytest.fixture()
def db(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(str(path)) as conn:
        now = time.time()
        conn.execute(
            "INSERT INTO email_metadata (internal_id, message_id, subject, sender, "
            "mailbox, date_received, sync_status, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (EMAIL_ID, "<w35@x>", "W35 项目deadline汇报", "pm@x.com",
             "收件箱", "2026-08-28 09:00:00", "synced", now, now),
        )
        conn.commit()
    return str(path)


def _runner(db) -> ProjectProgressRunner:
    return ProjectProgressRunner(
        sync_store_db_path=db,
        project_database_id="db-fake",
        filter_bu="TPS-ENBU",
        detector=ProjectProgressDetector(subject_pattern=r"项目deadline汇报"),
    )


@dataclass
class _Row:
    external_id: str
    parent_external_id: str = None  # type: ignore[assignment]
    current_sheet: SheetKind = SheetKind.ONGOING


def _parsed(n_projects: int = 2) -> ParseResult:
    projects = [_Row(external_id=f"P-{i}") for i in range(n_projects)]
    return ParseResult(
        xlsx_filename="w35.xlsx", xlsx_md5="", xlsx_size=10,
        sheet_name="Ongoing", total_rows=40, filter_bu="TPS-ENBU",
        filtered_rows=20, projects=projects,  # type: ignore[arg-type]
        reference_date=date(2026, 8, 28), week_tag="W35",
        sheet_stats={SheetKind.ONGOING: 20},
    )


def _oc(external_id: str, action: str, error: str = None):  # type: ignore[assignment]
    from src.project_progress.notion_sync import UpsertOutcome

    return UpsertOutcome(
        external_id=external_id, action=action, page_id=None, error=error
    )


@dataclass
class _FakeUpsert:
    result: UpsertAllResult
    calls: List[dict] = field(default_factory=list)

    async def __call__(self, parsed, email_url, *, mark_missing_as_done):
        self.calls.append({"mark": mark_missing_as_done})
        return self.result


def _run(db, monkeypatch, *, up: UpsertAllResult, **kw):
    r = _runner(db)
    monkeypatch.setattr(
        r, "_fetch_xlsx", lambda iid, mailbox: ("w35.xlsx", b"xlsx-bytes")
    )
    monkeypatch.setattr(runner_mod, "parse_xlsx", lambda *a, **k: _parsed())
    monkeypatch.setattr(r, "_upsert_all", _FakeUpsert(up))
    import asyncio

    return r, asyncio.run(r.sync_from_email(internal_id=EMAIL_ID, **kw))


def _log_rows(db):
    return list_run_logs(db, agent_id=PROJECT_PROGRESS_AGENT_ID)


# ── ① 完整一轮 ─────────────────────────────────────────────────────────────────


def test_full_sync_records_transcript_steps(db, monkeypatch):
    up = UpsertAllResult(
        created=1, updated=0, skipped=1, failed=1, marked_done=1,
        failed_samples=["P-1: boom"], done_samples=["P-9: 旧项目"],
        outcomes=[
            _oc("P-0", "created"),
            _oc("P-2", "skipped_idempotent"),
            _oc("P-1", "failed", "validation error"),
        ],
        mark_done_actions=[
            {"external_id": "P-9", "title": "旧项目", "ok": True},
        ],
    )
    _, summary = _run(db, monkeypatch, up=up)
    assert summary.status == "completed"

    rows = _log_rows(db)
    assert len(rows) == 1
    row = rows[0]
    assert row["status"] == "completed"
    assert row["trigger_kind"] == "email_filter"
    assert "W35 项目deadline汇报" in row["trigger_detail"]
    assert row["summary"] == (
        "W35 · 项目 2 个：新建 1 · 更新 0 · 失败 1 · 兜底标记完成 1"
    )

    # trig payload 的结构化 internal_id 被 list_run_logs 抽出 —— progressEmailId
    # 收敛判据的数据源 (记录列拿它去重台账行与 runlog 行)。
    assert row["trig_internal_id"] == EMAIL_ID

    steps = list_run_steps(db, int(row["id"]))
    kinds = [s["kind"] for s in steps]
    # 零 LLM: 触发 → 工具×N → 输出, **无 think** (design §8.1 定死的差异)。
    assert kinds[0] == "trig" and kinds[-1] == "out"
    assert set(kinds[1:-1]) == {"tool"}
    names = [s["name"] for s in steps]
    assert names[1:3] == ["fetch_xlsx", "parse_xlsx"]
    # 逐项目: 创建 / 失败逐条, 幂等聚合一行。
    created = next(s for s in steps if s["detail"] == "P-0 — 已创建")
    assert created["ok"] is True and created["payload"]["action"] == "created"
    failed = next(s for s in steps if "P-1 — 失败" in (s["detail"] or ""))
    assert failed["ok"] is False and "validation error" in failed["detail"]
    assert any("1 个项目与上次内容一致" in (s["detail"] or "") for s in steps)
    # mark-done 逐条留痕 (最容易「事后说不清」的一步)。
    mark = next(s for s in steps if s["name"] == "mark_done")
    assert "P-9" in mark["detail"] and "兜底标记为 Done" in mark["detail"]


# ── ② 解析失败: 说清为什么整批跳过 ─────────────────────────────────────────────


def test_parse_failure_records_failed_with_reason(db, monkeypatch):
    r = _runner(db)
    monkeypatch.setattr(
        r, "_fetch_xlsx", lambda iid, mailbox: ("w35.xlsx", b"xlsx-bytes")
    )

    def bad_parse(*a, **k):
        raise ValueError("missing column 负责人")

    monkeypatch.setattr(runner_mod, "parse_xlsx", bad_parse)
    import asyncio

    summary = asyncio.run(r.sync_from_email(internal_id=EMAIL_ID))
    assert summary.status == "failed"

    rows = _log_rows(db)
    assert len(rows) == 1
    assert rows[0]["status"] == "failed"
    steps = list_run_steps(db, int(rows[0]["id"]))
    parse_step = next(s for s in steps if s["name"] == "parse_xlsx")
    assert parse_step["ok"] is False
    # 不是只写「失败」—— 要写出为什么这么处置 (design §8.1 的例子)。
    assert "整批跳过" in parse_step["detail"]
    assert "missing column 负责人" in parse_step["detail"]


# ── ③ 幂等跳过留痕 ─────────────────────────────────────────────────────────────


def test_already_completed_records_skipped(db, monkeypatch):
    up = UpsertAllResult(created=2, outcomes=[_oc("P-0", "created"), _oc("P-1", "created")])
    _run(db, monkeypatch, up=up)
    # 第二次同一封: progress_store 已 completed → skipped 留痕而不是没有记录。
    _, summary = _run(db, monkeypatch, up=up)
    assert summary.status == "skipped"
    rows = _log_rows(db)
    assert len(rows) == 2
    assert rows[0]["status"] == "skipped"  # 最新一行
    assert "已处理过" in rows[0]["summary"]


# ── ④ dry_run 不落账 ───────────────────────────────────────────────────────────


def test_dry_run_writes_no_ledger(db, monkeypatch):
    up = UpsertAllResult()
    _, summary = _run(db, monkeypatch, up=up, dry_run=True)
    assert summary.dry_run is True
    assert _log_rows(db) == []


# ── ⑤ 折叠上限 ─────────────────────────────────────────────────────────────────


def test_upsert_steps_fold_beyond_cap_but_failures_stay_itemized():
    outcomes = [_oc(f"P-{i}", "created") for i in range(_PP_STEP_DETAIL_CAP + 7)]
    outcomes.append(_oc("P-BAD", "failed", "boom"))
    steps = _upsert_steps(UpsertAllResult(outcomes=outcomes))
    itemized_ok = [
        s for s in steps
        if s["name"] == "upsert_project" and s["ok"] and "已创建" in (s["detail"] or "")
    ]
    assert len(itemized_ok) == _PP_STEP_DETAIL_CAP
    assert any("另有 7 个项目已写入" in (s["detail"] or "") for s in steps)
    # 失败恒逐条, 不参与折叠。
    assert any("P-BAD — 失败：boom" in (s["detail"] or "") for s in steps)


def test_upsert_steps_surface_schema_bootstrap_failure():
    steps = _upsert_steps(UpsertAllResult(schema_error="401 unauthorized"))
    schema = next(s for s in steps if s["name"] == "schema_bootstrap")
    assert schema["ok"] is False
    assert "non-fatal" in schema["detail"] and "401 unauthorized" in schema["detail"]
