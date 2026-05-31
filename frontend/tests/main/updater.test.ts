// Sprint 8 §2.2 — electron-updater bridge state machine + IPC contract.
//
// We don't import the real `electron-updater` (it would try to read
// `app-update.yml` on module load, which doesn't exist outside a packaged
// build, and it would also try to fetch GitHub on `checkForUpdates`).
// Instead the handler accepts an `AutoUpdaterLike` injection, and these
// tests drive that shape directly.

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'

// Mock the electron module + BrowserWindow.getAllWindows() so the
// broadcast helper doesn't blow up on missing windows.
const sendSpy = vi.fn()
// feat/auto-update — vi.mock factories may only reference top-level vars whose
// names begin with `mock`. `mockAppOn` lets the periodic-recheck tests inspect
// the before-quit listener registerUpdaterHandlers wires via app.on(...).
const mockAppOn = vi.fn()
vi.mock('electron', () => ({
  // feat/auto-update gap C — registerUpdaterHandlers now calls app.on(
  // 'before-quit', ...) to clear the periodic interval; the mock MUST expose
  // `on` or that call throws.
  app: { getVersion: () => '1.2.3', on: mockAppOn },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: sendSpy }
      }
    ]
  }
}))

// Force `is.dev = false` so the handler binds the supplied updater rather
// than entering 'dev-disabled' state. Tests opt into dev path via
// `forceEnable: true` in registerUpdaterHandlers().
vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false }
}))

// feat/auto-update gap A — mock the settings module so readSettings() is
// deterministic for the auto-download branch (updater.ts statically imports
// `readSettings` from './settings'; vi.mock intercepts it). Mutate
// `mockAutoDownloadUpdates` per-test to flip the live toggle.
let mockAutoDownloadUpdates = true
vi.mock('../../src/electron/main/handlers/settings', () => ({
  readSettings: () => ({ autoDownloadUpdates: mockAutoDownloadUpdates })
}))

const {
  registerUpdaterHandlers,
  bindAutoUpdater,
  setBoundUpdater,
  getStatus,
  __resetForTesting,
  __testing
} = await import('../../src/electron/main/handlers/updater')

type Listener = (...args: unknown[]) => void

function makeStubUpdater(): {
  stub: import('../../src/electron/main/handlers/updater').AutoUpdaterLike
  fire: (event: string, ...args: unknown[]) => void
  checkSpy: ReturnType<typeof vi.fn>
  downloadSpy: ReturnType<typeof vi.fn>
  installSpy: ReturnType<typeof vi.fn>
} {
  const listeners: Record<string, Listener[]> = {}
  const checkSpy = vi.fn(async () => undefined)
  const downloadSpy = vi.fn(async () => undefined)
  const installSpy = vi.fn(() => undefined)
  const stub = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: { warn: () => undefined },
    on(event: string, listener: Listener): void {
      ;(listeners[event] ??= []).push(listener)
    },
    checkForUpdates: checkSpy,
    downloadUpdate: downloadSpy,
    quitAndInstall: installSpy
  } as unknown as import('../../src/electron/main/handlers/updater').AutoUpdaterLike
  function fire(event: string, ...args: unknown[]): void {
    for (const l of listeners[event] ?? []) l(...args)
  }
  return { stub, fire, checkSpy, downloadSpy, installSpy }
}

beforeEach(() => {
  sendSpy.mockClear()
  // feat/auto-update — reset proactive-behavior test state so the existing 11
  // cases never see a stray master flag / settings toggle / before-quit spy.
  mockAppOn.mockClear()
  mockAutoDownloadUpdates = true
  delete process.env.AUTO_UPDATE_ENABLED
  __resetForTesting('1.2.3')
})

afterEach(() => {
  setBoundUpdater(null)
  // A test may have switched to fake timers (periodic-recheck cases); always
  // restore real ones so subsequent files/tests aren't affected.
  vi.useRealTimers()
  delete process.env.AUTO_UPDATE_ENABLED
})

