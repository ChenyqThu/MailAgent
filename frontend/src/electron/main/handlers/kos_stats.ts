// issue #59 R7 — KOS 入库台账 IPC handler (read-only).
//
// Surface for the `/llm` dashboard's「知识库入库」section:
//   - kos:stats — `mailagent kos stats --days N -o json` (read, no auth)
//
// Mirrors handlers/llm_stats.ts one-for-one: same clamp, same read timeout,
// same "the CLI owns the aggregation" division of labour. The SQL lives once
// in `src/kos/stats.py`; CLI and serve-api both call it, so the desktop and
// remote-web dashboards can't drift.

import { ipcMain } from 'electron'

import { callCli } from '../cli_runner'

const READ_TIMEOUT_MS = 15_000

/** `sync_state` 的 `kos.health.*` 投影; 从未探活过 → 整个对象为 null。
 *  渲染侧不要只判 null —— 上游曾返回「对象在、字段全 null」的形状。 */
export interface KosHealthSnapshot {
  ok: boolean
  checked_at: number | null
  /** 契约外的附加字段（排查用，可选消费）。 */
  detail?: string | null
  consecutive_failed_rounds?: number | null
}

export interface KosStatsData {
  /** Producer-side activation, computed by the backend (ingest flag AND the
   *  three bulk-client credentials). Deliberately NOT the consumer-side
   *  `/chat/config.kosConfigured` — different credentials, different feature. */
  enabled: boolean
  /** Window width in days; mirror of the request (-1 = all time). */
  days: number
  since_ts: number | null
  /** `kos_ingest_log` status histogram. Keys may be absent — treat as 0. */
  by_status: {
    pushed?: number
    failed?: number
    dead?: number
    skipped?: number
  }
  /** Error-code histogram over the failed rows; may be empty. */
  by_error_code: Record<string, number>
  /** Rows waiting on a retry sweep. */
  pending_retry: number
  /** Rows past the retry ceiling — these need a manual bulk ingest. */
  dead_count: number
  last_success_ts: number | null
  health: KosHealthSnapshot | null
  daily: Array<{ date: string; pushed: number; failed: number }>
  /** 'live_query' | 'table_missing' | 'schema_stale'. */
  _source?: string
}

export async function runKosStats(days = 7): Promise<KosStatsData> {
  // Clamp to the CLI-supported range (1..365) up front — same reasoning as
  // llm:stats: the backend would error anyway, no point burning a subprocess.
  const d = Math.max(1, Math.min(365, Math.floor(days)))
  return (await callCli(['kos', 'stats', '--days', String(d)], {
    timeoutMs: READ_TIMEOUT_MS
  })) as KosStatsData
}

export function registerKosStatsHandlers(): void {
  ipcMain.handle('kos:stats', async (_evt, days: unknown = 7): Promise<KosStatsData> => {
    const d = typeof days === 'number' && Number.isFinite(days) ? days : 7
    return runKosStats(d)
  })
}

export const __testing = {
  runKosStats
}
