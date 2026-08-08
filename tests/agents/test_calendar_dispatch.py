from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from src.agents.calendar_dispatch import (
    CalendarChangeCoalescer,
    dispatch_calendar_change_agents,
)
from src.calendar_sync.caldav_reader import CalendarEvent
from src.calendar_sync.reconciler import CalendarChange
from src.calendar_sync.repository import CalendarEventRepository
from src.mail.sync_store import SyncStore
from src.sync.async_jobs import AsyncJobRepository


class _FakeStore:
    def __init__(self, agents):
        self._agents = agents

    def list_agents(self):
        return self._agents


def _event(**overrides):
    data = dict(
        summary="Planning",
        start=datetime(2026, 8, 9, 16, tzinfo=timezone.utc),
        end=datetime(2026, 8, 9, 17, tzinfo=timezone.utc),
        ical_uid="uid-1",
        calendar_name="Work",
        organizer="boss@example.com",
        attendees=["a@example.com"],
        attendees_detail=[{"email": "a@example.com"}],
        status="CONFIRMED",
    )
    data.update(overrides)
    return CalendarEvent(**data)


@pytest.fixture
def env(tmp_path):
    path = str(tmp_path / "calendar.db")
    SyncStore(path)
    calendar_repo = CalendarEventRepository(path)
    calendar_repo.upsert_from_caldav_event(_event(), source="caldav")
    return calendar_repo, AsyncJobRepository(path)


def _agent(trigger, budget=None):
    return {
        "id": "agent-1",
        "type": "custom",
        "enabled": 1,
        "trigger_json": json.dumps({
            "v": 2,
            "triggers": [{"id": "trg_cal", "enabled": True, **trigger}],
        }),
        "budget_json": budget,
    }


def _change(digest="a" * 64):
    return CalendarChange("uid-1", None, "Work", "updated", ["summary"], digest)


@pytest.mark.parametrize(
    "trigger",
    [
        {"kind": "calendar_event_change", "title_pattern": "Plan"},
        {"kind": "calendar_event_change", "organizer_pattern": "BOSS@"},
        {"kind": "calendar_event_change", "attendee_pattern": "a@"},
        {"kind": "calendar_event_change", "calendar_ids": ["Work"]},
        {"kind": "calendar_event_change"},
    ],
)
def test_matching_predicates_enqueue(env, trigger, monkeypatch):
    monkeypatch.setattr("src.agents.calendar_dispatch.calendar_trigger_enabled", lambda: True)
    calendar_repo, repo = env
    dispatch_calendar_change_agents(
        store=_FakeStore([_agent(trigger)]),
        repo=repo,
        calendar_repo=calendar_repo,
        changes=[_change()],
    )
    assert repo.count_agent_runs_since("agent-1", 0) == 1


@pytest.mark.parametrize(
    "trigger",
    [
        {"kind": "calendar_event_change", "title_pattern": "Nope"},
        {"kind": "calendar_event_change", "organizer_pattern": "nobody"},
        {"kind": "calendar_event_change", "attendee_pattern": "nobody"},
        {"kind": "calendar_event_change", "calendar_ids": ["Personal"]},
    ],
)
def test_predicates_filter(env, trigger, monkeypatch):
    monkeypatch.setattr("src.agents.calendar_dispatch.calendar_trigger_enabled", lambda: True)
    calendar_repo, repo = env
    dispatch_calendar_change_agents(
        store=_FakeStore([_agent(trigger)]), repo=repo, calendar_repo=calendar_repo,
        changes=[_change()],
    )
    assert repo.count_agent_runs_since("agent-1", 0) == 0


def test_same_fire_key_is_idempotent_and_flag_off_is_inert(env, monkeypatch):
    calendar_repo, repo = env
    store = _FakeStore([_agent({"kind": "calendar_event_change"})])
    monkeypatch.setattr("src.agents.calendar_dispatch.calendar_trigger_enabled", lambda: True)
    for _ in range(2):
        dispatch_calendar_change_agents(
            store=store, repo=repo, calendar_repo=calendar_repo, changes=[_change()]
        )
    assert repo.count_agent_runs_since("agent-1", 0) == 1
    monkeypatch.setattr("src.agents.calendar_dispatch.calendar_trigger_enabled", lambda: False)
    dispatch_calendar_change_agents(
        store=store, repo=repo, calendar_repo=calendar_repo, changes=[_change("b" * 64)]
    )
    assert repo.count_agent_runs_since("agent-1", 0) == 1


def test_coalescer_keeps_latest_pending():
    coalescer = CalendarChangeCoalescer()
    first = _change("a" * 64)
    second = _change("b" * 64)
    assert coalescer.offer([first], now_monotonic=0) == [first]
    assert coalescer.offer([second], now_monotonic=10) == []
    assert coalescer.pending[("uid-1", None)] == second
    assert coalescer.offer([], now_monotonic=60) == [second]
