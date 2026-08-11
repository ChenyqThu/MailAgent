from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import Actor, MatterError, MatterService, TRASH_RETENTION_MS


@pytest.fixture
def service(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(path), clock_ms=lambda: 1_800_000_000_000)


def _create(service: MatterService, key: str = "create-1"):
    return service.create_matter(
        {"title": "Ship Matter MVP"}, idempotency_key=key, source="desktop_ui"
    )


def _mutation(version: int, key: str):
    return {
        "expected_version": version,
        "idempotency_key": key,
        "source": "desktop_ui",
    }


def test_version_conflict_uses_aggregate_cas(service):
    created = _create(service)
    public_id = created["matter"]["public_id"]
    service.patch_matter(public_id, {"title": "Winner"}, **_mutation(1, "patch-1"))
    with pytest.raises(MatterError, match="version changed") as exc:
        service.patch_matter(public_id, {"title": "Loser"}, **_mutation(1, "patch-2"))
    assert exc.value.code == "E_VERSION_CONFLICT"


def test_patch_matter_allows_valid_priority_and_rejects_invalid_priority(service):
    created = _create(service)
    changed = service.patch_matter(
        created["matter"]["public_id"],
        {"priority": "p0"},
        **_mutation(created["version"], "priority-p0"),
    )
    assert changed["matter"]["priority"] == "p0"
    with pytest.raises(MatterError) as exc_info:
        service.patch_matter(
            created["matter"]["public_id"],
            {"priority": "urgent"},
            **_mutation(changed["version"], "priority-invalid"),
        )
    assert exc_info.value.code == "E_INVALID_ARG"


def test_public_id_is_unique_and_sequence_rolls_back_with_create(service, monkeypatch):
    original = service.repository.insert_matter

    def fail_once(*args, **kwargs):
        monkeypatch.setattr(service.repository, "insert_matter", original)
        raise RuntimeError("injected")

    monkeypatch.setattr(service.repository, "insert_matter", fail_once)
    with pytest.raises(RuntimeError, match="injected"):
        _create(service, "failed-create")
    first = _create(service, "create-ok")
    second = _create(service, "create-ok-2")
    assert first["matter"]["public_id"] == "MAT-0001"
    assert second["matter"]["public_id"] == "MAT-0002"


def test_manual_update_is_accepted_and_materialized(service):
    created = _create(service)
    public_id = created["matter"]["public_id"]
    result = service.patch_matter(
        public_id,
        {"status": "active", "health": "on_track", "current_summary": "Ready"},
        **_mutation(1, "manual-update"),
    )
    detail = service.get_matter(public_id, include=["updates"])
    assert result["matter"]["current_summary"] == "Ready"
    assert result["matter"]["latest_accepted_update_id"] == detail["updates"][0]["id"]
    assert detail["updates"][0]["review_status"] == "accepted"
    assert detail["updates"][0]["official_state_version"] == 2


def test_description_is_user_only(service):
    created = _create(service)
    with pytest.raises(MatterError) as exc:
        service.patch_matter(
            created["matter"]["public_id"],
            {"description": "agent rewrite"},
            actor=Actor(kind="agent", actor_id="a1"),
            **_mutation(1, "agent-description"),
        )
    assert exc.value.code == "E_INVALID_ARG"


def test_archive_is_orthogonal_to_status(service):
    created = _create(service)
    public_id = created["matter"]["public_id"]
    active = service.patch_matter(
        public_id, {"status": "active"}, **_mutation(1, "active")
    )
    archived = service.archive(public_id, **_mutation(active["version"], "archive"))
    reopened = service.reopen(public_id, **_mutation(archived["version"], "reopen"))
    assert archived["matter"]["status"] == "active"
    assert archived["matter"]["archived_at"] is not None
    assert reopened["matter"]["status"] == "active"
    assert reopened["matter"]["archived_at"] is None


def test_trash_restore_preserves_history(service):
    created = _create(service)
    public_id = created["matter"]["public_id"]
    trashed = service.trash(public_id, **_mutation(1, "trash"))
    restored = service.restore(public_id, **_mutation(trashed["version"], "restore"))
    timeline = service.timeline(public_id, cursor=None, limit=20)["items"]
    assert trashed["matter"]["purge_after"] == 1_800_000_000_000 + TRASH_RETENTION_MS
    assert restored["matter"]["deleted_at"] is None
    assert {event["kind"] for event in timeline} >= {
        "matter_created",
        "matter_trashed",
        "matter_restored",
    }


def test_permanent_delete_cascades_aggregate_after_trash(service):
    created = _create(service)
    public_id = created["matter"]["public_id"]
    updated = service.patch_matter(
        public_id,
        {"current_summary": "accepted"},
        **_mutation(1, "summary-before-delete"),
    )
    trashed = service.trash(
        public_id, **_mutation(updated["version"], "trash-before-delete")
    )
    result = service.permanently_delete(
        public_id,
        **_mutation(trashed["version"], "permanent-delete"),
        reason="confirmed by user",
    )
    assert result == {"deleted": True, "public_id": public_id}
    with service.repository.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM matter").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM matter_update").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM matter_event").fetchone()[0] == 0


def test_event_dedupe_key_replays_committed_result(service):
    created = _create(service)
    public_id = created["matter"]["public_id"]
    first = service.patch_matter(
        public_id, {"title": "Retried"}, **_mutation(1, "same-key")
    )
    replay = service.patch_matter(
        public_id, {"title": "Ignored"}, **_mutation(1, "same-key")
    )
    assert replay["version"] == first["version"]
    assert replay["event_ids"] == first["event_ids"]
    assert replay["matter"]["title"] == "Retried"


def test_non_action_fields_are_rejected_by_service_and_sql(service):
    created = _create(service)
    public_id = created["matter"]["public_id"]
    with pytest.raises(MatterError) as exc:
        service.create_item(
            public_id,
            {"kind": "note", "title": "No status", "status": "open"},
            **_mutation(1, "bad-note"),
        )
    assert exc.value.code == "E_INVALID_ARG"

    path = service.repository.db_path
    matter_id = created["matter"]["id"]
    with sqlite3.connect(path) as conn, pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """INSERT INTO matter_item
               (matter_id,kind,title,status,created_by_kind,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?)""",
            (matter_id, "note", "bad", "open", "user", 1, 1),
        )
