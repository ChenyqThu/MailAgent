from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.events import (
    RESOURCE_LINKED,
    RESOURCE_SUGGESTION_ACCEPTED,
    RESOURCE_SUGGESTION_REJECTED,
    RESOURCE_UPDATED,
)
from src.matters.repository import MatterRepository
from src.matters.service import MatterError, MatterService


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "matter-p6.db"
    SyncStore(str(path))
    service = MatterService(MatterRepository(path), clock_ms=lambda: 1_800_000_000_000)
    return service, path


def _mutation(version: int, key: str) -> dict[str, object]:
    return {
        "expected_version": version,
        "idempotency_key": key,
        "source": "desktop_ui",
    }


def _insert_email(
    path, internal_id: int, *, thread_id: str, subject: str,
    sender: str, snippet: str = "",
) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO email_metadata "
            "(internal_id,message_id,thread_id,subject,sender,to_addr,date_received,snippet) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                internal_id,
                f"message-{internal_id}",
                thread_id,
                subject,
                sender,
                "owner@example.com",
                f"2026-08-{internal_id:02d}T12:00:00Z",
                snippet,
            ),
        )
        conn.commit()


def test_rejection_suppresses_same_evidence_but_new_anchor_can_resuggest(env):
    service, path = env
    _insert_email(
        path, 1, thread_id="delivery-thread", subject="Delivery baseline",
        sender="lead@example.com",
    )
    _insert_email(
        path, 2, thread_id="delivery-thread", subject="Delivery update",
        sender="new-owner@example.com", snippet="customer delivery update",
    )
    created = service.create_matter(
        {"title": "Customer delivery"},
        idempotency_key="create",
        source="desktop_ui",
    )
    public_id = created["matter"]["public_id"]
    linked = service.add_resource(
        public_id,
        {"provider": "mailagent", "kind": "email", "external_key": "email:1"},
        **_mutation(created["version"], "link-anchor"),
    )

    discovered = service.discover_resource_suggestions(public_id)
    suggestion = next(
        item for item in discovered["items"]
        if item["resource"]["external_key"] == "email:2"
    )
    assert suggestion["link"]["confirmed_at"] is None
    assert suggestion["link"]["added_by_kind"] == "agent"

    rejected = service.reject_resource_suggestion(
        public_id,
        suggestion["resource"]["id"],
        reason="not relevant yet",
        **_mutation(linked["version"] + 1, "reject-suggestion"),
    )
    repeated = service.discover_resource_suggestions(public_id)
    assert repeated["items"] == []
    assert repeated["suppressed"] == [
        {"external_key": "email:2", "reason": "rejected_same_evidence"}
    ]

    stakeholder = service.create_stakeholder(
        public_id,
        {"email": "new-owner@example.com", "display_name": "New Owner"},
        **_mutation(rejected["version"], "add-new-evidence"),
    )
    rediscovered = service.discover_resource_suggestions(public_id)
    assert [item["resource"]["external_key"] for item in rediscovered["items"]] == [
        "email:2"
    ]
    assert rediscovered["items"][0]["link"]["confirmed_at"] is None
    assert stakeholder["version"] + 1 == service.get_matter(public_id)["matter"]["version"]
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM matter_relation").fetchone()[0] == 0
        assert conn.execute(
            "SELECT kind FROM matter_event WHERE dedupe_key='reject-suggestion'"
        ).fetchone()[0] == RESOURCE_SUGGESTION_REJECTED


