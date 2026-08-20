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
  - task 07-12 P2：flag `MAILAGENT_LLM_PROVIDER_REGISTRY` on 时模型引用支持
    providerRef（`providerId:modelId`），经 `provider_routing.resolve_route` 按
    provider 行 protocol 路由 + per-provider base/key；off（默认）/ provider 查不到
    （fail-open）→ 上述前缀路由 + 全局 env 配置，字节级不变。
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
from src.llm_agent import provider_routing


# CRS/Cloudflare is picky about user agents; mirror the browser-like UA used by
# other working CRS scripts instead of a custom bot-looking token.
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "Chrome/146.0.0.0 Safari/537.36"
)

# Models matching these prefixes go via the OpenAI Chat Completions endpoint
# on CRS (it routes non-Anthropic providers through /v1/chat/completions).
_OPENAI_PROTO_PREFIXES = ("gpt-", "gemini-", "codex-")


def _leg_for(model: str, route: Optional[provider_routing.ProviderRoute]) -> str:
    """决定一次调用走哪条协议腿：'anthropic' | 'openai' | 'unsupported'（google）。

    route=None（flag off / provider 查不到 fail-open）→ legacy 前缀路由（现状字节级）。
    default provider（seed 自 env 的 CRS 双协议网关）保留前缀路由 —— 等价性验收
    （prd §10.2）：legacy fallback 链里的 gpt-* 在 flag on 后仍走 /v1/chat/completions，
    否则 seed 行 protocol='anthropic' 会把它错送 /v1/messages。非 default 行严格按 protocol。
    """
    if route is None:
        return "openai" if _is_openai_proto(model) else "anthropic"
    if route.protocol == "google":
        return "unsupported"  # v1 不支持 google 协议腿（prd §4.3）——调用方 warning + 跳过
    if route.is_default and route.protocol == "anthropic":
        return "openai" if _is_openai_proto(route.model_id) else "anthropic"
    return "openai" if route.protocol in provider_routing.OPENAI_FAMILY_PROTOCOLS else "anthropic"


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


def _route_or_raise(model: str) -> Optional[provider_routing.ProviderRoute]:
    """resolve_route + MEDIUM-4 语义翻译：显式 providerRef 路由失败（provider 缺失/禁用）
    → 可读 LLMCallError（调用方只捕它），让 fallback 链明确跳下一个模型 + warning。
    None 仍表示 fail-open（flag off / 快照不可读 / 无冒号 legacy id）→ legacy 前缀路由。"""
    try:
        return provider_routing.resolve_route(model)
    except provider_routing.ProviderRouteError as e:
        raise LLMCallError(str(e)) from e


def _redact_upstream(text: str, route: Optional[provider_routing.ProviderRoute]) -> str:
    """上游错误正文脱敏（review HIGH-3）：当前腿的 api_key + 自定义 header 值 → ``***``。
    legacy 腿（route=None）只有全局 key。调用方先脱敏**再**截断（反了会漏 key 前缀）。"""
    if route is not None:
        return provider_routing.redact_secrets(
            text, api_key=route.api_key, headers=route.headers
        )
    return provider_routing.redact_secrets(text, api_key=cfg.llm_api_key or "")


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


