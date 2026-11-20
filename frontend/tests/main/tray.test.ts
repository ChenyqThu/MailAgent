// Phase 3 — macOS Menu Bar Tray & Popover position/action tests.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const trays: Array<{
    setToolTip: ReturnType<typeof vi.fn>
    setTitle: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    isDestroyed: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    getBounds: ReturnType<typeof vi.fn>
    popUpContextMenu: ReturnType<typeof vi.fn>
    listeners: Map<string, () => void>
  }> = []

  const windows: Array<{
    isDestroyed: ReturnType<typeof vi.fn>
    isVisible: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    hide: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    setPosition: ReturnType<typeof vi.fn>
    loadURL: ReturnType<typeof vi.fn>
    loadFile: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    webContents: { isLoading: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn> }
    listeners: Map<string, () => void>
  }> = []

  const setBadgeMock = vi.fn()
  const quitMock = vi.fn()
  const openExternalMock = vi.fn(async () => undefined)
  const ipcHandlers = new Map<string, (_evt: unknown, arg: unknown) => Promise<unknown>>()
  const menuBuildFromTemplate = vi.fn((tpl) => ({ tpl }))

  class MockTray {
    setToolTip = vi.fn()
    setTitle = vi.fn()
    destroy = vi.fn()
    isDestroyed = vi.fn(() => false)
    listeners = new Map<string, () => void>()
    on = vi.fn((evt: string, cb: () => void) => {
      this.listeners.set(evt, cb)
      return this
    })
    getBounds = vi.fn(() => ({ x: 900, y: 0, width: 26, height: 22 }))
    popUpContextMenu = vi.fn()
    constructor(_image: unknown) {
      trays.push(this)
    }
  }

  class MockBrowserWindow {
    isDestroyed = vi.fn(() => false)
    isVisible = vi.fn(() => false)
    show = vi.fn()
    hide = vi.fn()
    close = vi.fn()
    focus = vi.fn()
    setPosition = vi.fn()
    loadURL = vi.fn(async () => {})
    loadFile = vi.fn(async () => {})
    listeners = new Map<string, () => void>()
    on = vi.fn((evt: string, cb: () => void) => {
      this.listeners.set(evt, cb)
      return this
    })
    webContents = {
      isLoading: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn()
    }
    constructor(_opts: unknown) {
      windows.push(this)
    }
  }

  const createFromBitmapMock = vi.fn((_buf: Buffer, opts: { width: number; height: number }) => ({
    opts,
    setTemplateImage: vi.fn()
  }))

  return {
    trays,
    windows,
    setBadgeMock,
    quitMock,
    openExternalMock,
    ipcHandlers,
    menuBuildFromTemplate,
    createFromBitmapMock,
    MockTray,
    MockBrowserWindow
  }
})

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    quit: electronMocks.quitMock,
    dock: { setBadge: electronMocks.setBadgeMock }
  },
  BrowserWindow: electronMocks.MockBrowserWindow,
  Tray: electronMocks.MockTray,
  Menu: { buildFromTemplate: electronMocks.menuBuildFromTemplate },
  shell: { openExternal: electronMocks.openExternalMock },
  nativeImage: { createFromBitmap: electronMocks.createFromBitmapMock },
  screen: {
    getDisplayNearestPoint: vi.fn(() => ({
      workArea: { x: 0, y: 25, width: 1280, height: 775 }
    }))
  },
  ipcMain: {
    handle: vi.fn((ch: string, fn: (_evt: unknown, arg: unknown) => Promise<unknown>) => {
      electronMocks.ipcHandlers.set(ch, fn)
    })
  }
}))

import {
  __testing as trayTesting,
  buildTrayTemplateIcon,
  computePopoverPosition,
  dispatchTrayAction,
  registerTray,
  type TraySettingsSlice
} from '../../src/electron/main/tray'

