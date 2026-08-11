from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.models import person_key_for_email
from src.matters.repository import MatterRepository
from src.matters.service import MatterError, MatterService


@pytest.fixture
def service(tmp_path):
    path = tmp_path / "matter-p2.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(path), clock_ms=lambda: 1_000)


def mutation(version: int, key: str):
    return {
        "expected_version": version,
        "idempotency_key": key,
        "source": "desktop_ui",
    }


def create_matter(service: MatterService, title: str = "Matter"):
    return service.create_matter(
        {"title": title}, idempotency_key=f"create-{title}", source="desktop_ui"
    )


def test_resource_identity_duplicate_link_unlink_restore_and_sub_state(service):
    created = create_matter(service)
    public_id = created["matter"]["public_id"]
    first = service.add_resource(
        public_id,
        {"provider": "mailagent", "external_key": "thread:t1", "kind": "thread", "sub_state": "active"},
        **mutation(created["version"], "link-1"),
    )
    resource_id = first["resources"][0]["resource"]["id"]
    duplicate = service.add_resource(
        public_id,
        {"provider": "mailagent", "external_key": "thread:t1", "kind": "thread", "sub_state": "active"},
        **mutation(first["version"], "link-2"),
    )
    assert duplicate["warnings"] == ["already_linked"]
    assert duplicate["version"] == first["version"]

    paused = service.patch_resource(
        public_id, resource_id, {"sub_state": "paused"},
        **mutation(first["version"], "pause"),
    )
    assert paused["link"]["sub_state"] == "paused"
    unlinked = service.unlink_resource(
        public_id, resource_id, **mutation(paused["version"], "unlink")
    )
    restored = service.restore_resource(
        public_id, resource_id, **mutation(unlinked["version"], "restore")
    )
    assert restored["version"] == unlinked["version"] + 1
    assert service.list_resources(public_id)[0]["link"]["deleted_at"] is None

    email = service.add_resource(
        public_id,
        {"provider": "mailagent", "external_key": "email:10", "kind": "email"},
        **mutation(restored["version"], "email"),
    )
    email_id = email["resources"][0]["resource"]["id"]
    with pytest.raises(MatterError, match="subscription state") as exc:
        service.patch_resource(
            public_id, email_id, {"sub_state": "active"},
            **mutation(email["version"], "bad-sub"),
        )
    assert exc.value.code == "E_INVALID_STATE"


def test_resource_write_normalizes_bare_mailagent_keys_and_availability_is_tolerant(service):
    with service.repository.transaction() as conn:
        conn.execute(
            "INSERT INTO email_metadata(internal_id,message_id,thread_id,date_received) "
            "VALUES (123,'message-123','thread-123','2026-08-11T00:00:00Z')"
        )
    created = create_matter(service, "Normalized resource")
    linked = service.add_resource(
        created["matter"]["public_id"],
        {"provider": "mailagent", "external_key": "123", "kind": "email"},
        **mutation(created["version"], "link-bare-email"),
    )
    assert linked["resources"][0]["resource"]["external_key"] == "email:123"
    with service.repository.connect() as conn:
        assert service.repository.resource_available(conn, "mailagent", "email", "123") is True
        assert service.repository.resource_available(conn, "mailagent", "email", "email:123") is True
        assert service.repository.resource_available(conn, "mailagent", "thread", "thread-123") is True
        assert service.repository.resource_available(conn, "mailagent", "thread", "thread:thread-123") is True


def test_resource_access_policy_requires_explicit_resource_scope(service):
    created = create_matter(service)
    public_id = created["matter"]["public_id"]
    linked = service.add_resource(
        public_id, {"provider": "x", "external_key": "doc:1", "kind": "doc"},
        **mutation(created["version"], "link"),
    )
    resource_id = linked["resources"][0]["resource"]["id"]
    with pytest.raises(MatterError) as exc:
        service.patch_resource(
            public_id, resource_id, {"access_policy": "excluded"},
            **mutation(linked["version"], "bad-policy"),
        )
    assert exc.value.code == "E_INVALID_ARG"
    changed = service.patch_resource(
        public_id, resource_id,
        {"scope": "resource", "access_policy": "metadata_only"},
        **mutation(linked["version"], "policy"),
    )
    assert changed["resource"]["access_policy"] == "metadata_only"


