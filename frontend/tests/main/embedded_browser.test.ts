// @vitest-environment node

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, test, vi } from 'vitest'

const createdViews: Array<{
  opts: Record<string, unknown>
  bounds: { x: number; y: number; width: number; height: number }
  visible: boolean
  urls: string[]
  closed: boolean
  webContents: EventEmitter & {
    loadURL: (url: string) => Promise<void>
    getTitle: () => string
    getURL: () => string
    isLoading: () => boolean
    isDestroyed: () => boolean
    canGoBack: () => boolean
    canGoForward: () => boolean
    goBack: () => void
    goForward: () => void
    reload: () => void
    openDevTools: () => void
    close: () => void
    setWindowOpenHandler: (
      fn: (d: {
        url: string
        frameName?: string
        features?: string
        disposition?: string
      }) => { action: string; overrideBrowserWindowOptions?: Record<string, unknown> }
    ) => void
    windowOpenHandler?: (d: {
      url: string
      frameName?: string
      features?: string
      disposition?: string
    }) => { action: string; overrideBrowserWindowOptions?: Record<string, unknown> }
    debugger: Record<string, unknown>
  }
}> = []

vi.mock('electron', () => {
  class FakeWebContentsView {
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    visible = true
    urls: string[] = []
    closed = false
    webContents: (typeof createdViews)[number]['webContents']

    constructor(opts: Record<string, unknown>) {
      const wc = new EventEmitter() as (typeof createdViews)[number]['webContents']
      wc.loadURL = async (url: string) => {
        this.urls.push(url)
      }
      wc.getTitle = () => (this.urls.at(-1) ? `Title:${this.urls.at(-1)}` : '')
      wc.getURL = () => this.urls.at(-1) ?? 'about:blank'
      wc.isLoading = () => false
      wc.isDestroyed = () => this.closed
      wc.canGoBack = () => this.urls.length > 1
      wc.canGoForward = () => false
      wc.goBack = () => {}
      wc.goForward = () => {}
      wc.reload = () => {}
      wc.openDevTools = () => {}
      wc.close = () => {
        this.closed = true
      }
      wc.setWindowOpenHandler = (fn) => {
        wc.windowOpenHandler = fn
      }
      wc.debugger = {}
      this.webContents = wc
      createdViews.push({
        opts,
        bounds: this.bounds,
        visible: this.visible,
        urls: this.urls,
        closed: this.closed,
        webContents: wc
      })
    }

    setBounds(b: { x: number; y: number; width: number; height: number }) {
      this.bounds = { ...b }
      const rec = createdViews.find((v) => v.webContents === this.webContents)
      if (rec) rec.bounds = { ...b }
    }

    getBounds() {
      return this.bounds
    }

    setVisible(v: boolean) {
      this.visible = v
      const rec = createdViews.find((v2) => v2.webContents === this.webContents)
      if (rec) rec.visible = v
    }
  }

  return {
    BrowserWindow: class {},
    WebContentsView: FakeWebContentsView,
    Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
    clipboard: { writeText: () => {} },
    ipcMain: { handle: () => {}, removeHandler: () => {} },
    session: { fromPartition: () => ({ cookies: {} }) },
    shell: { openExternal: async () => {} }
  }
})

const {
  EmbeddedBrowserManager,
  MAX_AUTH_POPUP_WINDOWS,
  isAllowedEmbeddedNavigationUrl,
  normalizeEmbeddedBrowserUrl,
  parsePopupWindowSize,
  sanitizeBrowserUserAgent,
  shouldOpenAsAuthPopup,
  toElectronCookieDetails
} = await import('../../src/electron/main/embedded_browser')

afterEach(() => {
  createdViews.length = 0
})

