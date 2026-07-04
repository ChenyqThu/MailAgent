"""agent-runs spec 面 + approval-state 端点 REST 单测（S4 W2, ADR D2/D4）。

覆盖：CAS one-shot（双 pull 409 / 错 token 403 不消费 / 非 running 409 / 非 agent 404）+ spec
组装（cron/email 形状 + envelope 围栏 + budget clamp + 坏 agent 配置 409）+ approval 迁移 +
flag-off 404。用真实 FastAPI app + TestClient；deps monkeypatch 到临时 DB。
"""
from __future__ import annotations

import os
import sqlite3
import tempfile

# --- MUST run before importing src.api.* (import-time env reads) --------------
os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")
os.environ.setdefault(
    "MAILAGENT_AGENT_CONFIG_DB_PATH",
    os.path.join(tempfile.mkdtemp(prefix="mailagent-test-s4-"), "agent_config.db"),
)

import json  # noqa: E402
from types import SimpleNamespace  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# 🔴 先 import app（末尾会 include 所有 router，完整初始化 agent_runs），再取 agent_runs
# 模块——反过来会撞循环导入（agent_runs 顶层 from src.api.app import 触发 app include_router
# agent_runs.router，此刻 agent_runs 尚未定义 router）。
from src.api.app import app  # noqa: E402
import src.api.routers.agent_runs as agent_runs  # noqa: E402
from src.mail.sync_store import SyncStore  # noqa: E402
from src.reports.store import ReportStore  # noqa: E402
from src.sync.async_jobs import AsyncJobRepository  # noqa: E402


# ---------------------------------------------------------------------------
# fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def env(tmp_path, monkeypatch):
    db = tmp_path / "s.db"
    SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    store = ReportStore(str(db))
    monkeypatch.setattr(agent_runs, "get_job_repo", lambda: repo)
    monkeypatch.setattr(agent_runs, "get_report_store", lambda: store)
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: True)
    return SimpleNamespace(db=db, repo=repo, store=store)


@pytest.fixture
def client():
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _seed_custom(store, agent_id="dms", *, trigger=None, budget=None, tool_policy=None,
                 fallback=None, prompt="Approve the DMS request", enabled=True,
                 title="DMS Approver", model=None):
    store.create_agent(agent_id, type="custom", enabled=enabled, title=title,
                       prompt=prompt, model=model)
    patch = {}
    if trigger is not None:
        patch["trigger_json"] = json.dumps(trigger)
    if budget is not None:
        patch["budget_json"] = json.dumps(budget)
    if tool_policy is not None:
        patch["tool_policy_json"] = json.dumps(tool_policy)
    if fallback is not None:
        patch["fallback_models_json"] = json.dumps(fallback)
    if patch:
        store.update_agent(agent_id, patch)


def _running_job(repo, *, agent_id="dms", trigger_kind="cron",
                 fire_key="20260703T090000Z", email_internal_id=None, token="tok-1",
                 claim=True):
    params = {"agent_id": agent_id, "trigger_kind": trigger_kind, "fire_key": fire_key}
    if email_internal_id is not None:
        params["email_internal_id"] = email_internal_id
    job_id, _ = repo.enqueue(
        job_type="agent_run", target_kind="agent", target_key=agent_id,
        params=params, idempotency_key=f"k-{agent_id}-{fire_key}",
    )
    if claim:
        repo.claim_next(types=repo.AGENT_JOB_TYPES)  # → running
    repo.set_claim_token(job_id, token)
    return job_id


_CRON = {"v": 1, "kind": "cron", "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai"}
_EMAIL = {"v": 1, "kind": "email_filter", "subject_pattern": "DMS.*审批",
          "sender_pattern": "dms@corp\\.com", "folders": ["收件箱"]}


# ---------------------------------------------------------------------------
# spec 组装形状
# ---------------------------------------------------------------------------


