"""On-demand readable-content fetching and cache metadata for Matter URL resources."""

from __future__ import annotations

import hashlib
from typing import Any, Mapping

from .resource_identity import MatterError

# Six hours keeps repeated detail/context reads local while still revalidating a mutable web page
# several times per day. Fetching remains strictly request-driven; no timer or background worker.
URL_CACHE_FRESHNESS_MS = 6 * 60 * 60 * 1000

# The shared web_fetch implementation already enforces its network/body guards. Matter URL fetches
# request at most 50k readable characters so the persistent metadata cache remains bounded.
URL_FETCH_MAX_CHARS = 50_000

# Matters needs human-readable page text, not structured API/XML payloads. The shared web_fetch
# path is broader for general agent use, so this lane narrows its accepted result types further.
URL_FETCH_ALLOWED_CONTENT_TYPES = frozenset(
    {"text/html", "application/xhtml+xml", "text/plain"}
)

URL_CACHE_METADATA_KEY = "url_fetch_cache"
URL_CACHE_TEXT_KEY = "cached_excerpt"


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def describe_url_cache(resource: Mapping[str, Any], now_ms: int) -> dict[str, Any]:
    metadata = resource.get("metadata")
    metadata = metadata if isinstance(metadata, Mapping) else {}
    cache = metadata.get(URL_CACHE_METADATA_KEY)
    cache = cache if isinstance(cache, Mapping) else {}
    text = metadata.get(URL_CACHE_TEXT_KEY)
    fetched_at = cache.get("fetched_at")
    stored_hash = cache.get("content_hash")
    hash_matches = (
        isinstance(text, str)
        and isinstance(stored_hash, str)
        and stored_hash == content_hash(text)
        and resource.get("content_hash") == stored_hash
    )
    has_timestamp = isinstance(fetched_at, int) and fetched_at >= 0
    age_ms = now_ms - fetched_at if has_timestamp else None
    is_fresh = bool(hash_matches and age_ms is not None and 0 <= age_ms < URL_CACHE_FRESHNESS_MS)
    has_content = bool(hash_matches)
    state = "fresh" if is_fresh else ("stale" if has_content else "missing")
    return {
        "state": state,
        "has_content": has_content,
        "is_fresh": is_fresh,
        "fetched_at": fetched_at if has_timestamp else None,
        "fresh_until": fetched_at + URL_CACHE_FRESHNESS_MS if has_timestamp else None,
        "age_ms": age_ms,
        "freshness_ms": URL_CACHE_FRESHNESS_MS,
        "content_hash": stored_hash if isinstance(stored_hash, str) else None,
        "final_url": cache.get("final_url") if isinstance(cache.get("final_url"), str) else None,
        "content_type": cache.get("content_type") if isinstance(cache.get("content_type"), str) else None,
        "status": cache.get("status") if isinstance(cache.get("status"), int) else None,
        "truncated": bool(cache.get("truncated")),
        "content_chars": len(text) if has_content and isinstance(text, str) else 0,
    }


def cached_url_text(resource: Mapping[str, Any]) -> str | None:
    metadata = resource.get("metadata")
    if not isinstance(metadata, Mapping):
        return None
    text = metadata.get(URL_CACHE_TEXT_KEY)
    return text if isinstance(text, str) else None


def fetch_readable_url(url: str) -> dict[str, Any]:
    """Reuse the canonical web_fetch execution path, including its exact SSRF defenses.

    The shared path enforces http(s)-only URLs, rejects userinfo, validates every resolved IPv4/
    IPv6 address (including embedded IPv4 forms), pins the validated IP to prevent DNS rebinding,
    and re-runs validation after every redirect. It also owns the timeout, redirect, response-size,
    compression, and content-type guards, so Matter must not maintain a drifting copy.
    """
    # Lazy import avoids a routers.matters -> service -> url_fetch -> routers.web -> app cycle.
    from src.api.app import APIError
    from src.api.routers.web import _do_fetch

    try:
        result = _do_fetch(url, URL_FETCH_MAX_CHARS)
    except APIError as exc:
        raise MatterError(exc.code, exc.message, hint=exc.hint) from exc
    if result.get("content_type") not in URL_FETCH_ALLOWED_CONTENT_TYPES:
        raise MatterError(
            "E_CONTENT_TYPE",
            f"unsupported Matter URL content-type: {result.get('content_type') or '(missing)'}",
        )
    return result
