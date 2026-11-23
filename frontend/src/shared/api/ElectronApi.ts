// Electron-side MailApi implementation. Reads go to better-sqlite3 via IPC
// handlers (`email:list / :get / :body / :search` + `attachment:list /
// :localPath` — see src/electron/main/handlers/*). Writes (Sprint 5) will
// add `email:resync` etc. backed by `cli_runner.ts`.
//
// Every method funnels through `invoke()` so the preload-exposed
// `window.electron.ipcRenderer` is the only surface this file touches.
// The contextBridge guarantees a clean serialization boundary, so all
// arguments must be structured-clonable.

import type { FeedbackLogEntry } from '../feedback/contract'
import type {
  AdminApi,
  AdminHealthData,
  AIFields,
  AiApi,
  AttachmentApi,
  AttachmentMeta,
  BodyOpts,
  CalendarApi,
  CalendarExpandOpts,
  ChatApi,
  ConnectorApi,
  DavMailApi,
  McpServiceApi,
  NotionAgentApi,
  NotionAgentConfig,
  NotionAgentDoctorCheck,
  NotionAgentListItem,
  ReportApi,
  ComposeDraftOpts,
  ContactSuggestion,
  CreateDraftOpts,
  CreateDraftResult,
  SetReplySuggestionOpts,
  SetReplySuggestionResult,
  DraftPlanOpts,
  DraftPlanResult,
  SendEmailOpts,
  StagedAttachment,
  UploadComposeAttachmentOpts,
  EmailApi,
  EmailBody,
  EmailDetail,
  EmailFlagOpts,
  EmailPinOpts,
  EmailMeta,
  EnrichedEmailMeta,
  FeedbackApi,
  FeedbackDiagnostics,
  FeedbackSubmitOpts,
  FolderApi,
  EnvApi,
  EnvSetResult,
  EnvSnapshot,
  EventsApi,
  EventsStatus,
  HistorySyncApi,
  ServiceRestartResult,
  ServiceStatus,
  ServiceTarget,
  ServicesApi,
  SseEvent,
  JobEnqueueResult,
  JobsApi,
  KosApi,
  ListOpts,
  LlmApi,
  MailApi,
  MailboxSummary,
  NlToDslResult,
  NotificationPermissionResult,
  NotificationSystemStatus,
  PersistentSettings,
  PingResult,
  PromptsApi,
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
  TodayApi,
  UpdaterApi,
  UpdaterStatus
} from './types'
import { narrowGroupTurnEvent, type GroupTurnEvent } from '../../ai-gateway/groupTurnEvent'
import { createChatRuntime } from './chat_api'
import { createConnectorApi } from './connector_api'
import { createDavMailApi } from './davmail_api'
import { createMcpServiceApi } from './mcp_service_api'
import { HttpApi } from './HttpApi'

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

/** Loopback serve-api base URL for zero-IPC HTTP calls from Electron renderer.
 *  Port injected by main via ?apiPort=N; falls back to 8200. */
