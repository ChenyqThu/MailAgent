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
vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3' },
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
  __resetForTesting('1.2.3')
})

afterEach(() => {
  setBoundUpdater(null)
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
    expect(sendSpy).toHaveBeenCalledWith('updater:event', expect.objectContaining({ state: 'checking' }))
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
