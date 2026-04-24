"""Resolve a UTC+8 date string to a Daily Email Digest page_id.

Query the Daily Email Digests Notion DB, filter by `Report Date == date`,
return the first page id. 5-minute TTL cache to avoid hammering the API on
back-to-back emails arriving on the same day.

If `LLM_DAILY_DIGEST_DATABASE_ID` is empty, resolver is a no-op (returns None).
"""

from __future__ import annotations

import time
from typing import Dict, Optional, Tuple

from loguru import logger

from src.config import config as cfg
from src.notion.client import NotionClient


_TTL_SEC = 300.0


class DailyDigestResolver:
    def __init__(self, notion_client: Optional[NotionClient] = None):
        self._client = notion_client  # lazy-init below
        self._cache: Dict[str, Tuple[Optional[str], float]] = {}

    async def resolve(self, date_str: str) -> Optional[str]:
        """Return Daily Digest page_id for UTC+8 date YYYY-MM-DD; None if missing.

        Uses data_sources.query (Notion API 2025-09-03), resolving the
        data_source_id via NotionClient.get_data_source_id cache.
        """
        if not date_str:
            return None
        db_id = (cfg.llm_daily_digest_database_id or "").strip()
        if not db_id:
            return None

        cached = self._cache.get(date_str)
        if cached is not None and (time.monotonic() - cached[1]) < _TTL_SEC:
            return cached[0]

        if self._client is None:
            self._client = NotionClient()

        try:
            ds_id = await self._client.get_data_source_id(db_id)
            resp = await self._client.client.data_sources.query(
                data_source_id=ds_id,
                filter={
                    "property": cfg.llm_daily_digest_report_date_prop,
                    "date": {"equals": date_str},
                },
                page_size=1,
            )
        except Exception as e:
            logger.warning(f"[llm-digest] query failed for {date_str}: {e!r}")
            self._cache[date_str] = (None, time.monotonic())
            return None

        results = resp.get("results", []) if isinstance(resp, dict) else []
        page_id = results[0]["id"] if results else None
        self._cache[date_str] = (page_id, time.monotonic())
        if not page_id:
            logger.info(f"[llm-digest] no Daily Digest page for {date_str}")
        return page_id
