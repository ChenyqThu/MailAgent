"""Anthropic async client wrapper.

Uses anthropic.AsyncAnthropic with the gateway base_url from .env.
Explicit User-Agent bypasses Cloudflare 1010 on gateways like crs.chenge.ink.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from anthropic import AsyncAnthropic
from loguru import logger

from src.config import config as cfg


# Default urllib/httpx UA can trip Cloudflare rule 1010 on some relays.
_UA = "MailAgent-LLM/0.1 (Mozilla/5.0 compatible)"

# anthropic-beta header: opt into extended cache TTL ("1h" values on
# cache_control blocks). Legal across CRS (passes through unchanged) and
# native Anthropic (required for 1h TTL). Harmless when ttl<=5m. We send
# it unconditionally so downstream code can set ttl:"1h" freely.
_ANTHROPIC_BETA = "extended-cache-ttl-2025-04-11"


@dataclass
class LLMResult:
    tool_input: Dict[str, Any]
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int
    model: str
    latency_ms: int


class LLMCallError(RuntimeError):
    """Raised on network/parse/validation failures; caller converts to retry."""


class AnthropicClient:
    def __init__(self):
        self._client: Optional[AsyncAnthropic] = None

    def _lazy(self) -> AsyncAnthropic:
        if self._client is None:
            if not cfg.llm_api_key:
                raise LLMCallError("LLM_API_KEY is empty; cannot call LLM")
            self._client = AsyncAnthropic(
                api_key=cfg.llm_api_key,
                base_url=cfg.llm_api_base,
                timeout=float(cfg.llm_timeout_sec),
                default_headers={
                    "User-Agent": _UA,
                    "anthropic-beta": _ANTHROPIC_BETA,
                },
            )
        return self._client

    async def classify(
        self,
        *,
        system_blocks: List[Dict[str, Any]],
        user_content: str,
        tool_schema: Dict[str, Any],
        tool_name: str,
    ) -> LLMResult:
        """Call LLM forcing tool_use; return parsed tool_input + usage."""
        client = self._lazy()
        t0 = time.monotonic()
        try:
            msg = await client.messages.create(
                model=cfg.llm_model,
                max_tokens=cfg.llm_max_tokens,
                system=system_blocks,
                tools=[tool_schema],
                tool_choice={"type": "tool", "name": tool_name},
                messages=[{"role": "user", "content": user_content}],
            )
        except Exception as e:
            raise LLMCallError(f"Anthropic call failed: {e!r}") from e

        latency_ms = int((time.monotonic() - t0) * 1000)

        # Find the tool_use block
        tool_use = None
        for block in msg.content:
            if getattr(block, "type", None) == "tool_use":
                tool_use = block
                break
        if tool_use is None:
            text_blocks = [
                b for b in msg.content if getattr(b, "type", None) == "text"
            ]
            preview = text_blocks[0].text if text_blocks else repr(msg.content)
            raise LLMCallError(
                f"LLM did not return tool_use; stop_reason={msg.stop_reason} "
                f"preview={preview[:200]!r}"
            )
        if tool_use.name != tool_name:
            raise LLMCallError(
                f"Expected tool {tool_name!r} but got {tool_use.name!r}"
            )

        usage = msg.usage
        return LLMResult(
            tool_input=dict(tool_use.input or {}),
            input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
            output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
            cache_creation_input_tokens=int(
                getattr(usage, "cache_creation_input_tokens", 0) or 0
            ),
            cache_read_input_tokens=int(
                getattr(usage, "cache_read_input_tokens", 0) or 0
            ),
            model=msg.model,
            latency_ms=latency_ms,
        )

    async def close(self):
        if self._client is not None:
            try:
                await self._client.close()
            except Exception as e:
                logger.debug(f"[llm-client] close ignored err: {e!r}")
            self._client = None
