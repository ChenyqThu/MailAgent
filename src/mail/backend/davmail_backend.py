"""DavMailBackend — IMailBackend 实现, PRIMARY 模式 (MAILAGENT_BACKEND=davmail).

走 DavMail JVM 本机 IMAP (1143) + SMTP (1025), DavMail 内部桥接 EWS / Graph 跟
Outlook 服务端通信. PoC 实测 vs AppleScript:
- UID FETCH BODY[] 236ms (vs 1s, 4× 快)
- STORE +FLAGS 同步生效
- APPEND Drafts 富文本完美
- IDLE 不推送 (fallback 30s STATUS polling)

详见 plan §"切换边界 — 命令级抽象" + davmail-poc/POC-RESULTS.md.

`backend_origin = "davmail"`: 新邮件抓进来时 SyncStore 写 backend_origin='davmail',
internal_id = AUTOINCREMENT 起点 1_000_000_000 (永不跟 Mail.app ROWID 冲突).
"""
from __future__ import annotations

import time
from datetime import datetime
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formatdate, make_msgid


def _decode_mime_header(value: Optional[str]) -> str:
    """RFC 2047 decode 邮件 header (subject / from / to 等).

    DavMail IMAP 返回的 raw MIME 里 header 是 `=?gb2312?B?...?=` 这种 encoded-word 形式,
    必须 decode 才能跟 AppleScript 的 native 字符串对齐. 失败 fallback 原值.
    """
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value
from typing import TYPE_CHECKING, Any, Optional

from loguru import logger

from src.mail.backend.base import IMailBackend
from src.mail.backend.imap_client import (
    DavMailConnectionError,
    discover_drafts_folder,
    imap_connect,
    imap_session,
    probe_tcp,
    smtp_session,
)
from src.mail.backend.types import (
    BackendHealth,
    BackendOrigin,
    DraftAppendResult,
    DraftRequest,
    EmailContent,
    EmailMeta,
    RadarTick,
)

if TYPE_CHECKING:
    from src.config import Config
    from src.mail.sync_store import SyncStore


# 中文 mailbox → IMAP 标准名映射 (Outlook 国际化常见命名)
_MAILBOX_TO_IMAP = {
    "收件箱": "INBOX",
    "INBOX": "INBOX",
    "发件箱": "Sent Items",
    "已发送": "Sent Items",
    "草稿": "Drafts",
    "Drafts": "Drafts",
}


def _mailbox_to_imap(name: Optional[str]) -> str:
    """中文 mailbox → IMAP path. 未知名字原样返回 (假设是已经合规的 IMAP path)."""
    if not name:
        return "INBOX"
    return _MAILBOX_TO_IMAP.get(name, name)


