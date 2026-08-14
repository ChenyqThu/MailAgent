"""``src.cleanup.date_received`` — 存量 date_received tz 收敛 (幂等 repair op).

写入侧三条边界的归一见 ``tests/mail/test_sync_store_date_normalize.py``;
本文件只盯**存量收敛**: 幂等 / 不改绝对时刻 / 空与不可解析行不碰。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime

from src.cleanup.date_received import normalize_date_received_utc, to_utc_iso
from src.mail.sync_store import SyncStore


def _seed(db_path: str, rows: list[tuple[int, str | None]]) -> None:
    """绕过 SyncStore 写入 (它会归一) 直接塞存量脏值 —— 模拟老版本写进来的行."""
    SyncStore(db_path)  # 建表
    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            "INSERT INTO email_metadata (internal_id, subject, sender, mailbox, "
            "sync_status, date_received) VALUES (?, 's', 'a@x.com', '收件箱', "
            "'synced', ?)",
            rows,
        )
        conn.commit()
    finally:
        conn.close()


def _read(db_path: str) -> dict[int, str | None]:
    conn = sqlite3.connect(db_path)
    try:
        return {
            r[0]: r[1]
            for r in conn.execute(
                "SELECT internal_id, date_received FROM email_metadata"
            )
        }
    finally:
        conn.close()


def test_to_utc_iso_rejects_unparseable_and_naive():
    """归一不出 tz-aware 结果 → None ("别写"), 不许把没归一伪装成已归一."""
    assert to_utc_iso("garbage") is None
    assert to_utc_iso("") is None
    assert to_utc_iso(None) is None
    assert to_utc_iso("2026-08-14T17:54:15+00:00") == "2026-08-14T17:54:15+00:00"


def test_to_utc_iso_rejects_values_that_parse_but_stay_naive():
    """🔴 tz-aware 闸的**真**判据 —— 上一条测不到它.

    ``_normalize_date_received_iso`` 的 naive 分支只认 ``len >= 19`` 的 ISO 与
    space 形式; 短一截的 (日期-only / 截到分钟) 打不中任何分支, 被**原样返回**。
    那种串 ``datetime.fromisoformat`` 又恰好吃得下 → 少了 ``tzinfo is None``
    这道闸就会把它按**跑这条命令的机器的本地时区**折算后写回去::

        '2026-08-14'       → PT 机器上写成 2026-08-14T07:00:00+00:00
        '2026-08-14T10:54' → PT 机器上写成 2026-08-14T17:54:00+00:00

    即凭空发明一个时刻, 且换台机器结果都不一样。宁可留原值计 unparseable。
    """
    assert to_utc_iso("2026-08-14") is None
    assert to_utc_iso("2026-08-14T10:54") is None


def test_dry_run_reports_but_does_not_write(tmp_path):
    db = str(tmp_path / "t.db")
    _seed(db, [(1, "2026-08-14T10:54:15-07:00"), (2, "2026-08-14T16:28:16+00:00")])

    report = normalize_date_received_utc(db, dry_run=True)

    assert report.scanned == 2
    assert report.changed == 1
    assert report.unchanged == 1
    assert report.samples[0]["internal_id"] == 1
    assert report.samples[0]["after"] == "2026-08-14T17:54:15+00:00"
    # 库未被改动
    assert _read(db)[1] == "2026-08-14T10:54:15-07:00"


def test_write_converges_and_preserves_absolute_instant(tmp_path):
    db = str(tmp_path / "t.db")
    _seed(db, [
        (1, "2026-08-14T10:54:15-07:00"),        # PT, 生产实测的那一行
        (2, "2026-05-22T14:30:00+08:00"),        # 内部系统邮件
        (3, "2026-08-14T16:28:16+00:00"),        # 已归一
    ])
    before = _read(db)

    report = normalize_date_received_utc(db, dry_run=False)
    after = _read(db)

    assert report.changed == 2
    assert after[1] == "2026-08-14T17:54:15+00:00"
    assert after[2] == "2026-05-22T06:30:00+00:00"
    assert after[3] == "2026-08-14T16:28:16+00:00"
    # 🔴 只改偏移表示, 绝对时刻逐行不变
    for iid, old in before.items():
        assert datetime.fromisoformat(after[iid]) == datetime.fromisoformat(old)
    # 全表已收敛
    assert all(v.endswith("+00:00") for v in after.values())


def test_idempotent_second_run_changes_nothing(tmp_path):
    db = str(tmp_path / "t.db")
    _seed(db, [(1, "2026-08-14T10:54:15-07:00"), (2, "2026-05-22T14:30:00+08:00")])

    normalize_date_received_utc(db, dry_run=False)
    snapshot = _read(db)
    second = normalize_date_received_utc(db, dry_run=False)

    assert second.changed == 0
    assert second.unchanged == 2
    assert _read(db) == snapshot


def test_empty_and_null_rows_are_untouched_and_out_of_scope(tmp_path):
    """空 date_received 的落桶语义是独立议题 —— 本 op 不顺手改它, 也不计入 scanned."""
    db = str(tmp_path / "t.db")
    _seed(db, [(1, ""), (2, None), (3, "2026-08-14T10:54:15-07:00")])

    report = normalize_date_received_utc(db, dry_run=False)

    assert report.scanned == 1        # 只有第 3 行进范围
    assert report.changed == 1
    rows = _read(db)
    assert rows[1] == ""
    assert rows[2] is None


def test_unparseable_row_kept_verbatim_and_counted(tmp_path):
    """宁可留一行怪数据, 也不写入一个猜出来的时刻.

    两种 unparseable 形态都要盖住: 彻底解析不动的垃圾串 (``not-a-date``), 以及
    **解析得动但仍是 naive** 的短串 (``2026-08-14``) —— 后者才是危险的那种,
    少了 tz-aware 闸会被按本机时区折算成一个凭空发明的时刻写回去。
    """
    db = str(tmp_path / "t.db")
    _seed(db, [
        (1, "not-a-date"),
        (2, "2026-08-14T10:54:15-07:00"),
        (3, "2026-08-14"),
    ])

    report = normalize_date_received_utc(db, dry_run=False)

    assert report.unparseable == 2
    assert report.changed == 1
    rows = _read(db)
    assert rows[1] == "not-a-date"
    assert rows[3] == "2026-08-14"


def test_batching_handles_more_rows_than_one_batch(tmp_path):
    """分批提交不丢行 (活库可能同时有 backend 在写, 不敢开一条巨事务)."""
    db = str(tmp_path / "t.db")
    _seed(db, [(i, "2026-08-14T10:54:15-07:00") for i in range(1, 1203)])

    report = normalize_date_received_utc(db, dry_run=False)

    assert report.changed == 1202
    assert set(_read(db).values()) == {"2026-08-14T17:54:15+00:00"}