describe('tray module (Phase 3)', () => {
  beforeEach(() => {
    electronMocks.trays.length = 0
    electronMocks.windows.length = 0
    electronMocks.ipcHandlers.clear()
    electronMocks.setBadgeMock.mockReset()
    electronMocks.quitMock.mockReset()
    electronMocks.openExternalMock.mockReset().mockResolvedValue(undefined)
    electronMocks.createFromBitmapMock.mockClear()
    trayTesting.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('computePopoverPosition centers below tray and clamps inside screen workArea', () => {
    const pos = computePopoverPosition(
      { x: 1200, y: 0, width: 28, height: 22 },
      { x: 0, y: 25, width: 1280, height: 775 },
      360,
      460
    )
    expect(pos.x).toBe(1280 - 360 - 8)
    expect(pos.y).toBe(25 + 8)

    const leftPos = computePopoverPosition(
      { x: 10, y: 0, width: 24, height: 22 },
      { x: 0, y: 25, width: 1280, height: 775 },
      360,
      460
    )
    expect(leftPos.x).toBe(8)
  })

  test('buildTrayTemplateIcon creates 44x44 @2x bitmap with template flag enabled', () => {
    const icon = buildTrayTemplateIcon() as unknown as {
      opts: { width: number; height: number; scaleFactor: number }
      setTemplateImage: ReturnType<typeof vi.fn>
    }
    expect(icon.opts.width).toBe(44)
    expect(icon.opts.height).toBe(44)
    expect(icon.opts.scaleFactor).toBe(2.0)
    expect(icon.setTemplateImage).toHaveBeenCalledWith(true)
  })

  test('registerTray updates badges, reacts to settings changes, and toggles popover window', async () => {
    vi.useFakeTimers()
    const hooks: {
      settings?: (s: TraySettingsSlice) => void
      sse?: (p: unknown) => void
    } = {}
    let currentUnread = 3
    let currentSettings: TraySettingsSlice = { trayEnabled: true, dockBadgeEnabled: true }

    const mainSend = vi.fn()
    const mainWin = {
      isDestroyed: () => false,
      webContents: { isLoading: () => false, send: mainSend, once: vi.fn() }
    }

    const cleanup = registerTray({
      ensureMainWindow: async () => mainWin as never,
      getSettings: () => currentSettings,
      onSettingsChanged: (cb) => {
        hooks.settings = cb
        return () => {}
      },
      onSseEvent: (cb) => {
        hooks.sse = cb
        return () => {}
      },
      resolveApiPort: () => 8200,
      resolveAiGatewayPort: () => 8201,
      preloadPath: '/tmp/preload.mjs',
      rendererHtmlPath: '/tmp/index.html',
      rendererUrl: 'http://localhost:5173',
      surfaceWindowOptions: () => ({ vibrancy: 'fullscreen-ui' }),
      fetchUnreadTotal: async () => currentUnread
    })

    await vi.runOnlyPendingTimersAsync()
    expect(electronMocks.trays).toHaveLength(1)
    if (process.platform === 'darwin') {
      expect(electronMocks.trays[0].setTitle).toHaveBeenCalledWith('3', {
        fontType: 'monospacedDigit'
      })
      expect(electronMocks.setBadgeMock).toHaveBeenCalledWith('3')
    }

    // Left-click creates and positions ?tray=1 popover window
    electronMocks.trays[0].listeners.get('click')?.()
    expect(electronMocks.windows).toHaveLength(1)
    expect(electronMocks.windows[0].loadURL).toHaveBeenCalledWith(
      expect.stringContaining('tray=1')
    )
    expect(electronMocks.windows[0].show).toHaveBeenCalledOnce()

    // SSE notification.changed triggers debounced refresh
    currentUnread = 12
    hooks.sse?.({ event_type: 'notification.changed', data: {} })
    await vi.advanceTimersByTimeAsync(400)
    if (process.platform === 'darwin') {
      expect(electronMocks.setBadgeMock).toHaveBeenCalledWith('12')
    }

    // Disabling tray via settings destroys tray + popover
    currentSettings = { trayEnabled: false, dockBadgeEnabled: false }
    hooks.settings?.(currentSettings)
    expect(electronMocks.trays[0].destroy).toHaveBeenCalledOnce()
    if (process.platform === 'darwin') {
      expect(electronMocks.setBadgeMock).toHaveBeenCalledWith('')
    }

    cleanup()
  })

  test('dispatchTrayAction forwards newChat (with prompt), composeEmail, openToday, openCalendarToday, openSettings, openEmail, and quitApp', async () => {
    const sendMock = vi.fn()
    const mainWin = {
      isDestroyed: () => false,
      webContents: { isLoading: () => false, send: sendMock, once: vi.fn() }
    }
    const ensure = vi.fn(async () => mainWin as never)
    const hide = vi.fn()

    await dispatchTrayAction({ kind: 'newChat' }, ensure, hide)
    expect(sendMock).toHaveBeenCalledWith('mailagent:open-general-agent')

    await dispatchTrayAction({ kind: 'newChat', prompt: '总结今天邮件' }, ensure, hide)
    expect(sendMock).toHaveBeenCalledWith('mailagent:open-general-agent', {
      prompt: '总结今天邮件'
    })

    await dispatchTrayAction({ kind: 'composeEmail' }, ensure, hide)
    expect(sendMock).toHaveBeenCalledWith('mailagent:tray-compose-new')

    await dispatchTrayAction({ kind: 'openToday' }, ensure, hide)
    expect(sendMock).toHaveBeenCalledWith('mailagent:tray-open-today')

    await dispatchTrayAction({ kind: 'openCalendarToday' }, ensure, hide)
    expect(sendMock).toHaveBeenCalledWith('mailagent:deeplink', {
      kind: 'calendar',
      view: 'today'
    })

    await dispatchTrayAction({ kind: 'openSettings', tab: 'notifications' }, ensure, hide)
    expect(sendMock).toHaveBeenCalledWith('mailagent:deeplink', {
      kind: 'settings',
      view: 'notifications'
    })

    await dispatchTrayAction({ kind: 'openEmail', emailId: 88 }, ensure, hide)
    expect(sendMock).toHaveBeenCalledWith('mailagent:deeplink', { kind: 'email', id: 88 })

    await dispatchTrayAction({ kind: 'openLlmDashboard' }, ensure, hide)
    expect(sendMock).toHaveBeenCalledWith('mailagent:deeplink', { kind: 'llm' })

    await dispatchTrayAction(
      {
        kind: 'openNotification',
        id: 12,
        payload: { link: { type: 'email', emailId: 99 } },
        action: { id: 'open_email_ai', label: 'AI 拟稿 / 跟进', emailId: 99 }
      },
      ensure,
      hide
    )
    expect(sendMock).toHaveBeenCalledWith('notifications:navigate', {
      id: 12,
      payload: { link: { type: 'email', emailId: 99 } },
      action: { id: 'open_email_ai', label: 'AI 拟稿 / 跟进', emailId: 99 }
    })

    await dispatchTrayAction(
      {
        kind: 'openNotification',
        id: 13,
        payload: null,
        action: { id: 'join_meeting', label: '一键入会', url: 'https://zoom.us/j/123456' }
      },
      ensure,
      hide
    )
    expect(electronMocks.openExternalMock).toHaveBeenCalledWith('https://zoom.us/j/123456')

    await dispatchTrayAction({ kind: 'quitApp' }, ensure, hide)
    expect(electronMocks.quitMock).toHaveBeenCalledTimes(1)

    expect(hide).toHaveBeenCalledTimes(11)
  })
})
