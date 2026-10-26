"""agents skill（对外自定义 agent）—— list/get 字段白名单（指令 / 模型 / 权限面不出现）、limit 越界拒、
不存在或非 custom 的 id → E_NOT_FOUND；``custom_agent_run_now`` 的全部门槛按顺序：scope → confirm →
配额（10/h/key）→ 功能开关 → 存在 → enabled（停用拒绝且不入队）→ 入队。

run_now 走真实的 ``invoke_skill`` chokepoint（与 REST / MCP 同一入口）；registry 的 installed-skill
合并打成空，避免读本机 agent_config.db。
"""

from __future__ import annotations

import json
import os
from types import SimpleNamespace

import pytest

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.api.agent_auth import Principal  # noqa: E402
from src.mail.sync_store import SyncStore  # noqa: E402
from src.reports.store import ReportStore  # noqa: E402
from src.security.api_keys import HANDOFF_SCOPES, READ_ONLY_SCOPES  # noqa: E402
from src.skills import rate_limit, registry  # noqa: E402
from src.skills.builtin import agents as agents_skill  # noqa: E402
from src.skills.context import SkillContext  # noqa: E402
from src.skills.errors import SkillError  # noqa: E402
from src.skills.invoke import invoke_skill  # noqa: E402
from src.sync.async_jobs import AsyncJobRepository  # noqa: E402

GET_FIELDS = {"id", "type", "title", "description", "enabled", "trigger", "budget", "updated_at",
              "recent_runs"}
FORBIDDEN_SPEC = {"prompt", "model", "tool_policy", "allowed_tools", "grant_exec", "grant_web",
                  "grant_sessions", "skills", "grant_connectors", "capabilities"}
RUN_FIELDS = {"job_id", "state", "outcome", "approval_state", "session_id", "created_at",
              "finished_at", "error"}


def _principal(scopes) -> Principal:
    return Principal(kind="agent", auth_method="bearer", key_id="k1", scopes=frozenset(scopes))


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.setattr(registry, "_load_installed_skills", lambda builtins: [])
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture
def env(tmp_path):
    path = str(tmp_path / "sync.db")
    SyncStore(path)
    store = ReportStore(db_path=path)
    store.create_agent("watcher", type="custom", enabled=True, title="Watcher",
                       prompt="SECRET PROMPT TEXT", model="secret-model")
    store.update_agent("watcher", {
        "description": "watches invoices",
        "trigger_json": json.dumps({"v": 1, "kind": "cron", "cron": "0 9 * * *", "timezone": "UTC"}),
        "tool_policy_json": json.dumps({"v": 1, "allowed_tools": ["email_search_fulltext"], "grant_exec": True}),
        "budget_json": json.dumps({"v": 1, "max_runs_per_day": 3}),
    })
    store.create_agent("sleeper", type="custom", enabled=False, title="Sleeper")
    store.create_agent("daily", type="report", enabled=True, title="Daily")
    cfg = SimpleNamespace(sync_store_db_path=path, custom_agents_enabled=True)
    return SimpleNamespace(
        ctx=SkillContext(report_store=store, config=cfg),
        cfg=cfg,
        jobs=AsyncJobRepository(db_path=path),
    )


def _invoke(env, tool, params, *, scopes=HANDOFF_SCOPES, confirm=False):
    import asyncio

    return asyncio.run(
        invoke_skill(_principal(scopes), "agents", tool, params, confirm=confirm, ctx=env.ctx)
    )


def _err(env, tool, params, **kw) -> SkillError:
    with pytest.raises(SkillError) as ei:
        _invoke(env, tool, params, **kw)
    return ei.value


# ── list / get ──────────────────────────────────────────────────────────────


def test_list_only_custom_agents_with_minimal_fields(env):
    data = _invoke(env, "custom_agent_list", {})
    assert data["count"] == 2 and data["truncated"] is False
    assert {a["id"] for a in data["items"]} == {"watcher", "sleeper"}
    assert all(set(a) == {"id", "title", "enabled", "trigger"} for a in data["items"])


def test_list_truncation_and_limit_bounds(env):
    assert _invoke(env, "custom_agent_list", {"limit": 1})["truncated"] is True
    for limit in (0, 101):
        assert _err(env, "custom_agent_list", {"limit": limit}).code == "E_INVALID_ARG"


def test_get_hides_prompt_model_and_permissions(env):
    agents_skill._custom_agent_run_now(env.ctx, {"agent_id": "watcher"})
    data = _invoke(env, "custom_agent_get", {"agent_id": "watcher"})
    assert set(data) == GET_FIELDS
    assert not (FORBIDDEN_SPEC & set(data))
    dumped = json.dumps(data)
    assert "SECRET PROMPT TEXT" not in dumped and "secret-model" not in dumped
    assert "grant_exec" not in dumped and "email_search_fulltext" not in dumped
    assert data["trigger"]["kind"] == "cron" and data["budget"]["max_runs_per_day"] == 3
    assert len(data["recent_runs"]) == 1 and set(data["recent_runs"][0]) == RUN_FIELDS
    assert data["recent_runs"][0]["state"] == "queued"


