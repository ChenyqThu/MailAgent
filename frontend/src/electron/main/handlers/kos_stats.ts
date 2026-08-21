// issue #59 R7 — KOS 入库台账 IPC handler (read-only).
//
// Surface for the `/llm` dashboard's「知识库入库」section:
//   - kos:stats — GET /api/kos/stats?days=N (read, 本机 serve-api)
//
// Mirrors handlers/llm_stats.ts one-for-one: same clamp, same transport
// (daemonRead → 常驻 serve-api, task 08-20-perf-dashboards; 此前 fork CLI, 与
// llm:stats 并发两次 Python 冷启 = /llm 挂载即 ~1s)。聚合 SQL 只有一份, 在
// `src/kos/stats.py`; CLI 与 serve-api 都调它, 桌面与远程 web 看板不会漂移。

import { ipcMain } from 'electron'

import { daemonRead } from '../daemon_api'

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
   *  `/chat/config.kosConfigured` — different credentials, different feature.
   *  Equivalent to `gate === 'active'`. */
  enabled: boolean
  /** issue #64 — gate tri-state; the renderer's only criterion for "hide the
   *  whole section / show why / render normally". `flag_off` = the user never
   *  turned ingest on (default) → hide; `missing_credentials` = it IS on but
   *  credentials are missing → must show why, never hide silently. */
  gate?: 'active' | 'flag_off' | 'missing_credentials'
  /** Which env keys are missing when `gate === 'missing_credentials'`.
   *  🔴 Key NAMES only — never values (two of them are credentials). */
  missing_keys?: string[]
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
  /** issue #64 — the same histogram over ALL time, unaffected by `days`. The
   *  window count alone reads as "knowledge base total", and it drops by an
   *  order of magnitude the day a one-off bulk run rolls out of the window. */
  by_status_all?: {
    pushed?: number
    failed?: number
    dead?: number
    skipped?: number
  }
  /** All-time ledger row count (= sum of `by_status_all`); ignores `days`. */
  total_all?: number
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
  // Clamp to the backend-supported range (1..365) up front — same reasoning as
  // llm:stats: days=0 是 E_INVALID_ARG, 夹一下就不用把这个错误摆到看板上。
  const d = Math.max(1, Math.min(365, Math.floor(days)))
  return daemonRead<KosStatsData>('/kos/stats', { query: { days: String(d) } })
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
