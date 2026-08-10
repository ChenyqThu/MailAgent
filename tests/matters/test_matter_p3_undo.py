"""P3 D9 coverage: undo descriptors on mutation responses.

Semantics authority: p3-decisions.md D9 —
- every reversible mutation returns `undo = {tool, input, label}` where `input`
  carries the full reverse-call args PLUS the post-write `expected_version` and
  `reverses_event_id` (the primary event of the forward write);
- executing the descriptor really rolls the state back and the reverse event row
  lands `reverses_event_id` (undo shows up in the timeline);
- a concurrent write in between makes the stale descriptor fail E_VERSION_CONFLICT
  (no blind overwrite).
"""

from __future__ import annotations

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterError, MatterService


@pytest.fixture
def service(tmp_path) -> MatterService:
    path = tmp_path / "matter-undo.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(path), clock_ms=lambda: 1_700_000_000_000)


def mutation(version: int, key: str) -> dict:
    return {
        "expected_version": version,
        "idempotency_key": key,
        "source": "desktop_ui",
    }


def assert_undo_envelope(result: dict, *, tool: str, operation: str) -> dict:
    """D9 invariants shared by every descriptor: tool/label + fresh CAS anchors."""
    undo = result["undo"]
    assert undo is not None
    assert undo["tool"] == tool
    assert isinstance(undo["label"], str) and undo["label"]
    inp = undo["input"]
    assert inp["operation"] == operation
    assert inp["expected_version"] == result["version"]
    assert inp["reverses_event_id"] == result["event_ids"][0]
    return undo


def execute_undo(service: MatterService, undo: dict, key: str) -> dict:
    """Dispatch a descriptor exactly the way the renderer would (D9: direct REST,
    fresh idempotency_key, reverses_event_id passed through)."""
    inp = dict(undo["input"])
    args = {
        "expected_version": inp.pop("expected_version"),
        "reverses_event_id": inp.pop("reverses_event_id"),
        "idempotency_key": key,
        "source": "desktop_ui",
        "reason": "撤销",
    }
    tool = undo["tool"]
    public_id = inp.pop("public_id")
    operation = inp.pop("operation")
    if tool == "matter_update":
        if operation == "patch":
            result = service.patch_matter(public_id, inp.pop("patch"), **args)
        else:
            result = getattr(service, operation)(public_id, **args)
    elif tool == "matter_item_mutate":
        item_id = inp.pop("item_id")
        if operation == "delete":
            result = service.delete_item(public_id, item_id, **args)
        elif operation == "restore":
            result = service.restore_item(public_id, item_id, **args)
        else:
            result = service.update_item(public_id, item_id, inp.pop("patch"), **args)
    elif tool == "matter_resource_mutate":
        resource_id = inp.pop("resource_id")
        if operation == "unlink":
            result = service.unlink_resource(public_id, resource_id, **args)
        elif operation == "restore":
            result = service.restore_resource(public_id, resource_id, **args)
        else:
            result = service.patch_resource(public_id, resource_id, inp.pop("patch"), **args)
    else:
        raise AssertionError(f"unhandled undo tool: {tool}")
    # The descriptor must carry the reverse call args and nothing else.
    assert not inp, f"descriptor had unconsumed input keys: {sorted(inp)}"
    return result


def _event_row(service: MatterService, event_id: int) -> dict:
    with service.repository.connect() as conn:
        row = conn.execute(
            "SELECT * FROM matter_event WHERE id=?", (event_id,)
        ).fetchone()
        assert row is not None
        return dict(row)


