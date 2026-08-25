"""P3 D5 service-level coverage: context_snapshot.

Semantics authority: .trellis/tasks/08-09-mailagent-matters-mvp-p0-p7/research/p3-decisions.md
- D5: bounded projection (items<=50 open / stakeholders<=20 / pinned resources<=10
  with excerpt<=2000 chars / events<=30 since last accepted update, falling back to
  matter creation when none).

D8 (chat scope switch audit) 已随 0812 dogfood 的检索范围开关移除一并退役 —— 见文件末尾注释。
"""

from __future__ import annotations

import json

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterError, MatterService


class Clock:
    """Mutable millisecond clock so tests can move `happened_at` deterministically."""

    def __init__(self, now: int = 1_000):
        self.now = now

    def __call__(self) -> int:
        return self.now

    def tick(self, ms: int = 1_000) -> int:
        self.now += ms
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def service(tmp_path, clock: Clock) -> MatterService:
    path = tmp_path / "matter-p3.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(path), clock_ms=clock)


def mutation(version: int, key: str) -> dict:
    return {
        "expected_version": version,
        "idempotency_key": key,
        "source": "desktop_ui",
    }


# ===========================================================================
# context_snapshot
# ===========================================================================


def test_context_snapshot_core_fields_and_summary_accepted_at(service, clock):
    created = service.create_matter(
        {
            "title": "Snapshot Matter",
            "background": "the background",
            "goal": "the goal",
            "matter_type": "客户交付",
            "tags": ["vip", "q3"],
            "priority": "p0",
            # A3 起 due_at 必须是真实 epoch 毫秒（<10^12 会被 E_INVALID_ARG 拒掉）。
            "due_at": 1_786_690_800_000,
            "waiting_context": {"who": "acme"},
        },
        idempotency_key="create",
        source="desktop_ui",
    )
    public_id = created["matter"]["public_id"]

    # No accepted update yet -> summary_accepted_at falls back to created_at.
    snapshot = service.context_snapshot(public_id)
    assert snapshot["matter"]["summary_accepted_at"] == created["matter"]["created_at"]

    accept_time = clock.tick()
    patched = service.patch_matter(
        public_id,
        {"status": "active", "health": "on_track", "current_summary": "All good"},
        **mutation(1, "manual"),
    )
    snapshot = service.context_snapshot(public_id)
    core = snapshot["matter"]

    # D5 core field list (matter_type is renamed to `type` on the wire).
    # goal_checks joined in 0813 轮 3 O2 —— 跟进 run / 事项对话必须看得见「怎样算做完」。
    assert set(core) == {
        "id",
        "public_id",
        "title",
        "type",
        "tags",
        "status",
        "health",
        "priority",
        "due_at",
        "waiting_context",
        # v61：背景与目标是两个独立字段，快照两个都投（跟进 run 少任何一个都在瞎判断）。
        "background",
        "goal",
        "goal_checks",
        "current_summary",
        "version",
        "summary_accepted_at",
    }
    assert core["public_id"] == public_id
    assert core["type"] == "客户交付"
    assert core["tags"] == ["vip", "q3"]
    assert core["status"] == "active"
    assert core["health"] == "on_track"
    assert core["priority"] == "p0"
    assert core["due_at"] == 1_786_690_800_000
    assert core["waiting_context"] == {"who": "acme"}
    assert core["current_summary"] == "All good"
    assert core["version"] == patched["version"]
    # Accepted update timestamp now wins over created_at.
    assert core["summary_accepted_at"] == accept_time
    assert set(snapshot) == {
        "matter",
        "items",
        "stakeholders",
        # curated 进展（task 08-25）：跟进 run 与事项对话共用的「这件事到哪一步了」。
        "progress",
        "resources",
        "resource_counts",
        "events",
    }


