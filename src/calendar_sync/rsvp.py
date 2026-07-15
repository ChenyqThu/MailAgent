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

import sqlite3
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Dict, Optional

from loguru import logger

from src.calendar_sync._common import SOURCES_TRY_ORDER  # F30 — promote from replay.py
from src.calendar_sync.itip_reply import (
    VALID_RESPONSE_STATUS,
    build_itip_reply,
    send_itip_reply_smtp,
)

if TYPE_CHECKING:
    from src.calendar_sync.repository import (
        CalendarEventRepository,
        CalendarEventRow,
    )
    from src.config import Config


def _extract_organizer_email(organizer_field: str) -> Optional[str]:
    """组织者字段 → email (剥 mailto:). 非 email 字段 (会议室名等) 返 None."""
    s = (organizer_field or "").strip()
    if not s:
        return None
    if s.lower().startswith("mailto:"):
        s = s[7:].strip()
    return s if "@" in s else None


def _parse_recurrence_id(raw: Optional[str]) -> Optional[datetime]:
    """容错解析 RFC 5545 RECURRENCE-ID 字符串 → UTC datetime.

    `caldav_reader.py` 写入时通常用 ``datetime.isoformat()`` (含 tz), 但实际
    CalDAV 端 wild data 还可能是 DATE-only / compact / TZID-prefixed 等格式.
    任一格式解析失败都返 None — 调用方 fallback 整系列 RSVP, 避免单条邀请
    崩溃但 SMTP 已发的 diverge.

    支持:
    - ISO datetime 含 tz:    ``2026-05-30T14:00:00+00:00``
    - ISO datetime 无 tz:    ``2026-05-30T14:00:00`` → 视作 UTC
    - ISO date-only:         ``2026-05-30`` → UTC 00:00
    - Compact DATETIME UTC:  ``20260530T140000Z``
    - Compact DATETIME naive:``20260530T140000`` → 视作 UTC
    - Compact DATE:          ``20260530`` → UTC 00:00
    """
    if not raw:
        return None
    s = raw.strip()
    if not s:
        return None
    # ISO 8601 (datetime / date), datetime.fromisoformat 支持 ``YYYY-MM-DD``
    # 也支持带 tz 的 ``...+00:00`` (Python 3.11+ 也认 ``Z`` 结尾).
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00") if s.endswith("Z") else s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d
    except ValueError:
        pass
    # Compact RFC 5545 格式
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y%m%dT%H%M%S", "%Y%m%d"):
        try:
            d = datetime.strptime(s, fmt)
            return d.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    logger.warning(
        f"无法解析 recurrence_id={raw!r} → fallback 整系列 RSVP "
        "(单次 occurrence 状态可能跟服务端 diverge)"
    )
    return None


_SUBJECT_PREFIX = {
    "ACCEPTED": "Accepted",
    "TENTATIVE": "Tentative",
    "DECLINED": "Declined",
}