def test_spec_cron_full_shape(env, client):
    _seed_custom(env.store, trigger=_CRON, budget={"v": 1, "max_steps": 6, "max_run_seconds": 120},
                 model="claude-sonnet-5")
    job_id = _running_job(env.repo)
    r = client.get(f"/api/agent-runs/{job_id}/spec", headers={"X-Claim-Token": "tok-1"})
    assert r.status_code == 200
    spec = r.json()["data"]
    assert spec["jobId"] == job_id
    assert spec["agentId"] == "dms"
    assert spec["trigger"]["kind"] == "cron"
    assert spec["trigger"]["firedAt"].startswith("2026-07-03T09:00:00")
    assert "emailInternalId" not in spec["trigger"]  # cron 不带
    assert spec["prompt"]["taskPrompt"] == "Approve the DMS request"
    assert "emailEnvelope" not in spec["prompt"]  # cron 无 envelope
    assert spec["model"] == "claude-sonnet-5"
    assert spec["budget"] == {"maxSteps": 6, "maxRunSeconds": 120}
    # S5 ADR-004 §5.1（显式修订 ADR-003 D6）：未配 tool_policy → 投影**默认安全集**（非「不收窄」）。
    assert spec["toolPolicy"] == {
        "allowedTools": list(agent_runs.DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS)
    }
    assert spec["sessionTitle"].startswith("DMS Approver · ")


def test_spec_email_carries_fenced_envelope(env, client, monkeypatch):
    _seed_custom(env.store, trigger=_EMAIL, tool_policy={"v": 1, "allowed_tools": ["email_get", "email_body"]})
    job_id = _running_job(env.repo, trigger_kind="email_filter", fire_key="777",
                          email_internal_id=777)
    stub_meta = SimpleNamespace(
        subject="DMS 审批 pending", sender="dms@corp.com", sender_name="DMS Bot",
        date_received="2026-07-03 09:00:00",
    )

    class _StubRepo:
        def get_metadata(self, iid):
            assert iid == 777
            return stub_meta

        def get_body_markdown(self, iid, max_chars=-1):
            return "Please approve request #42"

    monkeypatch.setattr(agent_runs, "get_repository", lambda: _StubRepo())
    r = client.get(f"/api/agent-runs/{job_id}/spec", headers={"X-Claim-Token": "tok-1"})
    assert r.status_code == 200
    spec = r.json()["data"]
    assert spec["trigger"]["kind"] == "email_filter"
    assert spec["trigger"]["emailInternalId"] == 777
    assert spec["trigger"]["matchedRule"]["subjectPattern"] == "DMS.*审批"
    env_block = spec["prompt"]["emailEnvelope"]
    assert env_block.startswith("UNTRUSTED_EMAIL_BODY_START id=777\n")
    assert env_block.endswith("\nUNTRUSTED_EMAIL_BODY_END")
    assert "DMS Bot <dms@corp.com>" in env_block
    assert "Please approve request #42" in env_block
    assert spec["toolPolicy"] == {"allowedTools": ["email_get", "email_body"]}


def test_spec_tool_policy_three_states_and_grant_exec(env, client):
    """S5 ADR-004 §5.1 投影三态 + grantExec 判别（P1-4）：NULL → 默认安全集；显式列表 →
    verbatim（上一测试已盖）；显式 [] → 空集。grantExec 仅 parse 后字面 True 才输出。"""
    # 显式 [] → 空集（owner 显式选零工具，非默认集）。
    _seed_custom(env.store, agent_id="a_empty", trigger=_CRON,
                 tool_policy={"v": 1, "allowed_tools": []})
    jid = _running_job(env.repo, agent_id="a_empty", token="te")
    d = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "te"}).json()["data"]
    assert d["toolPolicy"] == {"allowedTools": []}

    # grant_exec: true → grantExec 投影 True。
    _seed_custom(env.store, agent_id="a_grant", trigger=_CRON,
                 tool_policy={"v": 1, "allowed_tools": ["email_get"], "grant_exec": True})
    jid2 = _running_job(env.repo, agent_id="a_grant", token="tg")
    d2 = client.get(f"/api/agent-runs/{jid2}/spec", headers={"X-Claim-Token": "tg"}).json()["data"]
    assert d2["toolPolicy"] == {"allowedTools": ["email_get"], "grantExec": True}

    # grant_exec: false → 键不投影。
    _seed_custom(env.store, agent_id="a_nogrant", trigger=_CRON,
                 tool_policy={"v": 1, "allowed_tools": ["email_get"], "grant_exec": False})
    jid3 = _running_job(env.repo, agent_id="a_nogrant", token="tn")
    d3 = client.get(f"/api/agent-runs/{jid3}/spec", headers={"X-Claim-Token": "tn"}).json()["data"]
    assert d3["toolPolicy"] == {"allowedTools": ["email_get"]}

    # 坏形状（grant_exec:"yes" —— 保存闸之外手工入库）→ 读侧宽容落未配置语义：默认安全集 +
    # 无 grantExec（junk 永不投影成授权，P1-4 负例）。
    _seed_custom(env.store, agent_id="a_junk", trigger=_CRON,
                 tool_policy={"v": 1, "allowed_tools": ["email_get"], "grant_exec": "yes"})
    jid4 = _running_job(env.repo, agent_id="a_junk", token="tj")
    d4 = client.get(f"/api/agent-runs/{jid4}/spec", headers={"X-Claim-Token": "tj"}).json()["data"]
    assert d4["toolPolicy"] == {
        "allowedTools": list(agent_runs.DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS)
    }


