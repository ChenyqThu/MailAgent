import type { AttachmentMeta } from './core'
import type { UpdateFlagOpts } from './email'

// ---- Sprint 6 §2.2 — SettingsPage surface --------------------------------

export type SecretSlot = 'cliApiKey' | 'llmApiKey' | 'llmTranslateApiKey' | 'customApiKey'

export interface SecretsStatus {
  cliApiKey: boolean
  llmApiKey: boolean
  llmTranslateApiKey: boolean
  customApiKey: boolean
}

export interface PersistentSettings {
  dbPath: string | null
  attachmentDir: string | null
  pollIntervalSec: 5 | 10 | 30 | 0
  notionAgentPageId: string | null
  notionAgentName: string | null
  customApiEndpoint: string | null
  /** feat/auto-update — auto-download an available update when the master
   *  AUTO_UPDATE_ENABLED flag is on. Default true; IslandUpdatesTab toggles it. */
  autoDownloadUpdates: boolean
  /** Owner's email — sourced from repo-root `.env` USER_EMAIL on every
   *  settings:get read. Read-only; the renderer doesn't write this. */
  userEmail: string | null
  /** 邮件签名 (HTML/纯文本)。compose 工具栏「签名」按钮在光标处插入。
   *  null/空 = 未设置。SettingsPanel 的签名编辑框写入。 */
  signature: string | null
}

export interface PingResult {
  ok: boolean
  detail?: string
  code?: string
}

export interface SettingsApi {
  /** Returns booleans only — the secret values never leave keytar. */
  secretsStatus(): Promise<SecretsStatus>
  /** Empty string clears the slot; otherwise stores in keytar. */
  setSecret(slot: SecretSlot, value: string): Promise<SecretsStatus>
  clearSecret(slot: SecretSlot): Promise<SecretsStatus>
  get(): Promise<PersistentSettings>
  set(partial: Partial<PersistentSettings>): Promise<PersistentSettings>
  /** Native folder picker. Returns absolute path or null on cancel. */
  pickFolder(title?: string): Promise<string | null>
  /** Pings the LLM gateway via `mailagent llm selftest`. */
  testLlm(): Promise<PingResult>
  /** Soft check: confirms custom-api-key + endpoint configured. */
  testCustomApi(): Promise<PingResult>
}

export interface NotionWriteApi {
  /** Sprint 5 — push read/flagged/processing_status to the Notion mail page. */
  updateFlag(internalId: number, opts: UpdateFlagOpts): Promise<unknown>
}

export interface AttachmentApi {
  list(internalId: number): Promise<AttachmentMeta[]>
  /** Returns a `file://`-safe local absolute path, or null if the attachment
   *  hasn't been persisted to disk (e.g. inline images that live only in MIME). */
  localPath(attachmentId: number): Promise<string | null>
  /** Sprint 13 — same content as `localPath` but inlined as a
   *  `data:<mime>;base64,...` URL. The sandboxed body iframe can't load
   *  `file://` URLs (same-origin policy under srcdoc) so inline images
   *  (cid: refs) substitute the data URL instead. Returns null when
   *  the file is missing or the read fails. */
  readDataUrl(attachmentId: number): Promise<string | null>
  /** Copy the on-disk attachment into the user's ~/Downloads, returning the
   *  final absolute path. Collides safely (appends `_1`, `_2`, …). Returns
   *  null when the row has no on-disk content or the source file is missing.
   *  Renderer cannot open `file://` URLs from the dev-server origin, so this
   *  exists as the user-visible "download attachment" affordance. */
  download(attachmentId: number): Promise<string | null>
}

// ---- Sprint 18 §PR B — repo-root .env read/write + pm2 services surface --
//
// Settings tabs (PR D) read the resolved `.env` once via env:get + cache it
// in zustand; on field-blur they call env:set({KEY: value}) which atomic-
// writes the file and returns restartRequired=true. RestartBanner (PR E)
// then surfaces and calls services:restart('mail-sync').

/** Mirror of `EnvSnapshot` in `electron/main/handlers/env.ts`. SECRET keys
 *  carry only '***' (set) or '' (unset) — plaintext never crosses IPC. */
export interface EnvSnapshot {
  path: string
  exists: boolean
  values: Record<string, string>
  managedKeys: readonly string[]
  secretKeys: string[]
}

export type EnvSetResult =
  | { ok: true; path: string; changedKeys: string[]; restartRequired: boolean }
  | {
      ok: false
      path: string
      error: { code: 'E_INVALID_KEY' | 'E_NOT_FOUND' | 'E_WRITE'; message: string }
    }

