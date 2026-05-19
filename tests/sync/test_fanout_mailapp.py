"""MailAppFanout 单测（Sprint 15 Stage 1.3）.

覆盖:
- 基础: 状态变化 → arm 调用 + sync_store.update_local_flags 同步
- Idempotency: payload == current 状态 → noop_idempotent, 不调 AppleScript
- Email missing: sync_store 找不到 → noop_email_missing
- AppleScript failure: arm 返回 False → fanout 失败
- 部分变化: 只 is_read 变 / 只 is_flagged 变
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
    return MailAppFanout(sync_store=sync_store, arm=arm)


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
        sync_store.update_local_flags.assert_called_once_with(1001, True, False)

    async def test_is_flagged_change_calls_arm(self, fanout, sync_store, arm):
        entry = _make_entry(payload={"is_flagged": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "done"
        arm.set_flag_by_id.assert_called_once_with(1001, True, "收件箱")
        arm.mark_as_read_by_id.assert_not_called()
        sync_store.update_local_flags.assert_called_once_with(1001, False, True)

    async def test_both_changes(self, fanout, sync_store, arm):
        entry = _make_entry(payload={"is_read": True, "is_flagged": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        arm.mark_as_read_by_id.assert_called_once()
        arm.set_flag_by_id.assert_called_once()
        sync_store.update_local_flags.assert_called_once_with(1001, True, True)

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

class TestIdempotency:
    async def test_noop_when_state_matches(self, fanout, sync_store, arm):
        """Current is_read=False is_flagged=False; payload 也写 False → noop."""
        entry = _make_entry(payload={"is_read": False, "is_flagged": False})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "noop_idempotent"
        arm.mark_as_read_by_id.assert_not_called()
        arm.set_flag_by_id.assert_not_called()
        sync_store.update_local_flags.assert_not_called()

    async def test_noop_when_payload_partial_matches_current(self, fanout, sync_store, arm):
        """Current is_read=True, payload 只指定 is_read=True → noop."""
        sync_store.get.return_value = {
            "internal_id": 1001, "is_read": True, "is_flagged": False, "mailbox": "收件箱"
        }
        entry = _make_entry(payload={"is_read": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "noop_idempotent"
        arm.mark_as_read_by_id.assert_not_called()

    async def test_payload_unspecified_key_preserved(self, fanout, sync_store, arm):
        """Current is_read=True is_flagged=True; payload 只指定 is_flagged=False.
        is_read 保持 True (不变), is_flagged 翻 False (变化) → 只调 set_flag."""
        sync_store.get.return_value = {
            "internal_id": 1001, "is_read": True, "is_flagged": True, "mailbox": "收件箱"
        }
        entry = _make_entry(payload={"is_flagged": False})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "done"
        arm.mark_as_read_by_id.assert_not_called()
        arm.set_flag_by_id.assert_called_once_with(1001, False, "收件箱")
        # update_local_flags 持久 (is_read=True, is_flagged=False)
        sync_store.update_local_flags.assert_called_once_with(1001, True, False)


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

    async def test_update_local_flags_exception_not_fatal(self, fanout, sync_store, arm):
        """sync_store.update_local_flags 抛异常不应该让 fanout 失败
        (AppleScript 已经写成功了, 不能因为 echo prevention 失败就重试整条 outbox)."""
        sync_store.update_local_flags.side_effect = RuntimeError("disk full")
        entry = _make_entry(payload={"is_read": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "done"
