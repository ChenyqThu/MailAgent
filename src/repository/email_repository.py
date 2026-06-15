"""EmailRepository - SQLite SSoT 邮件读写入口（v4 架构）.

设计原则:
    - 只读方法返回 dataclass，禁止暴露 sqlite3.Row 给上层
    - commit_email_with_body 是事务，metadata + body + attachments 原子提交
    - 附件二进制读写经由 AttachmentStore 子模块（不直接操作文件系统）

详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md §5.
"""

from __future__ import annotations

import sqlite3
import time
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from loguru import logger

from src.repository.attachment_store import AttachmentStore
from src.repository.search_query import (
    FilterPredicate,
    ParsedSearchQuery,
    TextTerm,
    build_structured_filter_predicates,
    parse_search_query,
)


# ============================================================
# Payloads (写入)
# ============================================================

@dataclass
class BodyPayload:
    """commit_email_with_body 的 body 入参."""
    html: Optional[str]                          # 原始 HTML（cid: 已重写为相对路径）
    markdown: Optional[str]                      # HTML → Markdown
    body_format: str = "html"                    # 'html' | 'text-only' | 'empty'
    has_inline_images: bool = False
    raw_mime_sha256: Optional[str] = None        # raw MIME 哈希
    fetched_source: str = "applescript"          # 'applescript' | 'emlx' | 'notion-backfill'


@dataclass
class AttachmentPayload:
    """commit_email_with_body 的 attachment 入参（单个）."""
    filename: str
    content: bytes                               # 二进制内容（会落盘 + 算 sha256）
    content_type: Optional[str] = None
    content_id: Optional[str] = None             # MIME CID（inline image）
    is_inline: bool = False
    derived_from_filename: Optional[str] = None  # 同一封邮件里原附件的 filename；用于 derived 关联
    derived_format: Optional[str] = None         # 'pdf' | 'csv'


# ============================================================
# Records (读取)
# ============================================================

@dataclass
class AttachmentRecord:
    """email_attachment 行 + 计算字段."""
    id: int
    internal_id: int
    filename: str
    content_type: Optional[str]
    size_bytes: Optional[int]
    is_inline: bool
    content_id: Optional[str]
    local_path: Optional[str]
    sha256: Optional[str]
    derived_from: Optional[int]
    derived_format: Optional[str]
    notion_file_id: Optional[str]
    notion_block_id: Optional[str]
    created_at: float


@dataclass
class EmailBodyRecord:
    internal_id: int
    message_id: Optional[str]
    html: Optional[str]
    markdown: Optional[str]
    body_format: str
    body_size_bytes: int
    has_inline_images: bool
    raw_mime_sha256: Optional[str]
    fetched_at: float
    fetched_source: str


@dataclass
class EmailMetadataRecord:
    """email_metadata 行 dataclass 投影 (替代 Dict 出口, 用于 CLI / EmailFull)."""
    internal_id: int
    message_id: Optional[str]
    thread_id: Optional[str]
    subject: str
    sender: str
    sender_name: Optional[str]
    to_addr: str
    cc_addr: str
    date_received: Optional[str]
    mailbox: str
    is_read: bool
    is_flagged: bool
    sync_status: str
    notion_page_id: Optional[str]
    notion_thread_id: Optional[str]
    sync_error: Optional[str]
    retry_count: int
    next_retry_at: Optional[float]
    created_at: float
    updated_at: float
    # v8: 前端置顶 / pin（Mail.app 无此概念；仅本地 + Notion mirror 不写）
    is_pinned: bool = False
    pinned_at: Optional[float] = None
    # v9: 邮件原生重要性（Importance / X-Priority / X-MSMail-Priority 任一为
    # high → True）。由 reader._parse_importance 在 parse 阶段填好，前端
    # EmailRow 的 ❗ 角标读这个字段。
    is_important: bool = False

    @property
    def notion_url(self) -> Optional[str]:
        if not self.notion_page_id:
            return None
        return f"https://www.notion.so/{self.notion_page_id.replace('-', '')}"


@dataclass
class EmailFull:
    """EmailRepository.get_email_full 返回 — metadata + body + attachments 单点聚合."""
    internal_id: int
    metadata: EmailMetadataRecord
    body: Optional[EmailBodyRecord]
    attachments: list[AttachmentRecord]


@dataclass
class ThreadMember:
    """同 thread_id 的兄弟邮件投影 — _handle_thread_relations 切 SQLite SSoT 用 (R-02)."""
    internal_id: int
    page_id: Optional[str]                # email_metadata.notion_page_id
    date_received: Optional[str]
    is_synced: bool


@dataclass
class EmailSearchHit:
    """search_email_bodies 单条命中（FTS5 + metadata join）."""
    internal_id: int
    subject: str
    sender: str
    date_received: Optional[str]
    mailbox: Optional[str]
    snippet: str            # FTS5 snippet() 高亮片段（默认 <mark>...</mark>）
    rank: float             # bm25 分数（越小越相关，FTS5 约定）
    notion_page_id: Optional[str] = None
    notion_url: Optional[str] = None


@dataclass
class EmailSearchResult:
    """带搜索 meta 的结果，用于 CLI/API/event 透传 parser warning。"""

    hits: list[EmailSearchHit]
    transformed_query: str
    parse_warnings: list[str] = field(default_factory=list)


@dataclass
class ContactSuggestion:
    """compose 收件人自动补全候选。"""

    email: str
    name: Optional[str]
    score: int
    last_seen: Optional[str]


# ============================================================
# PR-2b: 附件文本抽取 + FTS5 搜索 dataclass
# ============================================================

@dataclass
class AttachmentTextRecord:
    """email_attachment_text 行投影."""
    attachment_id: int
    text_content: Optional[str]
    text_size_bytes: int
    extractor: str
    status: str                          # 'pending' / 'extracted' / 'failed' / 'unsupported'
    error_message: Optional[str]
    retry_count: int
    next_retry_at: Optional[float]
    extracted_at: Optional[float]
    truncated: bool
    created_at: float
    updated_at: float


@dataclass
class AttachmentSearchHit:
    """search_attachment_texts 单条命中.

    FTS5 hit 后 JOIN email_attachment + email_metadata 拼邮件上下文,
    让 chat agent 直接 render '在哪封邮件的哪个附件里' 不用再多调 IPC.
    """
    attachment_id: int
    internal_id: int
    filename: str
    content_type: Optional[str]
    snippet: str
    rank: float
    email_subject: str
    email_sender: str
    email_date: Optional[str]
    email_mailbox: Optional[str]
    notion_page_id: Optional[str] = None
    notion_url: Optional[str] = None


# ============================================================
# FTS5 query smart transform — CJK-aware 自然语言 → FTS5 syntax (PR-2a)
# ============================================================
#
# Motivation: SQLite FTS5 用 unicode61 tokenizer, 连续 CJK 串当成单一 token
# ('本周产品评审' 是 1 个 token), 所以 raw query '产品' 仅命中含独立 '产品'
# token 的 doc, 漏掉 '产品评审' 这种合并 token. LLM/自然语言用户不会自己加
# `*`, 这个 wrapper 自动按字符级 AND fallback 提升中文召回.
#
# 不做的事:
# - 不引 jieba (C 扩展打包麻烦)
# - 不切 prefix 之外的 FTS5 特殊语法 (NEAR / column filter)
# - 含 punctuation / quote / wildcard 的 query 视为用户 explicit FTS5 syntax,
#   原样下放


