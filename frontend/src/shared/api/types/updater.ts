// ---- Sprint 8 §2.2 — auto-updater surface ---------------------------------

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
  /** From `app.getVersion()` (package.json at build time). */
  currentVersion: string
  latestVersion: string | null
  /** 0-100; defined only while state === 'downloading'. */
  downloadPercent: number | null
  message: string | null
  /** Epoch ms of the last state transition. */
  updatedAt: number
  /** feat/auto-update — true ONLY when (master AUTO_UPDATE_ENABLED on) AND
   *  (state !== 'dev-disabled') AND (an updater is bound). The renderer uses
   *  this to gate the proactive UpdateReadyBanner + the unsigned-build notice;
   *  false on unsigned/dev builds where updates can't actually install. */
  enabled: boolean
}

export interface UpdaterApi {
  /** Synchronous snapshot of the current status (single IPC roundtrip). */
  status(): Promise<UpdaterStatus>
  /** Trigger `autoUpdater.checkForUpdates()`. Returns the post-call status —
   *  events typically follow asynchronously so subscribe via `onEvent`. */
  check(): Promise<UpdaterStatus>
  /** Trigger `autoUpdater.downloadUpdate()` (only valid when state ===
   *  'available'). Returns the post-call status. */
  download(): Promise<UpdaterStatus>
  /** Trigger `autoUpdater.quitAndInstall(false, true)`. Quits the app, so
   *  there's nothing useful to return. */
  quitAndInstall(): Promise<void>
  /** Subscribe to status broadcasts. Returns an unsubscribe function. */
  onEvent(handler: (status: UpdaterStatus) => void): () => void
}
