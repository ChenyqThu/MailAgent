"""Phase 2.1 — iTIP REPLY (RFC 5546) 拼装 + DavMail SMTP 发送.

iTIP (Internet Calendaring Transport Independent Interoperability Protocol)
REPLY 用于 ATTENDEE 回应组织者的 invite. RFC 5546 §3.2.3 规定:

- VCALENDAR 必须 ``METHOD:REPLY``
- VEVENT 内 ATTENDEE 只包含 reply 用户自己 (PARTSTAT 标 ACCEPTED/TENTATIVE/DECLINED)
- ORGANIZER 引用原 invite 的 organizer (告诉服务端 reply 给谁)
- UID 跟原 invite 一致 (服务端通过此追踪)
- SEQUENCE 同原 invite (大于等于; 增量需要重发邀请)

Outlook/Exchange (跟 DavMail 桥的目标服务器) 接收 SMTP 邮件 Content-Type
``text/calendar; method=REPLY`` 后, EWS Calendar Assistant 自动:
1. 解析 REPLY VCALENDAR
2. 更新 organizer 端 attendee 的 PARTSTAT
3. (可选) 给 organizer 发通知邮件

调用方:

    >>> body = build_itip_reply(
    ...     ical_uid="abc-123", sequence=0,
    ...     dtstart_utc=datetime(2026, 5, 23, 14, tzinfo=timezone.utc),
    ...     dtend_utc=datetime(2026, 5, 23, 15, tzinfo=timezone.utc),
    ...     summary="Team Sync", organizer_email="alice@example.com",
    ...     attendee_email="bob@example.com", attendee_name="Bob",
    ...     response_status="ACCEPTED",
    ... )
    >>> send_itip_reply_smtp(
    ...     cfg, ical_body=body,
    ...     to_email="alice@example.com",
    ...     subject="Accepted: Team Sync",
    ... )
"""
from __future__ import annotations

import smtplib
import socket
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import TYPE_CHECKING

from loguru import logger

from src.mail.backend.imap_client import get_cipher_key

if TYPE_CHECKING:
    from src.config import Config

# RFC 5545 §3.2 — 唯一有效的三个 PARTSTAT for REPLY
VALID_RESPONSE_STATUS = ("ACCEPTED", "TENTATIVE", "DECLINED")


def _escape_text(s: str) -> str:
    """RFC 5545 §3.3.11 TEXT escape — backslash / semicolon / comma / newline."""
    return (
        s.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
        .replace("\r", "")
    )


