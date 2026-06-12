"""_poll_cycle 游标推进语义 — 拉取失败不丢邮件 (2026-06-10 丢信回归).

根因链: backend.get_new_emails 失败被吞 → _poll_cycle 拿到空列表当"没新邮件" →
第 4 步无条件 set_last_max_row_id(current_max) → (last_max, current_max] 窗口内
的邮件永久跳过。修复后: 拉取抛异常时本轮放弃、游标不动, 下轮天然重试同一窗口。
"""
from __future__ import annotations

import asyncio

from src.mail.new_watcher import NewWatcher


class _StubRadar:
    """check_for_changes 报告有新邮件; get_new_emails 行为由测试注入."""

    def __init__(self, get_new_emails_result):
        # exception 实例 → 抛出; 否则当返回值
        self._result = get_new_emails_result

    def is_available(self):
        return True

    def check_for_changes(self, last_max_row_id):
        # 模拟 2026-06-10 实况: row_id 535800 -> 535832, ~32 封新邮件
        return True, 535832, 32

    def get_new_emails(self, since_row_id):
        if isinstance(self._result, Exception):
            raise self._result
        return self._result


class _StubSyncStore:
    def __init__(self):
        self.last_max_row_id = 535800
        self.saved = []

    def get_last_max_row_id(self):
        return self.last_max_row_id

    def set_last_max_row_id(self, value):
        self.last_max_row_id = value

    def set_last_sync_time(self, value):
        pass

    def get(self, internal_id):
        return None  # 不存在 → save_email 会被调用

    def save_email(self, payload):
        self.saved.append(payload)
        return True


def _make_watcher(radar):
    w = NewWatcher.__new__(NewWatcher)
    w._stats = {"polls": 0, "new_emails_detected": 0}
    w.radar = radar
    w.sync_store = _StubSyncStore()

    async def _noop():
        pass

    w._process_pending_emails = _noop
    w._process_retry_queue = _noop
    w._process_llm_retry_queue = _noop
    w._detect_and_sync_flag_changes = _noop
    return w


def test_poll_cycle_fetch_failure_keeps_cursor():
    """get_new_emails 抛超时 → last_max_row_id 不变 (失败窗口下轮重试)."""
    w = _make_watcher(_StubRadar(TimeoutError("timed out")))

    asyncio.run(w._poll_cycle())

    assert w.sync_store.last_max_row_id == 535800  # 游标未被推到 535832
    assert w.sync_store.saved == []


def test_poll_cycle_fetch_success_advances_cursor():
    """对照: 拉取成功 (含空列表) → 游标照常推进, 邮件正常入库."""
    emails = [{
        "internal_id": 1_000_000_001,
        "message_id": "<m1@x>",
        "subject": "S",
        "sender": "a@b",
        "backend_origin": "davmail",
        "imap_uid": 100,
        "imap_uidvalidity": 12345,
    }]
    w = _make_watcher(_StubRadar(emails))

    asyncio.run(w._poll_cycle())

    assert w.sync_store.last_max_row_id == 535832
    assert len(w.sync_store.saved) == 1
    assert w.sync_store.saved[0]["internal_id"] == 1_000_000_001


def test_poll_cycle_empty_result_still_advances_cursor():
    """对照: 成功但 0 封 (估算偏差) ≠ 失败 → 游标仍推进, 不卡死."""
    w = _make_watcher(_StubRadar([]))

    asyncio.run(w._poll_cycle())

    assert w.sync_store.last_max_row_id == 535832
    assert w.sync_store.saved == []
