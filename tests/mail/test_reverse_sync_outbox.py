"""NotionToMailSync outbox 路径单测 (Sprint 15 hotfix 2 — 架构纯净化).

覆盖 reverse_sync.py 路径 B 迁 outbox 后的行为:
- outbox_repo 注入: sync_single_page 写 outbox 不调 arm
- _compute_payload_and_target: FLAG_ACTIONS 双 True / READ_ACTIONS 只 is_read /
  未知 ai_action 默认 mark read
- update_local_flags 仍写 SQLite (echo prevention 立即生效)
- update_page_mail_sync_status 仍直接调 (带外 ack)
- outbox_repo=None: 老路径 (调 arm + update_store_flags)

按 conftest.py async hook 写: async def test_xxx 自动 asyncio.run 包裹。
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.mail.reverse_sync import NotionToMailSync


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def notion_sync():
    n = MagicMock()
    n.query_pages_for_reverse_sync = AsyncMock(return_value=[])
    n.update_page_mail_sync_status = AsyncMock(return_value=None)
    return n


@pytest.fixture
def arm():
    a = MagicMock()
    a.mark_as_read_by_id = MagicMock(return_value=True)
    a.set_flag_by_id = MagicMock(return_value=True)
    a.mark_as_read = MagicMock(return_value=True)
    a.set_flag = MagicMock(return_value=True)
    return a


@pytest.fixture
def sync_store():
    """Mock SyncStore. get_by_message_id 返回带 internal_id 的 record."""
    s = MagicMock()
    s.get_by_message_id.return_value = {
        "internal_id": 1001, "is_read": False, "is_flagged": False
    }
    s.get.return_value = {"is_read": False, "is_flagged": False}
    s.update_local_flags = MagicMock(return_value=True)
    return s


@pytest.fixture
def outbox_repo():
    r = MagicMock()
    r.enqueue = MagicMock(return_value=42)
    # SSoT 守卫默认放行 (无未派发完成的本地 intent)。
    r.count_pending = MagicMock(return_value=0)
    return r


def _make_sync(notion_sync, arm, sync_store, outbox_repo=None):
    return NotionToMailSync(
        notion_sync=notion_sync,
        arm=arm,
        sync_store=sync_store,
        skip_notify=True,
        outbox_repo=outbox_repo,
    )


def _page(ai_action="需要回复", message_id="<msg-1001@example.com>", page_id="page-uuid"):
    return {
        "page_id": page_id,
        "message_id": message_id,
        "ai_action": ai_action,
        "mailbox": "收件箱",
    }


# ============================================================
# _compute_payload_and_target — 算 payload + 目标 state
# ============================================================

class TestComputePayload:
    def test_flag_actions(self, notion_sync, arm, sync_store):
        s = _make_sync(notion_sync, arm, sync_store)
        record = {"is_read": False, "is_flagged": False}
        for action in ("需要回复", "需要决策", "需要Review", "需要会议", "需要跟进", "等待响应"):
            payload, tr, tf = s._compute_payload_and_target(action, record)
            assert payload == {"is_read": True, "is_flagged": True}, action
            assert (tr, tf) == (True, True), action

    def test_read_actions_preserve_flagged(self, notion_sync, arm, sync_store):
        s = _make_sync(notion_sync, arm, sync_store)
        # current is_flagged=True 时, 仅 is_read → 仅 is_read 入 payload, target 保留
        record = {"is_read": False, "is_flagged": True}
        for action in ("仅供参考", "已完结"):
            payload, tr, tf = s._compute_payload_and_target(action, record)
            assert payload == {"is_read": True}, action
            assert (tr, tf) == (True, True), action  # is_flagged 保 True

    def test_unknown_action_default_mark_read(self, notion_sync, arm, sync_store):
        s = _make_sync(notion_sync, arm, sync_store)
        payload, tr, tf = s._compute_payload_and_target("奇怪动作", {"is_read": False, "is_flagged": False})
        assert payload == {"is_read": True}
        assert (tr, tf) == (True, False)

    def test_empty_ai_action(self, notion_sync, arm, sync_store):
        s = _make_sync(notion_sync, arm, sync_store)
        payload, tr, tf = s._compute_payload_and_target("", {})
        assert payload == {"is_read": True}

    def test_no_record_treats_current_as_false(self, notion_sync, arm, sync_store):
        s = _make_sync(notion_sync, arm, sync_store)
        payload, tr, tf = s._compute_payload_and_target("仅供参考", None)
        assert payload == {"is_read": True}
        assert (tr, tf) == (True, False)


# ============================================================
# sync_single_page — outbox 路径
# ============================================================

class TestOutboxPath:
    async def test_flag_action_writes_outbox_skip_arm(
        self, notion_sync, arm, sync_store, outbox_repo,
    ):
        s = _make_sync(notion_sync, arm, sync_store, outbox_repo=outbox_repo)
        result = await s.sync_single_page(_page(ai_action="需要回复"))
        assert result is True

        # arm 不调用
        arm.mark_as_read_by_id.assert_not_called()
        arm.set_flag_by_id.assert_not_called()
        arm.mark_as_read.assert_not_called()
        arm.set_flag.assert_not_called()

        # outbox 入队: target=mailapp, source=reverse_sync_poll, payload 双 True
        outbox_repo.enqueue.assert_called_once()
        kwargs = outbox_repo.enqueue.call_args.kwargs
        assert kwargs["target"] == "mailapp"
        assert kwargs["source"] == "reverse_sync_poll"
        assert kwargs["op_type"] == "flag_sync"
        assert kwargs["payload"] == {"is_read": True, "is_flagged": True}
        assert kwargs["internal_id"] == 1001

        # update_local_flags 立即写 (echo prevention + Notion 已同步镜像)
        sync_store.update_local_flags.assert_called_once_with(
            1001, True, True, processing_status="已同步"
        )

        # update_page_mail_sync_status 仍直接调 (带外 ack)
        notion_sync.update_page_mail_sync_status.assert_called_once_with(
            "page-uuid", synced=True, processing_status="已同步"
        )

    async def test_read_action_payload_only_is_read(
        self, notion_sync, arm, sync_store, outbox_repo,
    ):
        s = _make_sync(notion_sync, arm, sync_store, outbox_repo=outbox_repo)
        await s.sync_single_page(_page(ai_action="仅供参考"))
        kwargs = outbox_repo.enqueue.call_args.kwargs
        assert kwargs["payload"] == {"is_read": True}

    async def test_email_not_found_skips_outbox(
        self, notion_sync, arm, sync_store, outbox_repo,
    ):
        """Mail.app 找不到 → 不入 outbox, 直接 ack Notion 标 synced."""
        # 让 _lookup_internal_id 返 None
        sync_store.get_by_message_id.return_value = None
        # Envelope Index fallback 也 fail
        s = _make_sync(notion_sync, arm, sync_store, outbox_repo=outbox_repo)
        # 模拟 SQLiteRadar fallback 也找不到
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(
                "src.mail.reverse_sync.SQLiteRadar",
                lambda **kwargs: MagicMock(db_path=None),
            )
            result = await s.sync_single_page(_page())

        assert result is True
        outbox_repo.enqueue.assert_not_called()
        # Notion 仍被标 synced (避免无限重试)
        notion_sync.update_page_mail_sync_status.assert_called_once()


# ============================================================
# SSoT 守卫 — 本地 flag intent 未派发完成时, Notion 端旧状态不回写
# ============================================================

class TestPendingIntentGuard:
    async def test_pending_local_intent_skips_overwrite_and_enqueue(
        self, notion_sync, arm, sync_store, outbox_repo,
    ):
        """本邮件有 pending flag_sync intent → 不 update_local_flags / 不 enqueue,
        仍 ack Notion (防无限重试), 返回 True。防僵尸: 派发器积压期间 resync 重建
        的页面不得把 Notion 旧旗标写回本地。"""
        outbox_repo.count_pending = MagicMock(return_value=3)
        s = _make_sync(notion_sync, arm, sync_store, outbox_repo=outbox_repo)
        result = await s.sync_single_page(_page(ai_action="需要回复"))

        assert result is True
        outbox_repo.count_pending.assert_called_once_with(1001, op_type="flag_sync")
        sync_store.update_local_flags.assert_not_called()
        outbox_repo.enqueue.assert_not_called()
        # Notion 页仍被 ack 成已同步, 不会无限重试
        notion_sync.update_page_mail_sync_status.assert_called_once()

    async def test_count_pending_exception_fails_open(
        self, notion_sync, arm, sync_store, outbox_repo,
    ):
        """守卫查询失败 → fail-open 放行 (守卫是优化不是闸, 不因它断主流程)。"""
        outbox_repo.count_pending = MagicMock(side_effect=RuntimeError("DB locked"))
        s = _make_sync(notion_sync, arm, sync_store, outbox_repo=outbox_repo)
        result = await s.sync_single_page(_page(ai_action="需要回复"))

        assert result is True
        outbox_repo.enqueue.assert_called_once()
        sync_store.update_local_flags.assert_called_once()


# ============================================================
# sync_single_page — 老路径 (outbox_repo=None) 回退兼容
# ============================================================

class TestLegacyPath:
    async def test_flag_action_calls_arm(self, notion_sync, arm, sync_store):
        s = _make_sync(notion_sync, arm, sync_store, outbox_repo=None)
        await s.sync_single_page(_page(ai_action="需要回复"))
        # 老路径: arm 被调
        arm.mark_as_read_by_id.assert_called_once()
        arm.set_flag_by_id.assert_called_once()
        # 仍 ack Notion
        notion_sync.update_page_mail_sync_status.assert_called_once()

    async def test_read_action_calls_arm_mark_read_only(
        self, notion_sync, arm, sync_store,
    ):
        s = _make_sync(notion_sync, arm, sync_store, outbox_repo=None)
        await s.sync_single_page(_page(ai_action="仅供参考"))
        arm.mark_as_read_by_id.assert_called_once()
        arm.set_flag_by_id.assert_not_called()


# ============================================================
# 防回环 + 错误处理
# ============================================================

class TestErrorHandling:
    async def test_outbox_enqueue_exception_marks_failed(
        self, notion_sync, arm, sync_store, outbox_repo,
    ):
        """outbox.enqueue 抛异常 → sync_single_page 返 success=True (因为
        update_page_mail_sync_status 仍 ack), 但 _enqueue_outbox 内部返 False."""
        outbox_repo.enqueue.side_effect = RuntimeError("DB locked")
        s = _make_sync(notion_sync, arm, sync_store, outbox_repo=outbox_repo)
        result = await s.sync_single_page(_page(ai_action="需要回复"))
        # 仍返 True (Notion 被标 synced 避免无限重试, 跟 arm fail 同语义)
        assert result is True
        notion_sync.update_page_mail_sync_status.assert_called_once()

    async def test_target_only_mailapp_never_notion(
        self, notion_sync, arm, sync_store, outbox_repo,
    ):
        """防 Notion → handler → outbox(notion) → fanout → Notion automation
        → handler 循环: reverse_sync 路径永远不写 target=notion."""
        s = _make_sync(notion_sync, arm, sync_store, outbox_repo=outbox_repo)
        await s.sync_single_page(_page(ai_action="需要回复"))
        # 所有 enqueue 调用 target 都必须是 mailapp
        for call in outbox_repo.enqueue.call_args_list:
            assert call.kwargs["target"] == "mailapp"
