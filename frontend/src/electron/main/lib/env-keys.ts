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
  'MAIL_ACCOUNT_URL_PREFIX',

  // — DavMail backend (Onboarding 向导 davmail 分支 + legacy 迁移)。config.py 的
  // davmail Field 全集。向导写连接配置 (host/port/poc 模式/cipher), legacy 继承时
  // managed-filter 也要带过来 —— 之前缺这些 key 导致 davmail 老用户迁移丢配置 →
  // 后端起不来。DAVMAIL_POC_CIPHER_KEY / DAVMAIL_CIPHER_KEY 都是 secret。
  // 注: 后端 config.py 当前读 env=DAVMAIL_POC_CIPHER_KEY; 旧文档/报错曾用 DAVMAIL_CIPHER_KEY,
  // 两个都纳入白名单避免继承时丢 (后端是否 alias 二者见 roadmap follow-up)。
  'DAVMAIL_HOST',
  'DAVMAIL_IMAP_PORT',
  'DAVMAIL_SMTP_PORT',
  'DAVMAIL_POC_CIPHER_KEY',
  'DAVMAIL_CIPHER_KEY',
  'DAVMAIL_POC_MODE',
  'DAVMAIL_FETCH_TIMEOUT_SEC',
  'DAVMAIL_UID_BACKFILL_ENABLED',
  'DAVMAIL_UID_BACKFILL_BATCH_SIZE',
  'DAVMAIL_UID_BACKFILL_SLEEP_SEC',
  'DAVMAIL_DRAFTS_FOLDER',
  'DAVMAIL_SENT_FOLDER',
  'DAVMAIL_ARCHIVE_SENT',
  'DAVMAIL_POLL_INTERVAL_SEC',
  'DAVMAIL_CALDAV_PORT',

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
  'CALENDAR_CALDAV_SYNC_ENABLED',

  // — 多文件夹同步窗口 (SyncTab「自定义文件夹同步」区)。config.py folder_sync_past_days
  // / folder_sync_max_messages Field。SYNC_FOLDERS 白名单本身走 folder whitelist API
  // (后端 dotenv 写, 不经 env:set), 故不在此列。
  'FOLDER_SYNC_PAST_DAYS',
  'FOLDER_SYNC_MAX_MESSAGES',

  // — Backend selection (Onboarding 向导 backend 选择)。config.py 的 Field,
  // 值域 'applescript' | 'davmail' (Sprint 16 dual-backend cutover)。向导写入,
  // 默认 applescript (零依赖)。
  'MAILAGENT_BACKEND',

  // — Daily digest (Ping Island Phase 3 每日巡检)。config.py Field, boolean toggle,
  // 默认 false。向导插件勾选项之一 (plugins.digest → 这里)。
  'MAILAGENT_DAILY_DIGEST_ENABLED',

  // — AI Agent (PR D AiTab)
  'LLM_AGENT_ENABLED',
  'LLM_API_BASE',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_TRANSLATE_BASE_URL',
  'LLM_TRANSLATE_API_KEY',
  'LLM_TRANSLATE_MODEL',
  'LLM_FALLBACK_MODELS',
  // Hot-read by serve-api via dotenv_values — changing this does NOT require
  // a backend restart (AiTab handleToggleModel intentionally skips
  // markRestartRequired). Must be writable so the multi-select dropdown can
  // persist the enabled set via env:set.
  'LLM_ENABLED_MODELS',
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

  // — Remote Access (serve-api / RemoteAccessTab). V2 远程访问从 dogfood (手动
  // nohup serve-api) 收尾成生产态: serve-api 进程纳入打包 app 的
  // BackendLifecycleManager。这 5 个字段是 RemoteAccessTab 经 env:set 写 app .env
  // 的全集, 全部非 secret:
  //   - MAILAGENT_REMOTE_ACCESS_ENABLED: gate flag, !=='false' 即开 (默认开,
  //     bind loopback 零攻击面)。serveApiEnabled() 读它决定是否 spawn serve-api。
  //   - CF_AUDIENCE: Cloudflare Access Application "Audience" tag (公开应用标识非密钥)。
  //     auth.py 模块 import 期读它做 JWT aud 校验; 空则 serve-api 拒起 (软门控前提)。
  //   - CF_TEAM_DOMAIN: xxx.cloudflareaccess.com 团队域名 (JWKS issuer)。
  //   - MAILAGENT_API_PORT: 本地 API 端口 (默认 8200, bind 127.0.0.1)。
  //   - MAILAGENT_API_ALLOWED_EMAIL: 允许访问的邮箱 (留空=USER_EMAIL)。
  // CF_AUDIENCE 是 application tag 非密钥, 不入 SECRET_ENV_KEYS。改这些字段后需
  // 重启 serve-api 生效 (RestartBanner / Tab 内重启按钮触发)。
  'MAILAGENT_REMOTE_ACCESS_ENABLED',
  'CF_AUDIENCE',
  'CF_TEAM_DOMAIN',
  'MAILAGENT_API_PORT',
  'MAILAGENT_API_ALLOWED_EMAIL',

  // feat/auto-update re-review (codex, trust boundary) — AUTO_UPDATE_ENABLED is
  // intentionally NOT a managed key: it's the master safety gate for proactive
  // updater behavior, read directly via process.env in handlers/updater.ts.
  // Keeping it out of this list means env:set can never flip it from the renderer
  // before P6 notarization (enabling auto-update on an ad-hoc build → can't install).

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
  'MAILAGENT_CLI_API_KEY',
  'DAVMAIL_POC_CIPHER_KEY',
  'DAVMAIL_CIPHER_KEY',
  // codex r4 [HIGH] — MANAGED (returned) URLs whose value embeds a credential,
  // so they're redacted, not sent in plaintext. Parity mirror of
  // settings.py `_SECRET_ENV_KEYS`. ALERT_FEISHU_WEBHOOK_URL's trailing path
  // segment IS the bot token; REDIS_URL can carry an inline password
  // (`redis://[:password@]host:port`). Both stay in MANAGED_ENV_KEYS above
  // (L107 / L127) so env:get still returns them — just redacted.
  'ALERT_FEISHU_WEBHOOK_URL',
  'REDIS_URL'
])

/** Keys the UI surfaces as readonly display only. env:set on these is
 *  rejected with E_INVALID_KEY (they're not in MANAGED_ENV_KEYS, so the
 *  default reject path catches them — this set exists for documentation
 *  + the Settings UI knowing to render them disabled). */
export const READONLY_DISPLAY_KEYS: Set<string> = new Set<string>([
  'SSE_LOCAL_HOST',
  'SSE_LOCAL_PORT'
])
