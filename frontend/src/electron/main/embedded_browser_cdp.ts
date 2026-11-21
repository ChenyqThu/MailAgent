// Target-isolated loopback CDP & cookie control bridge for MailAgent's native
// Electron WebContentsView browser.
//
// Security guarantees:
//   - NEVER uses `--remote-debugging-port` (MailAgent's own UI BrowserWindow,
//     tray, and overlays are structurally invisible and unreachable here).
//   - Binds strictly to `127.0.0.1:<ephemeralPort>`.
//   - Rejects ANY request carrying an `Origin` header (403, blocks loopback CSRF).
//   - Validates loopback `Host` header against the bound port (403).
//   - HTTP control & discovery routes require constant-time `X-MailAgent-Local-Token` (401).
//   - CDP WebSocket upgrades require the per-session random `/cdp/<32-hex>` path (403).

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import {
  isAllowedLoopbackHost,
  upgradeLoopbackWebSocket,
  type LoopbackWebSocket
} from './loopback_ws'

const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024
const FALLBACK_BROWSER_CONTEXT_ID = 'mailagent-browser'

export interface DebuggerLike {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, commandParams?: unknown, sessionId?: string): Promise<unknown>
  on(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId: string) => void
  ): unknown
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  removeListener?(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId: string) => void
  ): unknown
  removeListener?(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
}

export interface CdpTargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  attached: boolean
  canAccessOpener: boolean
  browserContextId: string
  openerId?: string
}

