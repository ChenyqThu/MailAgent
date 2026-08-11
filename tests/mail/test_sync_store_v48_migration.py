"""v48 migration: canonical MailAgent Matter resource identities."""

from __future__ import annotations

import json
import sqlite3

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService


def _downgrade_to_v47(path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE sync_state SET value='47' WHERE key='db_version'")
        conn.commit()


def _insert_resource(conn, *, kind: str, external_key: str) -> int:
    cursor = conn.execute(
        "INSERT INTO resource(kind,provider,external_key,metadata_json,access_policy,created_at,updated_at) "
        "VALUES (?,'mailagent',?,'{}','allowed',10,20)",
        (kind, external_key),
    )
    return int(cursor.lastrowid)


def _insert_link(conn, matter_id: int, resource_id: int, **overrides) -> int:
    values = {
        "relation_type": None,
        "pinned": 0,
        "confidence": None,
        "provenance_json": "{}",
        "confirmed_at": None,
        "sub_state": "none",
        "created_at": 10,
        "updated_at": 20,
        **overrides,
    }
    cursor = conn.execute(
        "INSERT INTO matter_resource("
        "matter_id,resource_id,relation_type,pinned,added_by_kind,confidence,"
        "provenance_json,confirmed_at,sub_state,created_at,updated_at"
        ") VALUES (?,?,?,?,'user',?,?,?,?,?,?)",
        (
            matter_id,
            resource_id,
            values["relation_type"],
            values["pinned"],
            values["confidence"],
            values["provenance_json"],
            values["confirmed_at"],
            values["sub_state"],
            values["created_at"],
            values["updated_at"],
        ),
    )
    return int(cursor.lastrowid)


def test_v48_normalizes_resources_backfills_metadata_and_merges_collisions(tmp_path):
    path = tmp_path / "v48.db"
    SyncStore(str(path))
    service = MatterService(MatterRepository(path), clock_ms=lambda: 1_000)
    matter = service.create_matter(
        {"title": "Migration"}, idempotency_key="create", source="test"
    )["matter"]
    _downgrade_to_v47(path)

    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute(
            "INSERT INTO email_metadata(internal_id,message_id,thread_id,date_received) "
            "VALUES (123,'message-123','thread-123','2026-08-11T00:00:00Z')"
        )
        canonical_id = _insert_resource(conn, kind="email", external_key="email:123")
        legacy_id = _insert_resource(conn, kind="email", external_key="123")
        thread_id = _insert_resource(conn, kind="thread", external_key="thread-123")
        canonical_link_id = _insert_link(conn, matter["id"], canonical_id)
        _insert_link(
            conn,
            matter["id"],
            legacy_id,
            relation_type="reference",
            pinned=1,
            confidence=0.8,
            provenance_json='{"source":"ai"}',
            confirmed_at=15,
            sub_state="active",
            created_at=5,
            updated_at=30,
        )
        _insert_link(conn, matter["id"], thread_id)
        conn.execute(
            "INSERT INTO matter_event(matter_id,kind,happened_at,actor_kind,source,"
            "resource_id,dedupe_key,created_at) VALUES (?, 'legacy_resource', 1, 'user', "
            "'test', ?, 'legacy-resource-event', 1)",
            (matter["id"], legacy_id),
        )
        conn.commit()

    SyncStore(str(path))
    _downgrade_to_v47(path)
    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        resources = conn.execute(
            "SELECT * FROM resource WHERE provider='mailagent' ORDER BY external_key"
        ).fetchall()
        assert [row["external_key"] for row in resources] == [
            "email:123",
            "thread:thread-123",
        ]
        email = next(row for row in resources if row["kind"] == "email")
        assert email["id"] == canonical_id
        assert json.loads(email["metadata_json"]) == {
            "internal_id": 123,
            "message_id": "message-123",
            "date_received": "2026-08-11T00:00:00Z",
        }
        links = conn.execute(
            "SELECT * FROM matter_resource WHERE matter_id=? ORDER BY id", (matter["id"],)
        ).fetchall()
        email_links = [row for row in links if row["resource_id"] == canonical_id]
        assert len(email_links) == 1
        assert email_links[0]["id"] == canonical_link_id
        assert email_links[0]["pinned"] == 1
        assert email_links[0]["relation_type"] == "reference"
        assert email_links[0]["confidence"] == 0.8
        assert email_links[0]["sub_state"] == "active"
        assert email_links[0]["created_at"] == 5
        assert email_links[0]["updated_at"] == 30
        assert conn.execute(
            "SELECT resource_id FROM matter_event WHERE dedupe_key='legacy-resource-event'"
        ).fetchone()[0] == canonical_id
        assert conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0] == str(SyncStore.DB_VERSION)
