"""Single write boundary for local, per-message reply decisions.

An operation owns only IDs in the submitted snapshot. Undo deletes only its own
rows, so a later dismissal cannot be undone by an older UI action.
"""
from __future__ import annotations

import sqlite3
import time
import uuid


def dismiss_replies(db_path: str, internal_ids: list[int]) -> dict:
    ids = sorted(set(internal_ids))
    if not ids or any(type(i) is not int or i <= 0 for i in ids):
        raise ValueError("internalIds must contain positive integer IDs")
    operation_id = str(uuid.uuid4())
    with sqlite3.connect(db_path, timeout=30) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("BEGIN IMMEDIATE")
        for iid in ids:
            conn.execute(
                """INSERT INTO today_reply_dismissal (internal_id, operation_id, dismissed_at)
                   SELECT internal_id, ?, ? FROM email_metadata WHERE internal_id = ?
                   ON CONFLICT(internal_id) DO UPDATE SET
                     operation_id=excluded.operation_id, dismissed_at=excluded.dismissed_at""",
                (operation_id, time.time(), iid),
            )
    return {"operationId": operation_id}


def undo_dismissal(db_path: str, operation_id: str) -> dict:
    with sqlite3.connect(db_path, timeout=30) as conn:
        conn.execute("DELETE FROM today_reply_dismissal WHERE operation_id = ?", (operation_id,))
    return {"operationId": operation_id}
