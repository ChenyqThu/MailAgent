// V2 Web SPA / PWA MailApi implementation. Empty Sprint 0 placeholder; built
// out in Sprint V2-3 against the local FastAPI service (127.0.0.1:8200 via
// cloudflared tunnel). See REMOTE-ACCESS.md §3 + BACKEND-INTERFACES.md §2.4.

import type { MailApi } from './types'

function notImplemented(method: string): never {
  throw new Error(`HttpApi.${method}() not implemented yet (V2-Sprint 3)`)
}

export class HttpApi implements MailApi {
  constructor(private readonly baseUrl: string) {
    void this.baseUrl
  }

  email = {
    list: () => notImplemented('email.list'),
    listEnriched: () => notImplemented('email.listEnriched'),
    listMailboxes: () => notImplemented('email.listMailboxes'),
    listByThread: () => notImplemented('email.listByThread'),
    get: () => notImplemented('email.get'),
    body: () => notImplemented('email.body'),
    aiFields: () => notImplemented('email.aiFields'),
    search: () => notImplemented('email.search'),
    resync: () => notImplemented('email.resync'),
    // Sprint 5 §2.2 — V2 web build has no Mail.app on the remote host, so
    // createDraft must round-trip through the local FastAPI which then runs
    // osascript on the LAN host. Wired in V2-Sprint 3.
    createDraft: () => notImplemented('email.createDraft'),
    pin: () => notImplemented('email.pin'),
    listPinnedIds: () => notImplemented('email.listPinnedIds'),
    // Sprint 15 §3.3 — SSoT inversion. V2 will proxy through the local
    // FastAPI which then forks the `mailagent email flag` CLI on the Mac
    // host (same write path as Electron build), so all mutating semantics
    // stay on the host process. Wired in V2-Sprint 3.
    flag: () => notImplemented('email.flag')
  }

  attachment = {
    list: () => notImplemented('attachment.list'),
    localPath: () => notImplemented('attachment.localPath'),
    readDataUrl: () => notImplemented('attachment.readDataUrl')
  }

  ai = {
    translateBatch: () => notImplemented('ai.translateBatch'),
    getCached: () => notImplemented('ai.getCached'),
    deleteCached: () => notImplemented('ai.deleteCached'),
    abortTranslate: () => {
      /* V2 web build will route through fetch + AbortController; Sprint 3 stub. */
    }
  }

  // Sprint 4 §2.1 — AI Chat (V2 web SPA will route through SSE or a
  // dedicated /api/chat/stream endpoint; Sprint 4 only stubs).
  chat = {
    start: () => notImplemented('chat.start'),
    abort: () => {
      /* no-op stub */
    },
    listMessages: () => notImplemented('chat.listMessages'),
    listSessions: () => notImplemented('chat.listSessions'),
    onStream: (): (() => void) => () => undefined
  }

  // Sprint 5 §2.2 — CLI-backed writes via the local FastAPI in V2.
  llm = {
    run: () => notImplemented('llm.run'),
    // Sprint 6 — read-only stats can be served by the FastAPI directly
    // (no Mac-specific deps). Wired in V2-Sprint 3.
    stats: () => notImplemented('llm.stats'),
    selftest: () => notImplemented('llm.selftest')
  }

  notion = {
    updateFlag: () => notImplemented('notion.updateFlag')
  }

  // Sprint 6 §2.2 — admin dashboard / calendar / settings.
  // V2 web SPA will proxy each of these through the local FastAPI; the
  // Cloudflare Tunnel + Access combo means the secrets stay on the Mac.
  admin = {
    health: () => notImplemented('admin.health'),
    stats: () => notImplemented('admin.stats'),
    deadLetterList: () => notImplemented('admin.deadLetterList'),
    deadLetterRetry: () => notImplemented('admin.deadLetterRetry'),
    cleanupDeadLetter: () => notImplemented('admin.cleanupDeadLetter')
  }

