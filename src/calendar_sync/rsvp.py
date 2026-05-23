"""Phase 2.1 — RSVP orchestration: 读 calendar_event 行 → 拼 iTIP REPLY → SMTP 发 → 更新 SQLite.

入口 ``send_rsvp`` 给 CLI / IPC handler 调用. 协议层在 ``itip_reply.py``,
本模块只做 orchestration (按 ical_uid 找 row + 提取 organizer + 调用 build/send +
回写 response_status).

错误处理策略:
- row 不存在 → ValueError ('not found ...')
- organizer 字段空 / 不像 email → ValueError ('organizer email missing/invalid')
- SMTP 失败 → 上抛 smtplib 异常 (CLI 层映射成 CliError)
- 更新本地 response_status 失败 → 仅 warning (邮件已发, 服务端会异步反映)
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, Optional

from loguru import logger

from src.calendar_notion.replay import SOURCES_TRY_ORDER  # 复用 source fallback 顺序
from src.calendar_sync.itip_reply import (
    VALID_RESPONSE_STATUS,
    build_itip_reply,
    send_itip_reply_smtp,
)

if TYPE_CHECKING:
    from src.calendar_sync.repository import CalendarEventRepository
    from src.config import Config


def _extract_organizer_email(organizer_field: str) -> Optional[str]:
    """组织者字段 → email (剥 mailto:). 非 email 字段 (会议室名等) 返 None."""
    s = (organizer_field or "").strip()
    if not s:
        return None
    if s.lower().startswith("mailto:"):
        s = s[7:].strip()
    return s if "@" in s else None


_SUBJECT_PREFIX = {
    "ACCEPTED": "Accepted",
    "TENTATIVE": "Tentative",
    "DECLINED": "Declined",
}


def send_rsvp(
    repo: "CalendarEventRepository",
    cfg: "Config",
    *,
    ical_uid: str,
    response_status: str,
    recurrence_id: Optional[str] = None,
    source: Optional[str] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """发送 iTIP REPLY 给原 invite 的 organizer.

    Args:
        repo: CalendarEventRepository 实例 (读 row + 写 response_status)
        cfg: src.config.Config 实例 (DavMail SMTP + user_email)
        ical_uid: vEvent UID (RFC 5545)
        response_status: ``ACCEPTED`` / ``TENTATIVE`` / ``DECLINED`` (case-sensitive)
        recurrence_id: 非空 = 单次跳脱实例的 RSVP; 留空 = 整系列 REPLY
        source: 限定 source; 留空 = 按 caldav → email_ics → legacy 顺序找
        dry_run: True = 不实际发 SMTP, 返回 plan + body preview

    Returns:
        ``{action, ical_uid, recurrence_id, source, to_email, response_status, [body_preview], dry_run}``
        - ``action``: ``'sent'`` / ``'would_send'`` (dry_run)
        - ``to_email``: organizer 邮箱
        - ``body_preview``: 仅 dry_run 时返回 (前 300 字符)

    Raises:
        ValueError: response_status 非法 / row 不存在 / organizer 字段非 email
        smtplib.SMTPException: SMTP 发送失败 (网络/认证/服务端拒绝)
    """
    if response_status not in VALID_RESPONSE_STATUS:
        raise ValueError(
            f"response_status must be one of {VALID_RESPONSE_STATUS}, "
            f"got {response_status!r}"
        )

    # 1. 找 row (复用 SOURCES_TRY_ORDER 跟 replay 路径一致)
    candidates = [source] if source else list(SOURCES_TRY_ORDER)
    row = None
    actual_source = None
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

    # 2. 提取 organizer email
    to_email = _extract_organizer_email(row.organizer or "")
    if to_email is None:
        raise ValueError(
            f"organizer email missing or invalid: row.organizer={row.organizer!r} "
            f"(RSVP 必须有有效的 organizer 邮件才能 reply)"
        )

    # 3. 拼 iTIP REPLY body
    from datetime import datetime as _dt
    body = build_itip_reply(
        ical_uid=row.ical_uid,
        sequence=row.sequence,
        dtstart_utc=row.dtstart_utc,
        dtend_utc=row.dtend_utc or row.dtstart_utc,
        summary=row.summary or "",
        organizer_email=to_email,
        attendee_email=cfg.user_email,
        attendee_name=None,
        response_status=response_status,
        recurrence_id_utc=(
            _dt.fromisoformat(row.recurrence_id)
            if row.recurrence_id
            else None
        ),
    )

    if dry_run:
        return {
            "action": "would_send",
            "dry_run": True,
            "ical_uid": ical_uid,
            "recurrence_id": recurrence_id,
            "source": actual_source,
            "to_email": to_email,
            "response_status": response_status,
            "body_preview": body[:300],
        }

    # 4. 发 SMTP
    subject_prefix = _SUBJECT_PREFIX[response_status]
    subject = f"{subject_prefix}: {row.summary or '(无标题)'}"
    send_itip_reply_smtp(
        cfg, ical_body=body, to_email=to_email, subject=subject,
    )

    # 5. 更新本地 response_status (前端不必等下次 caldav sync 才看到)
    try:
        repo.update_response_status(row.id, response_status)
    except Exception as e:  # pragma: no cover - 防御
        logger.warning(
            f"RSVP 发送成功但回写 SQLite response_status 失败 "
            f"[row_id={row.id}, status={response_status}]: {e} — "
            "下次 caldav sync 会从服务端拉到正确状态"
        )

    return {
        "action": "sent",
        "dry_run": False,
        "ical_uid": ical_uid,
        "recurrence_id": recurrence_id,
        "source": actual_source,
        "to_email": to_email,
        "response_status": response_status,
    }
