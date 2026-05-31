// Sprint 8 §2.2 — electron-updater bridge.
//
// MailAgent ships via electron-builder → GitHub Releases (ad-hoc signed).
// On launch we wire `autoUpdater` (electron-updater package) to a tight set
// of IPC channels so the renderer can:
//   - read current/latest version + state (`updater:status`)
//   - trigger check / download / install on user action
//   - subscribe to state broadcasts (`updater:event`)
//
// Design choices:
//   - `autoDownload = false` — show "Update available" first, let the user
//     confirm. Auto-downloading a 100MB dmg on launch without consent is
//     hostile to bandwidth-constrained users (CRS context: this app talks
//     to LLM gateways with paid quotas).
//   - `autoInstallOnAppQuit = true` — once downloaded, install silently
//     on quit so the user doesn't have to manage the dialog twice.
//   - Production-only auto-check: in dev (`is.dev`), `app-update.yml` is
//     absent, so calling `checkForUpdates()` would throw. We surface the
//     dev sentinel via `state: 'dev-disabled'` and skip the auto-tick.
//   - State machine is single-string + small payload. The renderer mirrors
//     it through `useUpdaterStore` zustand. No per-event React state
//     re-render storm: every event collapses into one publish.
//
// feat/auto-update §gap-fill — two NEW proactive behaviors gated behind the
// master AUTO_UPDATE_ENABLED env flag (default OFF; flip ON only after P6
// notarization, since ad-hoc-signed builds can't actually install):
//   (a) auto-download-on-available — Scheme 2: we keep autoDownload=false
//       (preserves the existing test invariant + smaller blast radius) and
//       instead fire downloadUpdate() ourselves from the update-available
//       listener, but only when the master flag is on AND settings.json's
//       `autoDownloadUpdates` is true (read LIVE per event, never cached).
//   (b) periodic re-check — a 6h setInterval, armed only in the non-dev bound
//       branch when the master flag is on; cleared on app before-quit.
// The existing 10s startup check + Settings manual check/download/install are
// UNCHANGED (zero regression) — the flag does NOT gate them.

import { app, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'

// feat/auto-update gap A — static import is SAFE: `updater → settings` is
// acyclic (settings.ts never imports updater), and settings.ts's transitive
// keychain/cli_runner graph is already eagerly loaded at boot via
// registerSettingsHandlers in index.ts, so there's no extra blast radius. A
// lazy require() was rejected because the ESM test runner (vitest) doesn't
// honour CJS require for mocked modules; a static import is what
// `vi.mock('./settings')` intercepts cleanly.
import { readSettings } from './settings'

/** Auto-check tick after launch (production only). Gives the user a few
 *  seconds of unblocked UI before the network handshake fires. */
const AUTO_CHECK_DELAY_MS = 10_000

/** feat/auto-update gap C — periodic re-check cadence (6h). Armed only when
 *  the master flag is on AND we're in the non-dev bound branch. */
const AUTO_RECHECK_INTERVAL_MS = 21_600_000

/** feat/auto-update — master flag (AUTO_UPDATE_ENABLED), parsed in
 *  registerUpdaterHandlers via the chat/config.ts idiom. Module-level so the
 *  update-available listener (gap A) and the interval arming (gap C) both see
 *  it without threading it through every closure. Default false. */
let masterFlagEnabled = false

/** feat/auto-update gap C — id of the periodic re-check interval, so
 *  before-quit / __resetForTesting can clear it (no leaked timers in tests). */
let _recheckInterval: ReturnType<typeof setInterval> | null = null

/** Parse AUTO_UPDATE_ENABLED with the chat/config.ts:9-12 idiom (accepts
 *  "1" or "true", case-insensitive; unset/empty → false). */
function readMasterFlag(): boolean {
  const raw = process.env.AUTO_UPDATE_ENABLED
  if (raw === undefined || raw === '') return false
  return raw === '1' || raw.toLowerCase() === 'true'
}

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'dev-disabled'

export interface UpdaterStatus {
  state: UpdaterState
  /** From package.json — what's currently running. */
  currentVersion: string
  /** Set when `update-available` or `update-not-available` arrives. */
  latestVersion: string | null
  /** 0-100; defined during downloading. */
  downloadPercent: number | null
  /** Free-form: error message or rephrased latestVersion summary. */
  message: string | null
  /** When the last state transition happened (epoch ms). */
  updatedAt: number
  /** feat/auto-update — true ONLY when (master flag on) AND (state !==
   *  'dev-disabled') AND (an updater is bound). Set once at bind time in
   *  registerUpdaterHandlers; the dev-disabled early-return keeps it false.
   *  Renderer gates the proactive banner + unsigned-build notice on it. */
  enabled: boolean
}

let _status: UpdaterStatus = {
  state: 'idle',
  currentVersion: '0.0.0',
  latestVersion: null,
  downloadPercent: null,
  message: null,
  updatedAt: Date.now(),
  enabled: false
}

let _initialized = false

function setStatus(patch: Partial<UpdaterStatus>): void {
  _status = { ..._status, ...patch, updatedAt: Date.now() }
  broadcast(_status)
}

function broadcast(status: UpdaterStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updater:event', status)
    }
  }
}