export function loopbackBaseUrl(): string {
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
  constructor(private readonly loopbackHttp: HttpApi) {}

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
  async get(internalId: number): Promise<EmailDetail | null> {
    return (await invoker()('email:get', internalId)) as EmailDetail | null
  }
  // task 08-27 P5 —— 轻窗。同 chat.openPopout 是 fire-and-forget 的 send（新窗自己
  // ready-to-show），坏 id 就地丢弃不发 IPC。
  openDetached(internalId: number): void {
    if (!Number.isInteger(internalId) || internalId < 0) return
    sender()?.('window:openDetached', 'email', String(internalId))
  }
  async body(internalId: number, opts?: BodyOpts): Promise<EmailBody | null> {
    return (await invoker()('email:body', internalId, opts ?? {})) as EmailBody | null
  }
  async aiFields(internalId: number): Promise<AIFields | null> {
    return (await invoker()('email:aiFields', internalId)) as AIFields | null
  }
  async search(opts: SearchOpts): Promise<SearchResult> {
    return this.loopbackHttp.email.search(opts)
  }
  async contactSuggest(
    q: string,
    limit?: number,
    exclude?: string | string[]
  ): Promise<ContactSuggestion[]> {
    return this.loopbackHttp.email.contactSuggest(q, limit, exclude)
  }
  async resync(internalId: number, opts?: ResyncOpts): Promise<ResyncResult> {
    return this.loopbackHttp.email.resync(internalId, opts)
  }
  async createDraft(opts: CreateDraftOpts): Promise<CreateDraftResult> {
    const env = (await invoker()('email:createDraft', opts)) as WriteEnvelope<CreateDraftResult>
    return unwrap(env)
  }
  async setReplySuggestion(opts: SetReplySuggestionOpts): Promise<SetReplySuggestionResult> {
    return this.loopbackHttp.email.setReplySuggestion(opts)
  }
  async draft(opts: ComposeDraftOpts): Promise<unknown> {
    return this.loopbackHttp.email.draft(opts)
  }
  async deleteDraft(internalId: number): Promise<unknown> {
    return this.loopbackHttp.email.deleteDraft(internalId)
  }
  async send(opts: SendEmailOpts): Promise<unknown> {
    return this.loopbackHttp.email.send(opts)
  }
  async uploadComposeAttachment(opts: UploadComposeAttachmentOpts): Promise<StagedAttachment> {
    return this.loopbackHttp.email.uploadComposeAttachment(opts)
  }
  async draftPlan(opts: DraftPlanOpts): Promise<DraftPlanResult> {
    return this.loopbackHttp.email.draftPlan(opts)
  }
  async pin(internalId: number, pinned: boolean, opts?: EmailPinOpts): Promise<boolean | null> {
    return this.loopbackHttp.email.pin(internalId, pinned, opts)
  }
  async listPinnedIds(): Promise<number[]> {
    return (await invoker()('email:listPinnedIds')) as number[]
  }
  async flag(internalId: number | null, opts: EmailFlagOpts): Promise<unknown> {
    return this.loopbackHttp.email.flag(internalId, opts)
  }
  async archive(internalId: number): Promise<unknown> {
    return this.loopbackHttp.email.archive(internalId)
  }
  async batchResync(internalIds: number[], opts?: ResyncOpts): Promise<JobEnqueueResult> {
    return this.loopbackHttp.email.batchResync(internalIds, opts)
  }
  async nlToDsl(nl: string): Promise<NlToDslResult> {
    // P4b — main 侧 handlers/nl_search.ts 永不 reject (失败以 {dsl:'', error}
    // 返回), 故这里直接透传, 无 envelope/unwrap。
    return (await invoker()('email:nlToDsl', nl)) as NlToDslResult
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
  async systemNotificationStatus(): Promise<NotificationSystemStatus> {
    return (await invoker()('notifications:systemStatus')) as NotificationSystemStatus
  }
  async testNotification(): Promise<PingResult> {
    return (await invoker()('notifications:sendTest')) as PingResult
  }
  async requestNotificationPermission(): Promise<NotificationPermissionResult> {
    return (await invoker()(
      'notifications:requestPermission'
    )) as NotificationPermissionResult
  }
  async openNotificationSystemSettings(): Promise<{ ok: boolean }> {
    return (await invoker()('notifications:openSystemSettings')) as { ok: boolean }
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

// V2.1 3c-3 / S3 — ElectronApi.chat = shared `createChatRuntime`（serve-api 直
// fetch 薄传输面，S3 删 legacy 引擎后 chat turn 全跑 embedded AI SDK Gateway），
// 经 loopback serve-api fetch（token + CORS 由 main `chat_local_bridge` 的
// webRequest 透明注入）。runtime 同进程直 throw `Error & {code}`，无 IPC 边界。

/** ElectronApi.chat 的进程内 ChatRuntime（V2.1 3c-3 / S3 直 fetch 面）。`openPopout`
 *  是 Electron BrowserWindow 能力（shared runtime 里是 no-op）→ 这里 override 回
 *  main 的 `window:openChatPopout` IPC（runtime 透明，web 无此第二窗口场景）。 */
function createElectronChatRuntime(): ChatApi {
  const baseUrl = loopbackBaseUrl()
  const runtime = createChatRuntime({ baseUrl })
  return {
    ...runtime,
    openPopout(emailId: number): void {
      if (!Number.isInteger(emailId) || emailId < 0) return
      sender()?.('window:openChatPopout', emailId)
    },
    // Part B (island live-refresh) — Electron-only main→renderer broadcast（岛上批准 → gateway
    // 服务端 resume 落库后 lifecycle 广播），web (HttpApi) 无此通道（optional 方法缺省）。
    onSessionUpdated(
      handler: (payload: { sessionId: number; status: 'completed' | 'rejected' | 'error' }) => void
    ): () => void {
      return subscribe('chat:session-updated', (...args: unknown[]) => {
        const p = args[0] as { sessionId?: unknown; status?: unknown } | undefined
        if (
          p &&
          typeof p.sessionId === 'number' &&
          (p.status === 'completed' || p.status === 'rejected' || p.status === 'error')
        ) {
          handler({ sessionId: p.sessionId, status: p.status })
        }
      })
    },
    // harness-chat lane A B2 — gateway turn-persist broadcast（lifecycle persistTurn /
    // persistPausedAssistant / Compact 落库后广播）。运行时窄化与发射端联合同步；
    // 值域不符静默丢弃。web (HttpApi) 无此通道（optional 方法缺省 → 轮询降级）。
    // codex r2 [C] — runId 随载荷透传（per-run settle 去重 + own-run 归属）；非字符串窄化为 null
    //（unleased persist / 旧载荷同形）。
    onTurnPersisted(
      handler: (payload: {
        sessionId: number
        status: 'finished' | 'paused' | 'compacted'
        runId: string | null
      }) => void
    ): () => void {
      return subscribe('chat:turn-persisted', (...args: unknown[]) => {
        const p = args[0] as { sessionId?: unknown; status?: unknown; runId?: unknown } | undefined
        if (
          p &&
          typeof p.sessionId === 'number' &&
          (p.status === 'finished' || p.status === 'paused' || p.status === 'compacted')
        ) {
          handler({
            sessionId: p.sessionId,
            status: p.status,
            runId: typeof p.runId === 'string' ? p.runId : null
          })
        }
      })
    },
    onQueuedInputChanged(handler: (payload: { sessionId: number }) => void): () => void {
      return subscribe('chat:queued-input-changed', (...args: unknown[]) => {
        const payload = args[0] as { sessionId?: unknown } | undefined
        if (payload && typeof payload.sessionId === 'number') {
          handler({ sessionId: payload.sessionId })
        }
      })
    },
    // L4 群聊 UX 批 — 调度器 group turn 事件（lifecycle onGroupTurnEvent 广播）。运行时窄化走
    // 叶子 narrowGroupTurnEvent（必填形状不符丢整条；可选字段类型不符只丢字段）。
    onGroupTurn(handler: (event: GroupTurnEvent) => void): () => void {
      return subscribe('chat:group-turn', (...args: unknown[]) => {
        const event = narrowGroupTurnEvent(args[0])
        if (event) handler(event)
      })
    },
    async setGroupForeground(
      target: { groupId: number; threadId: number | null } | null
    ): Promise<void> {
      await invoker()('chat:group-foreground', {
        groupId: target?.groupId ?? null,
        threadId: target?.threadId ?? null
      })
    }
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

// task 08-27 P4a — 快捷反馈。两条链路都只有主进程做得到（诊断包 fork CLI / 提交要绕开
// renderer CSP + 统一设 UA），故 renderer 侧全是薄 invoke。
// 🔴 submit 失败**照抛**：调用方必须显示「没发出去」并给「打开表单页」的降级 —— 私有
// API 的失效是静默的，把错误吞掉就等于骗自己。
class ElectronFeedbackApi implements FeedbackApi {
  async context(route?: string): Promise<string> {
    return (await invoker()('feedback:context', route)) as string
  }
  async diagnostics(): Promise<FeedbackDiagnostics> {
    return (await invoker()('feedback:diagnostics')) as FeedbackDiagnostics
  }
  async submit(opts: FeedbackSubmitOpts): Promise<{ submissionBlockId: string }> {
    return (await invoker()('feedback:submit', opts)) as { submissionBlockId: string }
  }
  async recent(): Promise<FeedbackLogEntry[]> {
    return (await invoker()('feedback:recent')) as FeedbackLogEntry[]
  }
  async openForm(): Promise<void> {
    await invoker()('feedback:openForm')
  }
}

export class ElectronApi implements MailApi {
  private readonly loopbackHttp = new HttpApi(loopbackBaseUrl(), { retryNetworkOnce: true })
  email: EmailApi = new ElectronEmailApi(this.loopbackHttp)
  jobs: JobsApi = this.loopbackHttp.jobs
  historySync: HistorySyncApi = this.loopbackHttp.historySync
  folder: FolderApi = this.loopbackHttp.folder
  attachment: AttachmentApi = new ElectronAttachmentApi()
  ai: AiApi = this.loopbackHttp.ai
  chat: ChatApi = createElectronChatRuntime()
  // 08-01 PR4 — connector 面无 IPC 通道，直接经 loopback serve-api fetch（与 chat 同 baseUrl；
  // token + CORS 由 main `chat_local_bridge` 的 webRequest 透明注入）。
  connector: ConnectorApi = createConnectorApi(loopbackBaseUrl())
  // 设置 →「MCP 服务」：同 connector，无 IPC 通道，经 loopback serve-api fetch。
  mcpService: McpServiceApi = createMcpServiceApi(loopbackBaseUrl())
  // DavMail 自助重新认证：同 connector，无 IPC 通道，经 loopback serve-api fetch。
  davmail: DavMailApi = createDavMailApi(loopbackBaseUrl())
  llm: LlmApi = this.loopbackHttp.llm
  kos: KosApi = this.loopbackHttp.kos
  admin: AdminApi = {
    ...this.loopbackHttp.admin,
    health: async (): Promise<AdminHealthData> => {
      const data = await this.loopbackHttp.admin.health()
      const dbPath = (await invoker()('admin:dbPath')) as string
      return { ...data, db_path: dbPath }
    },
    exportDiagnostics: async (): Promise<{ saved: boolean; path?: string }> =>
      (await invoker()('admin:exportDiagnostics')) as { saved: boolean; path?: string }
  }
  calendar: CalendarApi = {
    ...this.loopbackHttp.calendar,
    async recurringDiscover(opts?: RecurringDiscoverOpts): Promise<RecurringInviteItem[]> {
      return (await invoker()('calendar:recurringDiscover', opts ?? {})) as RecurringInviteItem[]
    },
    async recurringReplay(opts: RecurringReplayOpts): Promise<unknown> {
      const env = (await invoker()('calendar:recurringReplay', opts)) as WriteEnvelope<unknown>
      return unwrap(env)
    },
    async expand(opts?: CalendarExpandOpts): Promise<unknown> {
      const env = (await invoker()('calendar:expand', opts ?? {})) as WriteEnvelope<unknown>
      return unwrap(env)
    }
  }
  settings: SettingsApi = new ElectronSettingsApi()
  updater: UpdaterApi = new ElectronUpdaterApi()
  events: EventsApi = new ElectronEventsApi()
  env: EnvApi = new ElectronEnvApi()
  services: ServicesApi = new ElectronServicesApi()
  prompts: PromptsApi = this.loopbackHttp.prompts
  notionAgent: NotionAgentApi = new ElectronNotionAgentApi()
  report: ReportApi = {
    ...this.loopbackHttp.report,
    openDetached(reportId: string): void {
      if (reportId === '') return
      sender()?.('window:openDetached', 'report', reportId)
    }
  }
  today: TodayApi = this.loopbackHttp.today
  feedback: FeedbackApi = new ElectronFeedbackApi()
}
