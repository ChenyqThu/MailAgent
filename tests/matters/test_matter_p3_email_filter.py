"""P3 D8 coverage: email retrieval matter-scope filtering (repository level).

Semantics authority: p3-decisions.md D8 — the matter association set is
matter_resource JOIN resource (provider='mailagent'), where `email:{iid}` keys
resolve directly and `thread:{tid}` keys expand to every email_metadata row with
that thread_id. `list_metadata(matter_id=)` and
`search_email_bodies_with_meta(matter_id=)` must only return hits inside that
set; no matter_id = existing behaviour untouched.
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService
from src.repository import EmailRepository

EMAILS = (
    # (internal_id, thread_id, subject, sender, body)
    (101, "T1", "Alpha kickoff", "alice@example.test", "needle alpha kickoff body"),
    (102, "T1", "Alpha follow-up", "alice@example.test", "needle alpha follow body"),
    (103, "T2", "Beta planning", "alice@example.test", "needle beta plan body"),
    (104, None, "Gamma misc", "bob@example.test", "needle gamma misc body"),
)


def _seed_emails(db_path: str) -> None:
    conn = sqlite3.connect(db_path)
    try:
        for iid, thread_id, subject, sender, body in EMAILS:
            conn.execute(
                "INSERT INTO email_metadata (internal_id, message_id, thread_id, "
                "subject, sender, sender_name, to_addr, date_received, mailbox, "
                "sync_status, is_read, is_flagged, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,0,0,1,1)",
                (
                    iid, f"<msg-{iid}@example.test>", thread_id, subject, sender,
                    sender.split("@")[0], "me@example.test",
                    f"2026-05-0{iid - 100} 09:00:00", "收件箱", "synced",
                ),
            )
            # email_body insert fires the email_body_fts trigger (real schema).
            conn.execute(
                "INSERT INTO email_body (internal_id, message_id, body_markdown, "
                "body_format, body_size_bytes, has_inline_images, fetched_at, "
                "fetched_source) VALUES (?,?,?,?,?,0,1,'davmail')",
                (iid, f"<msg-{iid}@example.test>", body, "markdown", len(body)),
            )
        conn.commit()
    finally:
        conn.close()


@pytest.fixture
def env(tmp_path):
    """Real-schema DB + a matter linked to email:104 (direct) and thread:T1 (expand)."""
    path = tmp_path / "matter-email.db"
    SyncStore(str(path))
    _seed_emails(str(path))
    service = MatterService(MatterRepository(path), clock_ms=lambda: 1_000)

    linked = service.create_matter(
        {"title": "Linked Matter"}, idempotency_key="create-linked", source="desktop_ui"
    )
    linked_pid = linked["matter"]["public_id"]
    after_email = service.add_resource(
        linked_pid,
        {"provider": "mailagent", "external_key": "email:104", "kind": "email"},
        expected_version=linked["version"], idempotency_key="link-email",
        source="desktop_ui",
    )
    after_thread = service.add_resource(
        linked_pid,
        {"provider": "mailagent", "external_key": "thread:T1", "kind": "thread"},
        expected_version=after_email["version"], idempotency_key="link-thread",
        source="desktop_ui",
    )

    empty = service.create_matter(
        {"title": "No Email Links"}, idempotency_key="create-empty", source="desktop_ui"
    )
    service.add_resource(
        empty["matter"]["public_id"],
        {"provider": "x", "external_key": "doc:1", "kind": "doc"},
        expected_version=empty["version"], idempotency_key="link-doc",
        source="desktop_ui",
    )

    repo = EmailRepository(db_path=str(path), trigram_enabled=False)
    return {
        "repo": repo,
        "service": service,
        "linked_pid": linked_pid,
        "linked_id": linked["matter"]["id"],
        "empty_id": empty["matter"]["id"],
        "thread_resource_id": after_thread["resources"][0]["resource"]["id"],
        "version": after_thread["version"],
    }


def _list_ids(repo: EmailRepository, **kwargs) -> set[int]:
    return {record.internal_id for record in repo.list_metadata(**kwargs)["emails"]}


def _search_ids(repo: EmailRepository, query: str, **kwargs) -> set[int]:
    result = repo.search_email_bodies_with_meta(query, **kwargs)
    return {hit.internal_id for hit in result.hits}


def test_list_metadata_matter_filter_email_direct_and_thread_expansion(env):
    repo = env["repo"]
    result = repo.list_metadata(matter_id=env["linked_id"])
    ids = {record.internal_id for record in result["emails"]}
    # thread:T1 expands to 101+102; email:104 resolves directly; 103 stays out.
    assert ids == {101, 102, 104}
    assert result["total"] == 3


def test_list_metadata_without_matter_id_is_unchanged(env):
    repo = env["repo"]
    assert _list_ids(repo) == {101, 102, 103, 104}
    # matter_id composes with ordinary filters instead of replacing them.
    assert _list_ids(repo, matter_id=env["linked_id"], sender_substr="bob") == {104}


def test_list_metadata_matter_without_email_links_returns_empty(env):
    repo = env["repo"]
    result = repo.list_metadata(matter_id=env["empty_id"])
    assert result["emails"] == []
    assert result["total"] == 0


def test_unlinked_thread_resource_leaves_matter_scope(env):
    # Soft-deleted links (mr.deleted_at) must drop out of the association set.
    env["service"].unlink_resource(
        env["linked_pid"], env["thread_resource_id"],
        expected_version=env["version"], idempotency_key="unlink-thread",
        source="desktop_ui",
    )
    assert _list_ids(env["repo"], matter_id=env["linked_id"]) == {104}


def test_search_smart_mode_matter_filter(env):
    repo = env["repo"]
    # Every seeded body matches "needle"; the matter scope must cut 103.
    assert _search_ids(repo, "needle") == {101, 102, 103, 104}
    assert _search_ids(repo, "needle", matter_id=env["linked_id"]) == {101, 102, 104}
    assert _search_ids(repo, "needle", matter_id=env["empty_id"]) == set()
    # The FTS query itself still applies inside the scope.
    assert _search_ids(repo, "alpha", matter_id=env["linked_id"]) == {101, 102}


def test_search_raw_mode_matter_filter(env):
    repo = env["repo"]
    assert _search_ids(repo, "needle", mode="raw") == {101, 102, 103, 104}
    assert _search_ids(repo, "needle", mode="raw", matter_id=env["linked_id"]) == {
        101, 102, 104,
    }


def test_search_parsed_dsl_path_matter_filter(env):
    repo = env["repo"]
    # `from:` forces the parsed (non-plain-passthrough) DSL path.
    assert _search_ids(repo, "needle from:alice") == {101, 102, 103}
    assert _search_ids(repo, "needle from:alice", matter_id=env["linked_id"]) == {
        101, 102,
    }
