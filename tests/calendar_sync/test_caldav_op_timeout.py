"""task 07-15 (#37 最小修) — CalDAV per-op 超时单测.

覆盖:
- ``run_with_caldav_timeout``:
  · 正常返回透传 (零行为差)
  · fn 抛异常 → 同对象 re-raise
  · fn 挂死 (sleep >> timeout) → 在预算内抛 CalDAVTimeoutError, 文案是
    「可能仍在执行」不是「已取消」(被放弃线程可能事后完成操作, 生产实锤)
- ``CalDAVWriter`` 公开操作全部被 ``_caldav_op_timeout`` 包装:
  · 底层 _connect 挂死时按 ``cfg.caldav_op_timeout_seconds`` 预算抛
  · cfg 无该字段 → 默认 60s
  · timeout 不触发时既有语义不变 (found/not-found 由 test_caldav_writer.py
    全量回归覆盖 — 那些测试现在都跑在 wrapper 里)
"""
from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from src.calendar_sync._common import CalDAVTimeoutError, run_with_caldav_timeout
from src.calendar_sync.caldav_writer import CalDAVWriter


# ---------------------------------------------------------------------------
# run_with_caldav_timeout
# ---------------------------------------------------------------------------

def test_passthrough_result():
    assert run_with_caldav_timeout(lambda: 42, timeout_s=5, op_name="t") == 42


def test_passthrough_exception_same_object():
    boom = ValueError("event not found by UID: 'x'")

    def fn():
        raise boom

    with pytest.raises(ValueError) as ei:
        run_with_caldav_timeout(fn, timeout_s=5, op_name="t")
    assert ei.value is boom  # 同对象 re-raise, 上层 'not found' 分流不受影响


def test_timeout_raises_within_budget():
    t0 = time.monotonic()
    with pytest.raises(CalDAVTimeoutError) as ei:
        run_with_caldav_timeout(
            lambda: time.sleep(3), timeout_s=0.2, op_name="delete_event",
        )
    elapsed = time.monotonic() - t0
    assert elapsed < 2.0  # 预算 0.2s + 调度余量, 远小于底层 3s 挂死

    msg = str(ei.value)
    # 语义红线: 被放弃线程可能事后完成 (删除盲挂 7.5min 后真执行了, 生产实锤)
    # — 文案必须说「可能仍在执行」, 不得说「已取消」。
    assert "可能仍在执行" in msg
    assert "取消" not in msg
    assert "delete_event" in msg


# ---------------------------------------------------------------------------
# CalDAVWriter — 公开操作包装
# ---------------------------------------------------------------------------

PUBLIC_OPS = (
    "create_event",
    "update_event",
    "update_occurrence",
    "split_series",
    "delete_event",
)


def _mock_cfg(**over):
    base = dict(
        user_email="bob@example.com",
        davmail_imap_host="127.0.0.1",
        davmail_caldav_port=1080,
        davmail_cipher_key="test-key",
        davmail_poc_mode=False,
    )
    base.update(over)
    return SimpleNamespace(**base)


def test_all_public_ops_wrapped():
    """五个公开操作全挂 _caldav_op_timeout (functools.wraps 留 __wrapped__)."""
    for op in PUBLIC_OPS:
        assert hasattr(getattr(CalDAVWriter, op), "__wrapped__"), op


def test_op_timeout_default_60s_when_cfg_missing_field():
    w = CalDAVWriter(_mock_cfg())
    assert w.op_timeout_s == 60.0


def test_op_timeout_reads_cfg_field():
    w = CalDAVWriter(_mock_cfg(caldav_op_timeout_seconds=15))
    assert w.op_timeout_s == 15.0


def test_delete_event_times_out_on_hung_connect(monkeypatch):
    """_connect 挂死 (模拟 EWS 节流盲挂) → delete_event 在预算内抛超时."""
    w = CalDAVWriter(_mock_cfg(caldav_op_timeout_seconds=0.2))
    monkeypatch.setattr(CalDAVWriter, "_connect", lambda self: time.sleep(3))

    t0 = time.monotonic()
    with pytest.raises(CalDAVTimeoutError):
        w.delete_event(ical_uid="uid-hang")
    assert time.monotonic() - t0 < 2.0


def test_update_event_times_out_on_hung_connect(monkeypatch):
    w = CalDAVWriter(_mock_cfg(caldav_op_timeout_seconds=0.2))
    monkeypatch.setattr(CalDAVWriter, "_connect", lambda self: time.sleep(3))

    with pytest.raises(CalDAVTimeoutError):
        w.update_event(ical_uid="uid-hang", summary="x")
