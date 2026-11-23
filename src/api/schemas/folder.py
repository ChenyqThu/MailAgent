"""Pydantic response schemas for `/api/folder/*` endpoints."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class FolderDiscoverItemDto(BaseModel):
    """Flat folder entry returned by `GET /api/folder/discover`."""

    imap_name: str
    display_name: str
    delimiter: str
    special_use: Optional[str] = None
    is_system: bool
    has_children: bool
    parent: Optional[str] = None
    message_count: Optional[int] = None
    is_synced: bool


class FolderTreeNodeDto(BaseModel):
    """Nested folder tree node returned by `GET /api/folder/discover`."""

    imap_name: str
    display_name: str
    delimiter: str
    special_use: Optional[str] = None
    is_system: bool
    has_children: bool
    parent: Optional[str] = None
    message_count: Optional[int] = None
    children: list[FolderTreeNodeDto] = Field(default_factory=list)


FolderTreeNodeDto.model_rebuild()


class FolderDiscoverResponse(BaseModel):
    folders: list[FolderDiscoverItemDto]
    tree: list[FolderTreeNodeDto]
    whitelist: list[str]


class FolderWhitelistResponse(BaseModel):
    folders: list[str]


class FolderWhitelistUpdateResponse(BaseModel):
    folders: list[str]
    restart_required: bool


class FolderCreateResponse(BaseModel):
    action: str
    imap_name: str


class FolderMutationResponse(BaseModel):
    action: str
    imap_name: str
    new_imap_name: Optional[str] = None
    affected_local_rows: int = 0
    restart_required: bool = False


class FolderPrefItemDto(BaseModel):
    imap_name: str
    mailbox_label: str
    icon: Optional[str] = None
    notify_enabled: bool
    llm_disabled: bool
    updated_at: float


class FolderPrefsListResponse(BaseModel):
    prefs: list[FolderPrefItemDto]


__all__ = [
    "FolderDiscoverItemDto",
    "FolderTreeNodeDto",
    "FolderDiscoverResponse",
    "FolderWhitelistResponse",
    "FolderWhitelistUpdateResponse",
    "FolderCreateResponse",
    "FolderMutationResponse",
    "FolderPrefItemDto",
    "FolderPrefsListResponse",
]
