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
from src.reports.models import MANUAL_CHAT_REPORT_AGENT_ID
from src.reports.store import ReportStore

_AGENT_ID = "test_daily"
_REPORT_ID = "test_daily:daily:2026-06-01"
_CUSTOM_AGENT_ID = "custom-digest"


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
    # type='custom' 行：/reports/custom 的归属校验要求 agentId 是真实 agent（或 manual chat 哨兵）。
    conn.execute(
        "INSERT OR REPLACE INTO report_agent "
        "(id, type, enabled, title, schedule_json, prompt, model, kos_enrich, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (_CUSTOM_AGENT_ID, "custom", 1, "Approval Digest", None, None, None, 0, time.time()),
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


def test_write_custom_report_new_allocates_daily_sequence(
    report_client: TestClient,
) -> None:
    body = {
        "agentId": "custom-digest",
        "title": "Approval digest",
        "mode": "new",
        "blocks": [{"type": "overview", "text": "Three approvals need attention."}],
    }
    first = report_client.post("/api/reports/custom", json=body)
    second = report_client.post("/api/reports/custom", json=body)

    assert first.status_code == 200
    assert second.status_code == 200
    first_data = first.json()["data"]
    second_data = second.json()["data"]
    assert first_data["id"].endswith(":0001")
    assert second_data["id"].endswith(":0002")
    assert first_data["cadence"] == "custom"
    assert first_data["headline"] == "Approval digest"
    assert first_data["doc"]["blocks"][0] == {
        "type": "header",
        "title": "Approval digest",
    }
    assert first_data["doc"]["blocks"][1]["type"] == "overview"


def test_write_custom_report_replace_uses_stable_destination(
    report_client: TestClient,
) -> None:
    first = report_client.post(
        "/api/reports/custom",
        json={
            "agentId": "custom-digest",
            "title": "First",
            "mode": "replace",
            "blocks": [{"type": "quote", "text": "v1"}],
        },
    )
    second = report_client.post(
        "/api/reports/custom",
        json={
            "agentId": "custom-digest",
            "title": "Second",
            "mode": "replace",
            "blocks": [{"type": "quote", "text": "v2"}],
        },
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["data"]["id"] == "custom-digest:custom:destination"
    assert second.json()["data"]["id"] == first.json()["data"]["id"]
    assert second.json()["data"]["headline"] == "Second"
    listed = report_client.get(
        "/api/reports", params={"cadence": "custom", "agentId": "custom-digest"}
    ).json()
    assert listed["meta"]["total"] == 1


def test_write_custom_report_rejects_remote_image(report_client: TestClient) -> None:
    response = report_client.post(
        "/api/reports/custom",
        json={
            "agentId": "custom-digest",
            "title": "Unsafe image",
            "mode": "new",
            "blocks": [
                {"type": "image", "src": "https://tracking.example/pixel.png", "alt": "pixel"}
            ],
        },
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_ARG"


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


def test_list_reports_total_and_offset_pagination(
    report_client: TestClient, report_db: Path
) -> None:
    """task 07-21：meta.total = 同 filter 条件 COUNT(*)，data 随 limit/offset 分页。"""
    store = ReportStore(str(report_db))
    for i in range(2, 6):  # report_db fixture 已种 1 份 2026-06-01，这里再加 4 份 daily。
        rid = f"{_AGENT_ID}:daily:2026-06-{i:02d}"
        store.create_report(
            report_id=rid, agent_id=_AGENT_ID, cadence="daily",
            report_date=f"2026-06-{i:02d}", window_start="s", window_end="e",
        )
        store.finish_report(rid, status="ready", headline=f"h{i}")

    r1 = report_client.get("/api/reports", params={"limit": 2, "offset": 0})
    env1 = r1.json()
    assert env1["meta"]["total"] == 5
    assert env1["meta"]["limit"] == 2
    assert env1["meta"]["offset"] == 0
    assert len(env1["data"]) == 2

    r2 = report_client.get("/api/reports", params={"limit": 2, "offset": 4})
    env2 = r2.json()
    assert len(env2["data"]) == 1  # 最后一页只剩 1 条
    assert env2["meta"]["total"] == 5

    ids_seen = {it["id"] for it in env1["data"]} | {it["id"] for it in env2["data"]}
    assert len(ids_seen) == 3  # 两页无重叠


def test_list_reports_offset_out_of_range_returns_empty(report_client: TestClient) -> None:
    r = report_client.get("/api/reports", params={"offset": 999})
    env = r.json()
    assert env["data"] == []
    assert env["meta"]["total"] == 1  # 总数仍准确，只是这页越界拿不到数据


def test_list_reports_total_empty_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = tmp_path / "empty_report.db"
    SyncStore(str(db))
    store = ReportStore(str(db))
    monkeypatch.setattr("src.api.routers.reports.get_report_store", lambda: store)
    with TestClient(app, raise_server_exceptions=False) as c:
        env = c.get("/api/reports").json()
        assert env["data"] == []
        assert env["meta"]["total"] == 0
        assert env["meta"]["count"] == 0


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
# S4 P2-1: 保存时深校验 custom agent trigger（坏配置 → 400，DB 不变）
# ---------------------------------------------------------------------------


def test_set_config_rejects_bad_cron_trigger(report_client: TestClient, report_db: Path) -> None:
    """坏 cron trigger → 400 E_INVALID_ARG，且 DB 不写入（校验在 update 前）。"""
    r = report_client.put(
        f"/api/report-agents/{_AGENT_ID}",
        json={"trigger": {"v": 1, "kind": "cron", "cron": "garbage cron"}},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    # DB 未变（trigger_json 仍 NULL）。
    row = ReportStore(str(report_db)).get_agent(_AGENT_ID)
    assert row["trigger_json"] is None


def test_set_config_rejects_unknown_trigger_kind(report_client: TestClient) -> None:
    r = report_client.put(
        f"/api/report-agents/{_AGENT_ID}", json={"trigger": {"v": 1, "kind": "webhook"}}
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_set_config_rejects_overlong_pattern(report_client: TestClient) -> None:
    r = report_client.put(
        f"/api/report-agents/{_AGENT_ID}",
        json={"trigger": {"v": 1, "kind": "email_filter", "subject_pattern": "a" * 300}},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_set_config_accepts_valid_trigger_on_custom(
    report_client: TestClient, report_db: Path
) -> None:
    """合法 trigger 存 custom agent → 200 + 读回一致（custom-only 投影）。"""
    ReportStore(str(report_db)).create_agent("custom1", type="custom", enabled=True, title="DMS")
    r = report_client.put(
        "/api/report-agents/custom1",
        json={"trigger": {"v": 1, "kind": "email_filter", "subject_pattern": "DMS.*审批",
                          "folders": ["收件箱"]}},
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["trigger"]["v"] == 2
    assert data["trigger"]["triggers"][0]["kind"] == "email_filter"
    assert data["trigger"]["triggers"][0]["subject_pattern"] == "DMS.*审批"
    assert data["trigger"]["triggers"][0]["id"].startswith("trg_")


def test_set_config_normal_patch_unaffected_by_validation(report_client: TestClient) -> None:
    """无 trigger 的普通 patch（report agent）不受校验影响 —— 行为零回归。"""
    r = report_client.put(
        f"/api/report-agents/{_AGENT_ID}", json={"enabled": False, "title": "X"}
    )
    assert r.status_code == 200
    assert r.json()["data"]["title"] == "X"


def test_contact_governance_config_roundtrips_literal_schedule_and_model_chain(
    report_client: TestClient,
) -> None:
    r = report_client.put(
        "/api/report-agents/contact_governance_agent",
        json={
            "enabled": True,
            "model": "provider:model",
            "fallback_models": ["fallback:a"],
            "trigger": {"fire_hour": 9},
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["type"] == "contact_governance"
    assert data["enabled"] is True
    assert data["model"] == "provider:model"
    assert data["fallback_models"] == ["fallback:a"]
    assert data["trigger"] == {"fire_hour": 9}


# ---------------------------------------------------------------------------
# create agent (POST /report-agents) + tools_json 投影
# ---------------------------------------------------------------------------


def test_create_search_agent(report_client: TestClient) -> None:
    """POST /report-agents 建 type='search' agent → resolve_agent 带 tools_json 数组。"""
    r = report_client.post(
        "/api/report-agents",
        json={
            "id": "my_search",
            "type": "search",
            "title": "My Search",
            "enabled": True,
            "tools_json": ["email_search_fulltext"],
        },
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["id"] == "my_search"
    assert data["type"] == "search"
    assert data["enabled"] is True
    assert data["title"] == "My Search"
    assert data["tools_json"] == ["email_search_fulltext"]


def test_create_report_agent_persists_normalized_description(report_client: TestClient) -> None:
    response = report_client.post(
        "/api/report-agents",
        json={
            "id": "weekly_description",
            "type": "report",
            "title": "Weekly",
            "description": "  Weekly status summary  ",
        },
    )
    assert response.status_code == 200
    assert response.json()["data"]["description"] == "Weekly status summary"


def test_create_agent_rejects_overlong_description(report_client: TestClient) -> None:
    response = report_client.post(
        "/api/report-agents",
        json={"id": "too_long_description", "type": "report", "description": "x" * 1001},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_ARG"


def test_create_agent_conflict_409(report_client: TestClient) -> None:
    """id 已存在 → 409 E_CONFLICT。"""
    r = report_client.post("/api/report-agents", json={"id": _AGENT_ID, "type": "report"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_CONFLICT"


def test_create_agent_missing_id(report_client: TestClient) -> None:
    r = report_client.post("/api/report-agents", json={"type": "search"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_create_agent_invalid_type(report_client: TestClient) -> None:
    """非法 type（白名单外）→ E_INVALID_ARG（4xx），不写脏行。"""
    r = report_client.post("/api/report-agents", json={"id": "bad", "type": "garbage"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_seeded_search_agent_tools_projection(report_client: TestClient) -> None:
    """种子 search agent (tools_json NULL by seed → 实际 JSON 串) 经 wire 投影成数组。
    search 行 prompt/model 不泄漏 report 默认（type 门控）。"""
    r = report_client.get("/api/report-agents?agentId=email_search_agent")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["type"] == "search"
    assert data["tools_json"] == ["email_search_fulltext"]
    # search 行 prompt/model NULL → 投影空串（不回退 report 的 get_default_prompt / DEFAULT_REPORT_MODEL）
    assert data["prompt"] == ""
    assert data["model"] == ""


def test_report_agent_tools_json_empty_default(report_client: TestClient) -> None:
    """report agent (tools_json NULL) → 空 list 默认（不破坏 report 投影）。"""
    r = report_client.get(f"/api/report-agents?agentId={_AGENT_ID}")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["type"] == "report"
    assert data["tools_json"] == []


# ---------------------------------------------------------------------------
# delete agent (DELETE /report-agents/{id})
# ---------------------------------------------------------------------------


def test_delete_agent(report_client: TestClient) -> None:
    """DELETE /report-agents/{id} → {deleted}；删后 getConfig 404。"""
    r = report_client.delete(f"/api/report-agents/{_AGENT_ID}")
    assert r.status_code == 200
    assert r.json()["data"]["deleted"] == _AGENT_ID
    assert report_client.get(f"/api/report-agents?agentId={_AGENT_ID}").status_code == 404


def test_delete_agent_404(report_client: TestClient) -> None:
    r = report_client.delete("/api/report-agents/ghost")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


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


def test_run_now_search_agent_rejected(
    report_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """type='search' agent 调 run_now → 400 E_INVALID_ARG，不写 report 行。"""
    import sqlite3 as _sqlite3
    import time as _time

    _SEARCH_ID = "email_search_agent"
    conn = _sqlite3.connect(str(report_db))
    conn.execute(
        "INSERT OR REPLACE INTO report_agent "
        "(id, type, enabled, title, schedule_json, prompt, model, kos_enrich, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (_SEARCH_ID, "search", 1, "Search Agent", "{}", None, None, 0, _time.time()),
    )
    conn.commit()
    conn.close()

    store = ReportStore(str(report_db))
    monkeypatch.setattr("src.api.routers.reports.get_report_store", lambda: store)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.post(f"/api/report-agents/{_SEARCH_ID}/run", json={})
    assert r.status_code == 400
    body = r.json()
    assert body["error"]["code"] == "E_INVALID_ARG"
    # S5：manual run 现支持 report/custom（search/preprocess 仍拒）。
    assert "report/custom" in body["error"]["message"]
    # 确认没有写入 report 行
    assert store.get_report(f"{_SEARCH_ID}:daily:2026-06-01") is None


def test_run_now_report_agent_still_works(
    report_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """type='report' agent 不受守卫影响，_run_report_once_sync mock 返回 ready 报告。"""
    rid = "guard_check:daily:2026-06-03"

    store = ReportStore(str(report_db))

    def _fake_sync(s, db_path, agent):  # noqa: ANN001
        store.create_report(
            report_id=rid, agent_id=agent["id"], cadence="daily",
            report_date="2026-06-03", window_start="x", window_end="y",
        )
        store.finish_report(rid, status="ready", headline="OK")
        return rid

    monkeypatch.setattr("src.api.routers.reports.get_report_store", lambda: store)
    monkeypatch.setattr("src.api.routers.reports._run_report_once_sync", _fake_sync)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.post(f"/api/report-agents/{_AGENT_ID}/run", json={})
    assert r.status_code == 200
    assert r.json()["data"]["status"] == "ready"


# ---------------------------------------------------------------------------
# S5 W1: create custom agent（flag-gated）+ run-now custom（enqueue，非路径 B）
# ---------------------------------------------------------------------------


def test_create_custom_agent_draft_flag_on(report_client: TestClient, monkeypatch) -> None:
    """flag on：create type='custom' 无 trigger → 草稿 custom 行（trigger 投影 null）。"""
    monkeypatch.setattr("src.api.routers.reports._custom_agents_enabled", lambda: True)
    r = report_client.post(
        "/api/report-agents",
        json={"id": "cust_draft", "type": "custom", "title": "DMS", "enabled": False},
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["type"] == "custom"
    assert data["trigger"] is None  # 草稿态


def test_create_custom_agent_with_trigger_persists(report_client: TestClient, monkeypatch) -> None:
    """flag on：create custom 带合法 cron trigger → 深校验通过 + 落库（读回一致，非静默丢弃）。"""
    monkeypatch.setattr("src.api.routers.reports._custom_agents_enabled", lambda: True)
    r = report_client.post(
        "/api/report-agents",
        json={
            "id": "cust_cron", "type": "custom", "enabled": True,
            "trigger": {"v": 1, "kind": "cron", "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai"},
            # Legacy max_steps is accepted but intentionally ignored; time is the only hard limit.
            "budget": {"v": 1, "max_steps": 6, "max_run_seconds": 900},
        },
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["trigger"]["v"] == 2
    assert data["trigger"]["triggers"][0]["kind"] == "cron"
    assert data["trigger"]["triggers"][0]["cron"] == "0 9 * * 1-5"
    assert "max_steps" not in data["budget"]
    assert data["budget"]["max_run_seconds"] == 900


def test_create_custom_agent_bad_trigger_rejected(report_client: TestClient, monkeypatch) -> None:
    """flag on：create custom 带坏 cron → 400 E_INVALID_ARG，不写脏行。"""
    monkeypatch.setattr("src.api.routers.reports._custom_agents_enabled", lambda: True)
    r = report_client.post(
        "/api/report-agents",
        json={"id": "cust_bad", "type": "custom",
              "trigger": {"v": 1, "kind": "cron", "cron": "not a cron"}},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert report_client.get("/api/report-agents?agentId=cust_bad").status_code == 404


def test_create_custom_agent_bad_tool_policy_no_orphan_row(
    report_client: TestClient, monkeypatch
) -> None:
    """flag on：create custom 带非 dict tool_policy → 400，且**不留孤儿草稿行**（建行原子性）。

    结构闸（config_patch_to_db 非 dict → ValueError）在 store.create_agent **之前**跑，故坏
    tool_policy/budget 拒收时零副作用（W1-check P2 修：曾在建行后才 400 会留下无 v30 字段的行）。
    """
    monkeypatch.setattr("src.api.routers.reports._custom_agents_enabled", lambda: True)
    r = report_client.post(
        "/api/report-agents",
        json={"id": "cust_badtp", "type": "custom", "tool_policy": "not a dict"},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert report_client.get("/api/report-agents?agentId=cust_badtp").status_code == 404


# ---------------------------------------------------------------------------
# S6 W3-2 (ADR-004 rev3.1 §7): CRUD 落库白名单放开三键（grant_exec/grant_web/skills）——
# parse_tool_policy 是唯一权威，其余未知键拒收纪律不变。
# ---------------------------------------------------------------------------


def test_create_custom_agent_with_grants_persists(
    report_client: TestClient, monkeypatch
) -> None:
    """flag on：create custom 带 grant_exec/grant_web/skills → 200 + tool_policy 三键读回一致。"""
    monkeypatch.setattr("src.api.routers.reports._custom_agents_enabled", lambda: True)
    r = report_client.post(
        "/api/report-agents",
        json={
            "id": "cust_grants", "type": "custom", "title": "Webby",
            "tool_policy": {
                "v": 1, "allowed_tools": ["email_get"],
                "grant_exec": True, "grant_web": "gated", "skills": ["email", "dms-approval"],
            },
        },
    )
    assert r.status_code == 200
    tp = r.json()["data"]["tool_policy"]
    assert tp["grant_exec"] is True
    assert tp["grant_web"] == "gated"
    assert tp["skills"] == ["email", "dms-approval"]
    assert tp["allowed_tools"] == ["email_get"]


def test_set_config_custom_grants_roundtrip(
    report_client: TestClient, report_db: Path
) -> None:
    """PUT tool_policy 三键 → 200 + 读回一致（Settings/CRUD 共用同一 REST 面）。"""
    ReportStore(str(report_db)).create_agent("cust_g2", type="custom", enabled=True, title="G2")
    r = report_client.put(
        "/api/report-agents/cust_g2",
        json={"tool_policy": {"v": 1, "grant_web": "open", "skills": []}},
    )
    assert r.status_code == 200
    tp = r.json()["data"]["tool_policy"]
    assert tp["grant_web"] == "open"
    assert tp["skills"] == []  # 显式零挂载 verbatim（≠ 默认挂载集）


def test_set_config_rejects_unknown_tool_policy_key(
    report_client: TestClient, report_db: Path
) -> None:
    """未知 tool_policy 键仍 400（extra-forbid 纪律不因三键放开而松动）。"""
    ReportStore(str(report_db)).create_agent("cust_g3", type="custom", enabled=True, title="G3")
    r = report_client.put(
        "/api/report-agents/cust_g3",
        json={"tool_policy": {"v": 1, "policy_rules": [{"capability": "exec"}]}},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_set_config_rejects_bad_grant_web_and_skills(
    report_client: TestClient, report_db: Path
) -> None:
    """grant_web 非三态字面量 / skills 非 list[str] → 400（typed 严格化，fail-closed 在边界）。"""
    ReportStore(str(report_db)).create_agent("cust_g4", type="custom", enabled=True, title="G4")
    for bad_tp in (
        {"v": 1, "grant_web": "yes"},
        {"v": 1, "grant_web": True},
        {"v": 1, "grant_web": 1},
        {"v": 1, "skills": "email"},
    ):
        r = report_client.put("/api/report-agents/cust_g4", json={"tool_policy": bad_tp})
        assert r.status_code == 400, bad_tp
        assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_set_config_grant_connectors_roundtrip(
    report_client: TestClient, report_db: Path
) -> None:
    """MCP connector PR3：PUT grant_connectors（read/write/update）→ 200 + 读回一致。"""
    ReportStore(str(report_db)).create_agent("cust_c1", type="custom", enabled=True, title="C1")
    r = report_client.put(
        "/api/report-agents/cust_c1",
        json={"tool_policy": {"v": 1, "grant_connectors": {"notion": "read",
                                                           "atlassian": "update"}}},
    )
    assert r.status_code == 200
    tp = r.json()["data"]["tool_policy"]
    assert tp["grant_connectors"] == {"notion": "read", "atlassian": "update"}


def test_report_row_grant_connectors_roundtrip(
    report_client: TestClient, report_db: Path
) -> None:
    """MCP connector PR3：**报告 Agent**（type='report'）也能配 grant_connectors 并读回。

    报告 Agent 是 connector 的第三个调用方（PRD 决策 8）；PUT 了读不回来 = 界面永远显示
    "没配"。只 round-trip grant_connectors —— 其余 tool_policy 键对 report 行无语义。
    """
    r = report_client.put(
        f"/api/report-agents/{_AGENT_ID}",
        json={"tool_policy": {"v": 1, "grant_connectors": {"notion": "read"}}},
    )
    assert r.status_code == 200
    assert r.json()["data"]["tool_policy"] == {"v": 1, "grant_connectors": {"notion": "read"}}
    got = report_client.get(f"/api/report-agents?agentId={_AGENT_ID}").json()["data"]
    assert got["tool_policy"] == {"v": 1, "grant_connectors": {"notion": "read"}}


def test_report_row_rejects_delete_ceiling(report_client: TestClient, report_db: Path) -> None:
    """🔴 值域闸对 report 行同样成立：``delete`` 天花板入库即拒（不是读侧宽容）。"""
    r = report_client.put(
        f"/api/report-agents/{_AGENT_ID}",
        json={"tool_policy": {"v": 1, "grant_connectors": {"notion": "delete"}}},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_set_config_rejects_delete_and_bad_grant_connectors(
    report_client: TestClient, report_db: Path
) -> None:
    """🔴 grill Q3=B：``delete`` 天花板 **入库即拒**（400，非读侧宽容）；坏形状同拒。"""
    ReportStore(str(report_db)).create_agent("cust_c2", type="custom", enabled=True, title="C2")
    for bad_tp in (
        {"v": 1, "grant_connectors": {"notion": "delete"}},  # 值域外（MVP 不开删除）
        {"v": 1, "grant_connectors": {"notion": "admin"}},
        {"v": 1, "grant_connectors": {"notion": True}},
        {"v": 1, "grant_connectors": {"": "read"}},
        {"v": 1, "grant_connectors": ["notion"]},
        {"v": 1, "grant_connectors": "notion"},
    ):
        r = report_client.put("/api/report-agents/cust_c2", json={"tool_policy": bad_tp})
        assert r.status_code == 400, bad_tp
        assert r.json()["error"]["code"] == "E_INVALID_ARG"
    # 拒收后行上仍无 grant（坏形状没有半落库）。
    tp = report_client.get("/api/report-agents?agentId=cust_c2").json()["data"]["tool_policy"]
    assert tp is None or "grant_connectors" not in tp


def test_create_custom_agent_flag_off_rejected(report_client: TestClient, monkeypatch) -> None:
    """flag off：create type='custom' → 维持今日 E_INVALID_ARG 拒收（白名单不含 custom，字节级不变）。"""
    monkeypatch.setattr("src.api.routers.reports._custom_agents_enabled", lambda: False)
    r = report_client.post("/api/report-agents", json={"id": "cust_off", "type": "custom"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    # 白名单文案不含 custom（flag off 的允许集 = report|search|preprocess）
    assert "report|search|preprocess" in r.json()["error"]["message"]
    assert report_client.get("/api/report-agents?agentId=cust_off").status_code == 404


def test_run_now_custom_enqueues_not_path_b(
    report_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """type='custom' run-now → enqueue agent_run（路径 A）+ 返回 jobId；**不**写 report 行（非路径 B）。"""
    from src.sync.async_jobs import AsyncJobRepository

    store = ReportStore(str(report_db))
    store.create_agent("cust_run", type="custom", enabled=True, title="DMS")
    repo = AsyncJobRepository(str(report_db))
    monkeypatch.setattr("src.api.routers.reports.get_report_store", lambda: store)
    monkeypatch.setattr("src.api.routers.reports._custom_agents_enabled", lambda: True)
    monkeypatch.setattr("src.api.deps.get_job_repo", lambda: repo)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.post("/api/report-agents/cust_run/run", json={})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["agentId"] == "cust_run" and isinstance(data["jobId"], int)
    # 真入队一个 agent_run（路径 A）
    jobs = repo.list_agent_runs(agent_id="cust_run")
    assert len(jobs) == 1 and jobs[0].job_type == "agent_run"
    assert jobs[0].params["trigger_kind"] == "manual"


def test_run_now_custom_flag_off_rejected(
    report_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """flag off：type='custom' run-now → 400 E_INVALID_ARG（feature disabled），不入队。"""
    from src.sync.async_jobs import AsyncJobRepository

    store = ReportStore(str(report_db))
    store.create_agent("cust_off_run", type="custom", enabled=True)
    repo = AsyncJobRepository(str(report_db))
    monkeypatch.setattr("src.api.routers.reports.get_report_store", lambda: store)
    monkeypatch.setattr("src.api.routers.reports._custom_agents_enabled", lambda: False)
    monkeypatch.setattr("src.api.deps.get_job_repo", lambda: repo)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.post("/api/report-agents/cust_off_run/run", json={})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert "disabled" in r.json()["error"]["message"]
    assert repo.list_agent_runs(agent_id="cust_off_run") == []


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


def test_wire_agent_avatar_round_trip_and_validation() -> None:
    from src.reports import wire

    avatar = {"shape": "nova", "palette": "aurora-pink", "variant_id": "agent:v2"}
    patch = wire.config_patch_to_db({"avatar": avatar})
    assert json.loads(patch["avatar_json"]) == avatar
    assert wire.resolve_agent({"id": "x", "avatar_json": patch["avatar_json"]})["avatar"] == avatar
    assert wire.config_patch_to_db({"avatar": None})["avatar_json"] is None

    with pytest.raises(ValueError, match="avatar.shape"):
        wire.config_patch_to_db({"avatar": {"shape": "triangle", "palette": "rose-milk"}})


def test_wire_agent_avatar_bot_round_trip_and_validation() -> None:
    """第三种 kind（type='bot'，08-12 灵动头像）：合法往返 + 越域/多余键/缺键逐条拒。

    判别边界：显式 type 逐个判（image → bot），无 type 落 legacy oreo 兜底。bot 形状名
    不在 oreo 词表里 —— 若判别漂了（bot dict 落进 legacy 支）这里的往返例会立刻红。
    """
    from src.reports import wire

    avatar = {"type": "bot", "shape": "sphere", "color": "orange"}
    patch = wire.config_patch_to_db({"avatar": avatar})
    assert json.loads(patch["avatar_json"]) == avatar
    assert wire.resolve_agent({"id": "x", "avatar_json": patch["avatar_json"]})["avatar"] == avatar
    # 全词表（8×11）都能过保存闸 —— 词表本体的跨语言对账在
    # tests/config/test_bot_avatar_vocab_parity.py，这里只保证白名单与校验用的是同一份。
    for shape in wire.BOT_AVATAR_SHAPES:
        for color in wire.BOT_AVATAR_COLORS:
            assert wire.config_patch_to_db(
                {"avatar": {"type": "bot", "shape": shape, "color": color}}
            )["avatar_json"]

    # 越域 shape：oreo 的 'bloom' 不在 bot 词表（两套词表不互认）。
    with pytest.raises(ValueError, match="avatar.shape"):
        wire.config_patch_to_db({"avatar": {"type": "bot", "shape": "bloom", "color": "orange"}})
    # 越域 color。
    with pytest.raises(ValueError, match="avatar.color"):
        wire.config_patch_to_db({"avatar": {"type": "bot", "shape": "sphere", "color": "magenta"}})
    # 多余键 → 拒（bot 支不做 image 支那种静默剥键，见 wire.py 注释）。
    with pytest.raises(ValueError, match="only keys"):
        wire.config_patch_to_db(
            {"avatar": {"type": "bot", "shape": "sphere", "color": "orange", "variant_id": "x"}}
        )
    # 缺键（shape/color 各缺一例）。
    with pytest.raises(ValueError, match="avatar.color"):
        wire.config_patch_to_db({"avatar": {"type": "bot", "shape": "sphere"}})
    with pytest.raises(ValueError, match="avatar.shape"):
        wire.config_patch_to_db({"avatar": {"type": "bot", "color": "orange"}})
    # 无 type 键 + bot 形状名 → 走 legacy oreo 支并被拒（判别只看 type，不看词表命中）。
    with pytest.raises(ValueError, match="avatar.shape"):
        wire.config_patch_to_db({"avatar": {"shape": "sphere", "palette": "rose"}})


def _avatar_image_data_uri(nbytes: int, mime: str = "image/webp") -> str:
    """长度精确可控的合法 data URI（内容不必是真图片 —— wire 层只管 mime/base64/字节数）。"""
    import base64 as _b64

    return f"data:{mime};base64," + _b64.b64encode(b"\x00" * nbytes).decode("ascii")


def test_wire_agent_avatar_image_round_trip() -> None:
    """WP7 上传态：合法 data URI 原样落库 + 读回；生成式（无 type 键）逐字不受影响。"""
    from src.reports import wire

    data = _avatar_image_data_uri(1024)
    patch = wire.config_patch_to_db({"avatar": {"type": "image", "data": data}})
    assert json.loads(patch["avatar_json"]) == {"type": "image", "data": data}
    assert wire.resolve_agent({"id": "x", "avatar_json": patch["avatar_json"]})["avatar"] == {
        "type": "image",
        "data": data,
    }
    # 三个 mime 都收（客户端只发 webp，png/jpeg 是给 CLI / 手工 patch 留的口子）。
    for mime in ("image/png", "image/jpeg"):
        assert wire.config_patch_to_db(
            {"avatar": {"type": "image", "data": _avatar_image_data_uri(64, mime)}}
        )["avatar_json"]
    # 混入生成式字段（或任何多余键）只落 type/data 两键 —— 落库形状恒是判别 union 的一支，
    # 不会出现「既像图片又像生成式」的两栖行。
    mixed = wire.config_patch_to_db(
        {
            "avatar": {
                "type": "image",
                "data": data,
                "shape": "nova",
                "palette": "aurora-pink",
                "variant_id": "x",
            }
        }
    )
    assert json.loads(mixed["avatar_json"]) == {"type": "image", "data": data}
    # type=image 但缺 data → 拒（不静默降级成生成式）。
    with pytest.raises(ValueError, match="must be a non-empty data URI string"):
        wire.config_patch_to_db({"avatar": {"type": "image"}})


def test_wire_agent_avatar_image_rejects_bad_payloads() -> None:
    """坏形态逐条拒（超限 / 坏 mime / 坏 base64 / 超长串 / 锚点绕过 / 非字符串）。

    这里的每一条都对应一种「后端收下、前端渲染判别不认」或「拿无界串去解码」的失败，
    故一律要求拒绝而不是宽容规范化 —— 上传头像的唯一生产者是前端，规范形态只有一种。
    """
    from src.reports import wire

    def _reject(data: object, match: str) -> None:
        with pytest.raises(ValueError, match=match):
            wire.config_patch_to_db({"avatar": {"type": "image", "data": data}})

    # 解码后超 150KB 硬顶（长度仍在 data URI 字符上限内 → 走的是 decode 后那道闸）。
    _reject(_avatar_image_data_uri(wire.AVATAR_IMAGE_MAX_BYTES + 1), "exceeds")
    # 正好 150KB 放行（边界不是 off-by-one）。
    assert wire.config_patch_to_db(
        {"avatar": {"type": "image", "data": _avatar_image_data_uri(wire.AVATAR_IMAGE_MAX_BYTES)}}
    )["avatar_json"]
    # 坏 mime（svg 可带脚本；gif 不在白名单）。
    _reject(_avatar_image_data_uri(64, "image/svg+xml"), "must be a base64 data URI")
    _reject(_avatar_image_data_uri(64, "image/gif"), "must be a base64 data URI")
    # mime 大小写敏感（前端判别式同样区分大小写 —— 收下就等于存一张前端认不出的头像）。
    _reject(_avatar_image_data_uri(64, "IMAGE/WEBP"), "must be a base64 data URI")
    # 带参数的 data URI（`;charset=`）不在契约里。
    _reject(
        "data:image/webp;charset=utf-8;base64," + _avatar_image_data_uri(64).split(",", 1)[1],
        "must be a base64 data URI",
    )
    # 🔴 尾部换行：Python 的 `$` 会匹配「结尾换行之前」，JS 的 `$` 不会 —— 收下就等于落一条
    # 前端 isAgentAvatarImage 认不出的行（头像静默变回生成式）。锚点必须是 `\Z`。
    _reject(_avatar_image_data_uri(64) + "\n", "must be a base64 data URI")
    _reject("\n" + _avatar_image_data_uri(64), "must be a base64 data URI")
    # base64 内嵌空白/换行（b64decode 默认会宽容吃掉，validate=True + 字符集正则一起拒）。
    _reject("data:image/webp;base64,QU JD", "must be a base64 data URI")
    _reject("data:image/webp;base64,QU\nJD", "must be a base64 data URI")
    # base64url 字母表（`-_`）与三个 `=` 填充都不是标准 base64。
    _reject("data:image/webp;base64,QUJD-_==", "must be a base64 data URI")
    _reject("data:image/webp;base64,QUJDA===", "must be a base64 data URI")
    # 嵌套 data URI / 脚本 URI。
    _reject("data:image/webp;base64,data:image/webp;base64,QUJD", "must be a base64 data URI")
    _reject("javascript:alert(1)", "must be a base64 data URI")
    # 外链 URL 不是 data URI。
    _reject("https://example.test/a.png", "must be a base64 data URI")
    # 坏 base64：长度 %4==1，字符集合法但解不出。
    _reject("data:image/webp;base64,QUJDR", "not valid base64")
    # 空 payload → 正则就不过（`+` 至少一个字符）。
    _reject("data:image/webp;base64,", "must be a base64 data URI")
    # 超长字符串在 b64decode **之前**被拒（防拿无界串去解码）。
    _reject("data:image/webp;base64," + "A" * wire.AVATAR_IMAGE_MAX_DATA_URI_CHARS, "exceeds")
    # 非字符串。
    _reject(None, "must be a non-empty data URI string")
    _reject(123, "must be a non-empty data URI string")


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


def test_write_custom_report_rejects_unknown_agent(report_client: TestClient) -> None:
    """归属校验（08-02 review F6）：任意字符串不能造出归属于「不存在的 agent」的报告。

    没有这条时 Reports tab 会按 agent 分组并显示裸 id，且该组永远点不进对应配置。
    """
    resp = report_client.post(
        "/api/reports/custom",
        json={
            "agentId": "no-such-agent",
            "title": "Ghost",
            "mode": "new",
            "blocks": [{"type": "overview", "text": "x"}],
        },
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_write_custom_report_accepts_manual_chat_sentinel(report_client: TestClient) -> None:
    """manual chat 没有 owning agent，用哨兵作者写报告必须放行（它不是 report_agent 行）。"""
    resp = report_client.post(
        "/api/reports/custom",
        json={
            "agentId": MANUAL_CHAT_REPORT_AGENT_ID,
            "title": "From chat",
            "mode": "new",
            "blocks": [{"type": "overview", "text": "written from manual chat"}],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["id"].startswith(f"{MANUAL_CHAT_REPORT_AGENT_ID}:custom:")
