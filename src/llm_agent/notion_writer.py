"""AIFieldsWriter: AILabels → Notion pages.update.

Writes the 11 LLM fields + Daily Digests relation + Processing Status.
Processing Status routing:
  - 收件箱 → "AI Reviewed"
  - 发件箱 → "已完成"  (per Email Agent Instructions §发件箱 lifecycle)

Non-overwrite mode: skip fields already non-empty on the page (useful for
retry-refill without clobbering user edits).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from loguru import logger

from src.notion.client import NotionClient

from .digest_resolver import DailyDigestResolver
from .md_to_rich_text import md_to_rich_text
from .processor import AILabels
from .schema import (
    PROCESSING_STATUS_AI_REVIEWED,
    PROCESSING_STATUS_COMPLETED,
)


def _rich(s: str, limit: int = 2000) -> Dict[str, Any]:
    return {"rich_text": [{"text": {"content": (s or "")[:limit]}}]}


def _select(name: str) -> Dict[str, Any]:
    return {"select": {"name": name}}


def _multi_select(names: List[str]) -> Dict[str, Any]:
    return {"multi_select": [{"name": n} for n in names]}


class AIFieldsWriter:
    def __init__(
        self,
        notion_client: Optional[NotionClient] = None,
        digest_resolver: Optional[DailyDigestResolver] = None,
    ):
        self._client = notion_client
        self._digest = digest_resolver or DailyDigestResolver(notion_client)

    def _lazy_client(self) -> NotionClient:
        if self._client is None:
            self._client = NotionClient()
        return self._client

    def _processing_status(self, mailbox: str) -> str:
        return (
            PROCESSING_STATUS_COMPLETED
            if mailbox == "发件箱"
            else PROCESSING_STATUS_AI_REVIEWED
        )

    def _build_props(
        self,
        labels: AILabels,
        digest_page_id: Optional[str],
    ) -> Dict[str, Any]:
        props: Dict[str, Any] = {}

        if labels.ai_summary:
            props["AI Summary"] = _rich(labels.ai_summary)
        if labels.key_points:
            props["Key Points"] = _rich(labels.key_points)
        if labels.category:
            props["Category"] = _select(labels.category)
        if labels.language:
            props["Language"] = _select(labels.language)
        if labels.sender_priority:
            props["Sender Priority"] = _select(labels.sender_priority)
        props["Action Required"] = {"checkbox": bool(labels.action_required)}
        if labels.action_type:
            props["Action Type"] = _select(labels.action_type)
        if labels.priority:
            props["Priority"] = _select(labels.priority)
        if labels.urgency_reason:
            props["Urgency Reason"] = _rich(labels.urgency_reason)
        if labels.mail_actions:
            props["Mail Actions"] = _multi_select(labels.mail_actions)
        if labels.reply_suggestion_md:
            rich = md_to_rich_text(labels.reply_suggestion_md)
            if rich:
                props["Reply Suggestion"] = {"rich_text": rich}
        if labels.related_project:
            props["Related Project"] = _rich(labels.related_project)
        if digest_page_id:
            props["Daily Digests"] = {"relation": [{"id": digest_page_id}]}

        props["Processing Status"] = _select(self._processing_status(labels.mailbox))
        return props

    async def _read_non_empty_props(self, page_id: str) -> Set[str]:
        """Return property names on the page that are already non-empty."""
        client = self._lazy_client()
        try:
            page = await client.client.pages.retrieve(page_id=page_id)
        except Exception as e:
            logger.warning(f"[llm-writer] retrieve page failed: {e!r}")
            return set()
        props = (page or {}).get("properties", {}) or {}
        non_empty: Set[str] = set()
        for name, p in props.items():
            t = p.get("type")
            if t == "rich_text":
                if p.get("rich_text"):
                    non_empty.add(name)
            elif t == "title":
                if p.get("title"):
                    non_empty.add(name)
            elif t == "select":
                if (p.get("select") or {}).get("name"):
                    non_empty.add(name)
            elif t == "multi_select":
                if p.get("multi_select"):
                    non_empty.add(name)
            elif t == "checkbox":
                # Checkbox always has value; treat False as "empty" so LLM can set it.
                if p.get("checkbox") is True:
                    non_empty.add(name)
            elif t == "relation":
                if p.get("relation"):
                    non_empty.add(name)
            elif t == "date":
                if p.get("date"):
                    non_empty.add(name)
        return non_empty

    async def write(
        self,
        page_id: str,
        labels: AILabels,
        *,
        overwrite: bool = True,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """Write labels into the Notion page. Returns a summary dict."""
        digest_page_id = None
        if labels.daily_digest_date:
            digest_page_id = await self._digest.resolve(labels.daily_digest_date)

        props = self._build_props(labels, digest_page_id)

        if not overwrite:
            existing = await self._read_non_empty_props(page_id)
            # Always allow Processing Status to advance (未处理 → AI Reviewed / 已完成)
            protected = {k for k in existing if k != "Processing Status"}
            if protected:
                logger.info(
                    f"[llm-writer] overwrite=False; skipping non-empty props: "
                    f"{sorted(protected)}"
                )
            props = {k: v for k, v in props.items() if k not in protected}

        summary = {
            "page_id": page_id,
            "mailbox": labels.mailbox,
            "processing_status": self._processing_status(labels.mailbox),
            "digest_page_id": digest_page_id,
            "written_props": sorted(props.keys()),
            "skipped_digest": bool(labels.daily_digest_date and not digest_page_id),
            "dry_run": dry_run,
        }
        if dry_run:
            logger.info(f"[llm-writer] DRY-RUN summary={summary}")
            return summary

        client = self._lazy_client()
        try:
            await client.client.pages.update(page_id=page_id, properties=props)
        except Exception as e:
            logger.error(f"[llm-writer] pages.update failed {page_id}: {e!r}")
            raise

        logger.info(
            f"[llm-writer] wrote page={page_id[:12]} props={len(props)} "
            f"status={summary['processing_status']} digest={digest_page_id}"
        )
        return summary
