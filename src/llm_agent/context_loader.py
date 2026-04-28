"""ContextLoader: fetch Email Agent Context markdown from Notion with TTL cache.

Uses the ntn_ token + Notion-Version: 2025-09-03 + GET /v1/pages/{id}/markdown
path (see docs/notion_markdown_api.md). Same mechanism as project_progress.
"""

from __future__ import annotations

import time
from typing import Optional

import aiohttp
from loguru import logger

from src.config import config as cfg


_NOTION_API_BASE = "https://api.notion.com/v1"
_NOTION_API_VERSION = "2025-09-03"


class ContextLoader:
    def __init__(self):
        self._md: Optional[str] = None
        self._fetched_at: float = 0.0

    async def get_markdown(self, force_refresh: bool = False) -> str:
        """Return context page markdown; empty str when not configured."""
        pid = (cfg.llm_context_page_id or "").strip()
        if not pid:
            return ""

        if (
            not force_refresh
            and self._md is not None
            and (time.monotonic() - self._fetched_at) < cfg.llm_context_cache_ttl_sec
        ):
            return self._md

        md = await self._fetch(pid)
        self._md = md
        self._fetched_at = time.monotonic()
        logger.info(f"[llm-context] loaded page={pid[:8]}... chars={len(md)}")
        return md

    async def _fetch(self, page_id: str) -> str:
        token = (cfg.notion_token or "").strip()
        if not token:
            logger.warning("[llm-context] NOTION_TOKEN empty; returning empty context")
            return ""
        url = f"{_NOTION_API_BASE}/pages/{page_id}/markdown"
        headers = {
            "Authorization": f"Bearer {token}",
            "Notion-Version": _NOTION_API_VERSION,
            "User-Agent": "MailAgent-LLM/0.1",
        }
        timeout = aiohttp.ClientTimeout(total=30)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as sess:
                async with sess.get(url, headers=headers) as resp:
                    if resp.status != 200:
                        body = (await resp.text())[:300]
                        logger.warning(
                            f"[llm-context] GET markdown status={resp.status} body={body}"
                        )
                        return ""
                    data = await resp.json()
                    return (data.get("markdown") or "") if isinstance(data, dict) else ""
        except Exception as e:
            logger.warning(f"[llm-context] fetch exception: {e!r}")
            return ""
