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
import type { LlmSelfTestData, LlmStatsData } from '@shared/api/types/llm'

const READ_TIMEOUT_MS = 15_000
const SELFTEST_TIMEOUT_MS = 30_000

/** `mailagent llm stats -o json` data block. Re-exported from the shared type rather than
 *  redeclared here — same reason as `LlmSelfTestData` below, and issue #68 is the proof:
 *  the two hand-written copies drifted on `_source`, so the dashboard (which reads the
 *  shared one) could never see the `table_missing` degradation the CLI has always sent. */
export type { LlmStatsData }

/** `mailagent llm selftest -o json` data block. Re-exported from the shared type (itself
 *  derived from llm-selftest.schema.json) rather than redeclared here: the local copy used to
 *  declare `detail` / `latency_ms`, which NEITHER the CLI nor serve-api has ever emitted, and
 *  a second hand-written copy is exactly how that survived. */
export type { LlmSelfTestData }

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
