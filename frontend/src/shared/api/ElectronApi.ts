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
  AdminApi,
  AdminHealthData,
  AdminStatsData,
  AIFields,
  AiApi,
  AttachmentApi,
  AttachmentMeta,
  BodyOpts,
  CalendarApi,
  CalendarExpandOpts,
  ChatApi,
  ChatEditOpts,
  ChatMessage,
  ChatSession,
  ChatStartOpts,
  ChatStartResult,
  ChatStreamEnvelope,
  CleanupDeadLetterOpts,
  CreateDraftOpts,
  CreateDraftResult,
  DeadLetterItem,
  DeadLetterListOpts,
  EmailApi,
  EmailBody,
  EmailDetail,
  EmailFlagOpts,
  EmailMeta,
  EnrichedEmailMeta,
  EnvApi,
  EnvSetResult,
  EnvSnapshot,
  EventsApi,
  EventsStatus,
  ServiceRestartResult,
  ServiceStatus,
  ServiceTarget,
  ServicesApi,
  SseEvent,
  IslandAIDraftReadyPayload,
  IslandAIDraftStartPayload,
  IslandAIDraftStreamPayload,
  IslandApi,
  IslandAppearancePayload,
  IslandStatus,
  ListOpts,
  LlmApi,
  LlmRunOpts,
  LlmSelfTestData,
  LlmStatsData,
  MailApi,
  MailboxSummary,
  NotionWriteApi,
  PersistentSettings,
  PingResult,
  PromptContent,
  PromptInfo,
  PromptSlot,
  PromptsApi,
  PromptWriteResult,
  RecurringDiscoverOpts,
  RecurringInviteItem,
  RecurringReplayOpts,
  ResyncOpts,
  ResyncResult,
  SearchOpts,
  SearchResult,
  SecretSlot,
  SecretsStatus,
  SettingsApi,
  TargetLang,
  TranslateBatchResult,
  TranslationCache,
  UpdateFlagOpts,
  UpdaterApi,
  UpdaterStatus
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

// Sprint 5 §2.2 — every write IPC returns this envelope so Electron IPC's
// loss of custom Error properties (codex review M-3) doesn't collapse
// downstream UI fallback branches. Throw on the renderer side with `code`
// on the Error instance so call sites can still do `err.code === 'E_AUTH'`.
type WriteEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; hint?: string }

function unwrap<T>(env: WriteEnvelope<T>): T {
  if (env.ok) return env.data
  const err = new Error(env.message) as Error & { code?: string; hint?: string }
  err.code = env.code
  if (env.hint !== undefined) err.hint = env.hint
  throw err
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
  async search(opts: SearchOpts): Promise<SearchResult> {
    return (await invoker()('email:search', opts)) as SearchResult
  }
  async resync(internalId: number, opts?: ResyncOpts): Promise<ResyncResult> {
    const env = (await invoker()('email:resync', internalId, opts ?? {})) as WriteEnvelope<unknown>
    return unwrap(env) as ResyncResult
  }
  async createDraft(opts: CreateDraftOpts): Promise<CreateDraftResult> {
    const env = (await invoker()('email:createDraft', opts)) as WriteEnvelope<CreateDraftResult>
    return unwrap(env)
  }
  async pin(internalId: number, pinned: boolean): Promise<boolean | null> {
    // Write IPC → envelope. CLI returns {internal_id, is_pinned, changed,
    // dry_run}; we only surface `is_pinned` (boolean) to the renderer.
    const env = (await invoker()('email:pin', internalId, pinned)) as WriteEnvelope<{
      internal_id: number
      is_pinned: boolean
      changed: boolean
      dry_run: boolean
    } | null>
    const data = unwrap(env)
    return data?.is_pinned ?? null
  }
  async listPinnedIds(): Promise<number[]> {
    return (await invoker()('email:listPinnedIds')) as number[]
  }
  async flag(internalId: number | null, opts: EmailFlagOpts): Promise<unknown> {
    // Same envelope contract as the other write IPCs. The CLI returns its
    // structured `data` block (updated_ids / outbox_entries / not_found) on
    // success; on failure the envelope carries E_PM2_RUNNING / E_AUTH /
    // E_INVALID_ARG etc. for the renderer to branch on.
    const env = (await invoker()('email:flag', internalId, opts ?? {})) as WriteEnvelope<unknown>
    return unwrap(env)
  }
}

