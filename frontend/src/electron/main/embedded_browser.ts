// Native multi-tab Electron WebContentsView manager backed by persistent partition
// `persist:mailagent-browser` + target-isolated loopback CDP bridge.
//
// Zero `--remote-debugging-port`: MailAgent's main UI BrowserWindow, tray, and
// overlay remain strictly invisible to Playwright / Agent automation.

import {
  BrowserWindow,
  Menu,
  WebContentsView,
  clipboard,
  ipcMain,
  session,
  shell
} from 'electron'
import { EventEmitter } from 'node:events'

import {
  EMBEDDED_BROWSER_IPC,
  EMBEDDED_BROWSER_PARTITION,
  type EmbeddedBrowserBounds,
  type EmbeddedBrowserState,
  type EmbeddedBrowserTab
} from '../../shared/embeddedBrowserContract'
import {
  EmbeddedBrowserCdpServer,
  type CdpCookieInput,
  type CdpCookieRecord,
  type EmbeddedBrowserCdpHost,
  type ManagedCdpTabHandle
} from './embedded_browser_cdp'

const DEFAULT_OFFSCREEN_BOUNDS = { x: 0, y: 0, width: 1280, height: 900 }
const BLOCKED_SCHEMES = [
  'javascript:',
  'data:',
  'file:',
  'mailagent:',
  'libpreview:',
  'chrome:',
  'chrome-extension:',
  'vbscript:',
  'blob:'
] as const

export function normalizeEmbeddedBrowserUrl(raw: string): string {
  const text = (raw || '').trim()
  if (!text || text === 'about:blank') return 'about:blank'
  const lowered = text.toLowerCase()
  for (const blocked of BLOCKED_SCHEMES) {
    if (lowered.startsWith(blocked)) {
      throw new Error(`Unsupported URL scheme: ${blocked}`)
    }
  }
  const candidate = text.includes('://') ? text : `https://${text}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname
  ) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`)
  }
  return parsed.toString()
}

export function isAllowedEmbeddedNavigationUrl(rawUrl: string): boolean {
  if (!rawUrl || rawUrl === 'about:blank') return true
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function mapElectronSameSiteToCdp(
  sameSite: Electron.Cookie['sameSite']
): 'Strict' | 'Lax' | 'None' | undefined {
  if (sameSite === 'strict') return 'Strict'
  if (sameSite === 'lax') return 'Lax'
  if (sameSite === 'no_restriction') return 'None'
  return undefined
}

function mapInputSameSiteToElectron(
  sameSite: string | undefined
): Electron.CookiesSetDetails['sameSite'] | undefined {
  if (!sameSite) return undefined
  const lower = sameSite.trim().toLowerCase()
  if (lower === 'strict') return 'strict'
  if (lower === 'lax') return 'lax'
  if (lower === 'none' || lower === 'no_restriction') return 'no_restriction'
  return undefined
}

function normalizeCookieDomainFilter(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null
  let host = trimmed
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase()
    } catch {
      return null
    }
  } else {
    host = host.split('/')[0].split(':')[0]
  }
  const clean = host.replace(/^\.+/, '')
  return clean || null
}

function domainMatchesCookie(cookieDomain: string, cleanFilter: string): boolean {
  const host = cookieDomain.replace(/^\.+/, '').toLowerCase()
  if (!host) return false
  return host === cleanFilter || host.endsWith(`.${cleanFilter}`) || cleanFilter.endsWith(`.${host}`)
}

function cookieUrlForElectron(cookie: Electron.Cookie): string {
  const scheme = cookie.secure ? 'https' : 'http'
  const host = (cookie.domain || '').replace(/^\.+/, '')
  const path = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/'
  return `${scheme}://${host}${path}`
}

