"""POST /api/skills/invoke —— email_search / report_run / report_get 闭环 + no-fork。

DoD ③：invoke 调通 email_search、report_run（拿 report_id）、report_get（取详情），
且 invoke 主路径无 run_cli。
"""

from __future__ import annotations


from tests.api.conftest import EMAIL_ID


def test_invoke_email_search(skill_client):
    """email_search 命中 conftest 播的 "redis timeout" 邮件。"""
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "search", "tool": "email_search", "input": {"q": "redis"}},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    ids = [it["internal_id"] for it in data["items"]]
    assert EMAIL_ID in ids
    assert data["total_matches"] >= 1
    assert "has_more" in data


def test_invoke_report_get(skill_client):
    """report_get 取到 conftest 播的 rep-1（含 doc + counts）。"""
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_get", "input": {"report_id": "rep-1"}},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["id"] == "rep-1"
    assert data["headline"] == "3 emails today"
    assert data["counts"] == {"total": 3}
    assert "doc" in data


def test_invoke_report_get_not_found(skill_client):
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_get", "input": {"report_id": "nope"}},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_invoke_report_run_then_get(skill_client, monkeypatch):
    """report_run（monkeypatch run_report_once）拿到 report_id → report_get 取详情。"""

    async def _fake_run(*, store, db_path, agent, **kwargs):
        rid = "rep-generated"
        store.create_report(
            report_id=rid,
            agent_id=agent["id"],
            cadence="daily",
            report_date="2026-06-02",
            window_start="2026-06-02T00:00:00Z",
            window_end="2026-06-03T00:00:00Z",
        )
        store.finish_report(
            rid, status="ready", headline="generated digest", blocks_json='{"blocks": []}',
            counts_json='{"total": 1}',
        )
        return rid

    monkeypatch.setattr("src.reports.worker.run_report_once", _fake_run)

    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_run", "input": {"agent_id": "daily"}},
    )
    assert r.status_code == 200, r.text
    run_data = r.json()["data"]
    rid = run_data["report_id"]
    assert rid == "rep-generated"
    assert run_data["status"] == "ready"

    r2 = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_get", "input": {"report_id": rid}},
    )
    assert r2.status_code == 200
    assert r2.json()["data"]["headline"] == "generated digest"


def test_invoke_unknown_tool_404(skill_client):
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "search", "tool": "nope", "input": {}},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_invoke_missing_required_arg_400(skill_client):
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "search", "tool": "email_search", "input": {}},
    )
    assert r.status_code in (400, 422)
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_invoke_path_does_not_fork_cli(skill_client, monkeypatch):
    """invoke 主路径无 run_cli：把 cli_runner.run_cli 换成炸弹，email_search/report 仍成功。"""

    async def _boom(*a, **k):  # pragma: no cover - 不应被调用
        raise AssertionError("invoke path must NOT fork the mailagent CLI")

    monkeypatch.setattr("src.api.cli_runner.run_cli", _boom)

    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "search", "tool": "email_search", "input": {"q": "redis"}},
    )
    assert r.status_code == 200, r.text
    r2 = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "report", "tool": "report_get", "input": {"report_id": "rep-1"}},
    )
    assert r2.status_code == 200
