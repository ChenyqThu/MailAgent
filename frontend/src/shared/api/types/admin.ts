// ---- Sprint 6 §2.2 — admin dashboard surface ------------------------------

import type { MailagentAdminHealth } from '@shared/types/cli.gen'

/** `admin health` data block — ONE type serving two producers:
 *    - desktop: `mailagent admin health` (CLI), the canonical
 *      `docs/cli-schema/admin-health.schema.json` contract;
 *    - web: serve-api `GET /api/admin/health` (`src/api/routers/admin.py::admin_health`),
 *      which emits the same block with exactly one deliberate deviation, encoded below.
 *
 *  DERIVED from the codegen'd schema type rather than hand-copied — the hand-copy had dropped
 *  `notes` and `davmail` entirely (both have been on BOTH producers' wire all along, so E4's
 *  crashloop / token-aging diagnostics were computed every call and thrown away for want of a
 *  type) and had pinned `db_version` as non-null where the schema says `integer | null`. */
export type AdminHealthData = Omit<MailagentAdminHealth['data'], 'db_path'> & {
  /** 🔴 Optional because the WEB half never sends it: `admin_health` redacts the absolute path
   *  on purpose (C9 "不回显绝对 db_path" — host layout is a deployment detail). The CLI half
   *  does send it, and the canonical schema marks it required, which is why this type used to
   *  declare it required and AdminPage's db_path hint silently vanished on web. */
  db_path?: string
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
  /** Raw float epoch **seconds** (the DB column `email_metadata.updated_at =
   *  time.time()`), surfaced verbatim by both the CLI list + serve-api. NOT an
   *  ISO string — `formatRelative` branches on the number type to render it. */
  updated_at: number | null
}

export interface DeadLetterListOpts {
  limit?: number
  mailbox?: string
}

export interface CleanupDeadLetterOpts {
  olderThan?: number
  dryRun?: boolean
}

// ── DavMail health snapshot (roadmap §4.5.1-3) — frontend reads sync_state
// davmail.* keys via direct better-sqlite3 (no CLI fork) every 5s for the
// red-dot badge + AdminPage card. Source-of-truth: DavMailWatchdog writes
// these keys every 60s.
export interface DavMailHealthData {
  /** False when mail-sync isn't in davmail mode (no watchdog ticks yet). */
  enabled: boolean
  level: 'ok' | 'warning' | 'critical' | 'unknown'
  last_probe_at: string | null
  imap_reachable: boolean
  smtp_reachable: boolean
  consecutive_imap_failures: number
  consecutive_smtp_failures: number
  /** L2a — real IMAP LOGIN probe result. Null/undefined when the probe was
   *  skipped (TCP down / probe disabled / cfg not injected / older backend). */
  imap_login_ok?: boolean | null
  /** Consecutive LOGIN failures; >= login_fail_threshold drives level critical (token degraded). */
  consecutive_login_failures?: number
  /** The threshold the watchdog actually applied (F5 — propagated via sync_state
   *  `davmail.login_fail_threshold` so the UI can't drift from the alerting rule).
   *  🔴 DESKTOP ONLY on the wire: `handlers/admin.ts` reads the sync_state key directly and
   *  emits it, but the web producer (`src/api/routers/admin.py::_build_davmail_health`)
   *  computes `_login_fail_threshold(state)` for its own level decision and does NOT put it in
   *  the response. So absent ≠ "3" — the owner may have configured
   *  DAVMAIL_LOGIN_FAIL_THRESHOLD to something else. Render the ratio only when it is present;
   *  substituting a default here would just be a different wrong number on screen. */
  login_fail_threshold?: number
  /** Days since token.dat mtime. Null when token.dat missing. */
  token_age_days: number | null
  token_mtime_iso: string | null
  /** Count of EWSThrottlingException headers in last 5 min log tail. */
  throttle_events_5min: number
  last_oauth_error: string | null
  last_oauth_error_at: string | null
  /** Watchdog auto-pauses uid-mapper when throttling >= 3 in 5min. */
  uid_backfill_paused: boolean
  /** davmail.folderSizeLimit 同步状态 (mail-sync 启动时把 DAVMAIL_FOLDER_SIZE_LIMIT
   *  写进 davmail.properties, 见 src/mail/davmail_properties.py)。与 watchdog 独立,
   *  故 enabled=false 时也可能有值; 键全缺 (老后端 / 从未跑过) → null。
   *  file_missing = 找不到 davmail.properties → 该设置**不生效**, UI 必须如实说。 */
  folder_size_limit_status?: 'updated' | 'unchanged' | 'file_missing' | 'error' | 'disabled' | null
  folder_size_limit_path?: string | null
  folder_size_limit_desired?: number | null
  /** davmail.properties 里实际的值 (读不到 → null)。 */
  folder_size_limit_file_value?: number | null
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
  /** Server-side ISO timestamp; renderer uses it for tooltip "as of". */
  generated_at: string
}

export interface AdminApi {
  health(): Promise<AdminHealthData>
  stats(): Promise<AdminStatsData>
  deadLetterList(opts?: DeadLetterListOpts): Promise<DeadLetterItem[]>
  /** Re-arms a dead-letter email for retry (write+auth). Throws Error & { code }
   *  on failure exactly like the other write methods. */
  deadLetterRetry(internalId: number): Promise<unknown>
  /** Permanently deletes a dead-letter email (write+auth, irreversible). Goes
   *  through delete_email_full → CASCADE (body/attachment/outbox) + local dir.
   *  The UI must gate this behind a confirm dialog. */
  deadLetterDelete(internalId: number): Promise<unknown>
  /** Run the cleanup-deadletter command (write+auth unless dryRun). */
  cleanupDeadLetter(opts?: CleanupDeadLetterOpts): Promise<unknown>
  /** roadmap §4.5 — current davmail backend health snapshot (direct SQLite
   *  read, ~1ms). Returns enabled=false when watchdog hasn't ticked. */
  davmailHealth(): Promise<DavMailHealthData>
  /** Current active system alerts derived from davmail health + (future)
   *  other sources. Polled by SystemAlertBadge every 5s. */
  systemAlerts(): Promise<SystemAlertsData>
  /** E4 §4.2 — 导出诊断包 (仅 Electron 本地: 打包近 7 天日志 + 脱敏配置快照 +
   *  health/db_check/manifest, 弹保存对话框让用户选路径)。**可选方法** —— 远程 HTTP
   *  实现不提供, Settings 按钮以此方法存在性判断是否渲染。saved=false 表示用户取消。 */
  exportDiagnostics?(): Promise<{ saved: boolean; path?: string }>
}