@pytest.mark.parametrize("agent_id", ["ghost", "daily"])
def test_get_unknown_or_non_custom_is_not_found(env, agent_id):
    err = _err(env, "custom_agent_get", {"agent_id": agent_id})
    assert err.code == "E_NOT_FOUND" and err.http_status == 404


@pytest.mark.parametrize("runs_limit", [-1, 21])
def test_get_runs_limit_out_of_range_rejected(env, runs_limit):
    assert _err(env, "custom_agent_get", {"agent_id": "watcher", "runs_limit": runs_limit}).code == "E_INVALID_ARG"


@pytest.mark.parametrize(
    "tool,params,confirm",
    [
        ("custom_agent_list", {}, False),
        ("custom_agent_get", {"agent_id": "watcher"}, False),
        ("custom_agent_run_now", {"agent_id": "watcher"}, True),
    ],
)
def test_feature_flag_off_rejects_every_tool(env, tool, params, confirm):
    env.cfg.custom_agents_enabled = False
    err = _err(env, tool, params, confirm=confirm)
    assert err.code == "E_SKILL_DISABLED" and err.http_status == 409
    assert env.jobs.list_agent_runs(agent_id="watcher") == []


# ── run_now ─────────────────────────────────────────────────────────────────


def test_run_now_enqueues_manual_run(env):
    data = _invoke(env, "custom_agent_run_now", {"agent_id": "watcher"}, confirm=True)
    assert data["agent_id"] == "watcher" and data["status"] == "queued" and data["was_created"] is True
    jobs = env.jobs.list_agent_runs(agent_id="watcher")
    assert len(jobs) == 1 and jobs[0].job_id == data["job_id"]
    assert jobs[0].params["trigger_kind"] == "manual"


def test_run_now_requires_confirm(env):
    err = _err(env, "custom_agent_run_now", {"agent_id": "watcher"}, confirm=False)
    assert err.code == "E_AUTH_FAILED" and err.http_status == 403
    assert env.jobs.list_agent_runs(agent_id="watcher") == []


def test_run_now_requires_agents_run_scope(env):
    assert "agents:run" not in READ_ONLY_SCOPES
    err = _err(env, "custom_agent_run_now", {"agent_id": "watcher"}, scopes=READ_ONLY_SCOPES, confirm=True)
    assert err.code == "E_AUTH_FAILED" and err.http_status == 403


def test_run_now_disabled_agent_rejected_before_enqueue(env, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "src.agents.run_queue.enqueue_manual_agent_run", lambda *a, **kw: calls.append((a, kw))
    )
    err = _err(env, "custom_agent_run_now", {"agent_id": "sleeper"}, confirm=True)
    assert err.code == "E_CONFLICT" and err.http_status == 409
    assert calls == []
    assert env.jobs.list_agent_runs(agent_id="sleeper") == []


@pytest.mark.parametrize("agent_id", ["ghost", "daily"])
def test_run_now_unknown_or_non_custom_is_not_found(env, agent_id):
    err = _err(env, "custom_agent_run_now", {"agent_id": agent_id}, confirm=True)
    assert err.code == "E_NOT_FOUND"


def test_run_now_rejects_any_input_besides_agent_id(env):
    err = _err(env, "custom_agent_run_now", {"agent_id": "watcher", "prompt": "do something else"}, confirm=True)
    assert err.code == "E_INVALID_ARG"
    assert env.jobs.list_agent_runs(agent_id="watcher") == []


def test_run_now_rate_limited_after_ten_calls_per_key(env, monkeypatch):
    monkeypatch.setattr(
        "src.agents.run_queue.enqueue_manual_agent_run",
        lambda repo, *, agent_id, budget_json: {"job_id": 1, "was_created": True, "skipped": False},
    )
    for _ in range(10):
        _invoke(env, "custom_agent_run_now", {"agent_id": "watcher"}, confirm=True)
    err = _err(env, "custom_agent_run_now", {"agent_id": "watcher"}, confirm=True)
    assert err.code == "E_RATE_LIMITED" and err.http_status == 429


def test_run_now_rejections_do_not_consume_quota(env):
    for _ in range(12):
        _err(env, "custom_agent_run_now", {"agent_id": "sleeper"}, confirm=True)
    assert _invoke(env, "custom_agent_run_now", {"agent_id": "watcher"}, confirm=True)["status"] == "queued"


def test_run_now_reports_skipped_when_daily_budget_used(env):
    for _ in range(3):
        assert _invoke(env, "custom_agent_run_now", {"agent_id": "watcher"}, confirm=True)["status"] == "queued"
    assert _invoke(env, "custom_agent_run_now", {"agent_id": "watcher"}, confirm=True)["status"] == "skipped"
