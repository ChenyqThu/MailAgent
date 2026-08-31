"""L4 P4a —— `GET /api/agent-runs?agentId=` 的成员 → 记录来源映射。

团队页的记录列要按成员列执行记录, 而记录散在两类源: `async_jobs`
(自定义 agent 的 `agent_run` + 通讯录治理的 `contact_governance`, 后者 target_key 是
`'global'` **不是** agent id) 与 `agent_run_log` 统一台账 (DB v73; 报告 / 联系人画像 /
项目周报这些不走 gateway 的成员)。映射表在 `src.agents.run_sources`; run_log 是每个
可解析成员的并查源。

盯五件事:
① 治理 run 能按 `contact_governance_agent` 查到, 且行上的 agentId 回填成成员 id;
② 🔴 事项域 (`matter:` / `matter_item:` 命名空间与两个 matter job_type) **恒不进**团队页
   口径 —— 空集不是报错, 也不是「碰巧查不到」;
③ run_log 行投影成对齐的形状 + `kind: 'run_log'` / `runLogId` (接缝契约; state 直接是
   9 值域子集, 时间字段 ISO 字符串, 毫秒→ISO 的换算就在边界那一处);
④ 自定义 agent 那条道现状不变;
⑤ 步骤端点 `GET /api/agent-runs/run-log/{id}/steps` 的形状 (接缝契约)。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import src.api.routers.agent_runs as agent_runs
from src.agents.run_log import record_agent_run
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
    """tmp sync_store（真 SyncStore migration → 含 agent_run_log/step）+ repo 注入 + flag on。"""
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


# ── ③ run_log 统一台账投影（接缝契约）───────────────────────────────────────────


def _record(db, agent_id=PROFILE_AGENT_ID, **kw):
    kw.setdefault("status", "completed")
    return record_agent_run(db, agent_id=agent_id, **kw)


def test_run_log_rows_project_with_kind_and_iso_times(client, runs_env):
    run_id = _record(
        runs_env.db,
        started_at_ms=1_700_000_000_000,
        completed_at_ms=1_700_000_090_000,
        summary="画像 4 人 · 跳过 0 · 失败 1",
        trigger_kind="schedule",
        model="m1",
        input_tokens=100,
        output_tokens=20,
        steps=[{"kind": "trig", "detail": "d"}, {"kind": "out", "detail": "o"}],
    )
    env = _get(client, agentId=PROFILE_AGENT_ID)
    assert env["meta"]["total"] == 1
    item = env["data"][0]
    assert item["agentId"] == PROFILE_AGENT_ID
    assert item["state"] == "completed"
    assert item["summary"] == "画像 4 人 · 跳过 0 · 失败 1"
    # 🔴 接缝契约: run_log item 带 kind + runLogId; 时间字段是 ISO 字符串
    # (台账存毫秒 epoch, 换算只在 _ms_iso 边界那一处)。
    assert item["kind"] == "run_log"
    assert item["runLogId"] == run_id
    assert item["createdAt"] == "2023-11-14T22:13:20+00:00"
    assert item["finishedAt"] == "2023-11-14T22:14:50+00:00"
    assert item["durationSeconds"] == 90.0
    assert item["steps"] == 2  # 列表面只带计数, 明细走 steps 端点
    assert item["tokens"] == {"inputTokens": 100, "outputTokens": 20}
    assert item["triggerKind"] == "schedule"
    assert item["triggerFiredAtIso"] == item["createdAt"]
    assert item["model"] == "m1"
    # run_log 的写入方不开会话、不走审批 —— 恒空是契约不是没写完。
    assert item["sessionId"] is None and item["approvalState"] is None
    # 形状对齐 async_jobs 那条道, 差集两个方向都钉死:
    # ① run_log 专属字段; ② auto-whitelist 两键**有意不在** run_log 行上 ——
    #    台账写入方不走 gateway, 没有这个概念, 恒 null 的字段不进契约。
    _enqueue(runs_env.repo, "agent_run", "reader", status="succeeded")
    reference = _get(client, agentId="reader")["data"][0]
    assert set(reference) - set(item) == {
        "autoWhitelistedWrites", "autoWhitelistedBreakdown",
    }
    assert set(item) - set(reference) == {
        "kind", "runLogId", "triggerDetail", "model", "reportId", "progressEmailId",
    }


@pytest.mark.parametrize("status", ["running", "completed", "failed", "skipped"])
def test_run_log_state_is_the_status_subset_verbatim(client, runs_env, status):
    """status 建表时 CHECK 钉死为 9 值域子集 —— 投影零映射直接透传。"""
    _record(
        runs_env.db, started_at_ms=1_700_000_000_000, status=status,
        completed_at_ms=None if status == "running" else 1_700_000_001_000,
    )
    item = _get(client, agentId=PROFILE_AGENT_ID)["data"][0]
    assert item["state"] == status
    assert item["state"] in AGENT_RUN_STATES


def test_run_log_failure_carries_the_reason(client, runs_env):
    _record(
        runs_env.db, started_at_ms=1_700_000_000_000, status="failed",
        summary="没跑完 · 候选 4 人，已完成 0 人", error="database is locked",
    )
    item = _get(client, agentId=PROFILE_AGENT_ID)["data"][0]
    assert item["state"] == "failed"
    assert item["error"] == "database is locked"
    assert item["summary"] == "没跑完 · 候选 4 人，已完成 0 人"


def test_run_log_rows_paginate_with_total(client, runs_env):
    for i in range(3):
        _record(runs_env.db, started_at_ms=1_700_000_000_000 + i * 1000)
    env = _get(client, agentId=PROFILE_AGENT_ID, limit=2, offset=0)
    assert env["meta"]["total"] == 3 and len(env["data"]) == 2
    page2 = _get(client, agentId=PROFILE_AGENT_ID, limit=2, offset=2)
    assert len(page2["data"]) == 1
    assert page2["data"][0]["runLogId"] not in {it["runLogId"] for it in env["data"]}


def test_run_log_empty_when_never_ran(client, runs_env):
    env = _get(client, agentId=PROFILE_AGENT_ID)
    assert env["data"] == [] and env["meta"]["total"] == 0


def test_report_run_carries_report_id_and_profile_run_does_not(client, runs_env):
    """🔴 reportId = out 步骤 payload 的 report_id (真实产物引用) —— 前端记录列靠它把
    「产物行 report:xxx」与「过程行 runlog:N」收敛成一条, 不做时间窗启发式。"""
    _record(
        runs_env.db, agent_id="daily_email_digest",
        started_at_ms=1_700_000_000_000, summary="今天 12 封",
        steps=[
            {"kind": "trig", "detail": "d"},
            {"kind": "tool", "name": "fetch_report_briefs", "ok": True},
            {"kind": "out", "name": "report", "detail": "今天 12 封",
             "payload": {"report_id": "daily_email_digest:daily:2026-06-01"}},
        ],
    )
    item = _get(client, agentId="daily_email_digest")["data"][0]
    assert item["reportId"] == "daily_email_digest:daily:2026-06-01"
    # 非报告类 (画像): out 步骤没有 report_id 键 → 自然 null, 不是空串。
    _record(
        runs_env.db, started_at_ms=1_700_000_000_000,
        steps=[{"kind": "trig", "detail": "d"},
               {"kind": "out", "name": "profile_batch", "detail": "画像 1 人"}],
    )
    assert _get(client, agentId=PROFILE_AGENT_ID)["data"][0]["reportId"] is None


def test_progress_email_id_projected_only_for_project_progress_runs(client, runs_env):
    """🔴 progressEmailId = trig 步骤 payload 的 internal_id (触发邮件引用) —— 记录列
    靠它把 project_progress_sync 台账行与 runlog 行收敛成一条。语义门: 只对该成员
    投影, 别的 agent 哪怕 trig 里带了 internal_id 也恒 null。"""
    trig = {"kind": "trig", "detail": "收到项目周报邮件",
            "payload": {"internal_id": 101, "message_id": "<w35@x>"}}
    _record(
        runs_env.db, agent_id="project_progress_sync",
        started_at_ms=1_700_000_000_000,
        steps=[trig, {"kind": "out", "name": "sync_result", "detail": "done"}],
    )
    item = _get(client, agentId="project_progress_sync")["data"][0]
    assert item["progressEmailId"] == 101
    # 别的成员带同形 trig payload → 不冒充周报引用。
    _record(
        runs_env.db, agent_id="daily_email_digest",
        started_at_ms=1_700_000_000_000, steps=[trig],
    )
    assert _get(client, agentId="daily_email_digest")["data"][0]["progressEmailId"] is None
    # trig 无 payload (画像) → null 而不是炸。
    _record(
        runs_env.db, started_at_ms=1_700_000_000_000,
        steps=[{"kind": "trig", "detail": "d"}],
    )
    assert _get(client, agentId=PROFILE_AGENT_ID)["data"][0]["progressEmailId"] is None


def test_report_agent_ids_hit_run_log_via_default_lane(client, runs_env):
    """报告 agent (daily_email_digest 等) 不在 BUILTIN_RUN_SOURCES 里 —— 默认档的
    async_jobs 半边恒空, run_log 半边把它的执行记录带出来。"""
    _record(runs_env.db, agent_id="daily_email_digest",
            started_at_ms=1_700_000_000_000, summary="今天 12 封")
    env = _get(client, agentId="daily_email_digest")
    assert env["meta"]["total"] == 1
    assert env["data"][0]["kind"] == "run_log"
    assert env["data"][0]["summary"] == "今天 12 封"


def test_async_jobs_and_run_log_merge_newest_first(client, runs_env):
    """两源都有行的成员 (兜底档): 按开始时刻合并倒序, total = 两源之和。"""
    _enqueue(runs_env.repo, "agent_run", "reader", status="succeeded",
             result={"outcome": "completed"})  # created_at = 当前 time.time()
    _record(runs_env.db, agent_id="reader", started_at_ms=1_000_000)  # 1970 年, 恒最老
    env = _get(client, agentId="reader")
    assert env["meta"]["total"] == 2
    kinds = [it.get("kind") for it in env["data"]]
    assert kinds == [None, "run_log"]  # async_jobs 行新 → 在前; run_log 行老 → 在后


# ── ⑤ 步骤端点（接缝契约）──────────────────────────────────────────────────────


def test_steps_endpoint_shape(client, runs_env):
    run_id = _record(
        runs_env.db, started_at_ms=1_700_000_000_000,
        steps=[
            {"kind": "trig", "detail": "每日画像批 · 候选 2 人"},
            {"kind": "tool", "name": "generate_contact_profile",
             "detail": "张三 — 已更新画像", "payload": {"contact_id": 1},
             "ok": True, "ms": 1200},
            {"kind": "tool", "name": "generate_contact_profile",
             "detail": "李四 — 失败：llm down", "ok": False},
            {"kind": "out", "name": "profile_batch", "detail": "画像 1 人"},
        ],
    )
    r = client.get(f"/api/agent-runs/run-log/{run_id}/steps")
    assert r.status_code == 200, r.text
    steps = r.json()["data"]["steps"]
    # 🔴 接缝契约: {seq, kind, name, detail, payload, ok, ms}, 不许改名。
    assert [set(s) for s in steps] == [
        {"seq", "kind", "name", "detail", "payload", "ok", "ms"}
    ] * 4
    assert [s["seq"] for s in steps] == [0, 1, 2, 3]
    assert [s["kind"] for s in steps] == ["trig", "tool", "tool", "out"]
    tool = steps[1]
    assert tool["payload"] == {"contact_id": 1}  # 解析后的对象, 不是 JSON 串
    assert tool["ok"] is True and tool["ms"] == 1200
    assert steps[2]["ok"] is False  # → 前端标 ✗ + fail 色
    assert steps[0]["payload"] is None and steps[0]["ok"] is None


def test_steps_endpoint_404_on_unknown_run(client, runs_env):
    r = client.get("/api/agent-runs/run-log/424242/steps")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_steps_endpoint_empty_steps_is_not_404(client, runs_env):
    run_id = _record(runs_env.db, started_at_ms=1_700_000_000_000)
    r = client.get(f"/api/agent-runs/run-log/{run_id}/steps")
    assert r.status_code == 200
    assert r.json()["data"]["steps"] == []


# ── 与既有 state 过滤 / flag 门控共存 ────────────────────────────────────────────


def test_state_filter_applies_to_governance_lane(client, runs_env):
    _enqueue(runs_env.repo, "contact_governance", "global",
             target_kind="contact_directory", status="succeeded",
             result={"outcome": "completed"})
    _enqueue(runs_env.repo, "contact_governance", "global",
             target_kind="contact_directory", status="failed")
    data = _get(client, agentId=GOVERNANCE_AGENT_ID, state="failed")["data"]
    assert len(data) == 1 and data[0]["state"] == "failed"


def test_state_filter_applies_to_run_log_lane(client, runs_env):
    _record(runs_env.db, started_at_ms=1_700_000_000_000, status="completed")
    _record(runs_env.db, started_at_ms=1_700_000_001_000, status="skipped")
    data = _get(client, agentId=PROFILE_AGENT_ID, state="skipped")["data"]
    assert len(data) == 1 and data[0]["state"] == "skipped"


def test_flag_off_404_for_every_lane(client, runs_env, monkeypatch):
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    for agent_id in (GOVERNANCE_AGENT_ID, PROFILE_AGENT_ID, "matter:MAT-0001"):
        assert client.get("/api/agent-runs", params={"agentId": agent_id}).status_code == 404
