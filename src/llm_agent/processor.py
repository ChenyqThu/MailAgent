"""LLMProcessor — main entry for classifying a single email via local LLM.

Contract:
  result = await processor.process_email(email)   # returns AILabels or raises LLMCallError

Fire-and-forget usage lives in src/mail/new_watcher.py:_maybe_trigger_llm_hook.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

from loguru import logger

from src.config import config as cfg

from .client import AnthropicClient, LLMCallError, LLMResult
from .context_loader import ContextLoader
from .prompt_loader import PromptLoader
from .schema import (
    ACTION_TYPE_INBOX,
    ACTION_TYPE_SENT,
    CATEGORY_ENUM,
    EMAIL_TOOL_SCHEMA,
    LANGUAGE_ENUM,
    MAIL_ACTIONS_ENUM,
    PRIORITY_ENUM,
    SENDER_PRIORITY_ENUM,
    is_valid_action_type,
)


_BEIJING = timezone(timedelta(hours=8))
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t]+")
_NL_RE = re.compile(r"\n{3,}")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class AILabels:
    """Parsed LLM output; passed to AIFieldsWriter for Notion pages.update."""

    ai_summary: str = ""
    key_points: str = ""
    category: str = ""
    language: str = ""
    sender_priority: str = ""
    action_required: bool = False
    action_type: str = ""
    priority: str = ""
    urgency_reason: str = ""
    mail_actions: List[str] = field(default_factory=list)
    reply_suggestion_md: str = ""
    daily_digest_date: str = ""
    related_project: str = ""
    # meta
    mailbox: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    model: str = ""
    latency_ms: int = 0

    def summary_for_log(self) -> Dict[str, Any]:
        return {
            "category": self.category,
            "priority": self.priority,
            "action_type": self.action_type,
            "action_required": self.action_required,
            "sender_priority": self.sender_priority,
            "daily_digest_date": self.daily_digest_date,
            "ai_summary": (self.ai_summary or "")[:80],
            "tokens": f"{self.input_tokens}/{self.output_tokens}",
            "cache": f"c={self.cache_creation_input_tokens} r={self.cache_read_input_tokens}",
        }


class LLMProcessor:
    """Stateful processor; reuse one instance across calls to keep caches warm."""

    def __init__(self):
        self._client = AnthropicClient()
        self._prompts = PromptLoader()
        self._context = ContextLoader()

    async def close(self):
        await self._client.close()

    async def process_email(self, email: Any) -> AILabels:
        """Classify a single email; raises LLMCallError on any failure."""
        mailbox = getattr(email, "mailbox", "") or "收件箱"
        system_blocks = await self._build_system(mailbox)
        user_msg = self._build_user(email)

        result: LLMResult = await self._client.classify(
            system_blocks=system_blocks,
            user_content=user_msg,
            tool_schema=EMAIL_TOOL_SCHEMA,
            tool_name="classify_email",
        )
        return self._parse(result, mailbox)

    # ---- system prompt -----------------------------------------------------

    async def _build_system(self, mailbox: str) -> List[Dict[str, Any]]:
        header = (
            "You are an email triage assistant. Call the `classify_email` tool "
            "EXACTLY ONCE. Never emit plain text. Never call any other tool."
        )
        blocks: List[Dict[str, Any]] = [{"type": "text", "text": header}]

        ctx_md = await self._context.get_markdown()
        if ctx_md:
            blocks.append({
                "type": "text",
                "text": (
                    "# Reference context (user profile / Sender Priority / focus projects)\n"
                    "# Read silently; never echo back.\n\n"
                    + ctx_md
                ),
                "cache_control": {"type": "ephemeral"},
            })

        mailbox_prompt = self._prompts.get_for_mailbox(mailbox)
        if mailbox_prompt:
            blocks.append({
                "type": "text",
                "text": f"# Mailbox-specific rules ({mailbox})\n\n" + mailbox_prompt,
                "cache_control": {"type": "ephemeral"},
            })

        # Final hard constraints (small, uncached)
        if mailbox == "发件箱":
            legal = "、".join(ACTION_TYPE_SENT)
        else:
            legal = "、".join(ACTION_TYPE_INBOX)
        blocks.append({
            "type": "text",
            "text": (
                f"Current mailbox = {mailbox}.\n"
                f"`action_type` 必须从 {{{legal}}} 里选；其他值会被系统拒绝。\n"
                f"`priority` 严格：🔴紧急=线上事故/阻塞；🟡重要=关键评审/deadline；"
                f"🟢一般=日常；⚪低=FYI。\n"
                f"`reply_suggestion_md` 仅在 action_required=true 时填；"
                f"Markdown 仅限 inline (**bold** *italic* ~~strike~~ `code` [t](u)) + 换行；"
                f"列表用 '- ' 前缀纯文本，禁 heading/code-block/真 list。"
                f"结尾统一加：\\n\\n----\\nBest,\\nLucien。\n"
                f"`daily_digest_date` 用邮件 Date 转 UTC+8 的日期（YYYY-MM-DD）。"
            ),
        })
        return blocks

    # ---- user message ------------------------------------------------------

    def _build_user(self, email: Any) -> str:
        body = self._plaintext_body(email)
        if len(body) > cfg.llm_body_max_chars:
            body = body[: cfg.llm_body_max_chars] + "\n...[truncated]"

        attachments = []
        for a in (getattr(email, "attachments", []) or []):
            name = (
                getattr(a, "filename", None)
                or getattr(a, "name", None)
                or (a if isinstance(a, str) else None)
            )
            if name:
                attachments.append(str(name))

        date = getattr(email, "date", None)
        date_iso = ""
        date_utc8_date = ""
        if isinstance(date, datetime):
            d = date if date.tzinfo is not None else date.replace(tzinfo=_BEIJING)
            date_iso = d.isoformat()
            date_utc8_date = d.astimezone(_BEIJING).date().isoformat()

        payload = {
            "mailbox": getattr(email, "mailbox", "") or "收件箱",
            "subject": getattr(email, "subject", "") or "",
            "from": (
                f"{(getattr(email, 'sender_name', '') or '').strip()} "
                f"<{(getattr(email, 'sender', '') or '').strip()}>"
            ).strip(),
            "to": getattr(email, "to", "") or "",
            "cc": getattr(email, "cc", "") or "",
            "date_iso": date_iso,
            "date_utc8_date": date_utc8_date,
            "thread_id": getattr(email, "thread_id", "") or "",
            "has_attachments": bool(getattr(email, "has_attachments", False)),
            "is_flagged": bool(getattr(email, "is_flagged", False)),
            "is_read": bool(getattr(email, "is_read", False)),
            "attachments": attachments[:20],
            "body_text": body,
        }
        return (
            "Classify the following email and call the classify_email tool.\n\n"
            + json.dumps(payload, ensure_ascii=False)
        )

    def _plaintext_body(self, email: Any) -> str:
        # Try .text / .plain_text first, fall back to stripping .html / .body_html
        for attr in ("text", "plain_text"):
            v = getattr(email, attr, None)
            if v:
                return _NL_RE.sub("\n\n", _WS_RE.sub(" ", v)).strip()
        for attr in ("html", "body_html"):
            v = getattr(email, attr, None)
            if v:
                stripped = _HTML_TAG_RE.sub(" ", v)
                return _NL_RE.sub("\n\n", _WS_RE.sub(" ", stripped)).strip()
        return (getattr(email, "body", "") or "").strip()

    # ---- parse / sanitize --------------------------------------------------

    def _parse(self, result: LLMResult, mailbox: str) -> AILabels:
        ti = result.tool_input or {}

        priority = ti.get("priority", "🟢 一般")
        if priority not in PRIORITY_ENUM:
            logger.warning(f"[llm] priority out-of-enum: {priority!r}; → 🟢 一般")
            priority = "🟢 一般"

        action_type = ti.get("action_type", "仅供参考")
        if not is_valid_action_type(action_type, mailbox):
            logger.warning(
                f"[llm] action_type={action_type!r} invalid for mailbox={mailbox}; → 仅供参考"
            )
            action_type = "仅供参考"

        category = ti.get("category", "")
        if category and category not in CATEGORY_ENUM:
            logger.warning(f"[llm] category {category!r} not in enum; clearing")
            category = ""

        language = ti.get("language", "")
        if language and language not in LANGUAGE_ENUM:
            logger.warning(f"[llm] language {language!r} not in enum; → Other")
            language = "Other"

        sender_priority = ti.get("sender_priority", "")
        if sender_priority and sender_priority not in SENDER_PRIORITY_ENUM:
            logger.warning(f"[llm] sender_priority {sender_priority!r} not in enum; clearing")
            sender_priority = ""

        raw_actions = ti.get("mail_actions") or []
        if not isinstance(raw_actions, list):
            raw_actions = []
        mail_actions = [a for a in raw_actions if a in MAIL_ACTIONS_ENUM]

        daily_digest_date = (ti.get("daily_digest_date") or "").strip()
        if daily_digest_date and not _DATE_RE.match(daily_digest_date):
            logger.warning(f"[llm] invalid daily_digest_date {daily_digest_date!r}; dropping")
            daily_digest_date = ""

        return AILabels(
            ai_summary=(ti.get("ai_summary") or "")[:2000],
            key_points=(ti.get("key_points") or "").strip(),
            category=category,
            language=language,
            sender_priority=sender_priority,
            action_required=bool(ti.get("action_required")),
            action_type=action_type,
            priority=priority,
            urgency_reason=(ti.get("urgency_reason") or "").strip(),
            mail_actions=mail_actions,
            reply_suggestion_md=(ti.get("reply_suggestion_md") or "").strip(),
            daily_digest_date=daily_digest_date,
            related_project=(ti.get("related_project") or "").strip(),
            mailbox=mailbox,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cache_creation_input_tokens=result.cache_creation_input_tokens,
            cache_read_input_tokens=result.cache_read_input_tokens,
            model=result.model,
            latency_ms=result.latency_ms,
        )
