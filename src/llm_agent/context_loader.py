"""ContextLoader: fetch Email Agent Context markdown from Notion with TTL cache.

Uses the ntn_ token + Notion-Version: 2025-09-03 + GET /v1/pages/{id}/markdown
path (see docs/notion_markdown_api.md). Same mechanism as project_progress.
"""

from __future__ import annotations

import asyncio
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
        headers = {
            "Authorization": f"Bearer {token}",
            "Notion-Version": _NOTION_API_VERSION,
            "User-Agent": "MailAgent-LLM/0.1",
        }
        timeout = aiohttp.ClientTimeout(total=30)
        try:
            async with aiohttp.ClientSession(timeout=timeout, headers=headers) as sess:
                parent_md = await self._fetch_page_markdown(sess, page_id)
                if not parent_md:
                    return ""

                child_pages = await self._list_child_pages(sess, page_id)
                if not child_pages:
                    return parent_md

                # 子页并行拉取 — 串行 N×RTT 是 /chat/config 慢的根源 (dogfood
                # round 3); _fetch_page_markdown 内部全 catch 返 "", gather 安全。
                child_mds = await asyncio.gather(
                    *[self._fetch_page_markdown(sess, cid) for cid, _ in child_pages]
                )
                parts = [parent_md]
                fetched = 0
                for (_child_id, title), child_md in zip(child_pages, child_mds):
                    if child_md:
                        parts.append(f"\n\n## {title}\n\n{child_md}")
                        fetched += 1
                logger.info(
                    f"[llm-context] expanded {fetched}/{len(child_pages)} child pages "
                    f"under {page_id[:8]}..."
                )
                return "\n\n".join(parts)
        except Exception as e:
            logger.warning(f"[llm-context] fetch exception: {e!r}")
            return ""

    async def _fetch_page_markdown(
        self, sess: aiohttp.ClientSession, page_id: str
    ) -> str:
        """GET /v1/pages/{id}/markdown — page body only, no child-page bodies."""
        url = f"{_NOTION_API_BASE}/pages/{page_id}/markdown"
        try:
            async with sess.get(url) as resp:
                if resp.status != 200:
                    body = (await resp.text())[:300]
                    logger.warning(
                        f"[llm-context] GET markdown status={resp.status} "
                        f"page={page_id[:8]} body={body}"
                    )
                    return ""
                data = await resp.json()
                return (data.get("markdown") or "") if isinstance(data, dict) else ""
        except Exception as e:
            logger.warning(f"[llm-context] markdown fetch exception page={page_id[:8]}: {e!r}")
            return ""

    async def _list_child_pages(
        self, sess: aiohttp.ClientSession, parent_id: str
    ) -> list[tuple[str, str]]:
        """List direct child_page blocks under a parent page.

        One level only — Notion's blocks/{id}/children does not recurse.
        Pagination handled up to 200 children (more than enough for context).
        Returns [(child_page_id, title), ...] in document order.
        """
        results: list[tuple[str, str]] = []
        cursor: Optional[str] = None
        for _ in range(2):  # up to 2 pages * 100 = 200 children
            qs = "?page_size=100"
            if cursor:
                qs += f"&start_cursor={cursor}"
            url = f"{_NOTION_API_BASE}/blocks/{parent_id}/children{qs}"
            try:
                async with sess.get(url) as resp:
                    if resp.status != 200:
                        body = (await resp.text())[:300]
                        logger.warning(
                            f"[llm-context] list children status={resp.status} "
                            f"parent={parent_id[:8]} body={body}"
                        )
                        return results
                    data = await resp.json()
            except Exception as e:
                logger.warning(
                    f"[llm-context] list children exception parent={parent_id[:8]}: {e!r}"
                )
                return results

            for block in data.get("results", []) or []:
                if block.get("type") == "child_page":
                    bid = block.get("id")
                    title = (block.get("child_page") or {}).get("title") or "Untitled"
                    if bid:
                        results.append((bid, title))

            if not data.get("has_more"):
                break
            cursor = data.get("next_cursor")
            if not cursor:
                break
        return results
