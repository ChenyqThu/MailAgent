from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

from src.repository.email_models import ContactSuggestion
from src.repository.email_repository import _CONTACT_SUGGEST_CACHE


def test_email_contacts_endpoint_aggregates_and_excludes(client, temp_db: Path):
    _CONTACT_SUGGEST_CACHE.clear()
    now = time.time()
    conn = sqlite3.connect(str(temp_db))
    try:
        conn.execute(
            """INSERT INTO email_metadata
               (internal_id, message_id, subject, sender, sender_name, to_addr,
                cc_addr, date_received, mailbox, is_read, is_flagged, sync_status,
                retry_count, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                9101,
                "<contacts-9101@example.com>",
                "contacts sent",
                "me@example.com",
                "Me",
                "Last, Jane API <jane.api@example.com>, Api Bob <bob.api@example.com>",
                "",
                "2026-06-10T10:00:00+08:00",
                "发件箱",
                1,
                0,
                "synced",
                0,
                now,
                now,
            ),
        )
        conn.execute(
            """INSERT INTO email_metadata
               (internal_id, message_id, subject, sender, sender_name, to_addr,
                cc_addr, date_received, mailbox, is_read, is_flagged, sync_status,
                retry_count, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                9102,
                "<contacts-9102@example.com>",
                "contacts incoming",
                "jane.api@example.com",
                "Jane API Latest",
                "Me <me@example.com>",
                "",
                "2026-06-12T10:00:00+08:00",
                "收件箱",
                0,
                0,
                "synced",
                0,
                now,
                now,
            ),
        )
        conn.commit()
        _CONTACT_SUGGEST_CACHE.clear()

        r = client.get(
            "/api/email/contacts",
            params={"q": "jane.api", "limit": 5, "exclude": "me@example.com"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "success"

        items = body["data"]["items"]
        assert items[0]["email"] == "jane.api@example.com"
        assert items[0]["name"] == "Jane API Latest"
        assert items[0]["score"] == 4
        assert all(item["email"] != "me@example.com" for item in items)
    finally:
        conn.execute("DELETE FROM email_metadata WHERE internal_id IN (?, ?)", (9101, 9102))
        conn.commit()
        conn.close()
        _CONTACT_SUGGEST_CACHE.clear()


def test_email_contacts_endpoint_offloads_to_worker_thread(client, monkeypatch):
    import asyncio
    from src.api.app import app
    from src.api.deps import get_repository

    caller_threads: list[int] = []
    loop_threads: list[int] = []
    orig_to_thread = asyncio.to_thread

    async def spy_to_thread(func, /, *args, **kwargs):
        loop_threads.append(threading.get_ident())
        return await orig_to_thread(func, *args, **kwargs)

    class StubRepo:
        def suggest_contacts(self, q: str = "", *, limit: int = 8, exclude=None):
            caller_threads.append(threading.get_ident())
            return [
                ContactSuggestion(
                    email="alice@example.com",
                    name="Alice",
                    score=5,
                    last_seen=None,
                )
            ]

    monkeypatch.setattr(asyncio, "to_thread", spy_to_thread)
    monkeypatch.setitem(app.dependency_overrides, get_repository, lambda: StubRepo())
    r = client.get("/api/email/contacts", params={"q": "alice", "limit": 5})
    assert r.status_code == 200
    assert len(loop_threads) == 1
    assert len(caller_threads) == 1
    assert caller_threads[0] != loop_threads[0]