export function toElectronCookieDetails(c: CdpCookieInput): Electron.CookiesSetDetails | null {
  if (!c || typeof c.name !== 'string' || !c.name || typeof c.value !== 'string') {
    return null
  }
  let url = typeof c.url === 'string' && c.url.trim() ? c.url.trim() : ''
  const rawDomain = typeof c.domain === 'string' ? c.domain.trim() : ''
  const cleanHost = rawDomain.replace(/^\.+/, '')
  const path = typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/'
  let secure = Boolean(c.secure)
  if (c.name.startsWith('__Host-') || c.name.startsWith('__Secure-')) {
    secure = true
  }
  if (!url) {
    if (!cleanHost) return null
    url = `${secure ? 'https' : 'http'}://${cleanHost}${path}`
  }

  const details: Electron.CookiesSetDetails = {
    url,
    name: c.name,
    value: c.value,
    path,
    secure,
    httpOnly: Boolean(c.httpOnly)
  }

  // Host-only & __Host- cookies omit explicit `domain` in Chromium.
  if (rawDomain.startsWith('.') && !c.name.startsWith('__Host-')) {
    details.domain = rawDomain
  }
  if (typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0) {
    details.expirationDate = c.expires
  }
  const mappedSameSite = mapInputSameSiteToElectron(c.sameSite)
  if (mappedSameSite) {
    details.sameSite = mappedSameSite
  }
  return details
}

interface ManagedTabEntry {
  tabId: string
  view: WebContentsView
}

export class EmbeddedBrowserManager {
  private readonly browserSession: Electron.Session
  private readonly getHostWindow: () => BrowserWindow | null
  private readonly emitter = new EventEmitter()

  private readonly tabs: ManagedTabEntry[] = []
  private activeTabId: string | null = null
  private nextTabSeq = 1
  private stateEmitTimer: NodeJS.Timeout | null = null
  private disposed = false

  private attachedBounds: EmbeddedBrowserBounds | null = null
  private attachedView: WebContentsView | null = null
  private attachedHostWin: BrowserWindow | null = null

  constructor(opts: {
    browserSession?: Electron.Session
    getHostWindow: () => BrowserWindow | null
  }) {
    this.browserSession =
      opts.browserSession ?? session.fromPartition(EMBEDDED_BROWSER_PARTITION)
    this.getHostWindow = opts.getHostWindow
  }

  createCdpHost(): EmbeddedBrowserCdpHost {
    return {
      listTabs: () => this.tabs.map((entry) => this.toCdpTabHandle(entry)),
      getTab: (tabId: string) => {
        const found = this.tabs.find((t) => t.tabId === tabId)
        return found ? this.toCdpTabHandle(found) : null
      },
      ensureAtLeastOneTab: async () => {
        const entry = this.ensureActiveTabEntry()
        return this.toCdpTabHandle(entry)
      },
      createTab: async (url = 'about:blank') => {
        const entry = this.createTabInternal(url, { activate: true })
        return this.toCdpTabHandle(entry)
      },
      activateTab: (tabId: string) => {
        const exists = this.tabs.some((t) => t.tabId === tabId)
        if (!exists) return false
        this.activeTabId = tabId
        this.syncAttachedView()
        this.emitStateSoon()
        return true
      },
      closeTab: async (tabId: string) => this.closeTabInternal(tabId),
      onTabCreated: (listener: (tabId: string) => void) => {
        this.emitter.on('tab-created', listener)
        return () => this.emitter.off('tab-created', listener)
      },
      onTabClosed: (listener: (tabId: string) => void) => {
        this.emitter.on('tab-closed', listener)
        return () => this.emitter.off('tab-closed', listener)
      },
      getAllCookies: async () => this.getAllCdpCookies(),
      setCookies: async (cookies: CdpCookieInput[]) => this.setCdpCookies(cookies),
      listCookieDomains: async () => this.listCookieDomains(),
      clearCookies: async (domain?: string) => this.clearCookies(domain)
    }
  }

