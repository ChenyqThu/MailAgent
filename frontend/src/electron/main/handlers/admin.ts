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

import { app, dialog, ipcMain } from 'electron'
import { copyFileSync, rmSync } from 'fs'
import { basename, dirname } from 'path'

import { callCli } from '../cli_runner'
import { getDb } from '../db'
import { ensureInternalId, envelopeFromCli, type WriteEnvelope } from '../lib/envelope'

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

// ── DavMail health + system alerts (roadmap §4.5) ─────────────────────────
//
// 直读 SQLite `sync_state` 表的 davmail.* keys (mail-sync 进程内的
// DavMailWatchdog 每 60s 写一份快照). 不走 callCli/fork mailagent,
// admin handler 模式 ~1ms vs CLI ~500ms — 顶部红点 badge 5s 轮询不能 fork.
// 系统告警从同一份快照派生 (current-state 模型而非 event stream),
// 跟 watchdog 自己的 "announced once until cleared" 去重语义一致.

export interface DavMailHealthData {
  enabled: boolean
  level: 'ok' | 'warning' | 'critical' | 'unknown'
  last_probe_at: string | null
  imap_reachable: boolean
  smtp_reachable: boolean
  consecutive_imap_failures: number
  consecutive_smtp_failures: number
  /** L2a — real IMAP LOGIN probe. Null when skipped (TCP down / disabled). */
  imap_login_ok?: boolean | null
  consecutive_login_failures?: number
  token_age_days: number | null
  token_mtime_iso: string | null
  throttle_events_5min: number
  last_oauth_error: string | null
  last_oauth_error_at: string | null
  uid_backfill_paused: boolean
}

export interface SystemAlertItem {
  level: 'critical' | 'warning' | 'info'
  source: string
  title: string
  message: string
  ts: string | null
}

export interface SystemAlertsData {
  alerts: SystemAlertItem[]
  critical_count: number
  warning_count: number
  generated_at: string
}

function readDavmailStateRows(): Record<string, string> {
  const db = getDb()
  const stmt = db.prepare(
    "SELECT key, value FROM sync_state WHERE key LIKE 'davmail%' OR key = 'davmail_uid_backfill_paused'"
  )
  const rows = stmt.all() as Array<{ key: string; value: string }>
  const out: Record<string, string> = {}
  for (const r of rows) out[r.key] = r.value ?? ''
  return out
}

export function runDavmailHealth(): DavMailHealthData {
  let state: Record<string, string>
  try {
    state = readDavmailStateRows()
  } catch {
    // SQLite 不可达 (路径错 / 文件锁) — 视为 unknown, 不抛
    return {
      enabled: false,
      level: 'unknown',
      last_probe_at: null,
      imap_reachable: false,
      smtp_reachable: false,
      consecutive_imap_failures: 0,
      consecutive_smtp_failures: 0,
      imap_login_ok: null,
      consecutive_login_failures: 0,
      token_age_days: null,
      token_mtime_iso: null,
      throttle_events_5min: 0,
      last_oauth_error: null,
      last_oauth_error_at: null,
      uid_backfill_paused: false
    }
  }
  const lastProbe = state['davmail.last_probe_at'] || null
  // 没 last_probe_at 说明 mail-sync 没在 davmail mode 跑 watchdog
  if (!lastProbe) {
    return {
      enabled: false,
      level: 'unknown',
      last_probe_at: null,
      imap_reachable: false,
      smtp_reachable: false,
      consecutive_imap_failures: 0,
      consecutive_smtp_failures: 0,
      imap_login_ok: null,
      consecutive_login_failures: 0,
      token_age_days: null,
      token_mtime_iso: null,
      throttle_events_5min: 0,
      last_oauth_error: null,
      last_oauth_error_at: null,
      uid_backfill_paused: state['davmail_uid_backfill_paused'] === 'true'
    }
  }
  const tokenAgeRaw = state['davmail.token_age_days']
  const tokenAge = tokenAgeRaw ? parseFloat(tokenAgeRaw) : -1
  const imapOk = state['davmail.imap_reachable'] === '1'
  const smtpOk = state['davmail.smtp_reachable'] === '1'
  const imapFails = parseInt(state['davmail.consecutive_imap_failures'] || '0', 10)
  const smtpFails = parseInt(state['davmail.consecutive_smtp_failures'] || '0', 10)
  // L2a: '' = 该轮跳过 login 探测 (TCP down / 开关关 / 未注入 cfg) → null
  const loginRaw = state['davmail.imap_login_ok']
  const loginOk = loginRaw === '1' ? true : loginRaw === '0' ? false : null
  const loginFails = parseInt(state['davmail.consecutive_login_failures'] || '0', 10)
  const throttleCount = parseInt(state['davmail.throttle_events_5min'] || '0', 10)
  const lastOAuthErr = state['davmail.last_oauth_error'] || null
  const lastOAuthAt = state['davmail.last_oauth_error_at'] || null
  const oauthRecent = !!lastOAuthAt && Date.now() - Date.parse(lastOAuthAt) < 3600 * 1000

  let level: DavMailHealthData['level'] = 'ok'
  if (oauthRecent) level = 'critical'
  else if (!imapOk && imapFails >= 3) level = 'critical'
  else if (!smtpOk && smtpFails >= 3) level = 'critical'
  // L2a: TCP 可达但 LOGIN 连续失败 = token 劣化 (镜像 watchdog 阈值 3)
  else if (loginFails >= 3) level = 'critical'
  else if (tokenAge >= 87) level = 'critical'
  else if (tokenAge >= 80) level = 'warning'
  else if (throttleCount >= 3) level = 'warning'
  else if (!imapOk || !smtpOk) level = 'warning'

  return {
    enabled: true,
    level,
    last_probe_at: lastProbe,
    imap_reachable: imapOk,
    smtp_reachable: smtpOk,
    consecutive_imap_failures: imapFails,
    consecutive_smtp_failures: smtpFails,
    imap_login_ok: loginOk,
    consecutive_login_failures: loginFails,
    token_age_days: tokenAge >= 0 ? tokenAge : null,
    token_mtime_iso: state['davmail.token_mtime_iso'] || null,
    throttle_events_5min: throttleCount,
    last_oauth_error: lastOAuthErr,
    last_oauth_error_at: lastOAuthAt,
    uid_backfill_paused: state['davmail_uid_backfill_paused'] === 'true'
  }
}

