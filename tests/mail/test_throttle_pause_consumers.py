"""EWS 限流 pause flag 的消费侧回归闸。

davmail_watchdog 检测到 throttle burst 时会置
``sync_state['davmail_uid_backfill_paused']='true'`` (写侧已有测试覆盖), 但此前
全库没有任何消费者 — 「自动暂停」实际什么都没暂停, 限流期间 backfill / 轮询照发
IMAP, 反而加剧 throttle。本文件锁定两个消费点的行为:

- ``DavMailUidMapper.run_backfill``: 限流期间挂起 (sleep 后重查), 不 fetch batch /
  不发 IMAP; flag 复位后自然续跑。
- ``NewWatcher._poll_cycle``: 限流期间整轮跳过 (STATUS / pending fetch / retry 都
  不发), 下一轮 poll 由 watchdog 复位 flag 后自然继续。

applescript 模式无 watchdog → flag 恒非 'true' → 行为不变 (对照测试锁定)。
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from src.mail.backend.davmail_uid_mapper import (
    _PAUSE_KEY,
    _PAUSE_RECHECK_SEC,
    DavMailUidMapper,
)
from src.mail.new_watcher import NewWatcher


# ---------------------------------------------------------------------------
# DavMailUidMapper.run_backfill
# ---------------------------------------------------------------------------

def _make_mapper(flag_values: dict) -> DavMailUidMapper:
    """flag_values: sync_state KV 的可变字典 (get_state 从中读)。"""
    store = MagicMock()
    store.get_state.side_effect = lambda key: flag_values.get(key)
    mapper = DavMailUidMapper(MagicMock(), store)
    mapper.count_pending = MagicMock(return_value=0)  # 裸 sqlite, 测试不建库
    mapper._fetch_batch_to_backfill = MagicMock(return_value=[])  # 空 batch → 正常收尾
    return mapper


@pytest.mark.asyncio
async def test_backfill_pauses_while_flag_set(monkeypatch):
    """flag='true' → 先挂起 (sleep _PAUSE_RECHECK_SEC), 挂起期间零 fetch;
    flag 复位后自然续跑到完成。"""
    flags = {_PAUSE_KEY: "true"}
    mapper = _make_mapper(flags)

    sleep_calls: list[float] = []

    async def fake_sleep(sec):
        sleep_calls.append(sec)
        flags[_PAUSE_KEY] = "false"  # 模拟 watchdog 检测限流解除, 复位 flag

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    result = await mapper.run_backfill()

    # 挂起发生过, 且用的是重查间隔
    assert sleep_calls == [_PAUSE_RECHECK_SEC]
    # 挂起期间零 fetch — fetch 只在 flag 复位后发生
    assert mapper._fetch_batch_to_backfill.call_count == 1
    # flag 复位后正常收尾
    assert result["processed"] == 0


@pytest.mark.asyncio
async def test_backfill_runs_normally_when_flag_clear(monkeypatch):
    """flag 未置 (None, applescript 模式常态) → 不挂起, 直接跑。"""
    mapper = _make_mapper({})

    async def fail_sleep(sec):  # pragma: no cover — 不该被调
        raise AssertionError(f"unexpected sleep({sec}) — flag 未置不应挂起")

    monkeypatch.setattr(asyncio, "sleep", fail_sleep)

    result = await mapper.run_backfill()

    assert mapper._fetch_batch_to_backfill.call_count == 1
    assert result["processed"] == 0


# ---------------------------------------------------------------------------
# NewWatcher._poll_cycle
# ---------------------------------------------------------------------------

class _Sentinel(Exception):
    """哨兵: 流程走到 backend.is_available 即抛 — 证明没有 early-return。"""


def _make_watcher(pause_value):
    w = NewWatcher.__new__(NewWatcher)
    w.sync_store = MagicMock()
    w.sync_store.get_state.side_effect = (
        lambda key: pause_value if key == "davmail_uid_backfill_paused" else None
    )
    w.backend = MagicMock()
    w.backend.is_available.side_effect = _Sentinel()
    w._stats = {"polls": 0}
    return w


@pytest.mark.asyncio
async def test_poll_cycle_skips_whole_round_when_paused():
    """flag='true' → 整轮跳过: backend 零触碰 (STATUS/fetch/retry 都不发)。"""
    w = _make_watcher("true")

    await w._poll_cycle()  # 不应触达 backend (否则 _Sentinel 会冒出来)

    w.backend.is_available.assert_not_called()
    assert w._stats["polls"] == 1  # 计数照常, 只是本轮不发 IMAP


@pytest.mark.asyncio
async def test_poll_cycle_proceeds_when_flag_clear():
    """flag 未置 → 不跳过, 流程正常抵达 backend.is_available (哨兵证明)。"""
    w = _make_watcher(None)

    with pytest.raises(_Sentinel):
        await w._poll_cycle()

    w.backend.is_available.assert_called_once()
