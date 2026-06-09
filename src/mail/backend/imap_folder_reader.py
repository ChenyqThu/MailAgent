"""FolderImapReader — Archive / Drafts IMAP 文件夹的读写操作.

对标 src/calendar_sync/caldav_reader.py: 封装一类资源的 IMAP/SMTP 操作, 供归档
(mail_write) / 草稿 (draft) / 多文件夹 CRUD 按需调用. 复用 DavMailBackend 已有的
imap_session / _build_reply_mime / 模块级 helper, 不重复造轮子.

davmail-only: 构造时接收一个 DavMailBackend 实例 (持 cfg + drafts_folder +
_build_reply_mime). AppleScript 模式下不实例化本类.

MIME → dict 解析逻辑抽成模块级纯函数 `parse_message_to_folder_dict`, 单测可直接
喂 raw MIME bytes, 不需要 mock IMAP.
"""
from __future__ import annotations

import hashlib
from datetime import datetime
from email.message import Message
from email.parser import BytesParser
from email.utils import getaddresses
from typing import TYPE_CHECKING, Optional

from loguru import logger

from src.converter.html_to_markdown import html_to_markdown
from src.mail.backend.davmail_backend import (
    DavMailBackend,
    _decode_mime_header,
    _extract_display_name,
    _extract_first_email,
    _normalize_date_iso,
    _read_uidvalidity_from_select,
    _select_is_writable,
)
from src.mail.backend.imap_client import (
    discover_archive_folder,
    imap_session,
    quote_mailbox,
    smtp_session,
)
from src.mail.backend.imap_utf7 import encode_imap_utf7
from src.mail.backend.types import DraftRequest

if TYPE_CHECKING:
    from src.config import Config

# 单封 body / snippet 上限, 控制 SQLite 体积 (snippet 用于列表预览).
_SNIPPET_CHARS = 200
_MONTHS = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)


# =============================================================================
# 纯函数: MIME → folder row dict (无 IMAP 依赖, 可单测)
# =============================================================================

def _extract_bodies(msg: Message) -> tuple[str, str]:
    """从 MIME 提取 (body_html, body_text). 优先 text/html, 兜底 text/plain.

    遍历所有 part, 跳过 attachment (content-disposition=attachment). multipart/
    alternative 时 html 和 plain 都可能存在, 各取最后一个非空.
    """
    body_html = ""
    body_text = ""
    for part in msg.walk():
        if part.is_multipart():
            continue
        disp = (part.get_content_disposition() or "").lower()
        if disp == "attachment":
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/html", "text/plain"):
            continue
        try:
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            charset = part.get_content_charset() or "utf-8"
            text = payload.decode(charset, errors="replace")
        except Exception:
            continue
        if ctype == "text/html":
            body_html = text
        else:
            body_text = text
    return body_html, body_text


def _extract_attachments(msg: Message) -> list[dict]:
    """提取附件元数据 [{filename, size, content_type}]. inline image 不计入."""
    out: list[dict] = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        disp = (part.get_content_disposition() or "").lower()
        filename = part.get_filename()
        if disp != "attachment" and not filename:
            continue
        if disp == "inline" and not filename:
            continue
        try:
            payload = part.get_payload(decode=True)
            size = len(payload) if payload else 0
        except Exception:
            size = 0
        out.append({
            "filename": _decode_mime_header(filename) if filename else "(unnamed)",
            "size": size,
            "content_type": part.get_content_type(),
        })
    return out


