"""/api/history-sync* —— 同步历史邮件的对外契约 (task 09-11, design §5 + §5.1)。

前端已按 §5.1 实现, 所以这里钉的是**逐字段的线上形状**, 不只是"能返回 200":

- 能力门: applescript 后端不支持, 且给出可读的原因码;
- 校验与前端同一条式子 (跨度 = 日期差, 365 合法 / 366 不合法);
- 同一时间只有一个任务: 重复发起返回同一个 job_id 且 was_created=false;
- 取消: 没有进行中的任务 → 404 E_NOT_FOUND;
- ``notion_floor`` 与 watcher 判 Notion 日期地板同源;
- 进度读态从 async_jobs 行 + sync_state live KV 合起来组装 (停滞这类原因只在后者)。
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.api.deps import get_settings
from src.api.routers import history_sync as router_mod
from src.mail.sync_store import SyncStore
from src.sync.async_jobs import AsyncJobRepository

TODAY = date.today()


def _stub_cfg(db_path: Path, *, backend: str = "davmail", mode: str = "relative"):
    return SimpleNamespace(
        mailagent_backend=backend,
        sync_date_mode=mode,
        sync_lookback_days=14,
        sync_start_date="2026-01-01",
        notion_token="ntn_x",
        email_database_id="db1",
        sync_store_db_path=str(db_path),
    )


@pytest.fixture()
def hs_env(tmp_path, monkeypatch) -> Iterator[SimpleNamespace]:
    """TestClient + 临时库 (sync_state 与 async_jobs 同一个库, 与生产一致)。"""
    db = tmp_path / "hs.db"
    store = SyncStore(str(db))
    repo = AsyncJobRepository(db_path=str(db))

    # get_job_repo 在 router 里是直调 (非 Depends), 故换模块引用而不是 dependency_overrides。
    monkeypatch.setattr(router_mod, "get_job_repo", lambda: repo)
    app.dependency_overrides[get_settings] = lambda: _stub_cfg(db)
    app.dependency_overrides[router_mod.get_history_store] = lambda: store
    with TestClient(app, raise_server_exceptions=False) as client:
        yield SimpleNamespace(client=client, store=store, repo=repo, db=db)
    app.dependency_overrides.pop(get_settings, None)
    app.dependency_overrides.pop(router_mod.get_history_store, None)


def _data(resp):
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "success", body
    return body["data"]


def _start(client, since, until):
    return client.post("/api/history-sync", json={"since": since, "until": until})


# ---------------------------------------------------------------------------
# GET: 能力 / 默认值 / Notion 地板
# ---------------------------------------------------------------------------


def test_get_reports_capability_and_defaults(hs_env):
    data = _data(hs_env.client.get("/api/history-sync"))

    assert data["supported"] is True
    assert data["unsupported_reason"] is None
    assert data["backend"] == "davmail"
    assert data["max_days"] == 365
    assert data["defaults"]["until"] == TODAY.isoformat()
    assert data["defaults"]["since"] == (TODAY - timedelta(days=14)).isoformat()
    assert data["job"] is None


def test_get_notion_floor_matches_the_watcher_gate(hs_env):
    """界面上承诺的"早于 X 日只存本地"必须与 watcher 实际判据同源。

    默认 relative 模式下地板是**滚动**日期 (今天 − SYNC_LOOKBACK_DAYS), 恰好与默认
    起始日同一天 —— 地板停在固定的 SYNC_START_DATE 会当场红。
    """
    from src.config import parse_sync_start_date

    data = _data(hs_env.client.get("/api/history-sync"))
    expected = parse_sync_start_date(_stub_cfg(hs_env.db))

    assert data["notion_enabled"] is True
    assert data["notion_floor"] == expected.strftime("%Y-%m-%d")
    assert data["notion_floor"] == (TODAY - timedelta(days=14)).isoformat()


def test_get_notion_floor_in_fixed_mode_is_the_configured_start_date(hs_env):
    """fixed 模式下地板是 SYNC_START_DATE 本身, 不随今天滚动。"""
    app.dependency_overrides[get_settings] = lambda: _stub_cfg(hs_env.db, mode="fixed")

    data = _data(hs_env.client.get("/api/history-sync"))

    assert data["notion_floor"] == "2026-01-01"


def test_applescript_backend_is_unsupported(hs_env, tmp_path):
    app.dependency_overrides[get_settings] = lambda: _stub_cfg(
        hs_env.db, backend="applescript"
    )

    data = _data(hs_env.client.get("/api/history-sync"))

    assert data["supported"] is False
    assert data["unsupported_reason"] == "backend_applescript"


def test_start_rejected_on_unsupported_backend(hs_env):
    app.dependency_overrides[get_settings] = lambda: _stub_cfg(
        hs_env.db, backend="applescript"
    )

    resp = _start(hs_env.client, TODAY.isoformat(), TODAY.isoformat())

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


# ---------------------------------------------------------------------------
# POST: 校验 (与前端 validateRange 同一条式子)
# ---------------------------------------------------------------------------


def test_span_rule_matches_the_frontend(hs_env):
    """跨度判据是**日期差**: 365 天放行, 366 天拒绝 (design §5.1)。"""
    ok = _start(
        hs_env.client, (TODAY - timedelta(days=365)).isoformat(), TODAY.isoformat()
    )
    assert ok.status_code == 200

    too_wide = _start(
        hs_env.client, (TODAY - timedelta(days=366)).isoformat(), TODAY.isoformat()
    )
    assert too_wide.status_code == 400
    assert too_wide.json()["error"]["code"] == "E_INVALID_ARG"


@pytest.mark.parametrize(
    "since,until",
    [
        ("2026-09-11", "2026-09-10"),                      # 起晚于止
        ("2026-09-01", (TODAY + timedelta(days=1)).isoformat()),  # 止晚于今天
        ("not-a-date", "2026-09-11"),                      # 格式
        ("", ""),                                          # 缺失
    ],
)
def test_invalid_ranges_are_rejected(hs_env, since, until):
    resp = _start(hs_env.client, since, until)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


# ---------------------------------------------------------------------------
# POST: 单任务语义
# ---------------------------------------------------------------------------


def test_start_enqueues_one_job_with_params(hs_env):
    data = _data(_start(hs_env.client, TODAY.isoformat(), TODAY.isoformat()))

    assert data["was_created"] is True
    job = hs_env.repo.get(data["job_id"])
    assert job.job_type == "history_sync"
    assert job.status == "queued"
    assert job.params == {"since": TODAY.isoformat(), "until": TODAY.isoformat()}


def test_second_start_returns_the_running_job(hs_env):
    """重复点击 / 并发请求只产生一个任务。"""
    first = _data(_start(hs_env.client, TODAY.isoformat(), TODAY.isoformat()))
    second = _data(
        _start(
            hs_env.client,
            (TODAY - timedelta(days=5)).isoformat(),   # 换个范围也不另起
            TODAY.isoformat(),
        )
    )

    assert second["job_id"] == first["job_id"]
    assert second["was_created"] is False
    assert hs_env.repo.count_runs(job_type="history_sync") == 1


# ---------------------------------------------------------------------------
# 取消
# ---------------------------------------------------------------------------


def test_cancel_without_active_job_is_404(hs_env):
    resp = hs_env.client.post("/api/history-sync/cancel", json={})

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "E_NOT_FOUND"


def test_cancel_marks_the_active_job(hs_env):
    started = _data(_start(hs_env.client, TODAY.isoformat(), TODAY.isoformat()))

    data = _data(hs_env.client.post("/api/history-sync/cancel", json={}))

    assert data == {"job_id": started["job_id"], "cancel_requested": True}
    # 取消是给 runner 的标记, 且必须在读态里可见 (前端据它禁用按钮)
    job = _data(hs_env.client.get("/api/history-sync"))["job"]
    assert job["cancel_requested"] is True


# ---------------------------------------------------------------------------
# 读态组装
# ---------------------------------------------------------------------------


def test_job_payload_merges_live_state(hs_env):
    """进度 / 分项计数 / 覆盖完整性来自 live KV, 与 async_jobs 行合并成一个 job 对象。"""
    started = _data(_start(hs_env.client, TODAY.isoformat(), TODAY.isoformat()))
    job_id = started["job_id"]
    hs_env.store.set_state(
        f"history_sync.live.{job_id}",
        json.dumps({
            "phase": "syncing",
            "counts": {"scanned": 9, "existing": 4, "added": 5, "processed": 3,
                       "notion_synced": 2, "local_only": 1, "failed": 0,
                       "empty_msgid": 1},
            "complete": False,
            "covered_from": "2026-09-05",
            "progress_done": 3,
            "progress_total": 5,
            "last_error": None,
        }),
    )
    hs_env.repo.claim_next()          # queued → running

    job = _data(hs_env.client.get("/api/history-sync"))["job"]

    assert job["status"] == "running"
    assert job["phase"] == "syncing"
    assert job["progress_done"] == 3
    assert job["progress_total"] == 5
    assert job["complete"] is False
    assert job["covered_from"] == "2026-09-05"
    assert job["counts"]["notion_synced"] == 2
    assert job["counts"]["empty_msgid"] == 1


def test_stall_reason_surfaces_even_though_the_job_row_has_no_error(hs_env):
    """停滞不是异常 → async_jobs.last_error 是空的; 原因只在 live 里, 读态必须带上它,
    否则界面会把"没做完"显示成成功。"""
    started = _data(_start(hs_env.client, TODAY.isoformat(), TODAY.isoformat()))
    job_id = started["job_id"]
    hs_env.store.set_state(
        f"history_sync.live.{job_id}",
        json.dumps({"phase": "done", "last_error": "邮件处理停滞: 3 封已入库但没有进展"}),
    )
    hs_env.repo.claim_next()
    hs_env.repo.mark_terminal(job_id, status="partial_failure", result={"failed": 3})

    job = _data(hs_env.client.get("/api/history-sync"))["job"]

    assert job["status"] == "partial_failure"
    assert job["phase"] == "done"
    assert "停滞" in job["last_error"]


def test_finished_job_is_reported_when_nothing_is_running(hs_env):
    started = _data(_start(hs_env.client, TODAY.isoformat(), TODAY.isoformat()))
    hs_env.repo.claim_next()
    hs_env.repo.mark_terminal(started["job_id"], status="succeeded", result={})

    data = _data(hs_env.client.get("/api/history-sync"))

    assert data["job"]["job_id"] == started["job_id"]
    assert data["job"]["status"] == "succeeded"
    # 已结束 → 可以再起一个新的
    again = _data(_start(hs_env.client, TODAY.isoformat(), TODAY.isoformat()))
    assert again["was_created"] is True
    assert again["job_id"] != started["job_id"]
