import {
  BrowserWindow,
  ipcMain,
  screen,
  type BrowserWindowConstructorOptions,
  type Rectangle
} from 'electron'

import {
  COMPUTER_USE_IPC,
  IDLE_COMPUTER_USE_ACTIVITY,
  type ComputerUseActivityState
} from '../../shared/computerUseOverlayContract'

export interface OverlayWindowWebContentsLike {
  isLoading?: () => boolean
  once?: (event: 'did-finish-load', fn: () => void) => unknown
  send: (channel: string, ...args: unknown[]) => void
}

export interface OverlayWindowLike {
  isDestroyed: () => boolean
  isVisible: () => boolean
  showInactive: () => void
  hide: () => void
  close: () => void
  setBounds: (bounds: Partial<Rectangle>) => void
  setAlwaysOnTop: (
    flag: boolean,
    level?:
      | 'normal'
      | 'floating'
      | 'torn-off-menu'
      | 'modal-panel'
      | 'main-menu'
      | 'status'
      | 'pop-up-menu'
      | 'screen-saver'
  ) => void
  setVisibleOnAllWorkspaces: (visible: boolean, options?: { visibleOnFullScreen?: boolean }) => void
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }) => void
  loadURL: (url: string) => Promise<void> | void
  loadFile: (filePath: string, options?: { search?: string }) => Promise<void> | void
  on: (event: 'closed', listener: () => void) => unknown
  webContents: OverlayWindowWebContentsLike
}

export interface OverlayIpcLike {
  handle: (channel: string, listener: (...args: unknown[]) => unknown) => void
  removeHandler: (channel: string) => void
  on: (channel: string, listener: (...args: unknown[]) => void) => unknown
  removeListener: (channel: string, listener: (...args: unknown[]) => void) => unknown
}

export interface RegisterComputerUseOverlayOptions {
  preloadPath: string
  rendererHtmlPath: string
  rendererUrl?: string
  createWindow?: (opts: BrowserWindowConstructorOptions) => OverlayWindowLike
  getAllWindows?: () => Array<Pick<OverlayWindowLike, 'isDestroyed' | 'webContents'>>
  getPrimaryDisplayBounds?: () => Rectangle
  ipc?: OverlayIpcLike
  platform?: NodeJS.Platform
}

export interface ComputerUseOverlayController {
  reportActivity: (state: ComputerUseActivityState) => void
  registerAbort: (runId: string, abort: () => void) => () => void
  stopActive: () => { stopped: boolean }
  getState: () => ComputerUseActivityState
  dispose: () => void
}

export function registerComputerUseOverlay(
  opts: RegisterComputerUseOverlayOptions
): ComputerUseOverlayController {
  const ipc: OverlayIpcLike = opts.ipc ?? ipcMain
  const platform = opts.platform ?? process.platform
  const getAllWindows = opts.getAllWindows ?? (() => BrowserWindow.getAllWindows())
  const getPrimaryDisplayBounds =
    opts.getPrimaryDisplayBounds ?? (() => screen.getPrimaryDisplay().bounds)
  const createWindow =
    opts.createWindow ??
    ((winOpts: BrowserWindowConstructorOptions) => new BrowserWindow(winOpts) as OverlayWindowLike)

  let currentState: ComputerUseActivityState = IDLE_COMPUTER_USE_ACTIVITY
  let overlayWin: OverlayWindowLike | null = null
  const abortHandlers = new Map<string, () => void>()

  const sendLatestStateWhenReady = (
    win: Pick<OverlayWindowLike, 'isDestroyed' | 'webContents'>
  ): void => {
    if (win.isDestroyed()) return
    const wc = win.webContents
    if (typeof wc.isLoading === 'function' && wc.isLoading() && typeof wc.once === 'function') {
      wc.once('did-finish-load', () => {
        if (!win.isDestroyed()) {
          wc.send(COMPUTER_USE_IPC.activityChanged, currentState)
        }
      })
      return
    }
    wc.send(COMPUTER_USE_IPC.activityChanged, currentState)
  }

  const ensureOverlayWindow = (): OverlayWindowLike => {
    if (overlayWin && !overlayWin.isDestroyed()) return overlayWin
    const bounds = getPrimaryDisplayBounds()
    const win = createWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: opts.preloadPath,
        sandbox: false
      }
    })
    win.on('closed', () => {
      if (overlayWin === win) overlayWin = null
    })
    const search = new URLSearchParams({ cuOverlay: '1' }).toString()
    if (opts.rendererUrl) {
      void win.loadURL(`${opts.rendererUrl}?${search}`)
    } else {
      void win.loadFile(opts.rendererHtmlPath, { search })
    }
    overlayWin = win
    return win
  }

  const broadcastState = (): void => {
    const seen = new Set<Pick<OverlayWindowLike, 'isDestroyed' | 'webContents'>>()
    for (const win of getAllWindows()) {
      seen.add(win)
      sendLatestStateWhenReady(win)
    }
    if (overlayWin && !seen.has(overlayWin)) {
      sendLatestStateWhenReady(overlayWin)
    }
  }

  const reportActivity = (next: ComputerUseActivityState): void => {
    currentState = next
    const showDesktopOverlay = next.active && next.surface === 'desktop'
    if (showDesktopOverlay) {
      const win = ensureOverlayWindow()
      const bounds = getPrimaryDisplayBounds()
      win.setBounds(bounds)
      win.setAlwaysOnTop(true, 'screen-saver')
      if (platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      }
      win.setIgnoreMouseEvents(true, { forward: true })
      if (!win.isVisible()) {
        win.showInactive()
      }
    } else if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setIgnoreMouseEvents(true, { forward: true })
      if (overlayWin.isVisible()) {
        overlayWin.hide()
      }
    }
    broadcastState()
  }

  const registerAbort = (runId: string, abort: () => void): (() => void) => {
    abortHandlers.set(runId, abort)
    return () => {
      const registered = abortHandlers.get(runId)
      if (registered === abort) {
        abortHandlers.delete(runId)
      }
    }
  }

  const stopActive = (): { stopped: boolean } => {
    const handlers = [...abortHandlers.values()]
    abortHandlers.clear()
    const hadActive = handlers.length > 0 || currentState.active
    for (const fn of handlers) {
      try {
        fn()
      } catch {
        /* ignore individual abort errors */
      }
    }
    reportActivity(IDLE_COMPUTER_USE_ACTIVITY)
    return { stopped: hadActive }
  }

  const onSetInteractive = (_evt: unknown, interactive: unknown): void => {
    if (!overlayWin || overlayWin.isDestroyed()) return
    if (interactive === true) {
      overlayWin.setIgnoreMouseEvents(false)
    } else {
      overlayWin.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  ipc.removeHandler(COMPUTER_USE_IPC.getState)
  ipc.removeHandler(COMPUTER_USE_IPC.stopActive)
  ipc.handle(COMPUTER_USE_IPC.getState, () => currentState)
  ipc.handle(COMPUTER_USE_IPC.stopActive, () => stopActive())
  ipc.on(COMPUTER_USE_IPC.overlaySetInteractive, onSetInteractive)

  const dispose = (): void => {
    ipc.removeHandler(COMPUTER_USE_IPC.getState)
    ipc.removeHandler(COMPUTER_USE_IPC.stopActive)
    ipc.removeListener(COMPUTER_USE_IPC.overlaySetInteractive, onSetInteractive)
    abortHandlers.clear()
    currentState = IDLE_COMPUTER_USE_ACTIVITY
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.close()
    }
    overlayWin = null
  }

  return {
    reportActivity,
    registerAbort,
    stopActive,
    getState: () => currentState,
    dispose
  }
}
