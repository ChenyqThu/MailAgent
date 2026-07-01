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
    # 隔离契约 §9-3 re-check（依赖 island_dispatch._state.sync_store 模块单例，
    # 跨测试残留态不确定）→ 本测试只验 re-emit + 清队列路径。
    monkeypatch.setattr(island_snooze, "_email_handled", lambda iid: False)

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


def test_fire_due_skips_handled_email(tmp_snooze_file, monkeypatch):
    """契约 §9-3: snooze 到期时邮件已被处理 → 跳过 re-emit, 但仍清出队列."""
    called = []
    monkeypatch.setattr(island_snooze.island_dispatch, "dispatch_llm_reviewed",
                        lambda **kw: called.append(kw))
    # email 1 已完成 → 跳过; email 2 未到期
    monkeypatch.setattr(island_snooze, "_email_handled", lambda iid: iid == 1)

    island_snooze.add(internal_id=1, snooze_until=time.time() - 10, subject="A")
    island_snooze.add(internal_id=3, snooze_until=time.time() - 10, subject="C")

    fired = island_snooze.fire_due()
    assert fired == 1  # 只有 email 3 真 re-emit
    assert [c["internal_id"] for c in called] == [3]
    # 两条到期都清出队列 (跳过的也不反复刷屏)
    assert island_snooze.list_all() == []


def test_email_handled_recheck(tmp_snooze_file, monkeypatch):
    """_email_handled: processing_status='已完成' 或已删 → True; 未处理/无 store → False."""
    from src.notify import island_dispatch

    class _Store:
        def __init__(self, mapping):
            self._m = mapping

        def get(self, iid):
            return self._m.get(iid)

    # 无 sync_store → False (fail-open)
    monkeypatch.setattr(island_dispatch._state, "sync_store", None)
    assert island_snooze._email_handled(1) is False

    store = _Store({
        1: {"processing_status": "已完成"},
        2: {"processing_status": None},
        # 3 缺失 → get 返 None (已删)
    })
    monkeypatch.setattr(island_dispatch._state, "sync_store", store)
    assert island_snooze._email_handled(1) is True   # 已完成
    assert island_snooze._email_handled(2) is False  # 未处理
    assert island_snooze._email_handled(3) is True   # 已删除


def test_remove_returns_bool(tmp_snooze_file):
    island_snooze.add(internal_id=7, duration_sec=60)
    assert island_snooze.remove(7) is True
    assert island_snooze.remove(7) is False
    assert island_snooze.list_all() == []
