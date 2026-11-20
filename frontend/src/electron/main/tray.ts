// Phase 3 — macOS Menu Bar 常驻 Tray + Popover 微面板 + Dock 未读角标同步。
//
// 所有依赖可经 RegisterTrayOptions 注入，保持叶子可测，不把重依赖拖进单测图。

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
  type Rectangle
} from 'electron'

import { getLocalApiToken, LOCAL_TOKEN_HEADER } from './local_token'

export type TrayActionPayload =
  | { kind: 'openMain' }
  | { kind: 'newChat'; prompt?: string }
  | { kind: 'composeEmail' }
  | { kind: 'openToday' }
  | { kind: 'openCalendarToday' }
  | { kind: 'openLlmDashboard' }
  | { kind: 'openSettings'; tab?: string }
  | { kind: 'openEmail'; emailId: number }
  | {
      kind: 'openNotification'
      id?: number
      payload: Record<string, unknown> | null
      action?: Record<string, unknown> | null
    }
  | { kind: 'quitApp' }

export interface TraySettingsSlice {
  trayEnabled?: boolean
  dockBadgeEnabled?: boolean
}

export interface RegisterTrayOptions {
  ensureMainWindow: () => Promise<BrowserWindow | null>
  getSettings: () => TraySettingsSlice
  onSettingsChanged?: (listener: (next: TraySettingsSlice) => void) => () => void
  onSseEvent?: (listener: (payload: unknown) => void) => () => void
  resolveApiPort: () => number
  resolveAiGatewayPort: () => number
  preloadPath: string
  rendererHtmlPath: string
  rendererUrl?: string
  surfaceWindowOptions: () => Electron.BrowserWindowConstructorOptions
  applyNativeSurface?: (win: BrowserWindow, surface: 'frosted' | 'solid') => void
  getPersistedSurface?: () => 'frosted' | 'solid'
  fetchUnreadTotal?: () => Promise<number | null>
}

const POPOVER_WIDTH = 368
const POPOVER_HEIGHT = 468
const POLL_INTERVAL_MS = 60_000
const SSE_DEBOUNCE_MS = 300

let _tray: Tray | null = null
let _popover: BrowserWindow | null = null
let _pollTimer: ReturnType<typeof setInterval> | null = null
let _debounceTimer: ReturnType<typeof setTimeout> | null = null
let _lastUnreadTotal = 0
let _opts: RegisterTrayOptions | null = null
let _unsubSettings: (() => void) | null = null
let _unsubSse: (() => void) | null = null
let _ipcRegistered = false
let _isQuitting = false

/** 计算 Tray Popover 坐标：水平居中于图标下方，钳位在当前显示器 workArea 内。 */
export function computePopoverPosition(
  trayBounds: Rectangle,
  workArea: Rectangle,
  width = POPOVER_WIDTH,
  height = POPOVER_HEIGHT
): { x: number; y: number } {
  const centeredX = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2)
  const maxX = workArea.x + Math.max(0, workArea.width - width)
  const x = Math.min(Math.max(centeredX, workArea.x + 8), Math.max(workArea.x + 8, maxX - 8))

  const belowY = Math.round(trayBounds.y + trayBounds.height + 4)
  const fitsBelow = belowY + height <= workArea.y + workArea.height
  const aboveY = Math.round(trayBounds.y - height - 4)
  const rawY = fitsBelow ? belowY : Math.max(workArea.y + 8, aboveY)
  const maxY = workArea.y + Math.max(0, workArea.height - height)
  const y = Math.min(Math.max(rawY, workArea.y + 8), Math.max(workArea.y + 8, maxY - 8))
  return { x, y }
}

function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const lenSq = bax * bax + bay * bay
  const h = lenSq > 0 ? Math.max(0, Math.min(1, (pax * bax + pay * bay) / lenSq)) : 0
  return Math.hypot(pax - bax * h, pay - bay * h)
}

