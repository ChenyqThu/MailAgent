from __future__ import annotations

import os
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.api.app import app
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.api.routers.matters import get_matter_create_research_service
from src.config import notion_enabled
from src.mail.sync_store import SyncStore
from src.matters.create_research import (
    CREATE_RESEARCH_LINK_SCOPES,
    CREATE_RESEARCH_RESOURCE_REASONS,
    CREATE_RESEARCH_WARNINGS,
    MatterCreateResearchService,
)
from src.matters.models import BUILTIN_MATTER_TYPES
from src.matters.repository import MatterRepository
from src.matters.run_spec import fence_matter_excerpt
from src.matters.service import MatterService
from src.repository.email_repository import EmailRepository


def _seed_email(
    path,
    internal_id: int,
    *,
    thread_id: str,
    subject: str,
    sender: str,
    to_addr: str,
    body: str,
) -> None:
    with sqlite3.connect(path) as conn:
        message_id = f"<message-{internal_id}@example.test>"
        conn.execute(
            "INSERT INTO email_metadata (internal_id,message_id,thread_id,subject,"
            "sender,sender_name,to_addr,cc_addr,date_received,mailbox,sync_status,"
            "is_read,is_flagged,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,'synced',0,0,1,1)",
            (
                internal_id,
                message_id,
                thread_id,
                subject,
                sender,
                sender.split("@", 1)[0],
                to_addr,
                "observer@example.test",
                f"2026-08-{internal_id:02d}T12:00:00Z",
                "Inbox",
            ),
        )
        conn.execute(
            "INSERT INTO email_body (internal_id,message_id,body_markdown,body_format,"
            "body_size_bytes,has_inline_images,fetched_at,fetched_source) "
            "VALUES (?,?,?,?,?,0,1,'davmail')",
            (internal_id, message_id, body, "markdown", len(body)),
        )
        conn.commit()


def _counts(path) -> tuple[int, int]:
    with sqlite3.connect(path) as conn:
        return (
            conn.execute("SELECT COUNT(*) FROM matter").fetchone()[0],
            conn.execute("SELECT COUNT(*) FROM matter_resource").fetchone()[0],
        )


@pytest.fixture
def research_env(tmp_path):
    path = tmp_path / "matter-create-research.db"
    SyncStore(str(path))
    subject = "Apollo delivery kickoff"
    source_body = "Apollo delivery starts after security approval."
    _seed_email(
        path,
        1,
        thread_id="apollo-thread",
        subject=subject,
        sender="lead@example.test",
        to_addr="owner@example.test",
        body=source_body,
    )
    _seed_email(
        path,
        2,
        thread_id="apollo-thread",
        subject="Apollo follow-up",
        sender="customer@example.test",
        to_addr="lead@example.test",
        body="The same thread confirms the delivery date.",
    )
    _seed_email(
        path,
        3,
        thread_id="other-thread",
        subject="Security checklist",
        sender="security@example.test",
        to_addr="lead@example.test",
        body="Apollo delivery security approval evidence.",
    )
    matter_service = MatterService(MatterRepository(path))
    existing = matter_service.create_matter(
        {"title": subject, "matter_type": BUILTIN_MATTER_TYPES[0]},
        idempotency_key="existing",
        source="desktop_ui",
    )
    matter_service.create_stakeholder(
        existing["matter"]["public_id"],
        {"email": "lead@example.test"},
        expected_version=existing["version"],
        idempotency_key="existing-stakeholder",
        source="desktop_ui",
    )
    return path, subject, source_body


def test_create_draft_endpoint_is_read_only_and_skips_unconfigured_notion(
    research_env,
):
    path, subject, source_body = research_env
    settings = SimpleNamespace(matters_enabled=True, sync_store_db_path=str(path))
    notion_config = SimpleNamespace(notion_token="", email_database_id="")
    notion_calls: list[str] = []

    async def unexpected_notion_search(query: str, limit: int):
        notion_calls.append(f"{query}:{limit}")
        return []

    service = MatterCreateResearchService(
        EmailRepository(path),
        MatterService(MatterRepository(path)),
        notion_searcher=unexpected_notion_search,
        notion_is_enabled=lambda: notion_enabled(notion_config),
    )
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_matter_create_research_service] = lambda: service
    before = _counts(path)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/matters/create-draft",
                json={"internal_id": 1, "link_scope": CREATE_RESEARCH_LINK_SCOPES[0]},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["draft"]["title"] == subject
    assert data["draft"]["matter_type"] == BUILTIN_MATTER_TYPES[0]
    assert data["research"]["notion_status"] == "disabled"
    assert data["research"]["warnings"] == []
    assert notion_calls == []
    assert _counts(path) == before

    resources = data["draft"]["resources"]
    assert resources[0]["reason"]["label"] == CREATE_RESEARCH_RESOURCE_REASONS[
        "source_email"
    ]
    assert any(
        item["reason"]["label"] == CREATE_RESEARCH_RESOURCE_REASONS["same_thread"]
        for item in resources
    )
    assert any(
        item["reason"]["label"]
        == CREATE_RESEARCH_RESOURCE_REASONS["full_text_match"]
        for item in resources
    )
    expected_fence = fence_matter_excerpt(
        resource_id="email:1",
        provider="mailagent",
        excerpt=source_body,
    )
    assert expected_fence in data["draft"]["description"]
    assert resources[0]["excerpt"] == expected_fence
    assert data["draft"]["duplicate_candidates"]


@pytest.mark.asyncio
async def test_create_draft_includes_configured_notion_results(research_env):
    path, _, _ = research_env

    async def notion_search(query: str, limit: int):
        assert query
        assert limit > 0
        return [
            {
                "id": "page-id",
                "url": "https://www.notion.so/page-id",
                "properties": {
                    "Name": {
                        "type": "title",
                        "title": [{"plain_text": "Apollo rollout notes"}],
                    }
                },
            }
        ]

    service = MatterCreateResearchService(
        EmailRepository(path),
        MatterService(MatterRepository(path)),
        notion_searcher=notion_search,
        notion_is_enabled=lambda: True,
    )
    result = await service.create_draft({"internal_id": 1})

    assert result["research"]["notion_status"] == "searched"
    notion_resource = next(
        item for item in result["draft"]["resources"] if item["provider"] == "notion"
    )
    assert notion_resource["reason"]["label"] == CREATE_RESEARCH_RESOURCE_REASONS[
        "notion_search_match"
    ]


@pytest.mark.asyncio
async def test_create_draft_degrades_when_configured_notion_search_fails(research_env):
    path, _, _ = research_env

    async def failing_notion_search(query: str, limit: int):
        raise RuntimeError(f"failed: {query}:{limit}")

    service = MatterCreateResearchService(
        EmailRepository(path),
        MatterService(MatterRepository(path)),
        notion_searcher=failing_notion_search,
        notion_is_enabled=lambda: True,
    )
    result = await service.create_draft({"internal_id": 1})

    assert result["research"]["notion_status"] == "failed"
    assert result["research"]["warnings"] == [
        {
            "code": "notion_search_failed",
            "message": CREATE_RESEARCH_WARNINGS["notion_search_failed"],
        }
    ]
    assert result["draft"]["title"]