def parse_message_to_folder_dict(
    raw_bytes: bytes,
    *,
    folder: str,
    imap_uid: int,
    imap_uidvalidity: Optional[int],
    is_flagged: bool = False,
) -> dict:
    """把 raw MIME bytes 解析成 folder row dict (不含本地 id / 时间戳).

    drafts: date_received 取邮件 Date 头 (草稿创建/修改时间); 调用方可覆盖.
    """
    import json

    msg = BytesParser().parsebytes(raw_bytes)

    message_id = (msg.get("Message-ID") or "").strip().strip("<>") or None
    references = msg.get("References") or ""
    in_reply_to = msg.get("In-Reply-To") or ""
    thread_id = None
    if references:
        refs = references.strip().split()
        if refs:
            thread_id = refs[0].strip("<>")
    elif in_reply_to:
        thread_id = in_reply_to.strip().strip("<>")

    from_decoded = _decode_mime_header(msg.get("From"))
    sender_email = _extract_first_email(from_decoded) or from_decoded
    sender_name = _extract_display_name(from_decoded)

    to_pairs = getaddresses([_decode_mime_header(h) for h in msg.get_all("To", [])])
    cc_pairs = getaddresses([_decode_mime_header(h) for h in msg.get_all("Cc", [])])
    to_addr = ", ".join(a for _, a in to_pairs if a) or None
    cc_addr = ", ".join(a for _, a in cc_pairs if a) or None

    body_html, body_text = _extract_bodies(msg)
    body_markdown = html_to_markdown(body_html) if body_html else (body_text or "")
    snippet = " ".join(body_markdown.split())[:_SNIPPET_CHARS] or None

    attachments = _extract_attachments(msg)

    return {
        "folder": folder,
        "imap_uid": imap_uid,
        "imap_uidvalidity": imap_uidvalidity,
        "message_id": message_id,
        "thread_id": thread_id,
        "subject": _decode_mime_header(msg.get("Subject")),
        "sender": sender_email,
        "sender_name": sender_name,
        "to_addr": to_addr,
        "cc_addr": cc_addr,
        "date_received": _normalize_date_iso(msg.get("Date") or ""),
        "is_flagged": 1 if is_flagged else 0,
        "has_attachments": 1 if attachments else 0,
        "body_html": body_html or None,
        "body_markdown": body_markdown or None,
        "snippet": snippet,
        "attachments_json": json.dumps(attachments, ensure_ascii=False) if attachments else None,
        "raw_mime_sha256": hashlib.sha256(raw_bytes).hexdigest(),
    }


# =============================================================================
# FolderImapReader — IMAP/SMTP 操作
# =============================================================================