  calendar = {
    recurringDiscover: () => notImplemented('calendar.recurringDiscover'),
    recurringReplay: () => notImplemented('calendar.recurringReplay'),
    expand: () => notImplemented('calendar.expand')
  }

  // Web SPA has no OS credential store — V2 will surface a "configure on
  // the Mac" hint instead of a writable form. Reads of `settings.get()`
  // can still proxy through FastAPI for poll-interval / Notion Agent
  // binding (non-secret).
  settings = {
    secretsStatus: () => notImplemented('settings.secretsStatus'),
    setSecret: () => notImplemented('settings.setSecret'),
    clearSecret: () => notImplemented('settings.clearSecret'),
    get: () => notImplemented('settings.get'),
    set: () => notImplemented('settings.set'),
    pickFolder: () => notImplemented('settings.pickFolder'),
    testLlm: () => notImplemented('settings.testLlm'),
    testCustomApi: () => notImplemented('settings.testCustomApi')
  }

  // Sprint 8 §2.2 — Web SPA has no in-app updater (the browser handles its
  // own caching; the host Mac runs electron-builder + GitHub Releases). On
  // V2 we'll surface "the Mac host is on version X" via the FastAPI's
  // /api/version endpoint, but the user can't trigger updates from web.
  updater = {
    status: () => notImplemented('updater.status'),
    check: () => notImplemented('updater.check'),
    download: () => notImplemented('updater.download'),
    quitAndInstall: () => notImplemented('updater.quitAndInstall'),
    onEvent: (): (() => void) => () => undefined
  }

  // Sprint 16 §SSE — events bridge stub.
  // V2 web build 后续会接 cloudflared 映射的 mail-sync 本地 9200 SSE endpoint
  // (浏览器原生 EventSource); 当前 sprint 不接入, 远端纯轮询. status/reconnect
  // 还有意义 (前端能 polling fallback); onEvent/onStatus 返回 noop unsubscribe.
  events = {
    status: () => notImplemented('events.status'),
    reconnect: () => notImplemented('events.reconnect'),
    onEvent: (): (() => void) => () => undefined,
    onStatus: (): (() => void) => () => undefined
  }

  // Sprint 18 §PR B — repo-root .env IPC + pm2 services bridge.
  // V2 web build has no `.env` access (the Mac host file is invisible from a
  // remote browser session) and cannot spawn pm2 directly; V2-Sprint will
  // surface a "edit on the Mac" hint via the FastAPI instead. Both surfaces
  // throw notImplemented so a misdirected web-side call surfaces clearly.
  env = {
    get: () => notImplemented('env.get'),
    set: () => notImplemented('env.set')
  }

  services = {
    restart: () => notImplemented('services.restart'),
    status: () => notImplemented('services.status')
  }

  // Web SPA has no direct fs access to the Mac host's prompt files. The V2
  // FastAPI could surface read-only views later; for now web users edit
  // prompts on the Mac.
  prompts = {
    list: () => notImplemented('prompts.list'),
    read: () => notImplemented('prompts.read'),
    write: () => notImplemented('prompts.write')
  }

  // Sprint 9 §2.3 — ping-island bridge lives on the Mac host. From a remote
  // browser the V2 FastAPI could surface a read-only "island connected?"
  // status, but emitting envelopes from the web tab would race the local
  // Electron process and confuse the session model. Web stubs are no-ops;
  // remote users see the island indicator inactive in the TitleBar.
  island = {
    status: () => notImplemented('island.status'),
    testConnection: () => notImplemented('island.testConnection'),
    setEnabled: () => notImplemented('island.setEnabled'),
    appearance: (): void => {
      /* no-op stub */
    },
    aiDraftStart: (): void => {
      /* no-op stub */
    },
    aiDraftStream: (): void => {
      /* no-op stub */
    },
    aiDraftReady: (): void => {
      /* no-op stub */
    },
    onEvent: (): (() => void) => () => undefined
  }
}
