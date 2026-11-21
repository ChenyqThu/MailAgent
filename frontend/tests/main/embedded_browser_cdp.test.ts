// @vitest-environment node

import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'

import {
  EmbeddedBrowserCdpServer,
  type CdpCookieInput,
  type DebuggerLike,
  type EmbeddedBrowserCdpHost,
  type ManagedCdpTabHandle
} from '../../src/electron/main/embedded_browser_cdp'

class FakeDebugger implements DebuggerLike {
  attached = false
  sentCommands: Array<{ method: string; params: unknown; sessionId?: string }> = []
  detachCalls = 0
  private readonly targetId: string
  private readonly title: () => string
  private readonly url: () => string
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>()

  constructor(targetId: string, title: () => string, url: () => string) {
    this.targetId = targetId
    this.title = title
    this.url = url
  }

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  detach(): void {
    this.attached = false
    this.detachCalls += 1
  }

  async sendCommand(method: string, commandParams?: unknown, sessionId?: string): Promise<unknown> {
    this.sentCommands.push({ method, params: commandParams, sessionId })
    if (method === 'Target.getTargetInfo') {
      return {
        targetInfo: {
          targetId: this.targetId,
          type: 'page',
          title: this.title(),
          url: this.url(),
          browserContextId: 'ctx-isolated',
          canAccessOpener: false
        }
      }
    }
    return { ok: true, method }
  }

  on(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId: string) => void
  ): this
  on(event: 'detach', listener: (event: unknown, reason: string) => void): this
  on(event: string, listener: (...args: never[]) => void): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  removeListener(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId: string) => void
  ): this
  removeListener(event: 'detach', listener: (event: unknown, reason: string) => void): this
  removeListener(event: string, listener: (...args: never[]) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emitEvent(method: string, params: unknown, sessionId = ''): void {
    for (const fn of this.listeners.get('message') ?? []) {
      ;(fn as (event: unknown, method: string, params: unknown, sessionId: string) => void)(
        {},
        method,
        params,
        sessionId
      )
    }
  }
}

class FakeHost implements EmbeddedBrowserCdpHost {
  tabs: Array<{
    tabId: string
    targetId: string
    title: string
    url: string
    dbg: FakeDebugger
  }> = []
  activatedIds: string[] = []
  cookies: Array<{
    name: string
    value: string
    domain: string
    path: string
    expires: number
    httpOnly: boolean
    secure: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
  }> = []
  private readonly createListeners = new Set<(tabId: string) => void>()
  private readonly closeListeners = new Set<(tabId: string) => void>()
  private seq = 1

  constructor(initialTabs: Array<{ title: string; url: string }> = []) {
    for (const t of initialTabs) this.addFakeTab(t.title, t.url)
  }

  addFakeTab(title: string, url: string) {
    const tabId = `tab-${this.seq}`
    const targetId = `CR-TARGET-${this.seq++}`
    const rec = {
      tabId,
      targetId,
      title,
      url,
      dbg: undefined as unknown as FakeDebugger
    }
    rec.dbg = new FakeDebugger(
      targetId,
      () => rec.title,
      () => rec.url
    )
    this.tabs.push(rec)
    for (const fn of this.createListeners) fn(tabId)
    return rec
  }

  private toHandle(rec: (typeof this.tabs)[number]): ManagedCdpTabHandle {
    return {
      tabId: rec.tabId,
      getTitle: () => rec.title,
      getUrl: () => rec.url,
      isDestroyed: () => false,
      getBounds: () => ({ left: 10, top: 20, width: 800, height: 600 }),
      debugger: rec.dbg
    }
  }

  listTabs(): ManagedCdpTabHandle[] {
    return this.tabs.map((t) => this.toHandle(t))
  }

  getTab(tabId: string): ManagedCdpTabHandle | null {
    const found = this.tabs.find((t) => t.tabId === tabId)
    return found ? this.toHandle(found) : null
  }

  async ensureAtLeastOneTab(): Promise<ManagedCdpTabHandle> {
    if (this.tabs.length === 0) this.addFakeTab('', 'about:blank')
    return this.toHandle(this.tabs[0])
  }

  async createTab(url = 'about:blank'): Promise<ManagedCdpTabHandle> {
    const rec = this.addFakeTab('', url)
    return this.toHandle(rec)
  }

  activateTab(tabId: string): boolean {
    if (!this.tabs.some((t) => t.tabId === tabId)) return false
    this.activatedIds.push(tabId)
    return true
  }

