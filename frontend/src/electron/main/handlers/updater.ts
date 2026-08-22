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
// master AUTO_UPDATE_ENABLED flag. P6 (1.0.0): flipped ON for packaged builds
// (Developer ID signing + notarize landed in the SAME commit — ad-hoc-only builds
// were the blocker, now resolved). dev stays OFF; explicit env still overrides
// (AUTO_UPDATE_ENABLED=0 in userData .env = emergency rollback). See readMasterFlag.
//   (a) auto-download-on-available — Scheme 2: we keep autoDownload=false
//       (preserves the existing test invariant + smaller blast radius) and
//       instead fire downloadUpdate() ourselves from the update-available
//       listener, but only when the master flag is on AND settings.json's
//       `autoDownloadUpdates` is true (read LIVE per event, never cached).
//   (b) periodic re-check — a 48h setInterval armed UNCONDITIONALLY in the non-dev
//       bound branch (check-only reminders need no signing; only auto-download/install
//       stays flag-gated via maybeAutoDownload); cleared on app before-quit.
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
// task 08-20-notification-center M2 批 B4 — 更新就绪 → 通知中心 loopback publish。
import { publishNotificationToCenter } from '../notification_fanout'

/** Auto-check tick after launch (production only). Gives the user a few
 *  seconds of unblocked UI before the network handshake fires. */
const AUTO_CHECK_DELAY_MS = 10_000

/** 新版本检测提醒 — 周期复查间隔 (48h)。无条件 arm (检测+提醒不需签名);
 *  仅自动下载/安装仍由 master flag (AUTO_UPDATE_ENABLED) gate。 */
const AUTO_RECHECK_INTERVAL_MS = 172_800_000

/** feat/auto-update — master flag (AUTO_UPDATE_ENABLED), parsed in
 *  registerUpdaterHandlers via the chat/config.ts idiom. Module-level so the
 *  update-available listener (gap A) and the interval arming (gap C) both see
 *  it without threading it through every closure. Default false. */
let masterFlagEnabled = false

/** feat/auto-update gap C — id of the periodic re-check interval, so
 *  before-quit / __resetForTesting can clear it (no leaked timers in tests). */
let _recheckInterval: ReturnType<typeof setInterval> | null = null

/** Resolve the master flag. An explicit AUTO_UPDATE_ENABLED (chat/config.ts:9-12
 *  idiom: "1"/"true" → on; anything else → off) ALWAYS wins — it's the dogfood
 *  switch and the emergency rollback (set AUTO_UPDATE_ENABLED=0 in userData .env
 *  to disable auto-download/install while keeping check-only reminders).
 *  P6 (1.0.0): when unset, default ON for packaged builds (releases are now
 *  Developer ID-signed + notarized so quitAndInstall actually works) and OFF in
 *  dev. The is.dev guard in registerUpdaterHandlers is the second line of defense
 *  (dev never binds the updater regardless of this flag). */
function readMasterFlag(): boolean {
  const raw = process.env.AUTO_UPDATE_ENABLED
  if (raw !== undefined && raw !== '') {
    return raw === '1' || raw.toLowerCase() === 'true'
  }
  return !is.dev
}

/** electron-updater throws/emits ENOENT for `app-update.yml` when the build
 *  has no updater config — i.e. an unpackaged / `npx electron-builder --dir`
 *  build run with is.dev=false (it slips past the dev guard, then every
 *  checkForUpdates() rejects). That's not a real "update check failed", it's
 *  "this build can't self-update". Detect it so we degrade to the same graceful
 *  `dev-disabled` sentinel instead of surfacing a raw ENOENT stack in Settings. */
function isUpdaterConfigMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('app-update.yml') || msg.includes('ENOENT')
}

/** Shared graceful landing for a missing updater config (see above). Mirrors
 *  the dev guard's `dev-disabled` state so the renderer renders the unsigned/
 *  inactive notice (enabled stays false) rather than an error stack. */
function markUpdaterUnavailable(): void {
  setStatus({
    state: 'dev-disabled',
    message: 'updater unavailable — app-update.yml missing (unpackaged/--dir build)'
  })
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
    // task 08-20-notification-center M2 批 B4 — 持久化「更新就绪」通知（通知中心 design
    // §7 updater 行）。「启动补发」走的就是本监听：updater 状态机是进程内存态（重启即
    // 清零 idle，「启动时已是 downloaded」在现实现里不存在），重启后 re-check →
    // re-download（差分/缓存秒回）会再次发出 update-downloaded → 同 key 再 publish，
    // 服务端 dedupe 吸收成计次 —— 即风险清单 4「downloaded 可重入 + dedupe 吸收」的
    // 落地形状。serve-api 未起 → helper 内只 log 不重试，绝不影响 updater 状态机。
    void publishNotificationToCenter({
      category: 'system',
      source: 'updater',
      severity: 'info',
      title: `新版本 v${info.version} 已就绪`,
      body:
        (info.releaseName && info.releaseName !== info.version ? `${info.releaseName} — ` : '') +
        '更新已下载完成，重启应用即可安装。',
      dedupeKey: `app_update:${info.version}`,
      payload: { link: { type: 'updater_restart' } }
    })
  })
  updater.on('error', (err: Error) => {
    // feat/auto-update re-review (codex + UX, MEDIUM) — a transient error from a
    // background re-check must not clobber a staged build's state (which would
    // vanish the banner + install CTA with no path back until restart). A real
    // download failure still surfaces via maybeAutoDownload()/download()'s catch.
    if (hasStagedBuild()) return
    // --dir/未打包构建缺 app-update.yml → ENOENT。降级 dev-disabled 而非把原始
    // 堆栈糊到 Settings（用户现象: "GitHub Releases · ad-hoc 签名" 下糊 ENOENT）。
    if (isUpdaterConfigMissing(err)) {
      markUpdaterUnavailable()
      return
    }
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
 * staged (mid-download or fully downloaded). Background 48h re-check events
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
 * back to DEFAULTS (autoDownloadUpdates: false — 07-04 manual-download default)
 * on a missing/corrupt file, so no extra guard is needed here.
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
      // --dir/未打包构建缺 app-update.yml → ENOENT, 降级 dev-disabled graceful.
      if (isUpdaterConfigMissing(err)) {
        markUpdaterUnavailable()
      } else {
        setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
      }
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
    // 新版本检测提醒 (check-only): 周期复查无条件 arm — 不再 gate AUTO_UPDATE_ENABLED。
    // 检测+提醒不需签名 (ad-hoc 也要每 48h 提醒); 仅自动下载/安装仍由 master flag
    // gate (maybeAutoDownload 内, 故复查发现新版只会 state='available' 弹提醒、不下载)。
    // 启动 check 本就无条件, 这里补长开 app 的周期复查。before-quit 清理防 timer 泄漏。
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

export const __testing = {
  setStatus,
  broadcast,
  check,
  download,
  quitAndInstall,
  bindAutoUpdater,
  setBoundUpdater
}