export function runSystemAlerts(): SystemAlertsData {
  const h = runDavmailHealth()
  const alerts: SystemAlertItem[] = []
  if (h.enabled && h.last_oauth_error && h.last_oauth_error_at) {
    const ageMs = Date.now() - Date.parse(h.last_oauth_error_at)
    if (ageMs < 3600 * 1000) {
      alerts.push({
        level: 'critical',
        source: 'davmail',
        title: 'DavMail OAuth 续期失败',
        message: h.last_oauth_error,
        ts: h.last_oauth_error_at
      })
    }
  }
  if (h.enabled && h.token_age_days !== null) {
    if (h.token_age_days >= 87) {
      alerts.push({
        level: 'critical',
        source: 'davmail',
        title: 'DavMail OAuth token 紧急过期',
        message: `token.dat ${h.token_age_days.toFixed(1)} 天未刷新, 估剩余 ${Math.max(0, 90 - h.token_age_days).toFixed(0)} 天`,
        ts: h.last_probe_at
      })
    } else if (h.token_age_days >= 80) {
      alerts.push({
        level: 'warning',
        source: 'davmail',
        title: 'DavMail OAuth token 即将过期',
        message: `token.dat ${h.token_age_days.toFixed(1)} 天未刷新, 估剩余 ${Math.max(0, 90 - h.token_age_days).toFixed(0)} 天`,
        ts: h.last_probe_at
      })
    }
  }
  if (h.enabled && !h.imap_reachable) {
    if (h.consecutive_imap_failures >= 3) {
      alerts.push({
        level: 'critical',
        source: 'davmail',
        title: 'DavMail IMAP 端口不可达',
        message: `连续 ${h.consecutive_imap_failures} 次 TCP probe 失败`,
        ts: h.last_probe_at
      })
    } else {
      alerts.push({
        level: 'warning',
        source: 'davmail',
        title: 'DavMail IMAP 探测失败',
        message: `连续 ${h.consecutive_imap_failures} 次失败 (<3, 还没到 critical)`,
        ts: h.last_probe_at
      })
    }
  }
  if (h.enabled && !h.smtp_reachable) {
    if (h.consecutive_smtp_failures >= 3) {
      alerts.push({
        level: 'critical',
        source: 'davmail',
        title: 'DavMail SMTP 端口不可达',
        message: `连续 ${h.consecutive_smtp_failures} 次 TCP probe 失败`,
        ts: h.last_probe_at
      })
    } else {
      alerts.push({
        level: 'warning',
        source: 'davmail',
        title: 'DavMail SMTP 探测失败',
        message: `连续 ${h.consecutive_smtp_failures} 次失败 (<3, 还没到 critical)`,
        ts: h.last_probe_at
      })
    }
  }
  // L2a: TCP 可达但 IMAP LOGIN 连续失败 = token 劣化 (能发不能收)
  if (h.enabled && (h.consecutive_login_failures ?? 0) >= 3) {
    alerts.push({
      level: 'critical',
      source: 'davmail',
      title: 'DavMail IMAP LOGIN 持续失败',
      message: `端口可达但 LOGIN 连续 ${h.consecutive_login_failures} 次失败 — token 劣化 (能发不能收), 建议 pm2 restart davmail-poc`,
      ts: h.last_probe_at
    })
  }
  if (h.enabled && h.throttle_events_5min >= 3) {
    alerts.push({
      level: 'warning',
      source: 'davmail',
      title: 'DavMail EWS throttling',
      message: `5min 内 ${h.throttle_events_5min} 次 throttle, uid-mapper 已暂停`,
      ts: h.last_probe_at
    })
  }
  return {
    alerts,
    critical_count: alerts.filter((a) => a.level === 'critical').length,
    warning_count: alerts.filter((a) => a.level === 'warning').length,
    generated_at: new Date().toISOString()
  }
}