def _fmt_utc(dt: datetime) -> str:
    """UTC datetime → RFC 5545 form ``YYYYMMDDTHHMMSSZ``."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y%m%dT%H%M%SZ")


def build_itip_reply(
    *,
    ical_uid: str,
    sequence: int,
    dtstart_utc: datetime,
    dtend_utc: datetime,
    summary: str,
    organizer_email: str,
    attendee_email: str,
    attendee_name: str | None,
    response_status: str,
    recurrence_id_utc: datetime | None = None,
    now_utc: datetime | None = None,
) -> str:
    """拼装 RFC 5546 iTIP REPLY VCALENDAR.

    Args:
        ical_uid: 原 invite 的 UID
        sequence: 原 invite 的 SEQUENCE (大于等于即可, 通常用原值)
        dtstart_utc / dtend_utc: 原 invite 的 DTSTART/DTEND (UTC)
        summary: 原 invite 的 SUMMARY (REPLY 中保留为 "Re: <summary>" 由调用方决定)
        organizer_email: 原 invite 的 organizer (REPLY 告诉服务端发给谁)
        attendee_email: 当前用户邮箱 (我作为 reply 的发起方)
        attendee_name: 当前用户显示名 (CN parameter, 可选)
        response_status: ``ACCEPTED`` / ``TENTATIVE`` / ``DECLINED``
        recurrence_id_utc: 非空 = 单次跳脱实例的 RSVP; 留空 = 整系列 REPLY
        now_utc: 测试用 fixed DTSTAMP; 留空 = 当前 UTC

    Returns:
        VCALENDAR 文本 (RFC 5545 用 CRLF 行尾)

    Raises:
        ValueError: response_status 非法 / ical_uid 空 / organizer_email 空
    """
    if response_status not in VALID_RESPONSE_STATUS:
        raise ValueError(
            f"response_status must be one of {VALID_RESPONSE_STATUS}, "
            f"got {response_status!r}"
        )
    if not ical_uid.strip():
        raise ValueError("ical_uid is required")
    if not organizer_email.strip():
        raise ValueError("organizer_email is required (RFC 5546 §3.2.3)")
    if not attendee_email.strip():
        raise ValueError("attendee_email is required")

    dtstamp = _fmt_utc(now_utc or datetime.now(timezone.utc))
    dtstart = _fmt_utc(dtstart_utc)
    dtend = _fmt_utc(dtend_utc)
    summary_esc = _escape_text(summary or "")

    # ATTENDEE 的 CN parameter 加引号防 escape (RFC 5545 §3.2.2)
    cn_param = ""
    if attendee_name and attendee_name.strip():
        # CN 内嵌引号要去掉 (无 escape 机制)
        clean_cn = attendee_name.replace('"', "").strip()
        cn_param = f';CN="{clean_cn}"'

    lines = [
        "BEGIN:VCALENDAR",
        "PRODID:-//MailAgent//Phase2.1 iTIP REPLY//EN",
        "VERSION:2.0",
        "METHOD:REPLY",
        "BEGIN:VEVENT",
        f"UID:{ical_uid}",
        f"DTSTAMP:{dtstamp}",
        f"DTSTART:{dtstart}",
        f"DTEND:{dtend}",
        f"SEQUENCE:{sequence}",
        f"SUMMARY:{summary_esc}",
        f"ORGANIZER:mailto:{organizer_email}",
        f"ATTENDEE;PARTSTAT={response_status}{cn_param}:mailto:{attendee_email}",
    ]
    if recurrence_id_utc is not None:
        # RECURRENCE-ID 在 ATTENDEE/UID 之间 (习惯位置); 标 reply 单次实例.
        lines.insert(-1, f"RECURRENCE-ID:{_fmt_utc(recurrence_id_utc)}")
    lines.extend(["END:VEVENT", "END:VCALENDAR"])

    # RFC 5545 §3.1 强制 CRLF
    return "\r\n".join(lines) + "\r\n"


def send_itip_reply_smtp(
    cfg: "Config",
    *,
    ical_body: str,
    to_email: str,
    subject: str,
    from_email: str | None = None,
    from_name: str | None = None,
    timeout_sec: int = 30,
) -> None:
    """通过 DavMail SMTP submission 发 iTIP REPLY 邮件给 organizer.

    Outlook/Exchange Calendar Assistant 解析 ``text/calendar; method=REPLY``
    body 自动更新 organizer 端 attendee 的 PARTSTAT.

    Args:
        cfg: src.config.Config 实例 (拿 DAVMAIL_HOST/SMTP_PORT/user_email/cipher_key)
        ical_body: build_itip_reply 输出 (VCALENDAR text/calendar body)
        to_email: organizer 邮箱
        subject: 邮件主题 (建议 "Accepted: <orig>" / "Declined: <orig>")
        from_email: 默认 cfg.user_email; 测试可 override
        from_name: 显示名 (可选)
        timeout_sec: SMTP 连接 + 发送总 timeout

    Raises:
        smtplib.SMTPException / socket.error / OSError: 网络/SMTP/认证问题
        ValueError: 必要 config 缺失
    """
    user = (from_email or getattr(cfg, "user_email", "") or "").strip()
    if not user:
        raise ValueError("from_email / cfg.user_email is required")
    host = getattr(cfg, "davmail_imap_host", "127.0.0.1") or "127.0.0.1"
    port = int(getattr(cfg, "davmail_smtp_port", 0) or 1025)
    # get_cipher_key 在 davmail_cipher_key 空且 poc_mode 关时会 raise
    # DavMailConnectionError — 我们让它原样抛, CLI 层映射成 CliError.
    password = get_cipher_key(cfg)

    msg = EmailMessage()
    msg["Subject"] = subject
    if from_name and from_name.strip():
        msg["From"] = f"{from_name} <{user}>"
    else:
        msg["From"] = user
    msg["To"] = to_email
    # Outlook/Exchange 通用模式: 单 part text/calendar; method=REPLY
    msg.set_content(
        ical_body,
        subtype="calendar",
        params={"method": "REPLY", "charset": "utf-8", "name": "invite.ics"},
        charset="utf-8",
    )

    logger.info(
        f"[itip-reply] sending to={to_email} via {host}:{port} user={user} "
        f"subject={subject!r} body_len={len(ical_body)}"
    )
    try:
        with smtplib.SMTP(host, port, timeout=timeout_sec) as s:
            # DavMail SMTP plain (无 STARTTLS), AUTH PLAIN with cipher_key 当 password
            s.login(user, password)
            s.send_message(msg)
        logger.info(f"[itip-reply] sent OK to={to_email}")
    except (smtplib.SMTPException, OSError, socket.error) as e:
        logger.error(f"[itip-reply] send failed to={to_email}: {e}")
        raise