def _is_cjk_char(c: str) -> bool:
    """检测单字符是否 CJK / 日韩 (覆盖 BMP + 扩展 A/B-F + 假名 + 谚文)."""
    if not c:
        return False
    cp = ord(c)
    if 0x4E00 <= cp <= 0x9FFF:        # CJK Unified Ideographs
        return True
    if 0x3400 <= cp <= 0x4DBF:        # CJK Extension A
        return True
    if 0x20000 <= cp <= 0x2FA1F:      # CJK Extension B-F
        return True
    if 0x3040 <= cp <= 0x30FF:        # Hiragana / Katakana
        return True
    if 0xAC00 <= cp <= 0xD7AF:        # Hangul Syllables
        return True
    return False


_FTS5_OPERATORS: frozenset = frozenset({'AND', 'OR', 'NOT'})


def _is_simple_natural_query(q: str) -> bool:
    """query 是否仅含字母/数字/空格/CJK (自然语言关键词).

    含其他 punctuation (`"`, `*`, `(`, `:`, `+`, `-`, `@`, `.` 等) → False,
    smart_query_transform 退回原 query 让 FTS5 自己 parse.
    """
    for c in q:
        if c.isalnum() or c.isspace() or _is_cjk_char(c):
            continue
        return False
    return True


def _wrap_token_cjk_aware(tok: str) -> str:
    """单 token 转 FTS5 片段.

    规则:
        纯拉丁:  原样 (FTS5 默认整词 match)
        单字 CJK: 'X*' (prefix 通配)
        多字 CJK: '(token* OR (c1* AND c2* AND ...))'
                  整 token prefix 优先, 字符级 AND fallback (unicode61
                  chunk-level token 命不中时兜底)
        混合 token (CJK + Latin): 按字符类切 segment, 各自处理, AND 连
    """
    if not tok:
        return ''

    segments: list = []  # list[tuple[bool, str]]
    current_cjk: Optional[bool] = None
    current: str = ''
    for c in tok:
        c_cjk = _is_cjk_char(c)
        if current_cjk is None:
            current_cjk = c_cjk
            current = c
        elif c_cjk == current_cjk:
            current += c
        else:
            segments.append((current_cjk, current))
            current = c
            current_cjk = c_cjk
    if current and current_cjk is not None:
        segments.append((current_cjk, current))

    if len(segments) == 1:
        is_cjk, seg = segments[0]
        if not is_cjk:
            return seg
        if len(seg) == 1:
            return f'{seg}*'
        chars_and = ' AND '.join(f'{c}*' for c in seg)
        return f'({seg}* OR ({chars_and}))'

    parts: list = []
    for is_cjk, seg in segments:
        if not is_cjk:
            parts.append(seg)
        elif len(seg) == 1:
            parts.append(f'{seg}*')
        else:
            chars_and = ' AND '.join(f'{c}*' for c in seg)
            parts.append(f'({seg}* OR ({chars_and}))')
    return '(' + ' AND '.join(parts) + ')'


def smart_query_transform(query: str) -> str:
    """把简单自然语言关键词 query 转成 FTS5-friendly query (CJK 感知).

    转换规则:
        - 空 / 仅空白 → 原样
        - 含 FTS5 特殊字符 (引号/通配/括号/punct 等) → 原样
        - 含 AND/OR/NOT 全大写 operator token → 原样
        - 否则按空白 split token, 逐 token 用 _wrap_token_cjk_aware 包装,
          多 token 用 AND 连接

    Examples:
        '产' → '产*'
        '产品' → '(产品* OR (产* AND 品*))'
        '本周产品评审' → '(本周产品评审* OR (本* AND 周* AND 产* AND 品* AND 评* AND 审*))'
        'redis 超时' → 'redis AND (超时* OR (超* AND 时*))'
        'redis timeout' → 'redis AND timeout'
        'Redis超时' → '(Redis AND (超时* OR (超* AND 时*)))'
        '"redis timeout"' → '"redis timeout"'   (raw, 含 quote)
        'redis AND timeout' → 'redis AND timeout'  (raw, 含 operator)
        '产品*' → '产品*'  (raw, 含 wildcard)
    """
    if not query or not query.strip():
        return query
    q = query.strip()

    if not _is_simple_natural_query(q):
        return q

    tokens = q.split()
    if any(t in _FTS5_OPERATORS for t in tokens):
        return q

    wrapped = [_wrap_token_cjk_aware(t) for t in tokens]
    wrapped = [w for w in wrapped if w]
    if not wrapped:
        return q
    if len(wrapped) == 1:
        return wrapped[0]
    return ' AND '.join(wrapped)


_CONTACT_CACHE_TTL_SECONDS = 10 * 60
_CONTACT_SUGGEST_CACHE: dict[str, tuple[float, list[ContactSuggestion]]] = {}
_EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)


def _normalize_contact_name(value: Optional[str]) -> Optional[str]:
    trimmed = (value or "").strip().strip("\"'")
    return trimmed or None


def _contact_date_key(value: Optional[str]) -> float:
    if not value:
        return 0.0
    try:
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        return datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return 0.0


def _parse_address_segment(segment: str) -> Optional[tuple[str, Optional[str]]]:
    angle = re.match(r"^(.*?)<([^>]+)>", segment)
    if angle:
        email_match = _EMAIL_RE.search(angle.group(2) or "")
        if not email_match:
            return None
        return email_match.group(0).lower(), _normalize_contact_name(angle.group(1))

    email_match = _EMAIL_RE.search(segment)
    if not email_match:
        return None
    name = _normalize_contact_name(segment[:email_match.start()])
    return email_match.group(0).lower(), name


def _parse_address_list(value: Optional[str]) -> list[tuple[str, Optional[str]]]:
    if not value:
        return []
    items: list[tuple[str, Optional[str]]] = []
    for segment in value.split(","):
        parsed = _parse_address_segment(segment.strip())
        if parsed is not None:
            items.append(parsed)
    return items


def _normalize_exclude(exclude: Optional[str | list[str]]) -> set[str]:
    values = exclude if isinstance(exclude, list) else ([exclude] if exclude else [])
    result: set[str] = set()
    for value in values:
        for part in str(value).split(","):
            email = part.strip().lower()
            if email:
                result.add(email)
    return result


def _contact_prefix_match(item: ContactSuggestion, q: str) -> bool:
    if not q:
        return False
    local_part = item.email.split("@", 1)[0]
    if local_part.startswith(q):
        return True
    if any(part.startswith(q) for part in re.split(r"[._%+-]+", local_part)):
        return True
    name = (item.name or "").lower()
    return any(part.startswith(q) for part in re.split(r"[\s,.;:()\"'<>]+", name))


# ============================================================
# Repository
# ============================================================

