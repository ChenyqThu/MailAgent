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
    get: () => notImplemented('email.get'),
    body: () => notImplemented('email.body'),
    search: () => notImplemented('email.search'),
    resync: () => notImplemented('email.resync')
  }

  attachment = {
    list: () => notImplemented('attachment.list'),
    localPath: () => notImplemented('attachment.localPath')
  }
}
