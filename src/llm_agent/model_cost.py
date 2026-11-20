"""Python-side 4-tier LLM USD cost estimator backed by `catalog.json`.

Single pricing source shared with `frontend/src/ai-gateway/modelCost.ts`:
reads `frontend/src/shared/modelCatalog/catalog.json` via `@lru_cache(maxsize=1)`.
No duplicated static pricing map — unknown models or stripped deployments degrade
cleanly to ``None``.

🔴 Prompt-token convention distinction:
  - Python ``LLMResult.input_tokens`` and ``llm_processing.input_tokens`` come from
    Anthropic / normalized Python paths and represent **uncached input tokens only**
    (``input_is_uncached_only=True``, default here).
  - TypeScript AI SDK ``ai@7`` (``ai_chat_messages.tokens_input``,
    ``ai_chat_group_turn.tokens_input``, ``ai_llm_usage_log.input_tokens``) stores
    **total prompt tokens** (= uncached + cacheRead + cacheWrite), so callers passing
    AI SDK totals MUST pass ``input_is_uncached_only=False`` to avoid double-billing
    cached tokens.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

_PER_MILLION = 1_000_000.0
_KNOWN_COLON_SUFFIXES = ("free", "extended", "thinking", "beta", "exacto")

PREFERRED_CATALOG_PROVIDERS: Dict[str, Tuple[str, ...]] = {
    "anthropic": ("anthropic",),
    "openai": ("openai",),
    "deepseek": ("deepseek",),
    "google": ("google",),
    "openrouter": ("openai", "anthropic", "google", "deepseek", "alibaba", "mistral", "xai"),
    "openai-compatible": (
        "openai",
        "anthropic",
        "deepseek",
        "google",
        "zhipuai",
        "zai",
        "moonshotai",
        "alibaba",
        "alibaba-cn",
        "minimax",
        "doubao",
        "xai",
        "mistral",
        "siliconflow",
        "groq",
        "togetherai",
        "fireworks-ai",
        "cohere",
        "perplexity",
    ),
}


def normalize_catalog_model_id(model_id: str) -> str:
    s = model_id.strip().lower()
    s = re.sub(r"\[[^\]]*\]\s*$", "", s)
    if "/" in s:
        s = s.rsplit("/", 1)[-1]
    s = re.sub(r":(free|extended|thinking|beta|exacto)\s*$", "", s)
    s = re.sub(r"-latest\s*$", "", s)
    return s.strip()


def _strip_provider_ref(model_id: str) -> str:
    s = model_id.strip()
    if ":" not in s:
        return s
    head, tail = s.split(":", 1)
    if tail.lower().strip() in _KNOWN_COLON_SUFFIXES:
        return s
    return tail.strip() or s


@lru_cache(maxsize=1)
def _load_catalog_indexes() -> Tuple[Dict[str, Dict[str, Dict[str, Any]]], Dict[str, Optional[str]]]:
    catalog_path = (
        Path(__file__).resolve().parents[2]
        / "frontend"
        / "src"
        / "shared"
        / "modelCatalog"
        / "catalog.json"
    )
    by_provider: Dict[str, Dict[str, Dict[str, Any]]] = {}
    global_owner: Dict[str, Optional[str]] = {}
    try:
        raw = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return by_provider, global_owner

    providers = raw.get("providers")
    if not isinstance(providers, dict):
        return by_provider, global_owner

    for pid, pdata in providers.items():
        if not isinstance(pdata, dict):
            continue
        models = pdata.get("models")
        if not isinstance(models, dict):
            continue
        p_map: Dict[str, Dict[str, Any]] = {}
        for mid, mdata in models.items():
            if not isinstance(mid, str) or not isinstance(mdata, dict):
                continue
            key = mid.lower()
            p_map[key] = mdata
            if key not in global_owner:
                global_owner[key] = pid
            elif global_owner[key] != pid:
                global_owner[key] = None
        if p_map:
            by_provider[pid] = p_map
    return by_provider, global_owner


def lookup_model_cost(
    model_id: Optional[str], protocol: Optional[str] = None
) -> Optional[Dict[str, Optional[float]]]:
    if not model_id or not isinstance(model_id, str):
        return None
    cleaned = _strip_provider_ref(model_id)
    exact_key = cleaned.strip().lower()
    if not exact_key:
        return None
    norm_key = normalize_catalog_model_id(cleaned)

    by_provider, global_owner = _load_catalog_indexes()
    chain = PREFERRED_CATALOG_PROVIDERS.get(protocol or "", ())

    def _cost_from(raw: Optional[Dict[str, Any]]) -> Optional[Dict[str, Optional[float]]]:
        if not raw:
            return None
        c = raw.get("cost")
        if not isinstance(c, dict):
            return None
        return {
            "input": float(c["input"]) if c.get("input") is not None else None,
            "output": float(c["output"]) if c.get("output") is not None else None,
            "cacheRead": float(c["cacheRead"]) if c.get("cacheRead") is not None else None,
            "cacheWrite": float(c["cacheWrite"]) if c.get("cacheWrite") is not None else None,
        }

    for pid in chain:
        hit = _cost_from(by_provider.get(pid, {}).get(exact_key))
        if hit is not None:
            return hit
    if norm_key and norm_key != exact_key:
        for pid in chain:
            hit = _cost_from(by_provider.get(pid, {}).get(norm_key))
            if hit is not None:
                return hit

    owner = global_owner.get(exact_key)
    if owner:
        hit = _cost_from(by_provider.get(owner, {}).get(exact_key))
        if hit is not None:
            return hit
    if norm_key and norm_key != exact_key:
        owner = global_owner.get(norm_key)
        if owner:
            hit = _cost_from(by_provider.get(owner, {}).get(norm_key))
            if hit is not None:
                return hit
    return None


def _non_neg(v: Optional[int]) -> int:
    if isinstance(v, (int, float)) and v > 0:
        return int(v)
    return 0


def estimate_cost_usd(
    model_id: Optional[str],
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    protocol: Optional[str] = None,
    input_is_uncached_only: bool = True,
) -> Optional[float]:
    if not model_id:
        return None
    cache_read = _non_neg(cache_read_tokens)
    cache_write = _non_neg(cache_write_tokens)
    raw_in = _non_neg(input_tokens)
    uncached_in = raw_in if input_is_uncached_only else max(0, raw_in - cache_read - cache_write)
    out = _non_neg(output_tokens)
    if uncached_in == 0 and out == 0 and cache_read == 0 and cache_write == 0:
        return None

    cost = lookup_model_cost(model_id, protocol)
    if cost is None:
        return None
    in_rate = cost.get("input")
    out_rate = cost.get("output")
    if (uncached_in > 0 or cache_read > 0 or cache_write > 0) and in_rate is None:
        return None
    if out > 0 and out_rate is None:
        return None

    in_r = in_rate or 0.0
    out_r = out_rate or 0.0
    read_r = cost.get("cacheRead") if cost.get("cacheRead") is not None else in_r
    write_r = cost.get("cacheWrite") if cost.get("cacheWrite") is not None else in_r

    return (
        uncached_in * in_r
        + out * out_r
        + cache_read * read_r
        + cache_write * write_r
    ) / _PER_MILLION


def estimate_cache_saved_usd(
    model_id: Optional[str],
    *,
    cache_read_tokens: int = 0,
    protocol: Optional[str] = None,
) -> Optional[float]:
    if not model_id:
        return None
    cache_read = _non_neg(cache_read_tokens)
    if cache_read == 0:
        return 0.0
    cost = lookup_model_cost(model_id, protocol)
    if cost is None or cost.get("input") is None:
        return None
    in_r = float(cost["input"])
    read_r = float(cost["cacheRead"]) if cost.get("cacheRead") is not None else in_r
    return max(0.0, cache_read * (in_r - read_r)) / _PER_MILLION
