"""单测：island_snooze 队列（add / due_now / fire_due）."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from src.notify import island_snooze


@pytest.fixture
def tmp_snooze_file(tmp_path: Path, monkeypatch):
    target = tmp_path / "snooze.json"
    monkeypatch.setattr(island_snooze, "SNOOZE_FILE", target)
    yield target


def test_add_and_list(tmp_snooze_file):
    until = island_snooze.add(internal_id=53675, duration_sec=120, subject="Hi")
    entries = island_snooze.list_all()
    assert len(entries) == 1
    assert entries[0]["internal_id"] == 53675
    assert entries[0]["snooze_until"] == pytest.approx(until, abs=0.01)
    # 文件已落盘
    raw = json.loads(tmp_snooze_file.read_text())
    assert raw[0]["subject"] == "Hi"


def test_add_same_id_replaces(tmp_snooze_file):
    island_snooze.add(internal_id=1, duration_sec=60, subject="A")
    island_snooze.add(internal_id=1, duration_sec=120, subject="B")
    entries = island_snooze.list_all()
    assert len(entries) == 1
    assert entries[0]["subject"] == "B"


def test_due_now_threshold(tmp_snooze_file):
    until = island_snooze.add(internal_id=10, duration_sec=60)
    # 当前时间没到 → due_now 为空
    assert len(island_snooze.due_now()) == 0
    # 跨越截止点 → due_now 返回这条
    due = island_snooze.due_now(now=until + 1)
    assert len(due) == 1
    assert due[0]["internal_id"] == 10


def test_fire_due_removes_entries(tmp_snooze_file, monkeypatch):
    """fire_due 调用 dispatch_llm_reviewed 并清空对应 entry."""
    called = []

    def fake_dispatch(**kwargs):
        called.append(kwargs)

    monkeypatch.setattr(island_snooze.island_dispatch, "dispatch_llm_reviewed",
                         fake_dispatch)

    island_snooze.add(internal_id=1, snooze_until=time.time() - 10, subject="A",
                      sender="a@b.com", page_id="pid", mailbox="收件箱",
                      ai_action="需要回复", ai_priority="🔴 紧急")
    island_snooze.add(internal_id=2, snooze_until=time.time() + 600, subject="B")

    fired = island_snooze.fire_due()
    assert fired == 1
    assert len(called) == 1
    assert called[0]["internal_id"] == 1
    # 已 fire 的清掉、未 fire 保留
    remaining = island_snooze.list_all()
    assert len(remaining) == 1
    assert remaining[0]["internal_id"] == 2


def test_remove_returns_bool(tmp_snooze_file):
    island_snooze.add(internal_id=7, duration_sec=60)
    assert island_snooze.remove(7) is True
    assert island_snooze.remove(7) is False
    assert island_snooze.list_all() == []