def test_spec_budget_defaults_and_clamp(env, client):
    # 无 budget → 全默认（maxSteps 8 / maxRunSeconds 300）
    _seed_custom(env.store, agent_id="a_default", trigger=_CRON)
    jid = _running_job(env.repo, agent_id="a_default", token="t2")
    d = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "t2"}).json()["data"]
    assert d["budget"] == {"maxSteps": 8, "maxRunSeconds": 300}
    # max_steps 越界 → clamp ≤16
    _seed_custom(env.store, agent_id="a_clamp", trigger=_CRON,
                 budget={"v": 1, "max_steps": 999, "max_run_seconds": 999999})
    jid2 = _running_job(env.repo, agent_id="a_clamp", token="t3")
    d2 = client.get(f"/api/agent-runs/{jid2}/spec", headers={"X-Claim-Token": "t3"}).json()["data"]
    assert d2["budget"]["maxSteps"] == 16
    assert d2["budget"]["maxRunSeconds"] == 1800  # MAX_RUN_SECONDS_CEILING


def test_spec_includes_fallback_models_when_set(env, client):
    _seed_custom(env.store, trigger=_CRON, fallback=["claude-haiku-4-5", "claude-opus-4-8"])
    jid = _running_job(env.repo)
    d = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "tok-1"}).json()["data"]
    assert d["fallbackModels"] == ["claude-haiku-4-5", "claude-opus-4-8"]


# ---------------------------------------------------------------------------
# CAS one-shot
# ---------------------------------------------------------------------------


def test_double_pull_second_is_409(env, client):
    _seed_custom(env.store, trigger=_CRON)
    jid = _running_job(env.repo)
    r1 = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "tok-1"})
    r2 = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "tok-1"})
    assert r1.status_code == 200
    assert r2.status_code == 409
    assert r2.json()["error"]["code"] == "E_SPEC_ALREADY_CLAIMED"


def test_wrong_token_403_and_not_consumed(env, client):
    _seed_custom(env.store, trigger=_CRON)
    jid = _running_job(env.repo, token="real")
    bad = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "WRONG"})
    assert bad.status_code == 403
    assert bad.json()["error"]["code"] == "E_SPEC_FORBIDDEN"
    # 未消费 spec_claimed_at → 正确 token 仍 200
    ok = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "real"})
    assert ok.status_code == 200


def test_missing_token_header_403(env, client):
    _seed_custom(env.store, trigger=_CRON)
    jid = _running_job(env.repo)
    r = client.get(f"/api/agent-runs/{jid}/spec")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_SPEC_FORBIDDEN"


def test_non_running_job_409(env, client):
    _seed_custom(env.store, trigger=_CRON)
    # 不 claim（queued 态）但设 token → CAS 要求 running → 409
    jid = _running_job(env.repo, claim=False, token="t")
    r = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "t"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_SPEC_ALREADY_CLAIMED"