  getState(): EmbeddedBrowserState {
    const projected: EmbeddedBrowserTab[] = this.tabs.map((entry) => {
      const wc = entry.view.webContents
      if (wc.isDestroyed()) {
        return {
          id: entry.tabId,
          title: '',
          url: 'about:blank',
          loading: false,
          canGoBack: false,
          canGoForward: false
        }
      }
      const nav = wc.navigationHistory
      return {
        id: entry.tabId,
        title: wc.getTitle(),
        url: wc.getURL() || 'about:blank',
        loading: wc.isLoading(),
        canGoBack: nav ? nav.canGoBack() : wc.canGoBack(),
        canGoForward: nav ? nav.canGoForward() : wc.canGoForward()
      }
    })
    const active =
      projected.find((t) => t.id === this.activeTabId) ?? projected[0] ?? null
    return {
      tabs: projected,
      activeTabId: active ? active.id : null,
      url: active ? active.url : 'about:blank',
      title: active ? active.title : '',
      loading: active ? active.loading : false,
      canGoBack: active ? active.canGoBack : false,
      canGoForward: active ? active.canGoForward : false
    }
  }

  attach(bounds: EmbeddedBrowserBounds): EmbeddedBrowserState {
    if (this.disposed) return this.getState()
    this.ensureActiveTabEntry()
    this.attachedBounds = { ...bounds }
    this.syncAttachedView()
    return this.getState()
  }

  setBounds(bounds: EmbeddedBrowserBounds): void {
    if (this.disposed) return
    this.attachedBounds = { ...bounds }
    this.syncAttachedView()
  }

  detach(): void {
    this.attachedBounds = null
    this.detachChildViewOnly()
  }

  async navigate(rawUrl: string): Promise<EmbeddedBrowserState> {
    const cleanUrl = normalizeEmbeddedBrowserUrl(rawUrl)
    const entry = this.ensureActiveTabEntry()
    if (!entry.view.webContents.isDestroyed()) {
      void entry.view.webContents.loadURL(cleanUrl).catch((err) => {
        console.warn('[embedded_browser] loadURL failed:', cleanUrl, err)
      })
    }
    this.emitStateSoon()
    return this.getState()
  }

  async newTab(rawUrl = 'about:blank'): Promise<EmbeddedBrowserState> {
    this.createTabInternal(rawUrl, { activate: true })
    return this.getState()
  }

  switchTab(tabId: string): EmbeddedBrowserState {
    if (this.tabs.some((t) => t.tabId === tabId)) {
      this.activeTabId = tabId
      this.syncAttachedView()
      this.emitStateNow()
    }
    return this.getState()
  }

  async closeTab(tabId: string): Promise<EmbeddedBrowserState> {
    await this.closeTabInternal(tabId)
    return this.getState()
  }

  back(): EmbeddedBrowserState {
    const entry = this.getActiveEntry()
    if (entry && !entry.view.webContents.isDestroyed()) {
      const nav = entry.view.webContents.navigationHistory
      if (nav?.canGoBack()) nav.goBack()
      else if (entry.view.webContents.canGoBack()) entry.view.webContents.goBack()
    }
    this.emitStateSoon()
    return this.getState()
  }

  forward(): EmbeddedBrowserState {
    const entry = this.getActiveEntry()
    if (entry && !entry.view.webContents.isDestroyed()) {
      const nav = entry.view.webContents.navigationHistory
      if (nav?.canGoForward()) nav.goForward()
      else if (entry.view.webContents.canGoForward()) entry.view.webContents.goForward()
    }
    this.emitStateSoon()
    return this.getState()
  }

  reload(): EmbeddedBrowserState {
    const entry = this.getActiveEntry()
    if (entry && !entry.view.webContents.isDestroyed()) {
      entry.view.webContents.reload()
    }
    this.emitStateSoon()
    return this.getState()
  }

  openDevTools(): void {
    const entry = this.getActiveEntry()
    if (!entry || entry.view.webContents.isDestroyed()) return
    entry.view.webContents.openDevTools({ mode: 'detach' })
  }

