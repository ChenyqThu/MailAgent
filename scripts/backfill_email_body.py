#!/usr/bin/env python3
"""
v4 历史邮件正文 backfill 脚本

把 Phase 1 上线（2026-05-15）之前已 sync 到 Notion 的邮件正文 + 附件回填到 SQLite。
让 LLM 走 SQLite 路径、handle_fetch_mail_content 享 ~250x latency 收益。

特性:
    - 幂等：已有 email_body 行的邮件自动跳过（除非 --force）
    - 断点续传：天然支持，每封独立事务，崩溃后下次跑会跳过已成功的
    - 优雅退出：SIGINT/SIGTERM 等当前邮件做完就停
    - 速率显示：每 N 封打印 rate + ETA
    - 失败熔断：连续 N 次失败自动停（默认 20）
    - Notion 不动：只读 AppleScript 取 source，只写 SQLite，不碰 Notion

Usage:
    # 单封验证
    python scripts/backfill_email_body.py --internal-ids 53675 --dry-run

    # 小批量 50 封（验证用，最近 synced 优先）
    python scripts/backfill_email_body.py --limit 50

    # 全量回填（约 6131 封，AppleScript ~1s/封估 ~1.7-3h）
    python scripts/backfill_email_body.py --all

    # 按日期范围（避开会议邀请密集的某个时段）
    python scripts/backfill_email_body.py --since-date 2026-01-01 --until-date 2026-03-31

    # 指定邮箱
    python scripts/backfill_email_body.py --mailbox 收件箱 --limit 100

    # 后台跑 + 日志
    nohup python scripts/backfill_email_body.py --all > logs/backfill.log 2>&1 &

监控进度（另起终端）:
    sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_body"
    sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_attachment"
    du -sh data/attachments/

注意:
    - **不要在 pm2 mail-sync 运行时跑此脚本** —— 两者都会 AppleScript 取邮件，
      会让 Mail.app 拥塞。先 pm2 stop mail-sync，跑完再 pm2 start。
    - 网络中断不影响：只读本地 AppleScript + 写本地 SQLite，无外部依赖。
"""

import argparse
import asyncio
import signal
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from loguru import logger

from src.config import config as cfg
from src.mail.applescript_arm import AppleScriptArm
from src.mail.reader import EmailReader
from src.mail.sync_store import SyncStore
from src.notion.sync import NotionSync
from src.repository import AttachmentStore, EmailRepository
from src.repository.storage_payload_builder import build_storage_payloads


# 优雅退出标志
_shutdown = False


def _handle_signal(signum, frame):
    global _shutdown
    if not _shutdown:
        print(f"\n[signal] Received {signum}, will stop after current email...")
        _shutdown = True
    else:
        print("\n[signal] Second signal, force exit")
        sys.exit(130)


def _pick_candidates(args, db_path: str) -> List[Dict[str, Any]]:
    """选要 backfill 的邮件.

    默认: sync_status='synced' AND notion_page_id IS NOT NULL AND 没有 email_body 行。
    --force: 包括已有 email_body 行的（会 INSERT OR REPLACE）。
    """
    conn = sqlite3.connect(db_path)
    try:
        sql = """
            SELECT m.internal_id, m.mailbox, m.message_id, m.is_read, m.is_flagged,
                   m.subject, m.date_received
              FROM email_metadata m
              LEFT JOIN email_body b ON m.internal_id = b.internal_id
             WHERE m.sync_status = 'synced'
               AND m.notion_page_id IS NOT NULL
        """
        params: List[Any] = []
        if not args.force:
            sql += " AND b.internal_id IS NULL"
        if args.since_date:
            sql += " AND m.date_received >= ?"
            params.append(args.since_date)
        if args.until_date:
            sql += " AND m.date_received <= ?"
            params.append(args.until_date)
        if args.mailbox:
            sql += " AND m.mailbox = ?"
            params.append(args.mailbox)
        # 最近 synced 优先（用户感知更明显）
        sql += " ORDER BY m.date_received DESC"
        if args.limit > 0:
            sql += " LIMIT ?"
            params.append(args.limit)

        rows = conn.execute(sql, params).fetchall()
        return [
            {
                "internal_id": r[0],
                "mailbox": r[1] or "收件箱",
                "message_id": r[2],
                "is_read": bool(r[3]),
                "is_flagged": bool(r[4]),
                "subject": r[5] or "",
                "date": r[6] or "",
            }
            for r in rows
        ]
    finally:
        conn.close()


