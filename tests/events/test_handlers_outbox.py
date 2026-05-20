"""tests/events/test_handlers_outbox.py — Sprint 15 Stage 1.4.

覆盖 EventHandlers 3 个反向 handler 在 outbox 启用 / 关闭两种模式下的行为：
- handle_flag_changed: outbox enabled → 写 outbox(target='mailapp', source='notion_webhook')
                       outbox disabled → 老路径 arm 调用
- handle_completed:    outbox enabled → 写 outbox(target='mailapp', source='notion_webhook')
                       (notion_webhook + target='notion' 被 echo prevention 拒,
                        handler 设计本来就不写)
- handle_ai_reviewed:  outbox enabled → 写 2 条 outbox (mailapp + notion, source='ai_reviewed_handler'),
                       echo prevention 因 source 不是 notion_webhook 不拦
                       outbox disabled → 老路径 arm + notion_sync 调用

核心防回环验证: outbox 关闭时无人写 outbox; outbox 开时 notion_webhook 源不会
被任何 target='notion' 命中（除了 ai_reviewed_handler 例外）。
"""

from __future__ import annotations

import sqlite3
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.events.handlers import EventHandlers
from src.mail.sync_store import SyncStore
from src.sync.outbox import OutboxRepository


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def db_path(tmp_path):
    """v10 schema + 1 邮件 row + 1 page_id."""
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    conn = sqlite3.connect(str(path))
    try:
        now = time.time()
        conn.execute(
            "INSERT INTO email_metadata (internal_id, message_id, sync_status, "
            "is_read, is_flagged, mailbox, notion_page_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (5001, "<msg-uuid@example.com>", "synced", 0, 0, "收件箱",
             "page-uuid-abc", now, now),
        )
        conn.commit()
    finally:
        conn.close()
    return str(path)


@pytest.fixture
def sync_store(db_path):
    return SyncStore(db_path)


@pytest.fixture
def outbox_repo(db_path):
    return OutboxRepository(db_path)


@pytest.fixture
def arm():
    """Mock AppleScriptArm (检测老路径有没有调用 set_flag / mark_as_read)."""
    a = MagicMock()
    a.mark_as_read_by_id = MagicMock(return_value=True)
    a.set_flag_by_id = MagicMock(return_value=True)
    a.mark_as_read = MagicMock(return_value=True)
    a.set_flag = MagicMock(return_value=True)
    return a


@pytest.fixture
def notion_sync():
    n = MagicMock()
    n.update_email_flags = AsyncMock(return_value=None)
    n.update_page_mail_sync_status = AsyncMock(return_value=None)
    return n


@pytest.fixture
def handlers_with_outbox(arm, sync_store, notion_sync, outbox_repo):
    return EventHandlers(
        arm=arm,
        sync_store=sync_store,
        notion_sync=notion_sync,
        outbox_repo=outbox_repo,
    )


@pytest.fixture
def handlers_no_outbox(arm, sync_store, notion_sync):
    return EventHandlers(
        arm=arm,
        sync_store=sync_store,
        notion_sync=notion_sync,
        outbox_repo=None,
    )


# ============================================================
# handle_flag_changed
# ============================================================

