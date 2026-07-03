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
    assert spec["toolPolicy"] == {}  # 未配 tool_policy → 不额外收窄
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
