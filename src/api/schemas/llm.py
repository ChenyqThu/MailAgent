"""LLM endpoint response models (llm.{run,stats,selftest}).

stats/selftest mirror the cli-schema shapes AND the frontend LlmStatsData /
LlmSelfTestData. Note the frontend LlmSelfTestData ({healthy, detail?,
latency_ms?}) is a REDUCED projection of the richer CLI selftest data
({healthy, api_base, primary_model, fallback_chain, llm_agent_enabled,
reasons}); we model the full CLI shape (extra=allow) so the router can forward
it, and the frontend reads only the subset it needs.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


# --- llm run ----------------------------------------------------------------
class LlmRunData(BaseModel):
    """`POST /api/llm/run/{id}` (llm-run.schema.json). Loose: data is additionalProperties:true."""

    model_config = {"extra": "allow"}

    internal_id: int = Field(..., ge=0)
    dry_run: bool
    page_id: Optional[str] = None
    mailbox: Optional[str] = None
    skipped: Optional[str] = None
    labels: Optional[dict[str, Any]] = None
    writer_summary: Optional[Any] = None  # object | string | null
    stored_at: Optional[float] = None


# --- llm stats --------------------------------------------------------------
class LlmCost(BaseModel):
    """Cost / cache / latency rollup (llm-stats.schema.json cost)."""

    input_tokens: int = Field(..., ge=0)
    output_tokens: int = Field(..., ge=0)
    cache_creation_input_tokens: int = Field(..., ge=0)
    cache_read_input_tokens: int = Field(..., ge=0)
    cache_hit_rate_pct: float = Field(..., ge=0)
    avg_latency_ms: int = Field(..., ge=0)
    success_rows: int = Field(..., ge=0)


class LlmStatsData(BaseModel):
    """`GET /api/llm/stats` (llm-stats.schema.json). Alias: LlmStatsData."""

    model_config = {"extra": "allow"}

    total: int = Field(..., ge=0)
    by_status: dict[str, int]
    days: int
    since_ts: Optional[float] = None
    cost: LlmCost


# --- llm selftest -----------------------------------------------------------
class LlmSelfTestData(BaseModel):
    """`GET /api/llm/selftest` (llm-selftest.schema.json — FULL CLI shape).

    Frontend LlmSelfTestData reads only {healthy, detail?, latency_ms?}; the
    extra CLI fields are forwarded harmlessly.
    """

    model_config = {"extra": "allow"}

    healthy: bool
    api_base: Optional[str] = None
    primary_model: Optional[str] = None
    fallback_chain: Optional[list[str]] = None
    llm_agent_enabled: Optional[bool] = None
    reasons: Optional[list[str]] = None
    # Frontend-projection fields (may be absent in the CLI data).
    detail: Optional[str] = None
    latency_ms: Optional[int] = None


__all__ = ["LlmRunData", "LlmCost", "LlmStatsData", "LlmSelfTestData"]
