"""Phase 2.4 — replay 一行 calendar_event 到 Notion mirror.

跟 Sprint 6 老 ``recurring replay`` 的差别:

- 老 ``recurring replay <internal_id>`` 基于邮件 .ics 重派生 CalendarEvent —
  只对 ``source='email_ics'`` 有效, ``internal_id=0`` (caldav-only) 无法 replay
- 新 ``calendar replay <ical_uid>`` 基于 SQLite ``calendar_event`` 行重导出 —
  ``caldav`` / ``email_ics`` / ``legacy_calendar_app`` 任何 source 都可,
  无需邮件源

调用方:
    >>> from src.calendar_sync import CalendarEventRepository
    >>> from src.calendar_notion.sync import CalendarNotionSync
    >>> repo = CalendarEventRepository('data/sync_store.db')
    >>> notion = CalendarNotionSync()
    >>> result = await replay_calendar_event(
    ...     repo, notion, ical_uid='...', recurrence_id=None, source=None,
    ... )
    >>> result['action']    # 'created' / 'updated' / 'skipped'
    >>> result['page_id']   # Notion page id
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from loguru import logger

from src.calendar_notion.sync import CalendarNotionSync
from src.calendar_sync import CalendarEventRepository
from src.calendar_sync.repository import CalendarEventRow
from src.models import Attendee, CalendarEvent, EventStatus

# 找 row 时按这顺序探: caldav 优先 (Sprint 16 主路径), email_ics 兜底
# (邮件 .ics 派生), legacy_calendar_app 最后 (老 calendar_main.py 路径).
SOURCES_TRY_ORDER = ("caldav", "email_ics", "legacy_calendar_app")

_STATUS_MAP = {
    "CONFIRMED": EventStatus.CONFIRMED,
    "TENTATIVE": EventStatus.TENTATIVE,
    "CANCELLED": EventStatus.CANCELLED,
}


def _event_id_for_row(row: CalendarEventRow) -> str:
    """跟 Notion ``Event ID`` 索引对齐:

    - 主事件 (recurrence_id 为空): ``{ical_uid}``
    - 单次跳脱 occurrence: ``{ical_uid}@{recurrence_id}``

    Notion ``_find_existing_event`` 用此 id 查重, 同一行多次 replay 不会建重复 page.
    """
    if row.recurrence_id:
        return f"{row.ical_uid}@{row.recurrence_id}"
    return row.ical_uid


def _map_status(s: Optional[str]) -> EventStatus:
    """SQLite row.status (str 'CONFIRMED'/'CANCELLED'/...) → EventStatus enum."""
    if not s:
        return EventStatus.NONE
    return _STATUS_MAP.get(s.upper(), EventStatus.NONE)


def _row_to_calendar_event(row: CalendarEventRow) -> CalendarEvent:
    """SQLite ``calendar_event`` 行 → ``CalendarEvent`` (CalendarNotionSync 期望).

    Mapping 规则:

    - ``attendees_json`` 是 list of dict ``{email, name, response, role}``,
      转 ``Attendee`` 时把 response → status (Notion 模型用 status 词).
    - ``organizer`` 通常是 ``mailto:foo@bar`` 或 raw email; 自动剥 mailto: 前缀.
    - ``dtend_utc`` 缺失时 fallback 等于 dtstart (Notion API 要求 end).
    """
    atts: list[Attendee] = []
    for a in row.attendees or []:
        if not isinstance(a, dict):
            continue
        atts.append(
            Attendee(
                email=a.get("email") or "",
                name=a.get("name"),
                status=(a.get("response") or "unknown").lower(),
            )
        )

    organizer = (row.organizer or "").strip()
    organizer_email: Optional[str] = None
    if organizer.lower().startswith("mailto:"):
        organizer_email = organizer[7:].strip() or None
        organizer = organizer_email or organizer
    elif "@" in organizer:
        organizer_email = organizer

    start = row.dtstart_utc or datetime.now(timezone.utc)
    end = row.dtend_utc or start

    return CalendarEvent(
        event_id=_event_id_for_row(row),
        calendar_name=row.calendar_name or "Exchange",
        title=row.summary or "(无标题)",
        start_time=start,
        end_time=end,
        is_all_day=bool(row.is_all_day),
        location=row.location or None,
        description=row.description or None,
        url=row.url or None,
        status=_map_status(row.status),
        organizer=organizer or None,
        organizer_email=organizer_email,
        attendees=atts,
        is_recurring=bool(row.rrule),
        recurrence_rule=row.rrule or None,
        last_modified=row.updated_at,
    )


async def replay_calendar_event(
    repo: CalendarEventRepository,
    notion_sync: CalendarNotionSync,
    *,
    ical_uid: str,
    recurrence_id: Optional[str] = None,
    source: Optional[str] = None,
) -> Dict[str, Any]:
    """重导出 SQLite calendar_event 行到 Notion mirror.

    Args:
        repo: CalendarEventRepository 实例 (读 row)
        notion_sync: CalendarNotionSync 实例 (写 Notion)
        ical_uid: vEvent UID (RFC 5545)
        recurrence_id: 非空 = 拿单次跳脱 occurrence; 留空 = 主事件
        source: 限定 source ∈ SOURCES_TRY_ORDER; ``None`` = 按 caldav → email_ics
                → legacy 顺序找第一个命中的

    Returns:
        ``{action, page_id, ical_uid, recurrence_id, source}``
        - ``action``: ``'created'`` / ``'updated'`` / ``'skipped'``
        - ``source``: 实际命中的 source (即便调用方传 None)

    Raises:
        ValueError: row 不存在 (调用方应映射成 CliNotFoundError)
    """
    candidates = [source] if source else list(SOURCES_TRY_ORDER)
    row: Optional[CalendarEventRow] = None
    actual_source: Optional[str] = None
    for s in candidates:
        if not s:
            continue
        candidate = repo.get_by_ical_uid(
            ical_uid, source=s, recurrence_id=recurrence_id,
        )
        if candidate is not None:
            row = candidate
            actual_source = s
            break

    if row is None:
        sources_str = ", ".join(c for c in candidates if c)
        raise ValueError(
            f"calendar_event not found: ical_uid={ical_uid!r} "
            f"recurrence_id={recurrence_id!r} sources_tried=[{sources_str}]"
        )

    event = _row_to_calendar_event(row)
    action, page_id = await notion_sync.sync_event(event)

    # 回写 notion_page_id — 即便 action='skipped' 也回写, 让 SQLite ↔ Notion 关联
    # 在 replay 之后保持权威. 写失败不抛 (Notion 已经写完了, SQLite 回写炸只是
    # 元数据丢, 用户再 replay 会自然修复).
    try:
        repo.update_notion_link(row.id, page_id)
    except Exception as e:  # pragma: no cover - 防御
        logger.warning(
            f"replay 写 Notion 成功但回写 SQLite notion_page_id 失败 "
            f"[row_id={row.id}, page_id={page_id}]: {e}"
        )

    return {
        "action": action,
        "page_id": page_id,
        "ical_uid": ical_uid,
        "recurrence_id": recurrence_id,
        "source": actual_source,
    }
