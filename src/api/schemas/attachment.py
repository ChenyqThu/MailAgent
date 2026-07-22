"""Attachment endpoint response models.

CRITICAL SECURITY INVARIANT: the wire shape NEVER includes `local_path`.
repo.get_attachments() returns an absolute host filesystem path (`local_path`)
that must be stripped from every response — attachment-list.schema.json already
omits it. The router builds AttachmentItem from the repo record's fields,
dropping local_path. Path-traversal is independently guarded inside
AttachmentStore (local_path must live under data/attachments/), but the API must
not echo host paths to a remote client regardless.

The download / inline endpoints stream raw bytes (StreamingResponse) and have no
JSON body, so there is no response model for them here — only the metadata list.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class AttachmentItem(BaseModel):
    """One row of `GET /api/attachment/list/{internal_id}`.

    Matches attachment-list.schema.json attachment_item. Frontend alias:
    `AttachmentMeta`. `local_path` is intentionally absent (see module docstring).
    Order produced by repo.get_attachments: is_inline DESC, id ASC.
    """

    id: int = Field(..., ge=0)
    internal_id: int = Field(..., ge=0)
    filename: str
    size_bytes: Optional[int] = None
    content_type: Optional[str] = None
    is_inline: bool
    content_id: Optional[str] = None
    sha256: Optional[str] = None
    derived_from: Optional[int] = None
    derived_format: Optional[str] = None
    notion_file_id: Optional[str] = None
    notion_block_id: Optional[str] = None


class ThreadAttachmentItem(BaseModel):
    """One row of `GET /api/attachment/thread/{thread_id}`.

    The minimal metadata face for the chat agent's *thread-level* attachment
    listing: attachment identity + size/type + `is_inline` (so the caller can
    filter inline cid: images out) + the owning email's attribution
    (`internal_id` / `sender` / `sender_name` / `date_received` / `email_subject`).

    Deliberately excludes `local_path` (module-level security invariant), plus
    `sha256` / `notion_*` / `derived_*` — those are storage/mirror internals the
    agent has no use for. `local_path` is NEVER on the wire (see module docstring).
    """

    id: int = Field(..., ge=0)
    internal_id: int = Field(..., ge=0)
    filename: str
    size_bytes: Optional[int] = None
    content_type: Optional[str] = None
    is_inline: bool
    sender: str
    sender_name: Optional[str] = None
    date_received: Optional[str] = None
    email_subject: str


class AttachmentTextResponse(BaseModel):
    """Body of `GET /api/attachment/{attachment_id}/text`.

    On-demand extracted plaintext of one attachment (PDF/docx/pptx/xlsx/txt…).
    `status` ∈ {extracted, pending, failed, unsupported}; `text_content` is only
    populated when `status == 'extracted'`, otherwise null with a one-line
    actionable `hint`. `truncated` merges the extractor's own 256 KB cap with any
    caller-supplied `max_chars` clip (either → true). `local_path` is NEVER on the
    wire (see module docstring); this response carries no host path.
    """

    attachment_id: int = Field(..., ge=0)
    internal_id: int = Field(..., ge=0)
    filename: str
    status: str
    text_content: Optional[str] = None
    truncated: bool = False
    extractor: Optional[str] = None
    email_subject: str
    sender: str
    hint: Optional[str] = None


__all__ = ["AttachmentItem", "ThreadAttachmentItem", "AttachmentTextResponse"]
