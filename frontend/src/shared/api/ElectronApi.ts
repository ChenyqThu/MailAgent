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
  CalendarEventDetail,
  CalendarEventOccurrence,
  CalendarExpandOpts,
  CalendarSyncStateItem,
  EventCreateOpts,
  EventDeleteOpts,
  EventGetOpts,
  EventReplayOpts,
  EventRsvpOpts,
  EventUpdateOpts,
  EventsListOpts,
  SyncNowOpts,
  ChatApi,
  NotionAgentApi,
  NotionAgentConfig,
  NotionAgentDoctorCheck,
  NotionAgentListItem,
  ReportApi,
  ReportAgentConfig,
  ReportCadence,
  ReportConfigPatch,
  ReportDetail,
  ReportListItem,
  ReportRunResult,
  CleanupDeadLetterOpts,
  ComposeDraftOpts,
  CreateDraftOpts,
  CreateDraftResult,
  DraftPlanOpts,
  DraftPlanResult,
  SendEmailOpts,
  DavMailHealthData,
  DeadLetterItem,
  DeadLetterListOpts,
  EmailApi,
  EmailBody,
  EmailDetail,
  EmailFlagOpts,
  EmailMeta,
  EnrichedEmailMeta,
  FolderApi,
  FolderCleanupResult,
  FolderDiscoverResult,
  FolderManageResult,
  FolderSetWhitelistResult,
  FolderWhitelistResult,
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
  SystemAlertsData,
  IslandAIDraftReadyPayload,
  IslandAIDraftStartPayload,
  IslandAIDraftStreamPayload,
  IslandApi,
  IslandAppearancePayload,
  IslandStatus,
  JobEnqueueResult,
  JobRecord,
  JobsApi,
  ListOpts,
  LlmApi,
  LlmRunOpts,
  LlmSelfTestData,
  LlmStatsData,
  LlmUpstreamModelsData,
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
import { createChatRuntime } from '../chat/runtime'
import { HttpApi } from './HttpApi'
import { request } from './http_client'

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

/** Loopback serve-api base URL for zero-IPC HTTP calls from Electron renderer
 *  (e.g. llm/models). Port injected by main via ?apiPort=N; falls back to 8200. */
