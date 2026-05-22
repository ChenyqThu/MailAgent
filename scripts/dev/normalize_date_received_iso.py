#!/usr/bin/env python3
"""一次性 backfill: email_metadata.date_received 全部归一成 ISO 8601 带 tz.

Sprint 16 cutover 发现 SSoT 时间格式不统一:
  - 5146 space-naive (mail.app SQLite radar 抓的, 本地北京时间)
  - 2    iso-naive (边界 case)
  - 3751 iso-with-tz (raw MIME 解析的, 已归一)

混合格式会让前端按字符串排序乱序 (T > space)。本脚本归一全部到 ISO 8601 + tz,
naive 时间默认 ``+08:00`` (mail.app 默认时区).

用法:
  source venv/bin/activate
  python scripts/dev/normalize_date_received_iso.py --dry-run
  python scripts/dev/normalize_date_received_iso.py --yes
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

# 加入 repo root 到 sys.path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.mail.sync_store import _normalize_date_received_iso  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/sync_store.db")
    ap.add_argument("--dry-run", action="store_true", default=True)
    ap.add_argument("--yes", action="store_true", help="confirm + 真跑")
    ap.add_argument("--sample", type=int, default=10, help="展示 sample 数")
    args = ap.parse_args()

    if args.yes:
        args.dry_run = False

    db_path = args.db
    print(f"db: {db_path}")
    print(f"mode: {'DRY-RUN' if args.dry_run else 'WRITE'}\n")

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """SELECT internal_id, date_received FROM email_metadata
                WHERE date_received IS NOT NULL AND date_received != ''"""
        ).fetchall()

    total = len(rows)
    print(f"scanning {total} rows ...")

    changes: list[tuple[int, str, str]] = []  # (internal_id, before, after)
    unchanged = 0
    failed = 0

    for r in rows:
        iid = r["internal_id"]
        before = r["date_received"]
        try:
            after = _normalize_date_received_iso(before)
        except Exception as e:
            print(f"  ERROR iid={iid} value={before!r}: {e}", file=sys.stderr)
            failed += 1
            continue
        if after == before:
            unchanged += 1
        else:
            changes.append((iid, before, after))

    print(f"to update: {len(changes)}")
    print(f"unchanged: {unchanged}")
    print(f"failed:    {failed}")

    if changes:
        print(f"\nsample changes (first {min(args.sample, len(changes))}):")
        for iid, b, a in changes[:args.sample]:
            print(f"  iid={iid:>10}  {b!r:<35} → {a!r}")

    if args.dry_run:
        print("\n(dry-run — no writes. Use --yes to actually update.)")
        sys.exit(0)

    # 真跑: batch executemany
    if not changes:
        print("\nnothing to update.")
        sys.exit(0)

    print(f"\napplying {len(changes)} UPDATEs ...")
    with sqlite3.connect(db_path, timeout=30.0) as conn:
        conn.execute("PRAGMA busy_timeout = 30000")
        # 用 executemany 单 transaction 提交
        params = [(after, iid) for iid, _, after in changes]
        conn.executemany(
            "UPDATE email_metadata SET date_received = ? WHERE internal_id = ?",
            params,
        )
        conn.commit()
    print(f"done. {len(changes)} rows updated.")


if __name__ == "__main__":
    main()
