"""serve-api reports router 测试 — /api/reports/* + /api/report-agents/*。

镜像本地 IPC report:list/get/getConfig/setConfig/runNow/delete 的形状 + 鉴权 +
in-process resolve（含默认 prompt，验证「修 agents 慢」走 in-process 非 fork CLI）。

DB：真 SyncStore schema（report_agent 种子 + report 行）。store 经 monkeypatch 注入端点
（对齐 jobs router 的 get_job_repo 直接调模式）。run_report_once mock（不烧 token）。
auth bypass 默认 ON（conftest 在 import 前 setdefault MAILAGENT_API_AUTH_DISABLED）。
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.mail.sync_store import SyncStore
from src.reports.store import ReportStore

_AGENT_ID = "test_daily"
_REPORT_ID = "test_daily:daily:2026-06-01"


@pytest.fixture
def report_db(tmp_path: Path) -> Path:
    """真 SyncStore schema + 确定性 agent（prompt NULL → resolve 回填默认）+ 1 份 ready 报告。"""
    db = tmp_path / "report.db"
    SyncStore(str(db))  # 建 report_agent(种子) + report 表
    conn = sqlite3.connect(str(db))
    conn.execute(
        "INSERT OR REPLACE INTO report_agent "
        "(id, type, enabled, title, schedule_json, prompt, model, kos_enrich, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (
            _AGENT_ID, "report", 1, "Daily Digest",
            json.dumps({"cadence": "daily", "hours": [9]}), None, None, 0, time.time(),
        ),
    )
    conn.commit()
    conn.close()
    store = ReportStore(str(db))
    store.create_report(
        report_id=_REPORT_ID, agent_id=_AGENT_ID, cadence="daily",
        report_date="2026-06-01", window_start="2026-06-01T00:00:00",
        window_end="2026-06-02T00:00:00",
    )
    store.finish_report(
        _REPORT_ID, status="ready",
        blocks_json=json.dumps({"version": 1, "blocks": [{"type": "heading", "text": "H"}]}),
        counts_json=json.dumps({"total": 5, "unread": 2}),
        headline="5 emails today",
    )
    return db


@pytest.fixture
def report_client(report_db: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    store = ReportStore(str(report_db))
    monkeypatch.setattr("src.api.routers.reports.get_report_store", lambda: store)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ---------------------------------------------------------------------------
# report 产物（读 + 删）
# ---------------------------------------------------------------------------


def test_list_reports_shape(report_client: TestClient) -> None:
    """report:list parity：counts_json→counts 对象，不含 blocks_json/doc（重）。"""
    r = report_client.get("/api/reports")
    assert r.status_code == 200
    env = r.json()
    assert env["status"] == "success"
    items = env["data"]
    assert len(items) == 1
    item = items[0]
    assert item["id"] == _REPORT_ID
    assert item["status"] == "ready"
    assert item["counts"] == {"total": 5, "unread": 2}
    assert "counts_json" not in item
    assert "blocks_json" not in item
    assert "doc" not in item
    assert env["meta"]["count"] == 1


def test_list_reports_filter_cadence(report_client: TestClient) -> None:
    assert len(report_client.get("/api/reports?cadence=daily").json()["data"]) == 1
    assert len(report_client.get("/api/reports?cadence=weekly").json()["data"]) == 0


def test_get_report_detail(report_client: TestClient) -> None:
    """report:get parity：blocks_json→doc + counts_json→counts。"""
    r = report_client.get(f"/api/reports/{_REPORT_ID}")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["id"] == _REPORT_ID
    assert data["doc"]["version"] == 1
    assert data["counts"] == {"total": 5, "unread": 2}
    assert "blocks_json" not in data


def test_get_report_404(report_client: TestClient) -> None:
    r = report_client.get("/api/reports/nonexistent:daily:2026-01-01")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_delete_report(report_client: TestClient) -> None:
    r = report_client.delete(f"/api/reports/{_REPORT_ID}")
    assert r.status_code == 200
    assert r.json()["data"]["deleted"] == _REPORT_ID
    assert report_client.get(f"/api/reports/{_REPORT_ID}").status_code == 404


def test_delete_report_404(report_client: TestClient) -> None:
    assert report_client.delete("/api/reports/ghost:daily:2026-01-01").status_code == 404


# ---------------------------------------------------------------------------
# report_agent 配置（getConfig — 修 agents 慢的核心）
# ---------------------------------------------------------------------------


def test_get_config_resolves_default_prompt_inprocess(report_client: TestClient) -> None:
    """getConfig in-process resolve：prompt NULL → 回填默认全文 + prompt_is_default=true。
    验证「修 agents 慢」：默认 prompt 经 get_default_prompt in-process（非 fork CLI）。"""
    r = report_client.get("/api/report-agents")
    assert r.status_code == 200
    agents = r.json()["data"]
    a = next(x for x in agents if x["id"] == _AGENT_ID)
    assert a["enabled"] is True
    assert a["title"] == "Daily Digest"
    assert a["schedule"] == {"cadence": "daily", "hours": [9]}
    # prompt NULL → in-process 回填默认全文（非空）+ flag
    assert a["prompt_is_default"] is True
    assert isinstance(a["prompt"], str) and len(a["prompt"]) > 0
    # model NULL → 默认（非空）
    assert a["model"]
    assert a["trigger_mode"] == "rolling_24h"


def test_get_config_single_agent(report_client: TestClient) -> None:
    r = report_client.get(f"/api/report-agents?agentId={_AGENT_ID}")
    assert r.status_code == 200
    assert r.json()["data"]["id"] == _AGENT_ID


def test_set_config_update(report_client: TestClient) -> None:
    r = report_client.put(
        f"/api/report-agents/{_AGENT_ID}",
        json={"enabled": False, "title": "Renamed", "prompt": "Custom persona"},
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["enabled"] is False
    assert data["title"] == "Renamed"
    assert data["prompt"] == "Custom persona"
    assert data["prompt_is_default"] is False


def test_set_config_reset_prompt_to_default(report_client: TestClient) -> None:
    """prompt "" → None（重置默认，resolve 回填）。"""
    r = report_client.put(f"/api/report-agents/{_AGENT_ID}", json={"prompt": ""})
    assert r.status_code == 200
    assert r.json()["data"]["prompt_is_default"] is True


def test_set_config_invalid_trigger_mode(report_client: TestClient) -> None:
    r = report_client.put(f"/api/report-agents/{_AGENT_ID}", json={"trigger_mode": "bogus"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_set_config_404(report_client: TestClient) -> None:
    assert report_client.put("/api/report-agents/ghost", json={"title": "x"}).status_code == 404


# ---------------------------------------------------------------------------
# runNow（mock run_report_once，不烧 token）
# ---------------------------------------------------------------------------


def test_run_now_mocked(report_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """runNow 同步 in-process：mock run_report_once 写 ready 报告，端点回 ReportRunResult 形状。"""
    rid = "test_daily:daily:2026-06-02"

    async def _fake_run(*, store, db_path, agent):  # noqa: ANN001 — mock signature
        store.create_report(
            report_id=rid, agent_id=agent["id"], cadence="daily",
            report_date="2026-06-02", window_start="x", window_end="y",
        )
        store.finish_report(rid, status="ready", headline="Mock headline")
        return rid

    monkeypatch.setattr("src.reports.worker.run_report_once", _fake_run)
    r = report_client.post(f"/api/report-agents/{_AGENT_ID}/run", json={})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["report_id"] == rid
    assert data["status"] == "ready"
    assert data["headline"] == "Mock headline"


def test_run_now_invalid_cadence(report_client: TestClient) -> None:
    r = report_client.post(f"/api/report-agents/{_AGENT_ID}/run", json={"cadence": "yearly"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_run_now_404(report_client: TestClient) -> None:
    assert report_client.post("/api/report-agents/ghost/run", json={}).status_code == 404


# ---------------------------------------------------------------------------
# wire 边界归一化 + 422 envelope（codex review finding 1/2）
# ---------------------------------------------------------------------------


def test_wire_resolve_agent_bad_schedule_no_crash() -> None:
    """schedule_json 是 JSON array（坏数据）→ 不崩 + 默认 schedule（防 list.get() AttributeError）。"""
    from src.reports import wire

    out = wire.resolve_agent({"id": "x", "schedule_json": "[1, 2]", "trigger_mode": "bogus"})
    assert out["schedule"] == {"cadence": "daily", "hours": [9]}
    assert out["trigger_mode"] == "rolling_24h"  # clamp 非 natural_day


def test_wire_resolve_agent_trigger_mode_clamp() -> None:
    """trigger_mode 仅 natural_day 认，其余/坏值/None 回落 rolling_24h（对齐 TS _toAgentConfig）。"""
    from src.reports import wire

    assert (
        wire.resolve_agent({"id": "x", "trigger_mode": "natural_day"})["trigger_mode"]
        == "natural_day"
    )
    assert (
        wire.resolve_agent({"id": "x", "trigger_mode": "garbage"})["trigger_mode"] == "rolling_24h"
    )
    assert wire.resolve_agent({"id": "x", "trigger_mode": None})["trigger_mode"] == "rolling_24h"


def test_wire_resolve_agent_empty_schedule_defaults() -> None:
    """空 dict / null schedule_json → 默认 {cadence, hours}（守 ReportAgentConfig.schedule 类型契约）。"""
    from src.reports import wire

    assert wire.resolve_agent({"id": "x", "schedule_json": "{}"})["schedule"] == {
        "cadence": "daily",
        "hours": [9],
    }
    assert wire.resolve_agent({"id": "x", "schedule_json": None})["schedule"] == {
        "cadence": "daily",
        "hours": [9],
    }


def test_malformed_body_returns_envelope(report_client: TestClient) -> None:
    """malformed/非 object body → 422 但走 MailAgent envelope（E_INVALID_ARG），非 FastAPI 默认
    {detail:[...]}（codex finding 2：全局 RequestValidationError handler）。"""
    r = report_client.put(
        f"/api/report-agents/{_AGENT_ID}",
        content="[1, 2, 3]",  # JSON array, not object → body: Optional[dict] 校验失败
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 422
    env = r.json()
    assert env["status"] == "error"
    assert env["error"]["code"] == "E_INVALID_ARG"
