"""问题 A 根因 2 — _maybe_trigger_llm_hook 的 _bg 不能对 skipped 结果重发通知中心推送。

runner.run_for_internal_id(force=False) 对已 success 邮件返回
``{ok:True, skipped:'already_success'}`` (labels 空)。
修复后 gate 为 ``ok and not skipped``。
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List

from src.mail.new_watcher import NewWatcher


class _StubRunner:
    """run_for_internal_id 返预设 result (模拟 already_success / 正常成功 / 失败)。"""

    def __init__(self, result: Dict[str, Any]):
        self._result = result
        self.calls: List[int] = []

    async def run_for_internal_id(self, internal_id, **kwargs):
        self.calls.append(internal_id)
        return self._result


class _FakeEmail:
    subject = "Hello"
    sender = "a@b.com"
    sender_name = "A"
    mailbox = "收件箱"


def _run_hook(result: Dict[str, Any]) -> List[tuple]:
    """跑一次 _maybe_trigger_llm_hook 的 _bg 并捕获 _maybe_notify_center_reviewed 调用。"""
    watcher = NewWatcher.__new__(NewWatcher)  # bypass 重构造
    watcher._llm_runner = _StubRunner(result)
    dispatched: List[tuple] = []

    async def _record(email_obj, internal_id, labels):
        dispatched.append((internal_id, labels))

    watcher._maybe_notify_center_reviewed = _record  # type: ignore[method-assign]

    async def _scenario():
        watcher._maybe_trigger_llm_hook(_FakeEmail(), 53675, "page-x")
        await asyncio.sleep(0.02)

    asyncio.run(_scenario())
    return dispatched


def test_skipped_already_success_does_not_dispatch():
    """ok:True + skipped:'already_success' → 不重发通知。"""
    dispatched = _run_hook(
        {"ok": True, "internal_id": 53675, "skipped": "already_success"}
    )
    assert dispatched == []


def test_normal_success_dispatches():
    """ok:True 且无 skipped → 正常 notify。"""
    labels = {"priority": "🔴 紧急", "action_type": "需要回复"}
    dispatched = _run_hook({"ok": True, "internal_id": 53675, "labels": labels})
    assert len(dispatched) == 1
    assert dispatched[0][0] == 53675
    assert dispatched[0][1] == labels


def test_failed_result_does_not_dispatch():
    """ok:False → 不 notify。"""
    dispatched = _run_hook({"ok": False, "internal_id": 53675, "error": "boom"})
    assert dispatched == []


def test_llm_runner_none_is_noop():
    """_llm_runner 未启用 → 直接 return, 不抛。"""
    watcher = NewWatcher.__new__(NewWatcher)
    watcher._llm_runner = None
    watcher._maybe_trigger_llm_hook(_FakeEmail(), 53675, "page-x")
