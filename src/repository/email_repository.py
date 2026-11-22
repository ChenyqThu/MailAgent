"""EmailRepository - SQLite SSoT 邮件读写入口（v4 架构）.

设计原则:
    - 只读方法返回 dataclass，禁止暴露 sqlite3.Row 给上层
    - commit_email_with_body 是事务，metadata + body + attachments 原子提交
    - 附件二进制读写经由 AttachmentStore 子模块（不直接操作文件系统）
    - 检索 / 附件文本 / 通讯录补全拆至同目录领域 Mixin，本模块维持单一门面与兼容再导出

详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md §5.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Optional, Sequence

from loguru import logger

from src.mail.mailbox_semantics import (
    DRAFT_LABEL_VARIANTS,
    filter_labels_for_mailbox,
    sql_in_predicate,
    sql_not_in_or_null,
)
from src.matters.resource_identity import parse_resource_key
from src.repository.attachment_store import AttachmentStore
from src.repository.cjk_bigram import (  # noqa: F401
    extract_cjk_bigrams,
    is_cjk_char as _is_cjk_char,
    is_pure_cjk_bigram,
)
from src.repository.email_attachment_text import _EmailAttachmentTextMixin
from src.repository.email_contacts import (  # noqa: F401
    _CONTACT_CACHE_TTL_SECONDS,
    _CONTACT_DIRECTORY_SQL,
    _CONTACT_DIRECTORY_TTL_SECONDS,
    _CONTACT_MERGED_CACHE,
    _CONTACT_SUGGEST_CACHE,
    _EmailContactsMixin,
    _build_contact_candidates,
    _contact_date_key,
    _history_candidate,
    _normalize_contact_name,
    _normalize_exclude,
    _parse_address_list,
    _parse_address_segment,
    _parse_name_variants,
)
from src.repository.email_models import (  # noqa: F401
    _FTS5_OPERATORS,
    _IN_CHUNK_SIZE,
    _RRF_FETCH_MAX,
    _RRF_FETCH_MIN_EXTRA,
    _RRF_FETCH_MULTIPLIER,
    _RRF_K,
    AttachmentPayload,
    AttachmentRecord,
    AttachmentSearchHit,
    AttachmentTextRecord,
    BodyPayload,
    ContactSuggestion,
    EmailBodyContentRecord,
    EmailBodyRecord,
    EmailFull,
    EmailMetadataRecord,
    EmailSearchHit,
    EmailSearchResult,
    ThreadAttachmentRecord,
    ThreadMember,
    _ContactCandidate,
    _MergedCandidate,
    _SearchLane,
    _TermRoute,
    _count_cjk_chars,
    _is_simple_natural_query,
    _quote_fts_token,
    _route_text_term,
    _wrap_token_cjk_aware,
    build_search_plan,
    build_trigram_snippet_expr,
    smart_query_transform,
)
from src.repository.email_search_fts import _EmailSearchFtsMixin
from src.repository.email_search_predicates import _EmailSearchPredicatesMixin
from src.repository.email_search_trigram import _EmailSearchTrigramMixin
from src.repository.search_query import FilterPredicate


class EmailRepository(
    _EmailContactsMixin,
    _EmailAttachmentTextMixin,
    _EmailSearchTrigramMixin,
    _EmailSearchPredicatesMixin,
    _EmailSearchFtsMixin,
):
    """SQLite SSoT 读写入口（v4 架构）."""

    def __init__(
        self,
        db_path: str = "data/sync_store.db",
        attachment_store: Optional[AttachmentStore] = None,
        *,
        trigram_enabled: Optional[bool] = None,
        latin_trigram_enabled: Optional[bool] = None,
    ):
        self.db_path = Path(db_path)
        self.attachment_store = attachment_store or AttachmentStore()
        # T7: CJK trigram 路由开关。None → 懒读 config.search_trigram_enabled
        # (默认 False; 读 config 失败/缺 env → False, 保证测试 / CLI 无 .env 也能起)。
        # 显式传 True/False → 测试 / caller 直控 (per-case trigram fixture 用)。
        self._trigram_enabled_override = trigram_enabled
        # PR2: 含 CJK 混合 query 中 >=3 字符拉丁 token 的双 lane 开关 (镜像上面的模式)。
        self._latin_trigram_enabled_override = latin_trigram_enabled
        # MED-2: AI 投影 schema 探测的实例级 memo (旧/裸/测试库可能无 llm_processing 表 /
        # email_metadata.ai_priority v14 列)。schema 进程内静态 (迁移在 init 时已跑完) →
        # 首次探测后缓存, 免每次搜索重查 sqlite_master / pragma。
        self._has_llm_processing: Optional[bool] = None
        self._has_ai_priority_col: Optional[bool] = None

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")  # CASCADE / SET NULL
        return conn

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

    def get_body_summary(self, internal_id: int) -> Optional[EmailBodyRecord]:
        """Read body metadata without loading either large content column."""
        conn = self._connect()
        try:
            row = conn.execute(
                """SELECT internal_id, message_id, body_format, body_size_bytes,
                          has_inline_images, raw_mime_sha256, fetched_at, fetched_source
                   FROM email_body WHERE internal_id = ?""",
                (internal_id,),
            ).fetchone()
            if not row:
                return None
            return EmailBodyRecord(
                internal_id=row["internal_id"],
                message_id=row["message_id"],
                html=None,
                markdown=None,
                body_format=row["body_format"] or "html",
                body_size_bytes=row["body_size_bytes"] or 0,
                has_inline_images=bool(row["has_inline_images"]),
                raw_mime_sha256=row["raw_mime_sha256"],
                fetched_at=row["fetched_at"],
                fetched_source=row["fetched_source"],
            )
        finally:
            conn.close()

    def get_body_content(
        self,
        internal_id: int,
        format_: str,
        *,
        max_chars: int = -1,
    ) -> Optional[EmailBodyContentRecord]:
        """Read exactly one requested content column, optionally as a SQL prefix."""
        columns = {
            "markdown": "body_markdown",
            "html": "body_html",
            "raw": "raw_mime_sha256",
        }
        column = columns.get(format_)
        if column is None:
            raise ValueError(f"unsupported body format: {format_!r}")
        expression = f"substr({column}, 1, ?)" if max_chars > 0 else column
        params = (max_chars, internal_id) if max_chars > 0 else (internal_id,)
        conn = self._connect()
        try:
            row = conn.execute(
                f"""SELECT internal_id, {expression} AS content, body_size_bytes,
                           fetched_at, fetched_source
                    FROM email_body WHERE internal_id = ?""",
                params,
            ).fetchone()
            if not row:
                return None
            return EmailBodyContentRecord(
                internal_id=row["internal_id"],
                content=row["content"],
                body_size_bytes=row["body_size_bytes"] or 0,
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

    def get_attachments_by_thread(
        self, thread_id: str
    ) -> list[ThreadAttachmentRecord]:
        """线程内全部附件（含各封邮件的归属上下文），供 chat agent 分层访问.

        单 SQL: email_attachment JOIN email_metadata ON internal_id WHERE
        thread_id=?，按 date_received ASC, attachment.id ASC 排序（时间正序 →
        agent 顺着线程读；同封邮件内按 attachment.id 稳定）。空 / 未知 thread_id →
        空 list。sender / subject COALESCE 成 ''（对齐 dataclass str 字段，与
        search_attachment_texts 一致）。
        """
        if not thread_id:
            return []
        conn = self._connect()
        try:
            rows = conn.execute(
                """SELECT a.id, a.internal_id, a.filename, a.content_type,
                          a.size_bytes, a.is_inline, a.content_id, a.sha256,
                          a.derived_from, a.derived_format, a.notion_file_id,
                          a.notion_block_id, a.created_at,
                          COALESCE(m.sender, '')  AS sender,
                          m.sender_name           AS sender_name,
                          m.date_received         AS date_received,
                          COALESCE(m.subject, '') AS email_subject
                     FROM email_attachment a
                     JOIN email_metadata m ON m.internal_id = a.internal_id
                    WHERE m.thread_id = ?
                    ORDER BY m.date_received ASC, a.id ASC""",
                (thread_id,),
            ).fetchall()
            return [
                ThreadAttachmentRecord(
                    id=r["id"],
                    internal_id=r["internal_id"],
                    filename=r["filename"],
                    content_type=r["content_type"],
                    size_bytes=r["size_bytes"],
                    is_inline=bool(r["is_inline"]),
                    content_id=r["content_id"],
                    sha256=r["sha256"],
                    derived_from=r["derived_from"],
                    derived_format=r["derived_format"],
                    notion_file_id=r["notion_file_id"],
                    notion_block_id=r["notion_block_id"],
                    created_at=r["created_at"],
                    sender=r["sender"],
                    sender_name=r["sender_name"],
                    date_received=r["date_received"],
                    email_subject=r["email_subject"],
                )
                for r in rows
            ]
        finally:
            conn.close()

    def get_attachment_record(self, attachment_id: int) -> Optional[AttachmentRecord]:
        """按 attachment.id 读单行 (compose attachment_id 引用装配需要 filename/
        content_type; 行→dataclass 映射与 get_attachments 一致)。"""
        conn = self._connect()
        try:
            r = conn.execute(
                """SELECT id, internal_id, filename, content_type, size_bytes,
                          is_inline, content_id, local_path, sha256,
                          derived_from, derived_format,
                          notion_file_id, notion_block_id, created_at
                   FROM email_attachment WHERE id = ?""",
                (attachment_id,),
            ).fetchone()
            if not r:
                return None
            return AttachmentRecord(
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

    def _matter_email_internal_ids(
        self, matter_id: int, *, allowed_only: bool = False
    ) -> list[int]:
        """matter 关联邮件集合展开（P3 引入）。

        ``allowed_only=False``（默认）= P3 manual chat 语义**字节级不变**（scope 过滤
        ≠ 访问控制的既有取舍，留痕不翻案，P6 复议）；``allowed_only=True`` = P4 run
        路径的访问控制维（仅 access_policy='allowed' 的资源 —— metadata_only 的正文
        在这里挡住，D5）。
        """
        conn = self._connect()
        try:
            sql = (
                "SELECT r.external_key FROM matter_resource mr "
                "JOIN resource r ON r.id=mr.resource_id "
                "WHERE mr.matter_id=? AND mr.deleted_at IS NULL "
                "AND r.provider='mailagent' AND r.kind IN ('email','thread')"
            )
            if allowed_only:
                sql += " AND r.access_policy='allowed'"
            rows = conn.execute(sql, (matter_id,)).fetchall()
            direct_ids: set[int] = set()
            thread_ids: set[str] = set()
            for row in rows:
                try:
                    kind, value = parse_resource_key(row["external_key"])
                except ValueError:
                    continue
                if kind == "email":
                    direct_ids.add(int(value))
                else:
                    thread_ids.add(value)
            if thread_ids:
                placeholders = ",".join("?" for _ in thread_ids)
                thread_rows = conn.execute(
                    f"SELECT internal_id FROM email_metadata WHERE thread_id IN ({placeholders})",
                    tuple(thread_ids),
                ).fetchall()
                direct_ids.update(int(row["internal_id"]) for row in thread_rows)
            return sorted(direct_ids)
        finally:
            conn.close()

    def matter_scope_contains(self, matter_id: int, internal_id: int) -> bool:
        """P4 headless 域守卫（D5）：internal_id 是否在 matter 的 **allowed** 关联集内
        （access_policy='allowed' 且关联未删；metadata_only/excluded 均不放行）。"""
        return internal_id in self._matter_email_internal_ids(
            matter_id, allowed_only=True
        )

    def _append_matter_filter(
        self, predicates: list[FilterPredicate], matter_id: Optional[int]
    ) -> None:
        if matter_id is None:
            return
        internal_ids = self._matter_email_internal_ids(matter_id)
        if not internal_ids:
            predicates.append(FilterPredicate("0"))
            return
        placeholders = ",".join("?" for _ in internal_ids)
        predicates.append(
            FilterPredicate(
                f"m.internal_id IN ({placeholders})", tuple(internal_ids)
            )
        )

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
        exclude_drafts: bool = False,
        limit: int = 50,
        offset: int = 0,
        matter_id: Optional[int] = None,
    ) -> dict:
        """CLI ``email list`` 用 — 返回 ``{total, limit, offset, emails: [EmailMetadataRecord, ...]}``.

        与 ``SyncStore.search_emails`` 的差异 (R-15 / PR-2 critic fix):
        - 不强制 ``sync_status IN ('synced', 'pending')``; 若 caller 传 ``status``
          就只过滤该 status, 否则不锁
        - 不把 limit 硬 cap 到 50; 上限走 ``LIST_LIMIT_MAX = 500``
          (与 CLI 公开契约一致, RFC §4.2)
        - SELECT 含 ``sync_status`` + ``thread_id``, CLI 能直接消费

        ``mailbox`` 按 `filter_labels_for_mailbox` 展开成变体集 IN 查 (内建 canonical
        禁止 `= ?` 精确匹配, 见 CLAUDE.md mailbox 语义单源纪律); 自定义文件夹名展开
        成单元素 = 精确匹配语义不变。``exclude_drafts=True`` 额外排除草稿行 (跨邮箱
        读面的 opt-in, 与 list-enriched 未指定 mailbox 时的默认排除同源同变体集)。
        """
        if limit <= 0:
            return {"total": 0, "limit": limit, "offset": offset, "emails": []}
        limit = min(limit, self.LIST_LIMIT_MAX)

        clauses: list[str] = []
        params: list = []
        if matter_id is not None:
            linked_ids = self._matter_email_internal_ids(matter_id)
            if not linked_ids:
                return {"total": 0, "limit": min(limit, self.LIST_LIMIT_MAX), "offset": offset, "emails": []}
            placeholders = ",".join("?" for _ in linked_ids)
            clauses.append(f"internal_id IN ({placeholders})")
            params.extend(linked_ids)
        if mailbox:
            predicate, vals = sql_in_predicate(
                "mailbox", filter_labels_for_mailbox(mailbox)
            )
            clauses.append(predicate)
            params.extend(vals)
        if exclude_drafts:
            clauses.append(sql_not_in_or_null("mailbox", DRAFT_LABEL_VARIANTS))
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
            conn.execute(
                "UPDATE email_metadata SET snippet = substr(?, 1, 100) WHERE internal_id = ?",
                (body.markdown, internal_id),
            )
            self._upsert_body_cjk2(conn, internal_id, body.markdown)

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

    def set_pin_many(
        self, internal_ids: Sequence[int], pinned: bool
    ) -> tuple[list[int], list[int]]:
        """批量置顶 / 取消置顶（线程级级联的写原语）。

        单条 ``UPDATE ... WHERE internal_id IN (...)`` —— 级联 unpin 整条线程时不许
        退化成 N 次往返（前端点一下要秒反应，见 ARCHITECTURE §7.1「批量优于扇出」）。

        Returns:
            (existing_ids, changed_ids) —— existing 是库里真有的行（差集即 not_found），
            changed 是本次 ``is_pinned`` 真变了的（调用方据此决定发不发 SSE）。
        """
        ids = [int(i) for i in internal_ids]
        if not ids:
            return [], []
        want = bool(pinned)   # 归一化一次, 下面的相等比较与 UPDATE 值同源
        conn = self._connect()
        try:
            placeholders = ", ".join("?" for _ in ids)
            rows = conn.execute(
                f"SELECT internal_id, is_pinned FROM email_metadata "
                f"WHERE internal_id IN ({placeholders})",
                ids,
            ).fetchall()
            existing = [r["internal_id"] for r in rows]
            changed = [r["internal_id"] for r in rows if bool(r["is_pinned"]) != want]
            if existing:
                target = 1 if want else 0
                now = time.time()
                exist_ph = ", ".join("?" for _ in existing)
                conn.execute(
                    f"""UPDATE email_metadata
                          SET is_pinned = ?,
                              pinned_at = ?,
                              updated_at = ?
                        WHERE internal_id IN ({exist_ph})""",
                    [target, now if want else None, now, *existing],
                )
            conn.commit()
            return existing, changed
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def list_flagged_thread_member_ids(
        self,
        thread_ids: Sequence[str],
        *,
        exclude_internal_ids: Sequence[int] = (),
    ) -> list[int]:
        """给定线程里**仍带旗标**的成员 internal_id（排除草稿箱 + 给定 id）。

        线程级「标完成」的级联摘旗用: 只碰真的还挂着旗的成员, 不去动别人的
        processing_status。草稿排除走 mailbox 语义单源 (禁字面量比较)。
        """
        return self._list_thread_member_ids(
            thread_ids, "is_flagged = 1", exclude_internal_ids
        )

    def list_pinned_thread_member_ids(
        self,
        thread_ids: Sequence[str],
        *,
        exclude_internal_ids: Sequence[int] = (),
    ) -> list[int]:
        """给定线程里**仍置顶**的成员 internal_id（排除草稿箱 + 给定 id）。"""
        return self._list_thread_member_ids(
            thread_ids, "is_pinned = 1", exclude_internal_ids
        )

    def _list_thread_member_ids(
        self,
        thread_ids: Sequence[str],
        predicate_sql: str,
        exclude_internal_ids: Sequence[int],
    ) -> list[int]:
        """两个级联展开的共享体。``predicate_sql`` 恒为本模块内的字面量常量（无注入面）。"""
        # 去重: 批量 primary 常常同线程, 重复 thread_id 只会白撑 IN 占位符。
        tids = list(dict.fromkeys(t for t in thread_ids if t))
        if not tids:
            return []
        conn = self._connect()
        try:
            tid_ph = ", ".join("?" for _ in tids)
            sql = (
                f"SELECT internal_id FROM email_metadata "
                f"WHERE thread_id IN ({tid_ph}) AND {predicate_sql} "
                f"AND {sql_not_in_or_null('mailbox', DRAFT_LABEL_VARIANTS)}"
            )
            params: list = list(tids)
            excl = [int(i) for i in exclude_internal_ids]
            if excl:
                excl_ph = ", ".join("?" for _ in excl)
                sql += f" AND internal_id NOT IN ({excl_ph})"
                params.extend(excl)
            sql += " ORDER BY internal_id"
            return [r["internal_id"] for r in conn.execute(sql, params).fetchall()]
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

    def delete_email_full_if_status(
        self, internal_id: int, expected_status: str
    ) -> bool:
        """带 sync_status 谓词的 delete_email_full 变体: 仅当行仍是 expected_status 才删。

        消除 AdminService.delete_dead_letter 的 TOCTOU —— SELECT status(连接 A) 与删除
        (连接 B) 之间, 并发 admin 面若把该行 retry 成 pending/synced, 通用
        delete_email_full 会删掉一封刚复活的真邮件。把状态判定并入删除事务的 WHERE 谓词,
        rowcount==0 = 状态在窗口内已变 → 不删, 返回 False。CASCADE + 附件目录清理与
        delete_email_full 一致(仅当确实删了才清附件目录)。

        Returns:
            True  行已删除(+ 附件目录已清)
            False 行不存在或 sync_status 已变(未删任何东西)
        """
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            cur = conn.execute(
                "DELETE FROM email_metadata WHERE internal_id = ? AND sync_status = ?",
                (internal_id, expected_status),
            )
            deleted = cur.rowcount == 1
            conn.commit()
        finally:
            conn.close()
        if deleted:
            self.attachment_store.delete_email_dir(internal_id)
        return deleted
