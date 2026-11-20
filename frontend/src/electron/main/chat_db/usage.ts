// Phase 4 WP-4B — 辅助 LLM 调用（auto_title / compact / search_agent / translate / nl_search /
// paused_turn / py_loopback 杂项消耗）的 ai_llm_usage_log 台账写入（ai_chat.db v33）。

import { getChatDb } from './connection'

export interface LlmUsageLogInput {
  surface: string
  providerId?: string | null
  model: string
  protocol?: string | null
  tokensInput?: number | null
  tokensOutput?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  costUsd?: number | null
  latencyMs?: number | null
  status?: 'ok' | 'error'
  errorCode?: string | null
  createdAt?: number
}

export function appendLlmUsageLog(input: LlmUsageLogInput): number {
  const now = input.createdAt ?? Date.now()
  const result = getChatDb()
    .prepare(
      `INSERT INTO ai_llm_usage_log
        (surface, provider_id, model, protocol, tokens_input, tokens_output,
         cache_read_tokens, cache_write_tokens, cost_usd, latency_ms,
         status, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.surface,
      input.providerId ?? null,
      input.model,
      input.protocol ?? null,
      input.tokensInput ?? null,
      input.tokensOutput ?? null,
      input.cacheReadTokens ?? null,
      input.cacheWriteTokens ?? null,
      input.costUsd ?? null,
      input.latencyMs ?? null,
      input.status ?? 'ok',
      input.errorCode ?? null,
      now
    )
  return Number(result.lastInsertRowid)
}
