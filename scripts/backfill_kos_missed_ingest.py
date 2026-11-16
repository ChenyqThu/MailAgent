#!/usr/bin/env python3
"""一次性补推: 把漏进 KOS 的收件箱邮件重新送回「LLM 分类 → KOS 等标签推送」队列。

漏推来源 (task 11-13-kos-missed-ingest-fix):

1. 重试队列补同步成功的邮件, 修复前不派发 LLM / KOS 钩子 ⇒ ``kos_ingest_log`` 里没有行,
   多数连 ``llm_processing`` 行都没有。
2. LLM 经 IMAP 取信时 DavMail 断网, 3 次重试耗尽 ``gave_up`` ⇒ KOS 在
   ``KOS_REQUIRE_LABELED=true`` 下记成 ``skip: unlabeled``, 之后不再重判。

本脚本**只改队列状态**, 不调 LLM、不调 KOS, 由运行中的主服务消费:

- LLM: 没有行或 ``gave_up`` 的, 置 ``status='failed'``、``retry_count=0``、
  ``next_retry_at=now`` ⇒ LLM 重试队列 (``get_ready_for_retry``) 接手。已 ``success`` 的不动。
- KOS: ``ingest_log.record_deferred(source='backfill')`` ⇒ 6c 扫描在 LLM 终态后推送
  (低于优先级下限的照常 ``skipped``)。
- 飞书: ``email_metadata.ingest_reason`` 改成 ``history_sync`` ⇒ 三个飞书通知入口
  (``should_suppress_reconcile_notify``) 一律不推。这批邮件晚到了几天到几个月,
  补发通知只是噪音。它们都已同步完成, 该列的另一个读者 ``is_history_ingest``
  (同步后跳过实时类钩子) 不会再被触发。

用法 (默认 dry-run, 只读打开数据库)::

    venv/bin/python scripts/backfill_kos_missed_ingest.py --db "<userData>/data/sync_store.db"
    venv/bin/python scripts/backfill_kos_missed_ingest.py --db ... --apply

🔴 活库是 ``~/Library/Application Support/mailagent-frontend/data/sync_store.db``,
不是仓库里的 ``data/``。``--apply`` 前确认主服务已部署含本任务修复的版本, 否则 LLM
仍会经 IMAP 取信。
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.kos import ingest_log  # noqa: E402
from src.mail.ingest_provenance import INGEST_HISTORY  # noqa: E402

INBOX = "收件箱"

# 无 KOS 台账行的已同步收件箱邮件 + KOS 记成 unlabeled 的邮件。
TARGET_SQL = """
SELECT m.internal_id, m.notion_page_id, m.mailbox, m.subject, m.date_received,
       p.status AS llm_status,
       k.status AS kos_status, k.error AS kos_error
  FROM email_metadata m
  LEFT JOIN llm_processing p ON p.internal_id = m.internal_id
  LEFT JOIN kos_ingest_log k ON k.internal_id = m.internal_id
 WHERE m.mailbox = ?
   AND m.sync_status = 'synced'
   AND m.created_at >= ?
   AND (k.internal_id IS NULL
        OR (k.status = 'skipped' AND k.error LIKE 'skip: unlabeled%'))
 ORDER BY m.internal_id
"""


def _parse_since(value: str) -> float:
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", required=True, help="sync_store.db 路径 (活库在 userData)")
    ap.add_argument("--since", default="2026-08-01",
                    help="只看 created_at 不早于该日期 (UTC) 的邮件, 默认 2026-08-01")
    ap.add_argument("--apply", action="store_true", help="写入; 不加则只打印清单")
    args = ap.parse_args()

    db_path = str(Path(args.db).expanduser())
    since_ts = _parse_since(args.since)

    if args.apply:
        conn = sqlite3.connect(db_path, timeout=30)
    else:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    try:
        if args.apply:
            conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(TARGET_SQL, (INBOX, since_ts)).fetchall()

        need_llm = [r for r in rows if r["llm_status"] != "success"]
        print(f"目标邮件 {len(rows)} 封: 需重跑 LLM {len(need_llm)} 封, "
              f"LLM 已成功只需 KOS 重判 {len(rows) - len(need_llm)} 封")
        for r in rows:
            print(f"  {r['internal_id']}  llm={r['llm_status'] or '-':8} "
                  f"kos={r['kos_status'] or '-':8} {r['date_received'] or '':25} "
                  f"{(r['subject'] or '')[:40]}")

        if not args.apply:
            print("\ndry-run: 未写入。确认后加 --apply。")
            return 0

        now = time.time()
        for r in rows:
            conn.execute(
                "UPDATE email_metadata SET ingest_reason = ? WHERE internal_id = ?",
                (INGEST_HISTORY, r["internal_id"]),
            )
        for r in need_llm:
            conn.execute(
                """
                INSERT INTO llm_processing
                    (internal_id, notion_page_id, mailbox, status, retry_count,
                     next_retry_at, last_error, created_at, updated_at)
                VALUES (?, ?, ?, 'failed', 0, ?, 'backfill: kos-missed-ingest', ?, ?)
                ON CONFLICT(internal_id) DO UPDATE SET
                    status='failed', retry_count=0, next_retry_at=excluded.next_retry_at,
                    last_error=excluded.last_error, updated_at=excluded.updated_at
                WHERE llm_processing.status != 'success'
                """,
                (r["internal_id"], r["notion_page_id"], r["mailbox"], now, now, now),
            )
        conn.commit()
    finally:
        conn.close()

    # LLM 行先落定再入 KOS 等标签队列: 反过来的话 6c 可能先看到「无 LLM 行」。
    for r in rows:
        iid = r["internal_id"]
        ingest_log.record_deferred(db_path, iid, f"sources/email/{iid}", "backfill")

    print(f"\n已写入: 标记补录来源(不发飞书) {len(rows)} 封, LLM 重新排队 {len(need_llm)} 封, "
          f"KOS 等标签排队 {len(rows)} 封。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