class TestFlagChangedWithOutbox:
    async def test_writes_outbox_skip_arm(
        self, handlers_with_outbox, outbox_repo, arm, sync_store
    ):
        await handlers_with_outbox.handle_flag_changed({
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                "is_read": True,
                "is_flagged": False,
            }
        })

        # arm 没被调用
        arm.mark_as_read_by_id.assert_not_called()
        arm.set_flag_by_id.assert_not_called()

        # outbox 写了一条 target='mailapp', source='notion_webhook'
        rows = outbox_repo.list_by_internal_id(5001)
        assert len(rows) == 1
        e = rows[0]
        assert e.target == "mailapp"
        assert e.source == "notion_webhook"
        assert e.payload == {"is_read": True}

        # SQLite local state 已被 echo prevention 更新
        record = sync_store.get(5001)
        assert bool(record["is_read"]) is True

    async def test_no_op_when_state_matches(
        self, handlers_with_outbox, outbox_repo, sync_store
    ):
        """payload 与 stored 一致 → 不写 outbox."""
        # stored is_read=False, is_flagged=False; webhook 也告诉我们 is_read=False
        await handlers_with_outbox.handle_flag_changed({
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                "is_read": False,
            }
        })

        rows = outbox_repo.list_by_internal_id(5001)
        assert len(rows) == 0

    async def test_outbox_notion_target_not_written(
        self, handlers_with_outbox, outbox_repo
    ):
        """notion_webhook 源 → handle_flag_changed 永远不写 target='notion'.
        防 Notion→handler→outbox→fanout→Notion 回环."""
        await handlers_with_outbox.handle_flag_changed({
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                "is_read": True,
                "is_flagged": True,
            }
        })

        rows = outbox_repo.list_by_internal_id(5001)
        notion_targets = [r for r in rows if r.target == "notion"]
        assert notion_targets == []


class TestFlagChangedWithoutOutbox:
    async def test_old_path_calls_arm(
        self, handlers_no_outbox, arm, sync_store
    ):
        await handlers_no_outbox.handle_flag_changed({
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                "is_read": True,
            }
        })

        arm.mark_as_read_by_id.assert_called_once()


# ============================================================
# handle_completed
# ============================================================

class TestCompletedWithOutbox:
    async def test_writes_outbox_skip_arm(
        self, handlers_with_outbox, outbox_repo, arm, sync_store
    ):
        # 先把邮件标 flagged 才能触发 completed
        sync_store.update_local_flags(5001, False, True)

        await handlers_with_outbox.handle_completed({
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                # Sprint 15 D 块: handle_completed 现在强守护, 必须 webhook 真带
                # processing_status='已完成' 才动手. 模拟 Notion automation 真实
                # payload.
                "processing_status": "已完成",
            },
        })

        arm.set_flag_by_id.assert_not_called()
        arm.mark_as_read_by_id.assert_not_called()

        rows = outbox_repo.list_by_internal_id(5001)
        assert len(rows) == 1
        e = rows[0]
        assert e.target == "mailapp"
        assert e.source == "notion_webhook"
        assert e.payload == {"is_read": True, "is_flagged": False}

    async def test_already_unflagged_short_circuits(
        self, handlers_with_outbox, outbox_repo, sync_store
    ):
        # stored_flagged 默认 False → 直接 return
        await handlers_with_outbox.handle_completed({
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                "processing_status": "已完成",
            },
        })

        rows = outbox_repo.list_by_internal_id(5001)
        assert len(rows) == 0

    async def test_guard_skips_when_processing_status_not_completed(
        self, handlers_with_outbox, outbox_repo, sync_store
    ):
        """Sprint 15 D 块 hotfix: 即使邮件 stored is_flagged=True, 没有
        processing_status='已完成' 的 webhook 不该 unflag."""
        sync_store.update_local_flags(5001, False, True)

        await handlers_with_outbox.handle_completed({
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                # processing_status 缺失 — Sprint 15 之前会无条件 unflag,
                # 修复后必须 short-circuit
            },
        })

        rows = outbox_repo.list_by_internal_id(5001)
        assert len(rows) == 0

        # SQLite 状态保持不变 (SQLite 用 INTEGER 存 bool, get() 返回 dict 含 1/0)
        record = sync_store.get(5001)
        assert bool(record["is_flagged"]) is True


class TestCompletedWithoutOutbox:
    async def test_old_path_calls_arm(
        self, handlers_no_outbox, arm, sync_store
    ):
        sync_store.update_local_flags(5001, False, True)
        await handlers_no_outbox.handle_completed({
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                "processing_status": "已完成",
            },
        })
        arm.set_flag_by_id.assert_called_once()
        arm.mark_as_read_by_id.assert_called_once()