def test_create_undo_is_trash_and_reverse_event_links_back(service):
    created = service.create_matter(
        {"title": "Fresh"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    undo = assert_undo_envelope(created, tool="matter_update", operation="trash")
    create_event_id = created["event_ids"][0]

    undone = execute_undo(service, undo, "undo-create")
    assert undone["matter"]["deleted_at"] is not None
    reverse_event = _event_row(service, undone["event_ids"][0])
    assert reverse_event["kind"] == "matter_trashed"
    assert reverse_event["reverses_event_id"] == create_event_id


def test_patch_undo_carries_before_values_and_restores_them(service):
    created = service.create_matter(
        {"title": "Original", "tags": ["alpha"]},
        idempotency_key="create",
        source="desktop_ui",
    )
    public_id = created["matter"]["public_id"]

    patched = service.patch_matter(
        public_id,
        {"title": "Changed", "tags": ["beta"], "status": "active"},
        **mutation(1, "patch"),
    )
    undo = assert_undo_envelope(patched, tool="matter_update", operation="patch")
    # D9: the reverse patch is the BEFORE image, captured server-side.
    assert undo["input"]["patch"] == {
        "title": "Original",
        "tags": ["alpha"],
        "status": "inbox",
    }

    undone = execute_undo(service, undo, "undo-patch")
    matter = undone["matter"]
    assert matter["title"] == "Original"
    assert matter["tags"] == ["alpha"]
    assert matter["status"] == "inbox"
    reverse_event = _event_row(service, undone["event_ids"][0])
    assert reverse_event["kind"] == "matter_updated"
    assert reverse_event["reverses_event_id"] == patched["event_ids"][0]


def test_item_delete_undo_restores_item(service):
    created = service.create_matter(
        {"title": "Items"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    item = service.create_item(
        public_id, {"kind": "action", "title": "task"}, **mutation(1, "item")
    )
    item_id = item["item"]["id"]

    deleted = service.delete_item(public_id, item_id, **mutation(item["version"], "del"))
    undo = assert_undo_envelope(deleted, tool="matter_item_mutate", operation="restore")
    assert undo["input"]["item_id"] == item_id
    assert deleted["item"]["deleted_at"] is not None

    undone = execute_undo(service, undo, "undo-del")
    assert undone["item"]["id"] == item_id
    assert undone["item"]["deleted_at"] is None
    reverse_event = _event_row(service, undone["event_ids"][0])
    assert reverse_event["kind"] == "item_restored"
    assert reverse_event["reverses_event_id"] == deleted["event_ids"][0]


def test_resource_link_undo_unlinks(service):
    created = service.create_matter(
        {"title": "Resources"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    linked = service.add_resource(
        public_id,
        {"provider": "x", "external_key": "doc:1", "kind": "doc"},
        **mutation(1, "link"),
    )
    resource_id = linked["resources"][0]["resource"]["id"]
    undo = assert_undo_envelope(linked, tool="matter_resource_mutate", operation="unlink")
    assert undo["input"]["resource_id"] == resource_id

    undone = execute_undo(service, undo, "undo-link")
    assert service.list_resources(public_id) == []
    reverse_event = _event_row(service, undone["event_ids"][0])
    assert reverse_event["kind"] == "resource_unlinked"
    assert reverse_event["reverses_event_id"] == linked["event_ids"][0]


def test_duplicate_resource_link_is_a_noop_with_no_undo(service):
    created = service.create_matter(
        {"title": "Resources"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    first = service.add_resource(
        public_id,
        {"provider": "x", "external_key": "doc:1", "kind": "doc"},
        **mutation(1, "link-1"),
    )
    duplicate = service.add_resource(
        public_id,
        {"provider": "x", "external_key": "doc:1", "kind": "doc"},
        **mutation(first["version"], "link-2"),
    )
    assert duplicate["warnings"] == ["already_linked"]
    # Nothing was written -> nothing to reverse.
    assert duplicate["undo"] is None


def test_add_note_undo_is_item_delete_marking_retraction(service):
    created = service.create_matter(
        {"title": "Notes"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    note = service.add_note(
        public_id, {"title": "meeting note", "description": "body"},
        **mutation(1, "note"),
    )
    note_id = note["item"]["id"]
    undo = assert_undo_envelope(note, tool="matter_item_mutate", operation="delete")
    assert undo["input"]["item_id"] == note_id

    undone = execute_undo(service, undo, "undo-note")
    # Append-only retraction: the note row survives, soft-deleted, with an event.
    assert undone["item"]["id"] == note_id
    assert undone["item"]["deleted_at"] is not None
    with service.repository.connect() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM matter_item WHERE id=?", (note_id,)
            ).fetchone()[0]
            == 1
        )
    reverse_event = _event_row(service, undone["event_ids"][0])
    assert reverse_event["kind"] == "item_deleted"
    assert reverse_event["reverses_event_id"] == note["event_ids"][0]


def test_stale_undo_raises_version_conflict_after_interleaved_write(service):
    created = service.create_matter(
        {"title": "Racy"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    first = service.patch_matter(public_id, {"title": "One"}, **mutation(1, "p1"))
    stale_undo = first["undo"]

    # A later write bumps the aggregate version past the descriptor's anchor.
    service.patch_matter(public_id, {"title": "Two"}, **mutation(first["version"], "p2"))

    with pytest.raises(MatterError) as exc:
        execute_undo(service, stale_undo, "undo-stale")
    assert exc.value.code == "E_VERSION_CONFLICT"
    # And nothing was rolled back.
    assert service.get_matter(public_id)["matter"]["title"] == "Two"


def test_timestamp_transitions_expose_symmetric_undo(service):
    created = service.create_matter(
        {"title": "Cycle"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    trashed = service.trash(public_id, **mutation(1, "trash"))
    undo = assert_undo_envelope(trashed, tool="matter_update", operation="restore")

    undone = execute_undo(service, undo, "undo-trash")
    assert undone["matter"]["deleted_at"] is None
    reverse_event = _event_row(service, undone["event_ids"][0])
    assert reverse_event["kind"] == "matter_restored"
    assert reverse_event["reverses_event_id"] == trashed["event_ids"][0]