class FolderImapReader:
    """Archive / Drafts 文件夹的 IMAP/SMTP 操作封装 (davmail-only)."""

    def __init__(self, backend: "DavMailBackend"):
        self.backend = backend
        self.cfg: "Config" = backend.cfg
        # lazy discover, 探测后缓存. drafts 用 backend 已探测的结果.
        self._archive_folder: Optional[str] = None

    # --- folder name 解析 ---

    def resolve_imap_folder(self, folder: str) -> Optional[str]:
        """'archive' / 'drafts' → 实际 IMAP folder 名 (探测/缓存). None=找不到."""
        if folder == "drafts":
            return self.backend.drafts_folder or "Drafts"
        if folder == "archive":
            if self._archive_folder is None:
                try:
                    with imap_session(self.cfg, timeout=30) as imap:
                        self._archive_folder = discover_archive_folder(imap)
                except Exception as e:
                    logger.warning(f"[folder-reader] discover archive failed: {e}")
                    self._archive_folder = None
            return self._archive_folder
        raise ValueError(f"unknown folder {folder!r} (expect 'archive'|'drafts')")

    @staticmethod
    def _since_search_arg(since: datetime) -> str:
        """datetime → IMAP SEARCH SINCE 参数 'DD-Mon-YYYY'."""
        return f"{since.day:02d}-{_MONTHS[since.month - 1]}-{since.year}"

    # --- 读 ---

    def list_folder(
        self,
        folder: str,
        *,
        since: Optional[datetime] = None,
        limit: int = 500,
    ) -> list[dict]:
        """列文件夹邮件 (含 body + 附件元数据). since=窗口左界 (archive 用), limit=末尾 N 封.

        返回 folder row dict list (不含本地 id / created_at / updated_at).
        """
        imap_box = self.resolve_imap_folder(folder)
        if not imap_box:
            logger.info(f"[folder-reader] folder {folder!r} not found on server, skip")
            return []
        out: list[dict] = []
        try:
            with imap_session(self.cfg, timeout=120) as imap:
                typ, _ = imap.select(imap_box, readonly=True)
                if typ != "OK":
                    logger.warning(f"[folder-reader] SELECT {imap_box!r} failed")
                    return []
                uv = _read_uidvalidity_from_select(imap)
                # SEARCH: 有 since 用 SINCE, 否则 ALL
                if since is not None:
                    typ, data = imap.uid("search", None, "SINCE", self._since_search_arg(since))
                else:
                    typ, data = imap.uid("search", None, "ALL")
                if typ != "OK" or not data or not data[0]:
                    return []
                uids = data[0].split()
                if limit and len(uids) > limit:
                    uids = uids[-limit:]
                if not uids:
                    return []
                # 逐封 FETCH BODY.PEEK[] (.PEEK 不置 \Seen). batch 一次取.
                uid_seq = b",".join(uids).decode()
                typ, fetched = imap.uid("fetch", uid_seq, "(UID FLAGS BODY.PEEK[])")
                if typ != "OK" or not fetched:
                    return []
                for item in fetched:
                    parsed = self._parse_fetch_item(item, folder, uv)
                    if parsed:
                        out.append(parsed)
        except Exception as e:
            logger.error(f"[folder-reader] list_folder({folder}) failed: {e}")
            return []
        return out

    @staticmethod
    def _parse_fetch_item(item, folder: str, uidvalidity: Optional[int]) -> Optional[dict]:
        """单个 FETCH 响应 tuple → folder row dict."""
        if not (isinstance(item, tuple) and len(item) >= 2):
            return None
        meta = item[0] if isinstance(item[0], (bytes, bytearray)) else b""
        meta_str = bytes(meta).decode("utf-8", errors="replace")
        # UID + FLAGS 从 meta 提取
        import re
        m = re.search(r"UID\s+(\d+)", meta_str)
        if not m:
            return None
        uid = int(m.group(1))
        is_flagged = "\\Flagged" in meta_str
        raw = bytes(item[1]) if isinstance(item[1], (bytes, bytearray)) else b""
        if not raw:
            return None
        try:
            d = parse_message_to_folder_dict(
                raw, folder=folder, imap_uid=uid,
                imap_uidvalidity=uidvalidity, is_flagged=is_flagged,
            )
            return d
        except Exception as e:
            logger.warning(f"[folder-reader] parse uid={uid} failed: {e}")
            return None

    def fetch_raw_by_uid(self, folder: str, uid: int) -> Optional[bytes]:
        """取单封 raw MIME bytes (send_draft / 附件下载用)."""
        imap_box = self.resolve_imap_folder(folder)
        if not imap_box:
            return None
        try:
            with imap_session(self.cfg, timeout=120) as imap:
                typ, _ = imap.select(imap_box, readonly=True)
                if typ != "OK":
                    return None
                typ, data = imap.uid("fetch", str(uid), "(BODY.PEEK[])")
                if typ != "OK" or not data:
                    return None
                for item in data:
                    if isinstance(item, tuple) and len(item) >= 2:
                        return bytes(item[1]) if isinstance(item[1], (bytes, bytearray)) else None
        except Exception as e:
            logger.error(f"[folder-reader] fetch_raw_by_uid({folder},{uid}) failed: {e}")
        return None

    def folder_status(self, folder: str) -> Optional[tuple[Optional[int], Optional[int]]]:
        """IMAP STATUS folder (UIDVALIDITY UIDNEXT) → (uidvalidity, uidnext).

        worker tick 用它判断 folder 有没有变 (uidnext 增 = 新邮件; uidvalidity 变 =
        服务端重建索引). None = folder 不存在 (如没 Archive 文件夹).
        """
        import re

        imap_box = self.resolve_imap_folder(folder)
        if not imap_box:
            return None
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                typ, data = imap.status(imap_box, "(UIDNEXT UIDVALIDITY)")
                if typ != "OK" or not data:
                    return None
                line = data[0]
                if isinstance(line, (bytes, bytearray)):
                    line = bytes(line).decode("utf-8", errors="replace")
                uv_m = re.search(r"UIDVALIDITY\s+(\d+)", line)
                un_m = re.search(r"UIDNEXT\s+(\d+)", line)
                return (
                    int(uv_m.group(1)) if uv_m else None,
                    int(un_m.group(1)) if un_m else None,
                )
        except Exception as e:
            logger.warning(f"[folder-reader] folder_status({folder}) failed: {e}")
            return None

    # --- 写 ---

    def delete_message(self, folder: str, uid: int) -> bool:
        """UID STORE +FLAGS (\\Deleted) + EXPUNGE. 带 read-only 降级检查."""
        imap_box = self.resolve_imap_folder(folder)
        if not imap_box:
            return False
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, _ = imap.select(imap_box, readonly=False)
                if typ != "OK" or not _select_is_writable(imap):
                    logger.error(f"[folder-reader] SELECT {imap_box!r} not writable, delete aborted")
                    return False
                typ, _ = imap.uid("store", str(uid), "+FLAGS", "(\\Deleted)")
                if typ != "OK":
                    return False
                imap.expunge()
                return True
        except Exception as e:
            logger.error(f"[folder-reader] delete_message({folder},{uid}) failed: {e}")
            return False

    def move_message(self, src_folder: str, uid: int, dst_imap: str) -> bool:
        """UID COPY → dst + STORE \\Deleted + EXPUNGE (存档移回 INBOX 等).

        dst_imap 是 IMAP folder 名 (如 'INBOX'), 调用方用 _mailbox_to_imap 转好.
        """
        imap_box = self.resolve_imap_folder(src_folder)
        if not imap_box:
            return False
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, _ = imap.select(imap_box, readonly=False)
                if typ != "OK" or not _select_is_writable(imap):
                    logger.error(f"[folder-reader] SELECT {imap_box!r} not writable, move aborted")
                    return False
                typ, _ = imap.uid("copy", str(uid), dst_imap)
                if typ != "OK":
                    logger.warning(f"[folder-reader] UID COPY {uid}→{dst_imap!r} failed")
                    return False
                imap.uid("store", str(uid), "+FLAGS", "(\\Deleted)")
                imap.expunge()
                return True
        except Exception as e:
            logger.error(f"[folder-reader] move_message({src_folder},{uid}→{dst_imap}) failed: {e}")
            return False

    def archive_inbox_message(
        self,
        message_id: Optional[str],
        fallback_uid: Optional[int] = None,
        src_imap: str = "INBOX",
    ) -> bool:
        """把 ``src_imap`` 文件夹里的邮件 MOVE 到 Archive 文件夹 (归档).

        ``src_imap`` 默认 INBOX (收件箱归档); 多文件夹同步传邮件**当前**文件夹的 imap_name
        (自定义文件夹邮件归档时 src 不是 INBOX)。SELECT src (writable, quote) → 按 Message-ID
        反查**当前** UID (避免 SQLite 存的过期 imap_uid) → UID COPY → Archive → STORE
        \\Deleted → EXPUNGE。message_id 查不到回退 fallback_uid。
        """
        dst = self.resolve_imap_folder("archive")
        if not dst:
            logger.error("[folder-reader] archive: Archive 文件夹未发现, 无法归档")
            return False
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, _ = imap.select(quote_mailbox(src_imap), readonly=False)
                if typ != "OK" or not _select_is_writable(imap):
                    logger.error(f"[folder-reader] archive: {src_imap!r} SELECT 不可写, 中止")
                    return False
                uid = DavMailBackend._lookup_uid_by_message_id(imap, message_id or "")
                if uid is None:
                    uid = fallback_uid
                if uid is None:
                    logger.warning(
                        f"[folder-reader] archive: 找不到 INBOX UID (mid={message_id!r})"
                    )
                    return False
                typ, _ = imap.uid("copy", str(uid), dst)
                if typ != "OK":
                    logger.warning(f"[folder-reader] archive: UID COPY {uid}→{dst!r} 失败")
                    return False
                imap.uid("store", str(uid), "+FLAGS", "(\\Deleted)")
                imap.expunge()
                logger.info(f"[folder-reader] archived INBOX uid={uid} → {dst!r}")
                return True
        except Exception as e:
            logger.error(f"[folder-reader] archive_inbox_message failed: {e}")
            return False

    # ------------------------------------------------------------
    # 多文件夹同步: 泛化移动 (任意 src→dst) + 文件夹管理 CRUD (davmail-only)
    # ------------------------------------------------------------

    def move_by_message_id(
        self,
        src_imap: str,
        message_id: Optional[str],
        dst_imap: str,
        fallback_uid: Optional[int] = None,
    ) -> bool:
        """泛化版 archive_inbox_message: src/dst 都是任意 IMAP folder 原始名 (modified-UTF7)。

        SELECT src (writable, quote) → 按 Message-ID 反查**当前** UID (避免 SQLite 存的过期
        imap_uid) → UID COPY → dst → STORE \\Deleted → EXPUNGE。message_id 查不到回退
        fallback_uid。归档 (任意文件夹→Archive) + 移动 (任意→任意) 共用。
        """
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, _ = imap.select(quote_mailbox(src_imap), readonly=False)
                if typ != "OK" or not _select_is_writable(imap):
                    logger.error(
                        f"[folder-reader] move: SELECT {src_imap!r} 不可写, 中止"
                    )
                    return False
                uid = DavMailBackend._lookup_uid_by_message_id(imap, message_id or "")
                if uid is None:
                    uid = fallback_uid
                if uid is None:
                    logger.warning(
                        f"[folder-reader] move: 找不到 {src_imap!r} UID (mid={message_id!r})"
                    )
                    return False
                typ, _ = imap.uid("copy", str(uid), quote_mailbox(dst_imap))
                if typ != "OK":
                    logger.warning(
                        f"[folder-reader] move: UID COPY {uid}→{dst_imap!r} 失败"
                    )
                    return False
                imap.uid("store", str(uid), "+FLAGS", "(\\Deleted)")
                imap.expunge()
                logger.info(f"[folder-reader] moved {src_imap!r} uid={uid} → {dst_imap!r}")
                return True
        except Exception as e:
            logger.error(
                f"[folder-reader] move_by_message_id({src_imap!r}→{dst_imap!r}) failed: {e}"
            )
            return False

    def create_folder(self, imap_name: str) -> bool:
        """IMAP CREATE (davmail→EWS CreateFolder)。imap_name = modified-UTF7 原始名 (含层级路径)。"""
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                typ, resp = imap.create(quote_mailbox(imap_name))
                if typ != "OK":
                    logger.error(f"[folder-reader] CREATE {imap_name!r} failed: {resp}")
                    return False
                return True
        except Exception as e:
            logger.error(f"[folder-reader] create_folder({imap_name!r}) failed: {e}")
            return False

    def rename_folder(self, old_imap: str, new_imap: str) -> bool:
        """IMAP RENAME (davmail→EWS UpdateFolder)。old/new = modified-UTF7 原始名。"""
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                typ, resp = imap.rename(quote_mailbox(old_imap), quote_mailbox(new_imap))
                if typ != "OK":
                    logger.error(
                        f"[folder-reader] RENAME {old_imap!r}→{new_imap!r} failed: {resp}"
                    )
                    return False
                return True
        except Exception as e:
            logger.error(
                f"[folder-reader] rename_folder({old_imap!r}→{new_imap!r}) failed: {e}"
            )
            return False

    def delete_folder(self, imap_name: str) -> bool:
        """IMAP DELETE (davmail→EWS DeleteFolder)。系统文件夹 EWS 自身拒删 (返回非 OK)。"""
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                typ, resp = imap.delete(quote_mailbox(imap_name))
                if typ != "OK":
                    logger.error(f"[folder-reader] DELETE {imap_name!r} failed: {resp}")
                    return False
                return True
        except Exception as e:
            logger.error(f"[folder-reader] delete_folder({imap_name!r}) failed: {e}")
            return False

    @staticmethod
    def build_child_imap_name(parent_imap: str, child_display: str, delimiter: str = "/") -> str:
        """父 imap_name + 子显示名 → 子文件夹完整 imap_name (modified-UTF7)。

        顶层 (parent 空) → 直接 encode(child)。child_display 是用户输入的可读名 (可中文)。
        """
        child_enc = encode_imap_utf7(child_display)
        if not parent_imap:
            return child_enc
        return f"{parent_imap}{delimiter}{child_enc}"

    def create_draft(self, draft: DraftRequest) -> Optional[int]:
        """构建 MIME (复用 backend._build_reply_mime, 支持 mode=new) → IMAP APPEND Drafts.

        Returns: 新草稿的 IMAP UID (APPENDUID), 或 None.
        """
        folder = self.backend.drafts_folder or "Drafts"
        try:
            mime_bytes = self.backend._build_reply_mime(draft)
        except Exception as e:
            logger.error(f"[folder-reader] build draft MIME failed: {e}")
            return None
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, data = imap.append(folder, "(\\Draft \\Seen)", None, mime_bytes)
                if typ != "OK":
                    logger.warning(f"[folder-reader] APPEND draft failed: {data}")
                    return None
                return DavMailBackend._parse_appenduid(data)
        except Exception as e:
            logger.error(f"[folder-reader] create_draft failed: {e}")
            return None

    def update_draft(self, old_uid: int, draft: DraftRequest) -> Optional[int]:
        """编辑草稿 = 先 APPEND 新草稿, 成功后再删旧 (顺序保证失败不丢草稿).

        Returns: 新草稿 UID, 或 None (失败时旧草稿保留).
        """
        new_uid = self.create_draft(draft)
        if new_uid is None:
            logger.warning("[folder-reader] update_draft: append new failed, old draft kept")
            return None
        # 新草稿就位, 删旧的. 删失败只 warning (用户会看到两封, 不致命).
        if not self.delete_message("drafts", old_uid):
            logger.warning(
                f"[folder-reader] update_draft: new uid={new_uid} created but "
                f"delete old uid={old_uid} failed — duplicate draft may appear"
            )
        return new_uid

    def send_draft(self, uid: int) -> bool:
        """取草稿 raw MIME → SMTP 发送 → 删除草稿.

        发送为对外不可逆动作; 调用方 (CLI) 已做 --yes 二次确认.
        """
        raw = self.fetch_raw_by_uid("drafts", uid)
        if not raw:
            logger.error(f"[folder-reader] send_draft: draft uid={uid} not found")
            return False
        msg = BytesParser().parsebytes(raw)
        try:
            with smtp_session(self.cfg) as smtp:
                smtp.send_message(msg)
        except Exception as e:
            logger.error(f"[folder-reader] send_draft SMTP failed (uid={uid}): {e}")
            return False
        # 发送成功 → 删草稿. 删失败只 warning (邮件已发出, 草稿残留不致命).
        if not self.delete_message("drafts", uid):
            logger.warning(f"[folder-reader] send_draft: sent but delete draft uid={uid} failed")
        return True
