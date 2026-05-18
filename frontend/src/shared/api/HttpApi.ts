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
    createDraft: () => notImplemented('email.createDraft')
  }

  attachment = {
    list: () => notImplemented('attachment.list'),
    localPath: () => notImplemented('attachment.localPath')
  }

  ai = {
    translate: () => notImplemented('ai.translate'),
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

  // Web SPA has no keytar — V2 will surface a "configure on the Mac" hint
  // instead of a writable form. Reads of `settings.get()` can still proxy
  // through FastAPI for poll-interval / Notion Agent binding (non-secret).
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
}
