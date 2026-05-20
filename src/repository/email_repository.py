"""EmailRepository - SQLite SSoT 邮件读写入口（v4 架构）.

设计原则:
    - 只读方法返回 dataclass，禁止暴露 sqlite3.Row 给上层
    - commit_email_with_body 是事务，metadata + body + attachments 原子提交
    - 附件二进制读写经由 AttachmentStore 子模块（不直接操作文件系统）

详见 docs/architecture_v4_sqlite_ssot.md §5.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from loguru import logger

from src.repository.attachment_store import AttachmentStore


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
        """FTS5 全文搜索邮件正文 + subject + sender.

        Args:
            query: FTS5 query 语法 —— 短语用引号，AND/OR/NOT 大写，前缀用 `term*`。
                示例：'"project plan"', 'redis AND timeout', 'meeting NOT canceled'
            limit: 最多返回多少条（caller 责任 cap，repo 不再约束上限）
            mailbox: 仅返回该 mailbox 的邮件（'收件箱' / '发件箱'）
            since_date / until_date: 'YYYY-MM-DD'，按 email_metadata.date_received 过滤；
                date_received 是 ISO 字符串，字典序与时间序一致，直接 `>=` / `<=`

        Returns:
            EmailSearchHit list，按 bm25 升序（最相关在前）。
            空查询 / 无命中 / FTS 语法错误均返回 []（语法错误会 logger.warning）。
        """
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
                # FTS5 query 语法错误（unbalanced quote / lone operator 等）
                logger.warning(f"search_email_bodies: invalid FTS5 query {query!r}: {e}")
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
