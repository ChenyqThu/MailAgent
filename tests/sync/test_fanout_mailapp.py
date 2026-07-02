"""MailAppFanout 单测（Sprint 15 Stage 1.3 + 1.6 fanout-no-shortcircuit fix）.

设计说明 (post Stage 1.6):
  Stage 1.4 把 CLI handler 端 update_local_flags 移到 enqueue 之前做 echo
  prevention, 这导致 fanout 时 SQLite cache 跟 payload 已经一致 — 一致不
  代表 Mail.app 真实状态已同步。所以 MailAppFanout 不能用 SQLite 做
  idempotency short-circuit，必须永远调 AppleScript (set read/flagged
  status 本身幂等, 无副作用)。

覆盖:
- 基础: 调 AppleScript + sync_store.update_local_flags 同步
- 部分: payload 只含 is_read / 只含 is_flagged → 只调对应 arm
- noop_no_change: payload 不含 mailapp 关心字段 → 跳过 arm
- noop_email_missing: sync_store 找不到 → 跳过
- AppleScript failure: arm 返回 False → fanout 失败
- mailbox 从 sync_store 取
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock

import pytest

from src.sync.mailapp_fanout import MailAppFanout
from src.sync.outbox import OutboxEntry


# ============================================================
# Fixtures
# ============================================================

def _make_entry(
    *,
    internal_id: int = 1001,
    payload: dict | None = None,
    target: str = "mailapp",
    source: str = "frontend",
) -> OutboxEntry:
    now = time.time()
    return OutboxEntry(
        outbox_id=1,
        internal_id=internal_id,
        op_type="flag_sync",
        target=target,
        payload=payload or {},
        source=source,
        status="processing",
        attempts=0,
        last_error=None,
        next_retry_at=None,
        created_at=now,
        updated_at=now,
    )


@pytest.fixture
def sync_store():
    """Mock SyncStore. 默认 get() 返回 {is_read:False, is_flagged:False, mailbox='收件箱'}."""
    store = MagicMock()
    store.get.return_value = {
        "internal_id": 1001,
        "is_read": False,
        "is_flagged": False,
        "mailbox": "收件箱",
    }
    store.update_local_flags = MagicMock(return_value=True)
    return store


@pytest.fixture
def arm():
    """Mock AppleScriptArm. 默认两个 set 都返回 True."""
    a = MagicMock()
    a.mark_as_read_by_id = MagicMock(return_value=True)
    a.set_flag_by_id = MagicMock(return_value=True)
    return a


@pytest.fixture
def fanout(sync_store, arm):
    return MailAppFanout(sync_store=sync_store, backend=arm)


# ============================================================
# Basic execution
# ============================================================

class TestBasicExecution:
    async def test_is_read_change_calls_arm(self, fanout, sync_store, arm):
        entry = _make_entry(payload={"is_read": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "done"
        arm.mark_as_read_by_id.assert_called_once_with(1001, True, "收件箱")
        arm.set_flag_by_id.assert_not_called()
        # fanout 不再写 SQLite (echo prevention 由 CLI/handler 端做)
        sync_store.update_local_flags.assert_not_called()

    async def test_is_flagged_change_calls_arm(self, fanout, sync_store, arm):
        entry = _make_entry(payload={"is_flagged": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "done"
        arm.set_flag_by_id.assert_called_once_with(1001, True, "收件箱")
        arm.mark_as_read_by_id.assert_not_called()
        sync_store.update_local_flags.assert_not_called()

    async def test_both_changes(self, fanout, sync_store, arm):
        entry = _make_entry(payload={"is_read": True, "is_flagged": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        arm.mark_as_read_by_id.assert_called_once()
        arm.set_flag_by_id.assert_called_once()
        sync_store.update_local_flags.assert_not_called()

    async def test_mailbox_passed_through(self, fanout, sync_store, arm):
        sync_store.get.return_value = {
            "internal_id": 2002, "is_read": False, "is_flagged": False, "mailbox": "发件箱"
        }
        entry = _make_entry(internal_id=2002, payload={"is_read": True})
        await fanout.execute(entry)
        arm.mark_as_read_by_id.assert_called_once_with(2002, True, "发件箱")


# ============================================================
# Idempotency
# ============================================================

class TestAlwaysCallsAppleScript:
    """Stage 1.6 fix: 不基于 SQLite cache 做 idempotency, payload 字段在
    就调 AppleScript (AppleScript 本身幂等), 字段不在就跳过对应调用."""

    async def test_payload_matches_current_still_calls(self, fanout, sync_store, arm):
        """SQLite cache 跟 payload 一致, 仍要调 AppleScript (cache≠Mail.app 真实)."""
        entry = _make_entry(payload={"is_read": False, "is_flagged": False})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "done"
        arm.mark_as_read_by_id.assert_called_once_with(1001, False, "收件箱")
        arm.set_flag_by_id.assert_called_once_with(1001, False, "收件箱")

    async def test_payload_only_is_read_skips_set_flag(self, fanout, sync_store, arm):
        """payload 不含 is_flagged → set_flag_by_id 不调用."""
        entry = _make_entry(payload={"is_read": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "done"
        arm.mark_as_read_by_id.assert_called_once_with(1001, True, "收件箱")
        arm.set_flag_by_id.assert_not_called()

    async def test_payload_only_is_flagged_skips_mark_read(self, fanout, sync_store, arm):
        """payload 只指定 is_flagged → 只调 set_flag."""
        sync_store.get.return_value = {
            "internal_id": 1001, "is_read": True, "is_flagged": True, "mailbox": "收件箱"
        }
        entry = _make_entry(payload={"is_flagged": False})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "done"
        arm.mark_as_read_by_id.assert_not_called()
        arm.set_flag_by_id.assert_called_once_with(1001, False, "收件箱")

    async def test_empty_payload_returns_no_change(self, fanout, sync_store, arm):
        """payload 没 is_read/is_flagged → noop_no_change."""
        entry = _make_entry(payload={"processing_status": "已完成"})  # 不归 mailapp 管
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "noop_no_change"
        arm.mark_as_read_by_id.assert_not_called()
        arm.set_flag_by_id.assert_not_called()


# ============================================================
# Missing email
# ============================================================

class TestEmailMissing:
    async def test_returns_noop_when_sync_store_get_none(self, fanout, sync_store, arm):
        sync_store.get.return_value = None
        entry = _make_entry(internal_id=9999, payload={"is_read": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "noop_email_missing"
        arm.mark_as_read_by_id.assert_not_called()


# ============================================================
# Failure paths
# ============================================================

class TestFailureHandling:
    async def test_mark_as_read_fails_returns_error(self, fanout, sync_store, arm):
        arm.mark_as_read_by_id.return_value = False
        entry = _make_entry(payload={"is_read": True})
        ok, detail = await fanout.execute(entry)
        assert ok is False
        assert "mark_as_read_by_id failed" in detail

    async def test_set_flag_fails_returns_error(self, fanout, sync_store, arm):
        arm.set_flag_by_id.return_value = False
        entry = _make_entry(payload={"is_flagged": True})
        ok, detail = await fanout.execute(entry)
        assert ok is False
        assert "set_flag_by_id failed" in detail

    async def test_both_fail_concat_errors(self, fanout, sync_store, arm):
        arm.mark_as_read_by_id.return_value = False
        arm.set_flag_by_id.return_value = False
        entry = _make_entry(payload={"is_read": True, "is_flagged": True})
        ok, detail = await fanout.execute(entry)
        assert ok is False
        assert "mark_as_read_by_id failed" in detail
        assert "set_flag_by_id failed" in detail

    # test_update_local_flags_exception_not_fatal 删除 — fanout 不再写 SQLite
