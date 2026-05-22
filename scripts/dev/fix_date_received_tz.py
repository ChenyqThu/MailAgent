#!/usr/bin/env python3
"""一次性修复: 撤回之前 normalize_date_received_iso.py 错标 +08:00 的存量行.

Sprint 16 cutover 后第一版 normalize 把所有 naive date_received 一律加 ``+08:00``,
但 mail.app SQLite radar 输出的是**系统本地 tz** naive (PDT 用户 = -07:00). 5148 行
被错标 → 前端显示时间偏差 ~15h.

本脚本扫所有 ``YYYY-MM-DDTHH:MM:SS+08:00`` (长度 25, 末尾 ``+08:00``) 行:
  - 把 tz suffix 撤掉拿 naive
  - 用系统 IANA zone (America/Los_Angeles 等) 加上正确 tz (按邮件日期算 DST)
  - 覆盖回 SQLite

误伤面: raw MIME 真带 ``+08:00`` 的中国发件人邮件 (少数, 看上次 audit 是 5 行) 也会
被改成系统本地 tz; 但绝对时间值偏差跟正确比也只是 tz label 错, raw 时分秒未变;
排序仍按 mail.app 接收顺序排列. 整体净效果远好于现状全错.

用法:
  source venv/bin/activate
  python scripts/dev/fix_date_received_tz.py --dry-run
  python scripts/dev/fix_date_received_tz.py --yes
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.mail.sync_store import _local_tz  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/sync_store.db")
    ap.add_argument("--dry-run", action="store_true", default=True)
    ap.add_argument("--yes", action="store_true", help="confirm + 真跑")
    ap.add_argument("--sample", type=int, default=10)
    args = ap.parse_args()
    if args.yes:
        args.dry_run = False

    local_tz = _local_tz()
    print(f"db: {args.db}")
    print(f"local tz: {local_tz}")
    print(f"mode: {'DRY-RUN' if args.dry_run else 'WRITE'}\n")

    with sqlite3.connect(args.db) as conn:
        conn.row_factory = sqlite3.Row
        # 只挑长度 25, 末尾 +08:00 的 row
        rows = conn.execute(
            """SELECT internal_id, date_received FROM email_metadata
                WHERE date_received IS NOT NULL
                  AND length(date_received) = 25
                  AND substr(date_received, -6) = '+08:00'"""
        ).fetchall()

    total = len(rows)
    print(f"candidate rows (25-char +08:00): {total}\n")

    changes: list[tuple[int, str, str]] = []
    skipped = 0
    failed = 0
    for r in rows:
        iid = r["internal_id"]
        before = r["date_received"]
        # 撤回 +08:00 → naive datetime
        naive_str = before[:19]  # "YYYY-MM-DDTHH:MM:SS"
        try:
            naive_dt = datetime.fromisoformat(naive_str)
        except ValueError as e:
            print(f"  ERROR iid={iid} {before!r}: {e}", file=sys.stderr)
            failed += 1
            continue
        # 加系统 tz (含 DST)
        aware_dt = naive_dt.replace(tzinfo=local_tz)
        after = aware_dt.isoformat()
        if after == before:
            skipped += 1
            continue
        changes.append((iid, before, after))

    print(f"to update: {len(changes)}")
    print(f"unchanged (system tz happens to be +08:00): {skipped}")
    print(f"failed: {failed}")

    if changes:
        print(f"\nsample (first {min(args.sample, len(changes))}):")
        for iid, b, a in changes[:args.sample]:
            print(f"  iid={iid:>10}  {b!r:<28} → {a!r}")

    if args.dry_run:
        print("\n(dry-run — use --yes to apply)")
        sys.exit(0)

    if not changes:
        print("\nnothing to update.")
        sys.exit(0)

    print(f"\napplying {len(changes)} UPDATEs ...")
    with sqlite3.connect(args.db, timeout=30.0) as conn:
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.executemany(
            "UPDATE email_metadata SET date_received = ? WHERE internal_id = ?",
            [(a, iid) for iid, _, a in changes],
        )
        conn.commit()
    print(f"done. {len(changes)} rows updated.")


if __name__ == "__main__":
    main()