export interface CdpCookieRecord {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export interface CdpCookieInput {
  name: string
  value: string
  url?: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string
  expires?: number
}

export interface ManagedCdpTabHandle {
  tabId: string
  getTitle(): string
  getUrl(): string
  isDestroyed(): boolean
  getBounds(): { left: number; top: number; width: number; height: number }
  debugger: DebuggerLike
}

export interface EmbeddedBrowserCdpHost {
  listTabs(): ManagedCdpTabHandle[]
  getTab(tabId: string): ManagedCdpTabHandle | null
  ensureAtLeastOneTab(): Promise<ManagedCdpTabHandle>
  createTab(url?: string): Promise<ManagedCdpTabHandle>
  activateTab(tabId: string): boolean
  closeTab(tabId: string): Promise<boolean>
  onTabCreated(listener: (tabId: string) => void): () => void
  onTabClosed(listener: (tabId: string) => void): () => void
  getAllCookies(): Promise<CdpCookieRecord[]>
  setCookies(cookies: CdpCookieInput[]): Promise<{ imported: number; skipped: number }>
  listCookieDomains(): Promise<{
    domains: Array<{ domain: string; count: number }>
    total_cookies: number
  }>
  clearCookies(domain?: string): Promise<{ cleared: number; domain: string | null }>
}

interface AttachedTabSession {
  tabId: string
  targetId: string
  sessionId: string
  targetInfo: CdpTargetInfo
  childSessions: Set<string>
  dbg: DebuggerLike
  onMessage: (event: unknown, method: string, params: unknown, sessionId: string) => void
  onDetach: (event: unknown, reason: string) => void
}

function safeEqualUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function normalizeTargetInfo(
  raw: Record<string, unknown> | undefined,
  tab: ManagedCdpTabHandle,
  attached: boolean
): CdpTargetInfo {
  const targetId =
    typeof raw?.targetId === 'string' && raw.targetId.trim()
      ? raw.targetId
      : `mailagent-tab-${tab.tabId}`
  const browserContextId =
    typeof raw?.browserContextId === 'string' && raw.browserContextId.trim()
      ? raw.browserContextId
      : FALLBACK_BROWSER_CONTEXT_ID
  const title =
    typeof raw?.title === 'string' && raw.title.length > 0 ? raw.title : tab.getTitle()
  const url =
    typeof raw?.url === 'string' && raw.url.length > 0 ? raw.url : tab.getUrl() || 'about:blank'
  const out: CdpTargetInfo = {
    targetId,
    type: 'page',
    title,
    url,
    attached,
    canAccessOpener: Boolean(raw?.canAccessOpener),
    browserContextId
  }
  if (typeof raw?.openerId === 'string' && raw.openerId) {
    out.openerId = raw.openerId
  }
  return out
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_HTTP_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>)
          return
        }
        reject(new Error('JSON body must be an object'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function rejectUpgrade(socket: Duplex, statusLine: string): void {
  try {
    socket.write(`${statusLine}\r\nConnection: close\r\n\r\n`)
  } catch {
    /* ignore broken socket */
  }
  socket.destroy()
}

export class EmbeddedBrowserCdpServer {
  private readonly host: EmbeddedBrowserCdpHost
  private readonly localToken: string
  private readonly cdpToken: string
  private readonly chromeVersion: string

  private server: Server | null = null
  private port = 0
  private activeClient: LoopbackWebSocket | null = null
  private autoAttach = false
  private discoverTargets = false
  private nextSessionSeq = 1
  private readonly tabSessions = new Map<string, AttachedTabSession>()
  private readonly attachingTabs = new Map<string, Promise<AttachedTabSession>>()
  private unsubCreate: (() => void) | null = null
  private unsubClose: (() => void) | null = null

  constructor(opts: {
    host: EmbeddedBrowserCdpHost
    localToken: string
    cdpToken?: string
    chromeVersion?: string
  }) {
    this.host = opts.host
    this.localToken = opts.localToken
    this.cdpToken = opts.cdpToken ?? randomBytes(16).toString('hex')
    this.chromeVersion = opts.chromeVersion ?? (process.versions.chrome || '134.0.0.0')
  }

  get boundPort(): number {
    return this.port
  }

  get controlUrl(): string {
    if (this.port <= 0) throw new Error('EmbeddedBrowserCdpServer not started')
    return `http://127.0.0.1:${this.port}`
  }

  get cdpWsUrl(): string {
    if (this.port <= 0) throw new Error('EmbeddedBrowserCdpServer not started')
    return `ws://127.0.0.1:${this.port}/cdp/${this.cdpToken}`
  }

  async start(): Promise<{ port: number; controlUrl: string; cdpWsUrl: string }> {
    if (this.server && this.port > 0) {
      return { port: this.port, controlUrl: this.controlUrl, cdpWsUrl: this.cdpWsUrl }
    }

    this.unsubCreate = this.host.onTabCreated((tabId) => {
      if (!this.activeClient || !this.autoAttach) return
      void this.attachTab(tabId).catch(() => {
        /* tab may already be closing */
      })
    })
    this.unsubClose = this.host.onTabClosed((tabId) => {
      this.detachTabSession(tabId)
    })

    const server = createServer((req, res) => {
      void this.handleHttp(req, res)
    })
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head)
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    const addr = server.address()
    if (!addr || typeof addr === 'string') {
      server.close()
      throw new Error('Failed to bind loopback CDP server port')
    }
    this.server = server
    this.port = addr.port
    return { port: this.port, controlUrl: this.controlUrl, cdpWsUrl: this.cdpWsUrl }
  }

  async stop(): Promise<void> {
    this.unsubCreate?.()
    this.unsubClose?.()
    this.unsubCreate = null
    this.unsubClose = null
    this.cleanupClientState()
    if (this.activeClient) {
      this.activeClient.close(1001, 'Server shutting down')
      this.activeClient = null
    }
    const srv = this.server
    this.server = null
    this.port = 0
    if (srv) {
      srv.closeAllConnections?.()
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
  }

  private isLocalHttpAuthorized(req: IncomingMessage): boolean {
    const raw = req.headers['x-mailagent-local-token']
    if (typeof raw !== 'string' || !raw) return false
    return safeEqualUtf8(raw, this.localToken)
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Block browser-initiated requests / DNS rebinding unconditionally.
    if (req.headers.origin !== undefined) {
      writeJson(res, 403, { error: 'Forbidden origin' })
      return
    }
    if (!isAllowedLoopbackHost(req.headers.host, this.port)) {
      writeJson(res, 403, { error: 'Forbidden host' })
      return
    }
    if (!this.isLocalHttpAuthorized(req)) {
      writeJson(res, 401, { error: 'Unauthorized' })
      return
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()

    try {
      if (method === 'GET' && pathname === '/health') {
        writeJson(res, 200, {
          ok: true,
          engine: 'electron_webcontents_view',
          tabCount: this.host.listTabs().length
        })
        return
      }

      if (method === 'GET' && (pathname === '/json/version' || pathname === '/json/version/')) {
        writeJson(res, 200, {
          Browser: `Chrome/${this.chromeVersion}`,
          'Protocol-Version': '1.3',
          'User-Agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.chromeVersion} Safari/537.36`,
          'V8-Version': process.versions.v8 || '',
          'WebKit-Version': '',
          webSocketDebuggerUrl: this.cdpWsUrl
        })
        return
      }

      if (
        method === 'GET' &&
        (pathname === '/json/list' ||
          pathname === '/json/list/' ||
          pathname === '/json' ||
          pathname === '/json/')
      ) {
        const tabs = this.host.listTabs()
        const payload = tabs.map((tab) => {
          const attached = this.tabSessions.get(tab.tabId)
          const targetId = attached?.targetId ?? `mailagent-tab-${tab.tabId}`
          return {
            description: '',
            id: targetId,
            title: tab.getTitle(),
            type: 'page',
            url: tab.getUrl() || 'about:blank',
            webSocketDebuggerUrl: this.cdpWsUrl
          }
        })
        writeJson(res, 200, payload)
        return
      }

      if (method === 'GET' && pathname === '/internal/cookies/domains') {
        const result = await this.host.listCookieDomains()
        writeJson(res, 200, result)
        return
      }

      if (method === 'POST' && pathname === '/internal/cookies/set') {
        const body = await readJsonBody(req)
        const rawCookies = body.cookies
        if (!Array.isArray(rawCookies)) {
          writeJson(res, 400, { error: 'cookies must be an array' })
          return
        }
        const result = await this.host.setCookies(rawCookies as CdpCookieInput[])
        writeJson(res, 200, result)
        return
      }

      if (method === 'POST' && pathname === '/internal/cookies/clear') {
        const body = await readJsonBody(req)
        const domain = typeof body.domain === 'string' && body.domain.trim() ? body.domain.trim() : undefined
        const result = await this.host.clearCookies(domain)
        writeJson(res, 200, result)
        return
      }

      writeJson(res, 404, { error: 'Not found' })
    } catch (err) {
      writeJson(res, 500, {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (req.headers.origin !== undefined) {
      rejectUpgrade(socket, 'HTTP/1.1 403 Forbidden')
      return
    }
    if (!isAllowedLoopbackHost(req.headers.host, this.port)) {
      rejectUpgrade(socket, 'HTTP/1.1 403 Forbidden')
      return
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const expectedPath = `/cdp/${this.cdpToken}`
    if (!safeEqualUtf8(url.pathname, expectedPath)) {
      rejectUpgrade(socket, 'HTTP/1.1 403 Forbidden')
      return
    }

    const ws = upgradeLoopbackWebSocket(req, socket, head)
    if (!ws) return

    if (this.activeClient && this.activeClient !== ws) {
      const prev = this.activeClient
      this.cleanupClientState()
      this.activeClient = null
      prev.close(1000, 'Replaced by new CDP client')
    }

    this.activeClient = ws
    ws.on('message', (raw: string) => {
      void this.handleWsMessage(ws, raw)
    })
    ws.on('close', () => {
      if (this.activeClient === ws) {
        this.activeClient = null
        this.cleanupClientState()
      }
    })
  }

  private emitToClient(message: Record<string, unknown>): void {
    this.activeClient?.send(JSON.stringify(message))
  }

  private async handleWsMessage(ws: LoopbackWebSocket, raw: string): Promise<void> {
    let msg: {
      id?: number
      method?: string
      params?: Record<string, unknown>
      sessionId?: string
    }
    try {
      msg = JSON.parse(raw) as typeof msg
    } catch {
      return
    }
    if (typeof msg?.id !== 'number' || typeof msg?.method !== 'string') {
      return
    }
    const { id, method, params, sessionId } = msg
    try {
      const result = await this.dispatchCdpCommand(method, params ?? {}, sessionId)
      if (this.activeClient === ws && ws.isOpen) {
        ws.send(JSON.stringify({ id, sessionId, result: result ?? {} }))
      }
    } catch (err) {
      if (this.activeClient === ws && ws.isOpen) {
        ws.send(
          JSON.stringify({
            id,
            sessionId,
            error: {
              code: -32000,
              message: err instanceof Error ? err.message : String(err)
            }
          })
        )
      }
    }
  }

  private async dispatchCdpCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> {
    if (!sessionId) {
      return this.handleRootCommand(method, params)
    }

    const tabSession = this.findTabSessionBySessionId(sessionId)
    if (!tabSession) {
      throw new Error(`No managed target found for sessionId: ${sessionId}`)
    }

    if (method === 'Browser.getWindowForTarget') {
      const tab = this.host.getTab(tabSession.tabId)
      const bounds = tab?.getBounds() ?? { left: 0, top: 0, width: 1280, height: 900 }
      return { windowId: 1, bounds: { ...bounds, windowState: 'normal' } }
    }

    if (method === 'Target.getTargetInfo') {
      const requestedId = typeof params.targetId === 'string' ? params.targetId : undefined
      if (requestedId && requestedId !== tabSession.targetId) {
        const other = this.findTabSessionByTargetId(requestedId)
        if (!other) throw new Error(`Target not found: ${requestedId}`)
        return { targetInfo: await this.refreshTargetInfo(other) }
      }
      return { targetInfo: await this.refreshTargetInfo(tabSession) }
    }

    if (method === 'Page.bringToFront') {
      this.host.activateTab(tabSession.tabId)
    }

    const forwardChildId = tabSession.sessionId === sessionId ? undefined : sessionId
    return tabSession.dbg.sendCommand(method, params, forwardChildId)
  }

  private async handleRootCommand(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    switch (method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: `Chrome/${this.chromeVersion}`,
          revision: '',
          userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.chromeVersion} Safari/537.36`,
          jsVersion: ''
        }

      case 'Browser.setDownloadBehavior':
      case 'Browser.grantPermissions':
      case 'Browser.resetPermissions':
      case 'Browser.cancelDownload':
      case 'Target.disposeBrowserContext':
        return {}

      case 'Browser.getWindowForTarget':
      case 'Browser.getWindowBounds': {
        const firstTab = this.host.listTabs()[0]
        const bounds = firstTab?.getBounds() ?? { left: 0, top: 0, width: 1280, height: 900 }
        return { windowId: 1, bounds: { ...bounds, windowState: 'normal' } }
      }

      case 'Target.setAutoAttach': {
        this.autoAttach = Boolean(params.autoAttach)
        if (this.autoAttach) {
          await this.host.ensureAtLeastOneTab()
          const tabs = this.host.listTabs()
          await Promise.all(tabs.map((t) => this.attachTab(t.tabId)))
        }
        return {}
      }

      case 'Target.setDiscoverTargets': {
        this.discoverTargets = Boolean(params.discover)
        if (this.discoverTargets) {
          for (const tab of this.host.listTabs()) {
            const attached = this.tabSessions.get(tab.tabId)
            const targetInfo = attached
              ? attached.targetInfo
              : normalizeTargetInfo(undefined, tab, false)
            this.emitToClient({
              method: 'Target.targetCreated',
              params: { targetInfo }
            })
          }
        }
        return {}
      }

      case 'Target.getTargets': {
        const targetInfos = await Promise.all(
          this.host.listTabs().map(async (tab) => {
            const existing = this.tabSessions.get(tab.tabId)
            if (existing) return this.refreshTargetInfo(existing)
            return normalizeTargetInfo(undefined, tab, false)
          })
        )
        return { targetInfos }
      }

      case 'Target.getTargetInfo': {
        const reqTargetId = typeof params.targetId === 'string' ? params.targetId : undefined
        if (reqTargetId) {
          const existing = this.findTabSessionByTargetId(reqTargetId)
          if (existing) {
            return { targetInfo: await this.refreshTargetInfo(existing) }
          }
          const matchingTab = this.host
            .listTabs()
            .find((t) => `mailagent-tab-${t.tabId}` === reqTargetId)
          if (!matchingTab) {
            throw new Error(`Target not found: ${reqTargetId}`)
          }
          return { targetInfo: normalizeTargetInfo(undefined, matchingTab, false) }
        }
        return {
          targetInfo: {
            targetId: 'browser',
            type: 'browser',
            title: 'MailAgent Browser',
            url: '',
            attached: true,
            canAccessOpener: false,
            browserContextId: FALLBACK_BROWSER_CONTEXT_ID
          }
        }
      }

      case 'Target.createTarget': {
        const url = typeof params.url === 'string' ? params.url : 'about:blank'
        const created = await this.host.createTab(url)
        const tabSession = await this.attachTab(created.tabId)
        return { targetId: tabSession.targetId }
      }

      case 'Target.activateTarget': {
        const targetId = typeof params.targetId === 'string' ? params.targetId : ''
        const tab = this.resolveTabByTargetId(targetId)
        if (!tab) throw new Error(`Target not found: ${targetId}`)
        this.host.activateTab(tab.tabId)
        return {}
      }

      case 'Target.closeTarget': {
        const targetId = typeof params.targetId === 'string' ? params.targetId : ''
        const tab = this.resolveTabByTargetId(targetId)
        if (!tab) return { success: false }
        this.detachTabSession(tab.tabId)
        const success = await this.host.closeTab(tab.tabId)
        return { success }
      }

      case 'Target.attachToTarget': {
        const targetId = typeof params.targetId === 'string' ? params.targetId : ''
        const tab = this.resolveTabByTargetId(targetId)
        if (!tab) throw new Error(`Target not found: ${targetId}`)
        const tabSession = await this.attachTab(tab.tabId)
        return { sessionId: tabSession.sessionId }
      }

      case 'Target.detachFromTarget': {
        const sid = typeof params.sessionId === 'string' ? params.sessionId : ''
        const tabSession = sid ? this.findTabSessionBySessionId(sid) : undefined
        if (tabSession) {
          this.detachTabSession(tabSession.tabId)
        }
        return {}
      }

      case 'Storage.getCookies': {
        const cookies = await this.host.getAllCookies()
        return { cookies }
      }

      case 'Storage.setCookies': {
        const rawCookies = Array.isArray(params.cookies) ? (params.cookies as CdpCookieInput[]) : []
        await this.host.setCookies(rawCookies)
        return {}
      }

      case 'Storage.clearCookies': {
        await this.host.clearCookies()
        return {}
      }

      default:
        throw new Error(`Unsupported root CDP command: ${method}`)
    }
  }

  private resolveTabByTargetId(targetId: string): ManagedCdpTabHandle | null {
    if (!targetId) return null
    const session = this.findTabSessionByTargetId(targetId)
    if (session) return this.host.getTab(session.tabId)
    return (
      this.host.listTabs().find((t) => `mailagent-tab-${t.tabId}` === targetId) ?? null
    )
  }

  private findTabSessionByTargetId(targetId: string): AttachedTabSession | undefined {
    for (const s of this.tabSessions.values()) {
      if (s.targetId === targetId) return s
    }
    return undefined
  }

  private findTabSessionBySessionId(sessionId: string): AttachedTabSession | undefined {
    for (const s of this.tabSessions.values()) {
      if (s.sessionId === sessionId || s.childSessions.has(sessionId)) return s
    }
    return undefined
  }

  private async refreshTargetInfo(tabSession: AttachedTabSession): Promise<CdpTargetInfo> {
    const tab = this.host.getTab(tabSession.tabId)
    if (!tab || tab.isDestroyed()) return tabSession.targetInfo
    try {
      const infoRes = (await tabSession.dbg.sendCommand('Target.getTargetInfo')) as
        | { targetInfo?: Record<string, unknown> }
        | undefined
      const updated = normalizeTargetInfo(infoRes?.targetInfo, tab, true)
      tabSession.targetInfo = updated
      return updated
    } catch {
      tabSession.targetInfo = {
        ...tabSession.targetInfo,
        title: tab.getTitle(),
        url: tab.getUrl() || 'about:blank'
      }
      return tabSession.targetInfo
    }
  }

  private async attachTab(tabId: string): Promise<AttachedTabSession> {
    const existing = this.tabSessions.get(tabId)
    if (existing) return existing

    const inflight = this.attachingTabs.get(tabId)
    if (inflight) return inflight

    const task = (async (): Promise<AttachedTabSession> => {
      const tab = this.host.getTab(tabId)
      if (!tab || tab.isDestroyed()) {
        throw new Error(`Managed tab unavailable: ${tabId}`)
      }
      const dbg = tab.debugger
      if (!dbg.isAttached()) {
        dbg.attach('1.3')
      }

      let rawTargetInfo: Record<string, unknown> | undefined
      try {
        const res = (await dbg.sendCommand('Target.getTargetInfo')) as
          | { targetInfo?: Record<string, unknown> }
          | undefined
        rawTargetInfo = res?.targetInfo
      } catch {
        rawTargetInfo = undefined
      }

      const targetInfo = normalizeTargetInfo(rawTargetInfo, tab, true)
      const sessionId = `pw-tab-${this.nextSessionSeq++}`
      const childSessions = new Set<string>()

      const onMessage = (
        _event: unknown,
        cdpMethod: string,
        cdpParams: unknown,
        cdpSessionId: string
      ): void => {
        if (!this.tabSessions.has(tabId)) return
        if (cdpMethod === 'Target.attachedToTarget') {
          const childId = (cdpParams as { sessionId?: unknown } | undefined)?.sessionId
          if (typeof childId === 'string' && childId) {
            childSessions.add(childId)
          }
        } else if (cdpMethod === 'Target.detachedFromTarget') {
          const childId = (cdpParams as { sessionId?: unknown } | undefined)?.sessionId
          if (typeof childId === 'string' && childId) {
            childSessions.delete(childId)
          }
        }
        this.emitToClient({
          sessionId: cdpSessionId || sessionId,
          method: cdpMethod,
          params: cdpParams
        })
      }

      const onDetach = (): void => {
        this.detachTabSession(tabId, { skipDebuggerDetach: true })
      }

      dbg.on('message', onMessage)
      dbg.on('detach', onDetach)

      const attachedSession: AttachedTabSession = {
        tabId,
        targetId: targetInfo.targetId,
        sessionId,
        targetInfo,
        childSessions,
        dbg,
        onMessage,
        onDetach
      }
      this.tabSessions.set(tabId, attachedSession)

      this.emitToClient({
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo,
          waitingForDebugger: false
        }
      })

      return attachedSession
    })()

    this.attachingTabs.set(tabId, task)
    try {
      return await task
    } finally {
      if (this.attachingTabs.get(tabId) === task) {
        this.attachingTabs.delete(tabId)
      }
    }
  }

  private detachTabSession(
    tabId: string,
    opts: { skipDebuggerDetach?: boolean } = {}
  ): void {
    const existing = this.tabSessions.get(tabId)
    if (!existing) return
    this.tabSessions.delete(tabId)
    existing.dbg.removeListener?.('message', existing.onMessage)
    existing.dbg.removeListener?.('detach', existing.onDetach)
    if (!opts.skipDebuggerDetach) {
      try {
        if (existing.dbg.isAttached()) existing.dbg.detach()
      } catch {
        /* ignore detach failure on closing webContents */
      }
    }
    this.emitToClient({
      method: 'Target.detachedFromTarget',
      params: {
        sessionId: existing.sessionId,
        targetId: existing.targetId
      }
    })
  }

  private cleanupClientState(): void {
    this.autoAttach = false
    this.discoverTargets = false
    for (const tabId of [...this.tabSessions.keys()]) {
      this.detachTabSession(tabId)
    }
    this.tabSessions.clear()
  }
}