// ── E4 §4.2 — 诊断包导出 (本地 Electron 专属) ────────────────────────────────
//
// fork `mailagent admin export-diagnostics` (读命令, 无 auth) 在 tmp 组装 zip
// (近 7 天日志 + 脱敏配置快照 + health/db_check/manifest), 前端拿 zip_path 后弹保存
// 对话框: 用户确认则 copy 到目标 + 清 tmp, 取消则直接清 tmp。quick_check 最坏 24s×2
// (sync_store + agent_config), 故 callCli timeout 放大到 3min (远超默认 60s)。远程
// web 不走此路 (HttpAdminApi 不实现 exportDiagnostics, AdminApi 该方法为 optional)。

const DIAGNOSTICS_TIMEOUT_MS = 180_000

export interface ExportDiagnosticsResult {
  /** True when the user picked a save location and the zip was copied there. */
  saved: boolean
  /** Absolute path the zip was saved to (only when saved=true). */
  path?: string
}

interface DiagnosticsCliData {
  zip_path?: string
  size_bytes?: number
  entry_count?: number
  skipped?: string[]
}

/** tmp zip 落在 Python `tempfile.mkdtemp()` 目录下 (该目录只含这一个 zip) → 删掉整个
 *  临时目录即完整清理, best-effort (失败交给 OS tmp 回收)。 */
function cleanupDiagnosticsTmp(zipPath: string): void {
  try {
    rmSync(dirname(zipPath), { recursive: true, force: true })
  } catch {
    /* 清理失败无所谓 — OS tmp 最终回收 */
  }
}

export async function runExportDiagnostics(): Promise<ExportDiagnosticsResult> {
  const data = (await callCli(['admin', 'export-diagnostics', '--app-version', app.getVersion()], {
    timeoutMs: DIAGNOSTICS_TIMEOUT_MS
  })) as DiagnosticsCliData
  const zipPath = data?.zip_path
  if (typeof zipPath !== 'string' || zipPath.length === 0) {
    throw new Error('export-diagnostics 未返回 zip_path')
  }
  const result = await dialog.showSaveDialog({
    title: '保存诊断包',
    defaultPath: basename(zipPath),
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) {
    // 用户取消 → 清理 tmp zip, 不当错误。
    cleanupDiagnosticsTmp(zipPath)
    return { saved: false }
  }
  try {
    copyFileSync(zipPath, result.filePath)
  } finally {
    cleanupDiagnosticsTmp(zipPath)
  }
  return { saved: true, path: result.filePath }
}

export function registerAdminHandlers(): void {
  ipcMain.handle('admin:health', async (): Promise<AdminHealthData> => runAdminHealth())
  ipcMain.handle('admin:stats', async (): Promise<AdminStatsData> => runAdminStats())
  ipcMain.handle('admin:davmailHealth', async (): Promise<DavMailHealthData> => runDavmailHealth())
  ipcMain.handle('admin:systemAlerts', async (): Promise<SystemAlertsData> => runSystemAlerts())
  ipcMain.handle(
    'admin:exportDiagnostics',
    async (): Promise<ExportDiagnosticsResult> => runExportDiagnostics()
  )
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
  runExportDiagnostics,
  envelopeFromCli,
  ensureInternalId
}