def test_keyword_only_discovery_requires_justified_expansion(env):
    service, path = env
    _insert_email(
        path, 10, thread_id="outside", subject="Project Apollo verification",
        sender="audit@example.com", snippet="Apollo evidence package",
    )
    created = service.create_matter(
        {"title": "Project Apollo"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    assert service.discover_resource_suggestions(public_id)["items"] == []
    with pytest.raises(MatterError) as exc_info:
        service.discover_resource_suggestions(
            public_id, expand_reason="verification"
        )
    assert exc_info.value.code == "E_INVALID_ARG"
    expanded = service.discover_resource_suggestions(
        public_id,
        query="Apollo evidence",
        expand_reason="verification",
    )
    assert expanded["expanded"] is True
    assert expanded["items"][0]["resource"]["external_key"] == "email:10"
    assert expanded["items"][0]["link"]["confirmed_at"] is None


def test_suggestion_acceptance_rate_uses_dedicated_event_kinds(env):
    service, path = env
    _insert_email(
        path, 30, thread_id="rate-thread", subject="Rate baseline",
        sender="lead@example.com",
    )
    _insert_email(
        path, 31, thread_id="rate-thread", subject="Rate accepted",
        sender="lead@example.com",
    )
    _insert_email(
        path, 32, thread_id="rate-thread", subject="Rate rejected",
        sender="lead@example.com",
    )
    created = service.create_matter(
        {"title": "Suggestion rate"}, idempotency_key="create-rate", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    linked = service.add_resource(
        public_id,
        {"provider": "mailagent", "kind": "email", "external_key": "email:30"},
        **_mutation(created["version"], "link-rate-anchor"),
    )
    discovered = service.discover_resource_suggestions(public_id)
    suggestions = {
        item["resource"]["external_key"]: item for item in discovered["items"]
    }

    accepted = service.patch_resource(
        public_id,
        suggestions["email:31"]["resource"]["id"],
        {"confirmed": True},
        reason="arbitrary reason text",
        **_mutation(linked["version"] + 1, "accept-rate-suggestion"),
    )
    replayed = service.patch_resource(
        public_id,
        suggestions["email:31"]["resource"]["id"],
        {"confirmed": True},
        reason="arbitrary reason text",
        **_mutation(linked["version"] + 1, "accept-rate-suggestion"),
    )
    assert replayed["event_ids"] == accepted["event_ids"]
    rejected = service.reject_resource_suggestion(
        public_id,
        suggestions["email:32"]["resource"]["id"],
        reason="also arbitrary",
        **_mutation(accepted["version"], "reject-rate-suggestion"),
    )
    service.patch_resource(
        public_id,
        suggestions["email:31"]["resource"]["id"],
        {"confirmed": True},
        **_mutation(rejected["version"], "patch-already-confirmed"),
    )

    with sqlite3.connect(path) as conn:
        counts = dict(
            conn.execute(
                "SELECT kind, COUNT(*) FROM matter_event "
                "WHERE kind IN (?, ?) GROUP BY kind",
                (RESOURCE_SUGGESTION_ACCEPTED, RESOURCE_SUGGESTION_REJECTED),
            )
        )
        assert counts == {
            RESOURCE_SUGGESTION_ACCEPTED: 1,
            RESOURCE_SUGGESTION_REJECTED: 1,
        }
        assert counts[RESOURCE_SUGGESTION_ACCEPTED] / sum(counts.values()) == 0.5
        assert conn.execute(
            "SELECT kind FROM matter_event WHERE dedupe_key='patch-already-confirmed'"
        ).fetchone()[0] == RESOURCE_UPDATED


def test_run_context_prepares_unconfirmed_matter_first_suggestions_without_version_bump(env):
    """跟进 run 的本地那一趟：durable anchor 建议入库，但不推事项版本号。

    🔴 0812 修法 4 起这一趟由调用方（``run_spec.assemble_matter_spec``）显式发起 ——
    ``context_snapshot`` 本身一行都不写库，见下面那条只读断言。
    """
    service, path = env
    _insert_email(
        path, 20, thread_id="run-thread", subject="Run baseline",
        sender="lead@example.com",
    )
    _insert_email(
        path, 21, thread_id="run-thread", subject="Run follow-up",
        sender="lead@example.com", snippet="new run evidence",
    )
    created = service.create_matter(
        {"title": "Run follow-up"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    linked = service.add_resource(
        public_id,
        {"provider": "mailagent", "kind": "email", "external_key": "email:20"},
        **_mutation(created["version"], "link-run-anchor"),
    )
    service.discover_resource_suggestions(public_id, limit=10, bump_version=False)
    snapshot = service.context_snapshot(public_id)
    assert "email:21" in {
        resource["external_key"] for resource in snapshot["resources"]
    }
    after = service.get_matter(public_id)["matter"]
    assert after["version"] == linked["version"]
    suggestion = next(
        item for item in service.list_resources(public_id)
        if item["resource"]["external_key"] == "email:21"
    )
    assert suggestion["link"]["confirmed_at"] is None
    assert suggestion["link"]["added_by_kind"] == "agent"


def test_context_snapshot_never_writes_and_never_self_signs_a_context_gap(env):
    """🔴 只读投影不许写库，更不许自己给自己签 `context_gap` 的条子。

    修复前：``context_snapshot`` 先跑一遍 discovery，本地候选为 0 时**自动升级**成全库
    keyword 外扩（``query=None``，最脏形态）—— 没有用户声明、没有审批，而 run_spec 用的
    正是默认值 ⇒ 每次跟进 run 自动开火。email 22/23 与事项零 durable 关联，只共享
    「follow / evidence」这类文档词；自动外扩会把它们全拉进来。
    """
    service, path = env
    _insert_email(
        path, 22, thread_id="unrelated-a", subject="Quarterly newsletter digest",
        sender="digest@example.com", snippet="follow up on evidence and delivery",
    )
    _insert_email(
        path, 23, thread_id="unrelated-b", subject="Recall notice for follow up",
        sender="noreply@example.com", snippet="this message has been recalled",
    )
    created = service.create_matter(
        {"title": "Follow up evidence", "background": "delivery follow up evidence"},
        idempotency_key="create-readonly",
        source="desktop_ui",
    )
    public_id = created["matter"]["public_id"]
    with sqlite3.connect(path) as conn:
        before = conn.execute("SELECT COUNT(*) FROM matter_resource").fetchone()[0]

    snapshot = service.context_snapshot(public_id)

    assert snapshot["resources"] == []
    assert snapshot["resource_counts"] == {
        "linked_resources": 0,
        "confirmed_resources": 0,
        "unconfirmed_suggestions": 0,
    }
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM matter_resource").fetchone()[0] == before
        assert conn.execute(
            "SELECT COUNT(*) FROM matter_event WHERE kind=?", (RESOURCE_LINKED,)
        ).fetchone()[0] == 0


def test_duplicate_candidates_use_multiple_explainable_signals_not_prefix(env):
    service, _ = env
    existing = service.create_matter(
        {"title": "Renew Acme enterprise agreement", "background": "legal review"},
        idempotency_key="existing",
        source="desktop_ui",
    )
    public_id = existing["matter"]["public_id"]
    stakeholder = service.create_stakeholder(
        public_id,
        {"email": "buyer@acme.example", "display_name": "Buyer"},
        **_mutation(existing["version"], "stakeholder"),
    )
    service.add_resource(
        public_id,
        {"provider": "x", "kind": "doc", "external_key": "contract:2026"},
        **_mutation(stakeholder["version"], "resource"),
    )

    candidates = service.duplicate_candidates(
        {
            "title": "Contract approval for strategic customer",
            "background": "Acme legal review",
            "stakeholders": ["buyer@acme.example"],
            "resources": [
                {"provider": "x", "kind": "doc", "external_key": "contract:2026"}
            ],
            "reference_at": existing["matter"]["created_at"],
        }
    )
    assert candidates[0]["matter"]["public_id"] == public_id
    kinds = {reason["kind"] for reason in candidates[0]["reasons"]}
    assert {"resource_overlap", "stakeholder_overlap", "semantic_overlap"} <= kinds
    assert candidates[0]["confidence"] > 0.7
