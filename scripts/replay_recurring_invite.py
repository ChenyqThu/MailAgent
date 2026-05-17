"""
回放历史会议邀请: import-only module。

DEPRECATED entry-point. Use 'mailagent calendar recurring {discover,replay}' instead.

CLI 调用的导出: discover_recurring / replay_one / _has_calendar_part 函数
"""
from __future__ import annotations

from typing import List, Optional

from loguru import logger

from src.mail.applescript_arm import AppleScriptArm
from src.mail.icalendar_parser import ICalendarParser
from src.mail.meeting_sync import MeetingInviteSync
from src.mail.sync_store import SyncStore


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

