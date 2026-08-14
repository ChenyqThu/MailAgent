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


def test_negative_offset_converts_to_utc():
    """PT 本地偏移 (-07:00) 同样归一 —— 生产实测的那一行就长这样.

    ``2026-08-14T10:54:15-07:00`` 绝对是 17:54Z, 却在字典序上被
    ``2026-08-14T16:28:16+00:00`` (绝对 16:28Z) 压到后面 → 线程 head 选错。
    """
    out = _normalize_date_received_iso("2026-08-14T10:54:15-07:00")
    assert out == "2026-08-14T17:54:15+00:00"


# ============================================================
# 三条持久化边界 —— 归一在边界收口, 未来新调用方自动被覆盖
# ============================================================


def _base_email(internal_id: int, date_received: str) -> dict:
    return {
        "internal_id": internal_id,
        "message_id": f"m{internal_id}@x",
        "subject": "s",
        "sender": "a@x.com",
        "mailbox": "收件箱",
        "sync_status": "pending",
        "date_received": date_received,
    }


def test_save_email_persists_utc_offset(tmp_path):
    """边界 1/3: ``_save_email_v3`` (单封 INSERT OR REPLACE)."""
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


def test_save_emails_batch_persists_utc_offset(tmp_path):
    """边界 2/3: ``save_emails_batch`` (initial_sync 的 executemany).

    这条曾经**没有**归一 —— 首次全量同步写进来的行会带原始偏移, 与增量路径
    (已归一) 混在同一张表里, 正是词法排序错乱的成因。
    """
    store = SyncStore(str(tmp_path / "t.db"))
    saved = store.save_emails_batch([
        _base_email(1, "2026-08-14T10:54:15-07:00"),
        _base_email(2, "2026-08-14T16:28:16+00:00"),
        _base_email(3, "Fri, 22 May 2026 14:30:00 +0800"),
    ])
    assert saved == 3
    assert store.get(1)["date_received"] == "2026-08-14T17:54:15+00:00"
    assert store.get(2)["date_received"] == "2026-08-14T16:28:16+00:00"
    assert store.get(3)["date_received"] == "2026-05-22T06:30:00+00:00"


def test_save_emails_batch_preserves_absolute_ordering(tmp_path):
    """归一后**词法序 == 时间序** —— 这才是修复要保住的性质.

    未归一时 ``10:54-07:00`` (绝对更晚) 的字典序比 ``16:28+00:00`` 小。
    """
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_emails_batch([
        _base_email(1, "2026-08-14T10:54:15-07:00"),   # 绝对 17:54Z, 更晚
        _base_email(2, "2026-08-14T16:28:16+00:00"),   # 绝对 16:28Z, 更早
    ])
    later = store.get(1)["date_received"]
    earlier = store.get(2)["date_received"]
    assert later > earlier  # 纯字符串比较, 与 SQL ORDER BY / localeCompare 同口径


def test_update_after_fetch_normalizes_date_received(tmp_path):
    """边界 3/3: ``update_after_fetch`` 的动态 SET.

    当前无调用方传这个键, 但它一直在 ``allowed_fields`` 里 —— 归一在边界,
    未来任意新调用方自动被覆盖 (与 message_id 的 ``_storage_message_id`` 同纪律)。
    """
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email(_base_email(1, "2026-08-14T16:28:16+00:00"))
    store.update_after_fetch(1, {"date_received": "2026-08-14T10:54:15-07:00"})
    assert store.get(1)["date_received"] == "2026-08-14T17:54:15+00:00"


def test_update_after_fetch_empty_date_stays_empty(tmp_path):
    """空值不被"归一"成猜出来的时刻 —— 与 ``_save_email_v3`` 同口径落空串."""
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email(_base_email(1, "2026-08-14T16:28:16+00:00"))
    store.update_after_fetch(1, {"date_received": ""})
    assert store.get(1)["date_received"] == ""
