// Sprint 18 — managed `.env` keys whitelist (SSoT).
//
// `env:get` filters its return shape to MANAGED_ENV_KEYS; `env:set` hard-
// rejects any key not in MANAGED_ENV_KEYS with E_INVALID_KEY. Two reasons:
//
//   1. Pydantic's BaseSettings(extra='ignore') silently drops stray keys —
//      a typo writes "NOTIN_TOKEN=..." to .env, Python ignores it, mail-sync
//      keeps using the old value, user sees "didn't save" with zero error.
//      Whitelist catches typos at the IPC boundary.
//   2. Many ENV keys are gray-rollout flags / internal tuning knobs
//      (BODY_DUAL_WRITE_ENABLED / LLM_PREFER_SQLITE_BODY / INIT_BATCH_SIZE /
//      APPLESCRIPT_TIMEOUT 等). Exposing those via env:set would let users
//      break the gray-rollout state. Sprint 18 Tier 1 + Advanced = 42 keys;
//      remaining ~50 ENV keys stay invisible.
//
// Maintaining: add a key here AND surface it in a Tab (PR D / PR F). The
// reverse check (env:set rejects keys with no Tab UI) isn't enforced — a
// future Tab can land while the whitelist already covers the field.

/** All keys the renderer is allowed to read AND write through env:* IPC. */
export const MANAGED_ENV_KEYS = [
  // — Accounts (PR D AccountsTab)
  'NOTION_TOKEN',
  'EMAIL_DATABASE_ID',
  'CALENDAR_DATABASE_ID',
  'USER_EMAIL',
  'MAIL_ACCOUNT_NAME',
  'MAIL_INBOX_NAME',
  'MAIL_SENT_NAME',

  // — Sync (PR D SyncTab)
  'SYNC_DATE_MODE',
  'SYNC_START_DATE',
  'SYNC_LOOKBACK_DAYS',
  'SYNC_MAILBOXES',
  'RADAR_POLL_INTERVAL',
  'REVERSE_SYNC_INTERVAL',
  'HEALTH_CHECK_INTERVAL',
  'SYNC_MODE',
  'CALENDAR_SYNC_MODE',
  'CALENDAR_PAST_DAYS',
  'CALENDAR_FUTURE_DAYS',

  // — AI Agent (PR D AiTab)
  'LLM_AGENT_ENABLED',
  'LLM_API_BASE',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_TRANSLATE_BASE_URL',
  'LLM_TRANSLATE_API_KEY',
  'LLM_TRANSLATE_MODEL',
  'LLM_FALLBACK_MODELS',
  'LLM_CONTEXT_PAGE_ID',
  'LLM_INBOX_PROMPT_PATH',
  'LLM_SENT_PROMPT_PATH',
  'LLM_CACHE_ENABLED',
  'LLM_CACHE_TTL',

  // — Notifications (PR D NotificationsTab)
  'FEISHU_NOTIFY_ENABLED',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_CHAT_ID',
  'ALERT_ENABLED',
  'ALERT_FEISHU_WEBHOOK_URL',
  'ALERT_FEISHU_WEBHOOK_SECRET',
  'ALERT_LEVELS',

  // — Integrations (PR D IntegrationsTab)
  'PROJECT_PROGRESS_SYNC_ENABLED',
  'PROJECT_PROGRESS_AUTO_SYNC_ENABLED',
  'PROJECT_PROGRESS_DATABASE_ID',
  'PROJECT_PROGRESS_FILTER_BU',
  'PROJECT_PROGRESS_SUBJECT_PATTERN',
  'PROJECT_PROGRESS_SENDER',
  'OFFICE_CONVERT_ENABLED',
  'STATS_REPORT_URL',
  'STATS_REPORT_INTERVAL',
  'STATS_REPORT_TOKEN',
  'DASHBOARD_PASSWORD',
  'MAILAGENT_CLI_API_KEY',

  // — Realtime & Storage (PR D RealtimeStorageTab + PR F Advanced)
  'REDIS_EVENTS_ENABLED',
  'REDIS_URL',
  'BODY_DUAL_WRITE_ENABLED',
  'MAILAGENT_SSE_ENABLED',
  'LOG_LEVEL',
  'MAILAGENT_OUTBOX_ENABLED',
  'MAILAGENT_OUTBOX_POLL_INTERVAL_SEC',
  'MAILAGENT_OUTBOX_MAX_ATTEMPTS',
  'MAILAGENT_OUTBOX_CONCURRENCY',

  // — Agent Harness + KOS (Sprint 19 — chat agent multi-turn loop + Jarvis
  // KOS v2 producer/consumer integration). 全是 boolean toggle, 默认 false.
  // OAuth credentials (KOS_OAUTH_CLIENT_ID / SECRET) + endpoint (KOS_MCP_BASE)
  // 暂不在白名单 — 走 .env 手动管理, 未来若做 Settings 'AI Agent' tab 第二段
  // 再加 SECRET_ENV_KEYS 项.
  'MAILAGENT_AGENT_HARNESS',
  'MAILAGENT_KOS_CONSUMER_ENABLED',
  'MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED',
  'MAILAGENT_KOS_INGEST_ENABLED',
  'MAILAGENT_KOS_TIME_DECAY_ENABLED',

  // — Island (PR D IslandUpdatesTab)
  'PING_ISLAND_ENABLED',
  'ISLAND_SOCKET_PATH',

  // — Advanced / readonly display (PR F RealtimeStorageTab disclosure).
  // These two land here so `env:get` returns them for read-only rendering,
  // but EnvField control="readonly" never calls env:set on them, so the
  // whitelist branch in `env:set` returns "no change" if anything ever
  // tries (renderer code shouldn't, this is belt + suspenders).
  'SSE_LOCAL_HOST',
  'SSE_LOCAL_PORT'
] as const

export type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number]

/** O(1) membership check. */
export const MANAGED_ENV_KEY_SET: Set<string> = new Set<string>(MANAGED_ENV_KEYS)

/** Keys whose values must NEVER cross IPC in plaintext. env:get redacts these
 *  to '***' (length > 0) or '' (unset). env:set accepts plaintext writes but
 *  doesn't log them. The renderer's password-input + write-only contract means
 *  users either type a new value or clear it; they can never read an existing
 *  secret back out — that's by design (DESIGN.md + SPRINT18-HANDOFF.md §pasta-
 *  prevention: a stolen renderer never has the secret). */
export const SECRET_ENV_KEYS: Set<string> = new Set<string>([
  'NOTION_TOKEN',
  'FEISHU_APP_SECRET',
  'ALERT_FEISHU_WEBHOOK_SECRET',
  'LLM_API_KEY',
  'LLM_TRANSLATE_API_KEY',
  'STATS_REPORT_TOKEN',
  'DASHBOARD_PASSWORD',
  'MAILAGENT_CLI_API_KEY'
])

/** Keys the UI surfaces as readonly display only. env:set on these is
 *  rejected with E_INVALID_KEY (they're not in MANAGED_ENV_KEYS, so the
 *  default reject path catches them — this set exists for documentation
 *  + the Settings UI knowing to render them disabled). */
export const READONLY_DISPLAY_KEYS: Set<string> = new Set<string>([
  'SSE_LOCAL_HOST',
  'SSE_LOCAL_PORT'
])
