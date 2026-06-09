"""LLM gateway client with multi-model fallback (Anthropic + OpenAI proto).

`LLMClient` routes per model:
  - claude-* → Anthropic Messages streaming (`/v1/messages`) + native tool_use
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

import inspect
import json as _json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Union

import httpx
from anthropic import AsyncAnthropic
from loguru import logger

from src.config import config as cfg


# CRS/Cloudflare is picky about user agents; mirror the browser-like UA used by
# other working CRS scripts instead of a custom bot-looking token.
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "Chrome/146.0.0.0 Safari/537.36"
)

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


# 工具 handler：收 tool input dict → 返字符串结果（同步或异步）。loop 把返回值原样
# 回灌成 tool_result。handler 内部自处理错误（返 "error: ..." 字符串，不要抛）。
ToolHandler = Callable[[Dict[str, Any]], Union[str, Awaitable[str]]]


@dataclass
class ToolLoopResult:
    """run_tool_loop 的产物：final_tool 的 input + token/轮次统计 + 调用轨迹。"""

    final_input: Dict[str, Any]
    iterations: int
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    model: str
    latency_ms: int
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)  # 审计：[{name,input,output_preview,ms}]


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


def _serialize_assistant_content(content: Any) -> List[Dict[str, Any]]:
    """Anthropic 返回的 assistant content blocks → 可回灌 messages 的 dict 列表。

    多轮 loop 把上一轮 assistant turn（含 tool_use）加回 messages，必须转成 dict
    （SDK 对象不能直接当 messages content）。只保留 text / tool_use 两类。
    """
    out: List[Dict[str, Any]] = []
    for b in content or []:
        bt = getattr(b, "type", None)
        if bt == "text":
            out.append({"type": "text", "text": getattr(b, "text", "") or ""})
        elif bt == "tool_use":
            out.append(
                {
                    "type": "tool_use",
                    "id": getattr(b, "id", ""),
                    "name": getattr(b, "name", ""),
                    "input": dict(getattr(b, "input", {}) or {}),
                }
            )
    return out


class LLMClient:
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
        user_content: str,
        tool_schema: Dict[str, Any],
        tool_name: str,
        model_chain: Optional[List[str]] = None,
    ) -> LLMResult:
        """Call LLM forcing tool_use; walk fallback chain on LLMCallError.

        `model_chain` defaults to [cfg.llm_model, *cfg.llm_fallback_models].
        """
        chain = _resolve_model_chain(model_chain)
        if not chain:
            raise LLMCallError("model chain is empty (LLM_MODEL unset?)")

        last_err: Optional[BaseException] = None
        for i, model in enumerate(chain):
            try:
                if _is_openai_proto(model):
                    return await self._classify_openai(
                        model=model,
                        system_blocks=system_blocks,
                        user_content=user_content,
                        tool_schema=tool_schema,
                        tool_name=tool_name,
                    )
                return await self._classify_anthropic(
                    model=model,
                    system_blocks=system_blocks,
                    user_content=user_content,
                    tool_schema=tool_schema,
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
        # unreachable
        raise last_err or LLMCallError("model chain exhausted without result")

    # ---- Anthropic leg -----------------------------------------------------

    async def _stream_anthropic_message(self, **kwargs: Any) -> Any:
        """Call Anthropic Messages in streaming mode and return the final Message.

        CRS routes Sonnet more reliably through the streaming path; callers still
        consume a completed Message so the rest of the LLM pipeline stays
        unchanged.
        """
        client = self._lazy()
        async with client.messages.stream(**kwargs) as stream:
            async for _event in stream:
                pass
            return await stream.get_final_message()

    async def _classify_anthropic(
        self,
        *,
        model: str,
        system_blocks: List[Dict[str, Any]],
        user_content: str,
        tool_schema: Dict[str, Any],
        tool_name: str,
    ) -> LLMResult:
        t0 = time.monotonic()
        try:
            msg = await self._stream_anthropic_message(
                model=model,
                max_tokens=cfg.llm_max_tokens,
                system=system_blocks,
                tools=[tool_schema],
                tool_choice={"type": "tool", "name": tool_name},
                messages=[{"role": "user", "content": user_content}],
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
        if tool_use.name != tool_name:
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
        )

    # ---- OpenAI leg --------------------------------------------------------

    async def _classify_openai(
        self,
        *,
        model: str,
        system_blocks: List[Dict[str, Any]],
        user_content: str,
        tool_schema: Dict[str, Any],
        tool_name: str,
    ) -> LLMResult:
        """Call OpenAI Chat Completions (stream=true is mandatory on CRS)."""
        http = self._lazy_http()
        sys_text = _flatten_system_to_text(system_blocks)
        body: Dict[str, Any] = {
            "model": model,
            "max_tokens": cfg.llm_max_tokens,
            "stream": True,
            "messages": [
                {"role": "system", "content": sys_text},
                {"role": "user", "content": user_content},
            ],
            "tools": [_to_openai_tool(tool_schema)],
            "tool_choice": {"type": "function", "function": {"name": tool_name}},
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
        if seen_tool_name and seen_tool_name != tool_name:
            raise LLMCallError(
                f"Expected tool {tool_name!r} but got {seen_tool_name!r} (model={model})"
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
        )

    # ---- Multi-turn tool loop (Anthropic-only) -----------------------------

    async def run_tool_loop(
        self,
        *,
        system_blocks: List[Dict[str, Any]],
        user_content: str,
        tools: List[Dict[str, Any]],
        tool_handlers: Dict[str, ToolHandler],
        final_tool: str,
        model_chain: Optional[List[str]] = None,
        max_iter: int = 8,
        max_tokens: int = 64000,
    ) -> ToolLoopResult:
        """多轮 tool_use loop（仅 Anthropic leg）。

        模型按需调 ``tools`` 里的工具（``tool_handlers`` 执行 + 回灌 tool_result），
        直到它调用 ``final_tool`` —— 返回该工具的 input（**不执行 handler**，交给 caller
        消费，如 build_report → ReportDraft）。``tool_choice=auto``（最后一轮强制 final_tool
        保证收尾），与 classify 的单次强制调用不同。

        走 fallback chain，但**只在 Anthropic 模型上**跑（OpenAI proto 的多轮原生 tool
        协议这里不实现，从链里过滤）。复用 caller 设在 system_blocks / tools 上的
        cache_control breakpoints。

        raises LLMCallError：链里无 Anthropic 模型 / 全部失败 / 用尽 max_iter 仍未产出。
        """
        chain = [m for m in _resolve_model_chain(model_chain) if not _is_openai_proto(m)]
        if not chain:
            raise LLMCallError("run_tool_loop needs an Anthropic model in the chain")

        last_err: Optional[BaseException] = None
        for i, model in enumerate(chain):
            try:
                return await self._run_loop_anthropic(
                    model=model,
                    system_blocks=system_blocks,
                    user_content=user_content,
                    tools=tools,
                    tool_handlers=tool_handlers,
                    final_tool=final_tool,
                    max_iter=max_iter,
                    max_tokens=max_tokens,
                )
            except LLMCallError as e:
                last_err = e
                if i + 1 < len(chain):
                    logger.warning(f"[llm] loop model={model} failed, fallback to {chain[i+1]}: {e}")
                    continue
                logger.warning(f"[llm] loop model={model} failed (last in chain): {e}")
                raise
        raise last_err or LLMCallError("loop model chain exhausted")

    async def _run_loop_anthropic(
        self,
        *,
        model: str,
        system_blocks: List[Dict[str, Any]],
        user_content: str,
        tools: List[Dict[str, Any]],
        tool_handlers: Dict[str, ToolHandler],
        final_tool: str,
        max_iter: int,
        max_tokens: int,
    ) -> ToolLoopResult:
        messages: List[Dict[str, Any]] = [{"role": "user", "content": user_content}]
        total_in = total_out = total_cache_read = 0
        tool_calls: List[Dict[str, Any]] = []
        t0 = time.monotonic()

        for it in range(max_iter):
            # 最后一轮强制收尾（必产 final_tool），否则 auto 让模型自由调工具/收尾。
            tool_choice: Dict[str, Any] = (
                {"type": "tool", "name": final_tool}
                if it == max_iter - 1
                else {"type": "auto"}
            )
            try:
                msg = await self._stream_anthropic_message(
                    model=model,
                    max_tokens=max_tokens,
                    system=system_blocks,
                    tools=tools,
                    tool_choice=tool_choice,
                    messages=messages,
                )
            except Exception as e:
                raise LLMCallError(
                    f"loop messages.stream failed (model={model}, iter={it}): {e!r}"
                ) from e

            usage = msg.usage
            total_in += int(getattr(usage, "input_tokens", 0) or 0)
            total_out += int(getattr(usage, "output_tokens", 0) or 0)
            total_cache_read += int(getattr(usage, "cache_read_input_tokens", 0) or 0)

            blocks = msg.content or []
            tool_uses = [b for b in blocks if getattr(b, "type", None) == "tool_use"]

            # 命中 final_tool → 收尾返回它的 input（不执行 handler）。
            final_block = next(
                (b for b in tool_uses if getattr(b, "name", "") == final_tool), None
            )
            if final_block is not None:
                return ToolLoopResult(
                    final_input=dict(getattr(final_block, "input", {}) or {}),
                    iterations=it + 1,
                    input_tokens=total_in,
                    output_tokens=total_out,
                    cache_read_input_tokens=total_cache_read,
                    model=getattr(msg, "model", model),
                    latency_ms=int((time.monotonic() - t0) * 1000),
                    tool_calls=tool_calls,
                )

            # 回灌上一轮 assistant turn（含 tool_use）。
            messages.append(
                {"role": "assistant", "content": _serialize_assistant_content(blocks)}
            )

            if not tool_uses:
                # 既没调工具也没调 final_tool（纯 end_turn）→ 提示收尾，再给一轮机会。
                messages.append(
                    {"role": "user", "content": f"请基于以上信息调用 {final_tool} 工具产出最终报告。"}
                )
                continue

            # 执行非 final 工具 + 回灌 tool_result（错误也回灌，让模型自适应）。
            results: List[Dict[str, Any]] = []
            for tu in tool_uses:
                name = getattr(tu, "name", "")
                tinput = dict(getattr(tu, "input", {}) or {})
                handler = tool_handlers.get(name)
                ts = time.monotonic()
                if handler is None:
                    out = f"error: unknown tool {name!r}"
                else:
                    try:
                        res = handler(tinput)
                        out = await res if inspect.isawaitable(res) else res
                        out = out if isinstance(out, str) else _json.dumps(out, ensure_ascii=False)
                    except Exception as e:  # noqa: BLE001 — 工具错误回灌给模型，不中断 loop
                        out = f"error: {e!r}"
                tool_calls.append(
                    {
                        "name": name,
                        "input": tinput,
                        "output_preview": out[:200],
                        "ms": int((time.monotonic() - ts) * 1000),
                    }
                )
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": getattr(tu, "id", ""),
                        "content": out,
                        "is_error": out.startswith("error:"),
                    }
                )
            messages.append({"role": "user", "content": results})

        raise LLMCallError(
            f"tool loop exhausted {max_iter} iters without calling {final_tool!r} (model={model})"
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
