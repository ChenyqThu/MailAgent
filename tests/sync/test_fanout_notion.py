"""NotionFanout 单测（Sprint 15 Stage 1.3）.

覆盖:
- 基础: flag 变化 → notion_sync.update_email_flags 调用
- notion_page_id NULL → noop_no_page_id (邮件还没同步到 Notion)
- Email missing → noop_email_missing
- Idempotency: flag 没变 + 无 processing_status → noop
- processing_status 单独触发也算 work (即使 flag 没变)
- Notion API 异常 → (False, error)
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.sync.notion_fanout import NotionFanout
from src.sync.outbox import OutboxEntry


# ============================================================
# Fixtures
# ============================================================

def _make_entry(
    *,
    internal_id: int = 1001,
    payload: dict | None = None,
    target: str = "notion",
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
    """Mock SyncStore. 默认含 notion_page_id."""
    store = MagicMock()
    store.get.return_value = {
        "internal_id": 1001,
        "is_read": False,
        "is_flagged": False,
        "notion_page_id": "page-uuid-abc",
        "mailbox": "收件箱",
    }
    return store


@pytest.fixture
def notion_sync():
    """Mock NotionSync. update_email_flags 是 async."""
    n = MagicMock()
    n.update_email_flags = AsyncMock(return_value=None)
    return n


@pytest.fixture
def fanout(sync_store, notion_sync):
    return NotionFanout(sync_store=sync_store, notion_sync=notion_sync)


# ============================================================
# Basic execution
# ============================================================

class TestBasicExecution:
    async def test_flag_change_calls_notion(self, fanout, sync_store, notion_sync):
        entry = _make_entry(payload={"is_read": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "done"
        notion_sync.update_email_flags.assert_called_once_with(
            "page-uuid-abc",
            is_read=True,
            is_flagged=False,
            processing_status="",
        )

    async def test_both_flag_and_processing_status(self, fanout, sync_store, notion_sync):
        entry = _make_entry(payload={
            "is_read": True, "is_flagged": True, "processing_status": "已完成"
        })
        ok, detail = await fanout.execute(entry)
        assert ok is True
        notion_sync.update_email_flags.assert_called_once_with(
            "page-uuid-abc",
            is_read=True,
            is_flagged=True,
            processing_status="已完成",
        )

    async def test_processing_status_only_is_work(self, fanout, sync_store, notion_sync):
        """payload 只有 processing_status，flag 没变也不算 noop."""
        entry = _make_entry(payload={"processing_status": "AI Reviewed"})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "done"
        notion_sync.update_email_flags.assert_called_once_with(
            "page-uuid-abc",
            is_read=False,
            is_flagged=False,
            processing_status="AI Reviewed",
        )


# ============================================================
# Skip conditions
# ============================================================

class TestSkipConditions:
    async def test_no_notion_page_id_skipped(self, fanout, sync_store, notion_sync):
        sync_store.get.return_value = {
            "internal_id": 1001,
            "is_read": False,
            "is_flagged": False,
            "notion_page_id": None,
        }
        entry = _make_entry(payload={"is_read": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "noop_no_page_id"
        notion_sync.update_email_flags.assert_not_called()

    async def test_empty_page_id_skipped(self, fanout, sync_store, notion_sync):
        sync_store.get.return_value = {
            "internal_id": 1001,
            "is_read": False,
            "is_flagged": False,
            "notion_page_id": "",
        }
        entry = _make_entry(payload={"is_read": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "noop_no_page_id"
        notion_sync.update_email_flags.assert_not_called()

    async def test_email_missing(self, fanout, sync_store, notion_sync):
        sync_store.get.return_value = None
        entry = _make_entry(internal_id=9999, payload={"is_read": True})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "noop_email_missing"
        notion_sync.update_email_flags.assert_not_called()


# ============================================================
# Idempotency
# ============================================================

class TestAlwaysCallsNotionApi:
    """Stage 1.6 fix: 不基于 SQLite cache 做 idempotency, payload 有 notion
    字段就调 update_email_flags (Notion pages.update 幂等). 字段都没有才 noop."""

    async def test_payload_matches_current_still_calls(self, fanout, sync_store, notion_sync):
        """SQLite cache 跟 payload 一致, 仍要调 Notion (cache≠Notion 真实状态)."""
        entry = _make_entry(payload={"is_read": False, "is_flagged": False})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "done"
        notion_sync.update_email_flags.assert_called_once()

    async def test_empty_payload_returns_no_change(self, fanout, sync_store, notion_sync):
        """payload 没 is_read/is_flagged/processing_status → noop_no_change."""
        entry = _make_entry(payload={"some_other_key": "ignored"})
        ok, detail = await fanout.execute(entry)
        assert ok is True
        assert detail == "noop_no_change"
        notion_sync.update_email_flags.assert_not_called()


# ============================================================
# Failure handling
# ============================================================

class TestFailure:
    async def test_notion_exception_returns_error(self, fanout, sync_store, notion_sync):
        notion_sync.update_email_flags.side_effect = RuntimeError("Notion 429")
        entry = _make_entry(payload={"is_read": True})
        ok, detail = await fanout.execute(entry)
        assert ok is False
        assert "notion update_email_flags failed" in detail
        assert "Notion 429" in detail
