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
            {filename_or_derived_key: attachment_id} —— 上层 Notion uploader
            上传后用这个 map 把 notion_file_id 回写过来。

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
