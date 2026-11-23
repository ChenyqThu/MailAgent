"""Read-only SQLite query helpers for ``src/api/routers/admin.py``.

Keeps raw SQL out of FastAPI routers while preserving strict read-only semantics
(never instantiates ``SyncStore`` / never triggers schema migrations on GET).
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Optional


def read_health_snapshot(db_path: str) -> dict[str, Any]:
    """Read raw DB version, table list, worker rows, boot history, and davmail keys."""
    db_accessible = False
    db_version: Optional[int] = None
    tables_present: list[str] = []
    worker_rows: list[Any] = []
    boot_history_raw: Optional[str] = None
    davmail_rows: list[tuple[Any, Any]] = []
    error_message: Optional[str] = None

    try:
        if not Path(db_path).exists():
            raise FileNotFoundError
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            db_accessible = True
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            ).fetchone()
            if row:
                try:
                    db_version = int(row[0])
                except (TypeError, ValueError):
                    db_version = None
            tables_present = [
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
                ).fetchall()
            ]
            try:
                worker_rows = conn.execute(
                    "SELECT key, value FROM sync_state WHERE key LIKE 'worker.%'"
                ).fetchall()
                boot_row = conn.execute(
                    "SELECT value FROM sync_state WHERE key='service.start_history'"
                ).fetchone()
                boot_history_raw = boot_row[0] if boot_row else None
                davmail_rows = [
                    (r[0], r[1])
                    for r in conn.execute(
                        "SELECT key, value FROM sync_state WHERE key IN "
                        "('davmail.last_probe_at', 'davmail.token_age_days', "
                        "'davmail.imap_reachable', 'davmail.auth.expires_at')"
                    ).fetchall()
                ]
            except sqlite3.Error:
                worker_rows = []
                boot_history_raw = None
                davmail_rows = []
        finally:
            conn.close()
    except FileNotFoundError:
        error_message = "database file not found"
    except Exception as exc:  # noqa: BLE001 — diagnostic redaction: class name only
        error_message = type(exc).__name__

    return {
        "db_accessible": db_accessible,
        "db_version": db_version,
        "tables_present": tables_present,
        "worker_rows": worker_rows,
        "boot_history_raw": boot_history_raw,
        "davmail_rows": davmail_rows,
        "error_message": error_message,
    }


def read_sync_store_section(repo: Any) -> dict[str, Any]:
    """Read-only distribution mirror of ``SyncStore.get_stats()``."""
    total_emails = 0
    by_status: dict[str, int] = {}
    by_mailbox: dict[str, int] = {}
    last_max_row_id: Optional[int] = None
    last_sync_time: Optional[str] = None

    conn = repo._connect()
    try:
        try:
            total_emails = conn.execute(
                "SELECT COUNT(*) FROM email_metadata"
            ).fetchone()[0]
            by_status = {
                r["sync_status"]: r["count"]
                for r in conn.execute(
                    "SELECT sync_status, COUNT(*) AS count "
                    "FROM email_metadata GROUP BY sync_status"
                ).fetchall()
            }
            by_mailbox = {
                r["mailbox"]: r["count"]
                for r in conn.execute(
                    "SELECT mailbox, COUNT(*) AS count "
                    "FROM email_metadata GROUP BY mailbox"
                ).fetchall()
            }
        except sqlite3.Error:
            total_emails, by_status, by_mailbox = 0, {}, {}

        try:
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key='last_max_row_id'"
            ).fetchone()
            if row and row["value"] is not None:
                try:
                    last_max_row_id = int(row["value"])
                except (TypeError, ValueError):
                    last_max_row_id = None
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key='last_sync_time'"
            ).fetchone()
            last_sync_time = row["value"] if row else None
        except sqlite3.Error:
            last_max_row_id, last_sync_time = None, None
    finally:
        conn.close()

    failure_queue = by_status.get("fetch_failed", 0) + by_status.get("failed", 0)
    db_size_bytes = repo.db_path.stat().st_size if repo.db_path.exists() else 0

    return {
        "total_emails": total_emails,
        "by_status": by_status,
        "by_mailbox": by_mailbox,
        "failure_queue": failure_queue,
        "last_max_row_id": last_max_row_id,
        "last_sync_time": last_sync_time,
        "db_size_mb": round(db_size_bytes / 1024 / 1024, 2),
        "db_size_bytes": db_size_bytes,
        "_source": "live_query",
    }


def list_dead_letters(
    repo: Any, *, limit: int = 50, mailbox: Optional[str] = None
) -> list[dict[str, Any]]:
    """Query ``sync_status='dead_letter'`` emails ordered by ``updated_at DESC``."""
    query = (
        "SELECT internal_id, subject, sender, mailbox, date_received, "
        "sync_status, retry_count, sync_error, updated_at "
        "FROM email_metadata WHERE sync_status='dead_letter'"
    )
    params: list[Any] = []
    if mailbox:
        query += " AND mailbox = ?"
        params.append(mailbox)
    query += " ORDER BY updated_at DESC LIMIT ?"
    params.append(limit)

    conn = repo._connect()
    rows: list[dict[str, Any]] = []
    try:
        for r in conn.execute(query, params).fetchall():
            rows.append(
                {
                    "internal_id": r["internal_id"],
                    "subject": r["subject"],
                    "sender": r["sender"],
                    "mailbox": r["mailbox"],
                    "date_received": r["date_received"],
                    "sync_status": r["sync_status"],
                    "retry_count": r["retry_count"],
                    "sync_error": r["sync_error"],
                    "last_error": r["sync_error"],
                    "updated_at": r["updated_at"],
                }
            )
    finally:
        conn.close()
    return rows


def read_davmail_state(repo: Any) -> dict[str, str]:
    """Read all ``davmail.*`` keys plus ``davmail_uid_backfill_paused`` from ``sync_state``."""
    conn = repo._connect()
    try:
        rows = conn.execute(
            "SELECT key, value FROM sync_state WHERE key LIKE 'davmail.%'"
        ).fetchall()
        state = {r["key"]: r["value"] for r in rows}
        extra = conn.execute(
            "SELECT value FROM sync_state WHERE key = 'davmail_uid_backfill_paused'"
        ).fetchone()
        if extra is not None:
            state["davmail_uid_backfill_paused"] = extra["value"]
    finally:
        conn.close()
    return state
