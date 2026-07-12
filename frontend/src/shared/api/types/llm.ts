import type { LlmRunOpts } from './email'

// ---- Sprint 6 §2.2 — LLM dashboard surface --------------------------------

export interface LlmStatsData {
  total: number
  by_status: Record<string, number>
  days: number
  since_ts: number
  cost: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
    cache_hit_rate_pct: number
    avg_latency_ms: number
    success_rows: number
  }
}

export interface LlmSelfTestData {
  healthy: boolean
  detail?: string
  latency_ms?: number
}

/** dynamic-models — serve-api GET /api/llm/models response. */
export interface LlmUpstreamModelsData {
  models: string[]
  cached: boolean
  cached_at: number | null
  error?: string
}

export interface LlmApi {
  /** Sprint 5 — re-run AI classification for one email via `mailagent llm run`. */
  run(internalId: number, opts?: LlmRunOpts): Promise<unknown>
  /** Sprint 6 — aggregate stats for the LLM dashboard (cost / cache hit / latency). */
  stats(days?: number): Promise<LlmStatsData>
  /** Sprint 6 — no-token health probe for the LLM gateway. */
  selftest(): Promise<LlmSelfTestData>
  /** dynamic-models — fetch upstream model list (GET /api/llm/models).
   *  Pass refresh=true to bypass the server-side 5-min TTL cache.
   *  Pass provider='translate' to fetch from the translation provider instead of
   *  the main LLM gateway (falls back to main if LLM_TRANSLATE_BASE_URL is unset). */
  listUpstreamModels(opts?: {
    refresh?: boolean
    provider?: 'main' | 'translate'
  }): Promise<LlmUpstreamModelsData>
}
