"""Admin endpoint response models.

Covers admin.{health,stats,deadLetterList,deadLetterRetry,cleanupDeadLetter,
davmailHealth,systemAlerts}. health/stats/dead-letter mirror the cli-schema
shapes; davmailHealth/systemAlerts have NO CLI command and are built by the
router from a direct read of the sync_state `davmail.*` keys (meta.source still
'sqlite').
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# --- admin health -----------------------------------------------------------
class AdminHealthData(BaseModel):
    """`GET /api/admin/health` (admin-health.schema.json). Alias: AdminHealthData."""

    model_config = {"extra": "allow"}

    db_path: str
    db_accessible: bool
    db_version: Optional[int] = None
    db_version_expected: int
    schema_ok: bool
    tables_present: list[str]
    tables_missing: list[str]
    healthy: bool
    error: Optional[str] = None
    # E4 WP1/WP2: worker 心跳 (sync_state 'worker.%') + davmail 摘要 + 动态提示行。
    workers: Optional[dict[str, Any]] = None
    davmail: Optional[dict[str, Any]] = None
    notes: Optional[list[str]] = None


# --- admin stats ------------------------------------------------------------
class SyncStoreSection(BaseModel):
    """sync_store section of admin stats (admin-stats.schema.json)."""

    model_config = {"extra": "allow"}

    total_emails: int = Field(..., ge=0)
    by_status: dict[str, int]
    by_mailbox: Optional[dict[str, int]] = None
    failure_queue: Optional[int] = None
    last_max_row_id: Optional[int] = None
    last_sync_time: Optional[str] = None
    db_size_mb: float = Field(..., ge=0)
    db_size_bytes: Optional[int] = None


class AdminStatsData(BaseModel):
    """`GET /api/admin/stats` (admin-stats.schema.json). Alias: AdminStatsData.

    `data` is `additionalProperties:true` in the schema — most sections are
    loose `_source`-tagged bags, so we keep extra=allow and only type the
    sync_store section that's guaranteed live_query.
    """

    model_config = {"extra": "allow"}

    watcher: Optional[dict[str, Any]] = None
    sync_store: Optional[SyncStoreSection] = None
    handlers: Optional[dict[str, Any]] = None
    v4_rollout: Optional[dict[str, Any]] = None


# --- dead letter ------------------------------------------------------------
class DeadLetterItem(BaseModel):
    """One `GET /api/admin/dead-letter` row.

    Frontend `DeadLetterItem` is RICHER than the CLI list schema
    (admin-dead-letter.schema.json list item) — it adds `date_received`,
    `sync_status`, `sync_error`. The CLI list item has `last_error`/`updated_at`
    (number). The router should join the missing columns (or the frontend
    degrades). extra=allow tolerates either source.
    """

    model_config = {"extra": "allow"}

    internal_id: int
    mailbox: Optional[str] = None
    subject: Optional[str] = None
    sender: Optional[str] = None
    date_received: Optional[str] = None
    retry_count: Optional[int] = None
    sync_status: Optional[str] = None
    sync_error: Optional[str] = None
    # CLI-native fields (present when sourced straight from the CLI list).
    last_error: Optional[str] = None
    updated_at: Optional[Any] = None  # number (epoch) from CLI or ISO str from join


class DeadLetterRetryResult(BaseModel):
    """`POST /api/admin/dead-letter/{id}/retry` (admin-dead-letter retry_success)."""

    model_config = {"extra": "allow"}

    internal_id: int
    old_status: str
    new_status: str


class CleanupDeadLetterResult(BaseModel):
    """`POST /api/admin/cleanup-dead-letter` — loose CLI data passthrough."""

    model_config = {"extra": "allow"}


# --- davmail health (direct sync_state read, no CLI) ------------------------
DavMailLevel = Literal["ok", "warning", "critical", "unknown"]


class DavMailHealthData(BaseModel):
    """`GET /api/admin/davmail-health` (frontend DavMailHealthData).

    Built by the router from sync_state `davmail.*` keys (DavMailWatchdog writes
    them every 60s). `enabled=false` when no watchdog ticks (non-davmail mode).
    """

    model_config = {"extra": "allow"}

    enabled: bool
    level: DavMailLevel
    last_probe_at: Optional[str] = None
    imap_reachable: bool
    smtp_reachable: bool
    consecutive_imap_failures: int
    consecutive_smtp_failures: int
    token_age_days: Optional[float] = None
    token_mtime_iso: Optional[str] = None
    throttle_events_5min: int
    last_oauth_error: Optional[str] = None
    last_oauth_error_at: Optional[str] = None
    uid_backfill_paused: bool


# --- system alerts ----------------------------------------------------------
class SystemAlertItem(BaseModel):
    """One active system alert (frontend SystemAlertItem)."""

    level: Literal["critical", "warning", "info"]
    source: str
    title: str
    message: str
    ts: Optional[str] = None


class SystemAlertsData(BaseModel):
    """`GET /api/admin/system-alerts` (frontend SystemAlertsData)."""

    alerts: list[SystemAlertItem]
    critical_count: int
    warning_count: int
    generated_at: str  # server-side ISO timestamp


__all__ = [
    "AdminHealthData", "SyncStoreSection", "AdminStatsData",
    "DeadLetterItem", "DeadLetterRetryResult", "CleanupDeadLetterResult",
    "DavMailLevel", "DavMailHealthData",
    "SystemAlertItem", "SystemAlertsData",
]