class EmailRepository:
    """SQLite SSoT 读写入口（v4 架构）."""

    def __init__(
        self,
        db_path: str = "data/sync_store.db",
        attachment_store: Optional[AttachmentStore] = None,
    ):
        self.db_path = Path(db_path)
        self.attachment_store = attachment_store or AttachmentStore()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")  # CASCADE / SET NULL
        return conn

    # ============================================================
    # READ
    # ============================================================

    def get_body_html(self, internal_id: int) -> Optional[str]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT body_html FROM email_body WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            return row["body_html"] if row else None
        finally:
            conn.close()

    def get_body_markdown(
        self, internal_id: int, max_chars: int = -1
    ) -> Optional[str]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT body_markdown FROM email_body WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            if not row or row["body_markdown"] is None:
                return None
            md = row["body_markdown"]
            if max_chars > 0 and len(md) > max_chars:
                return md[:max_chars]
            return md
        finally:
            conn.close()

    def get_body(self, internal_id: int) -> Optional[EmailBodyRecord]:
        conn = self._connect()
        try:
            row = conn.execute(
                """SELECT internal_id, message_id, body_html, body_markdown,
                          body_format, body_size_bytes, has_inline_images,
                          raw_mime_sha256, fetched_at, fetched_source
                   FROM email_body WHERE internal_id = ?""",
                (internal_id,),
            ).fetchone()
            if not row:
                return None
            return EmailBodyRecord(
                internal_id=row["internal_id"],
                message_id=row["message_id"],
                html=row["body_html"],
                markdown=row["body_markdown"],
                body_format=row["body_format"] or "html",
                body_size_bytes=row["body_size_bytes"] or 0,
                has_inline_images=bool(row["has_inline_images"]),
                raw_mime_sha256=row["raw_mime_sha256"],
                fetched_at=row["fetched_at"],
                fetched_source=row["fetched_source"],
            )
        finally:
            conn.close()

    def get_attachments(self, internal_id: int) -> list[AttachmentRecord]:
        conn = self._connect()
        try:
            rows = conn.execute(
                """SELECT id, internal_id, filename, content_type, size_bytes,
                          is_inline, content_id, local_path, sha256,
                          derived_from, derived_format,
                          notion_file_id, notion_block_id, created_at
                   FROM email_attachment WHERE internal_id = ?
                   ORDER BY is_inline DESC, id ASC""",
                (internal_id,),
            ).fetchall()
            return [
                AttachmentRecord(
                    id=r["id"],
                    internal_id=r["internal_id"],
                    filename=r["filename"],
                    content_type=r["content_type"],
                    size_bytes=r["size_bytes"],
                    is_inline=bool(r["is_inline"]),
                    content_id=r["content_id"],
                    local_path=r["local_path"],
                    sha256=r["sha256"],
                    derived_from=r["derived_from"],
                    derived_format=r["derived_format"],
                    notion_file_id=r["notion_file_id"],
                    notion_block_id=r["notion_block_id"],
                    created_at=r["created_at"],
                )
                for r in rows
            ]
        finally:
            conn.close()

    def get_attachment_bytes(self, attachment_id: int) -> Optional[bytes]:
        """根据 attachment.id 通过 local_path 读盘。"""
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT local_path FROM email_attachment WHERE id = ?",
                (attachment_id,),
            ).fetchone()
            if not row or not row["local_path"]:
                return None
            try:
                return self.attachment_store.read(row["local_path"])
            except FileNotFoundError:
                logger.warning(f"Attachment file missing: {row['local_path']}")
                return None
        finally:
            conn.close()

    def get_metadata(self, internal_id: int) -> Optional[EmailMetadataRecord]:
        """SELECT email_metadata 单行构造 dataclass."""
        conn = self._connect()
        try:
            row = conn.execute(
                """SELECT internal_id, message_id, thread_id, subject, sender,
                          sender_name, to_addr, cc_addr, date_received, mailbox,
                          is_read, is_flagged, sync_status,
                          notion_page_id, notion_thread_id, sync_error,
                          retry_count, next_retry_at, created_at, updated_at,
                          is_pinned, pinned_at, is_important
                   FROM email_metadata WHERE internal_id = ?""",
                (internal_id,),
            ).fetchone()
            if not row:
                return None
            return EmailMetadataRecord(
                internal_id=row["internal_id"],
                message_id=row["message_id"],
                thread_id=row["thread_id"],
                subject=row["subject"] or "",
                sender=row["sender"] or "",
                sender_name=row["sender_name"],
                to_addr=row["to_addr"] or "",
                cc_addr=row["cc_addr"] or "",
                date_received=row["date_received"],
                mailbox=row["mailbox"] or "",
                is_read=bool(row["is_read"]),
                is_flagged=bool(row["is_flagged"]),
                sync_status=row["sync_status"] or "pending",
                notion_page_id=row["notion_page_id"],
                notion_thread_id=row["notion_thread_id"],
                sync_error=row["sync_error"],
                retry_count=row["retry_count"] or 0,
                next_retry_at=row["next_retry_at"],
                created_at=row["created_at"] or 0.0,
                updated_at=row["updated_at"] or 0.0,
                is_pinned=bool(row["is_pinned"]),
                pinned_at=row["pinned_at"],
                is_important=bool(row["is_important"]),
            )
        finally:
            conn.close()

    def get_email_full(self, internal_id: int) -> Optional[EmailFull]:
        """一次聚合 metadata + body + attachments — CLI / Notion sync from-sqlite 主入口."""
        meta = self.get_metadata(internal_id)
        if meta is None:
            return None
        return EmailFull(
            internal_id=internal_id,
            metadata=meta,
            body=self.get_body(internal_id),
            attachments=self.get_attachments(internal_id),
        )

    def get_thread_members(
        self,
        thread_id: str,
        *,
        exclude_internal_id: Optional[int] = None,
        synced_only: bool = True,
    ) -> list[ThreadMember]:
        """从 SQLite 查同 thread_id 的兄弟邮件 (R-02 — SSoT 替代 Notion API 查询).

        与 sync_store.get_all_emails_by_thread_id 的区别:
            - 返回 dataclass list 而非 dict list
            - 用 internal_id 排除 (caller 语义一致, 不再依赖 message_id)
            - default synced_only=True — _handle_thread_relations 只关心已上 Notion 的邮件
              (要写 Notion relation 必须有 page_id)

        排序: date_received DESC (最新在前, 与 sync_store.get_all_emails_by_thread_id 一致)。
        空 thread_id → 返回 []。
        """
        if not thread_id:
            return []
        conn = self._connect()
        try:
            sql = (
                "SELECT internal_id, notion_page_id, date_received, sync_status "
                "FROM email_metadata WHERE thread_id = ?"
            )
            params: list = [thread_id]
            if exclude_internal_id is not None:
                sql += " AND internal_id != ?"
                params.append(exclude_internal_id)
            if synced_only:
                sql += " AND sync_status = 'synced'"
            sql += " ORDER BY date_received DESC"
            rows = conn.execute(sql, params).fetchall()
            return [
                ThreadMember(
                    internal_id=r["internal_id"],
                    page_id=r["notion_page_id"],
                    date_received=r["date_received"],
                    is_synced=(r["sync_status"] == "synced"),
                )
                for r in rows
            ]
        finally:
            conn.close()

    # ============================================================
    # LIST (CLI `email list` 专用 — 比 SyncStore.search_emails 更宽松,
    # 不锁 sync_status, 不 cap limit, 暴露 sync_status + thread_id)
    # ============================================================

    LIST_LIMIT_MAX = 500

    def list_metadata(
        self,
        *,
        mailbox: Optional[str] = None,
        status: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        sender_substr: Optional[str] = None,
        subject_substr: Optional[str] = None,
        is_read: Optional[bool] = None,
        is_flagged: Optional[bool] = None,
        is_pinned: Optional[bool] = None,
        is_important: Optional[bool] = None,
        has_notion: Optional[bool] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> dict:
        """CLI ``email list`` 用 — 返回 ``{total, limit, offset, emails: [EmailMetadataRecord, ...]}``.

        与 ``SyncStore.search_emails`` 的差异 (R-15 / PR-2 critic fix):
        - 不强制 ``sync_status IN ('synced', 'pending')``; 若 caller 传 ``status``
          就只过滤该 status, 否则不锁
        - 不把 limit 硬 cap 到 50; 上限走 ``LIST_LIMIT_MAX = 500``
          (与 CLI 公开契约一致, RFC §4.2)
        - SELECT 含 ``sync_status`` + ``thread_id``, CLI 能直接消费
        """
        if limit <= 0:
            return {"total": 0, "limit": limit, "offset": offset, "emails": []}
        limit = min(limit, self.LIST_LIMIT_MAX)

        clauses: list[str] = []
        params: list = []
        if mailbox:
            clauses.append("mailbox = ?")
            params.append(mailbox)
        if status:
            clauses.append("sync_status = ?")
            params.append(status)
        if date_from:
            clauses.append("date_received >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("date_received <= ?")
            params.append(f"{date_to} 23:59:59")
        if sender_substr:
            clauses.append("(sender LIKE ? OR sender_name LIKE ?)")
            like_val = f"%{sender_substr}%"
            params.extend([like_val, like_val])
        if subject_substr:
            clauses.append("subject LIKE ?")
            params.append(f"%{subject_substr}%")
        if is_read is not None:
            clauses.append("is_read = ?")
            params.append(1 if is_read else 0)
        if is_flagged is not None:
            clauses.append("is_flagged = ?")
            params.append(1 if is_flagged else 0)
        if is_pinned is not None:
            clauses.append("is_pinned = ?")
            params.append(1 if is_pinned else 0)
        if is_important is not None:
            clauses.append("is_important = ?")
            params.append(1 if is_important else 0)
        if has_notion is True:
            clauses.append("notion_page_id IS NOT NULL")
        elif has_notion is False:
            clauses.append("notion_page_id IS NULL")

        where_clause = (" WHERE " + " AND ".join(clauses)) if clauses else ""

        conn = self._connect()
        try:
            count_row = conn.execute(
                f"SELECT COUNT(*) AS c FROM email_metadata{where_clause}",
                params,
            ).fetchone()
            total = count_row["c"] if count_row else 0

            rows = conn.execute(
                f"""SELECT internal_id, message_id, thread_id, subject, sender,
                           sender_name, to_addr, cc_addr, date_received, mailbox,
                           is_read, is_flagged, sync_status,
                           notion_page_id, notion_thread_id, sync_error,
                           retry_count, next_retry_at, created_at, updated_at,
                           is_pinned, pinned_at, is_important
                      FROM email_metadata{where_clause}
                  ORDER BY is_pinned DESC, is_important DESC, date_received DESC
                     LIMIT ? OFFSET ?""",
                params + [limit, offset],
            ).fetchall()

            emails = [
                EmailMetadataRecord(
                    internal_id=r["internal_id"],
                    message_id=r["message_id"],
                    thread_id=r["thread_id"],
                    subject=r["subject"] or "",
                    sender=r["sender"] or "",
                    sender_name=r["sender_name"],
                    to_addr=r["to_addr"] or "",
                    cc_addr=r["cc_addr"] or "",
                    date_received=r["date_received"],
                    mailbox=r["mailbox"] or "",
                    is_read=bool(r["is_read"]),
                    is_flagged=bool(r["is_flagged"]),
                    sync_status=r["sync_status"] or "pending",
                    notion_page_id=r["notion_page_id"],
                    notion_thread_id=r["notion_thread_id"],
                    sync_error=r["sync_error"],
                    retry_count=r["retry_count"] or 0,
                    next_retry_at=r["next_retry_at"],
                    created_at=r["created_at"] or 0.0,
                    updated_at=r["updated_at"] or 0.0,
                    is_pinned=bool(r["is_pinned"]),
                    pinned_at=r["pinned_at"],
                    is_important=bool(r["is_important"]),
                )
                for r in rows
            ]
            return {"total": total, "limit": limit, "offset": offset, "emails": emails}
        finally:
            conn.close()

    # ============================================================
    # CONTACT SUGGEST (compose 收件人自动补全)
    # ============================================================

    def suggest_contacts(
        self,
        q: str = "",
        *,
        limit: int = 8,
        exclude: Optional[str | list[str]] = None,
    ) -> list[ContactSuggestion]:
        """从本地邮件元数据聚合 compose 收件人自动补全候选。"""
        try:
            limit = min(max(int(limit), 1), 50)
        except (TypeError, ValueError):
            limit = 8
        query = (q or "").strip().lower()
        excluded = _normalize_exclude(exclude)

        items = [
            item
            for item in self._contact_corpus()
            if item.email.lower() not in excluded
        ]
        if query:
            items = [
                item
                for item in items
                if query in item.email.lower()
                or query in (item.name or "").lower()
            ]

        return sorted(
            items,
            key=lambda item: (
                0 if _contact_prefix_match(item, query) else 1,
                -item.score,
                -_contact_date_key(item.last_seen),
                item.email,
            ),
        )[:limit]

    def _contact_corpus(self) -> list[ContactSuggestion]:
        cache_key = str(self.db_path.resolve())
        now = time.time()
        cached = _CONTACT_SUGGEST_CACHE.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]
        try:
            items = self._aggregate_contact_suggestions()
            _CONTACT_SUGGEST_CACHE[cache_key] = (
                now + _CONTACT_CACHE_TTL_SECONDS,
                items,
            )
            return items
        except Exception as e:
            logger.warning(f"suggest_contacts: aggregation failed: {e}")
            return []

    def _aggregate_contact_suggestions(self) -> list[ContactSuggestion]:
        conn = self._connect()
        contacts: dict[str, dict[str, object]] = {}

        def upsert(
            parsed: Optional[tuple[str, Optional[str]]],
            *,
            score_delta: int,
            date_received: Optional[str],
        ) -> None:
            if parsed is None:
                return
            email, name = parsed
            seen_ts = _contact_date_key(date_received)
            current = contacts.setdefault(
                email,
                {
                    "email": email,
                    "name": None,
                    "score": 0,
                    "last_seen": None,
                    "last_seen_ts": 0.0,
                    "name_seen_ts": 0.0,
                },
            )
            current["score"] = int(current["score"]) + score_delta
            if seen_ts >= float(current["last_seen_ts"]):
                current["last_seen_ts"] = seen_ts
                if date_received:
                    current["last_seen"] = date_received
            if name and seen_ts >= float(current["name_seen_ts"]):
                current["name"] = name
                current["name_seen_ts"] = seen_ts

        try:
            rows = conn.execute(
                """SELECT sender, sender_name, to_addr, cc_addr, mailbox, date_received
                   FROM email_metadata"""
            ).fetchall()
            for row in rows:
                sender = _parse_address_segment(row["sender"] or "")
                if sender is not None:
                    sender_email, sender_name = sender
                    upsert(
                        (
                            sender_email,
                            _normalize_contact_name(row["sender_name"]) or sender_name,
                        ),
                        score_delta=1,
                        date_received=row["date_received"],
                    )

                recipient_score = 3 if row["mailbox"] == "发件箱" else 1
                for parsed in _parse_address_list(row["to_addr"]):
                    upsert(
                        parsed,
                        score_delta=recipient_score,
                        date_received=row["date_received"],
                    )
                for parsed in _parse_address_list(row["cc_addr"]):
                    upsert(
                        parsed,
                        score_delta=recipient_score,
                        date_received=row["date_received"],
                    )

            return [
                ContactSuggestion(
                    email=str(item["email"]),
                    name=item["name"] if isinstance(item["name"], str) else None,
                    score=int(item["score"]),
                    last_seen=(
                        item["last_seen"]
                        if isinstance(item["last_seen"], str)
                        else None
                    ),
                )
                for item in contacts.values()
            ]
        finally:
            conn.close()

    # ============================================================
    # SEARCH (Phase 3: FTS5)
    # ============================================================

    def search_email_bodies(
        self,
        query: str,
        *,
        limit: int = 50,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
    ) -> list[EmailSearchHit]:
        """FTS5 全文搜索邮件正文 + subject + sender（raw FTS5 入口）.

        Args:
            query: FTS5 query 语法 —— 短语用引号，AND/OR/NOT 大写，前缀用 `term*`。
                示例：'"project plan"', 'redis AND timeout', 'meeting NOT canceled'
            limit: 最多返回多少条（caller 责任 cap，repo 不再约束上限）
            mailbox: 仅返回该 mailbox 的邮件（'收件箱' / '发件箱'）
            since_date / until_date: 'YYYY-MM-DD'，按本地时区解释；内部用
                SQLite datetime() 归一时区后比较。

        Returns:
            EmailSearchHit list，按 bm25 升序（最相关在前）。
            空查询 / 无命中 / FTS 语法错误均返回 []（语法错误会 logger.warning）。
        """
        return self._search_email_bodies_raw(
            query,
            limit=limit,
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
        )

    def search_email_bodies_with_meta(
        self,
        query: str,
        *,
        mode: str = "smart",
        limit: int = 50,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
        now: Optional[str] = None,
        tz_offset_minutes: Optional[int] = None,
    ) -> EmailSearchResult:
        """搜索正文并返回调用方需要透传的 meta。

        ``mode='raw'`` 保持 FTS5 query 原样下放；``mode='smart'`` 先解析
        Search Query DSL v1。纯文本 query 命中 fast-path，继续走旧 smart
        transform + raw 查询路径，确保存量行为不变。
        """
        if not query or not query.strip():
            return EmailSearchResult([], query, [])
        if limit <= 0:
            return EmailSearchResult([], query, [])

        normalized_mode = (mode or "smart").lower()
        if normalized_mode == "raw":
            structured_filters, structured_warnings = build_structured_filter_predicates(
                mailbox=mailbox,
                since_date=since_date,
                until_date=until_date,
                now=now,
                tz_offset_minutes=tz_offset_minutes,
            )
            hits = self._search_email_bodies_raw(
                query,
                limit=limit,
                extra_filters=structured_filters,
            )
            return EmailSearchResult(hits, query, structured_warnings)

        parsed = parse_search_query(
            query,
            now=now,
            tz_offset_minutes=tz_offset_minutes,
        )
        if parsed.is_plain_passthrough:
            transformed = smart_query_transform(query)
            structured_filters, structured_warnings = build_structured_filter_predicates(
                mailbox=mailbox,
                since_date=since_date,
                until_date=until_date,
                now=now,
                tz_offset_minutes=tz_offset_minutes,
            )
            if transformed != query:
                logger.debug(
                    f"search_email_bodies_smart: query={query!r} → "
                    f"transformed={transformed!r}"
                )
            hits = self._search_email_bodies_raw(
                transformed,
                limit=limit,
                extra_filters=structured_filters,
            )
            return EmailSearchResult(
                hits,
                transformed,
                [*parsed.warnings, *structured_warnings],
            )

        hits, transformed = self._search_email_bodies_parsed(
            parsed,
            limit=limit,
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
            now=now,
            tz_offset_minutes=tz_offset_minutes,
        )
        return EmailSearchResult(hits, transformed, parsed.warnings)

    def _search_email_bodies_raw(
        self,
        query: str,
        *,
        limit: int,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
        extra_filters: Optional[list[FilterPredicate]] = None,
    ) -> list[EmailSearchHit]:
        if not query or not query.strip():
            return []
        if limit <= 0:
            return []

        # FTS5 MATCH 用占位符传字符串避免 SQL 注入（FTS 语法本身的非法字符
        # 由 SQLite 抛 OperationalError，被下面 try/except 接住）
        sql = """
            SELECT m.internal_id,
                   COALESCE(m.subject, '')        AS subject,
                   COALESCE(m.sender, '')         AS sender,
                   m.date_received,
                   m.mailbox,
                   m.notion_page_id,
                   snippet(email_body_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                   bm25(email_body_fts)           AS rank
              FROM email_body_fts
              JOIN email_metadata m ON m.internal_id = email_body_fts.rowid
             WHERE email_body_fts MATCH ?
        """
        params: list = [query]
        filters = extra_filters
        if filters is None:
            filters, _ = build_structured_filter_predicates(
                mailbox=mailbox,
                since_date=since_date,
                until_date=until_date,
            )
        for predicate in filters:
            sql += f" AND ({predicate.sql})"
            params.extend(predicate.params)
        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        return self._execute_email_search(sql, params, query)

    def _search_email_bodies_parsed(
        self,
        parsed: ParsedSearchQuery,
        *,
        limit: int,
        mailbox: Optional[str],
        since_date: Optional[str],
        until_date: Optional[str],
        now: Optional[str],
        tz_offset_minutes: Optional[int],
    ) -> tuple[list[EmailSearchHit], str]:
        fts_expr = self._build_positive_fts_expr(parsed)
        neg_fts_expr = self._build_negative_fts_expr(parsed)
        filters, structured_warnings = build_structured_filter_predicates(
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
            now=now,
            tz_offset_minutes=tz_offset_minutes,
        )
        parsed.warnings.extend(structured_warnings)

        predicates: list[FilterPredicate] = [
            *parsed.filters,
            *self._compile_or_filter_groups(parsed.or_filter_groups),
            *filters,
        ]
        predicates.extend(
            FilterPredicate(f"NOT ({predicate.sql})", predicate.params)
            for predicate in parsed.neg_filters
        )

        if not fts_expr and not neg_fts_expr and not predicates:
            return [], parsed.original_query

        params: list = []
        if fts_expr:
            sql = """
                SELECT m.internal_id,
                       COALESCE(m.subject, '')        AS subject,
                       COALESCE(m.sender, '')         AS sender,
                       m.date_received,
                       m.mailbox,
                       m.notion_page_id,
                       snippet(email_body_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                       bm25(email_body_fts)           AS rank
                  FROM email_body_fts
                  JOIN email_metadata m ON m.internal_id = email_body_fts.rowid
                 WHERE email_body_fts MATCH ?
            """
            params.append(fts_expr)
            order_by = " ORDER BY rank LIMIT ?"
        else:
            sql = """
                SELECT m.internal_id,
                       COALESCE(m.subject, '')        AS subject,
                       COALESCE(m.sender, '')         AS sender,
                       m.date_received,
                       m.mailbox,
                       m.notion_page_id,
                       ''                             AS snippet,
                       0.0                            AS rank
                  FROM email_metadata m
                 WHERE 1 = 1
            """
            order_by = " ORDER BY datetime(m.date_received) DESC LIMIT ?"

        for predicate in predicates:
            sql += f" AND ({predicate.sql})"
            params.extend(predicate.params)
        if neg_fts_expr:
            sql += (
                " AND m.internal_id NOT IN ("
                "SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)"
            )
            params.append(neg_fts_expr)
        sql += order_by
        params.append(limit)

        query_for_log = fts_expr or parsed.original_query
        transformed_query = fts_expr if fts_expr else parsed.original_query
        return self._execute_email_search(sql, params, query_for_log), transformed_query

    def _execute_email_search(
        self,
        sql: str,
        params: list,
        query_for_log: str,
    ) -> list[EmailSearchHit]:
        conn = self._connect()
        try:
            try:
                rows = conn.execute(sql, params).fetchall()
            except sqlite3.OperationalError as e:
                # FTS5 query 语法错误（unbalanced quote / lone operator 等）
                logger.warning(
                    f"search_email_bodies: invalid FTS5 query {query_for_log!r}: {e}"
                )
                return []

            hits: list[EmailSearchHit] = []
            for r in rows:
                page_id = r["notion_page_id"]
                notion_url = (
                    f"https://www.notion.so/{page_id.replace('-', '')}"
                    if page_id else None
                )
                hits.append(EmailSearchHit(
                    internal_id=r["internal_id"],
                    subject=r["subject"],
                    sender=r["sender"],
                    date_received=r["date_received"],
                    mailbox=r["mailbox"],
                    snippet=r["snippet"] or "",
                    rank=float(r["rank"]),
                    notion_page_id=page_id,
                    notion_url=notion_url,
                ))
            return hits
        finally:
            conn.close()

    def _build_positive_fts_expr(self, parsed: ParsedSearchQuery) -> str:
        parts: list[str] = []
        parts.extend(self._text_term_to_fts(term) for term in parsed.fts_terms)
        parts.extend(
            self._build_fts_or_group(group)
            for group in parsed.fts_or_groups
        )
        parts = [p for p in parts if p]
        return " AND ".join(parts)

    def _build_negative_fts_expr(self, parsed: ParsedSearchQuery) -> str:
        parts = [self._text_term_to_fts(term) for term in parsed.neg_fts_terms]
        parts = [p for p in parts if p]
        return " OR ".join(f"({part})" for part in parts)

    def _build_fts_or_group(self, group: list[TextTerm]) -> str:
        parts = [self._text_term_to_fts(term) for term in group]
        parts = [p for p in parts if p]
        if len(parts) <= 1:
            return parts[0] if parts else ""
        return "(" + " OR ".join(f"({part})" for part in parts) + ")"

    def _text_term_to_fts(self, term: TextTerm) -> str:
        if term.is_phrase or term.force_quoted or not _is_simple_natural_query(term.value):
            return self._quote_fts_value(term.value)
        return smart_query_transform(term.value)

    @staticmethod
    def _quote_fts_value(value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

    @staticmethod
    def _compile_or_filter_groups(
        groups: list[list[FilterPredicate]],
    ) -> list[FilterPredicate]:
        predicates: list[FilterPredicate] = []
        for group in groups:
            sql_parts: list[str] = []
            params: list = []
            for predicate in group:
                sql_parts.append(f"({predicate.sql})")
                params.extend(predicate.params)
            if sql_parts:
                predicates.append(FilterPredicate(" OR ".join(sql_parts), tuple(params)))
        return predicates

    def search_email_bodies_smart(
        self,
        query: str,
        *,
        limit: int = 50,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
    ) -> list[EmailSearchHit]:
        """Smart wrapper of search_email_bodies — Search Query DSL v1 + CJK-aware.

        纯文本查询仍走旧 smart transform fast-path；含字段语法时由 parser 编译。
        """
        return self.search_email_bodies_with_meta(
            query,
            mode="smart",
            limit=limit,
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
        ).hits

    # ============================================================
    # SEARCH (PR-2b: 附件文本 FTS5)
    # ============================================================

    def enqueue_attachment_text_extraction(self, attachment_id: int) -> None:
        """commit_email_with_body 后调 — 把附件登记为 pending 等 worker 抽.

        幂等: 已有行就不动 (INSERT OR IGNORE). worker 处理失败时另外维护
        retry_count + next_retry_at, 不在这里 reset.
        """
        conn = self._connect()
        now = time.time()
        try:
            conn.execute(
                """INSERT OR IGNORE INTO email_attachment_text
                   (attachment_id, text_content, text_size_bytes, extractor,
                    status, retry_count, created_at, updated_at)
                   VALUES (?, NULL, 0, 'pending', 'pending', 0, ?, ?)""",
                (attachment_id, now, now),
            )
            conn.commit()
        finally:
            conn.close()

    def commit_attachment_text(
        self,
        attachment_id: int,
        text: str,
        extractor: str,
        *,
        status: str = 'extracted',
        error_message: Optional[str] = None,
        truncated: bool = False,
    ) -> None:
        """worker / extractor 完成后调 — upsert email_attachment_text 行.

        FTS5 索引通过 trigger 自动维护: status='extracted' + text 非空时
        进 email_attachment_fts; 其他 status 不索引.
        """
        if status not in ('pending', 'extracted', 'failed', 'unsupported'):
            raise ValueError(f"invalid status: {status!r}")

        conn = self._connect()
        now = time.time()
        text_bytes = len(text.encode('utf-8')) if text else 0
        text_payload = text if (text and status == 'extracted') else None
        extracted_at = now if status == 'extracted' else None
        try:
            # 保留原 created_at (如果存在) 让审计 / 重试统计准
            row = conn.execute(
                "SELECT created_at FROM email_attachment_text WHERE attachment_id = ?",
                (attachment_id,),
            ).fetchone()
            created_at = row['created_at'] if row else now

            conn.execute(
                """INSERT OR REPLACE INTO email_attachment_text
                   (attachment_id, text_content, text_size_bytes, extractor,
                    status, error_message, retry_count, next_retry_at,
                    extracted_at, truncated, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)""",
                (
                    attachment_id, text_payload, text_bytes, extractor,
                    status, error_message, extracted_at,
                    1 if truncated else 0,
                    created_at, now,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def get_attachment_text(self, attachment_id: int) -> Optional[AttachmentTextRecord]:
        conn = self._connect()
        try:
            row = conn.execute(
                """SELECT attachment_id, text_content, text_size_bytes, extractor,
                          status, error_message, retry_count, next_retry_at,
                          extracted_at, truncated, created_at, updated_at
                     FROM email_attachment_text WHERE attachment_id = ?""",
                (attachment_id,),
            ).fetchone()
            if not row:
                return None
            return AttachmentTextRecord(
                attachment_id=row['attachment_id'],
                text_content=row['text_content'],
                text_size_bytes=row['text_size_bytes'] or 0,
                extractor=row['extractor'],
                status=row['status'],
                error_message=row['error_message'],
                retry_count=row['retry_count'] or 0,
                next_retry_at=row['next_retry_at'],
                extracted_at=row['extracted_at'],
                truncated=bool(row['truncated']),
                created_at=row['created_at'],
                updated_at=row['updated_at'],
            )
        finally:
            conn.close()

    def list_pending_attachment_extractions(self, *, limit: int = 20) -> list[int]:
        """worker poll 用: 取 pending + retry-ready 的 attachment_id list."""
        if limit <= 0:
            return []
        conn = self._connect()
        now = time.time()
        try:
            rows = conn.execute(
                """SELECT attachment_id FROM email_attachment_text
                   WHERE status = 'pending'
                      OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
                   ORDER BY created_at ASC
                   LIMIT ?""",
                (now, limit),
            ).fetchall()
            return [r['attachment_id'] for r in rows]
        finally:
            conn.close()

    # 重试退避表: 1min, 5min, 15min, 1h, 2h (跟 sync_store.email_metadata 一致)
    _ATTACHMENT_TEXT_RETRY_BACKOFFS = (60.0, 300.0, 900.0, 3600.0, 7200.0)

    def mark_attachment_text_failure(
        self,
        attachment_id: int,
        error_message: str,
        *,
        max_retries: int = 5,
    ) -> None:
        """worker 失败时调 — 递增 retry_count, 算 next_retry_at; 超 max 标 failed (无 retry)."""
        conn = self._connect()
        now = time.time()
        try:
            row = conn.execute(
                "SELECT retry_count FROM email_attachment_text WHERE attachment_id = ?",
                (attachment_id,),
            ).fetchone()
            if not row:
                # 首次失败前应该已经 enqueue, 这里没行就补一行
                conn.execute(
                    """INSERT INTO email_attachment_text
                       (attachment_id, text_content, text_size_bytes, extractor,
                        status, error_message, retry_count, next_retry_at,
                        truncated, created_at, updated_at)
                       VALUES (?, NULL, 0, 'none', 'failed', ?, 1, ?, 0, ?, ?)""",
                    (
                        attachment_id, error_message,
                        now + self._ATTACHMENT_TEXT_RETRY_BACKOFFS[0],
                        now, now,
                    ),
                )
            else:
                new_count = (row['retry_count'] or 0) + 1
                if new_count >= max_retries:
                    next_retry = None  # dead - 不再重试
                else:
                    backoff_idx = min(new_count - 1, len(self._ATTACHMENT_TEXT_RETRY_BACKOFFS) - 1)
                    next_retry = now + self._ATTACHMENT_TEXT_RETRY_BACKOFFS[backoff_idx]
                conn.execute(
                    """UPDATE email_attachment_text
                       SET status = 'failed', error_message = ?,
                           retry_count = ?, next_retry_at = ?, updated_at = ?
                       WHERE attachment_id = ?""",
                    (error_message, new_count, next_retry, now, attachment_id),
                )
            conn.commit()
        finally:
            conn.close()

    def search_attachment_texts(
        self,
        query: str,
        *,
        limit: int = 30,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
    ) -> list[AttachmentSearchHit]:
        """FTS5 搜附件文本 + JOIN 拼邮件上下文 (PR-2b).

        跟 search_email_bodies 平行设计: bm25 升序 (最相关在前),
        snippet 高亮 <mark>...</mark>, JOIN email_attachment + email_metadata
        让 chat agent 直接 render '哪封邮件的哪个附件'.
        """
        if not query or not query.strip():
            return []
        if limit <= 0:
            return []

        sql = """
            SELECT a.id           AS attachment_id,
                   a.internal_id  AS internal_id,
                   COALESCE(a.filename, '')      AS filename,
                   a.content_type AS content_type,
                   COALESCE(m.subject, '')       AS email_subject,
                   COALESCE(m.sender, '')        AS email_sender,
                   m.date_received               AS email_date,
                   m.mailbox                     AS email_mailbox,
                   m.notion_page_id              AS notion_page_id,
                   snippet(email_attachment_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                   bm25(email_attachment_fts)    AS rank
              FROM email_attachment_fts
              JOIN email_attachment a ON a.id = email_attachment_fts.rowid
              JOIN email_metadata m ON m.internal_id = a.internal_id
             WHERE email_attachment_fts MATCH ?
        """
        params: list = [query]
        if mailbox:
            sql += " AND m.mailbox = ?"
            params.append(mailbox)
        if since_date:
            sql += " AND m.date_received >= ?"
            params.append(since_date)
        if until_date:
            sql += " AND m.date_received <= ?"
            params.append(until_date)
        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        conn = self._connect()
        try:
            try:
                rows = conn.execute(sql, params).fetchall()
            except sqlite3.OperationalError as e:
                logger.warning(
                    f"search_attachment_texts: invalid FTS5 query {query!r}: {e}"
                )
                return []

            hits: list[AttachmentSearchHit] = []
            for r in rows:
                page_id = r['notion_page_id']
                notion_url = (
                    f"https://www.notion.so/{page_id.replace('-', '')}"
                    if page_id else None
                )
                hits.append(AttachmentSearchHit(
                    attachment_id=r['attachment_id'],
                    internal_id=r['internal_id'],
                    filename=r['filename'],
                    content_type=r['content_type'],
                    snippet=r['snippet'] or '',
                    rank=float(r['rank']),
                    email_subject=r['email_subject'],
                    email_sender=r['email_sender'],
                    email_date=r['email_date'],
                    email_mailbox=r['email_mailbox'],
                    notion_page_id=page_id,
                    notion_url=notion_url,
                ))
            return hits
        finally:
            conn.close()

    def search_attachment_texts_smart(
        self,
        query: str,
        *,
        limit: int = 30,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
    ) -> list[AttachmentSearchHit]:
        """Smart wrapper of search_attachment_texts (复用 PR-2a smart_query_transform)."""
        transformed = smart_query_transform(query)
        if transformed != query:
            logger.debug(
                f"search_attachment_texts_smart: query={query!r} → "
                f"transformed={transformed!r}"
            )
        return self.search_attachment_texts(
            transformed,
            limit=limit,
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
        )

    # ============================================================
    # WRITE
    # ============================================================

    def commit_email_with_body(
        self,
        internal_id: int,
        body: BodyPayload,
        attachments: list[AttachmentPayload],
        *,
        message_id: Optional[str] = None,
    ) -> dict[str, int]:
        """事务：写 email_body + 落盘 attachments + 写 email_attachment 行.

        返回:
            ``dict[原始 AttachmentPayload.filename, attachment_id]`` —— 上层
            Notion uploader 上传后用这个 map 把 notion_file_id 回写过来。

            **Key 契约**: key 是 caller 传进来的原始 ``att.filename``，**不是**
            sanitize 后落盘的 ``used_filename``（SQLite ``email_attachment.filename``
            列里存的）。调用方持有 ``AttachmentPayload`` list 即可直接查；不要用
            ``AttachmentStore`` 内部的 sanitize 结果做 key。

        失败处理:
            事务级别 rollback；落盘错误会触发 rollback 并清理已写入文件。
            FK 约束要求 email_metadata.internal_id 必须存在（CASCADE 父表）。
        """
        # 1. 先落盘所有附件（外部 IO，先做避免 DB 事务持锁太久）
        saved_files: list[Path] = []
        attachment_disk_info: list[dict] = []  # 与 attachments 同序，包含 local_path / sha256 / 实际 used_filename
        try:
            for att in attachments:
                target_path, used_filename = self.attachment_store.save(
                    internal_id, att.filename, att.content
                )
                saved_files.append(target_path)
                attachment_disk_info.append({
                    "local_path": self.attachment_store.relative_path(
                        internal_id, used_filename
                    ),
                    "sha256": AttachmentStore.sha256(att.content),
                    "used_filename": used_filename,
                    "size_bytes": len(att.content),
                })
        except OSError as e:
            # 落盘失败：清理已写
            for f in saved_files:
                try:
                    f.unlink(missing_ok=True)
                except OSError:
                    pass
            raise RuntimeError(f"Failed to save attachment to disk: {e}") from e

        # 2. 事务写 SQLite
        conn = self._connect()
        now = time.time()
        try:
            conn.execute("BEGIN")
            # email_body upsert
            body_size = len(body.markdown or body.html or "")
            conn.execute(
                """INSERT OR REPLACE INTO email_body
                   (internal_id, message_id, body_html, body_markdown,
                    body_format, body_size_bytes, has_inline_images,
                    raw_mime_sha256, fetched_at, fetched_source, schema_version)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                (
                    internal_id,
                    message_id,
                    body.html,
                    body.markdown,
                    body.body_format,
                    body_size,
                    1 if body.has_inline_images else 0,
                    body.raw_mime_sha256,
                    now,
                    body.fetched_source,
                ),
            )

            # 删除老的 attachment 行（重新 commit 时避免重复）
            conn.execute(
                "DELETE FROM email_attachment WHERE internal_id = ?",
                (internal_id,),
            )

            # 两阶段写入：第一阶段写原始附件、收集 filename → id 映射
            #            第二阶段写 derived 附件，根据 filename 映射回填 derived_from
            filename_to_id: dict[str, int] = {}
            derived_queue: list[tuple[int, AttachmentPayload, dict]] = []

            for idx, (att, disk) in enumerate(zip(attachments, attachment_disk_info)):
                if att.derived_from_filename:
                    derived_queue.append((idx, att, disk))
                    continue
                cur = conn.execute(
                    """INSERT INTO email_attachment
                       (internal_id, content_id, filename, content_type, size_bytes,
                        is_inline, local_path, sha256, derived_from, derived_format,
                        created_at, schema_version)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1)""",
                    (
                        internal_id,
                        att.content_id,
                        disk["used_filename"],
                        att.content_type,
                        disk["size_bytes"],
                        1 if att.is_inline else 0,
                        disk["local_path"],
                        disk["sha256"],
                        now,
                    ),
                )
                filename_to_id[att.filename] = cur.lastrowid

            for idx, att, disk in derived_queue:
                derived_from_id = filename_to_id.get(att.derived_from_filename)
                conn.execute(
                    """INSERT INTO email_attachment
                       (internal_id, content_id, filename, content_type, size_bytes,
                        is_inline, local_path, sha256, derived_from, derived_format,
                        created_at, schema_version)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                    (
                        internal_id,
                        att.content_id,
                        disk["used_filename"],
                        att.content_type,
                        disk["size_bytes"],
                        1 if att.is_inline else 0,
                        disk["local_path"],
                        disk["sha256"],
                        derived_from_id,
                        att.derived_format,
                        now,
                    ),
                )

            conn.commit()

            # 拼最终返回值：所有 filename → id（含 derived）
            id_map = dict(filename_to_id)
            # 重新查 derived 的 id
            if derived_queue:
                for idx, att, disk in derived_queue:
                    row = conn.execute(
                        """SELECT id FROM email_attachment
                           WHERE internal_id = ? AND filename = ?""",
                        (internal_id, disk["used_filename"]),
                    ).fetchone()
                    if row:
                        id_map[att.filename] = row["id"]

            # PR-2b: 把非 inline 附件登记为 'pending' 让 attachment_text worker
            # 抽 PDF / docx / pptx / xlsx 文本入 FTS5 索引. inline 图 (cid:) 跳过.
            # enqueue 失败 (lock 等) 仅 warning 不 raise — 主 commit 不阻塞;
            # CLI `mailagent attachment extract --include-missing` 可兜底补.
            for att in attachments:
                if att.is_inline:
                    continue
                att_id = id_map.get(att.filename)
                if att_id is None:
                    continue
                try:
                    conn.execute(
                        """INSERT OR IGNORE INTO email_attachment_text
                           (attachment_id, text_content, text_size_bytes, extractor,
                            status, retry_count, created_at, updated_at)
                           VALUES (?, NULL, 0, 'pending', 'pending', 0, ?, ?)""",
                        (att_id, now, now),
                    )
                except Exception as e:
                    logger.warning(
                        f"enqueue attachment_text extraction failed for "
                        f"att_id={att_id}: {e}"
                    )
            conn.commit()

            return id_map
        except Exception:
            conn.rollback()
            # 回滚事务后清理落盘文件
            for f in saved_files:
                try:
                    f.unlink(missing_ok=True)
                except OSError:
                    pass
            raise
        finally:
            conn.close()

    def update_notion_links(
        self,
        internal_id: int,
        *,
        page_id: Optional[str] = None,
        file_id_map: Optional[dict[int, str]] = None,
        block_id_map: Optional[dict[int, str]] = None,
    ) -> None:
        """Notion sync 完成后回写 file/block id 到 email_attachment.

        page_id 不写 email_body（Notion 的 page_id 已经在 email_metadata.notion_page_id），
        除非未来想冗余存。
        """
        if not file_id_map and not block_id_map:
            return
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            file_id_map = file_id_map or {}
            block_id_map = block_id_map or {}
            for att_id, file_id in file_id_map.items():
                conn.execute(
                    "UPDATE email_attachment SET notion_file_id = ? WHERE id = ?",
                    (file_id, att_id),
                )
            for att_id, block_id in block_id_map.items():
                conn.execute(
                    "UPDATE email_attachment SET notion_block_id = ? WHERE id = ?",
                    (block_id, att_id),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ============================================================
    # PIN (v8) — front-end "置顶" persistence
    # ============================================================

    def set_pin(self, internal_id: int, pinned: bool) -> Optional[bool]:
        """置顶 / 取消置顶。

        Returns:
            True/False — 新的置顶状态（成功）；
            None — 邮件不存在。
        """
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT is_pinned FROM email_metadata WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            if row is None:
                return None
            target = 1 if pinned else 0
            now = time.time()
            conn.execute(
                """UPDATE email_metadata
                      SET is_pinned = ?,
                          pinned_at = ?,
                          updated_at = ?
                    WHERE internal_id = ?""",
                (target, now if pinned else None, now, internal_id),
            )
            conn.commit()
            return bool(target)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def toggle_pin(self, internal_id: int) -> Optional[bool]:
        """翻转置顶状态。Returns 新状态 / None（邮件不存在）。"""
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT is_pinned FROM email_metadata WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            if row is None:
                return None
            new_state = not bool(row["is_pinned"])
        finally:
            conn.close()
        return self.set_pin(internal_id, new_state)

    def list_pinned_ids(self) -> list[int]:
        """所有置顶邮件的 internal_id（pinned_at DESC，最近置顶在前）。"""
        conn = self._connect()
        try:
            rows = conn.execute(
                """SELECT internal_id FROM email_metadata
                    WHERE is_pinned = 1
                    ORDER BY pinned_at DESC NULLS LAST, internal_id DESC"""
            ).fetchall()
            return [r["internal_id"] for r in rows]
        finally:
            conn.close()

    def delete_email_full(self, internal_id: int) -> None:
        """删除 email_metadata（CASCADE 触发 body + attachment）+ 本地附件目录."""
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            conn.execute(
                "DELETE FROM email_metadata WHERE internal_id = ?", (internal_id,)
            )
            conn.commit()
        finally:
            conn.close()
        self.attachment_store.delete_email_dir(internal_id)
