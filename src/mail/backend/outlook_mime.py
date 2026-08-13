"""Outlook COM item → RFC822 MIME 重组 (P0 风险核心, 纯 Python 零 COM 依赖).

Outlook COM **没有可靠的「给我原始 MIME」API** (PR_TRANSPORT_MESSAGE_HEADERS 只有
头块; PR_MIME 不通用), 而本仓整条解析链 (``EmailReader.parse_email_source`` →
附件/会议 ics/线程/v4 SSoT) 吃 RFC822 原文 —— 所以 outlook_com backend 必须本地
重组 MIME。同事仓 (MailAgentWin) 的 eml_generator 重组路线已在其生产跑通, 本模块
是其思路的重写升级: 保留原始 transport 头 + 重建 body 结构。

分层纪律:
  - :class:`ItemSnapshot` 是**纯数据**快照 —— COM 属性抽取发生在 backend 的 STA
    线程上 (``outlook_com_backend._snapshot_item``), 抽完即与 COM 解耦;
  - :func:`rebuild_rfc822` 是纯函数, mac 上可完整单测 (保真度闸)。

结构策略 (镜像常见 MUA 产物):
  - plain + html            → multipart/alternative
  - html + 内联图 (cid:)    → multipart/related 包住 html
  - 任意 + 普通附件         → multipart/mixed 最外层
  - .ics 附件               → text/calendar (会议邀请解析链依赖这个 MIME 类型)

头策略: 优先 PR_TRANSPORT_MESSAGE_HEADERS 原文 (References/In-Reply-To/Received
链全保留 —— thread_id 推导靠它), 剥掉结构性头 (Content-*/MIME-Version, 由重组决定);
transport 头缺失 (草稿/已发送常见) 时从 item 属性合成必需头。
"""
from __future__ import annotations

import mimetypes
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email import policy
from email.message import EmailMessage
from email.parser import Parser
from email.utils import format_datetime, make_msgid
from typing import List, Optional

from loguru import logger

# 结构性头: 重组时由 EmailMessage 自己生成, 原值必须剥掉 (boundary 已失效)
_STRUCTURAL_HEADERS = frozenset(
    {
        "content-type",
        "content-transfer-encoding",
        "content-disposition",
        "content-id",
        "mime-version",
    }
)


@dataclass
class AttachmentSnapshot:
    """附件纯数据快照 (bytes in-memory, 由 STA 线程 SaveAsFile→read→unlink 产出)."""

    filename: str
    data: bytes
    content_id: Optional[str] = None  # 有值 + html 里有 cid: 引用 → 内联图
    mime_type: Optional[str] = None  # COM 侧可给 PR_ATTACH_MIME_TAG; 缺省按扩展名猜


@dataclass
class ItemSnapshot:
    """MailItem 纯数据快照 —— COM 解耦边界."""

    subject: str = ""
    sender_name: str = ""
    sender_email: str = ""
    to: str = ""
    cc: str = ""
    message_id: str = ""
    received_time: Optional[datetime] = None
    transport_headers: Optional[str] = None  # PR_TRANSPORT_MESSAGE_HEADERS 原文
    html_body: Optional[str] = None
    plain_body: Optional[str] = None
    attachments: List[AttachmentSnapshot] = field(default_factory=list)
    conversation_index: Optional[str] = None
    conversation_id: Optional[str] = None
    entry_id: Optional[str] = None
    store_id: Optional[str] = None
    is_read: bool = False
    is_flagged: bool = False


def _guess_mime(att: AttachmentSnapshot) -> tuple[str, str]:
    """附件 MIME 类型: COM 给的 PR_ATTACH_MIME_TAG 优先, 否则按扩展名猜.

    .ics 强制 text/calendar —— 会议邀请检测链 (meeting_sync/icalendar_parser)
    按 MIME 类型识别, application/octet-stream 会让 .ics 静默失联。
    """
    name_lower = (att.filename or "").lower()
    if name_lower.endswith(".ics"):
        return "text", "calendar"
    mime = att.mime_type
    if not mime or "/" not in mime:
        guessed, _ = mimetypes.guess_type(att.filename or "")
        mime = guessed or "application/octet-stream"
    maintype, _, subtype = mime.partition("/")
    return maintype or "application", subtype or "octet-stream"


def _parse_transport_headers(headers_str: str) -> list[tuple[str, str]]:
    """transport 头块 → (name, value) 列表, 剥结构性头.

    用 compat32 宽松解析 (真实世界头里什么怪东西都有), 值保持原文 —— 再 set 进
    policy.default 的 EmailMessage 时逐条 try/except, 坏头跳过不炸整封。
    """
    try:
        msg = Parser().parsestr(headers_str, headersonly=True)
    except Exception as e:  # noqa: BLE001 — 头块整体坏 → 全部走合成路径
        logger.warning(f"[outlook-mime] transport headers unparseable, synthesizing: {e}")
        return []
    out: list[tuple[str, str]] = []
    for name, value in msg.items():
        if name.lower() in _STRUCTURAL_HEADERS:
            continue
        out.append((name, value))
    return out