def _check_organizer_freshness(
    repo: "CalendarEventRepository",
    row: "CalendarEventRow",
) -> Optional[str]:
    """Phase 3 §P1-e — source='email_ics' 时检查 organizer 信息是否 stale.

    背景: ``source='email_ics'`` 的 row.organizer 来自原邮件解析时的快照.
    原邮件被删除 / dead_letter / 用户清理后, row.organizer 仍是当时的值. RSVP
    会发到此地址 — 如果该 organizer 邮箱已停用 / 域名不可达, SMTP 会失败但 user
    不知道是因为 stale, 误以为是网络问题.

    本检查不阻塞发送 (邮箱真实可达性是远程 SMTP 服务端的事), 仅在源邮件已不在
    ``email_metadata`` 表时附加 warning, 让 CLI / IPC 用户做信息决策.

    ``source='caldav'`` row 从 Outlook CalDAV 实时拉, organizer 一定 fresh,
    返 None.

    Args:
        repo: CalendarEventRepository (复用 db_path)
        row: 待 RSVP 的 calendar_event row

    Returns:
        None — fresh / 无法判断 (不阻塞行为)
        str  — warning 文本 (e.g. "源邮件 internal_id=53120 已不在 email_metadata,
               organizer 信息可能 stale")
    """
    if row.source != "email_ics":
        return None
    iid = row.related_email_internal_id
    if iid is None or iid == 0:
        # email_ics 但无 related link (Phase 1.5 之前的派生 row): 无法 verify
        return None

    # 直接打 sqlite3 (跨表查 email_metadata) — repo 没暴露 email_metadata
    # 接口, 这里走 raw SQL 比污染 repo 干净.
    try:
        conn = sqlite3.connect(str(repo.db_path), timeout=5.0)
        try:
            cur = conn.execute(
                "SELECT internal_id, sync_status FROM email_metadata "
                "WHERE internal_id = ?",
                (iid,),
            )
            meta = cur.fetchone()
        finally:
            conn.close()
    except Exception as e:
        # SQL 错误不应阻塞 RSVP — 仅 log + 当 fresh 处理
        logger.warning(
            f"organizer freshness check 查 email_metadata 失败 "
            f"[internal_id={iid}]: {e} — 跳过 stale 检测"
        )
        return None

    if meta is None:
        return (
            f"源邮件 internal_id={iid} 已不在 email_metadata, "
            f"organizer={row.organizer!r} 信息可能 stale (RSVP 仍会发出, "
            "但 SMTP 失败时考虑该原因)"
        )
    if meta[1] == "dead_letter":
        return (
            f"源邮件 internal_id={iid} 是 dead_letter 状态, "
            f"organizer={row.organizer!r} 可能不可靠"
        )
    return None


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
        ``{action, ical_uid, recurrence_id, source, to_email, response_status, [body_preview], [organizer_freshness_warning], dry_run}``
        - ``action``: ``'sent'`` / ``'would_send'`` (dry_run)
        - ``to_email``: organizer 邮箱
        - ``body_preview``: 仅 dry_run 时返回 (前 300 字符)
        - ``organizer_freshness_warning``: Phase 3 §P1-e — source='email_ics'
           源邮件被删 / dead_letter 时给的提示文本; 其他情况 key 不出现.
           **不阻塞发送** — 只是给 CLI / IPC 决策信息.

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

    # 2. 提取 organizer email。task 07-15 问题2 — 空 organizer 入口显式拒绝:
    #    owner 自建事件经 Exchange 回读 organizer 可能为空串, 该类事件本就不该
    #    有 RSVP (前端已门控, 这里兜底)。专用文案不含 'not found'/'missing',
    #    serve-api / CLI 的 ValueError 分流按此走 400 E_INVALID_ARG (非 404)。
    if not (row.organizer or "").strip():
        raise ValueError(
            f"事件无组织者, 无法发送 RSVP (ical_uid={ical_uid!r} 的 organizer 为空; "
            "自建事件经 Exchange 回读 organizer 可能为空)"
        )
    to_email = _extract_organizer_email(row.organizer or "")
    if to_email is None:
        raise ValueError(
            f"organizer email missing or invalid: row.organizer={row.organizer!r} "
            f"(RSVP 必须有有效的 organizer 邮件才能 reply)"
        )

    # 2.5 Phase 3 §P1-e — email_ics source 检查 organizer 信息是否 stale
    freshness_warning = _check_organizer_freshness(repo, row)
    if freshness_warning is not None:
        logger.warning(
            f"organizer freshness warning for ical_uid={ical_uid!r}: "
            f"{freshness_warning}"
        )

    # 3. 拼 iTIP REPLY body. recurrence_id 解析失败时 _parse_recurrence_id
    #    内部已经 warning + 返 None, 自动 fallback 整系列 RSVP (本地 row.id
    #    仍是 occurrence row, 但 wire 上是 series-wide REPLY).
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
        recurrence_id_utc=_parse_recurrence_id(row.recurrence_id),
    )

    if dry_run:
        out: Dict[str, Any] = {
            "action": "would_send",
            "dry_run": True,
            "ical_uid": ical_uid,
            "recurrence_id": recurrence_id,
            "source": actual_source,
            "to_email": to_email,
            "response_status": response_status,
            "body_preview": body[:300],
        }
        if freshness_warning is not None:
            out["organizer_freshness_warning"] = freshness_warning
        return out

    # 4. 发 SMTP
    subject_prefix = _SUBJECT_PREFIX[response_status]
    subject = f"{subject_prefix}: {row.summary or '未命名事件'}"
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

    out: Dict[str, Any] = {
        "action": "sent",
        "dry_run": False,
        "ical_uid": ical_uid,
        "recurrence_id": recurrence_id,
        "source": actual_source,
        "to_email": to_email,
        "response_status": response_status,
    }
    if freshness_warning is not None:
        out["organizer_freshness_warning"] = freshness_warning
    return out