# ============================================================
# handle_ai_reviewed
# ============================================================

class TestAiReviewedWithOutbox:
    async def test_writes_2_outboxes_no_arm(
        self, handlers_with_outbox, outbox_repo, arm, notion_sync, sync_store
    ):
        await handlers_with_outbox.handle_ai_reviewed({
            "page_id": "page-uuid-abc",
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                "ai_action": "需要回复",
                "ai_priority": "🟢 普通",
                "mailbox": "收件箱",
            },
        })

        arm.set_flag_by_id.assert_not_called()
        arm.mark_as_read_by_id.assert_not_called()
        # update_email_flags 也不被调用（走 outbox）
        notion_sync.update_email_flags.assert_not_called()

        rows = outbox_repo.list_by_internal_id(5001)
        # 2 条：mailapp + notion，source='ai_reviewed_handler' 不被 echo 防御拒
        assert len(rows) == 2
        mailapp_row = next(r for r in rows if r.target == "mailapp")
        notion_row = next(r for r in rows if r.target == "notion")
        assert mailapp_row.source == "ai_reviewed_handler"
        assert mailapp_row.payload == {"is_read": True, "is_flagged": True}
        assert notion_row.source == "ai_reviewed_handler"
        assert notion_row.payload == {
            "is_read": True, "is_flagged": True, "processing_status": "已同步",
        }

    async def test_update_page_mail_sync_status_still_direct(
        self, handlers_with_outbox, notion_sync
    ):
        """带外 ack: update_page_mail_sync_status 仍走直接 API（不经 outbox）."""
        await handlers_with_outbox.handle_ai_reviewed({
            "page_id": "page-uuid-abc",
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                "ai_action": "需要回复",
                "ai_priority": "🟢 普通",
                "mailbox": "收件箱",
            },
        })
        notion_sync.update_page_mail_sync_status.assert_called_once_with(
            "page-uuid-abc", synced=True
        )

    async def test_non_flag_action_writes_unflagged_payload(
        self, handlers_with_outbox, outbox_repo
    ):
        """ai_action='仅供参考' 不在 FLAG_ACTIONS → is_flagged=False."""
        await handlers_with_outbox.handle_ai_reviewed({
            "page_id": "page-uuid-abc",
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                "ai_action": "仅供参考",
                "ai_priority": "🟢 普通",
                "mailbox": "收件箱",
            },
        })

        rows = outbox_repo.list_by_internal_id(5001)
        mailapp_row = next(r for r in rows if r.target == "mailapp")
        assert mailapp_row.payload == {"is_read": True, "is_flagged": False}


class TestAiReviewedWithoutOutbox:
    async def test_old_path_calls_arm_and_notion(
        self, handlers_no_outbox, arm, notion_sync, sync_store
    ):
        await handlers_no_outbox.handle_ai_reviewed({
            "page_id": "page-uuid-abc",
            "properties": {
                "message_id": "<msg-uuid@example.com>",
                "ai_action": "需要回复",
                "ai_priority": "🟢 普通",
                "mailbox": "收件箱",
            },
        })
        arm.mark_as_read_by_id.assert_called_once()
        arm.set_flag_by_id.assert_called_once()
        notion_sync.update_email_flags.assert_called_once()
        notion_sync.update_page_mail_sync_status.assert_called_once()


# ============================================================
# Echo-prevention end-to-end through OutboxRepository.enqueue
# ============================================================

class TestEchoPreventionEndToEnd:
    async def test_notion_webhook_source_to_notion_target_blocked(
        self, outbox_repo
    ):
        """直接走 enqueue 路径模拟未来如果有人误传 source='notion_webhook'
        + target='notion'，应被 silent skip."""
        result = outbox_repo.enqueue(
            internal_id=5001, op_type="flag_sync", target="notion",
            payload={"is_read": True}, source="notion_webhook",
        )
        assert result == -1

        rows = outbox_repo.list_by_internal_id(5001)
        assert all(r.target != "notion" for r in rows)
