"""Outgoing mail builder + SMTP sender — davmail / applescript backend 共享.

把 reply / reply-all / forward / new 的 MIME 构造收敛到一处 (``build_outgoing_mime``),
SMTP 发送 (``smtp_send``) 复用 ``imap_client.smtp_session``. davmail 主路径 + applescript
fallback (cfg 端口都指向 DavMail JVM) 都委托本模块, 消除重复.

切换边界: 本模块只管"怎么拼 MIME + 怎么 SMTP 投递", 不碰 SQLite / Notion / 收件人推导
(收件人 + forward 引用块由 CLI ``_compose_draft`` 预先算好塞进 DraftRequest).
"""
from __future__ import annotations

import re
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formatdate, make_msgid
from typing import TYPE_CHECKING, Optional

from loguru import logger

from src.mail.backend.imap_client import (
    DavMailConnectionError,
    discover_sent_folder,
    imap_session,
    smtp_session,
)
from src.mail.backend.types import DraftRequest, SendResult

if TYPE_CHECKING:
    from src.config import Config


# RFC 4315 APPENDUID response: [APPENDUID uidvalidity uid]
_APPENDUID_RE = re.compile(rb"APPENDUID\s+(\d+)\s+(\d+)", re.IGNORECASE)


def build_outgoing_mime(cfg: "Config", draft: DraftRequest) -> bytes:
    """构造发件 MIME (reply / reply-all / forward / new), 供 IMAP APPEND 或 SMTP send.

    - reply*: multipart/alternative (plain + 可选 html), 带 In-Reply-To / References 线程头.
    - forward: **不带** threading 头 (独立邮件); ``forward_intro_text/html`` 追加在用户正文后.
    - 附件: 任意 mode 都支持; ``EmailMessage.add_attachment`` 自动把 alternative 包进
      multipart/mixed (外层 mixed 套 alternative + 各 attachment part).

    review HIGH/MEDIUM 保留: In-Reply-To 强制 ``<msg-id>`` 包裹; From display name; User-Agent.
    """
    msg = EmailMessage()
    from_display = getattr(cfg, "user_name", "") or ""
    from_email = cfg.user_email
    msg["From"] = f"{from_display} <{from_email}>" if from_display else from_email
    if draft.to:
        msg["To"] = ", ".join(draft.to)
    if draft.cc:
        msg["Cc"] = ", ".join(draft.cc)
    if draft.bcc:
        # send 时 smtplib.send_message 自动从 Bcc 提取收件人并剥离该 header;
        # draft APPEND 时 Bcc 留在草稿 (Outlook 草稿可见 Bcc, 可接受).
        msg["Bcc"] = ", ".join(draft.bcc)
    msg["Subject"] = draft.subject or "(no subject)"
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="mailagent.local")

    # threading 头: forward 是独立邮件, 不写 In-Reply-To / References.
    if draft.mode != "forward":
        if draft.in_reply_to:
            irt = draft.in_reply_to.strip()
            if not irt.startswith("<"):
                irt = f"<{irt}>"
            msg["In-Reply-To"] = irt
        if draft.references:
            # 调用方应传完整 chain (``<old_refs> <old_msgid>``); 这里只做空白归一.
            refs_clean = " ".join(draft.references.split())
            if refs_clean:
                msg["References"] = refs_clean
        elif draft.in_reply_to:
            irt = draft.in_reply_to.strip()
            if not irt.startswith("<"):
                irt = f"<{irt}>"
            msg["References"] = irt

    msg["User-Agent"] = "MailAgent/dual-backend/davmail"

    # 正文组装: forward 把引用块追加在用户正文之后.
    body_text = draft.reply_text or "(empty body)"
    body_html = draft.reply_html
    if draft.mode == "forward":
        if draft.forward_intro_text:
            body_text = f"{body_text}\n\n{draft.forward_intro_text}"
        if draft.forward_intro_html:
            # 用户正文若无 html, 用 plain 包一层保证 alternative 一致.
            base_html = body_html or f"<p>{(draft.reply_text or '').strip()}</p>"
            body_html = f"{base_html}{draft.forward_intro_html}"

    msg.set_content(body_text)
    if body_html:
        msg.add_alternative(body_html, subtype="html")

    # 附件 (multipart/mixed 自动嵌套).
    for att in draft.attachments or []:
        try:
            filename, content, mime_type = att
        except (ValueError, TypeError):
            logger.warning(f"[sender] skip malformed attachment entry: {att!r}")
            continue
        maintype, _, subtype = (mime_type or "application/octet-stream").partition("/")
        msg.add_attachment(
            content,
            maintype=maintype or "application",
            subtype=subtype or "octet-stream",
            filename=filename,
        )
    return msg.as_bytes()


def _parse_appenduid(data: Optional[list]) -> Optional[int]:
    """从 APPEND 响应解析 APPENDUID (RFC 4315 ``[APPENDUID uidvalidity uid]``)."""
    if not data:
        return None
    for item in data:
        raw = item if isinstance(item, (bytes, bytearray)) else str(item).encode()
        m = _APPENDUID_RE.search(raw)
        if m:
            try:
                return int(m.group(2))
            except (TypeError, ValueError):
                return None
    return None


def _append_to_sent(cfg: "Config", mime_bytes: bytes) -> tuple[bool, Optional[int]]:
    """兜底: 手动 APPEND 一份到 Sent 文件夹 (服务端不自动归档时用).

    Returns (archived, sent_uid). 失败仅 warning 不抛 — 归档失败不该让 send 算失败.
    """
    try:
        with imap_session(cfg, timeout=60) as imap:
            sent = getattr(cfg, "davmail_sent_folder", "") or discover_sent_folder(imap)
            if not sent:
                logger.warning("[sender] archive_sent: 找不到 Sent 文件夹, 跳过归档")
                return False, None
            typ, data = imap.append(sent, "(\\Seen)", None, mime_bytes)
            if typ != "OK":
                logger.warning(f"[sender] archive_sent: APPEND {sent!r} failed: {data}")
                return False, None
            return True, _parse_appenduid(data)
    except Exception as e:
        logger.warning(f"[sender] archive_sent failed: {e}")
        return False, None


def smtp_send(
    cfg: "Config",
    mime_bytes: bytes,
    *,
    method: str = "smtp",
    archive_sent: bool = False,
) -> SendResult:
    """通过 DavMail SMTP 真实发送 mime_bytes. 失败返回 ``SendResult(success=False)`` 不抛.

    ``archive_sent=True`` 时发送成功后再手动 APPEND 一份到 Sent (服务端不自动归档兜底).
    """
    msg = BytesParser().parsebytes(mime_bytes)
    message_id = (msg.get("Message-ID") or "").strip()
    try:
        with smtp_session(cfg, timeout=120) as smtp:
            smtp.send_message(msg)
    except DavMailConnectionError as e:
        logger.error(f"[sender] smtp_send connect/auth failed: {e}")
        return SendResult(
            success=False, message_id=message_id, method=method,
            error=f"SMTP connect/auth failed: {e}",
        )
    except Exception as e:
        logger.error(f"[sender] smtp_send failed: {e}")
        return SendResult(
            success=False, message_id=message_id, method=method,
            error=f"SMTP send failed: {e}",
        )

    archived, sent_uid = False, None
    if archive_sent:
        archived, sent_uid = _append_to_sent(cfg, mime_bytes)

    return SendResult(
        success=True, message_id=message_id, method=method,
        archived_to_sent=archived, sent_folder_uid=sent_uid,
    )
