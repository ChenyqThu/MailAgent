// Sprint 6 §2.2 — admin dashboard IPC handlers.
//
// Surface for `/admin` route:
//   - admin:health           — `mailagent admin health -o json` (read, no auth)
//   - admin:stats            — `mailagent admin stats -o json` (read, no auth)
//   - admin:deadLetterList   — `mailagent admin dead-letter list --limit N` (read)
//   - admin:deadLetterRetry  — `mailagent admin dead-letter retry <id>` (write+auth)
//   - admin:cleanupDeadLetter — `mailagent admin cleanup-deadletter --older-than N`
//                              + `--no-dry-run --yes` (write+auth)
//
// Read handlers return raw `data` (the CLI envelope is already unwrapped
// by `callCli`). Write handlers return `WriteEnvelope<T>` so the renderer
// gets the structured `{ ok, data | code+message+hint }` shape that
// survives the IPC boundary (Sprint 5 §2.2 envelope contract).

import { ipcMain } from 'electron'

import { CliError, callCli } from '../cli_runner'

type WriteEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; hint?: string }

function envelopeFromCli<T>(p: Promise<unknown>): Promise<WriteEnvelope<T>> {
  return p.then(
    (data): WriteEnvelope<T> => ({ ok: true, data: data as T }),
    (err: unknown): WriteEnvelope<T> => {
      if (err instanceof CliError) {
        return { ok: false, code: err.errorCode, message: err.message, hint: err.hint }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, code: 'E_DISPATCH', message }
    }
  )
}

const READ_TIMEOUT_MS = 15_000
const WRITE_TIMEOUT_MS = 60_000

export interface AdminHealthData {
  db_path: string
  db_accessible: boolean
  db_version: number
  db_version_expected: number
  schema_ok: boolean
  tables_present: string[]
  tables_missing: string[]
  healthy: boolean
}

export interface AdminStatsData {
  watcher?: Record<string, unknown>
  sync_store?: {
    total_emails: number
    by_status: Record<string, number>
    by_mailbox: Record<string, number>
    failure_queue: number
    last_max_row_id: number | null
    last_sync_time: string | null
    db_size_mb: number
    db_size_bytes: number
    _source?: string
  }
  handlers?: Record<string, unknown>
  v4_rollout?: {
    from_sqlite_hit: number
    fallback_miss: number
    fallback_error: number
    route_latency_p99_ms: number
    body_miss_internal_ids: number[]
    window_seconds: number
    _staleness_seconds?: number
    _source?: string
  }
}

export interface DeadLetterItem {
  internal_id: number
  mailbox: string | null
  subject: string | null
  sender: string | null
  date_received: string | null
  retry_count: number
  sync_status: string
  sync_error: string | null
  updated_at: string | null
}

export async function runAdminHealth(): Promise<AdminHealthData> {
  return (await callCli(['admin', 'health'], { timeoutMs: READ_TIMEOUT_MS })) as AdminHealthData
}

export async function runAdminStats(): Promise<AdminStatsData> {
  return (await callCli(['admin', 'stats'], { timeoutMs: READ_TIMEOUT_MS })) as AdminStatsData
}

export interface DeadLetterListOpts {
  limit?: number
  mailbox?: string
}

export async function runDeadLetterList(opts: DeadLetterListOpts = {}): Promise<DeadLetterItem[]> {
  const args = ['admin', 'dead-letter', 'list']
  if (opts.limit !== undefined) args.push('--limit', String(opts.limit))
  if (opts.mailbox) args.push('--mailbox', opts.mailbox)
  const out = await callCli(args, { timeoutMs: READ_TIMEOUT_MS })
  // CLI returns either `[...]` directly (newer) or `{items: [...]}` shape
  // depending on flag passthrough; normalize so the renderer always sees an
  // array.
  if (Array.isArray(out)) return out as DeadLetterItem[]
  if (out && typeof out === 'object' && Array.isArray((out as { items?: unknown }).items)) {
    return (out as { items: DeadLetterItem[] }).items
  }
  return []
}

export async function runDeadLetterRetry(internalId: number): Promise<unknown> {
  return callCli(['admin', 'dead-letter', 'retry', String(internalId)], {
    write: true,
    needsAuth: true,
    timeoutMs: WRITE_TIMEOUT_MS
  })
}

export interface CleanupDeadLetterOpts {
  /** Days; defaults to CLI's 30. */
  olderThan?: number
  dryRun?: boolean
}

export async function runCleanupDeadLetter(opts: CleanupDeadLetterOpts = {}): Promise<unknown> {
  const args = ['admin', 'cleanup-deadletter']
  if (opts.olderThan !== undefined) args.push('--older-than', String(opts.olderThan))
  if (opts.dryRun === false) args.push('--no-dry-run', '--yes')
  return callCli(args, {
    write: !opts.dryRun,
    needsAuth: !opts.dryRun,
    timeoutMs: WRITE_TIMEOUT_MS
  })
}

function ensureInternalId(value: unknown, channel: string): WriteEnvelope<never> | number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    return {
      ok: false,
      code: 'E_INVALID_ARG',
      message: `${channel}: expected non-negative integer internalId, got ${String(value)}`
    }
  }
  return value as number
}

export function registerAdminHandlers(): void {
  ipcMain.handle('admin:health', async (): Promise<AdminHealthData> => runAdminHealth())
  ipcMain.handle('admin:stats', async (): Promise<AdminStatsData> => runAdminStats())
  ipcMain.handle(
    'admin:deadLetterList',
    async (_evt, opts: DeadLetterListOpts = {}): Promise<DeadLetterItem[]> => {
      return runDeadLetterList(opts ?? {})
    }
  )
  ipcMain.handle(
    'admin:deadLetterRetry',
    async (_evt, internalId: unknown): Promise<WriteEnvelope<unknown>> => {
      const idOrErr = ensureInternalId(internalId, 'admin:deadLetterRetry')
      if (typeof idOrErr !== 'number') return idOrErr
      return envelopeFromCli(runDeadLetterRetry(idOrErr))
    }
  )
  ipcMain.handle(
    'admin:cleanupDeadLetter',
    async (_evt, opts: CleanupDeadLetterOpts = {}): Promise<WriteEnvelope<unknown>> => {
      return envelopeFromCli(runCleanupDeadLetter(opts ?? {}))
    }
  )
}

export const __testing = {
  runAdminHealth,
  runAdminStats,
  runDeadLetterList,
  runDeadLetterRetry,
  runCleanupDeadLetter,
  envelopeFromCli,
  ensureInternalId
}
