"""Local LLM Agent — replaces Notion Custom Agent for email AI-field filling.

Default disabled via LLM_AGENT_ENABLED=false in .env.
See CLAUDE.md §LLM Agent for enable steps (including Notion automation pause).
"""

from .client import AnthropicClient, LLMCallError, LLMResult
from .context_loader import ContextLoader
from .digest_resolver import DailyDigestResolver
from .md_to_rich_text import md_to_rich_text
from .notion_writer import AIFieldsWriter
from .processor import AILabels, LLMProcessor
from .prompt_loader import PromptLoader
from .runner import LLMRunner
from .schema import (
    EMAIL_TOOL_SCHEMA,
    PROCESSING_STATUS_AI_REVIEWED,
    PROCESSING_STATUS_COMPLETED,
    SENDER_HISTORY_TOOL_SCHEMA,
    THREAD_CONTEXT_TOOL_SCHEMA,
)
from .store import LLMProcessingStore
from .tools import execute_tool

__all__ = [
    "AnthropicClient",
    "LLMCallError",
    "LLMResult",
    "ContextLoader",
    "DailyDigestResolver",
    "md_to_rich_text",
    "AIFieldsWriter",
    "AILabels",
    "LLMProcessor",
    "PromptLoader",
    "LLMRunner",
    "EMAIL_TOOL_SCHEMA",
    "PROCESSING_STATUS_AI_REVIEWED",
    "PROCESSING_STATUS_COMPLETED",
    "SENDER_HISTORY_TOOL_SCHEMA",
    "THREAD_CONTEXT_TOOL_SCHEMA",
    "LLMProcessingStore",
    "execute_tool",
]
