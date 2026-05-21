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
import { join } from 'path'

import {
  clearCliApiKey,
  clearCustomApiKey,
  clearLlmApiKey,
  clearLlmTranslateApiKey,
  getCustomApiKey,
  getSecretsStatus,
  setCliApiKey,
  setCustomApiKey,
  setLlmApiKey,
  setLlmTranslateApiKey,
  type SecretsStatus
} from '../keychain'
// Sprint 8 §2.2 — shared with `db.ts:settingsDbPathOverride()` so the
// IPC sanitizer and the actual DB-open call validate paths identically.
import { isSafeUserPath } from '../lib/path-guard'
// Sprint 18 §PR B — single source of truth for the `.env` path. The
// USER_EMAIL reader below used to keep its own candidate list; now it
// resolves the same file that env:* IPC and the Python CLI consume.
import { resolveEnvPath } from '../lib/env-path'
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
  /** Sprint 11 V1.4 — owner's email address, surfaced in the nav-shell
   *  account header. Sourced from the repo-root `.env` USER_EMAIL key at
   *  every settings:get read (NOT user-writable). The Sidebar's
   *  `deriveAccount(userEmail)` derives the badge + monogram from this. */
  userEmail: string | null
}

const DEFAULTS: PersistentSettings = {
  dbPath: null,
  attachmentDir: null,
  pollIntervalSec: 5,
  notionAgentPageId: null,
  notionAgentName: null,
  customApiEndpoint: null,
  userEmail: null
}

/** Sprint 11 V1.4 — read USER_EMAIL from the repo-root `.env`. The file is
 *  the same one the Python backend reads, so the owner-of-the-SQLite-SSoT
 *  edits one source. Sprint 18 §PR B — candidate resolution moved to
 *  `lib/env-path.ts:resolveEnvPath()` so env:* IPC and this reader share
 *  one truth. The shell-override (`process.env.USER_EMAIL`) still wins for
 *  ad-hoc dev sessions. */
function loadUserEmailFromEnv(): string | null {
  const shellVar = process.env.USER_EMAIL
  if (shellVar && shellVar.includes('@')) return shellVar.trim()
  try {
    const p = resolveEnvPath()
    const txt = readFileSync(p, 'utf8')
    const match = txt.match(/^\s*USER_EMAIL\s*=\s*(.+?)\s*$/m)
    if (match && match[1].includes('@')) {
      return match[1].replace(/^["']|["']$/g, '').trim()
    }
  } catch {
    /* .env unreadable — fall through to null */
  }
  return null
}

function readSettings(): PersistentSettings {
  let persisted: Partial<PersistentSettings> = {}
  try {
    if (existsSync(SETTINGS_FILE)) {
      persisted = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<PersistentSettings>
    }
  } catch {
    /* corrupt file — fall through to defaults */
  }
  const userEmail = loadUserEmailFromEnv()
  return { ...DEFAULTS, ...sanitize(persisted), userEmail }
}

// Sprint 7 Day 1 (Sprint 6 review opus MEDIUM #1) — `isSafeUserPath` moved
// to `lib/path-guard.ts` in Sprint 8 so `db.ts:settingsDbPathOverride()`
// shares the predicate with the IPC sanitizer (Sprint 7 ship-review
// MEDIUM #1: the sanitizer was dead code without the wire-through). Policy
// unchanged: null accepted, non-string dropped, string must be absolute +
// no `..` segments in the raw value.
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
  secret: 'cliApiKey' | 'llmApiKey' | 'llmTranslateApiKey' | 'customApiKey'
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
        case 'llmTranslateApiKey':
          await setLlmTranslateApiKey(req.value)
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
        case 'llmTranslateApiKey':
          await clearLlmTranslateApiKey()
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