def test_missing_job_404(env, client):
    r = client.get("/api/agent-runs/999999/spec", headers={"X-Claim-Token": "x"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_SPEC_NOT_FOUND"


def test_non_agent_job_404(env, client):
    jid, _ = env.repo.enqueue(job_type="resync", target_kind="ids", target_key="ids:1",
                              idempotency_key="m1")
    r = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "x"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_SPEC_NOT_FOUND"


# ---------------------------------------------------------------------------
# 坏 agent 配置 → 409 E_SPEC_AGENT_INVALID
# ---------------------------------------------------------------------------


def test_agent_disabled_409(env, client):
    _seed_custom(env.store, trigger=_CRON, enabled=False)
    jid = _running_job(env.repo)
    r = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "tok-1"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_SPEC_AGENT_INVALID"


def test_agent_missing_409(env, client):
    # job 引用不存在的 agent_id（未 create）
    jid = _running_job(env.repo, agent_id="ghost")
    r = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "tok-1"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_SPEC_AGENT_INVALID"


def test_agent_non_custom_type_409(env, client):
    env.store.create_agent("report1", type="report", enabled=True, title="R")
    jid = _running_job(env.repo, agent_id="report1")
    r = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "tok-1"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_SPEC_AGENT_INVALID"


def test_agent_bad_trigger_json_409(env, client):
    # 直插坏 trigger_json（绕 set_config 校验，模拟历史坏行）→ 运行时 fail-closed 409
    _seed_custom(env.store, trigger=None)
    conn = sqlite3.connect(str(env.db))
    conn.execute("UPDATE report_agent SET trigger_json=? WHERE id='dms'",
                 ('{"v":1,"kind":"cron","cron":"not a cron"}',))
    conn.commit()
    conn.close()
    jid = _running_job(env.repo)
    r = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "tok-1"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_SPEC_AGENT_INVALID"


def test_spec_claimed_at_written_as_float(env, client):
    _seed_custom(env.store, trigger=_CRON)
    jid = _running_job(env.repo)
    client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "tok-1"})
    conn = sqlite3.connect(str(env.db))
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT spec_claimed_at FROM async_jobs WHERE job_id=?", (jid,)).fetchone()
    conn.close()
    assert isinstance(row["spec_claimed_at"], float)


# ---------------------------------------------------------------------------
# approval-state 回写
# ---------------------------------------------------------------------------


def _paused_job(env, agent_id="dms"):
    """一个 paused_handoff 终态 job（result.approval_state=pending）——审批结算的前置态。"""
    _seed_custom(env.store, agent_id=agent_id, trigger=_CRON)
    jid = _running_job(env.repo, agent_id=agent_id)
    env.repo.mark_terminal(jid, status="succeeded",
                           result={"sessionId": 3, "outcome": "paused_handoff",
                                   "approval_state": "pending"})
    return jid


def test_approval_pending_to_approved(env, client):
    jid = _paused_job(env)
    r = client.post(f"/api/agent-runs/{jid}/approval-state", json={"state": "approved"})
    assert r.status_code == 200
    assert r.json()["data"] == {"jobId": jid, "approvalState": "approved", "idempotent": False}
    assert env.repo.get(jid).result["approval_state"] == "approved"


def test_approval_idempotent_same_value(env, client):
    jid = _paused_job(env)
    client.post(f"/api/agent-runs/{jid}/approval-state", json={"state": "rejected"})
    r2 = client.post(f"/api/agent-runs/{jid}/approval-state", json={"state": "rejected"})
    assert r2.status_code == 200
    assert r2.json()["data"]["idempotent"] is True


