"""LLM gateway client with multi-model fallback (Anthropic + OpenAI proto).

Despite the historical name `AnthropicClient`, this routes per model:
  - claude-* → Anthropic Messages (`/v1/messages`) + native tool_use
  - gpt-* / gemini-* / codex-* → OpenAI Chat Completions
    (`/v1/chat/completions`, stream-only on CRS) + tool_calls

`classify()` walks the model chain `[cfg.llm_model, *cfg.llm_fallback_models]`
in order, returning the first success. An LLMCallError on one model triggers
a fallback to the next; the last model's error is re-raised when all fail.

Notes:
  - Cache_control breakpoints are emitted (Anthropic-only). OpenAI legs flatten
    system blocks to plain text and ignore cache_control naturally.
  - The OpenAI leg returns 0 for cache token counters (no cache there).
"""

from __future__ import annotations

import json as _json
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx
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

# Models matching these prefixes go via the OpenAI Chat Completions endpoint
# on CRS (it routes non-Anthropic providers through /v1/chat/completions).
_OPENAI_PROTO_PREFIXES = ("gpt-", "gemini-", "codex-")


@dataclass
class LLMResult:
    tool_input: Dict[str, Any]
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int
    model: str
    latency_ms: int
    tool_name: str = ""
    tool_use_id: str = ""


class LLMCallError(RuntimeError):
    """Raised on network/parse/validation failures; caller converts to retry."""


def _is_openai_proto(model: str) -> bool:
    return model.lower().startswith(_OPENAI_PROTO_PREFIXES)


def _resolve_model_chain(override: Optional[List[str]] = None) -> List[str]:
    """Return [primary, *fallbacks] from config (or `override`), de-duplicated."""
    if override is not None:
        chain = [m for m in override if m]
    else:
        chain = [cfg.llm_model] if cfg.llm_model else []
        raw = (cfg.llm_fallback_models or "").strip()
        if raw:
            for m in raw.split(","):
                m = m.strip()
                if m:
                    chain.append(m)
    seen = set()
    deduped: List[str] = []
    for m in chain:
        if m not in seen:
            seen.add(m)
            deduped.append(m)
    return deduped


def _flatten_system_to_text(blocks: List[Dict[str, Any]]) -> str:
    """OpenAI chat doesn't accept multi-block system or cache_control; concat text."""
    parts: List[str] = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        t = b.get("text")
        if t:
            parts.append(t)
    return "\n\n".join(parts)


def _to_openai_tool(schema: Dict[str, Any]) -> Dict[str, Any]:
    """Convert Anthropic tool schema → OpenAI function tool schema."""
    return {
        "type": "function",
        "function": {
            "name": schema.get("name", ""),
            "description": schema.get("description", ""),
            "parameters": schema.get("input_schema") or {"type": "object", "properties": {}},
        },
    }