describe('embedded_browser', () => {
  test('normalizes URLs cleanly and rejects dangerous schemes', () => {
    expect(normalizeEmbeddedBrowserUrl('oa.example.com/inbox')).toBe('https://oa.example.com/inbox')
    expect(normalizeEmbeddedBrowserUrl('about:blank')).toBe('about:blank')
    expect(normalizeEmbeddedBrowserUrl('')).toBe('about:blank')

    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'mailagent://open',
      'libpreview://doc/1',
      'chrome://settings',
      'data:text/html,hi'
    ]) {
      expect(() => normalizeEmbeddedBrowserUrl(bad)).toThrow()
      expect(isAllowedEmbeddedNavigationUrl(bad)).toBe(false)
    }
  })

  test('converts host-only, domain, and __Host- cookies accurately for Electron session', () => {
    const hostOnly = toElectronCookieDetails({
      name: 'sid',
      value: 'v1',
      domain: 'oa.corp',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      expires: 1_900_000_000
    })
    expect(hostOnly).toEqual({
      url: 'https://oa.corp/',
      name: 'sid',
      value: 'v1',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: 1_900_000_000
    })

    const wildcard = toElectronCookieDetails({
      name: 'prefs',
      value: 'dark',
      domain: '.oa.corp',
      path: '/app',
      secure: false
    })
    expect(wildcard?.domain).toBe('.oa.corp')

    const hostPrefix = toElectronCookieDetails({
      name: '__Host-csrf',
      value: 'tok',
      domain: 'oa.corp',
      path: '/',
      secure: false
    })
    expect(hostPrefix?.secure).toBe(true)
    expect(hostPrefix?.domain).toBeUndefined()
  })

  test('attaches WebContentsView with strict sandbox, routes popups to tabs, and keeps tabs alive on detach', async () => {
    const childViews = new Set<unknown>()
    const fakeWin = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
      contentView: {
        addChildView: (v: unknown) => childViews.add(v),
        removeChildView: (v: unknown) => childViews.delete(v)
      }
    }

    const fakeSession = {
      cookies: {
        get: async () => [],
        set: async () => {},
        remove: async () => {},
        flushStore: async () => {}
      }
    } as unknown as Electron.Session

    const mgr = new EmbeddedBrowserManager({
      browserSession: fakeSession,
      getHostWindow: () => fakeWin as unknown as Electron.BrowserWindow
    })

    const state1 = mgr.attach({ x: 100, y: 80, width: 500, height: 600, visible: true })
    expect(state1.tabs).toHaveLength(1)
    expect(childViews.size).toBe(1)

    // Strict isolated sandbox + zero preload
    const wp = createdViews[0].opts.webPreferences as Record<string, unknown>
    expect(wp.sandbox).toBe(true)
    expect(wp.contextIsolation).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.preload).toBeUndefined()

    // Popup routes into managed tab and denies raw BrowserWindow popup
    const action = createdViews[0].webContents.windowOpenHandler?.({ url: 'https://docs.corp/auth' })
    expect(action).toEqual({ action: 'deny' })
    expect(mgr.getState().tabs).toHaveLength(2)

    // Setting visible=false hides child view while preserving all tabs
    mgr.setBounds({ x: 100, y: 80, width: 500, height: 600, visible: false })
    expect(childViews.size).toBe(0)
    expect(mgr.getState().tabs).toHaveLength(2)

    // Detach keeps tabs alive in background
    mgr.detach()
    expect(mgr.getState().tabs).toHaveLength(2)
  })

  test('sanitizes Electron and MailAgent tokens from browser session user agent', () => {
    const raw =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) MailAgent/2.16.0 Chrome/142.0.7444.265 Electron/39.8.7 Safari/537.36'
    const clean = sanitizeBrowserUserAgent(raw)
    expect(clean).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.265 Safari/537.36'
    )
    expect(clean).not.toContain('Electron/')
    expect(clean).not.toContain('MailAgent/')

    const setUserAgent = vi.fn()
    const fakeSession = {
      getUserAgent: () => raw,
      setUserAgent,
      cookies: {
        get: async () => [],
        set: async () => {},
        remove: async () => {},
        flushStore: async () => {}
      }
    } as unknown as Electron.Session

    new EmbeddedBrowserManager({
      browserSession: fakeSession,
      getHostWindow: () => null
    })
    expect(setUserAgent).toHaveBeenCalledWith(clean)
  })

  test('detects OAuth/SSO popups vs ordinary links and clamps popup size', () => {
    expect(
      shouldOpenAsAuthPopup({
        url: 'https://accounts.google.com/o/oauth2/auth',
        features: 'width=500,height=650'
      })
    ).toBe(true)
    expect(
      shouldOpenAsAuthPopup({
        url: 'about:blank',
        frameName: 'oauth_popup',
        disposition: 'foreground-tab'
      })
    ).toBe(true)
    expect(
      shouldOpenAsAuthPopup({
        url: 'https://github.com/login/oauth/authorize',
        frameName: 'github_sso',
        disposition: 'foreground-tab'
      })
    ).toBe(true)
    expect(
      shouldOpenAsAuthPopup({
        url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        disposition: 'new-window'
      })
    ).toBe(true)

    expect(
      shouldOpenAsAuthPopup({
        url: 'https://docs.corp/article',
        frameName: '_blank',
        disposition: 'foreground-tab'
      })
    ).toBe(false)
    expect(
      shouldOpenAsAuthPopup({
        url: 'https://docs.corp/article',
        disposition: 'background-tab'
      })
    ).toBe(false)

    expect(parsePopupWindowSize()).toEqual({ width: 520, height: 680 })
    expect(parsePopupWindowSize('width=100,height=2000')).toEqual({ width: 420, height: 960 })
    expect(parsePopupWindowSize('width=540,height=720')).toEqual({ width: 540, height: 720 })
  })

  test('allows sandboxed OAuth popups sharing session, enforces cap, blocks unsafe schemes, and cleans up on close/dispose', async () => {
    const fakeWin = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
    }
    const flushStore = vi.fn(async () => {})
    const fakeSession = {
      cookies: {
        get: async () => [],
        set: async () => {},
        remove: async () => {},
        flushStore
      }
    } as unknown as Electron.Session

    const mgr = new EmbeddedBrowserManager({
      browserSession: fakeSession,
      getHostWindow: () => fakeWin as unknown as Electron.BrowserWindow
    })
    mgr.attach({ x: 0, y: 0, width: 600, height: 700, visible: true })

    // 1. Dangerous scheme denied even with popup features
    const dangerous = createdViews[0].webContents.windowOpenHandler?.({
      url: 'javascript:alert(1)',
      features: 'width=500,height=600'
    })
    expect(dangerous).toEqual({ action: 'deny' })

    // 2. OAuth popup allowed with strict sandbox + shared session + host parent
    const authRes = createdViews[0].webContents.windowOpenHandler?.({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      features: 'width=500,height=650'
    })
    expect(authRes?.action).toBe('allow')
    const override = authRes?.overrideBrowserWindowOptions as Record<string, unknown>
    expect(override.parent).toBe(fakeWin)
    expect(override.width).toBe(500)
    expect(override.height).toBe(650)
    const wp = override.webPreferences as Record<string, unknown>
    expect(wp.session).toBe(fakeSession)
    expect(wp.sandbox).toBe(true)
    expect(wp.contextIsolation).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.preload).toBeUndefined()

    // 3. did-create-window tracks popup, installs nav guard, and flushes cookies on close
    const makeFakePopup = () => {
      const popupWin = new EventEmitter() as unknown as Electron.BrowserWindow & {
        _destroyed: boolean
        close: () => void
        isDestroyed: () => boolean
        webContents: EventEmitter & {
          setWindowOpenHandler: (fn: unknown) => void
          windowOpenHandler?: unknown
        }
      }
      popupWin._destroyed = false
      popupWin.isDestroyed = () => popupWin._destroyed
      popupWin.close = () => {
        if (popupWin._destroyed) return
        popupWin._destroyed = true
        popupWin.emit('closed')
      }
      const pwc = new EventEmitter() as EventEmitter & {
        setWindowOpenHandler: (fn: unknown) => void
        windowOpenHandler?: unknown
      }
      pwc.setWindowOpenHandler = (fn) => {
        pwc.windowOpenHandler = fn
      }
      popupWin.webContents = pwc as unknown as typeof popupWin.webContents
      return popupWin
    }

    const p1 = makeFakePopup()
    createdViews[0].webContents.emit('did-create-window', p1)
    expect(mgr.getPopupCount()).toBe(1)

    const preventDefault = vi.fn()
    p1.webContents.emit('will-navigate', { preventDefault }, 'file:///etc/passwd')
    expect(preventDefault).toHaveBeenCalledTimes(1)

    p1.close()
    await Promise.resolve()
    expect(mgr.getPopupCount()).toBe(0)
    expect(flushStore).toHaveBeenCalledTimes(1)

    // 4. Cap at MAX_AUTH_POPUP_WINDOWS (5th popup falls back to tab and returns deny)
    const activePopups = Array.from({ length: MAX_AUTH_POPUP_WINDOWS }, () => {
      const p = makeFakePopup()
      createdViews[0].webContents.emit('did-create-window', p)
      return p
    })
    expect(mgr.getPopupCount()).toBe(MAX_AUTH_POPUP_WINDOWS)

    const overCap = createdViews[0].webContents.windowOpenHandler?.({
      url: 'https://sso.example.com/login',
      features: 'width=500,height=650'
    })
    expect(overCap).toEqual({ action: 'deny' })
    expect(mgr.getState().tabs.some((t) => t.url === 'https://sso.example.com/login')).toBe(true)

    // 5. resetSession closes all remaining popup windows
    await mgr.resetSession()
    expect(mgr.getPopupCount()).toBe(0)
    for (const p of activePopups) {
      expect(p.isDestroyed()).toBe(true)
    }

    // 6. dispose also closes active popups
    const pExtra = makeFakePopup()
    createdViews[createdViews.length - 1].webContents.emit('did-create-window', pExtra)
    expect(mgr.getPopupCount()).toBe(1)
    mgr.dispose()
    expect(mgr.getPopupCount()).toBe(0)
    expect(pExtra.isDestroyed()).toBe(true)
  })
})
