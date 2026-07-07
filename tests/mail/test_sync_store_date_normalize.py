"""sync_store._normalize_date_received_iso — 归一 UTC 偏移 (07-07 排序 tz 归一).

AppleScript fallback 写入路径与 davmail 侧 ``_normalize_date_iso`` 同口径:
排序全链路是词法字符串比较, 混杂偏移会让 ``10:54+08:00`` 压过 ``05:58+00:00``。
不同改此处 = 应急回切 AppleScript 时重新混入非 UTC 行 (排序 bug 复发)。
"""
from __future__ import annotations

from datetime import datetime, timezone

from src.mail.sync_store import SyncStore, _local_tz, _normalize_date_received_iso


def test_iso_with_plus8_converts_to_utc():
    out = _normalize_date_received_iso("2026-05-22T14:30:00+08:00")
    assert out == "2026-05-22T06:30:00+00:00"


def test_iso_utc_idempotent():
    """已是 UTC 偏移 → 逐字节不变 (backfill 幂等前提)."""
    out = _normalize_date_received_iso("2026-05-22T06:30:00+00:00")
    assert out == "2026-05-22T06:30:00+00:00"


def test_iso_naive_local_tz_then_utc():
    """ISO naive → 按系统本地 tz (含 DST) 解释, 再转 UTC 偏移."""
    expected = (
        datetime(2026, 1, 27, 23, 1, 25)
        .replace(tzinfo=_local_tz())
        .astimezone(timezone.utc)
        .isoformat()
    )
    out = _normalize_date_received_iso("2026-01-27T23:01:25")
    assert out == expected
    assert out.endswith("+00:00")


def test_space_naive_local_tz_then_utc():
    """mail.app radar 的 space-naive → 本地 tz 解释后转 UTC."""
    expected = (
        datetime(2026, 5, 19, 4, 23, 53)
        .replace(tzinfo=_local_tz())
        .astimezone(timezone.utc)
        .isoformat()
    )
    out = _normalize_date_received_iso("2026-05-19 04:23:53")
    assert out == expected
    assert out.endswith("+00:00")


def test_rfc822_plus8_converts_to_utc():
    out = _normalize_date_received_iso("Fri, 22 May 2026 14:30:00 +0800")
    assert out == "2026-05-22T06:30:00+00:00"


def test_malformed_returns_original():
    assert _normalize_date_received_iso("garbage") == "garbage"
    assert _normalize_date_received_iso("") == ""
    assert _normalize_date_received_iso(None) is None


def test_save_email_persists_utc_offset(tmp_path):
    """端到端: save_email 写入路径落库即 UTC 偏移."""
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email({
        "internal_id": 1,
        "subject": "s",
        "sender": "a@x.com",
        "mailbox": "收件箱",
        "sync_status": "pending",
        "date_received": "2026-07-07T10:54:00+08:00",
    })
    row = store.get(1)
    assert row["date_received"] == "2026-07-07T02:54:00+00:00"