class AnthropicClient:
    """LLM client with per-model protocol routing + automatic fallback chain."""

    def __init__(self):
        self._client: Optional[AsyncAnthropic] = None
        self._http: Optional[httpx.AsyncClient] = None

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

    def _lazy_http(self) -> httpx.AsyncClient:
        if self._http is None:
            if not cfg.llm_api_key:
                raise LLMCallError("LLM_API_KEY is empty; cannot call LLM")
            base = (cfg.llm_api_base or "").rstrip("/")
            self._http = httpx.AsyncClient(
                base_url=base,
                timeout=float(cfg.llm_timeout_sec),
                headers={
                    "Authorization": f"Bearer {cfg.llm_api_key}",
                    "User-Agent": _UA,
                    "Accept": "text/event-stream",
                },
            )
        return self._http

    async def classify(
        self,
        *,
        system_blocks: List[Dict[str, Any]],
        user_content: Any,  # str (single turn) or List[Dict] (multi-turn messages)
        tool_schema: Any,  # single dict or list of dicts
        tool_name: Optional[str] = None,  # None = auto, str = force specific tool
        model_chain: Optional[List[str]] = None,
    ) -> LLMResult:
        """Call LLM with tool_use; walk fallback chain on LLMCallError.

        Args:
            user_content: either a plain string (wrapped as single user message)
                or a list of message dicts for multi-turn conversations.
            tool_schema: a single tool dict or a list of tool dicts.
            tool_name: if set, forces that specific tool; if None, lets LLM choose.
        """
        chain = _resolve_model_chain(model_chain)
        if not chain:
            raise LLMCallError("model chain is empty (LLM_MODEL unset?)")

        # Normalize tool_schema to list
        tools = tool_schema if isinstance(tool_schema, list) else [tool_schema]

        # Normalize messages
        if isinstance(user_content, str):
            messages = [{"role": "user", "content": user_content}]
        else:
            messages = user_content

        last_err: Optional[BaseException] = None
        for i, model in enumerate(chain):
            try:
                if _is_openai_proto(model):
                    return await self._classify_openai(
                        model=model,
                        system_blocks=system_blocks,
                        user_content=messages,
                        tool_schema=tools,
                        tool_name=tool_name,
                    )
                return await self._classify_anthropic(
                    model=model,
                    system_blocks=system_blocks,
                    user_content=messages,
                    tool_schema=tools,
                    tool_name=tool_name,
                )
            except LLMCallError as e:
                last_err = e
                if i + 1 < len(chain):
                    nxt = chain[i + 1]
                    logger.warning(
                        f"[llm] model={model} failed, falling back to {nxt}: {e}"
                    )
                    continue
                logger.warning(f"[llm] model={model} failed (last in chain): {e}")
                raise
        raise last_err or LLMCallError("model chain exhausted without result")

    # ---- Anthropic leg -----------------------------------------------------

    async def _classify_anthropic(
        self,
        *,
        model: str,
        system_blocks: List[Dict[str, Any]],
        user_content: Any,  # List[Dict] (messages)
        tool_schema: List[Dict[str, Any]],
        tool_name: Optional[str],
    ) -> LLMResult:
        client = self._lazy()
        t0 = time.monotonic()

        # Build tool_choice
        if tool_name:
            tool_choice = {"type": "tool", "name": tool_name}
        else:
            tool_choice = {"type": "any"}

        try:
            msg = await client.messages.create(
                model=model,
                max_tokens=cfg.llm_max_tokens,
                system=system_blocks,
                tools=tool_schema,
                tool_choice=tool_choice,
                messages=user_content,
            )
        except Exception as e:
            raise LLMCallError(f"Anthropic call failed (model={model}): {e!r}") from e

        latency_ms = int((time.monotonic() - t0) * 1000)

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
                f"LLM did not return tool_use (model={model}); "
                f"stop_reason={msg.stop_reason} preview={preview[:200]!r}"
            )
        if tool_name and tool_use.name != tool_name:
            raise LLMCallError(
                f"Expected tool {tool_name!r} but got {tool_use.name!r} (model={model})"
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
            tool_name=tool_use.name or "",
            tool_use_id=getattr(tool_use, "id", "") or "",
        )

    # ---- OpenAI leg --------------------------------------------------------

    async def _classify_openai(
        self,
        *,
        model: str,
        system_blocks: List[Dict[str, Any]],
        user_content: Any,  # List[Dict] (messages)
        tool_schema: List[Dict[str, Any]],
        tool_name: Optional[str],
    ) -> LLMResult:
        """Call OpenAI Chat Completions (stream=true is mandatory on CRS).

        Note: OpenAI protocol doesn't support multi-turn tool_use natively
        in the same way as Anthropic. For the OpenAI leg, we flatten messages
        and force classify_email directly (no context tools).
        """
        http = self._lazy_http()
        sys_text = _flatten_system_to_text(system_blocks)

        # Convert messages to OpenAI format
        oai_messages: List[Dict[str, Any]] = [
            {"role": "system", "content": sys_text},
        ]
        for msg in user_content:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if isinstance(content, str):
                oai_messages.append({"role": role, "content": content})
            elif isinstance(content, list):
                # Flatten structured content blocks to text
                text_parts = []
                for block in content:
                    if isinstance(block, dict):
                        if block.get("type") == "tool_result":
                            text_parts.append(
                                f"[Tool result: {block.get('content', '')}]"
                            )
                        elif block.get("type") == "tool_use":
                            continue  # skip tool_use blocks in assistant messages
                        elif block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                if text_parts:
                    oai_messages.append({"role": role, "content": "\n".join(text_parts)})

        # For OpenAI, always force classify_email (no multi-turn context tools)
        force_name = tool_name or "classify_email"
        oai_tools = [_to_openai_tool(t) for t in tool_schema]

        body: Dict[str, Any] = {
            "model": model,
            "max_tokens": cfg.llm_max_tokens,
            "stream": True,
            "messages": oai_messages,
            "tools": oai_tools,
            "tool_choice": {"type": "function", "function": {"name": force_name}},
        }

        t0 = time.monotonic()
        tool_args = ""
        seen_tool_name = ""
        prompt_tokens = 0
        completion_tokens = 0

        try:
            async with http.stream(
                "POST",
                "/v1/chat/completions",
                json=body,
                headers={"Content-Type": "application/json"},
            ) as resp:
                if resp.status_code >= 400:
                    err_body = (await resp.aread()).decode("utf-8", errors="replace")
                    raise LLMCallError(
                        f"OpenAI HTTP {resp.status_code} (model={model}): {err_body[:300]}"
                    )

                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        evt = _json.loads(payload)
                    except _json.JSONDecodeError:
                        continue

                    if isinstance(evt, dict) and evt.get("error"):
                        raise LLMCallError(
                            f"OpenAI stream error (model={model}): {evt['error']}"
                        )

                    choices = evt.get("choices") or []
                    if choices:
                        delta = (choices[0] or {}).get("delta") or {}
                        for tc in (delta.get("tool_calls") or []):
                            fn = (tc or {}).get("function") or {}
                            if fn.get("name"):
                                seen_tool_name = fn["name"]
                            if fn.get("arguments"):
                                tool_args += fn["arguments"]

                    usage = evt.get("usage")
                    if isinstance(usage, dict):
                        prompt_tokens = (
                            int(usage.get("prompt_tokens") or 0) or prompt_tokens
                        )
                        completion_tokens = (
                            int(usage.get("completion_tokens") or 0) or completion_tokens
                        )
        except LLMCallError:
            raise
        except Exception as e:
            raise LLMCallError(f"OpenAI stream failed (model={model}): {e!r}") from e

        latency_ms = int((time.monotonic() - t0) * 1000)

        if not tool_args:
            raise LLMCallError(
                f"OpenAI returned no tool_calls (model={model}); "
                f"got_name={seen_tool_name!r}"
            )
        try:
            tool_input = _json.loads(tool_args)
        except _json.JSONDecodeError as e:
            raise LLMCallError(
                f"OpenAI tool args not valid JSON (model={model}): {e!r}; "
                f"raw={tool_args[:200]!r}"
            ) from e
        if not isinstance(tool_input, dict):
            raise LLMCallError(
                f"OpenAI tool args not an object (model={model}): {tool_input!r}"
            )

        return LLMResult(
            tool_input=tool_input,
            input_tokens=prompt_tokens,
            output_tokens=completion_tokens,
            cache_creation_input_tokens=0,
            cache_read_input_tokens=0,
            model=model,
            latency_ms=latency_ms,
            tool_name=seen_tool_name or force_name,
            tool_use_id="",
        )

    async def close(self):
        if self._client is not None:
            try:
                await self._client.close()
            except Exception as e:
                logger.debug(f"[llm-client] anthropic close ignored err: {e!r}")
            self._client = None
        if self._http is not None:
            try:
                await self._http.aclose()
            except Exception as e:
                logger.debug(f"[llm-client] httpx close ignored err: {e!r}")
            self._http = None