class DavMailBackend(IMailBackend):
    """DavMail IMAP/SMTP 后端 (主路径)."""

    backend_origin: BackendOrigin = "davmail"

    def __init__(self, cfg: "Config", *, sync_store: "SyncStore"):
        self.cfg = cfg
        self.sync_store = sync_store
        self.host = getattr(cfg, "davmail_imap_host", "") or "127.0.0.1"
        self.imap_port = int(getattr(cfg, "davmail_imap_port", 0) or 1143)
        self.smtp_port = int(getattr(cfg, "davmail_smtp_port", 0) or 1025)

        # probe 时探测填充
        self.drafts_folder: Optional[str] = (
            getattr(cfg, "davmail_drafts_folder", "") or None
        )
        self.inbox_uidvalidity: Optional[int] = None
        self.last_op_latency_ms: Optional[int] = None

    # =========================================================================
    # 启动 / 健康检查
    # =========================================================================

    def probe_readiness(self) -> tuple[bool, str]:
        """启动 probe: TCP 1143/1025 + IMAP LOGIN + SELECT INBOX + 探测 Drafts 文件夹."""
        for port in (self.imap_port, self.smtp_port):
            ok, detail = probe_tcp(self.host, port, timeout=2.0)
            if not ok:
                return False, f"TCP probe failed: {detail}"

        try:
            imap = imap_connect(self.cfg, timeout=10)
        except DavMailConnectionError as e:
            return False, f"IMAP LOGIN failed: {e}"

        try:
            typ, data = imap.select("INBOX", readonly=True)
            if typ != "OK":
                return False, f"SELECT INBOX failed: {data}"

            # 拿 UIDVALIDITY (baseline marker 的一部分)
            typ, data = imap.status("INBOX", "(UIDVALIDITY)")
            if typ == "OK" and data:
                uv = self._extract_status_value(data[0], "UIDVALIDITY")
                self.inbox_uidvalidity = int(uv) if uv else None

            # 探测 Drafts (如果配置没显式给)
            if not self.drafts_folder:
                self.drafts_folder = discover_drafts_folder(imap) or "Drafts"
        finally:
            try:
                imap.logout()
            except Exception:
                pass

        return True, (
            f"DavMail OK (uidvalidity={self.inbox_uidvalidity}, "
            f"drafts={self.drafts_folder!r})"
        )

    def health_status(self) -> BackendHealth:
        # 轻量探测: 仅 TCP, 不做 LOGIN (避免高频 LOGIN)
        imap_ok, imap_detail = probe_tcp(self.host, self.imap_port, timeout=2.0)
        smtp_ok, smtp_detail = probe_tcp(self.host, self.smtp_port, timeout=2.0)
        healthy = imap_ok and smtp_ok
        return BackendHealth(
            healthy=healthy,
            backend=self.backend_origin,
            details={
                "imap": imap_detail,
                "smtp": smtp_detail,
                "uidvalidity": self.inbox_uidvalidity,
                "drafts_folder": self.drafts_folder,
            },
            last_op_latency_ms=self.last_op_latency_ms,
            error=None if healthy else f"imap={imap_ok} smtp={smtp_ok}",
        )

    # =========================================================================
    # 正向 sync — IMAP STATUS UIDNEXT 雷达
    # =========================================================================

    def detect_new_emails(self, marker: Any = None) -> RadarTick:
        """IMAP STATUS INBOX (UIDNEXT UIDVALIDITY) 轮询.

        marker=None: 启动 baseline, 返回 (uidvalidity, uidnext), has_new=False.
        marker=(uidvalidity, uidnext): 比对; uidvalidity 变了 → has_new=True + 全失效信号;
            uidnext 变大 → has_new=True, 估计新邮件数 = current_uidnext - last_uidnext.

        不在此处 fetch headers (lazy: 上层 new_watcher 收到 has_new=True 后再 fetch_recent
        或 fetch_email_by_id), 避免大批量 backfill 阻塞雷达节奏.
        """
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                t0 = time.time()
                typ, data = imap.status("INBOX", "(UIDNEXT UIDVALIDITY MESSAGES)")
                self.last_op_latency_ms = int((time.time() - t0) * 1000)
        except Exception as e:
            logger.warning(f"[davmail-backend] STATUS INBOX failed: {e}")
            return RadarTick(has_new=False, current_marker=marker, estimated_new_count=0)

        if typ != "OK" or not data:
            return RadarTick(has_new=False, current_marker=marker, estimated_new_count=0)

        uv = self._extract_status_value(data[0], "UIDVALIDITY")
        uidnext = self._extract_status_value(data[0], "UIDNEXT")
        try:
            current = (int(uv), int(uidnext))
        except (TypeError, ValueError):
            return RadarTick(has_new=False, current_marker=marker, estimated_new_count=0)

        if marker is None:
            return RadarTick(has_new=False, current_marker=current, estimated_new_count=0)

        try:
            last_uv, last_uidnext = marker
        except Exception:
            return RadarTick(has_new=True, current_marker=current, estimated_new_count=0)

        if int(last_uv) != current[0]:
            # UIDVALIDITY 变了 — Outlook server 重建 mailbox 索引, 所有 imap_uid 失效
            logger.warning(
                f"[davmail-backend] UIDVALIDITY changed: {last_uv} → {current[0]}, "
                f"all imap_uid 失效, 需触发 backfill"
            )
            return RadarTick(
                has_new=True, current_marker=current, estimated_new_count=-1,
            )

        delta = current[1] - int(last_uidnext)
        return RadarTick(
            has_new=delta > 0,
            current_marker=current,
            estimated_new_count=max(0, delta),
        )

    def fetch_email_by_id(
        self, internal_id: int, *, mailbox: Optional[str] = None
    ) -> Optional[EmailContent]:
        """查 SyncStore 拿 (uidvalidity, uid) 或 message_id, 然后 IMAP UID FETCH BODY[]."""
        record = self.sync_store.get(internal_id)
        if not record:
            logger.warning(f"[davmail-backend] internal_id={internal_id} not in sync_store")
            return None

        imap_box = _mailbox_to_imap(mailbox or record.get("mailbox"))
        imap_uid = record.get("imap_uid")  # A.4 schema 后才有值
        imap_uv = record.get("imap_uidvalidity")
        message_id = record.get("message_id") or ""

        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, _ = imap.select(imap_box, readonly=True)
                if typ != "OK":
                    logger.warning(f"[davmail-backend] SELECT {imap_box!r} failed")
                    return None

                # 优先用 imap_uid 快路径; 否则 message_id 反查
                if imap_uid and imap_uv:
                    typ, status_data = imap.status(imap_box, "(UIDVALIDITY)")
                    current_uv = self._extract_status_value(
                        status_data[0] if status_data else b"", "UIDVALIDITY"
                    )
                    if current_uv and int(current_uv) != int(imap_uv):
                        logger.info(
                            f"[davmail-backend] UIDVALIDITY mismatch for "
                            f"internal_id={internal_id}, fallback to message_id search"
                        )
                        imap_uid = None  # 失效

                if not imap_uid:
                    if not message_id:
                        logger.warning(
                            f"[davmail-backend] internal_id={internal_id} no imap_uid "
                            f"AND no message_id — cannot locate"
                        )
                        return None
                    imap_uid = self._lookup_uid_by_message_id(imap, message_id)
                    if not imap_uid:
                        return None

                # FETCH BODY[]
                t0 = time.time()
                typ, data = imap.uid(
                    "fetch", str(imap_uid),
                    "(UID INTERNALDATE FLAGS RFC822.SIZE BODY.PEEK[])",
                )
                self.last_op_latency_ms = int((time.time() - t0) * 1000)

                if typ != "OK" or not data:
                    return None

                return self._parse_fetch_response(data, internal_id, imap_box)
        except Exception as e:
            logger.error(f"[davmail-backend] fetch_email_by_id({internal_id}) failed: {e}")
            return None

    def fetch_recent(
        self, count: int, *, mailbox: Optional[str] = None
    ) -> list[EmailMeta]:
        """IMAP UID SEARCH ALL 取末尾 count 个 UID → BATCH FETCH headers."""
        imap_box = _mailbox_to_imap(mailbox)
        result: list[EmailMeta] = []
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, _ = imap.select(imap_box, readonly=True)
                if typ != "OK":
                    return []

                typ, data = imap.uid("search", None, "ALL")
                if typ != "OK" or not data or not data[0]:
                    return []
                uids = data[0].split()
                tail = uids[-count:] if len(uids) > count else uids

                if not tail:
                    return []
                uid_seq = b",".join(tail).decode()
                typ, data = imap.uid(
                    "fetch", uid_seq,
                    "(UID FLAGS BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT FROM DATE REFERENCES IN-REPLY-TO)])",
                )
                if typ != "OK" or not data:
                    return []
                # NOTE: Phase A.3 简化 — 完整 batch header 解析推到 Phase A 末优化
                # 这里给个 stub: 返回空, 标 TODO. fetch_recent 暂时不被主链路调用
                # (new_watcher 主路径走 detect_new_emails + fetch_email_by_id).
                logger.info(
                    f"[davmail-backend] fetch_recent({count}) — Phase A.3 stub, "
                    f"returning empty list; got {len(tail)} UIDs"
                )
        except Exception as e:
            logger.error(f"[davmail-backend] fetch_recent failed: {e}")
        return result

    # =========================================================================
    # 反向 sync — UID STORE
    # =========================================================================

    def mark_as_read(
        self, internal_id: int, read: bool, *, mailbox: Optional[str] = None
    ) -> bool:
        flag = "(\\Seen)"
        op = "+FLAGS" if read else "-FLAGS"
        return self._store_flag(internal_id, op, flag, mailbox)

    def set_flag(
        self, internal_id: int, flagged: bool, *, mailbox: Optional[str] = None
    ) -> bool:
        flag = "(\\Flagged)"
        op = "+FLAGS" if flagged else "-FLAGS"
        return self._store_flag(internal_id, op, flag, mailbox)

    def _store_flag(
        self, internal_id: int, op: str, flag: str, mailbox: Optional[str]
    ) -> bool:
        record = self.sync_store.get(internal_id)
        if not record:
            logger.warning(f"[davmail-backend] _store_flag: internal_id={internal_id} not in sync_store")
            return False
        imap_box = _mailbox_to_imap(mailbox or record.get("mailbox"))
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                typ, _ = imap.select(imap_box, readonly=False)
                if typ != "OK":
                    return False
                imap_uid = record.get("imap_uid")
                if not imap_uid:
                    msg_id = record.get("message_id") or ""
                    if not msg_id:
                        return False
                    imap_uid = self._lookup_uid_by_message_id(imap, msg_id)
                    if not imap_uid:
                        return False
                t0 = time.time()
                typ, _ = imap.uid("store", str(imap_uid), op, flag)
                self.last_op_latency_ms = int((time.time() - t0) * 1000)
                return typ == "OK"
        except Exception as e:
            logger.error(f"[davmail-backend] _store_flag failed: {e}")
            return False

    # =========================================================================
    # 草稿创建 — IMAP APPEND
    # =========================================================================

    def append_draft(self, draft: DraftRequest) -> DraftAppendResult:
        """Build MIME (multipart/alternative HTML + plain) → IMAP APPEND.

        Phase A.3 内嵌简化 MIME builder; Phase B 抽到 src/mail/draft_builder.py 并支持
        附件 / 完整 reply-all 收件人计算 / In-Reply-To 自动推断.
        """
        folder = draft.drafts_folder or self.drafts_folder or "Drafts"

        try:
            mime_bytes = self._build_reply_mime(draft)
        except Exception as e:
            return DraftAppendResult(
                success=False, drafts_folder=folder, error=f"MIME build failed: {e}",
            )

        try:
            with imap_session(self.cfg, timeout=60) as imap:
                t0 = time.time()
                typ, data = imap.append(folder, "(\\Draft)", None, mime_bytes)
                self.last_op_latency_ms = int((time.time() - t0) * 1000)

                if typ != "OK":
                    return DraftAppendResult(
                        success=False, drafts_folder=folder,
                        error=f"IMAP APPEND failed: {data}",
                    )
                # APPENDUID extension 返回 UID, 解析它
                appended_uid = self._parse_appenduid(data)
                logger.info(
                    f"[davmail-backend] append_draft → {folder!r} "
                    f"uid={appended_uid} latency={self.last_op_latency_ms}ms"
                )
                return DraftAppendResult(
                    success=True, drafts_folder=folder, appended_uid=appended_uid,
                    method="imap_append",
                )
        except Exception as e:
            logger.error(f"[davmail-backend] append_draft failed: {e}")
            return DraftAppendResult(
                success=False, drafts_folder=folder, error=f"append exception: {e}",
            )

    # =========================================================================
    # 内部 helpers
    # =========================================================================

    @staticmethod
    def _extract_status_value(line: bytes, key: str) -> Optional[str]:
        """从 STATUS response line 提取指定 key 的值.

        line 形如: b'INBOX (UIDNEXT 12345 UIDVALIDITY 67890 MESSAGES 24000)'
        """
        if not line:
            return None
        text = line.decode("utf-8", errors="replace")
        tokens = text.replace("(", " ").replace(")", " ").split()
        for i, tok in enumerate(tokens):
            if tok.upper() == key.upper() and i + 1 < len(tokens):
                return tokens[i + 1]
        return None

    @staticmethod
    def _lookup_uid_by_message_id(imap, message_id: str) -> Optional[int]:
        """IMAP UID SEARCH HEADER Message-ID '<msg-id>' 反查 UID."""
        if not message_id:
            return None
        mid_clean = message_id.strip()
        # IMAP SEARCH 需要带 < > 的完整 Message-ID
        if not mid_clean.startswith("<"):
            mid_clean = f"<{mid_clean}>"
        try:
            typ, data = imap.uid("search", None, "HEADER", "Message-ID", mid_clean)
        except Exception as e:
            logger.warning(f"[davmail-backend] UID SEARCH HEADER failed: {e}")
            return None
        if typ != "OK" or not data or not data[0]:
            return None
        try:
            return int(data[0].split()[0])
        except Exception:
            return None

    def _parse_fetch_response(
        self, data: list, internal_id: int, imap_box: str
    ) -> Optional[EmailContent]:
        """从 UID FETCH 响应解析出 EmailContent."""
        mime_bytes = b""
        uid_returned = None
        flags_returned: list[str] = []
        for item in data:
            if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], (bytes, bytearray)):
                # item[0] 形如 b'1 (UID 100 FLAGS (\\Seen) BODY[] {1234}'
                meta = item[0].decode("utf-8", errors="replace")
                m_uid = self._extract_status_value(item[0], "UID")
                if m_uid:
                    uid_returned = int(m_uid)
                if "\\Seen" in meta:
                    flags_returned.append("\\Seen")
                if "\\Flagged" in meta:
                    flags_returned.append("\\Flagged")
                mime_bytes = bytes(item[1])
                break

        if not mime_bytes:
            return None

        msg = BytesParser().parsebytes(mime_bytes)
        message_id = (msg.get("Message-ID") or "").strip().strip("<>")
        # RFC 2047 decode — DavMail IMAP 返回 raw encoded-word, AppleScript 返回 decoded 字符串
        subject = _decode_mime_header(msg.get("Subject"))
        sender = _decode_mime_header(msg.get("From"))
        date_str = msg.get("Date") or ""  # Date header 不需要 decode
        references = msg.get("References") or ""
        in_reply_to = msg.get("In-Reply-To") or ""
        thread_id = None
        if references:
            refs = references.strip().split()
            if refs:
                thread_id = refs[0].strip("<>")
        elif in_reply_to:
            thread_id = in_reply_to.strip().strip("<>")
        if not thread_id and message_id:
            thread_id = message_id

        # 抽 text/plain 部分作为 content (HTML 部分留在 source 里给 v4 SQLite SSoT 解析)
        content = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain" and not part.get("Content-Disposition", "").startswith("attachment"):
                    try:
                        payload = part.get_payload(decode=True)
                        if payload:
                            content = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
                            break
                    except Exception:
                        pass
        else:
            try:
                payload = msg.get_payload(decode=True)
                if payload:
                    content = payload.decode(msg.get_content_charset() or "utf-8", errors="replace")
            except Exception:
                pass

        return EmailContent(
            message_id=message_id,
            internal_id=internal_id,
            subject=subject,
            sender=sender,
            date_received=date_str,  # RFC 822 格式; 上层若需 ISO 自己 parse
            content=content,
            source=mime_bytes.decode("utf-8", errors="replace"),
            is_read="\\Seen" in flags_returned,
            is_flagged="\\Flagged" in flags_returned,
            thread_id=thread_id,
            mailbox=imap_box,
            imap_uid=uid_returned,
            imap_uidvalidity=self.inbox_uidvalidity,
        )

    def _build_reply_mime(self, draft: DraftRequest) -> bytes:
        """Build multipart/alternative MIME for IMAP APPEND.

        简化版 (Phase A.3): 直接用 EmailMessage; Phase B 抽到 draft_builder.py 并支持
        附件 / cid inline image / Reply-All 收件人去重等高级特性.
        """
        msg = EmailMessage()
        msg["From"] = self.cfg.user_email
        if draft.to:
            msg["To"] = ", ".join(draft.to)
        if draft.cc:
            msg["Cc"] = ", ".join(draft.cc)
        msg["Subject"] = draft.subject or "(no subject)"
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = make_msgid(domain="mailagent.local")
        if draft.in_reply_to:
            msg["In-Reply-To"] = draft.in_reply_to
        if draft.references:
            msg["References"] = draft.references
        elif draft.in_reply_to:
            msg["References"] = draft.in_reply_to

        msg.set_content(draft.reply_text or "(empty body)")
        if draft.reply_html:
            msg.add_alternative(draft.reply_html, subtype="html")
        return msg.as_bytes()

    @staticmethod
    def _parse_appenduid(data: list) -> Optional[int]:
        """从 APPEND 响应解析 APPENDUID extension 返回的 UID.

        响应形如: [b'[APPENDUID 12345 678] (Success)']
        """
        if not data:
            return None
        for item in data:
            text = item.decode("utf-8", errors="replace") if isinstance(item, (bytes, bytearray)) else str(item)
            if "APPENDUID" in text:
                parts = text.split()
                for i, tok in enumerate(parts):
                    if "APPENDUID" in tok.upper() and i + 2 < len(parts):
                        try:
                            return int(parts[i + 2].strip("]"))
                        except Exception:
                            pass
        return None
