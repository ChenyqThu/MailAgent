"""LLMProcessor — two-stage agent for email classification.

Stage 1 (optional): LLM calls context tools (get_thread_context / get_sender_history)
Stage 2 (required): LLM calls classify_email with full context

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
    SENDER_HISTORY_TOOL_SCHEMA,
    THREAD_CONTEXT_TOOL_SCHEMA,
    is_valid_action_type,
)
from .tools import execute_tool


_BEIJING = timezone(timedelta(hours=8))
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t]+")
_NL_RE = re.compile(r"\n{3,}")

# Context tool names that the agent can call before classify_email
_CONTEXT_TOOLS = {"get_thread_context", "get_sender_history"}
_MAX_AGENT_TURNS = 4  # 1 initial + up to 2 context lookups + 1 final classify


def _html_to_plaintext(html: str) -> str:
    """HTML → plain text via BeautifulSoup + html2text."""
    import html2text
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "head", "title", "meta", "link"]):
        tag.decompose()
    body = soup.find("body")
    if body:
        soup = body
    h = html2text.HTML2Text()
    h.ignore_links = True
    h.ignore_images = True
    h.body_width = 0
    return h.handle(str(soup)).strip()


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_VALID_TTL = {"5m", "1h"}


def _build_cache_control() -> Dict[str, Any] | None:
    if not cfg.llm_cache_enabled:
        return None
    cc: Dict[str, Any] = {"type": "ephemeral"}
    ttl = (cfg.llm_cache_ttl or "").strip().lower()
    if ttl in _VALID_TTL:
        cc["ttl"] = ttl
    elif ttl:
        logger.warning(
            f"[llm] ignoring invalid LLM_CACHE_TTL={cfg.llm_cache_ttl!r}; "
            f"expected '' / '5m' / '1h'"
        )
    return cc


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
    confidence: float = 1.0
    # meta
    mailbox: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    model: str = ""
    latency_ms: int = 0
    agent_turns: int = 1

    def summary_for_log(self) -> Dict[str, Any]:
        return {
            "category": self.category,
            "priority": self.priority,
            "action_type": self.action_type,
            "action_required": self.action_required,
            "sender_priority": self.sender_priority,
            "daily_digest_date": self.daily_digest_date,
            "confidence": self.confidence,
            "ai_summary": (self.ai_summary or "")[:80],
            "tokens": f"{self.input_tokens}/{self.output_tokens}",
            "cache": f"c={self.cache_creation_input_tokens} r={self.cache_read_input_tokens}",
            "turns": self.agent_turns,
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
        """Classify a single email via multi-turn agent loop."""
        mailbox = getattr(email, "mailbox", "") or "收件箱"
        system_blocks = await self._build_system(mailbox)
        user_msg = self._build_user(email)
        all_tools = self._build_tool_list()

        result = await self._agent_loop(
            system_blocks=system_blocks,
            user_msg=user_msg,
            tools=all_tools,
            mailbox=mailbox,
        )
        return result

    # ---- agent loop ----------------------------------------------------------

    async def _agent_loop(
        self,
        *,
        system_blocks: List[Dict[str, Any]],
        user_msg: str,
        tools: List[Dict[str, Any]],
        mailbox: str,
    ) -> AILabels:
        """Multi-turn loop: context tools → classify_email.

        The LLM can call 0-2 context tools before calling classify_email.
        Simple emails go straight to classify (1 turn). Complex emails
        may take 2-3 turns.
        """
        messages: List[Dict[str, Any]] = [
            {"role": "user", "content": user_msg},
        ]

        total_input = 0
        total_output = 0
        total_cache_creation = 0
        total_cache_read = 0
        model_used = ""
        total_latency = 0

        for turn in range(_MAX_AGENT_TURNS):
            result: LLMResult = await self._client.classify(
                system_blocks=system_blocks,
                user_content=messages,
                tool_schema=tools,
                tool_name=None,  # don't force; let the agent choose
            )

            total_input += result.input_tokens
            total_output += result.output_tokens
            total_cache_creation += result.cache_creation_input_tokens
            total_cache_read += result.cache_read_input_tokens
            model_used = result.model
            total_latency += result.latency_ms

            tool_name = result.tool_name
            tool_input = result.tool_input or {}

            # Final classification — done
            if tool_name == "classify_email":
                labels = self._parse(result, mailbox)
                labels.input_tokens = total_input
                labels.output_tokens = total_output
                labels.cache_creation_input_tokens = total_cache_creation
                labels.cache_read_input_tokens = total_cache_read
                labels.model = model_used
                labels.latency_ms = total_latency
                labels.agent_turns = turn + 1
                logger.info(
                    f"[llm-agent] classified in {turn + 1} turn(s), "
                    f"confidence={labels.confidence:.2f}"
                )
                return labels

            # Context tool — execute and continue
            if tool_name in _CONTEXT_TOOLS:
                logger.info(f"[llm-agent] turn {turn + 1}: calling {tool_name}")
                tool_result = execute_tool(tool_name, tool_input)

                # Append assistant message with tool_use + tool_result
                messages.append({
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": result.tool_use_id or f"ctx_{turn}",
                            "name": tool_name,
                            "input": tool_input,
                        }
                    ],
                })
                messages.append({
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": result.tool_use_id or f"ctx_{turn}",
                            "content": tool_result,
                        }
                    ],
                })
                continue

            # Unexpected tool or no tool — force classify on next turn
            logger.warning(
                f"[llm-agent] unexpected tool={tool_name!r} on turn {turn + 1}; "
                f"forcing classify_email"
            )
            break

        # Fallback: force single-shot classify
        logger.warning("[llm-agent] agent loop exhausted; forcing classify_email")
        result = await self._client.classify(
            system_blocks=system_blocks,
            user_content=messages,
            tool_schema=[EMAIL_TOOL_SCHEMA],
            tool_name="classify_email",
        )
        total_input += result.input_tokens
        total_output += result.output_tokens
        total_cache_creation += result.cache_creation_input_tokens
        total_cache_read += result.cache_read_input_tokens
        total_latency += result.latency_ms

        labels = self._parse(result, mailbox)
        labels.input_tokens = total_input
        labels.output_tokens = total_output
        labels.cache_creation_input_tokens = total_cache_creation
        labels.cache_read_input_tokens = total_cache_read
        labels.model = model_used or result.model
        labels.latency_ms = total_latency
        labels.agent_turns = _MAX_AGENT_TURNS + 1
        return labels

    # ---- tool list -----------------------------------------------------------

    def _build_tool_list(self) -> List[Dict[str, Any]]:
        return [
            EMAIL_TOOL_SCHEMA,
            THREAD_CONTEXT_TOOL_SCHEMA,
            SENDER_HISTORY_TOOL_SCHEMA,
        ]

    # ---- system prompt -------------------------------------------------------

    async def _build_system(self, mailbox: str) -> List[Dict[str, Any]]:
        """Build structured system prompt with clear sections.

        Block layout (stable prefix for cache):
          1. Identity + environment
          2. Reference context (from Notion page, 30min TTL)
          3. Mailbox-specific rules (from .md files, hot-reload)
          4. Output constraints + cache_control breakpoint
        """
        now = datetime.now(_BEIJING)
        today = now.strftime("%Y-%m-%d")
        weekday_zh = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][now.weekday()]
        current_time = now.strftime("%H:%M")

        # Block 1: Identity + environment (stable)
        identity = (
            "# Role\n"
            "你是 Kevin Wang（王俊）的邮件 AI 助手。\n\n"
            "# About Kevin\n"
            "- TP-Link ENBU 产品经理\n"
            "- 负责智能家居产品线，跨部门协调研发、测试、市场\n"
            "- 日常处理：需求评审、项目进度、技术方案、跨团队沟通\n"
            "- 邮箱：kevin.wang@tp-link.com\n\n"
            "# Environment\n"
            f"- 当前时间：{today} {weekday_zh} {current_time} (UTC+8)\n"
            "- 工作时段：周一至周五 9:00-18:00\n\n"
            "# Your Task\n"
            "分析邮件，判断优先级和所需动作。你有 3 个工具：\n"
            "- `get_thread_context`: 查同线程历史邮件（可选，按需调用）\n"
            "- `get_sender_history`: 查发件人近 30 天统计（可选，按需调用）\n"
            "- `classify_email`: 输出最终分类（必须，作为最后一步调用）\n\n"
            "**流程**：先读邮件 → 需要更多上下文时调用查询工具 → "
            "最后调用 classify_email 输出结果。\n"
            "简单邮件（系统通知、newsletter）直接 classify，不需要查上下文。"
        )
        blocks: List[Dict[str, Any]] = [{"type": "text", "text": identity}]

        # Block 2: Reference context (Notion page, 30min TTL)
        ctx_md = await self._context.get_markdown()
        if ctx_md:
            blocks.append({
                "type": "text",
                "text": (
                    "# Reference Context\n"
                    "以下是 Kevin 的个人资料、发件人优先级映射、当前重点项目。"
                    "内部参考，不要回显。\n\n"
                    + ctx_md
                ),
            })

        # Block 3: Mailbox-specific rules (hot-reload .md)
        mailbox_prompt = self._prompts.get_for_mailbox(mailbox)
        if mailbox_prompt:
            blocks.append({
                "type": "text",
                "text": f"# Mailbox Rules ({mailbox})\n\n" + mailbox_prompt,
            })

        # Block 4: Output constraints (stable per-mailbox, carries cache_control)
        if mailbox == "发件箱":
            legal = "、".join(ACTION_TYPE_SENT)
        else:
            legal = "、".join(ACTION_TYPE_INBOX)

        constraints = (
            f"# Output Constraints\n"
            f"Current mailbox = {mailbox}.\n"
            f"`action_type` 必须从 {{{legal}}} 中选择。\n\n"
            f"## Priority 判定标准\n"
            f"- 🔴紧急：线上事故/发布阻塞/生产异常，且需 Kevin 立即处理\n"
            f"- 🟡重要：关键评审/版本 deadline/Kevin 在 To 中被要求反馈\n"
            f"- 🟢一般：日常更新、不需立即行动\n"
            f"- ⚪低：系统通知、newsletter、FYI\n\n"
            f"## Confidence 判定\n"
            f"- >= 0.9：明确的邮件（系统通知、清晰的请求）\n"
            f"- 0.7-0.9：需要一些判断但信息足够\n"
            f"- 0.4-0.7：模糊、信息不足、多种合理解读\n"
            f"- < 0.4：几乎无法判断\n\n"
            f"## Reply Suggestion 格式\n"
            f"仅 action_required=true 时填。"
            f"仅限 inline Markdown（**bold** *italic* ~~strike~~ `code` [text](url)）+ 换行。"
            f"列表用 '- ' 前缀纯文本。禁 heading/code-block。"
            f"签名固定：\\n\\n----\\nBest,\\nKevin\n\n"
            f"`daily_digest_date` = 邮件 Date 转 UTC+8 日期（YYYY-MM-DD）。"
        )

        final_block: Dict[str, Any] = {"type": "text", "text": constraints}
        cc = _build_cache_control()
        if cc is not None:
            final_block["cache_control"] = cc
        blocks.append(final_block)
        return blocks

    # ---- user message --------------------------------------------------------

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
            "Classify the following email.\n\n"
            + json.dumps(payload, ensure_ascii=False)
        )

    def _plaintext_body(self, email: Any) -> str:
        for attr in ("text", "plain_text"):
            v = getattr(email, attr, None)
            if v:
                return _NL_RE.sub("\n\n", _WS_RE.sub(" ", v)).strip()
        for attr in ("html", "body_html"):
            v = getattr(email, attr, None)
            if v:
                return _html_to_plaintext(v)
        content = getattr(email, "content", None)
        if content:
            ctype = (getattr(email, "content_type", "") or "").lower()
            if "html" in ctype:
                return _html_to_plaintext(content)
            return _NL_RE.sub("\n\n", _WS_RE.sub(" ", content)).strip()
        return (getattr(email, "body", "") or "").strip()

    # ---- parse / sanitize ----------------------------------------------------

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

        confidence = ti.get("confidence", 1.0)
        if not isinstance(confidence, (int, float)):
            confidence = 1.0
        confidence = max(0.0, min(1.0, float(confidence)))

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
            confidence=confidence,
            mailbox=mailbox,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cache_creation_input_tokens=result.cache_creation_input_tokens,
            cache_read_input_tokens=result.cache_read_input_tokens,
            model=result.model,
            latency_ms=result.latency_ms,
        )