/** 构造 22pt (@2x 44px) 抗锯齿单色 Template 菜单栏图标（SF Symbols 比例对称圆角信封，零 hex 字面量）。 */
export function buildTrayTemplateIcon(): Electron.NativeImage {
  const size = 44
  const buf = Buffer.alloc(size * size * 4, 0)

  // Symmetric rounded envelope (33×23px inner box -> ~18pt visual span, ~1.8pt stroke weight)
  const cx = 22.0
  const cy = 22.0
  const hw = 16.5
  const hh = 11.5
  const cornerR = 4.6
  const borderHalfStroke = 1.75

  for (let py = 0; py < size; py++) {
    const y = py + 0.5
    for (let px = 0; px < size; px++) {
      const x = px + 0.5

      const qx = Math.abs(x - cx) - (hw - cornerR)
      const qy = Math.abs(y - cy) - (hh - cornerR)
      const dBox =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - cornerR
      const dEnvelope = Math.abs(dBox) - borderHalfStroke

      const dFlapL = sdSegment(x, y, 7.5, 14.0, 22.0, 24.0) - 1.65
      const dFlapR = sdSegment(x, y, 36.5, 14.0, 22.0, 24.0) - 1.65

      const dist = Math.min(dEnvelope, dFlapL, dFlapR)
      const coverage = Math.max(0, Math.min(1, 0.5 - dist))
      if (coverage > 0) {
        const idx = (py * size + px) * 4
        buf[idx] = 0
        buf[idx + 1] = 0
        buf[idx + 2] = 0
        buf[idx + 3] = Math.round(coverage * 255)
      }
    }
  }

  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2.0 })
  if (typeof img.setTemplateImage === 'function') {
    img.setTemplateImage(true)
  }
  return img
}

function sendWhenReady(win: BrowserWindow, channel: string, payload?: unknown): void {
  if (win.isDestroyed()) return
  const contents = win.webContents
  if (
    typeof contents.isLoading === 'function' &&
    contents.isLoading() &&
    typeof contents.once === 'function'
  ) {
    contents.once('did-finish-load', (): void => {
      if (!win.isDestroyed()) {
        if (payload === undefined) contents.send(channel)
        else contents.send(channel, payload)
      }
    })
    return
  }
  if (payload === undefined) contents.send(channel)
  else contents.send(channel, payload)
}

export async function dispatchTrayAction(
  action: TrayActionPayload,
  ensureMainWindow: () => Promise<BrowserWindow | null>,
  hidePopover?: () => void
): Promise<{ ok: boolean }> {
  hidePopover?.()
  if (action.kind === 'quitApp') {
    app.quit()
    return { ok: true }
  }
  if (
    action.kind === 'openNotification' &&
    action.action?.id === 'join_meeting' &&
    typeof action.action.url === 'string' &&
    action.action.url.startsWith('https://')
  ) {
    void shell.openExternal(action.action.url)
    return { ok: true }
  }
  const win = await ensureMainWindow()
  if (!win || win.isDestroyed()) return { ok: false }

  switch (action.kind) {
    case 'openMain':
      return { ok: true }
    case 'newChat': {
      const prompt = typeof action.prompt === 'string' ? action.prompt.trim() : ''
      sendWhenReady(win, 'mailagent:open-general-agent', prompt ? { prompt } : undefined)
      return { ok: true }
    }
    case 'composeEmail':
      sendWhenReady(win, 'mailagent:tray-compose-new')
      return { ok: true }
    case 'openToday':
      sendWhenReady(win, 'mailagent:tray-open-today')
      return { ok: true }
    case 'openCalendarToday':
      sendWhenReady(win, 'mailagent:deeplink', { kind: 'calendar', view: 'today' })
      return { ok: true }
    case 'openLlmDashboard':
      sendWhenReady(win, 'mailagent:deeplink', { kind: 'llm' })
      return { ok: true }
    case 'openSettings':
      sendWhenReady(win, 'mailagent:deeplink', {
        kind: 'settings',
        view: action.tab ?? 'notifications'
      })
      return { ok: true }
    case 'openEmail':
      if (typeof action.emailId === 'number' && Number.isInteger(action.emailId)) {
        sendWhenReady(win, 'mailagent:deeplink', { kind: 'email', id: action.emailId })
      }
      return { ok: true }
    case 'openNotification':
      sendWhenReady(win, 'notifications:navigate', {
        id: typeof action.id === 'number' ? action.id : 0,
        payload: action.payload ?? null,
        ...(action.action ? { action: action.action } : {})
      })
      return { ok: true }
  }
}