  async resetSession(): Promise<EmbeddedBrowserState> {
    const oldTabs = [...this.tabs]
    this.detachChildViewOnly()
    this.tabs.length = 0
    this.activeTabId = null
    for (const old of oldTabs) {
      this.emitter.emit('tab-closed', old.tabId)
      if (!old.view.webContents.isDestroyed()) {
        old.view.webContents.close({ waitForBeforeUnload: false })
      }
    }
    this.createTabInternal('about:blank', { activate: true })
    if (this.attachedBounds) {
      this.syncAttachedView()
    }
    this.emitStateNow()
    return this.getState()
  }

  async getAllCdpCookies(): Promise<CdpCookieRecord[]> {
    const all = await this.browserSession.cookies.get({})
    return all.map((c) => {
      const rec: CdpCookieRecord = {
        name: c.name,
        value: c.value,
        domain: c.domain || '',
        path: c.path || '/',
        expires: typeof c.expirationDate === 'number' ? c.expirationDate : -1,
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure)
      }
      const ss = mapElectronSameSiteToCdp(c.sameSite)
      if (ss) rec.sameSite = ss
      return rec
    })
  }

  async setCdpCookies(cookies: CdpCookieInput[]): Promise<{ imported: number; skipped: number }> {
    let imported = 0
    let skipped = 0
    for (const raw of cookies) {
      const details = toElectronCookieDetails(raw)
      if (!details) {
        skipped += 1
        continue
      }
      try {
        await this.browserSession.cookies.set(details)
        imported += 1
      } catch {
        skipped += 1
      }
    }
    await this.browserSession.cookies.flushStore()
    return { imported, skipped }
  }

  async listCookieDomains(): Promise<{
    domains: Array<{ domain: string; count: number }>
    total_cookies: number
  }> {
    const all = await this.browserSession.cookies.get({})
    const counts = new Map<string, number>()
    for (const c of all) {
      const dom = (c.domain || '').replace(/^\.+/, '').toLowerCase()
      if (!dom) continue
      counts.set(dom, (counts.get(dom) ?? 0) + 1)
    }
    const domains = [...counts.entries()]
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
      .map(([domain, count]) => ({ domain, count }))
    let total = 0
    for (const c of counts.values()) total += c
    return { domains, total_cookies: total }
  }

  async clearCookies(domain?: string): Promise<{ cleared: number; domain: string | null }> {
    const cleanDomain = typeof domain === 'string' && domain.trim() ? domain.trim() : null
    const all = await this.browserSession.cookies.get({})
    if (!cleanDomain) {
      for (const c of all) {
        try {
          await this.browserSession.cookies.remove(cookieUrlForElectron(c), c.name)
        } catch {
          /* ignore individual cookie remove errors */
        }
      }
      await this.browserSession.cookies.flushStore()
      return { cleared: all.length, domain: null }
    }

    const norm = normalizeCookieDomainFilter(cleanDomain)
    if (!norm) return { cleared: 0, domain: cleanDomain }

    let cleared = 0
    for (const c of all) {
      if (!c.domain || !domainMatchesCookie(c.domain, norm)) continue
      try {
        await this.browserSession.cookies.remove(cookieUrlForElectron(c), c.name)
        cleared += 1
      } catch {
        /* ignore individual failure */
      }
    }
    await this.browserSession.cookies.flushStore()
    return { cleared, domain: cleanDomain }
  }

  dispose(): void {
    this.disposed = true
    if (this.stateEmitTimer) {
      clearTimeout(this.stateEmitTimer)
      this.stateEmitTimer = null
    }
    this.detachChildViewOnly()
    const oldTabs = this.tabs.splice(0, this.tabs.length)
    for (const old of oldTabs) {
      if (!old.view.webContents.isDestroyed()) {
        old.view.webContents.close({ waitForBeforeUnload: false })
      }
    }
  }

  private toCdpTabHandle(entry: ManagedTabEntry): ManagedCdpTabHandle {
    return {
      tabId: entry.tabId,
      getTitle: () => (entry.view.webContents.isDestroyed() ? '' : entry.view.webContents.getTitle()),
      getUrl: () =>
        entry.view.webContents.isDestroyed() ? 'about:blank' : entry.view.webContents.getURL(),
      isDestroyed: () => entry.view.webContents.isDestroyed(),
      getBounds: () => {
        const b = entry.view.getBounds()
        return {
          left: b.x,
          top: b.y,
          width: b.width || DEFAULT_OFFSCREEN_BOUNDS.width,
          height: b.height || DEFAULT_OFFSCREEN_BOUNDS.height
        }
      },
      debugger: entry.view.webContents.debugger
    }
  }

  private getActiveEntry(): ManagedTabEntry | null {
    if (this.activeTabId) {
      const found = this.tabs.find((t) => t.tabId === this.activeTabId)
      if (found) return found
    }
    return this.tabs[0] ?? null
  }

  private ensureActiveTabEntry(): ManagedTabEntry {
    const active = this.getActiveEntry()
    if (active) {
      this.activeTabId = active.tabId
      return active
    }
    return this.createTabInternal('about:blank', { activate: true })
  }

  private createTabInternal(rawUrl: string, opts: { activate: boolean }): ManagedTabEntry {
    const cleanUrl = normalizeEmbeddedBrowserUrl(rawUrl)
    const tabId = `tab-${this.nextTabSeq++}`
    const view = new WebContentsView({
      webPreferences: {
        session: this.browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    })
    view.setBounds({ ...DEFAULT_OFFSCREEN_BOUNDS })

    const entry: ManagedTabEntry = { tabId, view }
    this.tabs.push(entry)
    if (opts.activate || this.activeTabId === null) {
      this.activeTabId = tabId
    }

    this.attachWebContentsHooks(entry)
    void view.webContents.loadURL(cleanUrl).catch((err) => {
      console.warn('[embedded_browser] initial loadURL failed:', cleanUrl, err)
    })

    if (this.attachedBounds && opts.activate) {
      this.syncAttachedView()
    }
    this.emitter.emit('tab-created', tabId)
    this.emitStateSoon()
    return entry
  }

  private async closeTabInternal(tabId: string): Promise<boolean> {
    const idx = this.tabs.findIndex((t) => t.tabId === tabId)
    if (idx < 0) return false
    const [removed] = this.tabs.splice(idx, 1)

    if (this.attachedView === removed.view) {
      this.detachChildViewOnly()
    }
    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)] ?? null
      this.activeTabId = next ? next.tabId : null
    }
    if (this.tabs.length === 0 && !this.disposed) {
      this.createTabInternal('about:blank', { activate: true })
    } else {
      this.syncAttachedView()
    }

    this.emitter.emit('tab-closed', tabId)
    if (!removed.view.webContents.isDestroyed()) {
      removed.view.webContents.close({ waitForBeforeUnload: false })
    }
    this.emitStateNow()
    return true
  }

  private attachWebContentsHooks(entry: ManagedTabEntry): void {
    const wc = entry.view.webContents
    wc.on('will-navigate', (event, url) => {
      if (!isAllowedEmbeddedNavigationUrl(url)) {
        event.preventDefault()
      }
    })
    wc.on('will-redirect', (event, url) => {
      if (!isAllowedEmbeddedNavigationUrl(url)) {
        event.preventDefault()
      }
    })
    wc.setWindowOpenHandler((details) => {
      if (isAllowedEmbeddedNavigationUrl(details.url)) {
        this.createTabInternal(details.url, { activate: true })
      }
      return { action: 'deny' }
    })

    const onChange = (): void => this.emitStateSoon()
    wc.on('did-start-loading', onChange)
    wc.on('did-stop-loading', onChange)
    wc.on('did-navigate', onChange)
    wc.on('did-navigate-in-page', onChange)
    wc.on('page-title-updated', onChange)
    wc.on('did-fail-load', onChange)

    wc.on('context-menu', (_evt, params) => {
      const nav = wc.navigationHistory
      const canGoBack = nav ? nav.canGoBack() : wc.canGoBack()
      const canGoForward = nav ? nav.canGoForward() : wc.canGoForward()
      const template: Electron.MenuItemConstructorOptions[] = [
        { label: 'Back', enabled: canGoBack, click: () => this.back() },
        { label: 'Forward', enabled: canGoForward, click: () => this.forward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
      if (params.linkURL && isAllowedEmbeddedNavigationUrl(params.linkURL)) {
        template.push(
          { type: 'separator' },
          {
            label: 'Open Link in New Tab',
            click: () => this.createTabInternal(params.linkURL, { activate: true })
          },
          {
            label: 'Open Link in System Browser',
            click: () => void shell.openExternal(params.linkURL)
          },
          {
            label: 'Copy Link Address',
            click: () => clipboard.writeText(params.linkURL)
          }
        )
      }
      template.push(
        { type: 'separator' },
        {
          label: 'Inspect Element',
          click: () => wc.inspectElement(params.x, params.y)
        }
      )
      Menu.buildFromTemplate(template).popup()
    })
  }

  private detachChildViewOnly(): void {
    if (this.attachedView && this.attachedHostWin && !this.attachedHostWin.isDestroyed()) {
      try {
        this.attachedHostWin.contentView.removeChildView(this.attachedView)
      } catch {
        /* ignore already detached */
      }
    }
    if (this.attachedView) {
      try {
        this.attachedView.setVisible(true)
        this.attachedView.setBounds({ ...DEFAULT_OFFSCREEN_BOUNDS })
      } catch {
        /* ignore */
      }
    }
    this.attachedView = null
    this.attachedHostWin = null
  }

  private syncAttachedView(): void {
    const bounds = this.attachedBounds
    const hostWin = this.getHostWindow()
    if (!bounds || !hostWin || hostWin.isDestroyed()) {
      this.detachChildViewOnly()
      return
    }
    const active = this.getActiveEntry()
    if (!active || active.view.webContents.isDestroyed()) {
      this.detachChildViewOnly()
      return
    }

    const shouldShow = bounds.visible && bounds.width >= 10 && bounds.height >= 10
    if (!shouldShow) {
      if (this.attachedView && this.attachedHostWin === hostWin) {
        try {
          hostWin.contentView.removeChildView(this.attachedView)
        } catch {
          /* ignore */
        }
        this.attachedView = null
      }
      return
    }

    if (this.attachedHostWin && this.attachedHostWin !== hostWin) {
      this.detachChildViewOnly()
    }
    if (this.attachedView && this.attachedView !== active.view) {
      try {
        hostWin.contentView.removeChildView(this.attachedView)
      } catch {
        /* ignore */
      }
      this.attachedView = null
    }
    if (this.attachedView !== active.view) {
      hostWin.contentView.addChildView(active.view)
      this.attachedView = active.view
      this.attachedHostWin = hostWin
    }

    active.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(10, Math.round(bounds.width)),
      height: Math.max(10, Math.round(bounds.height))
    })
    active.view.setVisible(true)
  }

  private emitStateSoon(): void {
    if (this.disposed || this.stateEmitTimer) return
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = null
      this.emitStateNow()
    }, 32)
  }

  private emitStateNow(): void {
    if (this.disposed) return
    const state = this.getState()
    const hostWin = this.getHostWindow()
    if (hostWin && !hostWin.isDestroyed()) {
      try {
        hostWin.webContents.send(EMBEDDED_BROWSER_IPC.stateChanged, state)
      } catch {
        /* ignore torn-down renderer */
      }
    }
  }
}