def test_approval_conflict_after_settled_409(env, client):
    jid = _paused_job(env)
    client.post(f"/api/agent-runs/{jid}/approval-state", json={"state": "approved"})
    # 已 approved 再 reject → 不可迁移 409
    r = client.post(f"/api/agent-runs/{jid}/approval-state", json={"state": "rejected"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_APPROVAL_NOT_PENDING"


def test_approval_no_pending_409(env, client):
    _seed_custom(env.store, trigger=_CRON)
    jid = _running_job(env.repo)
    env.repo.mark_terminal(jid, status="succeeded", result={"sessionId": 1})  # 无 approval_state
    r = client.post(f"/api/agent-runs/{jid}/approval-state", json={"state": "approved"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_APPROVAL_NOT_PENDING"


def test_approval_missing_job_404(env, client):
    r = client.post("/api/agent-runs/999999/approval-state", json={"state": "approved"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_SPEC_NOT_FOUND"


def test_approval_invalid_state_422(env, client):
    jid = _paused_job(env)
    r = client.post(f"/api/agent-runs/{jid}/approval-state", json={"state": "maybe"})
    assert r.status_code == 422  # pydantic Literal 校验


# ---------------------------------------------------------------------------
# flag-off → 404
# ---------------------------------------------------------------------------


def test_flag_off_spec_404(env, client, monkeypatch):
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    _seed_custom(env.store, trigger=_CRON)
    jid = _running_job(env.repo)
    r = client.get(f"/api/agent-runs/{jid}/spec", headers={"X-Claim-Token": "tok-1"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_flag_off_approval_404(env, client, monkeypatch):
    jid = _paused_job(env)
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    r = client.post(f"/api/agent-runs/{jid}/approval-state", json={"state": "approved"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


# ---------------------------------------------------------------------------
# run 历史列表（S5 W1）—— derive_agent_run_state 单源投影 + agent_id 过滤 + flag-off 404
# ---------------------------------------------------------------------------


def _terminal_run(env, *, agent_id, fire_key, status, result=None, last_error=None):
    """enqueue + claim + mark_terminal 一个 agent_run → 供 run 历史投影测。"""
    jid = _running_job(env.repo, agent_id=agent_id, fire_key=fire_key, token=f"t-{fire_key}")
    env.repo.mark_terminal(jid, status=status, result=result, last_error=last_error)
    return jid


def test_list_runs_empty(env, client):
    r = client.get("/api/agent-runs")
    assert r.status_code == 200
    assert r.json()["data"] == []


def test_list_runs_state_projection(env, client):
    """4 态（completed/failed/paused_pending/queued）→ derive_agent_run_state 投影穿过端点。"""
    _terminal_run(env, agent_id="dms", fire_key="f-ok",
                  status="succeeded", result={"outcome": "completed", "sessionId": 11})
    _terminal_run(env, agent_id="dms", fire_key="f-err",
                  status="failed", last_error="E_GATEWAY_DOWN")
    _terminal_run(env, agent_id="dms", fire_key="f-pause", status="succeeded",
                  result={"outcome": "paused_handoff", "approval_state": "pending", "sessionId": 22})
    _running_job(env.repo, agent_id="dms", fire_key="f-q", token="tq", claim=False)  # queued

    r = client.get("/api/agent-runs?agentId=dms")
    assert r.status_code == 200
    items = r.json()["data"]
    assert {it["state"] for it in items} == {"completed", "failed", "paused_pending", "queued"}
    # 🔴 paused_handoff 行读态**非** completed（P6 不变量：永不渲染为成功完成）
    pause = next(it for it in items if it["outcome"] == "paused_handoff")
    assert pause["state"] == "paused_pending"
    assert pause["approvalState"] == "pending"
    assert pause["sessionId"] == 22
    ok = next(it for it in items if it["state"] == "completed")
    assert ok["sessionId"] == 11 and ok["error"] is None
    err = next(it for it in items if it["state"] == "failed")
    assert err["error"] == "E_GATEWAY_DOWN"


def test_list_runs_agent_id_filter(env, client):
    _terminal_run(env, agent_id="dms", fire_key="a1",
                  status="succeeded", result={"outcome": "completed"})
    _terminal_run(env, agent_id="other", fire_key="b1",
                  status="succeeded", result={"outcome": "completed"})
    items = client.get("/api/agent-runs?agentId=dms").json()["data"]
    assert len(items) == 1 and items[0]["agentId"] == "dms"
    all_items = client.get("/api/agent-runs").json()["data"]
    assert {it["agentId"] for it in all_items} == {"dms", "other"}


def test_list_runs_limit_and_order(env, client):
    for i in range(5):
        _terminal_run(env, agent_id="dms", fire_key=f"o{i}",
                      status="succeeded", result={"outcome": "completed"})
    items = client.get("/api/agent-runs?agentId=dms&limit=3").json()["data"]
    assert len(items) == 3
    jids = [it["jobId"] for it in items]
    assert jids == sorted(jids, reverse=True)  # created_at desc（新 job 在前）


def test_flag_off_list_runs_404(env, client, monkeypatch):
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    r = client.get("/api/agent-runs?agentId=dms")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


# ---------------------------------------------------------------------------
# run 历史免卡计数投影（S5 W5b, ADR-004 D6）—— autoWhitelistedWrites 三态
# ---------------------------------------------------------------------------

# 最小 ai_chat.db 形状（仅本投影 join 触及的列；approval_status/whitelist_rule_id = CHAT_DB v18）。
_CHAT_DDL = """
CREATE TABLE ai_chat_sessions (id INTEGER PRIMARY KEY, backend_kind TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE ai_chat_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE chat_tool_call (id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL,
    tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
    status TEXT NOT NULL, confirmation_tier TEXT NOT NULL,
    approval_status TEXT, whitelist_rule_id INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
"""


def _seed_chat_db(path, *, session_calls: dict[int, list]) -> None:
    """{session_id: [approval_status, ...]} → 每 session 一条消息 + 逐 status 一行 tool_call。"""
    conn = sqlite3.connect(str(path))
    conn.executescript(_CHAT_DDL)
    mid = 0
    for sid, statuses in session_calls.items():
        mid += 1
        conn.execute(
            "INSERT INTO ai_chat_sessions (id, backend_kind, created_at, updated_at) "
            "VALUES (?, 'ai-sdk', 1, 1)", (sid,))
        conn.execute(
            "INSERT INTO ai_chat_messages (id, session_id, role, content, status, "
            "created_at, updated_at) VALUES (?, ?, 'assistant', '', 'complete', 1, 1)",
            (mid, sid))
        for i, st in enumerate(statuses):
            conn.execute(
                "INSERT INTO chat_tool_call (message_id, tool_use_id, tool_name, input_json, "
                "status, confirmation_tier, approval_status, whitelist_rule_id, created_at, "
                "updated_at) VALUES (?, ?, 'email_flag', '{}', 'ok', 'preview', ?, ?, 1, 1)",
                (mid, f"tu_{sid}_{i}", st, 7 if st == "auto_whitelist" else None))
    conn.commit()
    conn.close()


def test_list_runs_auto_whitelist_count(env, client, tmp_path, monkeypatch):
    """账本可达：有 sessionId 的行计数（auto_whitelist 行数，其它 approval_status 不计入；
    0 = 显式无免卡写）；无 sessionId 的行恒 null（无从归账）。"""
    chat_db = tmp_path / "ai_chat.db"
    _seed_chat_db(chat_db, session_calls={
        11: ["auto_whitelist", "auto_whitelist", "approved", None],
        22: ["approved"],
    })
    monkeypatch.setenv("AI_CHAT_DB_PATH", str(chat_db))

    _terminal_run(env, agent_id="dms", fire_key="aw1",
                  status="succeeded", result={"outcome": "completed", "sessionId": 11})
    _terminal_run(env, agent_id="dms", fire_key="aw2",
                  status="succeeded", result={"outcome": "completed", "sessionId": 22})
    _terminal_run(env, agent_id="dms", fire_key="aw3",
                  status="failed", last_error="E_GATEWAY_DOWN")  # 无 sessionId

    items = {it["sessionId"]: it for it in
             client.get("/api/agent-runs?agentId=dms").json()["data"]}
    assert items[11]["autoWhitelistedWrites"] == 2
    assert items[22]["autoWhitelistedWrites"] == 0
    assert items[None]["autoWhitelistedWrites"] is None


def test_list_runs_auto_whitelist_null_when_chat_db_missing(env, client, tmp_path, monkeypatch):
    """账本不可达（库不存在）→ 字段 null 降级（绝不渲染成「0 次免卡」谎报），run 历史本体照常。"""
    monkeypatch.setenv("AI_CHAT_DB_PATH", str(tmp_path / "nonexistent" / "ai_chat.db"))
    _terminal_run(env, agent_id="dms", fire_key="nx1",
                  status="succeeded", result={"outcome": "completed", "sessionId": 11})
    items = client.get("/api/agent-runs?agentId=dms").json()["data"]
    assert len(items) == 1
    assert items[0]["state"] == "completed"
    assert items[0]["autoWhitelistedWrites"] is None
