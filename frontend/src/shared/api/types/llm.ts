import type { LlmRunOpts } from './email'
import type { MailagentLlmSelftest } from '@shared/types/cli.gen'

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
  /** 同一窗口、同一个 `status='success'` 口径下按 model 拆开（task 08-20-perf-dashboards）。
   *  全表 rollup 回答「花了多少」，这一段回答「花在谁身上」—— 换模型 / 加 fallback 链
   *  之后成本归属只能靠它。按 tokens 降序；`model` 为空的老行归到 `'(unknown)'`。
   *
   *  🔴 只有 serve-api（`src/api/routers/llm.py`）发它；`mailagent llm stats` 那份手抄
   *  SQL 至今没有这段，所以字段是可选的 —— 桌面看板已改走 serve-api，CLI 仍是旧形状。 */
  by_model?: Array<{
    model: string
    rows: number
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    avg_latency_ms: number
  }>
  /** How the numbers were obtained — `'live_query'` normally, `'table_missing'` when the
   *  `llm_processing` table doesn't exist yet (fresh install / pre-v37 DB), in which case
   *  every count above is a zero placeholder, not a measurement.
   *
   *  🔴 issue #68: both producers have always emitted it (`src/cli/commands/llm.py:333,390`
   *  and `src/api/routers/llm.py:257,307`) and the desktop main-process copy declared it —
   *  but this shared type, the one the dashboard actually reads, did not. So the degradation
   *  signal was unreachable on both transports and "0 calls, ¥0 cost" rendered identically
   *  whether the LLM was idle or the table was simply absent. Compare `KosStatsData`, where
   *  both sides have carried `_source` from the start. */
  _source?: string
}

/** GET /llm/selftest data block — the no-token gateway health probe.
 *
 *  Canonical wire = `docs/cli-schema/llm-selftest.schema.json` (codegen'd as
 *  `MailagentLlmSelftest` in shared/types/cli.gen.ts). BOTH producers emit exactly these
 *  six fields: serve-api `src/api/routers/llm.py::llm_selftest` → `LlmService.selftest`
 *  (`src/services/llm_service.py:160-184`) for web, and `mailagent llm selftest`
 *  (`src/cli/commands/llm.py:135-160`) for desktop.
 *
 *  🔴 This interface previously declared `detail?: string` + `latency_ms?: number`, neither
 *  of which exists on either producer — so `LlmDashboardPage`'s toast body read a field that
 *  was undefined by construction and the user saw a bare "gateway unreachable" with the real
 *  diagnosis ("LLM_API_KEY is empty") dropped on the floor. Keep this aligned with the
 *  schema, not with what a consumer wishes existed.
 *
 *  So it is no longer hand-written at all: DERIVED from the codegen'd type, the way
 *  `types/core.ts` already sources its email records. A hand-copied mirror is what let the
 *  two fictional fields survive; a derivation cannot drift — regenerate the schema and every
 *  consumer of the dropped/renamed field fails `pnpm run typecheck` instead of silently
 *  reading `undefined`. The fields it carries: healthy, reasons, api_base, primary_model,
 *  fallback_chain, llm_agent_enabled. `reasons` is the probe's ONLY diagnostic channel —
 *  always surface it. */
export type LlmSelfTestData = Extract<MailagentLlmSelftest, { status: 'success' }>['data']

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