  async closeTab(tabId: string): Promise<boolean> {
    const idx = this.tabs.findIndex((t) => t.tabId === tabId)
    if (idx < 0) return false
    this.tabs.splice(idx, 1)
    for (const fn of this.closeListeners) fn(tabId)
    return true
  }

  onTabCreated(listener: (tabId: string) => void): () => void {
    this.createListeners.add(listener)
    return () => this.createListeners.delete(listener)
  }

  onTabClosed(listener: (tabId: string) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async getAllCookies() {
    return this.cookies
  }

  async setCookies(input: CdpCookieInput[]) {
    for (const c of input) {
      this.cookies.push({
        name: c.name,
        value: c.value,
        domain: c.domain || 'example.com',
        path: c.path || '/',
        expires: c.expires ?? -1,
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure)
      })
    }
    return { imported: input.length, skipped: 0 }
  }

  async listCookieDomains() {
    const counts = new Map<string, number>()
    for (const c of this.cookies) {
      const dom = c.domain.replace(/^\.+/, '')
      counts.set(dom, (counts.get(dom) ?? 0) + 1)
    }
    return {
      domains: [...counts.entries()].map(([domain, count]) => ({ domain, count })),
      total_cookies: this.cookies.length
    }
  }

  async clearCookies(domain?: string) {
    if (!domain) {
      const n = this.cookies.length
      this.cookies.length = 0
      return { cleared: n, domain: null }
    }
    const before = this.cookies.length
    this.cookies = this.cookies.filter((c) => !c.domain.includes(domain))
    return { cleared: before - this.cookies.length, domain }
  }
}

const servers: EmbeddedBrowserCdpServer[] = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.stop()
  }
})

function sendRawUpgrade(opts: {
  port: number
  path: string
  headers?: Record<string, string>
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: opts.port,
      path: opts.path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        ...(opts.headers ?? {})
      }
    })
    req.on('response', (res) => {
      resolve(res.statusCode ?? 0)
      res.resume()
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      resolve(101)
    })
    req.on('error', reject)
    req.end()
  })
}

class CdpTestClient {
  private readonly ws: WebSocket
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  readonly events: Array<{ sessionId?: string; method: string; params: unknown }> = []

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (evt) => {
      const data = JSON.parse(String(evt.data)) as {
        id?: number
        sessionId?: string
        method?: string
        params?: unknown
        result?: unknown
        error?: { message?: string }
      }
      if (typeof data.id === 'number') {
        const entry = this.pending.get(data.id)
        if (!entry) return
        this.pending.delete(data.id)
        if (data.error) entry.reject(new Error(data.error.message || 'CDP error'))
        else entry.resolve(data.result)
        return
      }
      if (data.method) {
        this.events.push({ sessionId: data.sessionId, method: data.method, params: data.params })
      }
    })
  }

  static async connect(url: string): Promise<CdpTestClient> {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('WS connect failed')), { once: true })
    })
    return new CdpTestClient(ws)
  }

  call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject
      })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close(): void {
    this.ws.close()
  }
}