describe('updater: state machine via bindAutoUpdater', () => {
  test('initial state is idle', () => {
    expect(getStatus().state).toBe('idle')
    expect(getStatus().currentVersion).toBe('1.2.3')
  })

  test('checking-for-update → state=checking', () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    fire('checking-for-update')
    expect(getStatus().state).toBe('checking')
  })

  test('update-available carries version + releaseName message', () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    fire('update-available', { version: '1.3.0', releaseName: 'Spring polish' })
    const s = getStatus()
    expect(s.state).toBe('available')
    expect(s.latestVersion).toBe('1.3.0')
    expect(s.message).toBe('Spring polish')
  })

  test('update-not-available transitions to not-available with version', () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    fire('update-not-available', { version: '1.2.3' })
    expect(getStatus().state).toBe('not-available')
    expect(getStatus().latestVersion).toBe('1.2.3')
  })

  test('download-progress sets downloading + rounds percent', () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    fire('download-progress', { percent: 42.7, bytesPerSecond: 0, transferred: 0, total: 100 })
    expect(getStatus().state).toBe('downloading')
    expect(getStatus().downloadPercent).toBe(43)
  })

  test('update-downloaded ramps to 100% + downloaded state', () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    fire('update-downloaded', { version: '1.3.0' })
    expect(getStatus().state).toBe('downloaded')
    expect(getStatus().downloadPercent).toBe(100)
    expect(getStatus().latestVersion).toBe('1.3.0')
  })

  test('error event surfaces message + state', () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    fire('error', new Error('GitHub 503'))
    expect(getStatus().state).toBe('error')
    expect(getStatus().message).toBe('GitHub 503')
  })

  test('bindAutoUpdater enforces autoDownload=false + autoInstallOnAppQuit=true', () => {
    const { stub } = makeStubUpdater()
    bindAutoUpdater(stub)
    expect(stub.autoDownload).toBe(false)
    expect(stub.autoInstallOnAppQuit).toBe(true)
  })

  test('every state transition broadcasts to renderer via webContents.send', () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    sendSpy.mockClear()
    fire('checking-for-update')
    expect(sendSpy).toHaveBeenCalledWith(
      'updater:event',
      expect.objectContaining({ state: 'checking' })
    )
  })
})

describe('updater: handler operations', () => {
  test('check() in idle state delegates to autoUpdater.checkForUpdates', async () => {
    const { stub, checkSpy } = makeStubUpdater()
    bindAutoUpdater(stub)
    setBoundUpdater(stub)
    const s = await __testing.check()
    expect(checkSpy).toHaveBeenCalled()
    expect(s.state).toBe('idle') // stub doesn't fire events on its own
  })

  test('check() in dev-disabled state is a no-op', async () => {
    const { stub, checkSpy } = makeStubUpdater()
    bindAutoUpdater(stub)
    setBoundUpdater(stub)
    __testing.setStatus({ state: 'dev-disabled' })
    await __testing.check()
    expect(checkSpy).not.toHaveBeenCalled()
  })

  test('download() requires state=available; refuses from idle', async () => {
    const { stub, downloadSpy } = makeStubUpdater()
    bindAutoUpdater(stub)
    setBoundUpdater(stub)
    await __testing.download()
    expect(downloadSpy).not.toHaveBeenCalled()
  })

  test('download() runs once state transitions to available', async () => {
    const { stub, fire, downloadSpy } = makeStubUpdater()
    bindAutoUpdater(stub)
    setBoundUpdater(stub)
    fire('update-available', { version: '1.3.0' })
    await __testing.download()
    expect(downloadSpy).toHaveBeenCalledTimes(1)
  })

  test('quitAndInstall() only fires when state=downloaded', () => {
    const { stub, fire, installSpy } = makeStubUpdater()
    bindAutoUpdater(stub)
    setBoundUpdater(stub)
    // Premature install request — ignored.
    __testing.quitAndInstall()
    expect(installSpy).not.toHaveBeenCalled()
    // Once downloaded, install fires with the documented args (silent=false,
    // forceRunAfter=true).
    fire('update-downloaded', { version: '1.3.0' })
    __testing.quitAndInstall()
    expect(installSpy).toHaveBeenCalledWith(false, true)
  })

  test('check() surfaces autoUpdater rejection as error state', async () => {
    const { stub } = makeStubUpdater()
    bindAutoUpdater(stub)
    // Override checkForUpdates to throw.
    ;(stub as unknown as { checkForUpdates: () => Promise<never> }).checkForUpdates =
      async (): Promise<never> => {
        throw new Error('no connection')
      }
    setBoundUpdater(stub)
    const s = await __testing.check()
    expect(s.state).toBe('error')
    expect(s.message).toBe('no connection')
  })
})

describe('updater: registerUpdaterHandlers entry', () => {
  test('production path stamps currentVersion + binds updater', () => {
    const { stub } = makeStubUpdater()
    registerUpdaterHandlers({ updater: stub, currentVersion: '1.2.3' })
    // bindAutoUpdater enforces autoDownload=false + autoInstallOnAppQuit=true.
    expect(stub.autoDownload).toBe(false)
    expect(stub.autoInstallOnAppQuit).toBe(true)
    // Status carries the supplied version (overriding app.getVersion default).
    expect(getStatus().currentVersion).toBe('1.2.3')
    expect(getStatus().state).toBe('idle')
  })
})