def _parse_openai_tool_args(raw: str, *, model: str, tool: str) -> Dict[str, Any]:
    """OpenAI tool_call 的 arguments（JSON 串）→ dict；坏 JSON / 非 object → LLMCallError。"""
    try:
        parsed = _json.loads(raw or "{}")
    except _json.JSONDecodeError as e:
        raise LLMCallError(
            f"OpenAI tool args not valid JSON (model={model}, tool={tool}): {e!r}; "
            f"raw={raw[:200]!r}"
        ) from e
    if not isinstance(parsed, dict):
        raise LLMCallError(
            f"OpenAI tool args not an object (model={model}, tool={tool}): {parsed!r}"
        )
    return parsed


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
        # flag on（provider registry）：per-provider 客户端缓存 {provider_id: (sig, client)}。
        # sig = (base,key,headers) 配置签名 —— 30s TTL 热读到新行值（key 轮换等）时签名失配
        # 即重建；旧实例进 _retired，由 close() 统一关（同步路径不能 await close）。
        self._anthropic_by_provider: Dict[str, Any] = {}
        self._http_by_provider: Dict[str, Any] = {}
        self._retired: List[Any] = []

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

    # ---- per-provider clients（flag on 路径；provider_routing 决议后按行构造）--------

    @staticmethod
    def _route_sig(route: provider_routing.ProviderRoute) -> tuple:
        """行配置签名：失配（TTL 热读到 key 轮换 / base 改动）即重建客户端。"""
        return (route.base_url, route.api_key, tuple(sorted(route.headers.items())))

    def _anthropic_for(self, route: provider_routing.ProviderRoute) -> AsyncAnthropic:
        """per-provider AsyncAnthropic（懒建；base 行值原样，SDK 自动加 /v1/messages）。"""
        sig = self._route_sig(route)
        cached = self._anthropic_by_provider.get(route.provider_id)
        if cached is not None and cached[0] == sig:
            return cached[1]
        if not route.api_key:
            # 行无 key = 未配置 或 Fernet 解密失败（store 解密失败按 absent 投影）。
            raise LLMCallError(
                f"provider '{route.provider_id}' has no API key "
                "(not configured, or it failed to decrypt); cannot call LLM"
            )
        inst = AsyncAnthropic(
            api_key=route.api_key,
            base_url=provider_routing.normalize_anthropic_base(route.base_url),
            timeout=float(cfg.llm_timeout_sec),
            default_headers={"User-Agent": _UA, **route.headers},
        )
        self._anthropic_by_provider[route.provider_id] = (sig, inst)
        if cached is not None:
            self._retired.append(cached[1])
        return inst

    def _http_for(self, route: provider_routing.ProviderRoute) -> httpx.AsyncClient:
        """per-provider httpx（openai 腿；base 已归一含 /vN，POST 路径恒 /chat/completions）。

        key 允许为空（本地 openai-compatible 服务无鉴权）→ 不发 Authorization。
        """
        sig = self._route_sig(route)
        cached = self._http_by_provider.get(route.provider_id)
        if cached is not None and cached[0] == sig:
            return cached[1]
        base = provider_routing.openai_base_for(route)
        if not base:
            raise LLMCallError(
                f"provider '{route.provider_id}' ({route.protocol}) has no base_url configured"
            )
        headers = {"User-Agent": _UA, "Accept": "text/event-stream", **route.headers}
        if route.api_key:
            headers["Authorization"] = f"Bearer {route.api_key}"
        inst = httpx.AsyncClient(
            base_url=base, timeout=float(cfg.llm_timeout_sec), headers=headers
        )
        self._http_by_provider[route.provider_id] = (sig, inst)
        if cached is not None:
            self._retired.append(cached[1])
        return inst

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
                # flag off / fail-open → route=None → legacy 前缀路由（现状字节级）；
                # 显式 ref 路由失败 → LLMCallError → 本 except 走 fallback（MEDIUM-4）。
                route = _route_or_raise(model)
                leg = _leg_for(model, route)
                if leg == "unsupported":
                    raise LLMCallError(
                        f"provider protocol 'google' is not supported on the Python leg "
                        f"(model={model}); skipping"
                    )
                if leg == "openai":
                    return await self._classify_openai(
                        model=model,
                        system_blocks=system_blocks,
                        user_content=user_content,
                        tool_schema=tool_schema,
                        tool_name=tool_name,
                        route=route,
                    )
                return await self._classify_anthropic(
                    model=model,
                    system_blocks=system_blocks,
                    user_content=user_content,
                    tool_schema=tool_schema,
                    tool_name=tool_name,
                    route=route,
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

    async def _stream_anthropic_message(
        self, *, client: Optional[AsyncAnthropic] = None, **kwargs: Any
    ) -> Any:
        """Call Anthropic Messages in streaming mode and return the final Message.

        CRS routes Sonnet more reliably through the streaming path; callers still
        consume a completed Message so the rest of the LLM pipeline stays
        unchanged. `client` 缺省用全局单例（legacy）；flag on 传 per-provider 实例。
        """
        client = client or self._lazy()
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
        route: Optional[provider_routing.ProviderRoute] = None,
    ) -> LLMResult:
        t0 = time.monotonic()
        try:
            msg = await self._stream_anthropic_message(
                client=self._anthropic_for(route) if route else None,
                model=route.model_id if route else model,
                max_tokens=provider_routing.clamp_max_tokens(cfg.llm_max_tokens, route),
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
        route: Optional[provider_routing.ProviderRoute] = None,
    ) -> LLMResult:
        """Call OpenAI Chat Completions (stream=true is mandatory on CRS)."""
        http = self._http_for(route) if route else self._lazy_http()
        # legacy base 不含 /vN（拼 /v1/...）；route base 已由 openai_base_for 归一含 /vN。
        path = "/chat/completions" if route else "/v1/chat/completions"
        sys_text = _flatten_system_to_text(system_blocks)
        body: Dict[str, Any] = {
            "model": route.model_id if route else model,
            "max_tokens": provider_routing.clamp_max_tokens(cfg.llm_max_tokens, route),
            "stream": True,
            "messages": [
                {"role": "system", "content": sys_text},
                {"role": "user", "content": user_content},
            ],
            "tools": [_to_openai_tool(tool_schema)],
            "tool_choice": {"type": "function", "function": {"name": tool_name}},
        }
        # classify 恒强制 tool_choice → 恒 merge provider/model quirk（DeepSeek 须禁
        # thinking）。route=None（legacy 前缀路由）不注入，字节级不变。
        if route is not None:
            body.update(
                provider_routing.forced_tool_choice_extra_body(
                    route.protocol, route.model_id
                )
            )

        t0 = time.monotonic()
        tool_args = ""
        seen_tool_name = ""
        prompt_tokens = 0
        completion_tokens = 0

        try:
            async with http.stream(
                "POST",
                path,
                json=body,
                headers={"Content-Type": "application/json"},
            ) as resp:
                if resp.status_code >= 400:
                    err_body = (await resp.aread()).decode("utf-8", errors="replace")
                    raise LLMCallError(
                        f"OpenAI HTTP {resp.status_code} (model={model}): "
                        f"{_redact_upstream(err_body, route)[:300]}"
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
                            f"OpenAI stream error (model={model}): "
                            f"{_redact_upstream(str(evt['error']), route)}"
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
        """多轮 tool_use loop（Anthropic + OpenAI 双协议腿，task 07-12 P2 决策 3）。

        模型按需调 ``tools`` 里的工具（``tool_handlers`` 执行 + 回灌 tool_result），
        直到它调用 ``final_tool`` —— 返回该工具的 input（**不执行 handler**，交给 caller
        消费，如 build_report → ReportDraft）。``tool_choice=auto``（最后一轮强制 final_tool
        保证收尾），与 classify 的单次强制调用不同。

        走 fallback chain。flag off（显式 false 应急回退）：**只在 Anthropic 前缀模型上**
        跑（现状字节级，OpenAI proto 从链里过滤）；flag on（默认，2026-07-13 cutover）：
        按 provider 协议分发（openai 系走
        ``_run_loop_openai`` 多轮 tool_calls 协议），仅 google 协议被过滤 + warning。
        cache_control：anthropic 腿复用 caller 设的 breakpoints；openai 腿在 system 打平
        时自然丢弃（现状语义）。

        raises LLMCallError：链里无可用模型 / 全部失败 / 用尽 max_iter 仍未产出。
        """
        if provider_routing.registry_enabled():
            chain = []
            for m in _resolve_model_chain(model_chain):
                try:
                    r = provider_routing.resolve_route(m)
                except provider_routing.ProviderRouteError:
                    # 显式 ref 路由失败：留在链里，由主循环按模型失败处理（fallback + warning）。
                    chain.append(m)
                    continue
                if r is not None and r.protocol == "google":
                    logger.warning(
                        f"[llm] loop skipping model={m}: provider protocol 'google' "
                        "is not supported on the Python leg"
                    )
                    continue
                chain.append(m)
            if not chain:
                raise LLMCallError(
                    "run_tool_loop has no usable model in the chain "
                    "(google-protocol models are skipped)"
                )
        else:
            chain = [m for m in _resolve_model_chain(model_chain) if not _is_openai_proto(m)]
            if not chain:
                raise LLMCallError("run_tool_loop needs an Anthropic model in the chain")

        last_err: Optional[BaseException] = None
        for i, model in enumerate(chain):
            try:
                route = _route_or_raise(model)
                leg = _leg_for(model, route)
                if leg == "unsupported":
                    # TTL 快照在过滤后刷新把协议翻成 google 的窗口 → 防御性跳过（走 fallback）。
                    raise LLMCallError(
                        f"provider protocol 'google' is not supported (model={model})"
                    )
                eff_max_tokens = provider_routing.clamp_max_tokens(max_tokens, route)
                if leg == "openai":
                    return await self._run_loop_openai(
                        model=model,
                        route=route,
                        system_blocks=system_blocks,
                        user_content=user_content,
                        tools=tools,
                        tool_handlers=tool_handlers,
                        final_tool=final_tool,
                        max_iter=max_iter,
                        max_tokens=eff_max_tokens,
                    )
                return await self._run_loop_anthropic(
                    model=model,
                    route=route,
                    system_blocks=system_blocks,
                    user_content=user_content,
                    tools=tools,
                    tool_handlers=tool_handlers,
                    final_tool=final_tool,
                    max_iter=max_iter,
                    max_tokens=eff_max_tokens,
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
        route: Optional[provider_routing.ProviderRoute] = None,
    ) -> ToolLoopResult:
        client = self._anthropic_for(route) if route else None
        wire_model = route.model_id if route else model
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
                    client=client,
                    model=wire_model,
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
                # 措辞与 final_tool 无关（MCP connector PR3 起本 loop 还被邮件预处理**分类**
                # 复用，原来那句「产出最终报告」会把分类模型往报告形状上带）。
                messages.append(
                    {"role": "user", "content": f"请基于以上信息调用 {final_tool} 工具完成本次任务。"}
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

    # ---- Multi-turn tool loop (OpenAI leg, task 07-12 P2) --------------------

    async def _openai_stream_turn(
        self,
        *,
        http: httpx.AsyncClient,
        path: str,
        body: Dict[str, Any],
        model: str,
        ctx: str,
        route: Optional[provider_routing.ProviderRoute] = None,
    ) -> Dict[str, Any]:
        """单轮 OpenAI Chat Completions 流式请求 → 聚合 {text, tool_calls, finish_reason, tokens}。

        tool_calls delta 按 ``index`` 聚合：id / function.name 出现即覆写（标准协议整段
        下发，覆写兼容全量重发的实现），``function.arguments`` 分片拼接。
        """
        text_parts: List[str] = []
        calls: Dict[int, Dict[str, str]] = {}
        finish_reason = ""
        prompt_tokens = 0
        completion_tokens = 0
        try:
            async with http.stream(
                "POST", path, json=body, headers={"Content-Type": "application/json"}
            ) as resp:
                if resp.status_code >= 400:
                    err_body = (await resp.aread()).decode("utf-8", errors="replace")
                    raise LLMCallError(
                        f"OpenAI HTTP {resp.status_code} (model={model}, {ctx}): "
                        f"{_redact_upstream(err_body, route)[:300]}"
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
                            f"OpenAI stream error (model={model}, {ctx}): "
                            f"{_redact_upstream(str(evt['error']), route)}"
                        )
                    choices = evt.get("choices") or []
                    if choices:
                        ch0 = choices[0] or {}
                        delta = ch0.get("delta") or {}
                        if delta.get("content"):
                            text_parts.append(delta["content"])
                        for tc in (delta.get("tool_calls") or []):
                            tc = tc or {}
                            idx = int(tc.get("index") or 0)
                            slot = calls.setdefault(
                                idx, {"id": "", "name": "", "arguments": ""}
                            )
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] = fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] += fn["arguments"]
                        if ch0.get("finish_reason"):
                            finish_reason = ch0["finish_reason"]
                    usage = evt.get("usage")
                    if isinstance(usage, dict):
                        prompt_tokens = int(usage.get("prompt_tokens") or 0) or prompt_tokens
                        completion_tokens = (
                            int(usage.get("completion_tokens") or 0) or completion_tokens
                        )
        except LLMCallError:
            raise
        except Exception as e:
            raise LLMCallError(f"OpenAI stream failed (model={model}, {ctx}): {e!r}") from e
        return {
            "text": "".join(text_parts),
            "tool_calls": [calls[k] for k in sorted(calls)],
            "finish_reason": finish_reason,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
        }

    async def _run_loop_openai(
        self,
        *,
        model: str,
        route: Optional[provider_routing.ProviderRoute],
        system_blocks: List[Dict[str, Any]],
        user_content: str,
        tools: List[Dict[str, Any]],
        tool_handlers: Dict[str, ToolHandler],
        final_tool: str,
        max_iter: int,
        max_tokens: int,
    ) -> ToolLoopResult:
        """OpenAI Chat Completions 多轮 tool loop（与 anthropic 腿同语义）。

        协议差异：assistant ``tool_calls`` 消息重放 + ``role:"tool"`` 结果回传（tool_call_id
        对齐）；流式 tool_call delta 按 index 聚合；cache_control 在 system 打平时自然丢弃。
        命中 ``final_tool`` 返回其 input（不执行 handler）；工具错误回灌让模型自适应。
        """
        http = self._http_for(route) if route else self._lazy_http()
        path = "/chat/completions" if route else "/v1/chat/completions"
        wire_model = route.model_id if route else model
        sys_text = _flatten_system_to_text(system_blocks)
        tools_payload = [_to_openai_tool(t) for t in tools]
        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": sys_text},
            {"role": "user", "content": user_content},
        ]
        total_in = total_out = 0
        tool_calls_audit: List[Dict[str, Any]] = []
        t0 = time.monotonic()

        for it in range(max_iter):
            # 最后一轮强制收尾（复用 classify 的 forced-function 形状），否则 auto。
            forced_final = it == max_iter - 1
            tool_choice: Union[str, Dict[str, Any]] = (
                {"type": "function", "function": {"name": final_tool}}
                if forced_final
                else "auto"
            )
            body: Dict[str, Any] = {
                "model": wire_model,
                "max_tokens": max_tokens,
                "stream": True,
                "messages": messages,
                "tools": tools_payload,
                "tool_choice": tool_choice,
            }
            # 仅强制轮 merge provider/model quirk（DeepSeek 禁 thinking）；auto 轮不注入
            # ——保留 thinking 给推理用。route=None（legacy）不注入。
            if forced_final and route is not None:
                body.update(
                    provider_routing.forced_tool_choice_extra_body(
                        route.protocol, route.model_id
                    )
                )
            turn = await self._openai_stream_turn(
                http=http, path=path, body=body, model=model, ctx=f"iter={it}", route=route
            )
            total_in += turn["prompt_tokens"]
            total_out += turn["completion_tokens"]

            calls = turn["tool_calls"]
            # 个别实现单 tool call 可省 id —— 回传 role:"tool" 必须对齐 id，缺则补
            # 确定性 id（it+序号，跨轮唯一）。
            for j, c in enumerate(calls):
                if not c["id"]:
                    c["id"] = f"call_auto_{it}_{j}"

            final_call = next((c for c in calls if c["name"] == final_tool), None)
            if final_call is not None:
                return ToolLoopResult(
                    final_input=_parse_openai_tool_args(
                        final_call["arguments"], model=model, tool=final_tool
                    ),
                    iterations=it + 1,
                    input_tokens=total_in,
                    output_tokens=total_out,
                    cache_read_input_tokens=0,
                    model=model,
                    latency_ms=int((time.monotonic() - t0) * 1000),
                    tool_calls=tool_calls_audit,
                )

            if not calls:
                # 纯文本收尾（未调工具）→ 提示收尾，再给一轮机会（镜像 anthropic 腿）。
                messages.append({"role": "assistant", "content": turn["text"] or ""})
                messages.append(
                    {"role": "user", "content": f"请基于以上信息调用 {final_tool} 工具产出最终报告。"}
                )
                continue

            # assistant tool_calls 消息重放（OpenAI 多轮协议要求原样回放上一轮 assistant turn）。
            messages.append(
                {
                    "role": "assistant",
                    "content": turn["text"] or "",
                    "tool_calls": [
                        {
                            "id": c["id"],
                            "type": "function",
                            "function": {
                                "name": c["name"],
                                "arguments": c["arguments"] or "{}",
                            },
                        }
                        for c in calls
                    ],
                }
            )
            # 执行非 final 工具 + role:"tool" 结果回传（错误也回灌，让模型自适应）。
            for c in calls:
                name = c["name"]
                ts = time.monotonic()
                tinput: Optional[Dict[str, Any]]
                try:
                    parsed = _json.loads(c["arguments"]) if c["arguments"] else {}
                    tinput = parsed if isinstance(parsed, dict) else None
                except _json.JSONDecodeError:
                    tinput = None
                handler = tool_handlers.get(name)
                if tinput is None:
                    out = f"error: tool arguments not valid JSON: {c['arguments'][:200]!r}"
                elif handler is None:
                    out = f"error: unknown tool {name!r}"
                else:
                    try:
                        res = handler(tinput)
                        out = await res if inspect.isawaitable(res) else res
                        out = out if isinstance(out, str) else _json.dumps(out, ensure_ascii=False)
                    except Exception as e:  # noqa: BLE001 — 工具错误回灌给模型，不中断 loop
                        out = f"error: {e!r}"
                tool_calls_audit.append(
                    {
                        "name": name,
                        "input": tinput if isinstance(tinput, dict) else {},
                        "output_preview": out[:200],
                        "ms": int((time.monotonic() - ts) * 1000),
                    }
                )
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": out})

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
        # per-provider 客户端 + 签名失配换下来的旧实例（flag on 路径）。
        for _sig, inst in self._anthropic_by_provider.values():
            try:
                await inst.close()
            except Exception as e:
                logger.debug(f"[llm-client] provider anthropic close ignored err: {e!r}")
        self._anthropic_by_provider = {}
        for _sig, inst in self._http_by_provider.values():
            try:
                await inst.aclose()
            except Exception as e:
                logger.debug(f"[llm-client] provider httpx close ignored err: {e!r}")
        self._http_by_provider = {}
        for inst in self._retired:
            try:
                if hasattr(inst, "aclose"):
                    await inst.aclose()
                else:
                    await inst.close()
            except Exception as e:
                logger.debug(f"[llm-client] retired client close ignored err: {e!r}")
        self._retired = []