function loopbackBaseUrl(): string {
  let port = 8200
  try {
    const raw = new URLSearchParams(window.location.search).get('apiPort')
    const n = raw != null ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n > 0) port = n
  } catch {
    /* non-renderer test env — fall back to default port */
  }
  return `http://127.0.0.1:${port}/api`
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

  // CRITICAL — 必须用 `on()` 返回的 disposer 来反订阅, 不能自己 `removeListener
  // (channel, wrapped)`. 跨 contextBridge 第二次传 `wrapped` 会生成一个*新的*
  // proxy, 与注册时的 proxy 不是同一引用, removeListener 匹配不到 → listener
  // 泄漏。electron-toolkit 的 `on` 返回的 disposer 闭包捕获的是注册时那个
  // proxy, 移除可靠。泄漏的后果是实打实的: StrictMode(dev) 把订阅 effect
  // mount→cleanup→remount, cleanup 没真正摘除旧 listener → `chat:stream` 上
  // 挂了 2 个 listener → 每个流式 chunk 被投递两次 → 渲染层 `content += delta`
  // 追加两次 → 整段回复重复 / 交错 (本 bug 根因, 数据探针实测 distinctSubs=2)。
  const dispose = onFn.call(bridge, channel, wrapped) as unknown as (() => void) | undefined
  if (typeof dispose === 'function') return dispose

  // Fallback: 桥接实现的 `on` 未返回 disposer 时, 退回 removeListener(尽力而为)。
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
  async listByThreads(threadIds: string[]): Promise<Record<string, EmailMeta[]>> {
    return (await invoker()('email:listByThreads', threadIds)) as Record<string, EmailMeta[]>
  }
  async listSnippets(internalIds: number[]): Promise<Record<number, string>> {
    return (await invoker()('email:listSnippets', internalIds)) as Record<number, string>
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
  async draft(opts: ComposeDraftOpts): Promise<unknown> {
    const env = (await invoker()('email:draft', opts)) as WriteEnvelope<unknown>
    return unwrap(env)
  }
  async send(opts: SendEmailOpts): Promise<unknown> {
    const env = (await invoker()('email:send', opts)) as WriteEnvelope<unknown>
    return unwrap(env)
  }
  async draftPlan(opts: DraftPlanOpts): Promise<DraftPlanResult> {
    const env = (await invoker()('email:draftPlan', opts)) as WriteEnvelope<DraftPlanResult>
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
  async archive(internalId: number): Promise<unknown> {
    // Write IPC → envelope. CLI does IMAP MOVE INBOX→Archive + SQLite/Notion
    // Mailbox→存档 and returns {success, from_mailbox, to_mailbox, notion_updated}.
    const env = (await invoker()('email:archive', internalId)) as WriteEnvelope<unknown>
    return unwrap(env)
  }
  async batchResync(internalIds: number[], opts?: ResyncOpts): Promise<JobEnqueueResult> {
    // D2b — Write IPC → envelope. Enqueues an async_jobs resync job and returns
    // {job_id, status:'queued', was_created, …}; watchResyncJob then tracks
    // progress via SSE job.* + jobs.get polling.
    const env = (await invoker()(
      'email:batchResync',
      internalIds,
      opts ?? {}
    )) as WriteEnvelope<JobEnqueueResult>
    return unwrap(env)
  }
}

class ElectronFolderApi implements FolderApi {
  // 多文件夹同步 (P3) — discover/whitelist 走 Main→daemon→serve-api 转发 (D1)。
  // 用 envelope 形态过 IPC 边界以保住 error.code (非 davmail → E_INVALID_ARG, 给
  // FolderPicker 门控)。
  async discover(opts?: { counts?: boolean }): Promise<FolderDiscoverResult> {
    const env = (await invoker()('folder:discover', opts)) as WriteEnvelope<FolderDiscoverResult>
    return unwrap(env)
  }
  async getWhitelist(): Promise<FolderWhitelistResult> {
    const env = (await invoker()('folder:getWhitelist')) as WriteEnvelope<FolderWhitelistResult>
    return unwrap(env)
  }
  async setWhitelist(imapNames: string[]): Promise<FolderSetWhitelistResult> {
    const env = (await invoker()(
      'folder:setWhitelist',
      imapNames
    )) as WriteEnvelope<FolderSetWhitelistResult>
    return unwrap(env)
  }
  // 文件夹管理 (P4) — 新建/重命名/删除 走 Main→daemon→serve-api 转发 (envelope 保 code)。
  async createFolder(parentImapName: string | null, name: string): Promise<FolderManageResult> {
    const env = (await invoker()(
      'folder:create',
      parentImapName,
      name
    )) as WriteEnvelope<FolderManageResult>
    return unwrap(env)
  }
  async renameFolder(imapName: string, newName: string): Promise<FolderManageResult> {
    const env = (await invoker()(
      'folder:rename',
      imapName,
      newName
    )) as WriteEnvelope<FolderManageResult>
    return unwrap(env)
  }
  async deleteFolder(imapName: string): Promise<FolderManageResult> {
    const env = (await invoker()(
      'folder:manageDelete',
      imapName
    )) as WriteEnvelope<FolderManageResult>
    return unwrap(env)
  }
  async cleanup(imapName: string): Promise<FolderCleanupResult> {
    const env = (await invoker()('folder:cleanup', imapName)) as WriteEnvelope<FolderCleanupResult>
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
  async listUpstreamModels(opts?: {
    refresh?: boolean
    provider?: 'main' | 'translate'
  }): Promise<LlmUpstreamModelsData> {
    // Zero new IPC: Electron renderer calls the loopback serve-api directly
    // (same pattern as chat runtime). The API key stays on the serve-api host.
    const query: Record<string, string> = {}
    if (opts?.refresh) query['refresh'] = 'true'
    if (opts?.provider) query['provider'] = opts.provider
    return request<LlmUpstreamModelsData>(
      loopbackBaseUrl(),
      'GET',
      '/llm/models',
      Object.keys(query).length > 0 ? { query } : undefined
    )
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
  async davmailHealth(): Promise<DavMailHealthData> {
    return (await invoker()('admin:davmailHealth')) as DavMailHealthData
  }
  async systemAlerts(): Promise<SystemAlertsData> {
    return (await invoker()('admin:systemAlerts')) as SystemAlertsData
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

  // Phase 3 §3.1 — Calendar SSoT
  async eventsList(opts: EventsListOpts = {}): Promise<CalendarEventOccurrence[]> {
    return (await invoker()('calendar:eventsList', opts)) as CalendarEventOccurrence[]
  }
  async eventGet(opts: EventGetOpts): Promise<CalendarEventDetail | null> {
    return (await invoker()('calendar:eventGet', opts)) as CalendarEventDetail | null
  }
  async syncStatus(): Promise<CalendarSyncStateItem[]> {
    return (await invoker()('calendar:syncStatus')) as CalendarSyncStateItem[]
  }
  async calendarNames(): Promise<string[]> {
    return (await invoker()('calendar:calendarNames')) as string[]
  }
  async syncTrigger(opts: SyncNowOpts = {}): Promise<unknown> {
    const env = (await invoker()('calendar:syncTrigger', opts)) as WriteEnvelope<unknown>
    return unwrap(env)
  }

  // Phase 2.4 — replay calendar_event 行到 Notion (any source)
  async eventReplay(opts: EventReplayOpts): Promise<unknown> {
    const env = (await invoker()('calendar:eventReplay', opts)) as WriteEnvelope<unknown>
    return unwrap(env)
  }

  // Phase 2.1 — RSVP iTIP REPLY to organizer
  async eventRsvp(opts: EventRsvpOpts): Promise<unknown> {
    const env = (await invoker()('calendar:eventRsvp', opts)) as WriteEnvelope<unknown>
    return unwrap(env)
  }

  // Phase 2.2 — CalDAV PUT 新建事件
  async eventCreate(opts: EventCreateOpts): Promise<unknown> {
    const env = (await invoker()('calendar:eventCreate', opts)) as WriteEnvelope<unknown>
    return unwrap(env)
  }

  // Phase 2.3 — CalDAV PUT update / DELETE
  async eventUpdate(opts: EventUpdateOpts): Promise<unknown> {
    const env = (await invoker()('calendar:eventUpdate', opts)) as WriteEnvelope<unknown>
    return unwrap(env)
  }
  async eventDelete(opts: EventDeleteOpts): Promise<unknown> {
    const env = (await invoker()('calendar:eventDelete', opts)) as WriteEnvelope<unknown>
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
  async translateBatch(internalId: number, targetLang?: TargetLang): Promise<TranslateBatchResult> {
    const env = (await invoker()('translate:batch', {
      internalId,
      targetLang
    })) as TranslateEnvelope
    if (env.ok) return env.data
    const err = new Error(env.message) as Error & { code?: string }
    err.code = env.code
    throw err
  }
  async getCached(internalId: number, targetLang?: TargetLang): Promise<TranslationCache | null> {
    return (await invoker()('translation:get', internalId, targetLang)) as TranslationCache | null
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

// V2.1 3c-3 cutover — ElectronApi.chat 不再走 IPC (`chat:*` → main dispatcher)，
// 改为在 renderer 进程内跑 shared `createChatRuntime`（dispatcher + HttpChatPlatform
// + 进程内 emitter sink），经 loopback serve-api fetch（token + CORS 由 main
// `chat_local_bridge` 的 webRequest 透明注入）。旧 `ElectronChatApi`（IPC 封装）+
// `ChatStartEnvelope`（IPC 丢 Error.code 才需的 envelope）随之删除 —— runtime 同进程
// 直 throw `Error & {code}`，无 IPC 边界，不需 envelope 解包。main 侧 `chat:*` IPC
// handler 暂留为 dead code（3c-4 cutover 整体删 main 直跑路径）。

/** renderer 内 ChatRuntime 的 loopback serve-api baseUrl。host 恒 127.0.0.1
 *  (loopback)；端口由 main `createWindow` 经 `?apiPort=N` 注入（`resolveApiPort()`
 *  单一真源 = serve-api 实际端口 = `chat_local_bridge` webRequest filter 端口）。
 *  renderer 进程无 `process.env`，故端口必须由 main 透传；缺省 / 解析失败回退 8200。 */
function loopbackChatBaseUrl(): string {
  let port = 8200
  try {
    const raw = new URLSearchParams(window.location.search).get('apiPort')
    const n = raw != null ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n > 0) port = n
  } catch {
    // window/location 不可用（非 renderer 测试环境）→ 回退默认端口。
  }
  return `http://127.0.0.1:${port}/api`
}

/** ElectronApi.chat 的进程内 ChatRuntime（V2.1 3c-3）。`reads = new HttpApi(loopback)`
 *  仅供 `HttpChatPlatform` 的工具读（email/attachment）；该 HttpApi 的 lazy `.chat`
 *  getter 永不构造（破循环，见 HttpApi.chat 注释）。`openPopout` 是 Electron
 *  BrowserWindow 能力（shared runtime 里是 no-op）→ 这里 override 回 main 的
 *  `window:openChatPopout` IPC（runtime 透明，web 无此第二窗口场景）。 */
function createElectronChatRuntime(): ChatApi {
  const baseUrl = loopbackChatBaseUrl()
  const runtime = createChatRuntime({ reads: new HttpApi(baseUrl), baseUrl })
  return {
    ...runtime,
    openPopout(emailId: number): void {
      if (!Number.isInteger(emailId) || emailId < 0) return
      sender()?.('window:openChatPopout', emailId)
    }
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

// D2b — async_jobs 长任务查询 (batch resync 进度轮询)。jobs:get 经 daemonRequest
// 转发 GET /api/jobs/{id}; 返回 envelope → unwrap (E_NOT_FOUND 抛 Error & {code})。
class ElectronJobsApi implements JobsApi {
  async get(jobId: number): Promise<JobRecord> {
    const env = (await invoker()('jobs:get', jobId)) as WriteEnvelope<JobRecord>
    return unwrap(env)
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

class ElectronNotionAgentApi implements NotionAgentApi {
  async getConfig(): Promise<NotionAgentConfig> {
    return (await invoker()('notionAgent:getConfig')) as NotionAgentConfig
  }
  async listModels(): Promise<string[]> {
    return (await invoker()('notionAgent:listModels')) as string[]
  }
  async doctor(): Promise<NotionAgentDoctorCheck[]> {
    const env = (await invoker()('notionAgent:doctor')) as WriteEnvelope<NotionAgentDoctorCheck[]>
    return unwrap(env)
  }
  async listAgents(): Promise<NotionAgentListItem[]> {
    const env = (await invoker()('notionAgent:listAgents')) as WriteEnvelope<NotionAgentListItem[]>
    return unwrap(env)
  }
  async setAgent(
    pageId: string,
    name: string,
    accessory?: string | null
  ): Promise<NotionAgentConfig> {
    const env = (await invoker()('notionAgent:setAgent', {
      pageId,
      name,
      accessory
    })) as WriteEnvelope<NotionAgentConfig>
    return unwrap(env)
  }
  async setModel(alias: string): Promise<NotionAgentConfig> {
    const env = (await invoker()('notionAgent:setModel', {
      alias
    })) as WriteEnvelope<NotionAgentConfig>
    return unwrap(env)
  }
}

class ElectronReportApi implements ReportApi {
  async list(opts?: {
    cadence?: ReportCadence
    agentId?: string
    limit?: number
  }): Promise<ReportListItem[]> {
    return (await invoker()('report:list', opts ?? {})) as ReportListItem[]
  }
  async get(reportId: string): Promise<ReportDetail | null> {
    return (await invoker()('report:get', reportId)) as ReportDetail | null
  }
  async getConfig(): Promise<ReportAgentConfig[]> {
    return (await invoker()('report:getConfig')) as ReportAgentConfig[]
  }
  async setConfig(agentId: string, patch: ReportConfigPatch): Promise<ReportAgentConfig> {
    const env = (await invoker()(
      'report:setConfig',
      agentId,
      patch
    )) as WriteEnvelope<ReportAgentConfig>
    return unwrap(env)
  }
  async runNow(agentId: string, opts?: { cadence?: ReportCadence }): Promise<ReportRunResult> {
    const env = (await invoker()(
      'report:runNow',
      agentId,
      opts ?? {}
    )) as WriteEnvelope<ReportRunResult>
    return unwrap(env)
  }
  async delete(reportId: string): Promise<void> {
    const env = (await invoker()('report:delete', reportId)) as WriteEnvelope<{ deleted: string }>
    unwrap(env)
  }
}

export class ElectronApi implements MailApi {
  email: EmailApi = new ElectronEmailApi()
  jobs: JobsApi = new ElectronJobsApi()
  folder: FolderApi = new ElectronFolderApi()
  attachment: AttachmentApi = new ElectronAttachmentApi()
  ai: AiApi = new ElectronAiApi()
  chat: ChatApi = createElectronChatRuntime()
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
  notionAgent: NotionAgentApi = new ElectronNotionAgentApi()
  report: ReportApi = new ElectronReportApi()
}