def _hydrate_internal_ids(ids: List[int], store: SyncStore) -> List[Dict[str, Any]]:
    """从 sync_store 取 --internal-ids 的 metadata."""
    out = []
    for iid in ids:
        meta = store.get(iid)
        if not meta:
            logger.warning(f"internal_id={iid} not found in sync_store, skipping")
            continue
        out.append({
            "internal_id": iid,
            "mailbox": meta.get("mailbox") or "收件箱",
            "message_id": meta.get("message_id"),
            "is_read": bool(meta.get("is_read")),
            "is_flagged": bool(meta.get("is_flagged")),
            "subject": meta.get("subject") or "",
            "date": meta.get("date_received") or "",
        })
    return out


async def _backfill_one(
    record: Dict[str, Any],
    arm: AppleScriptArm,
    reader: EmailReader,
    repo: EmailRepository,
    notion_sync: NotionSync,
    *,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """对单封邮件跑 backfill：fetch → parse → office-convert → build → commit."""
    iid = record["internal_id"]
    mailbox = record["mailbox"]
    rc: Dict[str, Any] = {"internal_id": iid, "subject": record["subject"][:60]}

    # 1. AppleScript 取 MIME source
    full = arm.fetch_email_content_by_id(iid, mailbox)
    if not full:
        rc.update({"ok": False, "error": "AppleScript fetch_email_content_by_id returned None"})
        return rc

    # 2. parse → Email obj
    email = reader.parse_email_source(
        full.get("source", ""),
        record["message_id"] or full.get("message_id", ""),
        is_read=record["is_read"],
        is_flagged=record["is_flagged"],
    )
    if email is None:
        rc.update({"ok": False, "error": "parse_email_source returned None"})
        return rc

    email.mailbox = mailbox
    email.internal_id = iid

    # 3. 预跑 Office 转换（让 derived CSV/PDF 跟 dual-write 一起落 SQLite）
    # convert_to_csv/pdf 内部失败时静默返回 []，所以这里加一层"期望 vs 实际"对比，
    # 漏转的会被 warning 出来，后续可用 scripts/backfill_derivatives.py 补
    from src.converter.office_converter import is_convertible
    expected_convertibles = [a.filename for a in email.attachments if is_convertible(a.filename)]
    try:
        derived = notion_sync._convert_office_attachments(email)
        if derived:
            email.attachments.extend(derived)
            derived_origins = {d.derived_from_filename for d in derived if d.derived_from_filename}
            missed = set(expected_convertibles) - derived_origins
            if missed:
                logger.warning(
                    f"[{iid}] Office convert produced no derivative for: {missed} "
                    f"(expected {len(expected_convertibles)}, got {len(derived_origins)})"
                )
        elif expected_convertibles:
            logger.warning(
                f"[{iid}] Office convert returned empty but {len(expected_convertibles)} "
                f"convertible attachments expected: {expected_convertibles}"
            )
    except Exception as e:
        logger.warning(f"[{iid}] Office pre-convert raised (non-fatal): {e}")

    # 4. build payload
    body, atts = build_storage_payloads(
        email,
        iid,
        raw_mime_source=full.get("source"),
        attachment_store=repo.attachment_store,
    )

    rc.update({
        "body_format": body.body_format,
        "body_size": len(body.markdown or ""),
        "html_size": len(body.html or ""),
        "attachments": len(atts),
        "inline_images": body.has_inline_images,
    })

    if dry_run:
        rc["ok"] = True
        rc["dry_run"] = True
        return rc

    # 5. commit 事务
    try:
        id_map = repo.commit_email_with_body(
            iid, body, atts, message_id=email.message_id
        )
        rc["ok"] = True
        rc["attachment_ids"] = len(id_map)
    except Exception as e:
        rc["ok"] = False
        rc["error"] = f"commit failed: {e!r}"
    return rc


def _body_row_count(db_path: str) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute("SELECT COUNT(*) FROM email_body").fetchone()[0]
    finally:
        conn.close()


async def main():
    ap = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[1],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--all", action="store_true",
                    help="回填所有待 backfill 邮件（约 6131 封）")
    ap.add_argument("--limit", type=int, default=0,
                    help="限制回填数量（按 date_received DESC 排序）")
    ap.add_argument("--internal-ids", type=str, default="",
                    help="逗号分隔 internal_id 列表，覆盖其他过滤")
    ap.add_argument("--since-date", type=str, default="",
                    help="只处理 date_received >= 此日期的邮件（YYYY-MM-DD）")
    ap.add_argument("--until-date", type=str, default="",
                    help="只处理 date_received <= 此日期的邮件（YYYY-MM-DD）")
    ap.add_argument("--mailbox", type=str, default="",
                    help="只处理指定邮箱（如 '收件箱' / '发件箱'）")
    ap.add_argument("--force", action="store_true",
                    help="包括已有 email_body 行的邮件（覆盖重写）")
    ap.add_argument("--dry-run", action="store_true",
                    help="不写 SQLite，只走流程并打印 stats")
    ap.add_argument("--max-failures", type=int, default=20,
                    help="连续失败超过此数自动停（默认 20）")
    ap.add_argument("--progress-every", type=int, default=10,
                    help="每 N 封打印 progress（默认 10）")
    args = ap.parse_args()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    # 加载候选
    store = SyncStore(cfg.sync_store_db_path)
    if args.internal_ids:
        ids = [int(x) for x in args.internal_ids.split(",") if x.strip()]
        candidates = _hydrate_internal_ids(ids, store)
    else:
        if not (args.all or args.limit or args.since_date or args.until_date or args.mailbox):
            print("Error: specify one of --all / --limit / --since-date / --until-date "
                  "/ --mailbox / --internal-ids", file=sys.stderr)
            sys.exit(2)
        candidates = _pick_candidates(args, cfg.sync_store_db_path)

    if not candidates:
        print("No emails to backfill (all already have body rows? try --force to re-backfill).")
        return

    initial_body_count = _body_row_count(cfg.sync_store_db_path)
    print(f"=" * 70)
    print(f"  v4 Email Body Backfill")
    print(f"  candidates:   {len(candidates)}")
    print(f"  existing:     {initial_body_count} body rows")
    print(f"  dry_run:      {args.dry_run}")
    print(f"  force:        {args.force}")
    print(f"  max_failures: {args.max_failures}")
    print(f"=" * 70)

    # 初始化组件
    arm = AppleScriptArm(
        account_name=cfg.mail_account_name, inbox_name=cfg.mail_inbox_name
    )
    reader = EmailReader()
    repo = EmailRepository(
        db_path=cfg.sync_store_db_path,
        attachment_store=AttachmentStore(cfg.attachment_storage_dir),
    )
    notion_sync = NotionSync(
        email_repo=repo,
        sync_store=store,
    )  # 只用 _convert_office_attachments，不调远端

    t0 = time.monotonic()
    stats = {"ok": 0, "failed": 0}
    failure_streak = 0
    errors: List[Dict[str, Any]] = []

    for i, rec in enumerate(candidates, 1):
        if _shutdown:
            print(f"\n[abort] Stopped at {i - 1}/{len(candidates)} by signal")
            break

        try:
            r = await _backfill_one(
                rec, arm, reader, repo, notion_sync, dry_run=args.dry_run
            )
        except Exception as e:
            r = {
                "internal_id": rec["internal_id"], "ok": False,
                "error": f"unexpected exception: {e!r}",
            }

        if r.get("ok"):
            stats["ok"] += 1
            failure_streak = 0
        else:
            stats["failed"] += 1
            failure_streak += 1
            errors.append(r)
            print(f"  ✗ [{i}/{len(candidates)}] {r['internal_id']} "
                  f"({rec['date'][:10]}): {r.get('error', 'unknown')}")

        # 进度
        if i % args.progress_every == 0 or i == len(candidates) or i == 1:
            elapsed = time.monotonic() - t0
            rate = i / elapsed if elapsed > 0 else 0
            eta = (len(candidates) - i) / rate if rate > 0 else 0
            print(
                f"  [{i}/{len(candidates)}] "
                f"ok={stats['ok']} failed={stats['failed']} "
                f"rate={rate:.2f}/s "
                f"ETA={eta / 60:.1f}min"
            )

        if failure_streak >= args.max_failures:
            print(f"\n[abort] {args.max_failures} consecutive failures, stopping. "
                  f"Last error: {errors[-1].get('error') if errors else 'unknown'}")
            break

    elapsed = time.monotonic() - t0
    final_body_count = _body_row_count(cfg.sync_store_db_path)

    print(f"\n{'=' * 70}")
    print(f"  Done")
    print(f"=" * 70)
    print(f"  ok:           {stats['ok']}")
    print(f"  failed:       {stats['failed']}")
    print(f"  elapsed:      {elapsed:.0f}s ({elapsed / 60:.1f}min)")
    rate = (stats['ok'] + stats['failed']) / max(elapsed, 0.001)
    print(f"  rate:         {rate:.2f} emails/s")
    print(f"  body rows:    {initial_body_count} → {final_body_count}  "
          f"(+{final_body_count - initial_body_count})")
    if errors and len(errors) <= 10:
        print(f"\n  First {len(errors)} errors:")
        for e in errors[:10]:
            print(f"    {e['internal_id']}: {e.get('error', '')[:100]}")
    elif errors:
        print(f"\n  {len(errors)} errors (showing first 10):")
        for e in errors[:10]:
            print(f"    {e['internal_id']}: {e.get('error', '')[:100]}")


if __name__ == "__main__":
    asyncio.run(main())
