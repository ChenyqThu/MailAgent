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


__all__ = ["AttachmentItem"]
