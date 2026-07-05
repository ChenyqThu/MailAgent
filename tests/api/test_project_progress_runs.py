"""serve-api project-progress runs 端点测试 — GET /api/project-progress/runs（v1.3.0 R5）。

只读近期执行记录（``ProjectProgressSyncStore.list_recent`` 包一层 + 投影）。store 经
monkeypatch 注入端点（对齐 test_reports 的 get_report_store 直接调模式；端点 lazy import
``src.api.deps.get_project_progress_store``，故 patch 该模块属性）。auth bypass 默认 ON
（conftest 在 import 前 setdefault MAILAGENT_API_AUTH_DISABLED）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.project_progress.sync_store import (
    ProjectProgressSyncRecord,
    ProjectProgressSyncStore,
)


@pytest.fixture
def pp_store(tmp_path: Path) -> ProjectProgressSyncStore:
    """三条确定性记录：completed（含项目计数）/ failed（带 error）/ skipped（去重）。"""
    store = ProjectProgressSyncStore(str(tmp_path / "pp.db"))
    store.complete(
        ProjectProgressSyncRecord(
            email_internal_id=101,
            email_subject="[weekly] 项目进度 W23",
            week_tag="2026-W23",
            xlsx_filename="progress_w23.xlsx",
            projects_total=8,
            projects_created=2,
            projects_updated=6,
        )
    )
    store.fail(
        ProjectProgressSyncRecord(
            email_internal_id=102,
            email_subject="[weekly] 项目进度 W24",
            week_tag="2026-W24",
        ),
        "notion 429 rate limited",
    )
    store.skip(103, "duplicate xlsx_md5")
    return store


@pytest.fixture
def pp_client(
    pp_store: ProjectProgressSyncStore, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    monkeypatch.setattr("src.api.deps.get_project_progress_store", lambda: pp_store)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def test_list_runs_shape(pp_client: TestClient) -> None:
    """投影字段完整；内部 sheet_* 计数不泄漏；status/error/时间戳各就位。"""
    r = pp_client.get("/api/project-progress/runs")
    assert r.status_code == 200
    env = r.json()
    assert env["status"] == "success"
    items = env["data"]
    assert len(items) == 3
    assert env["meta"]["count"] == 3

    by_id = {it["internalId"]: it for it in items}
    done = by_id[101]
    assert done["status"] == "completed"
    assert done["subject"] == "[weekly] 项目进度 W23"
    assert done["weekTag"] == "2026-W23"
    assert done["filename"] == "progress_w23.xlsx"
    assert done["projectsTotal"] == 8
    assert done["projectsCreated"] == 2
    assert done["projectsUpdated"] == 6
    assert done["completedAt"] is not None
    assert done["error"] is None
    # 内部 4-sheet 计数字段刻意不进投影（只暴露历史卡需要的字段）。
    assert "sheet_ongoing_rows" not in done

    failed = by_id[102]
    assert failed["status"] == "failed"
    assert failed["error"] == "notion 429 rate limited"

    skipped = by_id[103]
    assert skipped["status"] == "skipped"


def test_list_runs_limit(pp_client: TestClient) -> None:
    r = pp_client.get("/api/project-progress/runs?limit=1")
    assert r.status_code == 200
    assert len(r.json()["data"]) == 1


def test_list_runs_limit_bounds(pp_client: TestClient) -> None:
    """limit 越界 → 422（Query ge=1 le=100）。"""
    assert pp_client.get("/api/project-progress/runs?limit=0").status_code == 422
    assert pp_client.get("/api/project-progress/runs?limit=101").status_code == 422


def test_list_runs_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """空表 → 200 + []（守读优雅降级）。"""
    store = ProjectProgressSyncStore(str(tmp_path / "empty.db"))
    monkeypatch.setattr("src.api.deps.get_project_progress_store", lambda: store)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/api/project-progress/runs")
    assert r.status_code == 200
    assert r.json()["data"] == []
    assert r.json()["meta"]["count"] == 0
