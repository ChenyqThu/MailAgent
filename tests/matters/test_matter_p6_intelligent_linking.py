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
from src.matters.resource_identity import evidence_fingerprint, rejection_resource_key
from src.matters.service import Actor, MatterService


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


def test_rejection_memory_keys_on_durable_anchors_and_moves_with_new_evidence(env):
    """拒绝记忆的判据 = 「同 resource_key 且同 durable evidence 指纹」。

    🔴 task 08-25：产建议的关键词扫描 (`discover_resource_suggestions`) 已退役，但**拒绝
    记忆本身没动** —— 会议结束 → 出席者身份匹配的提案链还在用它。这里改用只读候选引擎
    (`list_resource_candidates`，与当年产建议时是同一个 `_email_resource_candidates`) 取
    evidence，钉的还是同一件事：拒了之后同证据不再来，锚点真变了才能再来。
    """
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

    def candidate_fingerprint() -> str:
        candidate = next(
            item
            for item in service.list_resource_candidates(public_id)["items"]
            if item["external_key"] == "email:2"
        )
        return evidence_fingerprint(
            rejection_resource_key("mailagent", "email", "email:2"),
            candidate["evidence"],
        )

    before = candidate_fingerprint()
    suggested = service.add_resource(
        public_id,
        {
            "provider": "mailagent",
            "kind": "email",
            "external_key": "email:2",
            "provenance": {"evidence_fingerprint": before},
        },
        actor=Actor(kind="agent"),
        **_mutation(linked["version"], "suggest-email-2"),
    )
    assert suggested["resources"][0]["link"]["confirmed_at"] is None
    assert suggested["resources"][0]["link"]["added_by_kind"] == "agent"

    rejected = service.reject_resource_suggestion(
        public_id,
        suggested["resources"][0]["resource"]["id"],
        reason="not relevant yet",
        **_mutation(suggested["version"], "reject-suggestion"),
    )
    with service.repository.connect() as conn:
        remembered = service.repository.get_resource_rejection(
            conn,
            service.get_matter(public_id)["matter"]["id"],
            rejection_resource_key("mailagent", "email", "email:2"),
        )
    assert remembered["evidence_fingerprint"] == before

    # 加一个真锚点（这封邮件的发件人成了干系人）→ durable evidence 变了 ⇒ 指纹变了 ⇒
    # 同一封邮件可以重新被提出来。这正是「实质新证据」的定义。
    service.create_stakeholder(
        public_id,
        {"email": "new-owner@example.com", "display_name": "New Owner"},
        **_mutation(rejected["version"], "add-new-evidence"),
    )
    assert candidate_fingerprint() != before

    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM matter_relation").fetchone()[0] == 0
        assert conn.execute(
            "SELECT kind FROM matter_event WHERE dedupe_key='reject-suggestion'"
        ).fetchone()[0] == RESOURCE_SUGGESTION_REJECTED


def test_readonly_candidates_never_recall_on_keywords_alone(env):
    """只读候选恒是 `local` 档：没有 thread / 干系人硬锚的邮件一条都不进。

    🔴 task 08-25 起这是候选引擎**唯一**的调用面 —— `query` / `expand_reason` 那条关键词
    外扩通道随 `discover_resource_suggestions` 一起没了消费者（见文件头）。
    """
    service, path = env
    _insert_email(
        path, 10, thread_id="outside", subject="Project Apollo verification",
        sender="audit@example.com", snippet="Apollo evidence package",
    )
    created = service.create_matter(
        {"title": "Project Apollo"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    assert service.list_resource_candidates(public_id)["items"] == []


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
    version = linked["version"]
    suggestions = {}
    for external_key in ("email:31", "email:32"):
        added = service.add_resource(
            public_id,
            {"provider": "mailagent", "kind": "email", "external_key": external_key},
            actor=Actor(kind="agent"),
            **_mutation(version, f"suggest-{external_key}"),
        )
        version = added["version"]
        suggestions[external_key] = added["resources"][0]

    accepted = service.patch_resource(
        public_id,
        suggestions["email:31"]["resource"]["id"],
        {"confirmed": True},
        reason="arbitrary reason text",
        **_mutation(version, "accept-rate-suggestion"),
    )
    replayed = service.patch_resource(
        public_id,
        suggestions["email:31"]["resource"]["id"],
        {"confirmed": True},
        reason="arbitrary reason text",
        **_mutation(version, "accept-rate-suggestion"),
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
