"""_poll_cycle 游标守卫 (PR #23 credit @KevinWangQQ) — 丢邮件修复回归。

洞: check_for_changes 用轻量 STATUS 证明有新邮件后, get_new_emails 的重量级
SEARCH/FETCH 失败曾被 backend 吞成返空 → _poll_cycle 无条件推进游标 →
(last_max, current_max] 窗口邮件永久跳过。

修后三态语义 (本文件锚死):
- backend raise → 游标不动、last_sync_time 不更新, 本轮其余步骤照常跑 (下轮重试);
- 合法返空 ([]) → 游标照常推进 (UIDNEXT 差值会高估: 删信/SEARCH 不匹配,
  空成功不推进会卡死) — 🔒 铁律;
- 返非空 → 入库 + 推进。
+ sqlite_radar.get_new_emails 失败 re-raise (不再吞成 [])。
"""
from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from src.mail.new_watcher import NewWatcher
from src.mail.sqlite_radar import SQLiteRadar
from src.mail.sync_store import SyncStore


class _Backend:
    """三态可控 backend: result 是 Exception 实例则 raise, 否则原样返回."""

    def __init__(self, result):
        self._result = result

    def is_available(self):
        return True

    def check_for_changes(self, last_max_row_id):
        return (True, 200, 5)

    def get_new_emails(self, since_row_id):
        if isinstance(self._result, Exception):
            raise self._result
        return self._result


def _watcher(tmp_path: Path, backend_result):
    w = NewWatcher.__new__(NewWatcher)
    w.sync_store = SyncStore(str(tmp_path / "t.db"))
    w.sync_store.set_last_max_row_id(100)
    w._stats = {"polls": 0, "new_emails_detected": 0}
    w.backend = _Backend(backend_result)
    # _poll_cycle 后续步骤全 stub (记录调用, 证明失败轮也正常走完);
    # _reconcile_drafts 用真方法 (backend 无 reconcile_drafts → noop)。
    w._called = []

    def _stub(name):
        async def _f():
            w._called.append(name)
        return _f

    w._process_pending_emails = _stub("pending")
    w._process_retry_queue = _stub("retry")
    w._process_llm_retry_queue = _stub("llm_retry")
    w._detect_and_sync_flag_changes = _stub("flags")
    return w


def test_backend_raise_does_not_advance_cursor(tmp_path):
    """get_new_emails 失败 → 游标不动 + last_sync_time 不更新 + 本轮正常结束."""
    w = _watcher(tmp_path, RuntimeError("imap timeout"))
    asyncio.run(w._poll_cycle())  # 不抛
    assert w.sync_store.get_last_max_row_id() == 100      # 游标留在原位
    assert w.sync_store.get_last_sync_time() is None      # 本轮不算成功同步
    assert "pending" in w._called                          # 后续步骤照常跑


def test_empty_success_advances_cursor(tmp_path):
    """🔒 铁律: 合法返空 (UIDNEXT 高估) 游标必须照常推进, 否则卡死."""
    w = _watcher(tmp_path, [])
    asyncio.run(w._poll_cycle())
    assert w.sync_store.get_last_max_row_id() == 200
    assert w.sync_store.get_last_sync_time() is not None


def test_nonempty_saves_and_advances(tmp_path):
    """返非空 → 入库 (pending) + 游标推进."""
    w = _watcher(tmp_path, [{
        "internal_id": 1_000_000_001,
        "message_id": "m1@x",
        "subject": "hello",
        "sender_email": "a@x.com",
        "sender_name": "A",
        "date_received": "2026-07-07T01:00:00+00:00",
        "mailbox": "收件箱",
        "is_read": False,
        "is_flagged": False,
        "backend_origin": "davmail",
        "imap_uid": 150,
        "imap_uidvalidity": 7,
    }])
    asyncio.run(w._poll_cycle())
    row = w.sync_store.get(1_000_000_001)
    assert row is not None
    assert row["sync_status"] == "pending"
    assert row["imap_uid"] == 150
    assert w.sync_store.get_last_max_row_id() == 200


def test_next_cycle_retries_same_window_after_failure(tmp_path):
    """失败轮后游标未动 → 下轮以同一 since_row_id 重试 (IMAP 恢复即自愈)."""
    w = _watcher(tmp_path, RuntimeError("imap timeout"))
    asyncio.run(w._poll_cycle())
    # IMAP 恢复: 换成成功 backend, 记录收到的 since_row_id
    seen = {}

    class _Recovered(_Backend):
        def get_new_emails(self, since_row_id):
            seen["since"] = since_row_id
            return []

    w.backend = _Recovered([])
    asyncio.run(w._poll_cycle())
    assert seen["since"] == 100                            # 同窗口重试
    assert w.sync_store.get_last_max_row_id() == 200       # 恢复后推进


def test_radar_get_new_emails_reraises(tmp_path):
    """sqlite_radar 路径同形修复: 连接失败 re-raise, 不吞成 []."""
    radar = SQLiteRadar.__new__(SQLiteRadar)
    radar.db_path = tmp_path / "nonexistent-dir" / "Envelope Index"  # 打不开 → 炸
    radar.mailboxes = ["收件箱"]
    radar.account_url_prefix = ""
    with pytest.raises(sqlite3.OperationalError):
        radar.get_new_emails(50)
