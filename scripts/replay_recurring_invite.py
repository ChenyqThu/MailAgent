"""回放历史会议邀请邮件，触发周期展开。

用途：
  - 周期会议展开功能首次上线后，需要把历史的 .ics 邀请重新喂给
    MeetingInviteSync.process_email，让它建立 recurring_series 行 +
    展开 horizon 内的所有 occurrences 写入 Notion 日历。

模式：
  --discover-recurring       扫 SyncStore 内的 .eml/source，列出带 RRULE 的 internal_id（不写入 Notion）
  --internal-id N            回放单个 internal_id（写入 Notion）
  --internal-ids N1,N2,...   回放多个 internal_id

示例：
  # 1. 先扫看哪些历史邀请是周期会议
  python scripts/replay_recurring_invite.py --discover-recurring --since 2026-04-01

  # 2. 回放指定的两个
  python scripts/replay_recurring_invite.py --internal-ids 51924,52846
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import List, Optional

# 确保 src.* 可解析
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from loguru import logger  # noqa: E402

from src.config import config  # noqa: E402
from src.mail.applescript_arm import AppleScriptArm  # noqa: E402
from src.mail.icalendar_parser import ICalendarParser  # noqa: E402
from src.mail.meeting_sync import MeetingInviteSync  # noqa: E402
from src.mail.sync_store import SyncStore  # noqa: E402


def _has_calendar_part(source: str) -> bool:
    """快速过滤：邮件含 text/calendar MIME part（避免对纯文本邮件跑解析）.

    注意：实际 .ics body 通常是 base64 / quoted-printable 编码，所以
    'BEGIN:VCALENDAR' / 'RRULE:' 字面 grep 在 source 里不可靠；这里只用
    Content-Type 标识符做廉价 prefilter，真正的 RRULE 判定交给 parser。
    """
    if not source:
        return False
    return "text/calendar" in source.lower()


async def discover_recurring(
    sync_store: SyncStore,
    arm: AppleScriptArm,
    since: Optional[str],
    limit: int,
) -> List[dict]:
    """扫已 synced 的邮件，找带 RRULE 的会议邀请。"""
    parser = ICalendarParser()

    # 用 SQLite 读所有 synced 邮件（按 date desc 排）
    where_clauses = ["sync_status = 'synced'"]
    params: list = []
    if since:
        where_clauses.append("date_received >= ?")
        params.append(since)
    where_sql = " AND ".join(where_clauses)

    with sync_store._connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT internal_id, subject, sender, date_received, mailbox
            FROM email_metadata
            WHERE {where_sql}
            ORDER BY date_received DESC
            LIMIT ?
            """,
            (*params, limit),
        )
        rows = cursor.fetchall()

    logger.info(f"Scanning {len(rows)} emails for RRULE...")

    matches: List[dict] = []
    for i, row in enumerate(rows, 1):
        internal_id = row["internal_id"]
        mailbox = row["mailbox"] or "收件箱"
        try:
            full = arm.fetch_email_content_by_id(internal_id, mailbox)
        except Exception as e:
            logger.debug(f"  [{i}/{len(rows)}] fetch failed id={internal_id}: {e}")
            continue
        if not full:
            continue
        source = full.get("source", "")
        if not _has_calendar_part(source):
            continue

        invite = parser.extract_from_email_source(source)
        if invite is None or not invite.recurrence_rule:
            continue

        matches.append(
            {
                "internal_id": internal_id,
                "subject": row["subject"],
                "sender": row["sender"],
                "date": row["date_received"],
                "uid": invite.uid,
                "rrule": invite.recurrence_rule,
                "method": invite.method,
                "dtstart": invite.start_time.isoformat(),
            }
        )
        logger.info(
            f"  [{i}/{len(rows)}] ✓ id={internal_id} subj={row['subject'][:50]!r} "
            f"rrule={invite.recurrence_rule[:50]} method={invite.method}"
        )

    return matches