def rebuild_rfc822(snap: ItemSnapshot) -> str:
    """快照 → RFC822 MIME 字符串 (可被 ``EmailReader.parse_email_source`` 解析).

    🔴 失败 raise (不返回空串) —— 空 ``source`` 在 ``new_watcher._build_email_object``
    是硬失败, 上层 (backend fetch) 捕获后返 None 走 retry queue, 语义与 davmail
    fetch 失败一致。
    """
    msg = EmailMessage(policy=policy.default)

    # ---- 1. 头: transport 原文优先, 逐条容错 ----
    seen: set[str] = set()
    if snap.transport_headers:
        for name, value in _parse_transport_headers(snap.transport_headers):
            key = name.lower()
            try:
                # Received 等头合法重复; unique 头 (Subject/From/...) 只收首个
                if key in seen and key not in ("received", "x-received"):
                    continue
                msg[name] = value
                seen.add(key)
            except Exception as e:  # noqa: BLE001 — 单条坏头跳过, 必需头下面兜底
                logger.debug(f"[outlook-mime] skip bad header {name!r}: {e}")

    # ---- 2. 必需头兜底合成 (transport 头缺失/被剥时) ----
    def _ensure(name: str, value: Optional[str]) -> None:
        if value and msg.get(name) is None:
            try:
                msg[name] = value
            except Exception as e:  # noqa: BLE001
                logger.warning(f"[outlook-mime] cannot set {name}: {e}")

    if msg.get("From") is None:
        if snap.sender_email:
            from_val = (
                f"{snap.sender_name} <{snap.sender_email}>"
                if snap.sender_name and snap.sender_name != snap.sender_email
                else snap.sender_email
            )
            _ensure("From", from_val)
    _ensure("To", snap.to)
    _ensure("Cc", snap.cc)
    _ensure("Subject", snap.subject)
    _ensure("Message-ID", snap.message_id)
    if msg.get("Message-ID") is None:
        # 空 Message-ID 曾在 MailAgentWin 造成数据事故 (空判据误判已存在);
        # 本仓纪律: 缺失即合成 (entry_id 派生保证稳定, 同封重抓得到同一 ID)
        synthetic = (
            f"<outlook-com-{snap.entry_id}@mailagent.synthetic>"
            if snap.entry_id
            else make_msgid(domain="mailagent.synthetic")
        )
        msg["Message-ID"] = synthetic
        logger.warning(f"[outlook-mime] missing Message-ID, synthesized {synthetic}")
    if msg.get("Date") is None:
        dt = snap.received_time or datetime.now(timezone.utc)
        if dt.tzinfo is None:
            dt = dt.astimezone()
        msg["Date"] = format_datetime(dt)

    # ---- 3. 正文 ----
    plain = snap.plain_body or ""
    html = snap.html_body
    if html:
        if plain.strip():
            msg.set_content(plain)
            msg.add_alternative(html, subtype="html")
            html_part = msg.get_payload()[-1]
        else:
            msg.set_content(html, subtype="html")
            html_part = msg
    else:
        msg.set_content(plain)
        html_part = None

    # ---- 4. 内联图 (cid: 引用) 进 related, 其余进 mixed ----
    inline: list[AttachmentSnapshot] = []
    regular: list[AttachmentSnapshot] = []
    html_lower = (html or "").lower()
    for att in snap.attachments:
        cid = (att.content_id or "").strip().strip("<>")
        if cid and html_part is not None and f"cid:{cid.lower()}" in html_lower:
            inline.append(att)
        else:
            regular.append(att)

    for att in inline:
        maintype, subtype = _guess_mime(att)
        cid = att.content_id.strip()
        if not cid.startswith("<"):
            cid = f"<{cid}>"
        try:
            html_part.add_related(
                att.data, maintype=maintype, subtype=subtype, cid=cid,
                filename=att.filename or None,
            )
        except Exception as e:  # noqa: BLE001 — 内联失败降级普通附件, 不丢数据
            logger.warning(f"[outlook-mime] inline attach failed, fallback: {e}")
            regular.append(att)

    for att in regular:
        maintype, subtype = _guess_mime(att)
        kwargs = {"maintype": maintype, "subtype": subtype, "filename": att.filename or "attachment"}
        if maintype == "text":
            # add_attachment(text) 要 str; .ics/csv 等按 utf-8 容错解码
            try:
                msg.add_attachment(
                    att.data.decode("utf-8", errors="replace"),
                    subtype=subtype,
                    filename=kwargs["filename"],
                )
                continue
            except Exception:  # noqa: BLE001 — 解码失败按二进制走
                kwargs = {"maintype": "application", "subtype": "octet-stream", "filename": kwargs["filename"]}
        msg.add_attachment(att.data, **kwargs)

    # ---- 5. 序列化 ----
    try:
        return msg.as_string()
    except Exception:
        # policy.default 序列化偶发被怪头噎住 → compat32 兜底 (宽松输出)
        logger.warning("[outlook-mime] policy.default serialization failed, retrying compat32")
        import email as _email

        return _email.message_from_bytes(msg.as_bytes(policy=policy.compat32)).as_string()
