"""Pydantic response schemas for `/api/history-sync*` endpoints."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class HistorySyncCountsDto(BaseModel):
    scanned: int
    existing: int
    added: int
    processed: int
    notion_synced: int
    local_only: int
    failed: int
    empty_msgid: int


class HistorySyncJobDto(BaseModel):
    job_id: int
    status: str
    phase: str
    since: str
    until: str
    counts: HistorySyncCountsDto
    progress_done: int
    progress_total: int
    complete: bool
    covered_from: Optional[str] = None
    cancel_requested: bool
    started_at: float
    finished_at: Optional[float] = None
    updated_at: float
    last_error: Optional[str] = None


class HistorySyncDefaultsDto(BaseModel):
    since: str
    until: str


class HistorySyncStateResponse(BaseModel):
    supported: bool
    unsupported_reason: Optional[str] = None
    backend: str
    defaults: HistorySyncDefaultsDto
    max_days: int
    notion_enabled: bool
    notion_floor: Optional[str] = None
    job: Optional[HistorySyncJobDto] = None


class HistorySyncStartResponse(BaseModel):
    job_id: int
    was_created: bool


class HistorySyncCancelResponse(BaseModel):
    job_id: int
    cancel_requested: bool


__all__ = [
    "HistorySyncCountsDto",
    "HistorySyncJobDto",
    "HistorySyncDefaultsDto",
    "HistorySyncStateResponse",
    "HistorySyncStartResponse",
    "HistorySyncCancelResponse",
]
