// Electron-side MailApi implementation. Reads go to better-sqlite3 via IPC
// handlers (`email:list / :get / :body / :search` + `attachment:list /
// :localPath` — see src/electron/main/handlers/*). Writes (Sprint 5) will
// add `email:resync` etc. backed by `cli_runner.ts`.
//
// Every method funnels through `invoke()` so the preload-exposed
// `window.electron.ipcRenderer` is the only surface this file touches.
// The contextBridge guarantees a clean serialization boundary, so all
// arguments must be structured-clonable.

import type {
  AttachmentApi,
  AttachmentMeta,
  BodyOpts,
  EmailApi,
  EmailBody,
  EmailDetail,
  EmailMeta,
  ListOpts,
  MailApi,
  ResyncOpts,
  ResyncResult,
  SearchHit,
  SearchOpts
} from './types'

type IpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>

function invoker(): IpcInvoker {
  // The preload script (src/electron/preload/index.ts) exposes
  // `@electron-toolkit/preload`'s electronAPI which includes `ipcRenderer`.
  // If the window is missing it, we're running outside Electron (tests,
  // bundling smoke check) — fail with an explicit message rather than a
  // cryptic "cannot read property 'invoke' of undefined".
  const w = window as unknown as { electron?: { ipcRenderer?: { invoke?: IpcInvoker } } }
  const fn = w.electron?.ipcRenderer?.invoke
  if (typeof fn !== 'function') {
    throw new Error('ElectronApi: window.electron.ipcRenderer.invoke missing — preload not loaded?')
  }
  return fn
}

class ElectronEmailApi implements EmailApi {
  async list(opts: ListOpts): Promise<EmailMeta[]> {
    return (await invoker()('email:list', opts)) as EmailMeta[]
  }
  async get(internalId: number): Promise<EmailDetail | null> {
    return (await invoker()('email:get', internalId)) as EmailDetail | null
  }
  async body(internalId: number, opts?: BodyOpts): Promise<EmailBody | null> {
    return (await invoker()('email:body', internalId, opts ?? {})) as EmailBody | null
  }
  async search(opts: SearchOpts): Promise<SearchHit[]> {
    return (await invoker()('email:search', opts)) as SearchHit[]
  }
  async resync(internalId: number, opts?: ResyncOpts): Promise<ResyncResult> {
    // Wired in Sprint 5 via cli_runner. Renderer can already call it; the
    // main handler will register at that point.
    return (await invoker()('email:resync', internalId, opts ?? {})) as ResyncResult
  }
}

class ElectronAttachmentApi implements AttachmentApi {
  async list(internalId: number): Promise<AttachmentMeta[]> {
    return (await invoker()('attachment:list', internalId)) as AttachmentMeta[]
  }
  async localPath(attachmentId: number): Promise<string | null> {
    return (await invoker()('attachment:localPath', attachmentId)) as string | null
  }
}

export class ElectronApi implements MailApi {
  email: EmailApi = new ElectronEmailApi()
  attachment: AttachmentApi = new ElectronAttachmentApi()
}