def test_stakeholder_person_key_is_stable_and_delete_clears_waiting_reference(service):
    assert person_key_for_email(" User@Example.COM ") == person_key_for_email("user@example.com")
    assert person_key_for_email(None) != person_key_for_email(None)
    created = create_matter(service)
    public_id = created["matter"]["public_id"]
    stakeholder = service.create_stakeholder(
        public_id, {"email": "User@Example.COM", "display_name": "User"},
        **mutation(created["version"], "stakeholder"),
    )
    duplicate = service.create_stakeholder(
        public_id, {"email": "user@example.com"},
        **mutation(stakeholder["version"], "stakeholder-duplicate"),
    )
    assert duplicate["warnings"] == ["already_linked"]
    item = service.create_item(
        public_id,
        {"kind": "action", "title": "Wait", "waiting_on_stakeholder_id": stakeholder["stakeholder"]["id"]},
        **mutation(stakeholder["version"], "item"),
    )
    removed = service.delete_stakeholder(
        public_id, stakeholder["stakeholder"]["id"],
        **mutation(item["version"], "remove-stakeholder"),
    )
    assert removed["version"] == item["version"] + 1
    assert service.list_items(public_id)[0]["waiting_on_stakeholder_id"] is None


def test_relation_self_loop_and_live_uniqueness(service):
    source = create_matter(service, "Source")
    target = create_matter(service, "Target")
    source_id = source["matter"]["public_id"]
    with pytest.raises(MatterError) as exc:
        service.create_relation(
            source_id, {"target_public_id": source_id, "relation_type": "related_to"},
            **mutation(source["version"], "self"),
        )
    assert exc.value.code == "E_INVALID_ARG"
    first = service.create_relation(
        source_id,
        {"target_public_id": target["matter"]["public_id"], "relation_type": "depends_on"},
        **mutation(source["version"], "relation"),
    )
    duplicate = service.create_relation(
        source_id,
        {"target_public_id": target["matter"]["public_id"], "relation_type": "depends_on"},
        **mutation(first["version"], "relation-duplicate"),
    )
    assert duplicate["warnings"] == ["already_linked"]
    assert len(service.list_relations(source_id)) == 1


def test_search_projection_matches_title_items_stakeholders_notes_and_rebuild(service):
    created = service.create_matter(
        {"title": "Alpha Project", "description": "description needle"},
        idempotency_key="search-create", source="desktop_ui",
    )
    public_id = created["matter"]["public_id"]
    item = service.create_item(
        public_id, {"kind": "action", "title": "item needle"},
        **mutation(created["version"], "search-item"),
    )
    stakeholder = service.create_stakeholder(
        public_id, {"display_name": "stakeholder needle", "email": "person@example.com"},
        **mutation(item["version"], "search-stakeholder"),
    )
    note = service.add_note(
        public_id, {"title": "note needle", "description": "note body"},
        **mutation(stakeholder["version"], "search-note"),
    )
    assert note["version"] == 4
    for query, field in (
        ("Alpha", "title"),
        ("item needle", "items"),
        ("stakeholder needle", "stakeholders"),
        ("note needle", "notes"),
        ("描述", None),
    ):
        if query == "描述":
            continue
        result = service.list_matters(filters={"q": query}, cursor=None, limit=10, sort="updated_at")
        assert result["items"]
        assert field in result["items"][0]["matched_fields"]
        assert len(result["items"][0]["snippets"][field]) <= 120
    assert service.rebuild_all_search_documents() == 1


def test_two_character_cjk_uses_like_and_three_character_uses_fts(service):
    create_matter(service, "中文搜索事项")
    two = service.list_matters(filters={"q": "中文"}, cursor=None, limit=10, sort="updated_at")
    three = service.list_matters(filters={"q": "中文搜"}, cursor=None, limit=10, sort="updated_at")
    assert len(two["items"]) == 1
    assert len(three["items"]) == 1


def test_source_email_creates_email_and_active_thread_links(service):
    with sqlite3.connect(service.repository.db_path) as conn:
        conn.execute(
            "INSERT INTO email_metadata(internal_id,subject,thread_id,sync_status) VALUES (42,'Mail title','thread-42','synced')"
        )
    created = service.create_matter(
        {"source_resource": {"provider": "mailagent", "kind": "email", "internal_id": 42, "link_scope": "thread"}},
        idempotency_key="source-email", source="desktop_ui",
    )
    assert created["matter"]["title"] == "Mail title"
    links = service.list_resources(created["matter"]["public_id"])
    assert {(row["resource"]["kind"], row["link"]["sub_state"]) for row in links} == {
        ("email", "none"), ("thread", "active")
    }


def test_source_email_without_thread_degrades_to_single(service):
    with sqlite3.connect(service.repository.db_path) as conn:
        conn.execute(
            "INSERT INTO email_metadata(internal_id,subject,sync_status) VALUES (43,'No thread','synced')"
        )
    created = service.create_matter(
        {"source_resource": {"provider": "mailagent", "kind": "email", "internal_id": 43, "link_scope": "thread"}},
        idempotency_key="source-no-thread", source="desktop_ui",
    )
    assert created["warnings"] == ["thread_unavailable"]
    assert len(created["resources"]) == 1
