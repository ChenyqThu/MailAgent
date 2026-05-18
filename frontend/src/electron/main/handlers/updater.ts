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

import { app, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'

/** Auto-check tick after launch (production only). Gives the user a few
 *  seconds of unblocked UI before the network handshake fires. */
const AUTO_CHECK_DELAY_MS = 10_000

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
}

let _status: UpdaterStatus = {
  state: 'idle',
  currentVersion: '0.0.0',
  latestVersion: null,
  downloadPercent: null,
  message: null,
  updatedAt: Date.now()
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
    setStatus({ state: 'checking', message: null })
  })
  updater.on('update-available', (info: UpdateInfo) => {
    setStatus({
      state: 'available',
      latestVersion: info.version,
      message: info.releaseName ?? null
    })
  })
  updater.on('update-not-available', (info: UpdateInfo) => {
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

async function check(): Promise<UpdaterStatus> {
  if (_status.state === 'dev-disabled') return _status
  if (!_bound) {
    setStatus({ state: 'error', message: 'updater not initialized' })
    return _status
  }
  try {
    await _bound.checkForUpdates()
  } catch (err) {
    setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
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
  _status = {
    state: 'idle',
    currentVersion,
    latestVersion: null,
    downloadPercent: null,
    message: null,
    updatedAt: Date.now()
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
    // Fire-and-forget: any error surfaces through the bound 'error' handler.
    setTimeout(() => {
      void check()
    }, AUTO_CHECK_DELAY_MS)
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
