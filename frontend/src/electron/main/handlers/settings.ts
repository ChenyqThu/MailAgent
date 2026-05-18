// Sprint 6 §2.2 — SettingsPage IPC handlers.
//
// Three classes of state:
//   1. Secrets (cli / llm / custom-api keys) → keytar via `keychain.ts`
//      (NEVER returned verbatim to the renderer; only `{set: boolean}` shape
//      from `settings:secrets:status`).
//   2. Persistent settings (DB path / attachment dir / poll interval /
//      custom-api endpoint / Notion Agent agent_page_id) → file-backed JSON
//      at `<userData>/settings.json`.
//   3. Test pings → fire-and-forget probes for the secret slots so the user
//      gets a green check without us echoing the secret.
//
// Theme mode / accent stay in `appearance.ts` (legacy + bootNativeTheme
// requires read at boot); we keep that file's surface unchanged.

import { app, dialog, ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { isAbsolute, join, normalize } from 'path'

import {
  clearCliApiKey,
  clearCustomApiKey,
  clearLlmApiKey,
  getCustomApiKey,
  getSecretsStatus,
  setCliApiKey,
  setCustomApiKey,
  setLlmApiKey,
  type SecretsStatus
} from '../keychain'
// Sprint 6 review (opus MEDIUM #4): dropped dynamic `await import('./llm_stats')`
// in favour of a static import — they're already eagerly loaded by `index.ts`,
// so the dynamic ceremony added a Vite warning + extra microtask without any
// code-split benefit. Static import path is settings → llm_stats → cli_runner
// → keychain; no circular dependency.
import { runLlmSelfTest } from './llm_stats'

const SETTINGS_FILE = join(app.getPath('userData'), 'settings.json')

export interface PersistentSettings {
  /** Override of the default `~/Documents/MailAgent/data/sync_store.db` path. */
  dbPath: string | null
  /** Override of the default attachment root (`~/Documents/MailAgent/data/attachments`). */
  attachmentDir: string | null
  /** Poll interval seconds for the inbox list (5 / 10 / 30 / 0=off). */
  pollIntervalSec: 5 | 10 | 30 | 0
  /** Notion Agent page_id used by the AI Chat panel (Sprint 4 reads from
   *  localStorage; we also persist into main-side settings so a future
   *  headless / V2 web path picks it up). */
  notionAgentPageId: string | null
  notionAgentName: string | null
  /** Custom-API base URL — the key lives in keytar (custom-api-key). */
  customApiEndpoint: string | null
}

const DEFAULTS: PersistentSettings = {
  dbPath: null,
  attachmentDir: null,
  pollIntervalSec: 5,
  notionAgentPageId: null,
  notionAgentName: null,
  customApiEndpoint: null
}

function readSettings(): PersistentSettings {
  try {
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULTS }
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<PersistentSettings>
    return { ...DEFAULTS, ...sanitize(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

// Sprint 7 Day 1 (Sprint 6 review opus MEDIUM #1 carry-forward) — gate
// `dbPath` / `attachmentDir` through a path-validation check before we ever
// persist them. Sprint 7 wires `better-sqlite3.Database(s.dbPath)` directly
// off this value (alongside the existing fs.readFile attachment lookup), so
// any traversal sequence or relative segment passed through the IPC would
// open a file outside the user's chosen scope.
//
// Policy:
//   - null is always accepted (means "fall back to default").
//   - non-string is rejected (drops out of the partial).
//   - string must be absolute AND not contain a `..` traversal segment
//     anywhere in the raw value. Anything else is dropped silently — the
//     renderer keeps showing the previous value, no DoS via spammy errors.
//
// IMPORTANT: we inspect the RAW string for `..` segments, not the normalized
// one — `path.normalize('/Users/me/../../etc/passwd')` returns `/etc/passwd`
// (the `..` is collapsed away), which would silently let a traversal slip
// through if we only looked at the normalized form. We still call normalize
// to confirm the result remains absolute (a leading `..` could escape into
// `..` territory on some platforms).
//
// We deliberately do NOT check existence here: the user can configure a
// path for a drive that's mounted on next boot. Read-time will fail loud.
function isSafeUserPath(value: string): boolean {
  if (value.length === 0) return false
  if (!isAbsolute(value)) return false
  // Raw-segment scan — must run before normalization.
  const rawSegments = value.split(/[/\\]/).filter(Boolean)
  if (rawSegments.includes('..')) return false
  // Normalize as a paranoid second check: the normalized form must remain
  // absolute (defends against constructed inputs that pass isAbsolute() but
  // resolve into a relative path after normalize on this platform).
  const normalized = normalize(value)
  if (!isAbsolute(normalized)) return false
  return true
}

function sanitize(raw: Partial<PersistentSettings>): Partial<PersistentSettings> {
  const out: Partial<PersistentSettings> = {}
  if (raw.dbPath === null) {
    out.dbPath = null
  } else if (typeof raw.dbPath === 'string' && isSafeUserPath(raw.dbPath)) {
    out.dbPath = raw.dbPath
  }
  if (raw.attachmentDir === null) {
    out.attachmentDir = null
  } else if (typeof raw.attachmentDir === 'string' && isSafeUserPath(raw.attachmentDir)) {
    out.attachmentDir = raw.attachmentDir
  }
  if (
    raw.pollIntervalSec === 5 ||
    raw.pollIntervalSec === 10 ||
    raw.pollIntervalSec === 30 ||
    raw.pollIntervalSec === 0
  ) {
    out.pollIntervalSec = raw.pollIntervalSec
  }
  if (typeof raw.notionAgentPageId === 'string' || raw.notionAgentPageId === null) {
    out.notionAgentPageId = raw.notionAgentPageId
  }
  if (typeof raw.notionAgentName === 'string' || raw.notionAgentName === null) {
    out.notionAgentName = raw.notionAgentName
  }
  if (typeof raw.customApiEndpoint === 'string' || raw.customApiEndpoint === null) {
    out.customApiEndpoint = raw.customApiEndpoint
  }
  return out
}

function writeSettings(s: PersistentSettings): void {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8')
  } catch (err) {
    // Surface the failure in the main process log; renderer doesn't get the
    // FS error directly — caller's `setSettings()` resolves anyway since the
    // in-memory return shape is the canonical (just-merged) value.
    console.error('[settings] write failed:', err)
  }
}

export interface SecretWriteRequest {
  secret: 'cliApiKey' | 'llmApiKey' | 'customApiKey'
  value: string
}

export interface PingResult {
  ok: boolean
  /** Optional human-readable detail — e.g. CRS account id, model echoed back. */
  detail?: string
  /** When ok=false, code surfaces what failed: E_NO_KEY / E_NETWORK / E_AUTH /
   *  E_UNREACHABLE / E_UPSTREAM. */
  code?: string
}

async function pingLlmEndpoint(): Promise<PingResult> {
  // We piggyback on the existing `mailagent llm selftest` instead of opening
  // a new HTTP connection from the renderer — it already knows how to find
  // the configured CRS endpoint + handle the no-token health probe, and the
  // CLI is on the user's PATH by the time settings is reachable. This keeps
  // the secret out of the renderer entirely.
  try {
    const data = await runLlmSelfTest()
    return { ok: data.healthy, detail: data.detail }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code =
      err && typeof err === 'object' && 'errorCode' in err
        ? String((err as { errorCode?: unknown }).errorCode)
        : 'E_UNREACHABLE'
    return { ok: false, code, detail: msg }
  }
}

async function pingCustomApi(): Promise<PingResult> {
  // Custom API endpoint check stays minimal — Sprint 7 will add a richer
  // health probe (CRS `/models` lookup, key auth verify). For Sprint 6 we
  // just confirm: endpoint configured + key in keychain. Renderer can then
  // smoke-test by sending an actual chat turn.
  const key = await getCustomApiKey()
  if (!key) return { ok: false, code: 'E_NO_KEY', detail: 'custom-api-key not in keychain' }
  const s = readSettings()
  if (!s.customApiEndpoint) {
    return { ok: false, code: 'E_NO_ENDPOINT', detail: 'customApiEndpoint not set' }
  }
  return { ok: true, detail: `Configured: ${s.customApiEndpoint}` }
}

export function registerSettingsHandlers(): void {
  // ---- secrets (status only, never values) -------------------------------
  ipcMain.handle('settings:secrets:status', async (): Promise<SecretsStatus> => {
    return getSecretsStatus()
  })

  ipcMain.handle(
    'settings:secrets:set',
    async (_evt, req: SecretWriteRequest): Promise<SecretsStatus> => {
      if (!req || typeof req.value !== 'string') {
        throw new Error('settings:secrets:set: expected { secret, value: string }')
      }
      switch (req.secret) {
        case 'cliApiKey':
          await setCliApiKey(req.value)
          break
        case 'llmApiKey':
          await setLlmApiKey(req.value)
          break
        case 'customApiKey':
          await setCustomApiKey(req.value)
          break
        default:
          throw new Error(`settings:secrets:set: unknown secret slot "${String(req.secret)}"`)
      }
      return getSecretsStatus()
    }
  )

  ipcMain.handle(
    'settings:secrets:clear',
    async (_evt, slot: SecretWriteRequest['secret']): Promise<SecretsStatus> => {
      switch (slot) {
        case 'cliApiKey':
          await clearCliApiKey()
          break
        case 'llmApiKey':
          await clearLlmApiKey()
          break
        case 'customApiKey':
          await clearCustomApiKey()
          break
        default:
          throw new Error(`settings:secrets:clear: unknown slot "${String(slot)}"`)
      }
      return getSecretsStatus()
    }
  )

  // ---- persistent settings -----------------------------------------------
  ipcMain.handle('settings:get', async (): Promise<PersistentSettings> => readSettings())

  ipcMain.handle(
    'settings:set',
    async (_evt, partial: Partial<PersistentSettings>): Promise<PersistentSettings> => {
      const merged: PersistentSettings = { ...readSettings(), ...sanitize(partial ?? {}) }
      writeSettings(merged)
      return merged
    }
  )

  // ---- folder picker dialogs --------------------------------------------
  ipcMain.handle('settings:pickFolder', async (_evt, title?: string): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: typeof title === 'string' && title.length > 0 ? title : 'Choose folder'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ---- secret ping tests -------------------------------------------------
  ipcMain.handle('settings:test:llm', async (): Promise<PingResult> => pingLlmEndpoint())
  ipcMain.handle('settings:test:customApi', async (): Promise<PingResult> => pingCustomApi())
}

export const __testing = {
  readSettings,
  writeSettings,
  sanitize,
  isSafeUserPath,
  DEFAULTS,
  SETTINGS_FILE
}
