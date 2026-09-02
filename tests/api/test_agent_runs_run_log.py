"""POST /api/agent-runs/run-log（g1 群聊）—— gateway 回写一行统一台账。

群成员的 spoke turn 经这条 loopback 镜像进 ``agent_run_log``，团队页的执行记录列因此看得见
「谁在群里说了什么」（AC6）。覆盖：写一行后 ``GET /api/agent-runs?agentId=`` 能查到（走
``_run_log_item`` 投影）/ status 值域（🔴 **没有 'stopped'** —— run_log.py:44 的四值，表 CHECK
会拒）/ step kind 值域 / flag off → 404。

🔴 鉴权 = ``verify_local_token``（gateway 内部回写面，不是 renderer 调用面）；conftest 的
auth bypass 让两条腿都放行，这里只钉值域与投影。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import src.api.routers.agent_runs as agent_runs
from src.agents.run_log import AGENT_RUN_LOG_STATUS_VALUES


@pytest.fixture()
def runs_env(tmp_path, monkeypatch):
    from src.mail.sync_store import SyncStore
    from src.sync.async_jobs import AsyncJobRepository

    db = tmp_path / "s.db"
    SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    monkeypatch.setattr(agent_runs, "get_job_repo", lambda: repo)
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: True)
    return SimpleNamespace(db=db, repo=repo)


def _body(**over):
    body = {
        "agentId": "a1",
        "startedAtMs": 1_700_000_000_000,
        "completedAtMs": 1_700_000_001_000,
        "status": "completed",
        "triggerKind": "group_chat",
        "triggerDetail": "session:7;chain:12;run:r-1",
        "summary": "我同意上面的方案",
        "model": "claude-sonnet-4-6",
        "inputTokens": 1200,
        "outputTokens": 90,
        "steps": [
            {"kind": "trig", "name": "群聊唤醒", "detail": "窗口 #10-#18"},
            {"kind": "out", "name": "发言", "detail": "message:42", "ok": True},
        ],
    }
    body.update(over)
    return body


def test_post_run_log_lands_and_is_listable(client, runs_env):
    res = client.post("/api/agent-runs/run-log", json=_body())
    assert res.status_code == 200
    run_log_id = res.json()["data"]["runLogId"]
    assert isinstance(run_log_id, int)

    items = client.get("/api/agent-runs", params={"agentId": "a1"}).json()["data"]
    mirrored = [it for it in items if it.get("kind") == "run_log"]
    assert len(mirrored) == 1
    item = mirrored[0]
    assert item["agentId"] == "a1"
    assert item["state"] == "completed"
    assert item["summary"] == "我同意上面的方案"
    assert item["runLogId"] == run_log_id

    steps = client.get(f"/api/agent-runs/run-log/{run_log_id}/steps").json()["data"]["steps"]
    assert [s["kind"] for s in steps] == ["trig", "out"]
    assert steps[0]["detail"] == "窗口 #10-#18"


def test_status_stopped_is_rejected(client, runs_env):
    """🔴 'stopped' 不在 run_log 的值域里（run_log.py 的四值 = sync_store CHECK 的来源）。

    设计三原稿曾把它当合法状态 —— 那样写进去的行会被表 CHECK 拒，而调用方是 best-effort
    镜像（只 warn），结果是「台账里悄悄少了一整类 run」。端点在这里 400，让越域可见。
    """
    assert "stopped" not in AGENT_RUN_LOG_STATUS_VALUES
    res = client.post("/api/agent-runs/run-log", json=_body(status="stopped"))
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"


def test_unknown_status_and_step_kind_rejected(client, runs_env):
    for bad in ("done", "COMPLETED", "", "held_dup"):
        res = client.post("/api/agent-runs/run-log", json=_body(status=bad))
        assert res.status_code == 400, f"status={bad!r}"
    res = client.post(
        "/api/agent-runs/run-log", json=_body(steps=[{"kind": "speak", "name": "x"}])
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"


def test_every_allowed_status_accepted(client, runs_env):
    for status in AGENT_RUN_LOG_STATUS_VALUES:
        res = client.post("/api/agent-runs/run-log", json=_body(status=status, steps=[]))
        assert res.status_code == 200, f"status={status!r} should be accepted"


def test_flag_off_404(client, runs_env, monkeypatch):
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    res = client.post("/api/agent-runs/run-log", json=_body())
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "E_NOT_FOUND"