/**
 * Wire `electron-updater` events → setStatus broadcasts.
 *
 * Exported separately so unit tests can drive the updater module with a
 * stub instead of pulling in the real `autoUpdater` (which would attempt
 * to talk to GitHub at module-load time during `pnpm test`).
 */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: unknown
  on(event: 'checking-for-update', listener: () => void): void
  on(event: 'update-available', listener: (info: UpdateInfo) => void): void
  on(event: 'update-not-available', listener: (info: UpdateInfo) => void): void
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): void
  on(event: 'update-downloaded', listener: (info: UpdateInfo) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export function bindAutoUpdater(updater: AutoUpdaterLike): void {
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = true
  // Silence the default winston-style log. The renderer's status stream is
  // the source of truth; we'll forward errors via `state: 'error'` instead.
  updater.logger = null

  updater.on('checking-for-update', () => {
    // feat/auto-update — a periodic re-check (gap C) fires 'checking-for-update'
    // BEFORE re-emitting 'update-available'; don't let it flip a staged build to
    // 'checking' (that defeated the same-version guard below — codex HIGH).
    if (hasStagedBuild()) return
    setStatus({ state: 'checking', message: null })
  })
  updater.on('update-available', (info: UpdateInfo) => {
    // feat/auto-update review (correctness lens) — a periodic re-check (gap C)
    // re-emits 'update-available' for a version we've ALREADY staged. Without
    // this guard the state would flip back to 'available' (the proactive banner
    // + Settings install card vanish out from under the user) and the
    // auto-download below would re-fire a redundant downloadUpdate(). Ignore the
    // re-discovery of the same version while it's downloading/downloaded; a
    // genuinely newer version (different number) falls through and supersedes.
    if (
      (_status.state === 'downloaded' || _status.state === 'downloading') &&
      _status.latestVersion === info.version
    ) {
      return
    }
    setStatus({
      state: 'available',
      latestVersion: info.version,
      message: info.releaseName ?? null
    })
    // feat/auto-update gap A (Scheme 2) — auto-download WITHOUT flipping
    // updater.autoDownload (kept false above to preserve the existing test
    // invariant + minimize blast radius). Gate: master flag on AND the LIVE
    // settings.json `autoDownloadUpdates` toggle is true (read per-event so a
    // mid-session Settings change takes effect on the next available update).
    if (masterFlagEnabled && readAutoDownloadSetting()) {
      maybeAutoDownload()
    }
  })
  updater.on('update-not-available', (info: UpdateInfo) => {
    // feat/auto-update re-review (MEDIUM) — a re-check that finds the running
    // version is latest (e.g. the staged release was retracted) must not
    // downgrade a staged build out of 'downloaded'; keep the install CTA.
    if (hasStagedBuild()) return
    setStatus({
      state: 'not-available',
      latestVersion: info.version,
      message: null
    })
  })
  updater.on('download-progress', (progress: ProgressInfo) => {
    setStatus({
      state: 'downloading',
      downloadPercent: Math.round(progress.percent),
      message: null
    })
  })
  updater.on('update-downloaded', (info: UpdateInfo) => {
    setStatus({
      state: 'downloaded',
      latestVersion: info.version,
      downloadPercent: 100,
      message: info.releaseName ?? null
    })
  })
  updater.on('error', (err: Error) => {
    // feat/auto-update re-review (codex + UX, MEDIUM) — a transient error from a
    // background re-check must not clobber a staged build's state (which would
    // vanish the banner + install CTA with no path back until restart). A real
    // download failure still surfaces via maybeAutoDownload()/download()'s catch.
    if (hasStagedBuild()) return
    setStatus({ state: 'error', message: err.message })
  })
}

/**
 * Public API for the IPC handlers + tests. Holds a reference to the bound
 * updater object so handlers can trigger check / download / install.
 */
let _bound: AutoUpdaterLike | null = null

export function setBoundUpdater(updater: AutoUpdaterLike | null): void {
  _bound = updater
}

export function getStatus(): UpdaterStatus {
  return _status
}

/**
 * feat/auto-update re-review (codex + UX lens) — true when a build is already
 * staged (mid-download or fully downloaded). Background 6h re-check events
 * (checking-for-update / update-not-available / error) and a failed check()
 * MUST NOT clobber this — the staged build + its banner + install CTA stay put.
 * A genuinely newer version still supersedes via 'update-available'; a real
 * download failure still surfaces via maybeAutoDownload()/download()'s catch.
 */
function hasStagedBuild(): boolean {
  return (
    (_status.state === 'downloaded' || _status.state === 'downloading') &&
    _status.latestVersion !== null
  )
}

/**
 * feat/auto-update gap A — read settings.json's `autoDownloadUpdates` LIVE
 * (per update-available event, never cached) so a mid-session Settings toggle
 * takes effect on the next available update. `readSettings()` already falls
 * back to DEFAULTS (autoDownloadUpdates: true) on a missing/corrupt file, so
 * no extra guard is needed here.
 */
function readAutoDownloadSetting(): boolean {
  return readSettings().autoDownloadUpdates
}

/**
 * feat/auto-update gap A — fire-and-forget `downloadUpdate()`. Rejections are
 * wrapped into `setStatus({ state: 'error' })` so a failed auto-download
 * surfaces through the same renderer status stream as a manual one (the bound
 * 'error' listener would also catch updater-internal errors, but a rejected
 * promise from the call itself needs explicit handling).
 */
function maybeAutoDownload(): void {
  if (!_bound) return
  // feat/auto-update re-review (codex, MEDIUM) — flip to 'downloading' BEFORE the
  // async downloadUpdate() so the 'available'→first-progress window can't double-
  // fire: a second overlapping check's same-version 'update-available' then sees
  // an in-flight download via the guard, and a manual download() is refused.
  if (_status.state === 'downloading' || _status.state === 'downloaded') return
  setStatus({ state: 'downloading', downloadPercent: 0, message: null })
  void _bound.downloadUpdate().catch((err) => {
    setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  })
}

async function check(): Promise<UpdaterStatus> {
  if (_status.state === 'dev-disabled') return _status
  if (!_bound) {
    setStatus({ state: 'error', message: 'updater not initialized' })
    return _status
  }
  try {
    await _bound.checkForUpdates()
  } catch (err) {
    // feat/auto-update re-review — a failed background re-check must not clobber
    // an already-staged build (see hasStagedBuild). A real download failure
    // surfaces via maybeAutoDownload()/download()'s own catch, not here.
    if (!hasStagedBuild()) {
      setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }
  return _status
}

async function download(): Promise<UpdaterStatus> {
  if (_status.state === 'dev-disabled') return _status
  if (!_bound) {
    setStatus({ state: 'error', message: 'updater not initialized' })
    return _status
  }
  if (_status.state !== 'available' && _status.state !== 'error') {
    return _status
  }
  try {
    await _bound.downloadUpdate()
  } catch (err) {
    setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  }
  return _status
}

function quitAndInstall(): void {
  if (!_bound) return
  if (_status.state !== 'downloaded') return
  // isSilent=false so macOS shows the standard "quit & relaunch" notice;
  // isForceRunAfter=true so the app re-opens after the install completes.
  _bound.quitAndInstall(false, true)
}

/**
 * Module-level reset for tests. Clears bound updater + resets status to
 * idle so each test starts with a clean slate.
 */
export function __resetForTesting(currentVersion: string): void {
  _bound = null
  _initialized = false
  // feat/auto-update — tear down the proactive-behavior module state so each
  // test starts clean and no setInterval timer leaks across cases.
  masterFlagEnabled = false
  if (_recheckInterval) {
    clearInterval(_recheckInterval)
    _recheckInterval = null
  }
  _status = {
    state: 'idle',
    currentVersion,
    latestVersion: null,
    downloadPercent: null,
    message: null,
    updatedAt: Date.now(),
    enabled: false
  }
}

/**
 * Boot the updater wiring + register IPC handlers. Idempotent.
 *
 * In dev (no app-update.yml), we still register the IPC handlers (so the
 * Settings page can render the dev-disabled state) but skip the autoUpdater
 * bind — bin's that env would just throw on every checkForUpdates() call.
 */
export function registerUpdaterHandlers(opts?: {
  /** Override the real `electron-updater` import; primarily for tests. */
  updater?: AutoUpdaterLike
  /** Override `app.getVersion()` for tests. */
  currentVersion?: string
  /** Bypass the dev guard; tests opt-in. */
  forceEnable?: boolean
}): void {
  if (_initialized) return
  _initialized = true

  // feat/auto-update — resolve the master flag once at boot. Gates ONLY the
  // two new proactive behaviors (auto-download + periodic re-check); the
  // startup check + manual Settings actions below are unconditional.
  masterFlagEnabled = readMasterFlag()

  const currentVersion = opts?.currentVersion ?? app.getVersion()
  _status = { ..._status, currentVersion, updatedAt: Date.now() }

  ipcMain.handle('updater:status', async (): Promise<UpdaterStatus> => getStatus())
  ipcMain.handle('updater:check', async (): Promise<UpdaterStatus> => check())
  ipcMain.handle('updater:download', async (): Promise<UpdaterStatus> => download())
  ipcMain.handle('updater:quitAndInstall', async (): Promise<void> => {
    quitAndInstall()
  })

  // Dev mode without an explicit override: stay disabled — autoUpdater can't
  // read app-update.yml outside a packaged build, and any check() will reject.
  if (is.dev && !opts?.forceEnable) {
    setStatus({ state: 'dev-disabled', message: 'dev mode — autoUpdater inactive' })
    return
  }

  // Bind the real (or test-supplied) updater and kick a delayed auto-check.
  const updater = opts?.updater
  if (updater) {
    bindAutoUpdater(updater)
    setBoundUpdater(updater)
    // feat/auto-update — we're past the dev-disabled return and an updater is
    // bound, so `enabled` collapses to the master flag. Ride the existing
    // updater:event broadcast (no new IPC channel) so the renderer's store
    // mirrors it on the next status push.
    setStatus({ enabled: masterFlagEnabled })
    // Fire-and-forget: any error surfaces through the bound 'error' handler.
    setTimeout(() => {
      void check()
    }, AUTO_CHECK_DELAY_MS)
    // feat/auto-update gap C — periodic re-check, armed ONLY when the master
    // flag is on. Cleared on before-quit (and __resetForTesting) so no timer
    // leaks. The existing startup check above stays unconditional.
    if (masterFlagEnabled) {
      _recheckInterval = setInterval(() => {
        void check()
      }, AUTO_RECHECK_INTERVAL_MS)
      app.on('before-quit', () => {
        if (_recheckInterval) {
          clearInterval(_recheckInterval)
          _recheckInterval = null
        }
      })
    }
  }
}

export const __testing = {
  setStatus,
  broadcast,
  check,
  download,
  quitAndInstall,
  bindAutoUpdater,
  setBoundUpdater
}
