"""SQLite access for the Matter aggregate."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping

from .models import MATTER_SEARCH_FIELDS
from .resource_identity import parse_resource_key


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
        query_text = str(filters.get("q") or "").strip()
        search_join = ""
        select_prefix = "matter.*"
        if query_text:
            search_join = " JOIN matter_search_document search_doc ON search_doc.matter_id=matter.id"
            if len(query_text) >= 3:
                search_join += " JOIN matter_fts ON matter_fts.rowid=matter.id"
                clauses.append("matter_fts MATCH ?")
                params.append(self._fts_query(query_text))
            else:
                like = f"%{self._escape_like(query_text)}%"
                clauses.append(
                    "(" + " OR ".join(
                        f"search_doc.{column} LIKE ? ESCAPE '\\'"
                        for column in self._search_columns()
                    ) + ")"
                )
                params.extend(like for _ in self._search_columns())
            select_prefix += ", " + ", ".join(
                f"search_doc.{column} AS search_{column}"
                for column in self._search_columns()
            )
        order_column = "updated_at" if sort != "created_at" else "created_at"
        if cursor:
            clauses.append(
                f"(matter.{order_column} < ? OR "
                f"(matter.{order_column}=? AND matter.id < ?))"
            )
            params.extend((cursor[0], cursor[0], cursor[1]))
        where = " AND ".join(clauses) or "1=1"
        total = int(
            conn.execute(
                f"SELECT COUNT(*) FROM matter{search_join} WHERE {where}", params
            ).fetchone()[0]
        )
        rows = conn.execute(
            f"SELECT {select_prefix} FROM matter{search_join} WHERE {where} "
            f"ORDER BY matter.{order_column} DESC, matter.id DESC LIMIT ?",
            (*params, limit + 1),
        ).fetchall()
        next_cursor = None
        if len(rows) > limit:
            last = rows[limit - 1]
            next_cursor = (int(last[order_column]), int(last["id"]))
        results = [self._matter_row(row) for row in rows[:limit]]
        if query_text:
            for result in results:
                self._add_search_match(result, query_text)
        return results, next_cursor, total

    def upsert_resource(
        self, conn: sqlite3.Connection, values: Mapping[str, Any]
    ) -> tuple[dict[str, Any], bool]:
        existing = conn.execute(
            "SELECT * FROM resource WHERE provider=? AND external_key=?",
            (values["provider"], values["external_key"]),
        ).fetchone()
        if existing:
            return self._resource_row(existing), False
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO resource ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        row = conn.execute("SELECT * FROM resource WHERE id=?", (cursor.lastrowid,)).fetchone()
        return self._resource_row(row), True

    def get_resource(self, conn: sqlite3.Connection, resource_id: int) -> dict[str, Any] | None:
        row = conn.execute("SELECT * FROM resource WHERE id=?", (resource_id,)).fetchone()
        return self._resource_row(row) if row else None

    def get_resource_link(
        self, conn: sqlite3.Connection, matter_id: int, resource_id: int, *, live_only: bool = False
    ) -> dict[str, Any] | None:
        sql = "SELECT * FROM matter_resource WHERE matter_id=? AND resource_id=?"
        if live_only:
            sql += " AND deleted_at IS NULL"
        sql += " ORDER BY id DESC LIMIT 1"
        row = conn.execute(sql, (matter_id, resource_id)).fetchone()
        return self._resource_link_row(row) if row else None

    def insert_resource_link(self, conn: sqlite3.Connection, values: Mapping[str, Any]) -> int:
        columns = tuple(values)
        cursor = conn.execute(
            f"INSERT INTO matter_resource ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(values[column] for column in columns),
        )
        return int(cursor.lastrowid)

    def get_resource_rejection(
        self, conn: sqlite3.Connection, matter_id: int, resource_key: str
    ) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT * FROM matter_resource_rejection WHERE matter_id=? AND resource_key=?",
            (matter_id, resource_key),
        ).fetchone()
        return dict(row) if row else None

    def upsert_resource_rejection(
        self, conn: sqlite3.Connection, values: Mapping[str, Any]
    ) -> None:
        conn.execute(
            "INSERT INTO matter_resource_rejection "
            "(matter_id,resource_key,rejected_at,evidence_fingerprint,reason) "
            "VALUES (?,?,?,?,?) ON CONFLICT(matter_id,resource_key) DO UPDATE SET "
            "rejected_at=excluded.rejected_at,evidence_fingerprint=excluded.evidence_fingerprint,"
            "reason=excluded.reason",
            (
                values["matter_id"],
                values["resource_key"],
                values["rejected_at"],
                values["evidence_fingerprint"],
                values.get("reason"),
            ),
        )

    def list_duplicate_candidate_rows(
        self, conn: sqlite3.Connection, *, exclude_matter_id: int | None = None
    ) -> list[dict[str, Any]]:
        params: list[Any] = []
        excluded = ""
        if exclude_matter_id is not None:
            excluded = " AND m.id<>?"
            params.append(exclude_matter_id)
        rows = conn.execute(
            "SELECT m.*, d.title AS search_title, d.description AS search_description, "
            "d.current_summary AS search_summary, d.items_text, d.stakeholders_text, d.notes_text "
            "FROM matter m JOIN matter_search_document d ON d.matter_id=m.id "
            "WHERE m.deleted_at IS NULL" + excluded + " ORDER BY m.updated_at DESC, m.id DESC LIMIT 500",
            params,
        ).fetchall()
        results: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["stakeholder_emails"] = [
                value[0]
                for value in conn.execute(
                    "SELECT email_normalized FROM matter_stakeholder "
                    "WHERE matter_id=? AND deleted_at IS NULL AND email_normalized IS NOT NULL",
                    (row["id"],),
                ).fetchall()
            ]
            item["resource_keys"] = [
                f"{value[0]}:{value[1]}"
                for value in conn.execute(
                    "SELECT r.provider,r.external_key FROM matter_resource mr "
                    "JOIN resource r ON r.id=mr.resource_id "
                    "WHERE mr.matter_id=? AND mr.deleted_at IS NULL",
                    (row["id"],),
                ).fetchall()
            ]
            results.append(item)
        return results

    def list_resources(self, conn: sqlite3.Connection, matter_id: int, filters: Mapping[str, Any]) -> list[dict[str, Any]]:
        clauses = ["mr.matter_id=?"]
        params: list[Any] = [matter_id]
        if not filters.get("include_deleted"):
            clauses.append("mr.deleted_at IS NULL")
        if filters.get("kind"):
            clauses.append("r.kind=?")
            params.append(filters["kind"])
        if filters.get("pinned") is not None:
            clauses.append("mr.pinned=?")
            params.append(1 if filters["pinned"] else 0)
        if filters.get("access_policy"):
            clauses.append("r.access_policy=?")
            params.append(filters["access_policy"])
        if filters.get("sub_state"):
            clauses.append("mr.sub_state=?")
            params.append(filters["sub_state"])
        rows = conn.execute(
            "SELECT r.*, mr.id AS link_id, mr.matter_id AS link_matter_id, mr.relation_type, mr.pinned, mr.added_by_kind, "
            "mr.added_by_id, mr.confidence, mr.provenance_json, mr.confirmed_at, mr.sub_state, "
            "mr.deleted_at AS link_deleted_at, mr.created_at AS link_created_at, mr.updated_at AS link_updated_at "
            f"FROM matter_resource mr JOIN resource r ON r.id=mr.resource_id WHERE {' AND '.join(clauses)} "
            "ORDER BY mr.pinned DESC, mr.created_at, mr.id",
            params,
        ).fetchall()
        return [self._joined_resource_row(conn, row) for row in rows]

    def lookup_resource_links(self, conn: sqlite3.Connection, provider: str, keys: list[str]) -> dict[str, list[dict[str, Any]]]:
        results = {key: [] for key in keys}
        if not keys:
            return results
        placeholders = ",".join("?" for _ in keys)
        rows = conn.execute(
            "SELECT r.id AS resource_id, r.external_key, r.kind, mr.id AS link_id, mr.pinned, mr.sub_state, "
            "m.public_id, m.title, m.status, m.health, m.priority, m.archived_at "
            "FROM resource r JOIN matter_resource mr ON mr.resource_id=r.id "
            "JOIN matter m ON m.id=mr.matter_id "
            f"WHERE r.provider=? AND r.external_key IN ({placeholders}) AND mr.deleted_at IS NULL "
            "AND m.deleted_at IS NULL ORDER BY m.updated_at DESC, m.id DESC",
            (provider, *keys),
        ).fetchall()
        for row in rows:
            item = dict(row)
            item["available"] = self.resource_available(conn, provider, row["kind"], row["external_key"])
            results[row["external_key"]].append(item)
        return results

    def resource_available(self, conn: sqlite3.Connection, provider: str, kind: str, external_key: str) -> bool:
        if provider != "mailagent" or kind not in {"email", "thread"}:
            return True
        try:
            parsed_kind, identifier = parse_resource_key(
                external_key if ":" in external_key else f"{kind}:{external_key}"
            )
        except ValueError:
            return False
        if parsed_kind != kind:
            return False
        if kind == "email":
            internal_id = int(identifier)
            return conn.execute("SELECT 1 FROM email_metadata WHERE internal_id=?", (internal_id,)).fetchone() is not None
        return conn.execute("SELECT 1 FROM email_metadata WHERE thread_id=? LIMIT 1", (identifier,)).fetchone() is not None

    def rebuild_all_search_documents(self) -> int:
        with self.transaction() as conn:
            ids = [int(row[0]) for row in conn.execute("SELECT id FROM matter")]
            for matter_id in ids:
                self.refresh_search_projection(conn, matter_id)
            return len(ids)

    def refresh_search_projection(self, conn: sqlite3.Connection, matter_id: int) -> None:
        row = conn.execute("SELECT * FROM matter WHERE id=?", (matter_id,)).fetchone()
        conn.execute("DELETE FROM matter_fts WHERE rowid=?", (matter_id,))
        conn.execute("DELETE FROM matter_search_document WHERE matter_id=?", (matter_id,))
        if not row:
            return
        tags = self._json(row["tags_json"], [])
        title = " ".join([row["title"], *(f"#{tag}" for tag in tags)])
        items_text = self._aggregate_items(conn, matter_id, note=False)
        notes_text = self._aggregate_items(conn, matter_id, note=True)
        stakeholders_text = "\n".join(
            " ".join(str(value or "") for value in stakeholder)
            for stakeholder in conn.execute(
                "SELECT display_name,email_normalized,organization,role FROM matter_stakeholder "
                "WHERE matter_id=? AND deleted_at IS NULL ORDER BY id",
                (matter_id,),
            ).fetchall()
        )
        values = (
            matter_id, title, row["description"] or "", row["current_summary"] or "",
            row["status"] or "", items_text, stakeholders_text, notes_text, row["updated_at"],
        )
        conn.execute(
            "INSERT INTO matter_search_document "
            "(matter_id,title,description,current_summary,status_text,items_text,stakeholders_text,notes_text,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            values,
        )
        conn.execute(
            "INSERT INTO matter_fts(rowid,title,description,current_summary,status_text,items_text,stakeholders_text,notes_text) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (matter_id, *values[1:8]),
        )

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
        result["goal_checks"] = cls._json(result.pop("goal_checks_json", None), [])
        result["waiting_context"] = cls._json(result.pop("waiting_context_json"), None)
        return result

    @classmethod
    def _resource_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["metadata"] = cls._json(result.pop("metadata_json"), {})
        return result

    @classmethod
    def _resource_link_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["pinned"] = bool(result["pinned"])
        result["provenance"] = cls._json(result.pop("provenance_json"), {})
        return result

    def _joined_resource_row(self, conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        raw = dict(row)
        resource = {key: raw[key] for key in (
            "id", "kind", "provider", "external_key", "canonical_url", "title", "metadata_json",
            "revision", "content_hash", "permission_state", "sync_state", "access_policy", "last_checked_at",
            "created_at", "updated_at",
        )}
        resource["metadata"] = self._json(resource.pop("metadata_json"), {})
        resource["available"] = self.resource_available(conn, resource["provider"], resource["kind"], resource["external_key"])
        link = {
            "id": raw["link_id"], "matter_id": raw["link_matter_id"], "resource_id": raw["id"],
            "relation_type": raw["relation_type"], "pinned": bool(raw["pinned"]),
            "added_by_kind": raw["added_by_kind"], "added_by_id": raw["added_by_id"],
            "confidence": raw["confidence"], "provenance": self._json(raw["provenance_json"], {}),
            "confirmed_at": raw["confirmed_at"], "sub_state": raw["sub_state"],
            "deleted_at": raw["link_deleted_at"], "created_at": raw["link_created_at"], "updated_at": raw["link_updated_at"],
        }
        return {"resource": resource, "link": link}

    @staticmethod
    def _aggregate_items(conn: sqlite3.Connection, matter_id: int, *, note: bool) -> str:
        comparator = "=" if note else "<>"
        rows = conn.execute(
            f"SELECT title,description FROM matter_item WHERE matter_id=? AND kind {comparator} 'note' "
            "AND deleted_at IS NULL ORDER BY position,id",
            (matter_id,),
        ).fetchall()
        return "\n".join(" ".join(str(value or "") for value in row) for row in rows)

    @staticmethod
    def _search_columns() -> tuple[str, ...]:
        return ("title", "description", "current_summary", "status_text", "items_text", "stakeholders_text", "notes_text")

    @staticmethod
    def _escape_like(value: str) -> str:
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    @staticmethod
    def _fts_query(value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

    def _add_search_match(self, result: dict[str, Any], query: str) -> None:
        lowered = query.lower()
        matched_fields: list[str] = []
        snippets: dict[str, str] = {}
        column_map = dict(zip(MATTER_SEARCH_FIELDS, self._search_columns(), strict=True))
        for field, column in column_map.items():
            text = str(result.pop(f"search_{column}", "") or "")
            if lowered in text.lower():
                matched_fields.append(field)
                snippets[field] = self._snippet(text, query)
        result["matched_fields"] = matched_fields
        result["snippets"] = snippets

    @staticmethod
    def _snippet(text: str, query: str) -> str:
        compact = " ".join(text.split())
        index = compact.lower().find(query.lower())
        start = max(0, index - 40) if index >= 0 else 0
        return compact[start:start + 120]

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
