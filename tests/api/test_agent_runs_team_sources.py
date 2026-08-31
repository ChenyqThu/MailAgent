"""L4 P4a —— `GET /api/agent-runs?agentId=` 的成员 → 记录来源映射。

团队页的记录列要按成员列执行记录, 而记录散在三处: `async_jobs(job_type='agent_run')`
(自定义 agent)、`async_jobs(job_type='contact_governance')` (通讯录治理, target_key 是
`'global'` **不是** agent id)、`contact_profile_run` 台账 (联系人画像, 压根不走 async_jobs)。
映射表在 `src.agents.run_sources`。

盯四件事:
① 治理 run 能按 `contact_governance_agent` 查到, 且行上的 agentId 回填成成员 id;
② 🔴 事项域 (`matter:` / `matter_item:` 命名空间与两个 matter job_type) **恒不进**团队页
   口径 —— 空集不是报错, 也不是「碰巧查不到」;
③ 画像台账投影成同一个形状 (state 落 9 值域, 毫秒→秒的换算就在边界那一处);
④ 自定义 agent 那条道现状不变。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import src.api.routers.agent_runs as agent_runs
from src.agents.run_sources import (
    BUILTIN_RUN_SOURCES,
    MATTER_JOB_TYPES,
    RUN_SOURCE_ASYNC_JOB,
    is_matter_scoped,
    resolve_run_source,
)
from src.agents.run_state import AGENT_RUN_STATES

GOVERNANCE_AGENT_ID = "contact_governance_agent"
PROFILE_AGENT_ID = "contact_profile_agent"


@pytest.fixture()
def runs_env(tmp_path, monkeypatch):
    """tmp sync_store（真 SyncStore migration → 含 contact_profile_run）+ repo 注入 + flag on。"""
    from src.mail.sync_store import SyncStore
    from src.sync.async_jobs import AsyncJobRepository

    db = tmp_path / "s.db"
    SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    monkeypatch.setattr(agent_runs, "get_job_repo", lambda: repo)
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: True)
    return SimpleNamespace(db=str(db), repo=repo)


def _enqueue(repo, job_type: str, target_key: str, *, target_kind: str = "agent", **kw):
    job_id, _ = repo.enqueue(
        job_type=job_type, target_kind=target_kind, target_key=target_key,
        params={"trigger_kind": kw.get("trigger_kind", "cron")},
    )
    if "status" in kw:
        repo.mark_terminal(job_id, status=kw["status"], result=kw.get("result"))
    return job_id


def _get(client, **params):
    r = client.get("/api/agent-runs", params=params)
    assert r.status_code == 200, r.text
    return r.json()


# ── ① 通讯录治理: target_key='global' 但成员 id 是 contact_governance_agent ────────


def test_governance_runs_listed_under_member_id_with_backfilled_agent_id(client, runs_env):
    job_id = _enqueue(
        runs_env.repo, "contact_governance", "global",
        target_kind="contact_directory", status="succeeded",
        result={"outcome": "completed", "summary": "提了 3 条建议"},
    )
    env = _get(client, agentId=GOVERNANCE_AGENT_ID)
    assert env["meta"]["total"] == 1
    assert len(env["data"]) == 1
    item = env["data"][0]
    assert item["jobId"] == job_id
    # 🔴 回填: 库里那行的 target_key 是 'global'，直接透传出去前端认不出是谁。
    assert item["agentId"] == GOVERNANCE_AGENT_ID
    assert item["state"] == "completed"
    assert item["summary"] == "提了 3 条建议"


def test_governance_target_key_is_not_the_member_id(client, runs_env):
    """拿 target_key ('global') 当 agentId 查必须查不到 —— 证明映射不是「agentId==target_key」。"""
    _enqueue(
        runs_env.repo, "contact_governance", "global",
        target_kind="contact_directory", status="succeeded",
    )
    assert _get(client, agentId="global")["data"] == []


def test_custom_agent_lane_unchanged(client, runs_env):
    """自定义 agent 那条道现状不变: job_type='agent_run' + target_key=agent id。"""
    _enqueue(runs_env.repo, "agent_run", "reader", status="succeeded",
             result={"outcome": "completed"})
    _enqueue(runs_env.repo, "contact_governance", "global",
             target_kind="contact_directory", status="succeeded")

    env = _get(client, agentId="reader")
    assert [it["agentId"] for it in env["data"]] == ["reader"]
    assert env["meta"]["total"] == 1


def test_no_agent_id_still_lists_only_agent_run(client, runs_env):
    """不带 agentId 的全局口径**有意不变** —— pending-count 之类的面靠它, 放宽会把治理 /
    事项的 run 掺进红点。"""
    _enqueue(runs_env.repo, "agent_run", "reader", status="succeeded")
    _enqueue(runs_env.repo, "contact_governance", "global",
             target_kind="contact_directory", status="succeeded")
    _enqueue(runs_env.repo, "matter_followup", "MAT-0001", target_kind="matter",
             status="succeeded")

    env = _get(client)
    assert [it["agentId"] for it in env["data"]] == ["reader"]
    assert env["meta"]["total"] == 1


# ── ② 事项域恒排除 ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("agent_id", ["matter:MAT-0001", "matter_item:MAT-0001:42"])
def test_matter_namespace_agent_ids_return_empty_not_error(client, runs_env, agent_id):
    """🔴 事项域的会话命名空间 → 200 空集。报错会让团队页整栏崩, 放行会把事项 run 掺进来。"""
    _enqueue(runs_env.repo, "matter_followup", "MAT-0001", target_kind="matter",
             status="succeeded")
    _enqueue(runs_env.repo, "matter_item_run", "matter_item:MAT-0001:42",
             target_kind="matter_item", status="succeeded")

    env = _get(client, agentId=agent_id)
    assert env["data"] == []
    assert env["meta"]["total"] == 0


def test_matter_scoped_ids_are_explicitly_rejected_by_mapping(runs_env):
    """🔴 「显式拒绝」而不是「默认档碰巧查不到」—— 默认档换个 job_type 就会漏出来。"""
    assert is_matter_scoped("matter:MAT-0001") is True
    assert is_matter_scoped("matter_item:MAT-0001:42") is True
    assert resolve_run_source("matter:MAT-0001") is None
    assert resolve_run_source("matter_item:MAT-0001:42") is None
    assert resolve_run_source("") is None
    # 长得像但不是命名空间的普通 id 不受影响。
    assert is_matter_scoped("mattermost_agent") is False


def test_no_mapping_can_ever_yield_a_matter_job_type():
    """任何一条映射都不许产出 matter_followup / matter_item_run。"""
    produced = {
        s.job_type
        for s in list(BUILTIN_RUN_SOURCES.values()) + [resolve_run_source("anything")]
        if s is not None and s.kind == RUN_SOURCE_ASYNC_JOB
    }
    assert produced & MATTER_JOB_TYPES == set()


def test_matter_run_rows_never_leak_through_the_default_lane(client, runs_env):
    """默认档钉死 job_type='agent_run': 事项 job 的 target_key 与某成员同名也查不到。"""
    _enqueue(runs_env.repo, "matter_followup", "reader", target_kind="matter",
             status="succeeded")
    assert _get(client, agentId="reader")["data"] == []


# ── ③ 画像台账投影 ─────────────────────────────────────────────────────────────


def _record(db, **kw):
    from src.contacts.profile_runs import record_profile_run

    stats = {
        "candidates": kw.pop("candidates", 0),
        "ran": kw.pop("ran", 0),
        "ok": kw.pop("ok", 0),
        "skipped": kw.pop("skipped", 0),
        "failed": kw.pop("failed", 0),
    }
    return record_profile_run(db, stats=stats, **kw)


def test_profile_runs_project_into_run_history_shape(client, runs_env):
    _record(
        runs_env.db, started_at_ms=1_700_000_000_000, completed_at_ms=1_700_000_090_000,
        candidates=5, ran=5, ok=4, skipped=0, failed=1,
    )
    env = _get(client, agentId=PROFILE_AGENT_ID)
    assert env["meta"]["total"] == 1
    item = env["data"][0]
    assert item["agentId"] == PROFILE_AGENT_ID
    assert item["state"] == "completed"
    assert item["summary"] == "画像 4 人 · 跳过 0 · 失败 1"
    # 🔴 毫秒 → 秒的换算就在投影这一处（台账存毫秒, run 历史契约是秒）。
    assert item["createdAt"] == 1_700_000_000.0
    assert item["finishedAt"] == 1_700_000_090.0
    assert item["durationSeconds"] == 90.0
    # 画像不开会话 / 无 token 账 / 无 fire_key —— 三处恒空是契约不是没写完。
    assert item["sessionId"] is None
    assert item["steps"] is None and item["tokens"] is None
    assert item["triggerKind"] is None and item["triggerFiredAtIso"] is None
    # 形状与 async_jobs 那条道逐键相同（前端 useAgentRuns 只认这一个形状）。
    _enqueue(runs_env.repo, "agent_run", "reader", status="succeeded")
    reference = _get(client, agentId="reader")["data"][0]
    assert set(item) == set(reference)


@pytest.mark.parametrize(
    "kw, expected_state, expected_summary",
    [
        ({"candidates": 3, "ran": 3, "ok": 3}, "completed", "画像 3 人 · 跳过 0 · 失败 0"),
        ({}, "skipped", "没有待更新画像的联系人"),
        (
            {"candidates": 2, "ran": 2, "failed": 2},
            "failed",
            "画像 0 人 · 跳过 0 · 失败 2",
        ),
    ],
)
def test_profile_status_maps_into_the_nine_state_domain(
    client, runs_env, kw, expected_state, expected_summary
):
    """ok/fail/noop 复用既有 9 值域 —— 新增第 10 个值 = 前端穷举渲染时一处静默空白。"""
    _record(runs_env.db, started_at_ms=1_700_000_000_000, **kw)
    item = _get(client, agentId=PROFILE_AGENT_ID)["data"][0]
    assert item["state"] == expected_state
    assert item["state"] in AGENT_RUN_STATES
    assert item["summary"] == expected_summary


def test_profile_batch_level_failure_carries_the_reason(client, runs_env):
    _record(
        runs_env.db, started_at_ms=1_700_000_000_000, candidates=4,
        error="database is locked",
    )
    item = _get(client, agentId=PROFILE_AGENT_ID)["data"][0]
    assert item["state"] == "failed"
    assert item["error"] == "database is locked"
    assert item["summary"] == "没跑完 · 候选 4 人，已完成 0 人"


def test_profile_runs_paginate_with_total(client, runs_env):
    for i in range(3):
        _record(runs_env.db, started_at_ms=1_700_000_000_000 + i * 1000, candidates=1,
                ran=1, ok=1)
    env = _get(client, agentId=PROFILE_AGENT_ID, limit=2, offset=0)
    assert env["meta"]["total"] == 3 and len(env["data"]) == 2
    page2 = _get(client, agentId=PROFILE_AGENT_ID, limit=2, offset=2)
    assert len(page2["data"]) == 1
    assert page2["data"][0]["jobId"] not in {it["jobId"] for it in env["data"]}


def test_profile_runs_empty_when_never_ran(client, runs_env):
    env = _get(client, agentId=PROFILE_AGENT_ID)
    assert env["data"] == [] and env["meta"]["total"] == 0


# ── 与既有 state 过滤 / flag 门控共存 ────────────────────────────────────────────


def test_state_filter_applies_to_governance_lane(client, runs_env):
    _enqueue(runs_env.repo, "contact_governance", "global",
             target_kind="contact_directory", status="succeeded",
             result={"outcome": "completed"})
    _enqueue(runs_env.repo, "contact_governance", "global",
             target_kind="contact_directory", status="failed")
    data = _get(client, agentId=GOVERNANCE_AGENT_ID, state="failed")["data"]
    assert len(data) == 1 and data[0]["state"] == "failed"


def test_state_filter_applies_to_profile_lane(client, runs_env):
    _record(runs_env.db, started_at_ms=1_700_000_000_000, candidates=1, ran=1, ok=1)
    _record(runs_env.db, started_at_ms=1_700_000_001_000)  # noop → skipped
    data = _get(client, agentId=PROFILE_AGENT_ID, state="skipped")["data"]
    assert len(data) == 1 and data[0]["state"] == "skipped"


def test_flag_off_404_for_every_lane(client, runs_env, monkeypatch):
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    for agent_id in (GOVERNANCE_AGENT_ID, PROFILE_AGENT_ID, "matter:MAT-0001"):
        assert client.get("/api/agent-runs", params={"agentId": agent_id}).status_code == 404
