"""SQLite access for the Matter aggregate."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping


class MatterRepository:
    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def get_matter(
        self, conn: sqlite3.Connection, public_id: str, *, include_deleted: bool = True
    ) -> dict[str, Any] | None:
        sql = "SELECT * FROM matter WHERE public_id=?"
        params: list[Any] = [public_id]
        if not include_deleted:
            sql += " AND deleted_at IS NULL"
        row = conn.execute(sql, params).fetchone()
        return self._matter_row(row) if row else None

    def get_matter_by_id(
        self, conn: sqlite3.Connection, matter_id: int
    ) -> dict[str, Any] | None:
        row = conn.execute("SELECT * FROM matter WHERE id=?", (matter_id,)).fetchone()
        return self._matter_row(row) if row else None

    def find_event(
        self, conn: sqlite3.Connection, dedupe_key: str
    ) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT * FROM matter_event WHERE dedupe_key=?", (dedupe_key,)
        ).fetchone()
        return self._event_row(row) if row else None

    def allocate_sequence(self, conn: sqlite3.Connection, created_at: int) -> int:
        cursor = conn.execute(
            "INSERT INTO matter_seq(created_at) VALUES (?)", (created_at,)
        )
        return int(cursor.lastrowid)

    def insert_matter(self, conn: sqlite3.Connection, values: Mapping[str, Any]) -> int:
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO matter ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        return int(cursor.lastrowid)

    def cas_update_matter(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        expected_version: int,
        changes: Mapping[str, Any],
    ) -> bool:
        assignments = [f"{column}=?" for column in changes]
        assignments.append("version=version+1")
        cursor = conn.execute(
            f"UPDATE matter SET {', '.join(assignments)} WHERE id=? AND version=?",
            (*changes.values(), matter_id, expected_version),
        )
        return cursor.rowcount == 1

    def insert_event(self, conn: sqlite3.Connection, values: Mapping[str, Any]) -> int:
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO matter_event ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        return int(cursor.lastrowid)

    def insert_update(self, conn: sqlite3.Connection, values: Mapping[str, Any]) -> int:
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO matter_update ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        return int(cursor.lastrowid)

    def insert_item(self, conn: sqlite3.Connection, values: Mapping[str, Any]) -> int:
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO matter_item ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        return int(cursor.lastrowid)

    def update_item(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        item_id: int,
        changes: Mapping[str, Any],
    ) -> bool:
        assignments = [f"{column}=?" for column in changes]
        assignments.append("version=version+1")
        cursor = conn.execute(
            f"UPDATE matter_item SET {', '.join(assignments)} WHERE id=? AND matter_id=?",
            (*changes.values(), item_id, matter_id),
        )
        return cursor.rowcount == 1

    def get_item(
        self, conn: sqlite3.Connection, matter_id: int, item_id: int
    ) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT * FROM matter_item WHERE id=? AND matter_id=?", (item_id, matter_id)
        ).fetchone()
        return self._item_row(row) if row else None

    def list_items(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        *,
        kind: str | None = None,
        status: str | None = None,
        include_deleted: bool = False,
    ) -> list[dict[str, Any]]:
        clauses = ["matter_id=?"]
        params: list[Any] = [matter_id]
        if kind:
            clauses.append("kind=?")
            params.append(kind)
        if status:
            clauses.append("status=?")
            params.append(status)
        if not include_deleted:
            clauses.append("deleted_at IS NULL")
        rows = conn.execute(
            f"SELECT * FROM matter_item WHERE {' AND '.join(clauses)} ORDER BY position, id",
            params,
        ).fetchall()
        return [self._item_row(row) for row in rows]

    def list_events(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        *,
        cursor: int | None,
        limit: int,
    ) -> tuple[list[dict[str, Any]], int | None]:
        clauses = ["matter_id=?"]
        params: list[Any] = [matter_id]
        if cursor is not None:
            clauses.append("id < ?")
            params.append(cursor)
        params.append(limit + 1)
        rows = conn.execute(
            f"SELECT * FROM matter_event WHERE {' AND '.join(clauses)} ORDER BY id DESC LIMIT ?",
            params,
        ).fetchall()
        next_cursor = int(rows[limit - 1]["id"]) if len(rows) > limit else None
        return [self._event_row(row) for row in rows[:limit]], next_cursor

    def list_updates(
        self, conn: sqlite3.Connection, matter_id: int
    ) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT * FROM matter_update WHERE matter_id=? ORDER BY created_at DESC, id DESC",
            (matter_id,),
        ).fetchall()
        return [self._update_row(row) for row in rows]

    def list_matters(
        self,
        conn: sqlite3.Connection,
        *,
        filters: Mapping[str, Any],
        cursor: tuple[int, int] | None,
        limit: int,
        sort: str,
    ) -> tuple[list[dict[str, Any]], tuple[int, int] | None, int]:
        clauses: list[str] = []
        params: list[Any] = []
        deleted = filters.get("deleted")
        archived = filters.get("archived")
        view = filters.get("view")
        if deleted is True or view == "trash":
            clauses.append("deleted_at IS NOT NULL")
        else:
            clauses.append("deleted_at IS NULL")
        if archived is True or view == "archived":
            clauses.append("archived_at IS NOT NULL")
        elif archived is False or view not in ("archived", "trash"):
            clauses.append("archived_at IS NULL")
        for field in ("status", "health", "priority"):
            value = filters.get(field)
            if value:
                clauses.append(f"{field}=?")
                params.append(value)
        if filters.get("type"):
            clauses.append("matter_type=?")
            params.append(filters["type"])
        if filters.get("tag"):
            clauses.append(
                "EXISTS (SELECT 1 FROM json_each(matter.tags_json) WHERE value=?)"
            )
            params.append(filters["tag"])
        if filters.get("q"):
            query = f"%{filters['q']}%"
            clauses.append(
                "(title LIKE ? OR description LIKE ? OR current_summary LIKE ?)"
            )
            params.extend((query, query, query))
        order_column = "updated_at" if sort != "created_at" else "created_at"
        if cursor:
            clauses.append(f"({order_column} < ? OR ({order_column}=? AND id < ?))")
            params.extend((cursor[0], cursor[0], cursor[1]))
        where = " AND ".join(clauses) or "1=1"
        total = int(
            conn.execute(
                f"SELECT COUNT(*) FROM matter WHERE {where}", params
            ).fetchone()[0]
        )
        rows = conn.execute(
            f"SELECT * FROM matter WHERE {where} ORDER BY {order_column} DESC, id DESC LIMIT ?",
            (*params, limit + 1),
        ).fetchall()
        next_cursor = None
        if len(rows) > limit:
            last = rows[limit - 1]
            next_cursor = (int(last[order_column]), int(last["id"]))
        return [self._matter_row(row) for row in rows[:limit]], next_cursor, total

    def delete_matter(self, conn: sqlite3.Connection, matter_id: int) -> None:
        conn.execute("DELETE FROM matter WHERE id=?", (matter_id,))

    @staticmethod
    def _json(value: Any, fallback: Any) -> Any:
        if value is None:
            return fallback
        try:
            return json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return fallback

    @classmethod
    def _matter_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["tags"] = cls._json(result.pop("tags_json"), [])
        result["waiting_context"] = cls._json(result.pop("waiting_context_json"), None)
        return result

    @classmethod
    def _item_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["checklist"] = cls._json(result.pop("checklist_json"), [])
        result["source_locator"] = cls._json(result.pop("source_locator_json"), None)
        return result

    @classmethod
    def _event_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["payload"] = cls._json(result.pop("payload_json"), {})
        return result

    @classmethod
    def _update_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        for source, target, fallback in (
            ("original_proposal_json", "original_proposal", {}),
            ("reviewed_result_json", "reviewed_result", None),
            ("changes_json", "changes", []),
            ("accepted_change_ids_json", "accepted_change_ids", None),
            ("citations_json", "citations", []),
        ):
            result[target] = cls._json(result.pop(source), fallback)
        return result