// feat/auto-update gap-fill — proactive behaviors gated behind the master
// AUTO_UPDATE_ENABLED flag. The dev path stays dev-disabled; the manual
// Settings actions + the existing 11 cases above are untouched.
describe('updater: enabled field (master flag gate)', () => {
  test('flag OFF + bound → enabled stays false', () => {
    const { stub } = makeStubUpdater()
    // AUTO_UPDATE_ENABLED unset (deleted in beforeEach) → flag off.
    registerUpdaterHandlers({ updater: stub })
    expect(getStatus().enabled).toBe(false)
  })

  test('flag ON + bound → enabled true', () => {
    process.env.AUTO_UPDATE_ENABLED = 'true'
    const { stub } = makeStubUpdater()
    registerUpdaterHandlers({ updater: stub })
    expect(getStatus().enabled).toBe(true)
  })

  test('flag ON but NO updater bound → enabled false (requires a bound updater)', () => {
    process.env.AUTO_UPDATE_ENABLED = '1'
    // No `updater` opt → the bind branch is skipped, so enabled never flips.
    registerUpdaterHandlers({})
    expect(getStatus().enabled).toBe(false)
  })

  test('dev-disabled status keeps enabled false even with flag on', () => {
    process.env.AUTO_UPDATE_ENABLED = 'true'
    // The dev-disabled path early-returns before the bind branch; emulate the
    // resulting status to confirm `enabled` is never set true there.
    __testing.setStatus({ state: 'dev-disabled' })
    expect(getStatus().state).toBe('dev-disabled')
    expect(getStatus().enabled).toBe(false)
  })
})

describe('updater: auto-download on update-available (gap A)', () => {
  test('flag ON + autoDownloadUpdates true → downloadUpdate() fires', () => {
    process.env.AUTO_UPDATE_ENABLED = 'true'
    mockAutoDownloadUpdates = true
    const { stub, fire, downloadSpy } = makeStubUpdater()
    registerUpdaterHandlers({ updater: stub })
    fire('update-available', { version: '1.3.0' })
    expect(downloadSpy).toHaveBeenCalledTimes(1)
  })

  test('flag OFF → downloadUpdate() NOT fired (manual download only)', () => {
    // AUTO_UPDATE_ENABLED unset → flag off.
    mockAutoDownloadUpdates = true
    const { stub, fire, downloadSpy } = makeStubUpdater()
    registerUpdaterHandlers({ updater: stub })
    fire('update-available', { version: '1.3.0' })
    expect(downloadSpy).not.toHaveBeenCalled()
  })

  test('flag ON but autoDownloadUpdates false → downloadUpdate() NOT fired', () => {
    process.env.AUTO_UPDATE_ENABLED = 'true'
    mockAutoDownloadUpdates = false
    const { stub, fire, downloadSpy } = makeStubUpdater()
    registerUpdaterHandlers({ updater: stub })
    fire('update-available', { version: '1.3.0' })
    expect(downloadSpy).not.toHaveBeenCalled()
  })

  test('update-available still transitions to available regardless of auto-download', () => {
    // Auto-download is additive; the state machine transition is unconditional.
    mockAutoDownloadUpdates = false
    const { stub, fire } = makeStubUpdater()
    registerUpdaterHandlers({ updater: stub })
    fire('update-available', { version: '1.3.0' })
    expect(getStatus().state).toBe('available')
    expect(getStatus().latestVersion).toBe('1.3.0')
  })

  test('re-discovered same version while downloaded → no re-download, stays downloaded (gap A+C idempotency)', () => {
    process.env.AUTO_UPDATE_ENABLED = 'true'
    mockAutoDownloadUpdates = true
    const { stub, fire, downloadSpy } = makeStubUpdater()
    registerUpdaterHandlers({ updater: stub })
    // First discovery → auto-download → completes.
    fire('update-available', { version: '1.3.0' })
    fire('update-downloaded', { version: '1.3.0' })
    expect(getStatus().state).toBe('downloaded')
    expect(downloadSpy).toHaveBeenCalledTimes(1)
    // A periodic re-check re-emits the SAME version. REAL event ordering: the
    // updater fires 'checking-for-update' FIRST, then 'update-available' — the
    // guard must survive the intervening 'checking' (codex review, HIGH). Must
    // NOT reset to 'available' nor re-download (banner flicker + bandwidth churn).
    fire('checking-for-update')
    fire('update-available', { version: '1.3.0' })
    expect(getStatus().state).toBe('downloaded')
    expect(downloadSpy).toHaveBeenCalledTimes(1)
  })

  test('checking-for-update does NOT clobber a staged (downloaded) update (codex HIGH)', () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    fire('update-downloaded', { version: '1.3.0' })
    expect(getStatus().state).toBe('downloaded')
    // The periodic re-check's leading 'checking-for-update' must leave a staged
    // build alone (else the same-version idempotency guard is defeated).
    fire('checking-for-update')
    expect(getStatus().state).toBe('downloaded')
  })

  test('a genuinely newer version after downloaded supersedes (transitions + re-downloads)', () => {
    process.env.AUTO_UPDATE_ENABLED = 'true'
    mockAutoDownloadUpdates = true
    const { stub, fire, downloadSpy } = makeStubUpdater()
    registerUpdaterHandlers({ updater: stub })
    fire('update-available', { version: '1.3.0' })
    fire('update-downloaded', { version: '1.3.0' })
    expect(downloadSpy).toHaveBeenCalledTimes(1)
    // Newer version published → not the staged one → must supersede + re-download
    // (still preceded by the real 'checking-for-update', which the guard ignores
    // for the staged version but does not block the newer transition).
    fire('checking-for-update')
    fire('update-available', { version: '1.4.0' })
    // After superseding, auto-download kicks off again → maybeAutoDownload flips
    // state to 'downloading' immediately (re-review FIX 2: close the double-fire
    // window), so the post-supersede state is 'downloading', not 'available'.
    expect(getStatus().state).toBe('downloading')
    expect(getStatus().latestVersion).toBe('1.4.0')
    expect(downloadSpy).toHaveBeenCalledTimes(2)
  })
})

