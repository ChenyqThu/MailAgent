"""Tests for DailyDigestResolver (mocked Notion client, no network)."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

from src.llm_agent.digest_resolver import DailyDigestResolver


def test_returns_none_when_date_empty():
    async def _():
        r = DailyDigestResolver()
        assert await r.resolve("") is None
    asyncio.run(_())


def test_returns_none_when_db_empty(monkeypatch):
    from src.llm_agent import digest_resolver as mod
    monkeypatch.setattr(mod.cfg, "llm_daily_digest_database_id", "")

    async def _():
        r = DailyDigestResolver()
        assert await r.resolve("2026-04-24") is None
    asyncio.run(_())


def _make_fake_notion(query_result=None, query_side_effect=None):
    """Build a mock NotionClient exposing get_data_source_id + data_sources.query."""
    fake_notion = MagicMock()
    fake_notion.get_data_source_id = AsyncMock(return_value="ds-id-fake")
    fake_notion.client = MagicMock()
    fake_notion.client.data_sources = MagicMock()
    if query_side_effect is not None:
        fake_notion.client.data_sources.query = AsyncMock(side_effect=query_side_effect)
    else:
        fake_notion.client.data_sources.query = AsyncMock(return_value=query_result)
    return fake_notion


def test_queries_notion_and_caches_hit(monkeypatch):
    from src.llm_agent import digest_resolver as mod
    monkeypatch.setattr(mod.cfg, "llm_daily_digest_database_id", "fake-db")
    monkeypatch.setattr(mod.cfg, "llm_daily_digest_report_date_prop", "Report Date")

    fake_notion = _make_fake_notion(
        query_result={"results": [{"id": "digest-page-abc"}]}
    )

    async def _():
        r = DailyDigestResolver(notion_client=fake_notion)
        pid = await r.resolve("2026-04-24")
        assert pid == "digest-page-abc"
        # 2nd call → cache hit, query still called once
        pid2 = await r.resolve("2026-04-24")
        assert pid2 == "digest-page-abc"
        assert fake_notion.client.data_sources.query.call_count == 1

        # filter content is correct
        call_kwargs = fake_notion.client.data_sources.query.call_args.kwargs
        assert call_kwargs["data_source_id"] == "ds-id-fake"
        assert call_kwargs["filter"] == {
            "property": "Report Date", "date": {"equals": "2026-04-24"}
        }
    asyncio.run(_())


def test_no_results_returns_none_and_caches(monkeypatch):
    from src.llm_agent import digest_resolver as mod
    monkeypatch.setattr(mod.cfg, "llm_daily_digest_database_id", "fake-db")

    fake_notion = _make_fake_notion(query_result={"results": []})

    async def _():
        r = DailyDigestResolver(notion_client=fake_notion)
        assert await r.resolve("2026-04-24") is None
        assert await r.resolve("2026-04-24") is None  # cached miss
        assert fake_notion.client.data_sources.query.call_count == 1
    asyncio.run(_())


def test_exception_returns_none_and_does_not_raise(monkeypatch):
    from src.llm_agent import digest_resolver as mod
    monkeypatch.setattr(mod.cfg, "llm_daily_digest_database_id", "fake-db")

    fake_notion = _make_fake_notion(
        query_side_effect=RuntimeError("simulated network error"),
    )

    async def _():
        r = DailyDigestResolver(notion_client=fake_notion)
        # Should not raise; returns None
        assert await r.resolve("2026-04-24") is None
    asyncio.run(_())