class ElectronLlmApi implements LlmApi {
  async run(internalId: number, opts?: LlmRunOpts): Promise<unknown> {
    const env = (await invoker()('llm:run', internalId, opts ?? {})) as WriteEnvelope<unknown>
    return unwrap(env)
  }
  async stats(days = 7): Promise<LlmStatsData> {
    return (await invoker()('llm:stats', days)) as LlmStatsData
  }
  async selftest(): Promise<LlmSelfTestData> {
    return (await invoker()('llm:selftest')) as LlmSelfTestData
  }
}

class ElectronAdminApi implements AdminApi {
  async health(): Promise<AdminHealthData> {
    return (await invoker()('admin:health')) as AdminHealthData
  }
  async stats(): Promise<AdminStatsData> {
    return (await invoker()('admin:stats')) as AdminStatsData
  }
  async deadLetterList(opts?: DeadLetterListOpts): Promise<DeadLetterItem[]> {
    return (await invoker()('admin:deadLetterList', opts ?? {})) as DeadLetterItem[]
  }
  async deadLetterRetry(internalId: number): Promise<unknown> {
    const env = (await invoker()('admin:deadLetterRetry', internalId)) as WriteEnvelope<unknown>
    return unwrap(env)
  }
  async cleanupDeadLetter(opts?: CleanupDeadLetterOpts): Promise<unknown> {
    const env = (await invoker()('admin:cleanupDeadLetter', opts ?? {})) as WriteEnvelope<unknown>
    return unwrap(env)
  }
}

class ElectronCalendarApi implements CalendarApi {
  async recurringDiscover(opts?: RecurringDiscoverOpts): Promise<RecurringInviteItem[]> {
    return (await invoker()('calendar:recurringDiscover', opts ?? {})) as RecurringInviteItem[]
  }
  async recurringReplay(opts: RecurringReplayOpts): Promise<unknown> {
    const env = (await invoker()('calendar:recurringReplay', opts)) as WriteEnvelope<unknown>
    return unwrap(env)
  }
  async expand(opts?: CalendarExpandOpts): Promise<unknown> {
    const env = (await invoker()('calendar:expand', opts ?? {})) as WriteEnvelope<unknown>
    return unwrap(env)
  }
}

class ElectronSettingsApi implements SettingsApi {
  async secretsStatus(): Promise<SecretsStatus> {
    return (await invoker()('settings:secrets:status')) as SecretsStatus
  }
  async setSecret(slot: SecretSlot, value: string): Promise<SecretsStatus> {
    return (await invoker()('settings:secrets:set', { secret: slot, value })) as SecretsStatus
  }
  async clearSecret(slot: SecretSlot): Promise<SecretsStatus> {
    return (await invoker()('settings:secrets:clear', slot)) as SecretsStatus
  }
  async get(): Promise<PersistentSettings> {
    return (await invoker()('settings:get')) as PersistentSettings
  }
  async set(partial: Partial<PersistentSettings>): Promise<PersistentSettings> {
    return (await invoker()('settings:set', partial)) as PersistentSettings
  }
  async pickFolder(title?: string): Promise<string | null> {
    return (await invoker()('settings:pickFolder', title)) as string | null
  }
  async testLlm(): Promise<PingResult> {
    return (await invoker()('settings:test:llm')) as PingResult
  }
  async testCustomApi(): Promise<PingResult> {
    return (await invoker()('settings:test:customApi')) as PingResult
  }
}

class ElectronNotionWriteApi implements NotionWriteApi {
  async updateFlag(internalId: number, opts: UpdateFlagOpts): Promise<unknown> {
    const env = (await invoker()(
      'notion:updateFlag',
      internalId,
      opts ?? {}
    )) as WriteEnvelope<unknown>
    return unwrap(env)
  }
}

