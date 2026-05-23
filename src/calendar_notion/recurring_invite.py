"""
回放历史会议邀请: import-only module。

DEPRECATED entry-point. Use 'mailagent calendar recurring {discover,replay}' instead.

Phase 1.5 重构 (frontend-view-silly-knuth.md): discover_recurring 退役"扫邮件 +
IMAP fetch 解析 .ics"老路径, 改读 calendar_event 表 (CalendarSyncWorker 已落库的
SSoT). 查询 ~5ms 替代原来 davmail 模式下每封邮件 5s × 2000 = 167min 的灾难性
IMAP scan. replay_one 仍走老路径 (email refetch + meeting_sync), 因为它需要邮件
.ics 内容才能重新 process; 计划下个 sprint 改成基于 calendar_event 重导出.

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
    since: Optional[str] = None,
    limit: int = 2000,
) -> List[dict]:
    """读 calendar_event 表里所有 RRULE != '' 的事件 (Phase 1.5).

    替代原"扫 email_metadata + IMAP fetch 解析 .ics"路径. davmail 模式下原路径
    167min/2000 封; 新路径 ~5ms SQLite 查询.

    Args:
        sync_store: SyncStore 实例 (跟 calendar_event 同 db_path).
        since: ISO 日期 YYYY-MM-DD; 留空 = 全部. 过滤 event.dtstart >= since.
        limit: 最多返回 N 行 (按 dtstart DESC 排, 取最近的 N 个).

    Returns:
        List of dicts (跟老 shape 对齐, CLI grouping 逻辑零改动):
            internal_id: related_email_internal_id 或 0 (caldav-only event 没邮件源)
            subject: event.summary
            sender: event.organizer (mailto 已剥)
            date: dtstart ISO
            uid: event.ical_uid
            rrule: event.rrule
            method: 'REQUEST' (calendar_event 表不存 iTIP method, 硬编码)
            dtstart: dtstart ISO
    """
    # since 解析为 epoch (UTC midnight); 失败忽略 (CLI 已校验入参)
    since_epoch: Optional[float] = None
    if since:
        try:
            from datetime import datetime, timezone
            d = datetime.fromisoformat(since)
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            since_epoch = d.astimezone(timezone.utc).timestamp()
        except (ValueError, TypeError):
            logger.warning(f"discover_recurring: invalid --since={since!r}, ignored")

    clauses = [
        "rrule != ''",
        "deleted_at IS NULL",
        # Phase 1.5 主流 source: caldav (worker 拉的) + email_ics (邮件邀请派生)
        "source IN ('caldav', 'email_ics')",
    ]
    params: list = []
    if since_epoch is not None:
        clauses.append("dtstart_utc >= ?")
        params.append(since_epoch)

    with sync_store._connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT id, ical_uid, summary, organizer, dtstart_utc,
                   rrule, related_email_internal_id
            FROM calendar_event
            WHERE {' AND '.join(clauses)}
            ORDER BY dtstart_utc DESC
            LIMIT ?
            """,
            (*params, limit),
        )
        rows = cursor.fetchall()

    logger.info(f"discover_recurring: {len(rows)} calendar_event rows with RRULE")

    from datetime import datetime, timezone

    matches: List[dict] = []
    for row in rows:
        dtstart_iso = (
            datetime.fromtimestamp(row["dtstart_utc"], tz=timezone.utc).isoformat()
            if row["dtstart_utc"] is not None
            else None
        )
        organizer = (row["organizer"] or "").replace("mailto:", "")
        matches.append(
            {
                "internal_id": int(row["related_email_internal_id"] or 0),
                "subject": row["summary"],
                "sender": organizer,
                "date": dtstart_iso,
                "uid": row["ical_uid"],
                "rrule": row["rrule"],
                "method": "REQUEST",
                "dtstart": dtstart_iso,
            }
        )

    return matches


async def replay_one(
    internal_id: int,
    sync_store: SyncStore,
    arm: AppleScriptArm,
    meeting_sync: MeetingInviteSync,
) -> Optional[str]:
    """回放单个 internal_id 的会议邀请。返回代表性 page_id 或 None。

    NOTE (Phase 1.5): 仍走老的 email refetch + meeting_sync 路径. 仅对
    related_email_internal_id 非空的 event 有效 (即邮件邀请派生的). caldav-only
    event 没邮件源, replay 会失败. 计划下个 sprint 改成基于 calendar_event 重导出.
    """
    if internal_id <= 0:
        logger.warning(
            f"replay_one: internal_id={internal_id} invalid; "
            f"caldav-only events 无邮件源, 无法 replay"
        )
        return None
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