describe('updater: periodic re-check interval (gap C)', () => {
  test('flag ON → setInterval armed at 6h; before-quit clears it', () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
    process.env.AUTO_UPDATE_ENABLED = 'true'
    const { stub } = makeStubUpdater()
    registerUpdaterHandlers({ updater: stub })
    // Armed exactly once with the 6h cadence.
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 21_600_000)
    // before-quit listener was registered via app.on; invoke it.
    const beforeQuit = mockAppOn.mock.calls.find((c) => c[0] === 'before-quit')?.[1] as
      | (() => void)
      | undefined
    expect(beforeQuit).toBeTypeOf('function')
    beforeQuit?.()
    expect(clearIntervalSpy).toHaveBeenCalled()
  })

  test('flag OFF → setInterval NOT armed (no periodic re-check)', () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
    // AUTO_UPDATE_ENABLED unset → flag off.
    const { stub } = makeStubUpdater()
    registerUpdaterHandlers({ updater: stub })
    expect(setIntervalSpy).not.toHaveBeenCalled()
    // ...and app.on('before-quit') is not wired for the recheck cleanup.
    expect(mockAppOn.mock.calls.find((c) => c[0] === 'before-quit')).toBeUndefined()
  })

  test('__resetForTesting clears a pending interval (no timer leak)', () => {
    vi.useFakeTimers()
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
    process.env.AUTO_UPDATE_ENABLED = 'true'
    const { stub } = makeStubUpdater()
    registerUpdaterHandlers({ updater: stub })
    clearIntervalSpy.mockClear()
    __resetForTesting('1.2.3')
    expect(clearIntervalSpy).toHaveBeenCalled()
  })
})

// feat/auto-update re-review (codex + UX lens, MEDIUM) — a periodic 6h re-check
// must not yank a staged build's state via the failure/idle event paths the first
// round of guards missed. checking-for-update + update-available were already
// guarded; these pin error / update-not-available / check()-rejection too.
describe('updater: staged build survives background re-check noise', () => {
  test('error during a re-check does NOT clobber a downloaded build', () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    fire('update-downloaded', { version: '1.3.0' })
    expect(getStatus().state).toBe('downloaded')
    // 6h re-check: checking-for-update (guarded) then a transient network error.
    fire('checking-for-update')
    fire('error', new Error('GitHub 503'))
    expect(getStatus().state).toBe('downloaded')
  })

  test('update-not-available during a re-check does NOT clobber a downloaded build', () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    fire('update-downloaded', { version: '1.3.0' })
    expect(getStatus().state).toBe('downloaded')
    // Staged release retracted → server reports the running version is latest.
    fire('update-not-available', { version: '1.2.3' })
    expect(getStatus().state).toBe('downloaded')
    expect(getStatus().latestVersion).toBe('1.3.0') // staged version preserved
  })

  test('check() rejection does NOT clobber a downloaded build', async () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    setBoundUpdater(stub)
    fire('update-downloaded', { version: '1.3.0' })
    ;(stub as unknown as { checkForUpdates: () => Promise<never> }).checkForUpdates =
      async (): Promise<never> => {
        throw new Error('no connection')
      }
    const s = await __testing.check()
    expect(s.state).toBe('downloaded')
  })

  test('error still surfaces when NOT staged (no over-guarding)', () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    // state 'available' (no master flag in this bind-only path → no auto-download).
    fire('update-available', { version: '1.3.0' })
    expect(getStatus().state).toBe('available')
    fire('error', new Error('boom'))
    expect(getStatus().state).toBe('error')
  })
})
