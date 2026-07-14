// ---- Sprint 6 §2.2 — admin dashboard surface ------------------------------

export interface AdminHealthData {
  db_path: string
  db_accessible: boolean
  db_version: number
  db_version_expected: number
  schema_ok: boolean
  tables_present: string[]
  tables_missing: string[]
  healthy: boolean
  /** E4 §4 — supervise worker 心跳 (sync_state 'worker.%' 键反解), keyed by worker
   *  name。镜像 docs/cli-schema/admin-health.schema.json 的 workers 子对象。当前无
   *  前端展示消费, 仅建模后端返回面。`stale`=该 worker 的 last_started_at 早于本次
   *  进程 boot (flag 关掉的 worker 留的旧快照, E4 §4 第二批新增, 非 stale 时不写)。 */
  workers?: Record<
    string,
    {
      status?: string
      last_started_at?: string
      restart_count?: number | string
      last_error?: string
      stale?: boolean
    }
  >
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
  /** Consecutive LOGIN failures; >= 3 drives level critical (token degraded). */
  consecutive_login_failures?: number
  /** Days since token.dat mtime. Null when token.dat missing. */
  token_age_days: number | null
  token_mtime_iso: string | null
  /** Count of EWSThrottlingException headers in last 5 min log tail. */
  throttle_events_5min: number
  last_oauth_error: string | null
  last_oauth_error_at: string | null
  /** Watchdog auto-pauses uid-mapper when throttling >= 3 in 5min. */
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