class ElectronAttachmentApi implements AttachmentApi {
  async list(internalId: number): Promise<AttachmentMeta[]> {
    return (await invoker()('attachment:list', internalId)) as AttachmentMeta[]
  }
  async localPath(attachmentId: number): Promise<string | null> {
    return (await invoker()('attachment:localPath', attachmentId)) as string | null
  }
  async readDataUrl(attachmentId: number): Promise<string | null> {
    return (await invoker()('attachment:readDataUrl', attachmentId)) as string | null
  }
  async download(attachmentId: number): Promise<string | null> {
    return (await invoker()('attachment:download', attachmentId)) as string | null
  }
}

// Mirror of TranslateEnvelope in src/electron/main/handlers/translate.ts.
// Re-declared here (not imported) so the renderer bundle stays main-side
// free. Codex review M-3 — Electron IPC does NOT preserve custom Error
// properties; the envelope makes the failure shape explicit.
type TranslateEnvelope =
  | { ok: true; data: TranslateBatchResult }
  | { ok: false; code: string; message: string }

class ElectronAiApi implements AiApi {
  async translateBatch(
    internalId: number,
    targetLang?: TargetLang
  ): Promise<TranslateBatchResult> {
    const env = (await invoker()('translate:batch', {
      internalId,
      targetLang
    })) as TranslateEnvelope
    if (env.ok) return env.data
    const err = new Error(env.message) as Error & { code?: string }
    err.code = env.code
    throw err
  }
  async getCached(
    internalId: number,
    targetLang?: TargetLang
  ): Promise<TranslationCache | null> {
    return (await invoker()(
      'translation:get',
      internalId,
      targetLang
    )) as TranslationCache | null
  }
  async deleteCached(internalId: number, targetLang?: TargetLang): Promise<boolean> {
    return (await invoker()('translation:delete', internalId, targetLang)) as boolean
  }
  abortTranslate(internalId: number): void {
    // Fire-and-forget — main side aborts every in-flight batch for this id.
    // No reply needed; the in-flight `translateBatch()` Promise returns
    // whatever partial segments it had completed.
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
  async editMessage(opts: ChatEditOpts): Promise<ChatStartResult> {
    // Same envelope shape as `start` — Electron IPC strips custom Error
    // properties, so the main process wraps dispatch failures in
    // `{ ok: false, code, message }`.
    const env = (await invoker()('chat:editMessage', opts)) as ChatStartEnvelope
    if (env.ok) return env.data
    const err = new Error(env.message) as Error & { code?: string }
    err.code = env.code
    throw err
  }
  openPopout(emailId: number): void {
    // Fire-and-forget; main process spawns the BrowserWindow + handles
    // load + show lifecycle. Bad emailId is silently dropped by the
    // handler — renderer validates the input upstream anyway.
    if (!Number.isInteger(emailId) || emailId < 0) return
    sender()?.('window:openChatPopout', emailId)
  }
  deleteSession(sessionId: number): void {
    // Fire-and-forget — chat_db's CASCADE FK takes care of message rows.
    if (!Number.isInteger(sessionId) || sessionId < 0) return
    sender()?.('chat:deleteSession', sessionId)
  }
  onStream(handler: (envelope: ChatStreamEnvelope) => void): () => void {
    return subscribe('chat:stream', (...args: unknown[]) => {
      const env = args[0] as ChatStreamEnvelope | undefined
      if (env && typeof env === 'object') handler(env)
    })
  }
}

class ElectronIslandApi implements IslandApi {
  async status(): Promise<IslandStatus> {
    return (await invoker()('island:status')) as IslandStatus
  }
  async testConnection(): Promise<IslandStatus> {
    return (await invoker()('island:testConnection')) as IslandStatus
  }
  async setEnabled(enabled: boolean): Promise<IslandStatus> {
    return (await invoker()('island:setEnabled', enabled)) as IslandStatus
  }
  appearance(payload: IslandAppearancePayload): void {
    sender()?.('island:appearance', payload)
  }
  aiDraftStart(payload: IslandAIDraftStartPayload): void {
    sender()?.('island:aiDraftStart', payload)
  }
  aiDraftStream(payload: IslandAIDraftStreamPayload): void {
    sender()?.('island:aiDraftStream', payload)
  }
  aiDraftReady(payload: IslandAIDraftReadyPayload): void {
    sender()?.('island:aiDraftReady', payload)
  }
  onEvent(handler: (status: IslandStatus) => void): () => void {
    return subscribe('island:event', (...args: unknown[]) => {
      const s = args[0] as IslandStatus | undefined
      if (s && typeof s === 'object') handler(s)
    })
  }
}

class ElectronUpdaterApi implements UpdaterApi {
  async status(): Promise<UpdaterStatus> {
    return (await invoker()('updater:status')) as UpdaterStatus
  }
  async check(): Promise<UpdaterStatus> {
    return (await invoker()('updater:check')) as UpdaterStatus
  }
  async download(): Promise<UpdaterStatus> {
    return (await invoker()('updater:download')) as UpdaterStatus
  }
  async quitAndInstall(): Promise<void> {
    await invoker()('updater:quitAndInstall')
  }
  onEvent(handler: (status: UpdaterStatus) => void): () => void {
    return subscribe('updater:event', (...args: unknown[]) => {
      const s = args[0] as UpdaterStatus | undefined
      if (s && typeof s === 'object') handler(s)
    })
  }
}

class ElectronEventsApi implements EventsApi {
  async status(): Promise<EventsStatus> {
    return (await invoker()('events:status')) as EventsStatus
  }
  async reconnect(): Promise<EventsStatus> {
    return (await invoker()('events:reconnect')) as EventsStatus
  }
  onEvent(handler: (event: SseEvent) => void): () => void {
    return subscribe('events:received', (...args: unknown[]) => {
      const ev = args[0] as SseEvent | undefined
      if (ev && typeof ev === 'object') handler(ev)
    })
  }
  onStatus(handler: (status: EventsStatus) => void): () => void {
    return subscribe('events:status', (...args: unknown[]) => {
      const s = args[0] as EventsStatus | undefined
      if (s && typeof s === 'object') handler(s)
    })
  }
}

// Sprint 18 §PR B — repo-root .env + pm2 services. Both APIs are pure
// thin IPC bridges; no caching here (cache lives in useEnvStore on the
// renderer side, refreshed on demand).

class ElectronEnvApi implements EnvApi {
  async get(): Promise<EnvSnapshot> {
    return (await invoker()('env:get')) as EnvSnapshot
  }
  async set(patch: Record<string, string | null>): Promise<EnvSetResult> {
    return (await invoker()('env:set', patch)) as EnvSetResult
  }
}

class ElectronServicesApi implements ServicesApi {
  async restart(target?: ServiceTarget): Promise<ServiceRestartResult> {
    return (await invoker()('services:restart', target)) as ServiceRestartResult
  }
  async status(): Promise<ServiceStatus[]> {
    return (await invoker()('services:status')) as ServiceStatus[]
  }
}

class ElectronPromptsApi implements PromptsApi {
  async list(): Promise<{ inbox: PromptInfo; sent: PromptInfo }> {
    return (await invoker()('prompts:list')) as { inbox: PromptInfo; sent: PromptInfo }
  }
  async read(slot: PromptSlot): Promise<PromptContent> {
    return (await invoker()('prompts:read', slot)) as PromptContent
  }
  async write(slot: PromptSlot, content: string): Promise<PromptWriteResult> {
    return (await invoker()('prompts:write', { slot, content })) as PromptWriteResult
  }
}

export class ElectronApi implements MailApi {
  email: EmailApi = new ElectronEmailApi()
  attachment: AttachmentApi = new ElectronAttachmentApi()
  ai: AiApi = new ElectronAiApi()
  chat: ChatApi = new ElectronChatApi()
  llm: LlmApi = new ElectronLlmApi()
  notion: NotionWriteApi = new ElectronNotionWriteApi()
  admin: AdminApi = new ElectronAdminApi()
  calendar: CalendarApi = new ElectronCalendarApi()
  settings: SettingsApi = new ElectronSettingsApi()
  updater: UpdaterApi = new ElectronUpdaterApi()
  island: IslandApi = new ElectronIslandApi()
  events: EventsApi = new ElectronEventsApi()
  env: EnvApi = new ElectronEnvApi()
  services: ServicesApi = new ElectronServicesApi()
  prompts: PromptsApi = new ElectronPromptsApi()
}