export interface EnvApi {
  /** Read the resolved `.env` snapshot. Secret values redacted. */
  get(): Promise<EnvSnapshot>
  /** Merge-write keys into the resolved `.env`. `null` value comments out
   *  the line (preserves the key for future re-enable). Returns a result
   *  envelope (not an exception) so the renderer can branch on error codes
   *  without losing the `code` property through the IPC structured-clone. */
  set(patch: Record<string, string | null>): Promise<EnvSetResult>
}

export type ServiceTarget = 'mail-sync' | 'calendar-sync' | 'all' | 'serve-api'

export interface ServiceRestartResult {
  ok: boolean
  target: string
  exitCode: number | null
  stdout: string
  stderr: string
  error?: {
    code: 'E_PM2_NOT_FOUND' | 'E_PM2_FAILED' | 'E_TIMEOUT' | 'E_INVALID_ARG'
    message: string
    /** Set on E_PM2_NOT_FOUND so the renderer toast can quote the exact
     *  terminal command. */
    fallbackCommand?: string
  }
}

export interface ServiceStatus {
  name: 'mail-sync' | 'calendar-sync'
  state: 'online' | 'stopped' | 'errored' | 'unknown'
  pid: number | null
  uptimeMs: number | null
  cpu: number | null
  memMB: number | null
}

export interface ServicesApi {
  /** Spawn `pm2 restart <target>`. Default target = `mail-sync`. */
  restart(target?: ServiceTarget): Promise<ServiceRestartResult>
  /** `pm2 jlist` → both known service slots, even when pm2 doesn't list one
   *  (returns `state: 'unknown'`). */
  status(): Promise<ServiceStatus[]>
}

// ---- LLM prompt files ---------------------------------------------------

export type PromptSlot = 'inbox' | 'sent'

export interface PromptInfo {
  slot: PromptSlot
  path: string
  exists: boolean
}

export interface PromptContent extends PromptInfo {
  content: string
}

export type PromptWriteResult =
  | { ok: true; info: PromptInfo }
  | { ok: false; code: string; message: string }

export interface PromptsApi {
  /** Read one prompt's content. Missing file returns `{exists:false, content:''}`. */
  read(slot: PromptSlot): Promise<PromptContent>
  /** Write content to the resolved path; auto-mkdir parent. */
  write(slot: PromptSlot, content: string): Promise<PromptWriteResult>
}

// ── Notion Agent CLI config (notion-agent-cli) ───────────────────────────
//
// The Notion Agent chat backend shells out to the local `notion-agent` CLI,
// which keeps its own account file (~/.notionagents/notion_account.json)
// holding the token_v2 cookie + the bound Custom Agent. This surface lets
// Settings show that binding and switch the bound agent / default model;
// token auth stays with the CLI (`notion-agent init`).

export interface NotionAgentConfig {
  /** The account file path we read/write (the symlink, not its target). */
  accountPath: string
  /** Resolved `notion-agent` binary path. */
  cliPath: string
  /** Whether that binary exists on disk. */
  cliFound: boolean
  /** account.json readable AND token_v2 present → backend can run. */
  configured: boolean
  /** token_v2 is set (value never leaves the main process). */
  tokenPresent: boolean
  userName: string | null
  userEmail: string | null
  spaceName: string | null
  spaceId: string | null
  /** Bound Custom Agent display name. */
  agentName: string | null
  /** Bound Custom Agent page id (account.agent_context_page_id). */
  agentPageId: string | null
  agentAccessory: string | null
  defaultModel: string | null
  timezone: string | null
}

/** One row of `notion-agent doctor --json`. */
export interface NotionAgentDoctorCheck {
  status: string
  check: string
  detail: string
}

/** One Custom Agent from `notion-agent agents list --json`. */
export interface NotionAgentListItem {
  agent_id: string
  name: string
  agent_page_id: string
  description: string | null
  icon: string | null
  most_recent_thread_title?: string | null
}

export interface NotionAgentApi {
  /** Read account.json binding + token presence. Never throws — a
   *  missing/garbled file yields configured:false. */
  getConfig(): Promise<NotionAgentConfig>
  /** Friendly model alias keys from models.json (empty when absent). */
  listModels(): Promise<string[]>
  /** Live `doctor --json` connectivity/auth readout. Throws (err.code) on
   *  CLI failure (not-installed / produced no output). */
  doctor(): Promise<NotionAgentDoctorCheck[]>
  /** Custom Agents in the bound workspace. Throws (err.code) on failure. */
  listAgents(): Promise<NotionAgentListItem[]>
  /** Bind a Custom Agent (writes account.json). Returns refreshed config. */
  setAgent(pageId: string, name: string, accessory?: string | null): Promise<NotionAgentConfig>
  /** Set the default model alias (writes account.json). Returns refreshed config. */
  setModel(alias: string): Promise<NotionAgentConfig>
}
