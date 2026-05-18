// Sprint 9 §2.2 — Island IPC bridge.
//
// Five IPC channels for the renderer ↔ ping-island integration:
//
//   `invoke` (handle):
//     island:status         → return getIslandStatus() snapshot
//     island:testConnection → trigger probeOnce() + return new status
//     island:setEnabled     → on/off toggle from Settings
//
//   `send`   (on, fire-and-forget):
//     island:appearance     → buildAppearanceChange + sendEnvelope
//     island:aiDraftStart   → buildAIDraftStart + sendEnvelope
//     island:aiDraftStream  → buildAIDraftStream + sendEnvelope
//     island:aiDraftReady   → buildAIDraftReady + sendEnvelope
//
//   broadcast (main → renderer):
//     island:event          → subscribeIslandStatus updates
//
// Validation pattern mirrors handlers/settings.ts: malformed payloads
// silently no-op (the renderer is trusted; defensive shape-checks live here
// for the same reason JSON.parse can throw on a corrupted localStorage
// shim).

import { BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'

import {
  buildAIDraftReady,
  buildAIDraftStart,
  buildAIDraftStream,
  buildAppearanceChange,
  getIslandStatus,
  probeOnce,
  reportSendOutcome,
  sendEnvelope,
  setIslandEnabled,
  startProbeLoop,
  stopProbeLoop,
  subscribeIslandStatus,
  type AIDraftReadyPayload,
  type AIDraftStartPayload,
  type AIDraftStreamPayload,
  type AppearanceChangePayload,
  type IslandStatus
} from '../island'

function broadcast(status: IslandStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('island:event', status)
    }
  }
}

let _registered = false
let _unsubscribe: (() => void) | null = null

export interface RegisterIslandOpts {
  /** Skip the probe loop. Default = `is.dev`. */
  devDisabled?: boolean
  /** Override the probe cadence (ms). Mainly for tests. */
  intervalMs?: number
}

/**
 * Wire `electron-updater`-style IPC for the island bridge. Idempotent so
 * the unit tests can call it inside `beforeEach` and `is.dev` toggles
 * cleanly via the override.
 */
export function registerIslandHandlers(opts?: RegisterIslandOpts): void {
  if (_registered) return
  _registered = true

  // ---- control surface ----------------------------------------------------
  ipcMain.handle('island:status', async (): Promise<IslandStatus> => getIslandStatus())
  ipcMain.handle('island:testConnection', async (): Promise<IslandStatus> => probeOnce())
  ipcMain.handle('island:setEnabled', async (_evt, enabled: unknown): Promise<IslandStatus> => {
    if (typeof enabled !== 'boolean') return getIslandStatus()
    return setIslandEnabled(enabled)
  })

  // ---- ephemeral envelopes (fire-and-forget) ------------------------------
  //
  // Reviewer L5: each send's outcome feeds back into the IslandStatus state
  // machine. We keep the fire-and-forget contract (no `await`, no exposed
  // promise) but chain a `.then` so a transient ping-island crash flips the
  // renderer pill within a single envelope round-trip instead of waiting up
  // to one probe interval (5 min) for the next loop tick to notice.
  ipcMain.on('island:appearance', (_evt, payload: unknown) => {
    if (!isAppearancePayload(payload)) return
    if (!isOperable()) return
    void sendEnvelope(buildAppearanceChange(payload)).then(reportSendOutcome)
  })

  ipcMain.on('island:aiDraftStart', (_evt, payload: unknown) => {
    if (!isStartPayload(payload)) return
    if (!isOperable()) return
    void sendEnvelope(buildAIDraftStart(payload)).then(reportSendOutcome)
  })

  ipcMain.on('island:aiDraftStream', (_evt, payload: unknown) => {
    if (!isStreamPayload(payload)) return
    if (!isOperable()) return
    void sendEnvelope(buildAIDraftStream(payload)).then(reportSendOutcome)
  })

  ipcMain.on('island:aiDraftReady', (_evt, payload: unknown) => {
    if (!isReadyPayload(payload)) return
    if (!isOperable()) return
    void sendEnvelope(buildAIDraftReady(payload)).then(reportSendOutcome)
  })

  // ---- probe → broadcast --------------------------------------------------
  _unsubscribe = subscribeIslandStatus(broadcast)

  // ---- start probe --------------------------------------------------------
  const devDisabled = opts?.devDisabled ?? is.dev
  startProbeLoop({ devDisabled, intervalMs: opts?.intervalMs })
}

function isOperable(): boolean {
  const state = getIslandStatus().state
  // 'disabled' = user toggled off; 'dev-disabled' = is.dev and no override.
  // Either way, don't burn syscalls trying to send envelopes that won't
  // be consumed.
  return state !== 'disabled' && state !== 'dev-disabled'
}

// ---- payload guards -------------------------------------------------------

function isAppearancePayload(value: unknown): value is AppearanceChangePayload {
  if (!value || typeof value !== 'object') return false
  const v = value as { accent?: unknown; theme?: unknown; lang?: unknown }
  if (typeof v.accent !== 'string') return false
  if (v.theme !== 'dark' && v.theme !== 'light') return false
  if (v.lang !== undefined && typeof v.lang !== 'string') return false
  return true
}

function isStartPayload(value: unknown): value is AIDraftStartPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.emailId !== 'number' || !Number.isFinite(v.emailId)) return false
  if (typeof v.prompt !== 'string') return false
  if (v.senderName !== null && typeof v.senderName !== 'string') return false
  if (v.subject !== null && typeof v.subject !== 'string') return false
  return true
}

function isStreamPayload(value: unknown): value is AIDraftStreamPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.emailId !== 'number' || !Number.isFinite(v.emailId)) return false
  if (typeof v.streamedChars !== 'number' || !Number.isFinite(v.streamedChars)) return false
  return true
}

function isReadyPayload(value: unknown): value is AIDraftReadyPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.emailId !== 'number' || !Number.isFinite(v.emailId)) return false
  if (typeof v.preview !== 'string') return false
  if (v.senderName !== null && typeof v.senderName !== 'string') return false
  if (v.subject !== null && typeof v.subject !== 'string') return false
  return true
}

/** Tear-down for tests. Resets the `_registered` latch + unsubscribes the
 *  probe → broadcast listener so the next test can re-register cleanly. */
export function __resetForTesting(): void {
  if (_unsubscribe !== null) {
    _unsubscribe()
    _unsubscribe = null
  }
  stopProbeLoop()
  _registered = false
}

export const __testing = {
  broadcast,
  isAppearancePayload,
  isStartPayload,
  isStreamPayload,
  isReadyPayload,
  isOperable
}