async function defaultFetchUnreadTotal(apiPort: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/notifications/unread-count`, {
      headers: { [LOCAL_TOKEN_HEADER]: getLocalApiToken() }
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { total?: unknown }; total?: unknown }
    const rawTotal = json?.data?.total ?? json?.total
    if (typeof rawTotal !== 'number' || !Number.isFinite(rawTotal)) return null
    return Math.max(0, Math.floor(rawTotal))
  } catch {
    return null
  }
}

function applyBadgeNumbers(total: number): void {
  _lastUnreadTotal = total
  const badgeText = total > 0 ? (total > 99 ? '99+' : String(total)) : ''
  if (_tray && !_tray.isDestroyed() && process.platform === 'darwin') {
    if (typeof _tray.setTitle === 'function') {
      _tray.setTitle(badgeText, { fontType: 'monospacedDigit' })
    }
  }
  const settings = _opts?.getSettings()
  const dockEnabled = settings?.dockBadgeEnabled !== false
  if (process.platform === 'darwin' && app.dock && typeof app.dock.setBadge === 'function') {
    app.dock.setBadge(dockEnabled ? badgeText : '')
  }
}

export async function refreshTrayBadges(): Promise<void> {
  if (!_opts) return
  const total = _opts.fetchUnreadTotal
    ? await _opts.fetchUnreadTotal()
    : await defaultFetchUnreadTotal(_opts.resolveApiPort())
  if (total !== null) {
    applyBadgeNumbers(total)
  }
}

function ensurePopoverWindow(): BrowserWindow | null {
  if (!_opts) return null
  if (_popover && !_popover.isDestroyed()) return _popover

  const opts = _opts
  const baseSurfaceOpts = opts.surfaceWindowOptions()
  const popoverSurfaceOpts =
    process.platform === 'darwin' && 'vibrancy' in baseSurfaceOpts && baseSurfaceOpts.vibrancy
      ? { ...baseSurfaceOpts, vibrancy: 'popover' as const }
      : baseSurfaceOpts
  const pop = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    roundedCorners: true,
    hasShadow: true,
    show: false,
    ...popoverSurfaceOpts,
    webPreferences: {
      preload: opts.preloadPath,
      sandbox: false
    }
  })

  pop.on('ready-to-show', (): void => {
    const surface = opts.getPersistedSurface?.() ?? 'frosted'
    if (opts.applyNativeSurface && opts.getPersistedSurface) {
      opts.applyNativeSurface(pop, surface)
    }
    if (
      process.platform === 'darwin' &&
      surface === 'frosted' &&
      typeof pop.setVibrancy === 'function'
    ) {
      try {
        pop.setVibrancy('popover')
      } catch {
        /* ignore platform vibrancy fallback */
      }
    }
  })
  pop.on('blur', (): void => {
    if (!pop.isDestroyed() && pop.isVisible()) {
      pop.hide()
    }
  })
  pop.on('closed', (): void => {
    if (_popover === pop) _popover = null
  })

  const search = new URLSearchParams({
    tray: '1',
    apiPort: String(opts.resolveApiPort()),
    aiGatewayPort: String(opts.resolveAiGatewayPort())
  }).toString()

  if (opts.rendererUrl) {
    void pop.loadURL(`${opts.rendererUrl}?${search}`)
  } else {
    void pop.loadFile(opts.rendererHtmlPath, { search })
  }

  _popover = pop
  return pop
}

function togglePopover(): void {
  if (!_tray || _tray.isDestroyed() || !_opts) return
  if (_popover && !_popover.isDestroyed() && _popover.isVisible()) {
    _popover.hide()
    return
  }
  const pop = ensurePopoverWindow()
  if (!pop) return

  const bounds = _tray.getBounds()
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
  const pos = computePopoverPosition(bounds, display.workArea, POPOVER_WIDTH, POPOVER_HEIGHT)
  pop.setPosition(pos.x, pos.y, false)
  pop.show()
  pop.focus()
  if (!pop.webContents.isLoading()) {
    pop.webContents.send('tray:opened')
  }
}

function createTrayInstance(): void {
  if (_tray && !_tray.isDestroyed()) return
  const opts = _opts
  if (!opts) return

  const tray = new Tray(buildTrayTemplateIcon())
  tray.setToolTip('MailAgent')
  tray.on('click', (): void => {
    togglePopover()
  })
  tray.on('right-click', (): void => {
    const menu = Menu.buildFromTemplate([
      {
        label: '打开主窗口',
        click: (): void => {
          void dispatchTrayAction({ kind: 'openMain' }, opts.ensureMainWindow, hidePopover)
        }
      },
      {
        label: '今日待办与总结',
        click: (): void => {
          void dispatchTrayAction({ kind: 'openToday' }, opts.ensureMainWindow, hidePopover)
        }
      },
      {
        label: '新建 AI 会话',
        click: (): void => {
          void dispatchTrayAction({ kind: 'newChat' }, opts.ensureMainWindow, hidePopover)
        }
      },
      {
        label: 'LLM 用量与缓存看板',
        click: (): void => {
          void dispatchTrayAction(
            { kind: 'openLlmDashboard' },
            opts.ensureMainWindow,
            hidePopover
          )
        }
      },
      {
        label: '通知与常驻设置',
        click: (): void => {
          void dispatchTrayAction(
            { kind: 'openSettings', tab: 'notifications' },
            opts.ensureMainWindow,
            hidePopover
          )
        }
      },
      { type: 'separator' },
      {
        label: '退出 MailAgent',
        click: (): void => {
          app.quit()
        }
      }
    ])
    tray.popUpContextMenu(menu)
  })
  _tray = tray
  applyBadgeNumbers(_lastUnreadTotal)
}

function hidePopover(): void {
  if (_popover && !_popover.isDestroyed() && _popover.isVisible()) {
    _popover.hide()
  }
}

function destroyTrayInstance(): void {
  if (_popover && !_popover.isDestroyed()) {
    _popover.close()
  }
  _popover = null
  if (_tray && !_tray.isDestroyed()) {
    _tray.destroy()
  }
  _tray = null
}

function syncTrayEnabled(enabled: boolean): void {
  if (enabled) {
    createTrayInstance()
  } else {
    destroyTrayInstance()
  }
}

export function registerTray(opts: RegisterTrayOptions): () => void {
  _opts = opts
  _isQuitting = false

  if (!_ipcRegistered) {
    _ipcRegistered = true
    ipcMain.handle(
      'tray:action',
      async (_evt, action: TrayActionPayload): Promise<{ ok: boolean }> => {
        if (!_opts || !action || typeof action !== 'object') return { ok: false }
        return dispatchTrayAction(action, _opts.ensureMainWindow, hidePopover)
      }
    )
  }

  const initial = opts.getSettings()
  if (initial.trayEnabled !== false) {
    createTrayInstance()
  }
  applyBadgeNumbers(_lastUnreadTotal)
  void refreshTrayBadges()

  if (_pollTimer) clearInterval(_pollTimer)
  _pollTimer = setInterval((): void => {
    void refreshTrayBadges()
  }, POLL_INTERVAL_MS)
  if (typeof (_pollTimer as { unref?: () => void }).unref === 'function') {
    ;(_pollTimer as { unref: () => void }).unref()
  }

  _unsubSettings?.()
  _unsubSettings = opts.onSettingsChanged
    ? opts.onSettingsChanged((next): void => {
        syncTrayEnabled(next.trayEnabled !== false)
        applyBadgeNumbers(_lastUnreadTotal)
      })
    : null

  _unsubSse?.()
  _unsubSse = opts.onSseEvent
    ? opts.onSseEvent((payload): void => {
        if (
          payload &&
          typeof payload === 'object' &&
          (payload as { event_type?: unknown }).event_type === 'notification.changed'
        ) {
          if (_debounceTimer) clearTimeout(_debounceTimer)
          _debounceTimer = setTimeout((): void => {
            _debounceTimer = null
            void refreshTrayBadges()
          }, SSE_DEBOUNCE_MS)
        }
      })
    : null

  app.on('before-quit', (): void => {
    _isQuitting = true
    destroyTrayInstance()
  })

  return (): void => {
    if (_pollTimer) {
      clearInterval(_pollTimer)
      _pollTimer = null
    }
    if (_debounceTimer) {
      clearTimeout(_debounceTimer)
      _debounceTimer = null
    }
    _unsubSettings?.()
    _unsubSettings = null
    _unsubSse?.()
    _unsubSse = null
    if (!_isQuitting) {
      destroyTrayInstance()
    }
    _opts = null
  }
}

export const __testing = {
  reset(): void {
    destroyTrayInstance()
    if (_pollTimer) clearInterval(_pollTimer)
    if (_debounceTimer) clearTimeout(_debounceTimer)
    _pollTimer = null
    _debounceTimer = null
    _unsubSettings?.()
    _unsubSse?.()
    _unsubSettings = null
    _unsubSse = null
    _lastUnreadTotal = 0
    _opts = null
    _ipcRegistered = false
    _isQuitting = false
  },
  getTray(): Tray | null {
    return _tray
  },
  getPopover(): BrowserWindow | null {
    return _popover
  }
}
