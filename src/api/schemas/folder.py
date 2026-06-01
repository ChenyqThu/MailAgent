"""Folder READ endpoint response models (folder.{list,get,search,syncStatus}).

Folder reads have NO cli-schema and NO EmailRepository backing — `folder_email`
is a SEPARATE table (DB v17). These shapes are sourced from the frontend
`shared/api/types.ts` (FolderEmailMeta / FolderEmailDetail / FolderSearchResult /
FolderSyncStatusResult). The router backs them with a direct-SQLite read on
folder_email / folder_email_fts (cleaner than subprocessing `mailagent folder
…`, which would hit the davmail-only FolderImapReader gate even for pure reads).

Folder WRITES (syncNow/deleteMsg/move/sendDraft/createDraft/editDraft) are
out-of-scope reductions for the MVP — not modeled here.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

FolderName = Literal["archive", "drafts"]


class FolderAttachmentMeta(BaseModel):
    """Folder email attachment summary (frontend FolderAttachmentMeta).

    NOTE the field names differ from the main AttachmentItem: folder uses
    `size` (not `size_bytes`) and has no id/sha256 — it's a lighter display-only
    shape. No host path is exposed.
    """

    filename: str
    size: int
    content_type: str


class FolderEmailMeta(BaseModel):
    """`GET /api/folder/list` row (frontend FolderEmailMeta) — no body."""

    id: int
    folder: FolderName
    imap_uid: int
    imap_uidvalidity: int
    message_id: Optional[str] = None
    thread_id: Optional[str] = None
    subject: str
    sender: str
    sender_name: Optional[str] = None
    to_addr: str
    cc_addr: str
    date_received: Optional[str] = None
    is_flagged: bool
    has_attachments: bool
    snippet: Optional[str] = None
    attachments: list[FolderAttachmentMeta] = Field(default_factory=list)


class FolderEmailDetail(FolderEmailMeta):
    """`GET /api/folder/get/{id}` (frontend FolderEmailDetail) — meta + body."""

    body_html: Optional[str] = None
    body_markdown: Optional[str] = None


class FolderSearchResult(BaseModel):
    """`GET /api/folder/search` data (frontend FolderSearchResult).

    `transformed_query` is the CJK-aware rewrite (null when raw / unchanged).
    `hits` are meta rows (no body).
    """

    query: str
    transformed_query: Optional[str] = None
    total_hits: int
    hits: list[FolderEmailMeta]


class FolderSyncStateItem(BaseModel):
    """One folder_sync_state row (frontend FolderSyncStateItem)."""

    folder: str
    imap_uidvalidity: Optional[int] = None
    last_uidnext: Optional[int] = None
    last_full_sync_at: Optional[float] = None
    last_incremental_sync_at: Optional[float] = None
    last_error: Optional[str] = None


class FolderSyncStatusResult(BaseModel):
    """`GET /api/folder/sync-status` data (frontend FolderSyncStatusResult)."""

    states: list[FolderSyncStateItem]
    counts: dict[str, int]


__all__ = [
    "FolderName", "FolderAttachmentMeta",
    "FolderEmailMeta", "FolderEmailDetail",
    "FolderSearchResult",
    "FolderSyncStateItem", "FolderSyncStatusResult",
]