export interface EmbeddedBrowserController {
  manager: EmbeddedBrowserManager
  cdpServer: EmbeddedBrowserCdpServer
  getBridgeEnv: () => Record<string, string>
  syncBridgeWithApi: () => Promise<void>
  dispose: () => Promise<void>
}

function validateBoundsPayload(raw: unknown): EmbeddedBrowserBounds | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const x = Number(r.x)
  const y = Number(r.y)
  const width = Number(r.width)
  const height = Number(r.height)
  const visible = Boolean(r.visible)
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null
  return { x, y, width, height, visible }
}

export async function registerEmbeddedBrowser(opts: {
  getHostWindow: () => BrowserWindow | null
  resolveApiPort: () => number
  getLocalToken: () => string
}): Promise<EmbeddedBrowserController> {
  const manager = new EmbeddedBrowserManager({
    getHostWindow: opts.getHostWindow
  })
  const cdpServer = new EmbeddedBrowserCdpServer({
    host: manager.createCdpHost(),
    localToken: opts.getLocalToken()
  })
  await cdpServer.start()

  const registerHandler = (
    channel: string,
    handler: (evt: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
  ): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
  }

  registerHandler(EMBEDDED_BROWSER_IPC.getState, () => manager.getState())
  registerHandler(EMBEDDED_BROWSER_IPC.attach, (_evt, rawBounds) => {
    const bounds = validateBoundsPayload(rawBounds)
    return bounds ? manager.attach(bounds) : manager.getState()
  })
  registerHandler(EMBEDDED_BROWSER_IPC.setBounds, (_evt, rawBounds) => {
    const bounds = validateBoundsPayload(rawBounds)
    if (bounds) manager.setBounds(bounds)
  })
  registerHandler(EMBEDDED_BROWSER_IPC.detach, () => {
    manager.detach()
  })
  registerHandler(EMBEDDED_BROWSER_IPC.navigate, (_evt, rawUrl) =>
    manager.navigate(typeof rawUrl === 'string' ? rawUrl : '')
  )
  registerHandler(EMBEDDED_BROWSER_IPC.newTab, (_evt, rawUrl) =>
    manager.newTab(typeof rawUrl === 'string' ? rawUrl : 'about:blank')
  )
  registerHandler(EMBEDDED_BROWSER_IPC.switchTab, (_evt, tabId) =>
    typeof tabId === 'string' ? manager.switchTab(tabId) : manager.getState()
  )
  registerHandler(EMBEDDED_BROWSER_IPC.closeTab, (_evt, tabId) =>
    typeof tabId === 'string' ? manager.closeTab(tabId) : manager.getState()
  )
  registerHandler(EMBEDDED_BROWSER_IPC.back, () => manager.back())
  registerHandler(EMBEDDED_BROWSER_IPC.forward, () => manager.forward())
  registerHandler(EMBEDDED_BROWSER_IPC.reload, () => manager.reload())
  registerHandler(EMBEDDED_BROWSER_IPC.openDevTools, () => manager.openDevTools())
  registerHandler(EMBEDDED_BROWSER_IPC.resetSession, () => manager.resetSession())

  const postBridgeState = async (active: boolean): Promise<void> => {
    const apiPort = opts.resolveApiPort()
    const token = opts.getLocalToken()
    const payload = active
      ? {
          active: true,
          cdp_ws_url: cdpServer.cdpWsUrl,
          control_url: cdpServer.controlUrl
        }
      : { active: false }
    try {
      await fetch(`http://127.0.0.1:${apiPort}/api/connector/browser_use/desktop-bridge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MailAgent-Local-Token': token
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2500)
      })
    } catch {
      /* serve-api may not be up yet; retried on onApiReady */
    }
  }

  return {
    manager,
    cdpServer,
    getBridgeEnv: () => ({
      MAILAGENT_DESKTOP_BROWSER_CDP_WS_URL: cdpServer.cdpWsUrl,
      MAILAGENT_DESKTOP_BROWSER_CONTROL_URL: cdpServer.controlUrl
    }),
    syncBridgeWithApi: () => postBridgeState(true),
    dispose: async () => {
      for (const channel of Object.values(EMBEDDED_BROWSER_IPC)) {
        if (channel !== EMBEDDED_BROWSER_IPC.stateChanged) {
          ipcMain.removeHandler(channel)
        }
      }
      await postBridgeState(false)
      await cdpServer.stop()
      manager.dispose()
    }
  }
}