async def replay_one(
    internal_id: int,
    sync_store: SyncStore,
    arm: AppleScriptArm,
    meeting_sync: MeetingInviteSync,
) -> Optional[str]:
    """回放单个 internal_id 的会议邀请。返回代表性 page_id 或 None。"""
    # 找 mailbox
    meta = sync_store.get(internal_id)
    if not meta:
        logger.error(f"internal_id={internal_id} not in SyncStore")
        return None
    mailbox = meta.get("mailbox") or "收件箱"

    full = arm.fetch_email_content_by_id(internal_id, mailbox)
    if not full:
        logger.error(f"failed to fetch email source for id={internal_id}")
        return None

    source = full.get("source", "")
    message_id = full.get("message_id") or meta.get("message_id")

    if not meeting_sync.has_meeting_invite(source):
        logger.warning(f"id={internal_id} has no calendar invite")
        return None

    page_id, invite = await meeting_sync.process_email(source, message_id)
    if invite is None:
        logger.warning(f"id={internal_id}: no invite extracted")
        return None

    # 输出统计
    stats = meeting_sync.get_stats()
    logger.info(
        f"id={internal_id} replay done: "
        f"page_id={page_id} "
        f"created={stats['events_created']} updated={stats['events_updated']} "
        f"occurrences_synced={stats['occurrences_synced']} "
        f"relabel_applied={stats['relabel_applied']}"
    )
    return page_id


async def main(args: argparse.Namespace) -> int:
    sync_store = SyncStore(config.sync_store_db_path)
    arm = AppleScriptArm()

    if args.discover_recurring:
        matches = await discover_recurring(
            sync_store, arm, since=args.since, limit=args.discover_limit
        )
        if not matches:
            print("No recurring invites found in window.")
            return 0
        print(f"\nFound {len(matches)} recurring meeting invites:\n")
        print(f"{'id':>8}  {'method':>8}  {'date':>20}  rrule  subject")
        print("-" * 100)
        for m in matches:
            print(
                f"{m['internal_id']:>8}  {m['method']:>8}  {m['date'][:19]:>20}  "
                f"{m['rrule'][:30]:<30}  {m['subject'][:50]}"
            )
        return 0

    if not args.internal_ids:
        print("Need --internal-ids or --discover-recurring", file=sys.stderr)
        return 2

    meeting_sync = MeetingInviteSync(sync_store=sync_store)

    successes = 0
    for internal_id in args.internal_ids:
        # 每封邀请处理前重置统计便于单独看
        meeting_sync.reset_stats()
        page_id = await replay_one(internal_id, sync_store, arm, meeting_sync)
        if page_id is not None:
            successes += 1

    print(f"\nReplay complete: {successes}/{len(args.internal_ids)} succeeded")
    return 0 if successes == len(args.internal_ids) else 1


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--discover-recurring", action="store_true",
                   help="扫 SyncStore 找带 RRULE 的邮件（不写入 Notion）")
    p.add_argument("--since", type=str, default=None,
                   help="discover 模式: 仅扫此日期之后的邮件 (YYYY-MM-DD)")
    p.add_argument("--discover-limit", type=int, default=2000,
                   help="discover 扫描上限（按 date desc）")
    p.add_argument("--internal-id", type=int, default=None,
                   help="单个回放: 邮件 internal_id")
    p.add_argument("--internal-ids", type=str, default=None,
                   help="批量回放: 逗号分隔的 internal_id，如 51924,52846")
    args = p.parse_args()

    ids: List[int] = []
    if args.internal_id is not None:
        ids.append(args.internal_id)
    if args.internal_ids:
        for s in args.internal_ids.split(","):
            s = s.strip()
            if s:
                ids.append(int(s))
    args.internal_ids = ids
    return args


if __name__ == "__main__":
    import warnings

    warnings.warn(
        "scripts/replay_recurring_invite.py is deprecated; use "
        "'mailagent calendar recurring replay' instead. Will be removed in PR-6.",
        DeprecationWarning,
        stacklevel=2,
    )
    args = parse_args()
    sys.exit(asyncio.run(main(args)))
