"""_poll_cycle 游标守卫 (PR #23 credit @KevinWangQQ) — 丢邮件修复回归。

洞: check_for_changes 用轻量 STATUS 证明有新邮件后, get_new_emails 的重量级
SEARCH/FETCH 失败曾被 backend 吞成返空 → _poll_cycle 无条件推进游标 →
(last_max, current_max] 窗口邮件永久跳过。

修后三态语义 (本文件锚死):
- backend raise → 游标不动、last_sync_time 不更新, 本轮其余步骤照常跑 (下轮重试);
- 合法返空 ([]) → 游标照常推进 (UIDNEXT 差值会高估: 删信/SEARCH 不匹配,
  空成功不推进会卡死);
- 返非空 → 入库 + 推进。
+ sqlite_radar.get_new_emails 失败 re-raise (不再吞成 [])。

🔴 **2026-08-11 修订: 「合法返空」的定义被收窄了 (B1′)。**

本文件原先把「返空 → 推进」写成"🔒 铁律"并锚死。那条表述**过度泛化**:
它的论证（UIDNEXT 差值会高估, 空成功不推进会卡死）只对 **backend 明确报告
`OK` + 空结果** 成立, 却被写成了"任何 `[]` 都推进"。而当时 backend 在
SELECT/SEARCH/FETCH 非 OK、批量解析少项、internal_id 分配失败时**也返回 `[]`** ——
于是这条"铁律"把「协议失败后永久关窗」一并焊死, 恰恰是 2026-08-11 丢邮件事故
（351 封漏 3 封）的认知根源: 一条恒绿、看起来在保护正确性、实际在阻止修复的闸。

现在 backend 对那些失败一律 raise ``FolderFetchError`` (见 backend/base.py),
所以本文件里 ``[]`` 与"合法空成功"重新等价, 下面的断言依旧成立 —— 但
**不要再把它读成"任何空结果都推进"**。判据是 backend 是否报告了失败:

  OK + 空      → 推进   (本文件 test_legal_empty_advances_cursor 锚住)
  协议/解析失败 → raise → 不推进 (test_b1prime_* 与 backend 侧测试锚住)
  save 写库失败 → 不推进 (test_b1prime_save_failure_blocks_cursor)
"""
from __future__ import annotations

import asyncio
import sqlite3
import time
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
    w._throttle_pause_announced = False
    # KOS 重试 (issue #59, 第 6c 步) 的不健康冷却: 置远未来抑制本轮处理 —— 本文件
    # 只锚游标语义, 且 .env 里 MAILAGENT_KOS_INGEST_ENABLED 可能开着 (flag 门挡不住)。
    w._kos_unhealthy_until = time.monotonic() + 3600
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
    w._extract_contacts = _stub("contacts")
    w._scan_calendar_contacts = _stub("calendar_contacts")
    w._contact_governance_tick = _stub("contact_governance")
    return w


def test_backend_raise_does_not_advance_cursor(tmp_path):
    """get_new_emails 失败 → 游标不动 + last_sync_time 不更新 + 本轮正常结束."""
    w = _watcher(tmp_path, RuntimeError("imap timeout"))
    asyncio.run(w._poll_cycle())  # 不抛
    assert w.sync_store.get_last_max_row_id() == 100      # 游标留在原位
    assert w.sync_store.get_last_sync_time() is None      # 本轮不算成功同步
    assert "pending" in w._called                          # 后续步骤照常跑


def test_legal_empty_advances_cursor(tmp_path):
    """**OK + 空结果**(UIDNEXT 高估) 游标必须照常推进, 否则卡死.

    这是收窄后仍然成立的那一半 —— 注意判据是"backend 没报告失败", 不是"返回了 []"。
    """
    w = _watcher(tmp_path, [])
    asyncio.run(w._poll_cycle())
    assert w.sync_store.get_last_max_row_id() == 200
    assert w.sync_store.get_last_sync_time() is not None


# 旧名保留一轮, 避免外部引用/习惯断裂
test_empty_success_advances_cursor = test_legal_empty_advances_cursor


def test_b1prime_folder_fetch_error_does_not_advance(tmp_path):
    """B1′: 协议/解析失败 (FolderFetchError) → 游标不推进.

    改动前这些失败在 backend 里被静默 ``return []``, 与合法空成功不可区分,
    游标照推 ⇒ 窗口内邮件永久跳过 (2026-08-11 事故的一半根因)。
    """
    from src.mail.backend.base import FolderFetchError

    w = _watcher(tmp_path, FolderFetchError("UID SEARCH failed: typ='NO'"))
    asyncio.run(w._poll_cycle())
    assert w.sync_store.get_last_max_row_id() == 100      # 不推进
    assert w.sync_store.get_last_sync_time() is None
    assert "pending" in w._called                          # 后续步骤照常


def test_b1prime_save_failure_blocks_cursor(tmp_path):
    """B1′: 任一封 save_email 返回 False → 游标不推进.

    🔴 改动前 save_email 的返回值**完全没被接**, 写库失败的那封会随游标推进
    永久出窗。注意这条与 FolderFetchError 是两个独立的洞: backend 成功返回了
    邮件, 是**持久化**失败。
    """
    w = _watcher(tmp_path, [{
        "internal_id": 1_000_000_001,
        "message_id": "m-save-fail@x",
        "subject": "will fail to save",
        "date_received": "2026-08-11T01:00:00+00:00",
        "mailbox": "收件箱",
        "backend_origin": "davmail",
        "imap_uid": 150,
    }])
    w.sync_store.save_email = lambda payload: False        # 模拟写库失败
    asyncio.run(w._poll_cycle())
    assert w.sync_store.get_last_max_row_id() == 100, (
        "save_email 失败却推进了游标 —— 那封邮件永久出窗"
    )
    assert w.sync_store.get_last_sync_time() is None


def test_b2_empty_fetch_gap_is_recorded(tmp_path):
    """B2: STATUS 说有新邮件却一封没取到 → warning + 累计计数 (不再完全静默).

    这不阻断也不告警 (落差多为良性), 但 2026-08-11 那三封的丢失现场就长这样,
    必须留下可查的痕迹。
    """
    w = _watcher(tmp_path, [])          # _Backend.check_for_changes 返回 estimated=5
    asyncio.run(w._poll_cycle())
    assert w.sync_store.get_state(w._EMPTY_GAP_TOTAL_KEY) == "1"
    assert w.sync_store.get_state(w._EMPTY_GAP_LAST_WINDOW_KEY) == "(100, 200]"
    assert w.sync_store.get_state(w._EMPTY_GAP_LAST_KEY) is not None
    # 游标仍推进 (留痕 ≠ 阻断)
    assert w.sync_store.get_last_max_row_id() == 200


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
