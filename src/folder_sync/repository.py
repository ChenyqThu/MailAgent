"""FolderEmailRepository — folder_email / folder_sync_state 表的 CRUD.

对标 src/calendar_sync/repository.py: 给 worker / CLI / IPC handler 统一读写入口.
只做 SQLite, 不调 IMAP (那是 FolderImapReader 的事).

DB schema 见 src/mail/sync_store.py DB_VERSION=17 folder_email 注释.
date_received 存 TEXT (ISO 8601), 跟 email_metadata 一致, 排序用字符串序 (ISO 可排序).
"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Iterator, Optional

from loguru import logger

_VALID_FOLDERS = frozenset({"archive", "drafts"})


@dataclass
class FolderEmailRow:
    """folder_email 表一行的内存表示. attachments 已 JSON-decode."""

    id: int
    folder: str
    imap_uidvalidity: Optional[int]
    imap_uid: Optional[int]
    message_id: Optional[str]
    thread_id: Optional[str]
    subject: Optional[str]
    sender: Optional[str]
    sender_name: Optional[str]
    to_addr: Optional[str]
    cc_addr: Optional[str]
    date_received: Optional[str]
    is_flagged: bool
    has_attachments: bool
    snippet: Optional[str]
    attachments: list[dict] = field(default_factory=list)
    raw_mime_sha256: Optional[str] = None
    body_html: Optional[str] = None
    body_markdown: Optional[str] = None
    synced_at: Optional[float] = None
    created_at: Optional[float] = None
    updated_at: Optional[float] = None
    deleted_at: Optional[float] = None


@dataclass
class FolderSyncStateRow:
    """folder_sync_state 表一行 (per-folder IMAP sync 游标)."""

    folder: str
    imap_uidvalidity: Optional[int] = None
    last_uidnext: Optional[int] = None
    last_full_sync_at: Optional[float] = None
    last_incremental_sync_at: Optional[float] = None
    last_error: Optional[str] = None


# 列表投影 (不含 body_html / body_markdown, 减少传输; 列表用 snippet 预览)
_BASE_COLS = [
    "id", "folder", "imap_uidvalidity", "imap_uid", "message_id", "thread_id",
    "subject", "sender", "sender_name", "to_addr", "cc_addr", "date_received",
    "is_flagged", "has_attachments", "snippet", "attachments_json",
    "raw_mime_sha256", "synced_at", "created_at", "updated_at", "deleted_at",
]
_LIST_COLS = ", ".join(_BASE_COLS)
_FULL_COLS = ", ".join(_BASE_COLS + ["body_html", "body_markdown"])


def _row_to_dataclass(row: sqlite3.Row) -> FolderEmailRow:
    keys = set(row.keys())
    atts: list[dict] = []
    aj = row["attachments_json"] if "attachments_json" in keys else None
    if aj:
        try:
            atts = json.loads(aj)
        except Exception:
            atts = []
    return FolderEmailRow(
        id=row["id"],
        folder=row["folder"],
        imap_uidvalidity=row["imap_uidvalidity"],
        imap_uid=row["imap_uid"],
        message_id=row["message_id"],
        thread_id=row["thread_id"],
        subject=row["subject"],
        sender=row["sender"],
        sender_name=row["sender_name"],
        to_addr=row["to_addr"],
        cc_addr=row["cc_addr"],
        date_received=row["date_received"],
        is_flagged=bool(row["is_flagged"]),
        has_attachments=bool(row["has_attachments"]),
        snippet=row["snippet"],
        attachments=atts,
        raw_mime_sha256=row["raw_mime_sha256"],
        body_html=row["body_html"] if "body_html" in keys else None,
        body_markdown=row["body_markdown"] if "body_markdown" in keys else None,
        synced_at=row["synced_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        deleted_at=row["deleted_at"],
    )


class FolderEmailRepository:
    """folder_email / folder_sync_state 表 CRUD (短连接 + WAL)."""

    def __init__(self, db_path: str = "data/sync_store.db"):
        self.db_path = str(db_path)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
        finally:
            conn.close()

    # --- 写 ---

    def upsert_emails(self, rows: list[dict]) -> dict:
        """批量 upsert (folder, imap_uidvalidity, imap_uid) 唯一. 复活软删除行 (deleted_at=NULL).

        Returns: {"inserted": N, "updated": M}.
        """
        if not rows:
            return {"inserted": 0, "updated": 0}
        now = time.time()
        inserted = updated = 0
        with self._connect() as conn:
            for r in rows:
                folder = r["folder"]
                if folder not in _VALID_FOLDERS:
                    raise ValueError(f"invalid folder {folder!r}")
                existing = conn.execute(
                    "SELECT id FROM folder_email "
                    "WHERE folder=? AND imap_uidvalidity IS ? AND imap_uid=?",
                    (folder, r.get("imap_uidvalidity"), r.get("imap_uid")),
                ).fetchone()
                vals = (
                    r.get("message_id"), r.get("thread_id"), r.get("subject"),
                    r.get("sender"), r.get("sender_name"), r.get("to_addr"),
                    r.get("cc_addr"), r.get("date_received"),
                    int(r.get("is_flagged") or 0), int(r.get("has_attachments") or 0),
                    r.get("body_html"), r.get("body_markdown"), r.get("snippet"),
                    r.get("attachments_json"), r.get("raw_mime_sha256"), now,
                )
                if existing:
                    conn.execute(
                        "UPDATE folder_email SET "
                        "message_id=?, thread_id=?, subject=?, sender=?, sender_name=?, "
                        "to_addr=?, cc_addr=?, date_received=?, is_flagged=?, has_attachments=?, "
                        "body_html=?, body_markdown=?, snippet=?, attachments_json=?, "
                        "raw_mime_sha256=?, synced_at=?, updated_at=?, deleted_at=NULL "
                        "WHERE id=?",
                        (*vals, now, existing["id"]),
                    )
                    updated += 1
                else:
                    conn.execute(
                        "INSERT INTO folder_email("
                        "folder, imap_uidvalidity, imap_uid, message_id, thread_id, subject, "
                        "sender, sender_name, to_addr, cc_addr, date_received, is_flagged, "
                        "has_attachments, body_html, body_markdown, snippet, attachments_json, "
                        "raw_mime_sha256, synced_at, created_at, updated_at) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            folder, r.get("imap_uidvalidity"), r.get("imap_uid"),
                            r.get("message_id"), r.get("thread_id"), r.get("subject"),
                            r.get("sender"), r.get("sender_name"), r.get("to_addr"),
                            r.get("cc_addr"), r.get("date_received"),
                            int(r.get("is_flagged") or 0), int(r.get("has_attachments") or 0),
                            r.get("body_html"), r.get("body_markdown"), r.get("snippet"),
                            r.get("attachments_json"), r.get("raw_mime_sha256"),
                            now, now, now,
                        ),
                    )
                    inserted += 1
            conn.commit()
        return {"inserted": inserted, "updated": updated}

    def soft_delete(self, id: int) -> bool:
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE folder_email SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
                (time.time(), time.time(), id),
            )
            conn.commit()
            return cur.rowcount > 0

    def soft_delete_by_uids(self, folder: str, uids: list[int]) -> int:
        """把 folder 内指定 uid 标软删除 (reconcile 用). 返回标记行数."""
        if not uids:
            return 0
        now = time.time()
        with self._connect() as conn:
            placeholders = ",".join("?" * len(uids))
            cur = conn.execute(
                f"UPDATE folder_email SET deleted_at=?, updated_at=? "
                f"WHERE folder=? AND deleted_at IS NULL AND imap_uid IN ({placeholders})",
                (now, now, folder, *uids),
            )
            conn.commit()
            return cur.rowcount

    def hard_delete(self, id: int) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM folder_email WHERE id=?", (id,))
            conn.commit()
            return cur.rowcount > 0

    def hard_delete_by_uid(self, folder: str, uid: int) -> bool:
        """物理删除 (草稿发送/删除后 IMAP 端已没了, 本地也清掉, 不留软删除残影)."""
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM folder_email WHERE folder=? AND imap_uid=?", (folder, uid)
            )
            conn.commit()
            return cur.rowcount > 0

    # --- 读 ---

    def list(self, folder: str, *, limit: int = 200, offset: int = 0) -> list[FolderEmailRow]:
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT {_LIST_COLS} FROM folder_email "
                f"WHERE folder=? AND deleted_at IS NULL "
                f"ORDER BY date_received DESC, id DESC LIMIT ? OFFSET ?",
                (folder, limit, offset),
            ).fetchall()
        return [_row_to_dataclass(r) for r in rows]

    def get(self, id: int) -> Optional[FolderEmailRow]:
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT {_FULL_COLS} FROM folder_email WHERE id=?", (id,)
            ).fetchone()
        return _row_to_dataclass(row) if row else None

    def get_by_uid(self, folder: str, imap_uid: int) -> Optional[FolderEmailRow]:
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT {_FULL_COLS} FROM folder_email "
                f"WHERE folder=? AND imap_uid=? AND deleted_at IS NULL",
                (folder, imap_uid),
            ).fetchone()
        return _row_to_dataclass(row) if row else None

    def get_active_uids(self, folder: str) -> set[int]:
        """folder 内未软删除的 imap_uid 集合 (reconcile diff 用)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT imap_uid FROM folder_email WHERE folder=? AND deleted_at IS NULL",
                (folder,),
            ).fetchall()
        return {r["imap_uid"] for r in rows if r["imap_uid"] is not None}

    def count(self, folder: str, *, include_deleted: bool = False) -> int:
        sql = "SELECT COUNT(*) AS n FROM folder_email WHERE folder=?"
        if not include_deleted:
            sql += " AND deleted_at IS NULL"
        with self._connect() as conn:
            return conn.execute(sql, (folder,)).fetchone()["n"]

    def search_fts(
        self, query: str, *, folder: Optional[str] = None, limit: int = 50
    ) -> list[FolderEmailRow]:
        """FTS5 MATCH 搜索 (raw FTS5 语法; smart CJK wrapper 由 caller 预处理).

        bm25 rank 升序 (越小越相关). 跳过软删除行.
        """
        sql = (
            "SELECT fe.* FROM folder_email fe "
            "JOIN folder_email_fts f ON fe.id = f.rowid "
            "WHERE folder_email_fts MATCH ? AND fe.deleted_at IS NULL"
        )
        params: list = [query]
        if folder:
            sql += " AND fe.folder = ?"
            params.append(folder)
        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
        return [_row_to_dataclass(r) for r in rows]

    # --- sync_state ---

    def upsert_sync_state(self, folder: str, **fields) -> None:
        """更新 folder_sync_state 的指定字段 (None 字段不动). 不存在则插入."""
        allowed = {
            "imap_uidvalidity", "last_uidnext", "last_full_sync_at",
            "last_incremental_sync_at", "last_error",
        }
        sets = {k: v for k, v in fields.items() if k in allowed}
        with self._connect() as conn:
            exists = conn.execute(
                "SELECT 1 FROM folder_sync_state WHERE folder=?", (folder,)
            ).fetchone()
            if exists:
                if sets:
                    cols = ", ".join(f"{k}=?" for k in sets)
                    conn.execute(
                        f"UPDATE folder_sync_state SET {cols} WHERE folder=?",
                        (*sets.values(), folder),
                    )
            else:
                cols = ["folder"] + list(sets.keys())
                conn.execute(
                    f"INSERT INTO folder_sync_state({', '.join(cols)}) "
                    f"VALUES ({', '.join('?' * len(cols))})",
                    (folder, *sets.values()),
                )
            conn.commit()

    def get_sync_state(self, folder: str) -> Optional[FolderSyncStateRow]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT folder, imap_uidvalidity, last_uidnext, last_full_sync_at, "
                "last_incremental_sync_at, last_error FROM folder_sync_state WHERE folder=?",
                (folder,),
            ).fetchone()
        if not row:
            return None
        return FolderSyncStateRow(
            folder=row["folder"],
            imap_uidvalidity=row["imap_uidvalidity"],
            last_uidnext=row["last_uidnext"],
            last_full_sync_at=row["last_full_sync_at"],
            last_incremental_sync_at=row["last_incremental_sync_at"],
            last_error=row["last_error"],
        )

    def list_sync_states(self) -> list[FolderSyncStateRow]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT folder, imap_uidvalidity, last_uidnext, last_full_sync_at, "
                "last_incremental_sync_at, last_error FROM folder_sync_state"
            ).fetchall()
        return [
            FolderSyncStateRow(
                folder=r["folder"], imap_uidvalidity=r["imap_uidvalidity"],
                last_uidnext=r["last_uidnext"], last_full_sync_at=r["last_full_sync_at"],
                last_incremental_sync_at=r["last_incremental_sync_at"], last_error=r["last_error"],
            )
            for r in rows
        ]
