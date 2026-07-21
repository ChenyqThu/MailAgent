"""daily_digest 的 fire marker 时区迁移（codex review ①）。

时区化那一批只给 report worker 写了迁移，同源改动的 digest 漏了：旧值 ``20260721-09``
表示**北京** 7/21 09:00（实际 = LA 7/20 18:00），升级后在本地时区被当成「本地 7/21 09:00
已执行」→ 跳过当天 09:00 的 catch-up（codex 实测 ``_missed_catchup_slot`` 返回 None）。

与 ``tests/reports/test_worker_timezone.py::TestMarkerMigration`` 同构（共用
``src/utils/fire_marker_tz``）。
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

import pytest

from src.notify import daily_digest as D

_UTC = timezone.utc


@pytest.fixture
def tz_la(monkeypatch):
    """本机系统时区固定成 America/Los_Angeles（astimezone() 无参会读它）。"""
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


class _FakeStore:
    def __init__(self, state: Optional[Dict[str, str]] = None):
        self.state: Dict[str, str] = dict(state or {})

    def get_state(self, key: str) -> Optional[str]:
        return self.state.get(key)

    def set_state(self, key: str, value: str) -> bool:
        self.state[key] = value
        return True


def test_legacy_beijing_marker_swallows_todays_catchup_without_migration(tz_la):
    """复现：不迁移 → 本地 7/21 10:00 的 catch-up 被旧北京日 marker 吃掉。"""
    store = _FakeStore({D._LAST_FIRE_STATE_KEY: "20260721-09"})
    now = datetime(2026, 7, 21, 17, 0, tzinfo=_UTC).astimezone()  # LA 07-21 10:00
    assert now.hour == 10 and now.day == 21
    assert D._missed_catchup_slot(now, store, [9]) is None      # ← 病灶

    D._migrate_fire_marker(store)
    assert store.state[D._LAST_FIRE_STATE_KEY] == "20260720-09"  # 真实 fire = LA 07-20 18:00
    assert D._missed_catchup_slot(now, store, [9]) == "20260721-09"


def test_migration_is_idempotent(tz_la):
    store = _FakeStore({D._LAST_FIRE_STATE_KEY: "20260721-09"})
    for _ in range(3):
        D._migrate_fire_marker(store)
    # 换算本身不幂等（重复跑会一路往前漂一天）→ 标记位必须挡住后续调用
    assert store.state[D._LAST_FIRE_STATE_KEY] == "20260720-09"
    assert store.state[D._MARKER_MIGRATION_STATE_KEY] == "1"


def test_migration_is_noop_in_shanghai(monkeypatch):
    """本机 = 旧硬编码时区 → 换算结果与旧值相同，原样不动。"""
    monkeypatch.setenv("TZ", "Asia/Shanghai")
    time.tzset()
    try:
        store = _FakeStore({D._LAST_FIRE_STATE_KEY: "20260721-09"})
        D._migrate_fire_marker(store)
        assert store.state[D._LAST_FIRE_STATE_KEY] == "20260721-09"
    finally:
        monkeypatch.undo()
        time.tzset()


def test_migration_skips_empty_marker(tz_la):
    """owner 活库现值就是空串（digest 默认关，从没 fire 过）→ 不该凭空造一个 marker。"""
    store = _FakeStore({D._LAST_FIRE_STATE_KEY: ""})
    D._migrate_fire_marker(store)
    assert store.state[D._LAST_FIRE_STATE_KEY] == ""


def test_migration_aborts_when_flag_write_fails(tz_la):
    """🔴 SyncStore.set_state 吞 sqlite3.Error 返回 False（不抛）——
    标记位没落库还照改 marker 的话，每次重启会把它再往前漂一天。"""

    class _FlagWriteFails(_FakeStore):
        def set_state(self, key: str, value: str) -> bool:
            if key == D._MARKER_MIGRATION_STATE_KEY:
                return False
            return super().set_state(key, value)

    store = _FlagWriteFails({D._LAST_FIRE_STATE_KEY: "20260721-09"})
    D._migrate_fire_marker(store)
    assert store.state[D._LAST_FIRE_STATE_KEY] == "20260721-09"          # 一个都没动
    assert D._MARKER_MIGRATION_STATE_KEY not in store.state              # 下次启动会重试


def test_marker_write_failure_keeps_old_value(tz_la):
    class _MarkerWriteFails(_FakeStore):
        def set_state(self, key: str, value: str) -> bool:
            if key == D._LAST_FIRE_STATE_KEY:
                return False
            return super().set_state(key, value)

    store = _MarkerWriteFails({D._LAST_FIRE_STATE_KEY: "20260721-09"})
    D._migrate_fire_marker(store)
    assert store.state[D._LAST_FIRE_STATE_KEY] == "20260721-09"
    assert store.state[D._MARKER_MIGRATION_STATE_KEY] == "1"   # 标记位已落，不重试


def test_tick_loop_runs_migration_on_start(tz_la):
    """迁移入口真的接在 tick_loop 上（否则上面的用例只测了一个没人调的函数）。"""
    store = _FakeStore({D._LAST_FIRE_STATE_KEY: "20260721-09"})
    fired: List[str] = []

    async def run_once(slot: str):
        fired.append(slot)
        store.set_state(D._LAST_FIRE_STATE_KEY, slot)   # 真 run_digest_once 也这么记

    async def _go():
        shutdown = asyncio.Event()
        task = asyncio.create_task(D.tick_loop(
            sync_store=store, run_once=run_once, shutdown_event=shutdown,
            interval_sec=0, fire_hours=[9],
            now_fn=lambda: datetime(2026, 7, 21, 17, 0, tzinfo=_UTC).astimezone(),
        ))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        shutdown.set()
        await asyncio.wait_for(task, timeout=2)

    asyncio.run(_go())
    # 不迁移的话旧北京日 marker 会吃掉这次 catch-up → fired 为空。
    assert fired == ["20260721-09"]
    assert store.state[D._MARKER_MIGRATION_STATE_KEY] == "1"
