from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService
from src.matters.worker import MatterAgendaWorker

NOW_DT = datetime(2026, 8, 11, 9, 5, tzinfo=timezone.utc)
NOW = int(NOW_DT.timestamp() * 1000)
RULE = {
    "freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
    "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0, "clamp": False,
}


class FakeRuns:
    def __init__(self, *, coalesced=False):
        self.calls = []
        self.coalesced = coalesced

    def enqueue_run(self, public_id, **kwargs):
        self.calls.append((public_id, kwargs))
        return {"run": {"id": 1}, "coalesced": self.coalesced}


class FakeState:
    def __init__(self):
        self.values = {}

    def get_state(self, key):
        return self.values.get(key)

    def set_state(self, key, value):
        self.values[key] = value
        return True


def _matter(path, *, agent_profile_id="p1"):
    repo = MatterRepository(path)
    service = MatterService(repo, clock_ms=lambda: NOW)
    result = service.create_matter({"title": "scheduled"}, idempotency_key="create", source="test")
    matter = result["matter"]
    schedule = {"kind": "schedule", "rule": RULE, "anchor": "2026-08-01", "timezone": "UTC"}
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE matter SET agent_enabled=1,agent_profile_id=?,schedule_json=? WHERE id=?",
            (agent_profile_id, json.dumps(schedule), matter["id"]),
        )
        conn.commit()
    return repo, matter


def test_schedule_fire_marker_catchup_and_coalesced_consumption(tmp_path):
    path = tmp_path / "schedule.db"
    SyncStore(str(path))
    repo, matter = _matter(path)
    state = FakeState()
    runs = FakeRuns(coalesced=True)
    worker = MatterAgendaWorker(
        repository=repo, sync_store=state, matter_agent_enabled=True,
        clock_ms=lambda: NOW, run_service=runs,
    )
    assert worker._schedule_tick() == {matter["id"]}
    assert len(runs.calls) == 1
    marker_key = f"matter.schedule.last_fire.{matter['id']}"
    assert state.values[marker_key].startswith("2026-08-11T09:00:00")
    assert worker._schedule_tick() == set()
    assert len(runs.calls) == 1

    late = MatterAgendaWorker(
        repository=repo, sync_store=FakeState(), matter_agent_enabled=True,
        clock_ms=lambda: NOW + 31 * 60 * 1000, run_service=FakeRuns(),
    )
    assert late._schedule_tick() == set()


# 0811 dogfood 反馈：定时跟进原本带 `AND agent_profile_id IS NOT NULL`，把自动化卡在
# 「必须先手工建一个 Custom Agent」上 —— 而 P4 D2 已写明 profile 只贡献 model/title/persona，
# 工具面与任务契约都是服务端强制的（run_spec.py 的四处消费全有 `if profile` 守卫）。
# 这条钉住「未绑定也能被定时选中」，防止那半个条件被回填。
def test_schedule_tick_enqueues_enabled_unbound_matter(tmp_path):
    path = tmp_path / "schedule-unbound.db"
    SyncStore(str(path))
    repo, matter = _matter(path, agent_profile_id=None)
    with sqlite3.connect(path) as conn:
        bound = conn.execute(
            "SELECT agent_profile_id FROM matter WHERE id=?", (matter["id"],)
        ).fetchone()[0]
    assert bound is None, "前置：这条用例的意义就在于 profile 为空"

    runs = FakeRuns()
    worker = MatterAgendaWorker(
        repository=repo,
        sync_store=FakeState(),
        matter_agent_enabled=True,
        clock_ms=lambda: NOW,
        run_service=runs,
    )

    assert worker._schedule_tick() == {matter["id"]}
    # 幂等键的具体格式归 run_service 所有，这里不手抄（同文件既有用例同样只断调用发生）。
    assert len(runs.calls) == 1
    public_id, kwargs = runs.calls[0]
    assert public_id == matter["public_id"]
    assert kwargs["trigger_kind"] == "schedule"


def _insert_fail(path, matter_id, run_id, trigger, completed_at):
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_run(id,matter_id,trigger_kind,idempotency_key,status,queued_at," 
            "started_at,completed_at,created_at) VALUES (?,?,?,?,'fail',?,?,?,?)",
            (run_id, matter_id, trigger, f"fail:{run_id}", completed_at - 2, completed_at - 1, completed_at, completed_at - 2),
        )
        conn.commit()


def test_retry_chain_manual_no_retry_schedule_backoff_and_terminal_episode(tmp_path):
    path = tmp_path / "retry.db"
    SyncStore(str(path))
    repo = MatterRepository(path)
    base = MatterService(repo, clock_ms=lambda: NOW)
    manual = base.create_matter({"title": "manual"}, idempotency_key="m", source="test")["matter"]
    _insert_fail(path, manual["id"], 1, "manual", NOW - 10 * 60 * 1000)
    runs = FakeRuns()
    worker = MatterAgendaWorker(repository=repo, sync_store=FakeState(), matter_agent_enabled=True, clock_ms=lambda: NOW, run_service=runs)
    worker._retry_tick()
    assert runs.calls == []
    assert worker.attention.list_attention(public_id=manual["public_id"])[0]["kind"] == "run_failed"

    scheduled = base.create_matter({"title": "scheduled"}, idempotency_key="s", source="test")["matter"]
    _insert_fail(path, scheduled["id"], 2, "schedule", NOW - 6 * 60 * 1000)
    worker._retry_tick()
    assert runs.calls[-1][1]["idempotency_key"].endswith(":retry:2")
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE matter_run SET completed_at=? WHERE id=2",
            (NOW - 40 * 60 * 1000,),
        )
        conn.commit()
    _insert_fail(path, scheduled["id"], 3, "schedule", NOW - 31 * 60 * 1000)
    worker._retry_tick()
    assert runs.calls[-1][1]["idempotency_key"].endswith(":retry:3")
    _insert_fail(path, scheduled["id"], 4, "schedule", NOW - 1)
    worker._retry_tick()
    terminal = worker.attention.list_attention(public_id=scheduled["public_id"])[0]
    assert terminal["kind"] == "run_failed" and terminal["payload"]["attempts"] == 3


def test_noop_scheduled_run_creates_no_retry_or_notification(tmp_path):
    path = tmp_path / "noop.db"
    SyncStore(str(path))
    repo = MatterRepository(path)
    base = MatterService(repo, clock_ms=lambda: NOW)
    matter = base.create_matter(
        {"title": "noop"}, idempotency_key="noop", source="test"
    )["matter"]
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_run(matter_id,trigger_kind,idempotency_key,status," 
            "queued_at,started_at,completed_at,created_at) "
            "VALUES (?,'schedule','noop-run','noop',1,2,3,1)",
            (matter["id"],),
        )
        conn.commit()
    worker = MatterAgendaWorker(
        repository=repo,
        sync_store=FakeState(),
        matter_agent_enabled=True,
        clock_ms=lambda: NOW,
        run_service=FakeRuns(),
    )
    assert worker._retry_tick() == set()
    assert worker.attention.list_attention(public_id=matter["public_id"]) == []
    assert worker.attention.eligible_notifications("all") == []
