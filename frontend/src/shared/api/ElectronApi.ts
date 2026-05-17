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
  AIFields,
  AiApi,
  AttachmentApi,
  AttachmentMeta,
  BodyOpts,
  ChatApi,
  ChatMessage,
  ChatSession,
  ChatStartOpts,
  ChatStartResult,
  ChatStreamEnvelope,
  EmailApi,
  EmailBody,
  EmailDetail,
  EmailMeta,
  EnrichedEmailMeta,
  ListOpts,
  MailApi,
  MailboxSummary,
  ResyncOpts,
  ResyncResult,
  SearchHit,
  SearchOpts,
  TargetLang,
  TranslationResult
} from './types'

type IpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>
type IpcSender = (channel: string, ...args: unknown[]) => void
type IpcListener = (...args: unknown[]) => void
type IpcOn = (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => void
type IpcRemove = (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => void

interface IpcBridge {
  invoke?: IpcInvoker
  send?: IpcSender
  on?: IpcOn
  removeListener?: IpcRemove
  off?: IpcRemove
}

function invoker(): IpcInvoker {
  // The preload script (src/electron/preload/index.ts) exposes
  // `@electron-toolkit/preload`'s electronAPI which includes `ipcRenderer`.
  // If the window is missing it, we're running outside Electron (tests,
  // bundling smoke check) — fail with an explicit message rather than a
  // cryptic "cannot read property 'invoke' of undefined".
  const w = window as unknown as { electron?: { ipcRenderer?: IpcBridge } }
  const fn = w.electron?.ipcRenderer?.invoke
  if (typeof fn !== 'function') {
    throw new Error('ElectronApi: window.electron.ipcRenderer.invoke missing — preload not loaded?')
  }
  return fn
}

function sender(): IpcSender | null {
  const w = window as unknown as { electron?: { ipcRenderer?: IpcBridge } }
  const fn = w.electron?.ipcRenderer?.send
  return typeof fn === 'function' ? fn : null
}

/**
 * Subscribe to a main → renderer broadcast channel. Returns an unsubscribe
 * function; safe to call when the preload bridge is missing (returns a
 * no-op so the renderer still mounts in a non-Electron test harness).
 */
function subscribe(channel: string, listener: IpcListener): () => void {
  const w = window as unknown as { electron?: { ipcRenderer?: IpcBridge } }
  const bridge = w.electron?.ipcRenderer
  const onFn = bridge?.on
  if (typeof onFn !== 'function') return () => undefined

  // electron-toolkit's electronAPI passes (event, ...args). We strip the
  // IpcRendererEvent before handing args to the renderer-side handler so
  // call sites only depend on the data shape, not on Electron internals.
  const wrapped = (_event: unknown, ...args: unknown[]): void => listener(...args)
  onFn.call(bridge, channel, wrapped)

  return () => {
    const removeFn = bridge?.removeListener ?? bridge?.off
    if (typeof removeFn === 'function') {
      removeFn.call(bridge, channel, wrapped)
    }
  }
}

class ElectronEmailApi implements EmailApi {
  async list(opts: ListOpts): Promise<EmailMeta[]> {
    return (await invoker()('email:list', opts)) as EmailMeta[]
  }
  async listEnriched(opts: ListOpts): Promise<EnrichedEmailMeta[]> {
    return (await invoker()('email:listEnriched', opts)) as EnrichedEmailMeta[]
  }
  async listMailboxes(): Promise<MailboxSummary[]> {
    return (await invoker()('email:listMailboxes')) as MailboxSummary[]
  }
  async listByThread(threadId: string | null): Promise<EmailMeta[]> {
    return (await invoker()('email:listByThread', threadId)) as EmailMeta[]
  }
  async get(internalId: number): Promise<EmailDetail | null> {
    return (await invoker()('email:get', internalId)) as EmailDetail | null
  }
  async body(internalId: number, opts?: BodyOpts): Promise<EmailBody | null> {
    return (await invoker()('email:body', internalId, opts ?? {})) as EmailBody | null
  }
  async aiFields(internalId: number): Promise<AIFields | null> {
    return (await invoker()('email:aiFields', internalId)) as AIFields | null
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

// Mirror of TranslateEnvelope in src/electron/main/handlers/translate.ts.
// Re-declared here (not imported) so the renderer bundle stays main-side
// free. Codex review M-3 — Electron IPC does NOT preserve custom Error
// properties; the envelope makes the failure shape explicit.
type TranslateEnvelope =
  | { ok: true; data: TranslationResult }
  | { ok: false; code: string; message: string }

class ElectronAiApi implements AiApi {
  async translate(internalId: number, targetLang?: TargetLang): Promise<TranslationResult> {
    const env = (await invoker()('email:translate', {
      internalId,
      targetLang
    })) as TranslateEnvelope
    if (env.ok) return env.data
    const err = new Error(env.message) as Error & { code?: string }
    err.code = env.code
    throw err
  }
  abortTranslate(internalId: number): void {
    // Fire-and-forget — main side just drops the AbortController. No reply
    // needed; the in-flight `translate()` promise resolves with E_ABORTED.
    sender()?.('email:translateAbort', internalId)
  }
}

// Mirror of ChatStartEnvelope in src/electron/main/handlers/chat.ts. Same
// rationale as TranslateEnvelope above (REVIEW-LOG codex M-3): IPC drops
// custom Error properties, so we route failures through `{ ok: false, code }`.
type ChatStartEnvelope =
  | { ok: true; data: ChatStartResult }
  | { ok: false; code: string; message: string }

class ElectronChatApi implements ChatApi {
  async start(opts: ChatStartOpts): Promise<ChatStartResult> {
    const env = (await invoker()('chat:start', opts)) as ChatStartEnvelope
    if (env.ok) return env.data
    const err = new Error(env.message) as Error & { code?: string }
    err.code = env.code
    throw err
  }
  abort(sessionId: number): void {
    // Same fire-and-forget pattern as ai.abortTranslate (Sprint 3).
    sender()?.('chat:abort', sessionId)
  }
  async listMessages(sessionId: number): Promise<ChatMessage[]> {
    return (await invoker()('chat:listMessages', sessionId)) as ChatMessage[]
  }
  async listSessions(emailId: number): Promise<ChatSession[]> {
    return (await invoker()('chat:listSessions', emailId)) as ChatSession[]
  }
  onStream(handler: (envelope: ChatStreamEnvelope) => void): () => void {
    return subscribe('chat:stream', (...args: unknown[]) => {
      const env = args[0] as ChatStreamEnvelope | undefined
      if (env && typeof env === 'object') handler(env)
    })
  }
}

export class ElectronApi implements MailApi {
  email: EmailApi = new ElectronEmailApi()
  attachment: AttachmentApi = new ElectronAttachmentApi()
  ai: AiApi = new ElectronAiApi()
  chat: ChatApi = new ElectronChatApi()
}
