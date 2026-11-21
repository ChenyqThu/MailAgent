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
    setWindowOpenHandler: (fn: (d: { url: string }) => { action: string }) => void
    windowOpenHandler?: (d: { url: string }) => { action: string }
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
  isAllowedEmbeddedNavigationUrl,
  normalizeEmbeddedBrowserUrl,
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
})
