#!/usr/bin/env python3
"""一次性 backfill: email_metadata.date_received 全部归一成 UTC 偏移 ISO 8601.

排序 tz 归一修复 (07-07 triage) 的存量侧: `_normalize_date_iso` 此前保留原始时区
偏移 (内部系统邮件 +08:00 vs 普通 +00:00), 而排序全链路是词法字符串比较
(SQL TEXT ORDER BY + 前端 localeCompare) → ``10:54+08:00`` 字典序压过
``05:58+00:00``。根因侧已改 astimezone(utc); 本脚本把存量行归一到同一口径。

流程: 先过既有 ``_normalize_date_received_iso`` (naive/space/RFC822 → tz-aware,
与历史 backfill 同源), 再 ``astimezone(utc)``。解析失败/仍 naive 的行保持原值
只计数。幂等: UTC ISO 输入输出逐字节相同。

folder_email 表已在 DB v23 DROP (P6 folder_sync cleanup), 无需覆盖。

用法:
  source venv/bin/activate
  python scripts/dev/normalize_date_received_utc.py --dry-run
  python scripts/dev/normalize_date_received_utc.py --db <path> --yes
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

# 加入 repo root 到 sys.path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.mail.sync_store import _normalize_date_received_iso  # noqa: E402


def to_utc_iso(value: str) -> str | None:
    """date_received → UTC 偏移 ISO 8601; 解析失败/仍 naive 返 None (保原值)."""
    normalized = _normalize_date_received_iso(value)
    if not normalized:
        return None
    try:
        dt = datetime.fromisoformat(normalized)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone(timezone.utc).isoformat()


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
    unparseable = 0

    for r in rows:
        iid = r["internal_id"]
        before = r["date_received"]
        after = to_utc_iso(before)
        if after is None:
            print(f"  UNPARSEABLE iid={iid} value={before!r} (kept)", file=sys.stderr)
            unparseable += 1
        elif after == before:
            unchanged += 1
        else:
            changes.append((iid, before, after))

    print(f"to update:   {len(changes)}")
    print(f"unchanged:   {unchanged}")
    print(f"unparseable: {unparseable}")

    if changes:
        print(f"\nsample changes (first {min(args.sample, len(changes))}):")
        for iid, b, a in changes[:args.sample]:
            print(f"  iid={iid:>10}  {b!r:<35} → {a!r}")

    if args.dry_run:
        print("\n(dry-run — no writes. Use --yes to actually update.)")
        sys.exit(0)

    if not changes:
        print("\nnothing to update.")
        sys.exit(0)

    print(f"\napplying {len(changes)} UPDATEs ...")
    with sqlite3.connect(db_path, timeout=30.0) as conn:
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.executemany(
            "UPDATE email_metadata SET date_received = ? WHERE internal_id = ?",
            [(after, iid) for iid, _, after in changes],
        )
        conn.commit()
    print(f"done. {len(changes)} rows updated.")


if __name__ == "__main__":
    main()
