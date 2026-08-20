from __future__ import annotations

from types import SimpleNamespace

import pytest

from src.mail import new_watcher
from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService


def mutation(version: int, key: str):
    return {"expected_version": version, "idempotency_key": key, "source": "desktop_ui"}


@pytest.fixture
def setup_subscription(tmp_path, monkeypatch):
    path = tmp_path / "watcher.db"
    SyncStore(str(path))
    repository = MatterRepository(path)
    service = MatterService(repository, clock_ms=lambda: 1_000)
    created = service.create_matter({"title": "Subscribed"}, idempotency_key="create", source="desktop_ui")
    linked = service.add_resource(
        created["matter"]["public_id"],
        {"provider": "mailagent", "external_key": "thread:thread-1", "kind": "thread", "sub_state": "active"},
        **mutation(created["version"], "thread"),
    )
    watcher = new_watcher.NewWatcher.__new__(new_watcher.NewWatcher)
    watcher.sync_store = SimpleNamespace(db_path=str(path))
    return watcher, service, linked, path


@pytest.mark.asyncio
async def test_thread_subscription_active_is_idempotent(setup_subscription):
    watcher, service, linked, _ = setup_subscription
    email = SimpleNamespace(thread_id="thread-1", subject="New reply")
    await watcher._maybe_link_matter_thread_subscriptions(email, 99)
    await watcher._maybe_link_matter_thread_subscriptions(email, 99)
    resources = service.list_resources(linked["matter"]["public_id"])
    assert [row["resource"]["external_key"] for row in resources].count("email:99") == 1
    with service.repository.connect() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM matter_event WHERE dedupe_key=?",
            (f"matter:{linked['matter']['id']}:auto_link:email:99",),
        ).fetchone()[0] == 1


@pytest.mark.asyncio
async def test_thread_subscription_paused_does_not_link(setup_subscription):
    watcher, service, linked, _ = setup_subscription
    thread_id = linked["resources"][0]["resource"]["id"]
    paused = service.patch_resource(
        linked["matter"]["public_id"], thread_id, {"sub_state": "paused"},
        **mutation(linked["version"], "pause"),
    )
    await watcher._maybe_link_matter_thread_subscriptions(
        SimpleNamespace(thread_id="thread-1", subject="Paused reply"), 100
    )
    assert all(
        row["resource"]["external_key"] != "email:100"
        for row in service.list_resources(paused["matter"]["public_id"])
    )