describe('EmbeddedBrowserCdpServer', () => {
  test('enforces loopback CSRF, Host, local token auth, and target isolation', async () => {
    const host = new FakeHost([{ title: 'Work Portal', url: 'https://oa.corp/home' }])
    const srv = new EmbeddedBrowserCdpServer({
      host,
      localToken: 'secret-local-token',
      cdpToken: 'secret-cdp-path',
      chromeVersion: '142.0.0.0'
    })
    servers.push(srv)
    const { port, controlUrl, cdpWsUrl } = await srv.start()

    // 1. Missing token -> 401
    const unauth = await fetch(`${controlUrl}/json/list`)
    expect(unauth.status).toBe(401)

    // 2. Origin header present -> 403 (loopback CSRF block even with token!)
    const originRes = await fetch(`${controlUrl}/json/list`, {
      headers: {
        Origin: 'https://evil.example',
        'X-MailAgent-Local-Token': 'secret-local-token'
      }
    })
    expect(originRes.status).toBe(403)

    // 3. WS upgrade with Origin -> 403; wrong CDP secret path -> 403
    expect(
      await sendRawUpgrade({
        port,
        path: '/cdp/secret-cdp-path',
        headers: { Origin: 'https://evil.example' }
      })
    ).toBe(403)
    expect(await sendRawUpgrade({ port, path: '/cdp/wrong-token' })).toBe(403)

    // 4. Authorized HTTP discovery lists ONLY managed tabs (never MailAgent UI targets)
    const listRes = await fetch(`${controlUrl}/json/list`, {
      headers: { 'X-MailAgent-Local-Token': 'secret-local-token' }
    })
    expect(listRes.status).toBe(200)
    const targets = (await listRes.json()) as Array<{ id: string; url: string; type: string }>
    expect(targets).toEqual([
      {
        description: '',
        id: 'mailagent-tab-tab-1',
        title: 'Work Portal',
        type: 'page',
        url: 'https://oa.corp/home',
        webSocketDebuggerUrl: cdpWsUrl
      }
    ])

    // 5. Internal cookie HTTP routes never return values in /domains
    await fetch(`${controlUrl}/internal/cookies/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MailAgent-Local-Token': 'secret-local-token'
      },
      body: JSON.stringify({
        cookies: [{ name: 'sid', value: 'TOPSECRET', domain: '.oa.corp', path: '/' }]
      })
    })
    const domRes = await fetch(`${controlUrl}/internal/cookies/domains`, {
      headers: { 'X-MailAgent-Local-Token': 'secret-local-token' }
    })
    const domJson = (await domRes.json()) as {
      domains: Array<{ domain: string; count: number }>
      total_cookies: number
    }
    expect(domJson).toEqual({
      domains: [{ domain: 'oa.corp', count: 1 }],
      total_cookies: 1
    })
    expect(JSON.stringify(domJson)).not.toContain('TOPSECRET')
  })

  test('executes Playwright CDP handshake, target creation/closing, command routing, and clean detach', async () => {
    const host = new FakeHost([{ title: 'Inbox Portal', url: 'https://mail.corp' }])
    const srv = new EmbeddedBrowserCdpServer({
      host,
      localToken: 'tok',
      cdpToken: 'cdp-tok',
      chromeVersion: '142.0.1.2'
    })
    servers.push(srv)
    const { cdpWsUrl } = await srv.start()

    const client = await CdpTestClient.connect(cdpWsUrl)

    const ver = await client.call<{ product: string; userAgent: string }>('Browser.getVersion')
    expect(ver.product).toBe('Chrome/142.0.1.2')
    expect(ver.userAgent).not.toContain('Headless')

    await client.call('Target.setAutoAttach', { autoAttach: true, flatten: true })
    const attachEvt = client.events.find((e) => e.method === 'Target.attachedToTarget')
    expect(attachEvt).toBeTruthy()
    const attachedPayload = attachEvt!.params as {
      sessionId: string
      targetInfo: { targetId: string; type: string; browserContextId: string }
    }
    expect(attachedPayload.targetInfo.type).toBe('page')
    expect(attachedPayload.targetInfo.browserContextId).toBe('ctx-isolated')
    const session1 = attachedPayload.sessionId

    // Unknown target attach must be rejected (target isolation!)
    await expect(
      client.call('Target.attachToTarget', { targetId: 'MAIN-APP-UI-WINDOW' })
    ).rejects.toThrow(/Target not found/)

    // Forward tab-scoped command + Page.bringToFront activates tab in UI
    const evalRes = await client.call<{ ok: boolean; method: string }>(
      'Runtime.evaluate',
      { expression: '1+1' },
      session1
    )
    expect(evalRes).toEqual({ ok: true, method: 'Runtime.evaluate' })
    await client.call('Page.bringToFront', {}, session1)
    expect(host.activatedIds).toContain('tab-1')

    // Forwarded debugger message carries tab sessionId (or child OOPIF sessionId)
    host.tabs[0].dbg.emitEvent('Page.loadEventFired', { timestamp: 123 })
    await new Promise<void>((r) => setTimeout(r, 15))
    expect(client.events).toContainEqual({
      sessionId: session1,
      method: 'Page.loadEventFired',
      params: { timestamp: 123 }
    })

    // Target.createTarget creates managed tab AND emits attachedToTarget BEFORE resolving
    const created = await client.call<{ targetId: string }>('Target.createTarget', {
      url: 'https://example.org'
    })
    expect(created.targetId).toBe('CR-TARGET-2')
    const attachEvents = client.events.filter((e) => e.method === 'Target.attachedToTarget')
    expect(attachEvents).toHaveLength(2)

    // Close created tab
    const closed = await client.call<{ success: boolean }>('Target.closeTarget', {
      targetId: created.targetId
    })
    expect(closed.success).toBe(true)

    // Disconnect detaches debuggers without closing managed tab
    client.close()
    await new Promise<void>((r) => setTimeout(r, 40))
    expect(host.tabs).toHaveLength(1)
    expect(host.tabs[0].dbg.detachCalls).toBe(1)
  })
})
