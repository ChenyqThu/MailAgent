"""Repository operations for ``semantic_index.db``."""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from src.semantic.db import SemanticDb


class SemanticRepository:
    def __init__(self, db: SemanticDb) -> None:
        self.db = db

    def existing_hashes(self, conn: sqlite3.Connection, model: str) -> dict[int, str]:
        rows = conn.execute(
            "SELECT internal_id, content_hash FROM email_semantic_vec WHERE model=?",
            (model,),
        ).fetchall()
        return {int(r["internal_id"]): str(r["content_hash"]) for r in rows}

    def upsert_email_vecs(
        self, conn: sqlite3.Connection, model: str, rows: list[dict[str, Any]]
    ) -> int:
        if not rows:
            return 0
        conn.executemany(
            "INSERT INTO email_semantic_vec (internal_id, model, content_hash, dim, vec, bq_vec, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(internal_id, model) DO UPDATE SET"
            " content_hash=excluded.content_hash, dim=excluded.dim, vec=excluded.vec,"
            " bq_vec=excluded.bq_vec, updated_at=excluded.updated_at",
            [
                (
                    int(r["internal_id"]),
                    model,
                    str(r["content_hash"]),
                    int(r["dim"]),
                    r["vec"],
                    r.get("bq_vec"),
                    float(r["updated_at"]),
                )
                for r in rows
            ],
        )
        return len(rows)

    def delete_model_vecs(self, conn: sqlite3.Connection, model: str) -> int:
        return int(conn.execute("DELETE FROM email_semantic_vec WHERE model=?", (model,)).rowcount or 0)

    def count_indexed(self, conn: sqlite3.Connection, model: str) -> int:
        return int(
            conn.execute("SELECT COUNT(*) FROM email_semantic_vec WHERE model=?", (model,)).fetchone()[0]
        )

    def vector_signature(self, conn: sqlite3.Connection, model: str) -> tuple[int, int, float]:
        row = conn.execute(
            "SELECT COUNT(*), COALESCE(MAX(rowid), 0), COALESCE(MAX(updated_at), 0.0)"
            " FROM email_semantic_vec WHERE model=?",
            (model,),
        ).fetchone()
        return int(row[0]), int(row[1]), float(row[2])

    def load_vectors(
        self, conn: sqlite3.Connection, model: str
    ) -> tuple[list[int], list[int], list[bytes], list[Optional[bytes]]]:
        rows = conn.execute(
            "SELECT internal_id, dim, vec, bq_vec FROM email_semantic_vec"
            " WHERE model=? ORDER BY internal_id ASC",
            (model,),
        ).fetchall()
        return (
            [int(r["internal_id"]) for r in rows],
            [int(r["dim"]) for r in rows],
            [bytes(r["vec"]) for r in rows],
            [bytes(r["bq_vec"]) if r["bq_vec"] is not None else None for r in rows],
        )