def test_context_snapshot_caps_items_stakeholders_resources(service, clock):
    created = service.create_matter(
        {"title": "Bounded"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    version = created["version"]

    # 3 closed items first (would land in the first-50 window if not excluded),
    # then 52 open ones -> snapshot must show exactly 50 open items, none closed.
    for i, status in enumerate(("done", "canceled", "done")):
        clock.tick()
        result = service.create_item(
            public_id,
            {"kind": "action", "title": f"closed-{i}", "status": status},
            **mutation(version, f"closed-{i}"),
        )
        version = result["version"]
    for i in range(52):
        clock.tick()
        result = service.create_item(
            public_id,
            {"kind": "action", "title": f"open-{i}"},
            **mutation(version, f"open-{i}"),
        )
        version = result["version"]

    # 24 ordinary stakeholders, then the waiting-on one LAST (highest id):
    # the <=20 window sorts is_waiting_on DESC so it must still be included first.
    for i in range(24):
        clock.tick()
        result = service.create_stakeholder(
            public_id,
            {"email": f"person{i}@example.com", "display_name": f"P{i}"},
            **mutation(version, f"sh-{i}"),
        )
        version = result["version"]
    clock.tick()
    result = service.create_stakeholder(
        public_id,
        {
            "email": "waiting@example.com",
            "display_name": "Waiting One",
            "is_waiting_on": True,
        },
        **mutation(version, "sh-waiting"),
    )
    version = result["version"]

    # 12 pinned + 1 unpinned resource -> snapshot returns only 10, pinned-only.
    for i in range(12):
        clock.tick()
        result = service.add_resource(
            public_id,
            {"provider": "x", "external_key": f"doc:{i}", "kind": "doc", "pinned": True},
            **mutation(version, f"res-{i}"),
        )
        version = result["version"]
    clock.tick()
    result = service.add_resource(
        public_id,
        {"provider": "x", "external_key": "doc:unpinned", "kind": "doc"},
        **mutation(version, "res-unpinned"),
    )

    snapshot = service.context_snapshot(public_id)

    assert len(snapshot["items"]) == 50
    titles = {item["title"] for item in snapshot["items"]}
    assert not titles & {"closed-0", "closed-1", "closed-2"}
    assert snapshot["items"][0]["title"] == "open-0"

    assert len(snapshot["stakeholders"]) == 20
    assert snapshot["stakeholders"][0]["display_name"] == "Waiting One"
    assert snapshot["stakeholders"][0]["is_waiting_on"] is True

    assert len(snapshot["resources"]) == 10
    assert all(r["external_key"] != "doc:unpinned" for r in snapshot["resources"])

    # The write burst above generated way more than 30 events.
    assert len(snapshot["events"]) == 30


def test_context_snapshot_event_cap_keeps_most_recent(service, clock):
    created = service.create_matter(
        {"title": "Events"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    version = created["version"]
    for i in range(35):
        clock.tick()
        result = service.create_item(
            public_id,
            {"kind": "action", "title": f"item-{i}"},
            **mutation(version, f"evt-{i}"),
        )
        version = result["version"]

    events = service.context_snapshot(public_id)["events"]
    assert len(events) == 30
    # happened_at DESC — newest first; the oldest events (matter_created and the
    # first item batch) fall off the window.
    assert events[0]["happened_at"] > events[-1]["happened_at"]
    assert all(event["kind"] == "item_created" for event in events)
    # Event projection is structured-only (no free-form payload passthrough).
    assert all(
        set(event) == {"kind", "happened_at", "actor_kind", "summary"}
        for event in events
    )


def test_context_snapshot_event_window_starts_at_last_accepted_update(service, clock):
    created = service.create_matter(
        {"title": "Windowed"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]

    clock.tick()
    early = service.create_item(
        public_id, {"kind": "action", "title": "early"}, **mutation(1, "early")
    )

    # No accepted update yet -> window falls back to creation: both events visible.
    kinds = [event["kind"] for event in service.context_snapshot(public_id)["events"]]
    assert "matter_created" in kinds
    assert "item_created" in kinds

    clock.tick()
    accepted = service.patch_matter(
        public_id,
        {"current_summary": "checkpoint"},
        **mutation(early["version"], "accept"),
    )
    clock.tick()
    service.create_item(
        public_id, {"kind": "action", "title": "late"}, **mutation(accepted["version"], "late")
    )

    events = service.context_snapshot(public_id)["events"]
    kinds = [event["kind"] for event in events]
    # Only the accepted update itself + later activity remain in the window.
    assert kinds == ["item_created", "matter_updated"]
    # matter_updated payload carries `fields` -> structured summary uses it.
    matter_updated = next(e for e in events if e["kind"] == "matter_updated")
    assert matter_updated["summary"].startswith("fields=")
    assert matter_updated["actor_kind"] == "user"


def test_context_snapshot_excerpt_is_truncated_and_optional(service, clock):
    created = service.create_matter(
        {"title": "Excerpts"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    long_excerpt = "x" * 5_000

    with_excerpt = service.add_resource(
        public_id,
        {
            "provider": "x",
            "external_key": "doc:long",
            "kind": "doc",
            "pinned": True,
            "metadata": {
                "cached_excerpt": long_excerpt,
                "body": "B" * 3_000,
                "internal_id": 42,
                "message_id": "<m42@example.test>",
                "date_received": "2026-05-01 09:00:00",
            },
        },
        **mutation(created["version"], "res-long"),
    )
    snippet_only = service.add_resource(
        public_id,
        {
            "provider": "x",
            "external_key": "doc:snippet",
            "kind": "doc",
            "pinned": True,
            "metadata": {"snippet": "short snippet"},
        },
        **mutation(with_excerpt["version"], "res-snippet"),
    )
    service.add_resource(
        public_id,
        {
            "provider": "x",
            "external_key": "doc:bare",
            "kind": "doc",
            "pinned": True,
            "metadata": {"revision_note": "no excerpt keys"},
        },
        **mutation(snippet_only["version"], "res-bare"),
    )

    resources = {
        r["external_key"]: r for r in service.context_snapshot(public_id)["resources"]
    }
    assert len(resources["doc:long"]["excerpt"]) == 2_000
    assert resources["doc:long"]["excerpt"] == long_excerpt[:2_000]
    assert resources["doc:snippet"]["excerpt"] == "short snippet"
    assert resources["doc:bare"]["excerpt"] is None
    # Bounded projection shape: metadata + excerpt, no body/content field.
    assert set(resources["doc:long"]) == {
        "id",
        "kind",
        "provider",
        "external_key",
        "title",
        "canonical_url",
        "revision",
        "access_policy",
        "metadata",
        "excerpt",
    }

    # 🔴 D5 bound is real, not just the `excerpt` field: metadata is a whitelist
    # projection — free-text keys (cached_excerpt / body / snippet / ...) must NOT
    # ride out untruncated through metadata. Excerpts leave only via `excerpt`.
    assert resources["doc:long"]["metadata"] == {
        "internal_id": 42,
        "message_id": "<m42@example.test>",
        "date_received": "2026-05-01 09:00:00",
    }
    assert resources["doc:snippet"]["metadata"] == {}
    assert resources["doc:bare"]["metadata"] == {}
    for entry in resources.values():
        assert set(entry["metadata"]) <= {
            "internal_id",
            "message_id",
            "thread_id",
            "date_received",
        }
    # Whole-entry serialized size stays bounded even with a 5000-char excerpt +
    # 3000-char body seeded into metadata (2000-char excerpt + short structured
    # fields only). Regression guard against reintroducing metadata passthrough.
    assert len(json.dumps(resources["doc:long"], ensure_ascii=False)) < 2_600


def test_context_snapshot_unknown_matter_raises(service):
    with pytest.raises(MatterError) as exc:
        service.context_snapshot("MAT-9999")
    assert exc.value.code == "E_MATTER_NOT_FOUND"


# 0812 dogfood —— `record_chat_scope` 已随「本事项 / 全库」检索范围开关一并移除（默认恒
# 全库），本节四个 D8 用例随方法删除。历史 `chat_scope_*` 事件行仍要能渲染，那条保证在前端
# `matterTimelineModel` 的 legacy 用例里。
