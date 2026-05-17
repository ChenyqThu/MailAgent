// Electron-side MailApi implementation. Sprint 0 = placeholder; Sprint 1 wires
// each method to window.electron IPC calls that hit Electron main process
// handlers (which in turn use better-sqlite3 for reads and execa('mailagent')
// for writes per BACKEND-INTERFACES.md §1.6).

import type { MailApi } from './types'

function notImplemented(method: string): never {
  throw new Error(`ElectronApi.${method}() not implemented yet (Sprint 1)`)
}

export class ElectronApi implements MailApi {
  email = {
    list: () => notImplemented('email.list'),
    get: () => notImplemented('email.get'),
    body: () => notImplemented('email.body'),
    search: () => notImplemented('email.search'),
    resync: () => notImplemented('email.resync')
  }

  attachment = {
    list: () => notImplemented('attachment.list'),
    download: () => notImplemented('attachment.download')
  }
}
