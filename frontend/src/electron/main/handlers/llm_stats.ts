// Sprint 6 §2.2 — LLM dashboard IPC handlers (read-only).
//
// Surface for `/llm` route:
//   - llm:stats     — `mailagent llm stats --days N -o json` (read, no auth)
//   - llm:selftest  — `mailagent llm selftest -o json` (read, no auth, no token)
//
// Distinct from `llm:run` (handlers/write_ops.ts) which is a write op for
// a single email re-run; that channel stays as-is. Dashboard only needs
// the aggregate cost / cache hit / latency rollup that the backend already
// computes inside the `llm_processing` SQLite table.

import { ipcMain } from 'electron'

import { callCli } from '../cli_runner'

const READ_TIMEOUT_MS = 15_000
const SELFTEST_TIMEOUT_MS = 30_000

export interface LlmStatsData {
  /** Total `llm_processing` rows in the window. */
  total: number
  /** Status histogram: `success / failed / gave_up / pending / ...`. */
  by_status: Record<string, number>
  /** Window width in days; mirror of the request. */
  days: number
  /** Lower bound epoch seconds (CLI computed) — useful for re-running the
   *  same query from another client. */
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
  _source?: string
}

export interface LlmSelfTestData {
  healthy: boolean
  /** Optional diagnostic detail — typically the model id we pinged. */
  detail?: string
  /** Round-trip ms of the no-token health probe. */
  latency_ms?: number
}

export async function runLlmStats(days = 7): Promise<LlmStatsData> {
  // Clamp days to the CLI-supported range (1..365); the backend would error
  // anyway but doing it up front avoids burning a subprocess.
  const d = Math.max(1, Math.min(365, Math.floor(days)))
  return (await callCli(['llm', 'stats', '--days', String(d)], {
    timeoutMs: READ_TIMEOUT_MS
  })) as LlmStatsData
}

export async function runLlmSelfTest(): Promise<LlmSelfTestData> {
  return (await callCli(['llm', 'selftest'], {
    timeoutMs: SELFTEST_TIMEOUT_MS
  })) as LlmSelfTestData
}

export function registerLlmStatsHandlers(): void {
  ipcMain.handle('llm:stats', async (_evt, days: unknown = 7): Promise<LlmStatsData> => {
    const d = typeof days === 'number' && Number.isFinite(days) ? days : 7
    return runLlmStats(d)
  })
  ipcMain.handle('llm:selftest', async (): Promise<LlmSelfTestData> => runLlmSelfTest())
}

export const __testing = {
  runLlmStats,
  runLlmSelfTest
}
