"""S6 W1 — GET /api/agent-runs 的 state 过滤 + GET /api/agent-runs/pending-count 契约。

读态唯一经 ``derive_agent_run_state`` 单源投影（不在此重造 status 映射）；只计 live 可批的
``paused_pending``（``paused_expired`` 不计红点）。鉴权 verify_cf_access（conftest auth bypass），
flag off → 404（S4 纪律）。fixtures 全合成：tmp SyncStore + AsyncJobRepository 注入。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import src.api.routers.agent_runs as agent_runs


@pytest.fixture()
def runs_env(tmp_path, monkeypatch):
    """tmp sync_store + AsyncJobRepository（注入 agent_runs.get_job_repo）+ flag on。"""
    from src.mail.sync_store import SyncStore
    from src.sync.async_jobs import AsyncJobRepository

    db = tmp_path / "s.db"
    SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    monkeypatch.setattr(agent_runs, "get_job_repo", lambda: repo)
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: True)
    return SimpleNamespace(db=db, repo=repo)


def _enqueue_run(repo, agent_id: str, *, status=None, result=None) -> int:
    """入队一条 agent_run（target_key=agent_id）→ 可选写终态（status + result_json）。

    status=None → 留 queued；'succeeded' + result{outcome:'paused_handoff', approval_state:'pending'}
    → paused_pending（mark_terminal 写 finished_at=now，龄 ~0 < TTL）。result 不含 sessionId 以
    避开 _annotate_auto_whitelist 的 ChatDb 依赖（合成库无 ai_chat.db）。
    """
    job_id, _ = repo.enqueue(
        job_type="agent_run", target_kind="agent", target_key=agent_id,
        params={"agent_id": agent_id},
    )
    if status is not None:
        repo.mark_terminal(job_id, status=status, result=result)
    return job_id


_PAUSED_PENDING = {"outcome": "paused_handoff", "approval_state": "pending"}
_COMPLETED = {"outcome": "completed"}


def _states(items):
    return sorted(it["state"] for it in items)


# ── state 过滤 ──────────────────────────────────────────────────────────────────


def test_list_no_state_returns_all(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)
    _enqueue_run(runs_env.repo, "b", status="failed")
    _enqueue_run(runs_env.repo, "b")  # queued

    data = client.get("/api/agent-runs").json()["data"]
    assert _states(data) == ["completed", "failed", "paused_pending", "queued"]


def test_list_state_filter_paused_pending(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "b", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)

    data = client.get("/api/agent-runs", params={"state": "paused_pending"}).json()["data"]
    assert len(data) == 2
    assert all(it["state"] == "paused_pending" for it in data)


def test_list_state_filter_completed(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)

    data = client.get("/api/agent-runs", params={"state": "completed"}).json()["data"]
    assert len(data) == 1 and data[0]["state"] == "completed"


def test_list_state_filter_empty_when_no_match(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)
    data = client.get("/api/agent-runs", params={"state": "failed"}).json()["data"]
    assert data == []


def test_list_state_filter_combines_with_agent_id(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "b", status="succeeded", result=_PAUSED_PENDING)
    data = client.get(
        "/api/agent-runs", params={"agentId": "a", "state": "paused_pending"}
    ).json()["data"]
    assert len(data) == 1 and data[0]["agentId"] == "a"


def test_list_invalid_state_400(client, runs_env):
    r = client.get("/api/agent-runs", params={"state": "bogus"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


# ── trigger 投影（L4 批次2 §2.1）──────────────────────────────────────────────────


def test_list_projects_trigger_kind_and_cron_fired_at(client, runs_env):
    """params 带 trigger_kind=cron + fire_key → triggerKind 直通，triggerFiredAtIso 解析
    fire_key 的 occurrence 时刻（与 _assemble_spec 的 firedAt 同一份 _fired_at_iso 解法）。"""
    runs_env.repo.enqueue(
        job_type="agent_run", target_kind="agent", target_key="a",
        params={"agent_id": "a", "trigger_kind": "cron", "fire_key": "20260101T090000Z"},
    )
    it = client.get("/api/agent-runs").json()["data"][0]
    assert it["triggerKind"] == "cron"
    assert it["triggerFiredAtIso"] == "2026-01-01T09:00:00+00:00"


def test_list_non_cron_trigger_kind_fired_at_falls_back_to_created_at(client, runs_env):
    """非 cron trigger_kind（如 manual）→ triggerFiredAtIso 回退 job.created_at，不解析 fire_key。"""
    from datetime import datetime, timezone

    job_id, _ = runs_env.repo.enqueue(
        job_type="agent_run", target_kind="agent", target_key="a",
        params={"agent_id": "a", "trigger_kind": "manual", "fire_key": "agent-call:1:tc"},
    )
    job = runs_env.repo.get(job_id)
    it = client.get("/api/agent-runs").json()["data"][0]
    assert it["triggerKind"] == "manual"
    assert it["triggerFiredAtIso"] == datetime.fromtimestamp(
        job.created_at, tz=timezone.utc
    ).isoformat()


def test_list_missing_trigger_kind_projects_none(client, runs_env):
    """params 无 trigger_kind（老行 / 非常规入队路径，既有 _enqueue_run helper 只写 agent_id）
    → 两字段恒 None，不臆造触发方式。"""
    _enqueue_run(runs_env.repo, "a")
    it = client.get("/api/agent-runs").json()["data"][0]
    assert it["triggerKind"] is None
    assert it["triggerFiredAtIso"] is None


# ── 分页（task 07-21：offset + meta.total）──────────────────────────────────────


def test_list_total_and_offset_pagination(client, runs_env):
    for i in range(5):
        _enqueue_run(runs_env.repo, "a")  # queued, 各带唯一 job_id

    r1 = client.get("/api/agent-runs", params={"agentId": "a", "limit": 2, "offset": 0})
    env1 = r1.json()
    assert env1["meta"]["total"] == 5
    assert env1["meta"]["limit"] == 2
    assert env1["meta"]["offset"] == 0
    assert len(env1["data"]) == 2

    r2 = client.get("/api/agent-runs", params={"agentId": "a", "limit": 2, "offset": 4})
    env2 = r2.json()
    assert len(env2["data"]) == 1
    assert env2["meta"]["total"] == 5

    ids_seen = {it["jobId"] for it in env1["data"]} | {it["jobId"] for it in env2["data"]}
    assert len(ids_seen) == 3  # 两页无重叠


def test_list_offset_out_of_range_returns_empty(client, runs_env):
    _enqueue_run(runs_env.repo, "a")
    r = client.get("/api/agent-runs", params={"agentId": "a", "offset": 999})
    env = r.json()
    assert env["data"] == []
    assert env["meta"]["total"] == 1  # 总数仍准确


def test_list_total_empty_table(client, runs_env):
    env = client.get("/api/agent-runs").json()
    assert env["data"] == []
    assert env["meta"]["total"] == 0


# ── pending-count ───────────────────────────────────────────────────────────────


def test_pending_count_total_and_by_agent(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "b", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)  # 不计
    _enqueue_run(runs_env.repo, "b", status="failed")  # 不计

    data = client.get("/api/agent-runs/pending-count").json()["data"]
    assert data["total"] == 3
    assert data["byAgent"] == {"a": 2, "b": 1}


def test_pending_count_zero_when_none_pending(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)
    _enqueue_run(runs_env.repo, "b", status="failed")

    data = client.get("/api/agent-runs/pending-count").json()["data"]
    assert data == {"total": 0, "byAgent": {}}


def test_pending_count_only_counts_paused_pending_not_expired(client, runs_env):
    # paused_expired（finished_at 远早于 TTL）不计红点：直改 finished_at 回拨到 TTL 外。
    import time

    from src.agents.run_state import APPROVAL_PENDING_TTL_SEC

    jid = _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    old = time.time() - APPROVAL_PENDING_TTL_SEC - 60
    conn = runs_env.repo._connect()
    try:
        conn.execute("UPDATE async_jobs SET finished_at=? WHERE job_id=?", (old, jid))
        conn.commit()
    finally:
        conn.close()

    # 读态应为 paused_expired（不可批）→ pending-count = 0。
    runs = client.get("/api/agent-runs").json()["data"]
    assert runs[0]["state"] == "paused_expired"
    assert client.get("/api/agent-runs/pending-count").json()["data"] == {
        "total": 0, "byAgent": {}
    }


# ── flag off（S4 纪律：feature 不存在 → 404）─────────────────────────────────────


def test_list_state_flag_off_404(client, runs_env, monkeypatch):
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    assert client.get("/api/agent-runs", params={"state": "paused_pending"}).status_code == 404


def test_pending_count_flag_off_404(client, runs_env, monkeypatch):
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    assert client.get("/api/agent-runs/pending-count").status_code == 404


# ── custom_agent_call enqueue / single-run / cancel ───────────────────────────


class _AgentStoreStub:
    def __init__(self, agent=None):
        self.agent = agent or {
            "id": "reader",
            "type": "custom",
            "enabled": True,
            "title": "Reader",
            "budget_json": None,
        }

    def get_agent(self, agent_id):
        return self.agent if agent_id == self.agent["id"] else None


def test_agent_call_enqueue_replay_reuses_job_and_original_session(
    client, runs_env, monkeypatch
):
    monkeypatch.setattr(agent_runs, "get_report_store", lambda: _AgentStoreStub())
    first = client.post(
        "/api/agent-runs/call",
        json={
            "agent_id": "reader",
            "fire_key": "agent-call:10:tc-1",
            "session_id": 22,
            "invocation": {"instruction": "summarize"},
        },
    )
    second = client.post(
        "/api/agent-runs/call",
        json={
            "agent_id": "reader",
            "fire_key": "agent-call:10:tc-1",
            "session_id": 99,
            "invocation": {"instruction": "must not replace original params"},
        },
    )
    assert first.status_code == second.status_code == 200
    one = first.json()["data"]
    two = second.json()["data"]
    assert one == {"jobId": one["jobId"], "wasCreated": True, "sessionId": 22}
    assert two == {"jobId": one["jobId"], "wasCreated": False, "sessionId": 22}
    job = runs_env.repo.get(one["jobId"])
    assert job.params["session_id"] == 22
    assert job.params["invocation"] == {"instruction": "summarize"}


def test_agent_call_enqueue_rejects_non_agent_call_fire_key(client, runs_env, monkeypatch):
    monkeypatch.setattr(agent_runs, "get_report_store", lambda: _AgentStoreStub())
    response = client.post(
        "/api/agent-runs/call",
        json={
            "agent_id": "reader",
            "fire_key": "cron:2026-08-08T09:00:00Z",
            "session_id": 22,
            "invocation": {"instruction": "summarize"},
        },
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_ARG"
    assert runs_env.repo.list_agent_runs(limit=10) == []


def test_get_single_run_projects_title_and_truncates_latest_answer(
    client, runs_env, monkeypatch
):
    monkeypatch.setattr(agent_runs, "get_report_store", lambda: _AgentStoreStub())
    answer = "x" * (agent_runs.FINAL_ANSWER_MAX_CHARS + 7)

    class _ChatDbStub:
        def get_latest_assistant_message(self, session_id):
            assert session_id == 7
            return {"content": answer}

    monkeypatch.setattr(agent_runs, "ChatDb", _ChatDbStub)
    job_id = _enqueue_run(
        runs_env.repo,
        "reader",
        status="succeeded",
        result={"outcome": "completed", "sessionId": 7, "summary": "fallback"},
    )
    response = client.get(f"/api/agent-runs/{job_id}")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["agentTitle"] == "Reader"
    assert data["finalAnswer"] == answer[: agent_runs.FINAL_ANSWER_MAX_CHARS]
    assert data["finalAnswerTruncated"] is True


def test_get_single_run_flag_off_404(client, runs_env, monkeypatch):
    job_id = _enqueue_run(runs_env.repo, "reader")
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    assert client.get(f"/api/agent-runs/{job_id}").status_code == 404


def test_cancel_queued_run_uses_cas_and_records_stopped(client, runs_env):
    job_id = _enqueue_run(runs_env.repo, "reader")
    response = client.post(f"/api/agent-runs/{job_id}/cancel")
    assert response.status_code == 200
    assert response.json()["data"] == {"cancelled": True}
    job = runs_env.repo.get(job_id)
    assert job.status == "aborted"
    assert job.result == {"outcome": "stopped", "reason": "user_cancelled"}


def test_cancel_running_run_refuses_queued_cas(client, runs_env):
    job_id = _enqueue_run(runs_env.repo, "reader")
    claimed = runs_env.repo.claim_next(types=runs_env.repo.AGENT_JOB_TYPES)
    assert claimed is not None and claimed.job_id == job_id
    response = client.post(f"/api/agent-runs/{job_id}/cancel")
    assert response.status_code == 200
    assert response.json()["data"] == {"cancelled": False, "state": "running"}
    assert runs_env.repo.get(job_id).status == "running"


# ── 免卡 badge 分源投影（S6 W3-2，ADR-004 rev3.1 §4.4 / F#3）───────────────────────
# rule-source（whitelist_rule_id 非空）与 grant-source（rule_id=null，per-tool）两桶分流。
# 🔴 投影不得假设 rule_id 非空 —— grant 级免卡（open web_fetch / web_search）行天然 null。


def _make_chat_db(tmp_path, monkeypatch):
    """合成最小 ai_chat.db（messages + tool_call 审计列）并经 AI_CHAT_DB_PATH 注入 ChatDb。"""
    import sqlite3

    p = tmp_path / "ai_chat.db"
    conn = sqlite3.connect(str(p))
    conn.executescript(
        """
        CREATE TABLE ai_chat_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL);
        CREATE TABLE chat_tool_call (
          id INTEGER PRIMARY KEY,
          message_id INTEGER NOT NULL,
          tool_name TEXT NOT NULL,
          approval_status TEXT,
          whitelist_rule_id INTEGER
        );
        """
    )
    conn.commit()
    conn.close()
    monkeypatch.setenv("AI_CHAT_DB_PATH", str(p))
    return p


def _insert_audit(db_path, session_id: int, rows) -> None:
    """rows = [(tool_name, approval_status, whitelist_rule_id), ...] 归到一条消息。"""
    import sqlite3

    conn = sqlite3.connect(str(db_path))
    cur = conn.execute(
        "INSERT INTO ai_chat_messages (session_id) VALUES (?)", (session_id,)
    )
    mid = cur.lastrowid
    conn.executemany(
        "INSERT INTO chat_tool_call (message_id, tool_name, approval_status, whitelist_rule_id) "
        "VALUES (?, ?, ?, ?)",
        [(mid, t, s, r) for t, s, r in rows],
    )
    conn.commit()
    conn.close()


def test_auto_whitelist_breakdown_splits_rule_vs_grant(client, runs_env, tmp_path, monkeypatch):
    """rule_id 非空 → rule 桶；rule_id=null → grant 桶（per-tool）；total 两源合计。"""
    db = _make_chat_db(tmp_path, monkeypatch)
    _insert_audit(
        db, 7,
        [
            ("run_command", "auto_whitelist", 5),   # rule-source（exec 白名单规则命中）
            ("run_command", "auto_whitelist", 5),
            ("web_fetch", "auto_whitelist", None),  # grant-source（open 档）
            ("web_search", "auto_whitelist", None),  # grant-source（搜索授权）
            ("web_search", "auto_whitelist", None),
            ("web_search", "auto_whitelist", None),
            ("email_flag", "approved", None),        # 人批行不计
        ],
    )
    _enqueue_run(
        runs_env.repo, "a", status="succeeded",
        result={"outcome": "completed", "sessionId": 7},
    )

    it = client.get("/api/agent-runs").json()["data"][0]
    assert it["autoWhitelistedWrites"] == 6
    assert it["autoWhitelistedBreakdown"] == {
        "rule": 2, "grant": {"web_fetch": 1, "web_search": 3},
    }


def test_auto_whitelist_breakdown_zero_vs_unreachable(client, runs_env, tmp_path, monkeypatch):
    """账本可达且无命中 → 0/空桶（显式无免卡）；无 sessionId → 两字段均 null（不渲染 ≠ 0）。"""
    _make_chat_db(tmp_path, monkeypatch)
    _enqueue_run(
        runs_env.repo, "a", status="succeeded",
        result={"outcome": "completed", "sessionId": 9},  # 会话存在于账本域但零审计行
    )
    _enqueue_run(runs_env.repo, "b", status="succeeded", result=_COMPLETED)  # 无 sessionId

    data = client.get("/api/agent-runs").json()["data"]
    by_agent = {it["agentId"]: it for it in data}
    assert by_agent["a"]["autoWhitelistedWrites"] == 0
    assert by_agent["a"]["autoWhitelistedBreakdown"] == {"rule": 0, "grant": {}}
    assert by_agent["b"]["autoWhitelistedWrites"] is None
    assert by_agent["b"]["autoWhitelistedBreakdown"] is None


def test_auto_whitelist_breakdown_ledger_missing_is_null(client, runs_env, tmp_path, monkeypatch):
    """ai_chat.db 文件不存在 → count 返 None → 两字段降级 null（渲染 0 就是谎报）。"""
    monkeypatch.setenv("AI_CHAT_DB_PATH", str(tmp_path / "missing.db"))
    _enqueue_run(
        runs_env.repo, "a", status="succeeded",
        result={"outcome": "completed", "sessionId": 7},
    )
    it = client.get("/api/agent-runs").json()["data"][0]
    assert it["autoWhitelistedWrites"] is None
    assert it["autoWhitelistedBreakdown"] is None
