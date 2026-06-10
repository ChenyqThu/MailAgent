// V2 Web SPA / PWA MailApi implementation. Built against the local FastAPI
// service (127.0.0.1:8200 via a cloudflared tunnel; default baseUrl '/api'
// for same-origin). See REMOTE-ACCESS.md §4 (data layer) +
// docs/v2-backend-sprint12-handoff.md (endpoint matrix + 减法清单).
//
// Every JSON method funnels through `this.req()` → http_client.request(),
// which parses the `{status, schema_version, data, error, meta}` envelope:
// success → data, error → throw Error & { code, hint } (1:1 mirror of
// ElectronApi.unwrap so call sites keep doing `err.code === 'E_NOT_FOUND'`),
// HTTP 207 partial_failure → return the {succeeded,failed,summary} data
// WITHOUT throwing. credentials:'include' rides the Cloudflare Access
// CF_Authorization cookie — no Authorization header, no API key in the bundle.
//
// Methods listed in the 减法清单 (stub_keep) stay as notImplemented/noop:
// chat.*, ai.translateBatch/abortTranslate, email.createDraft, calendar
// WRITES, folder WRITES, settings WRITE/secret, updater.*, env.set, services.*,
// prompts.write, notionAgent WRITES, island.*, notion.updateFlag, events.status/
// reconnect. Implemented surfaces: email/attachment (full read + write),
// ai.getCached/deleteCached, llm.run/stats/selftest, admin.*, calendar READS,
// folder READS, env.get (read-only .env snapshot), prompts.list/read,
// notionAgent.getConfig/listModels/listAgents, settings.get/secretsStatus.

import type {
  ReportApi,
  ReportAgentConfig,
  ReportCadence,
  ReportConfigPatch,
  ReportDetail,
  ReportListItem,
  ReportRunResult,
  AdminHealthData,
  AdminStatsData,
  AIFields,
  AttachmentMeta,
  BodyOpts,
  CalendarEventDetail,
  CalendarEventOccurrence,
  CalendarSyncStateItem,
  ChatApi,
  EventGetOpts,
  EventsListOpts,
  CleanupDeadLetterOpts,
  ComposeDraftOpts,
  DavMailHealthData,
  DeadLetterItem,
  DeadLetterListOpts,
  DraftPlanOpts,
  DraftPlanResult,
  EmailBody,
  EmailDetail,
  EmailFlagOpts,
  EmailMeta,
  EnrichedEmailMeta,
  EnvSnapshot,
  FolderCleanupResult,
  FolderDiscoverResult,
  FolderManageResult,
  FolderSetWhitelistResult,
  FolderWhitelistResult,
  JobEnqueueResult,
  JobRecord,
  ListOpts,
  LlmRunOpts,
  LlmSelfTestData,
  LlmStatsData,
  LlmUpstreamModelsData,
  MailApi,
  MailboxSummary,
  NotionAgentConfig,
  NotionAgentListItem,
  PersistentSettings,
  PromptContent,
  PromptInfo,
  PromptSlot,
  ResyncOpts,
  ResyncResult,
  SearchOpts,
  SearchResult,
  SecretsStatus,
  SendEmailOpts,
  SystemAlertsData,
  TargetLang,
  TranslationCache
} from './types'
import { fetchAsDataUrl, request, type QueryValue, type RequestOptions } from './http_client'
import { createChatRuntime } from '../chat/runtime'

function notImplemented(method: string): Promise<never> {
  // V2-Sprint 3 stub. MUST reject, never throw synchronously: every stubbed
  // surface is an async API method whose renderer call sites degrade via
  // `.catch()` / try-await. A sync throw escapes those handlers and trips the
  // React ErrorBoundary ("Something went wrong") — e.g. AiTab's prompts.list()
  // on mount when opened from remote. Rejecting keeps the failure inside the
  // promise chain so each call site can fall back to a toast.
  return Promise.reject(new Error(`HttpApi.${method}() not implemented yet (V2-Sprint 3)`))
}

/** True only for an ApiError whose code === 'E_NOT_FOUND'. Used by the few
 *  methods whose interface returns `T | null` on a missing row (email.get,
 *  email.body, email.pin, calendar.eventGet) — mirrors
 *  ElectronApi which returns null rather than throwing for those. */
function isNotFound(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === 'E_NOT_FOUND'
  )
}

export class HttpApi implements MailApi {
  constructor(private readonly baseUrl: string) {}

  /** Thin instance wrapper around http_client.request bound to this baseUrl. */
  private req<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    return request<T>(this.baseUrl, method, path, opts)
  }

  /** camelCase ListOpts → query record. Drops undefined; `internalIds`
   *  comma-joins (handled in buildQuery). The FastAPI exposes these exact
   *  camelCase alias keys (sinceDate/untilDate/fromAddr/isRead/isFlagged/
   *  hasNotion/internalIds). */
  private listQuery(opts: ListOpts): Record<string, QueryValue> {
    return {
      mailbox: opts.mailbox,
      status: opts.status,
      sinceDate: opts.sinceDate,
      untilDate: opts.untilDate,
      fromAddr: opts.fromAddr,
      subject: opts.subject,
      isRead: opts.isRead,
      isFlagged: opts.isFlagged,
      hasNotion: opts.hasNotion,
      internalIds: opts.internalIds,
      limit: opts.limit,
      offset: opts.offset
    }
  }

  email = {
    list: (opts: ListOpts): Promise<EmailMeta[]> =>
      this.req<EmailMeta[]>('GET', '/email/list', { query: this.listQuery(opts) }),

    listEnriched: (opts: ListOpts): Promise<EnrichedEmailMeta[]> =>
      this.req<EnrichedEmailMeta[]>('GET', '/email/list-enriched', {
        query: this.listQuery(opts)
      }),

    listMailboxes: (): Promise<MailboxSummary[]> =>
      this.req<MailboxSummary[]>('GET', '/email/mailboxes'),

    listByThread: (threadId: string | null): Promise<EmailMeta[]> => {
      // Empty/unknown thread → [] locally; avoids a bad /thread/ URL (server
      // also returns [] but don't round-trip a nonsense path).
      if (threadId === null || threadId === '') return Promise.resolve([])
      return this.req<EmailMeta[]>('GET', `/email/thread/${encodeURIComponent(threadId)}`)
    },

    listByThreads: (threadIds: string[]): Promise<Record<string, EmailMeta[]>> => {
      if (!threadIds || threadIds.length === 0) return Promise.resolve({})
      return this.req<Record<string, EmailMeta[]>>('POST', '/email/threads', {
        body: { threadIds }
      })
    },

    listSnippets: (internalIds: number[]): Promise<Record<number, string>> => {
      if (!internalIds || internalIds.length === 0) return Promise.resolve({})
      // Wire keys are strings (JSON object keys); semantically equal to the
      // IPC number-keyed map. `result[id]` / `result[String(id)]` both work.
      return this.req<Record<number, string>>('POST', '/email/snippets', {
        body: { internalIds }
      })
    },

    get: async (internalId: number): Promise<EmailDetail | null> => {
      try {
        // include body summary + attachments to match the Electron `get`
        // which returns them inline. `data.body` is a SUMMARY, not content.
        return await this.req<EmailDetail>('GET', `/email/${internalId}`, {
          query: { include: 'body,attachments' }
        })
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },

    body: async (internalId: number, opts?: BodyOpts): Promise<EmailBody | null> => {
      try {
        return await this.req<EmailBody>('GET', `/email/${internalId}/body`, {
          query: { format: opts?.format ?? 'markdown' }
        })
      } catch (e) {
        // No body row OR that format is null → server 404s → null.
        if (isNotFound(e)) return null
        throw e
      }
    },

    aiFields: async (internalId: number): Promise<AIFields | null> => {
      // Single→batch adapter: the web endpoint is POST batch (ids→map) but
      // the EmailApi.aiFields(id) interface is single. POST {internalIds:[id]}
      // then pick the one entry; missing → null.
      const map = await this.req<Record<string, AIFields>>('POST', '/email/ai-fields', {
        body: { internalIds: [internalId] }
      })
      return map[String(internalId)] ?? null
    },

    search: (opts: SearchOpts): Promise<SearchResult> =>
      // NOTE: param is `q` (not `query`), and `since/until` (not sinceDate/
      // untilDate) on this endpoint. Returns the SearchResult shape directly.
      this.req<SearchResult>('GET', '/email/search', {
        query: {
          q: opts.query,
          mailbox: opts.mailbox,
          since: opts.since,
          until: opts.until,
          limit: opts.limit
        }
      }),

    resync: (internalId: number, opts?: ResyncOpts): Promise<ResyncResult> =>
      // Server always adds --allow-concurrent, so E_PM2_RUNNING shouldn't
      // occur; if it does the envelope error throws with the code.
      this.req<ResyncResult>('POST', `/email/${internalId}/resync`, {
        body: {
          replaceExisting: opts?.replaceExisting,
          skipParentLookup: opts?.skipParentLookup,
          dryRun: opts?.dryRun
        }
      }),

    // Sprint 5 §2.2 — Mail.app AppleScript-only draft window. Web uses
    // email.draft instead (no osascript on the remote tab); keep stub.
    createDraft: () => notImplemented('email.createDraft'),

    draft: (opts: ComposeDraftOpts): Promise<unknown> =>
      // davmail-only. internalId + bodyHtml in BODY (server writes a tmp
      // .html → --body-html-file). Throws Error & { code } on failure.
      this.req<unknown>('POST', '/email/draft', { body: opts }),

    send: (opts: SendEmailOpts): Promise<unknown> =>
      // Irreversible SMTP send. Server always passes --yes (the renderer
      // shows SendConfirmDialog first — there is no flag to suppress send).
      this.req<unknown>('POST', '/email/send', { body: opts }),

    draftPlan: (opts: DraftPlanOpts): Promise<DraftPlanResult> =>
      // dry-run, read-only, no auth. The response is snake_case and MUST stay
      // snake_case (reply_html / forward_intro_html / reply_source) — request
      // does no case transform, so this is returned as-is.
      this.req<DraftPlanResult>('POST', `/email/${opts.internalId}/draft-plan`, {
        body: { mode: opts.mode }
      }),

    pin: async (internalId: number, pinned: boolean): Promise<boolean | null> => {
      try {
        const data = await this.req<{
          internal_id: number
          is_pinned: boolean
          changed: boolean
          dry_run: boolean
        }>('POST', `/email/${internalId}/pin`, { body: { pinned } })
        // Surface only is_pinned (boolean), mirroring ElectronApi.
        return data?.is_pinned ?? null
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },

    listPinnedIds: async (): Promise<number[]> => {
      // GET /pinned-ids data is {pinned_ids, count} — unwrap the inner array.
      const data = await this.req<{ pinned_ids: number[]; count: number }>(
        'GET',
        '/email/pinned-ids'
      )
      return data?.pinned_ids ?? []
    },

    flag: (internalId: number | null, opts: EmailFlagOpts): Promise<unknown> => {
      // allowConcurrent is server-forced (--allow-concurrent always) — never
      // send it. At least one of isRead/isFlagged/processingStatus required
      // (server 400s otherwise).
      const body: Record<string, unknown> = {}
      if (opts.isRead !== undefined) body.isRead = opts.isRead
      if (opts.isFlagged !== undefined) body.isFlagged = opts.isFlagged
      if (opts.processingStatus !== undefined) body.processingStatus = opts.processingStatus

      if (opts.ids && opts.ids.length > 0) {
        // Batch mode. The path still needs an int segment even though the
        // server reads body.ids and ignores the path when ids are present —
        // use /email/0/flag as the placeholder. May return HTTP 207
        // partial_failure → request() returns {succeeded,failed,summary}.
        body.ids = opts.ids
        return this.req<unknown>('POST', '/email/0/flag', { body })
      }
      // Single mode — internalId in the path.
      return this.req<unknown>('POST', `/email/${internalId}/flag`, { body })
    },

    archive: (internalId: number): Promise<unknown> =>
      // davmail-only → non-davmail backend yields E_INVALID_ARG (400) which
      // throws with the code. No --allow-concurrent on this one.
      this.req<unknown>('POST', `/email/${internalId}/archive`, { body: {} }),

    batchResync: (internalIds: number[], opts?: ResyncOpts): Promise<JobEnqueueResult> =>
      // D2b — enqueue an async_jobs resync job (mirror write_ops.runBatchResync).
      // POST /jobs, camelCase envelope + params snake_case. replace_existing
      // defaults true (live-resync parity with single resync); no idempotencyKey
      // (every click is a fresh job — re-running the same batch is allowed).
      // targetKind/targetKey informational only (backend reads params.internal_ids).
      this.req<JobEnqueueResult>('POST', '/jobs', {
        body: {
          jobType: 'resync',
          targetKind: 'batch',
          targetKey: String(internalIds.length),
          params: {
            internal_ids: internalIds,
            replace_existing: opts?.replaceExisting ?? true,
            skip_parent_lookup: opts?.skipParentLookup ?? false
          }
        }
      })
  }

  // D2b — async_jobs 长任务查询 (batch resync 进度轮询兜底)。web 无 SSE →
  // watchResyncJob 纯靠此轮询拿终态。GET /api/jobs/{id}。
  jobs = {
    get: (jobId: number): Promise<JobRecord> => this.req<JobRecord>('GET', `/jobs/${jobId}`)
  }

  // 多文件夹同步 (P3/P4/P5) — discover/whitelist/manage/cleanup。davmail-only
  // (discover/manage); serve-api 对非 davmail 后端返回 400 E_INVALID_ARG → req()
  // 抛带 code 的 Error, FolderPicker 据此切门控态。远程 web 直连这些端点 (与本地
  // daemon 转发同 wire)。
  folder = {
    discover: (opts?: { counts?: boolean }): Promise<FolderDiscoverResult> =>
      this.req<FolderDiscoverResult>('GET', '/folder/discover', {
        // 后端默认 counts=true; 显式传以保持 wire 清晰。
        query: { counts: opts?.counts ?? true }
      }),

    getWhitelist: (): Promise<FolderWhitelistResult> =>
      this.req<FolderWhitelistResult>('GET', '/folder/whitelist'),

    setWhitelist: (imapNames: string[]): Promise<FolderSetWhitelistResult> =>
      this.req<FolderSetWhitelistResult>('PUT', '/folder/whitelist', {
        body: { folders: imapNames }
      }),

    // 文件夹管理 (P4) — 新建/重命名/删除。davmail-only: serve-api 对非 davmail /
    // Exchange 失败抛带 code 的 Error, FolderPicker 据此反馈 + refetch。远程 web
    // 直连这些端点 (与本地 daemon 转发同 wire)。
    createFolder: (parentImapName: string | null, name: string): Promise<FolderManageResult> =>
      this.req<FolderManageResult>('POST', '/folder/manage', {
        // serve-api `_FolderCreateBody.parent: str = ""` (空串 = 顶层); null → 422,
        // 故顶层归一化为空串。
        body: { parent: parentImapName ?? '', name }
      }),

    renameFolder: (imapName: string, newName: string): Promise<FolderManageResult> =>
      this.req<FolderManageResult>('PATCH', '/folder/manage', {
        body: { imap_name: imapName, new_name: newName }
      }),

    deleteFolder: (imapName: string): Promise<FolderManageResult> =>
      this.req<FolderManageResult>('DELETE', '/folder/manage', {
        body: { imap_name: imapName }
      }),

    cleanup: (imapName: string): Promise<FolderCleanupResult> =>
      this.req<FolderCleanupResult>('POST', '/folder/cleanup', {
        body: { imap_name: imapName }
      })
  }

  attachment = {
    list: (internalId: number): Promise<AttachmentMeta[]> =>
      // local_path stripped server-side. 404 (email not found) would throw;
      // renderer only calls for existing emails.
      this.req<AttachmentMeta[]>('GET', `/attachment/list/${internalId}`),

    localPath: (attachmentId: number): Promise<string | null> =>
      // No host filesystem path in web. EmailBodyFrame's cid: rewrite points
      // at the inline binary endpoint instead. (Interface is string | null.)
      Promise.resolve(`${this.baseUrl}/attachment/${attachmentId}/inline`),

    readDataUrl: (attachmentId: number): Promise<string | null> =>
      // cid:-image path. Base64 the /inline bytes (fetch → blob → dataURL),
      // mirroring ElectronApi.readDataUrl exactly and dodging the sandboxed
      // srcdoc iframe's same-origin/CSP constraints. null on any failure.
      fetchAsDataUrl(`${this.baseUrl}/attachment/${attachmentId}/inline`),

    download: (attachmentId: number): Promise<string | null> =>
      // BINARY StreamingResponse (NOT enveloped). Web has no local path, so
      // return the download URL string for the renderer's <a download> /
      // window.open affordance.
      Promise.resolve(`${this.baseUrl}/attachment/${attachmentId}/download`)
  }

  ai = {
    // Electron-main LLM logic (html block extract + pLimit + gateway); no CLI.
    translateBatch: () => notImplemented('ai.translateBatch'),

    getCached: async (
      internalId: number,
      targetLang?: TargetLang
    ): Promise<TranslationCache | null> => {
      // The ONE camelCase response data shape ({internalId,targetLang,
      // segments,source,model,fetchedAt}) — returned as-is. null on miss.
      try {
        return await this.req<TranslationCache | null>('GET', `/ai/translation/${internalId}`, {
          query: { target_lang: targetLang ?? 'zh' }
        })
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },

    deleteCached: async (internalId: number, targetLang?: TargetLang): Promise<boolean> => {
      const data = await this.req<{ deleted: boolean }>('DELETE', `/ai/translation/${internalId}`, {
        query: { target_lang: targetLang ?? 'zh' }
      })
      return data?.deleted ?? false
    },

    abortTranslate: (): void => {
      /* V2 web build would route through fetch + AbortController; stub. */
    }
  }

  // V2.1 阶段 3 — 3c-2：chat 引擎在 UI 进程跑（B-pure-unified）。chat 整面 = ChatRuntime
  // （createChatDispatcher + HttpChatPlatform + 进程内 emitter sink，shared/chat/runtime.ts）
  // 取代阶段 2 的只读 stub —— 读 + 跑单一真源 fetch serve-api。
  //
  // 🔴 lazy getter 破循环：createChatRuntime({reads:this}) 把本 HttpApi 作工具读委托
  // （runtime → new HttpChatPlatform(this) 只用 email/attachment，不回访 .chat）。electron
  // 注入的 new HttpApi(loopback) 只取 email/attachment、不访问 .chat → 其 runtime 永不构造
  // （3c-3 electron 切走自己的 createChatRuntime）；远程 web 不用 chat 时零开销。
  private _chat?: ChatApi
  get chat(): ChatApi {
    if (!this._chat) {
      this._chat = createChatRuntime({ reads: this, baseUrl: this.baseUrl })
    }
    return this._chat
  }

  llm = {
    run: (internalId: number, opts?: LlmRunOpts): Promise<unknown> =>
      this.req<unknown>('POST', `/llm/run/${internalId}`, {
        query: { dry_run: opts?.dryRun, force: opts?.force, no_overwrite: opts?.noOverwrite }
      }),

    stats: (days = 7): Promise<LlmStatsData> =>
      this.req<LlmStatsData>('GET', '/llm/stats', { query: { days } }),

    selftest: (): Promise<LlmSelfTestData> => this.req<LlmSelfTestData>('GET', '/llm/selftest'),

    listUpstreamModels: (opts?: {
      refresh?: boolean
      provider?: 'main' | 'translate'
    }): Promise<LlmUpstreamModelsData> =>
      this.req<LlmUpstreamModelsData>('GET', '/llm/models', {
        query: {
          refresh: opts?.refresh ? 'true' : undefined,
          provider: opts?.provider ?? undefined
        }
      })
  }

  // Sprint-15 write path is email.flag. The legacy notion.updateFlag endpoint
  // exists but wiring it would invite dual-write confusion — keep the stub.
  notion = {
    updateFlag: () => notImplemented('notion.updateFlag')
  }

  admin = {
    health: (): Promise<AdminHealthData> => this.req<AdminHealthData>('GET', '/admin/health'),

    stats: (): Promise<AdminStatsData> => this.req<AdminStatsData>('GET', '/admin/stats'),

    deadLetterList: (opts?: DeadLetterListOpts): Promise<DeadLetterItem[]> =>
      this.req<DeadLetterItem[]>('GET', '/admin/dead-letter', {
        query: { limit: opts?.limit, mailbox: opts?.mailbox }
      }),

    deadLetterRetry: (internalId: number): Promise<unknown> =>
      this.req<unknown>('POST', `/admin/dead-letter/${internalId}/retry`, { body: {} }),

    cleanupDeadLetter: (opts?: CleanupDeadLetterOpts): Promise<unknown> =>
      // May return HTTP 207 partial_failure → request() returns the data block.
      this.req<unknown>('POST', '/admin/cleanup-dead-letter', {
        query: { older_than: opts?.olderThan, dry_run: opts?.dryRun }
      }),

    davmailHealth: (): Promise<DavMailHealthData> =>
      this.req<DavMailHealthData>('GET', '/admin/davmail-health'),

    systemAlerts: (): Promise<SystemAlertsData> =>
      this.req<SystemAlertsData>('GET', '/admin/system-alerts')
  }

  calendar = {
    // Writes — CalDAV-write/CLI-write, deferred.
    recurringDiscover: () => notImplemented('calendar.recurringDiscover'),
    recurringReplay: () => notImplemented('calendar.recurringReplay'),
    expand: () => notImplemented('calendar.expand'),

    // Reads — implemented.
    eventsList: async (opts: EventsListOpts = {}): Promise<CalendarEventOccurrence[]> => {
      // data is {events,total,window,filters} → return data.events.
      const data = await this.req<{ events: CalendarEventOccurrence[] }>(
        'GET',
        '/calendar/events',
        {
          query: {
            fromIso: opts.fromIso,
            toIso: opts.toIso,
            calendarName: opts.calendarName,
            source: opts.source,
            expandRecurrences: opts.expandRecurrences,
            limit: opts.limit
          }
        }
      )
      return data?.events ?? []
    },

    eventGet: async (opts: EventGetOpts): Promise<CalendarEventDetail | null> => {
      try {
        const data = await this.req<{ event: CalendarEventDetail }>(
          'GET',
          `/calendar/events/${encodeURIComponent(opts.icalUid)}`,
          { query: { source: opts.source, recurrenceId: opts.recurrenceId } }
        )
        return data?.event ?? null
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },

    syncStatus: async (): Promise<CalendarSyncStateItem[]> => {
      // data.calendars → CalendarSyncStateItem[].
      const data = await this.req<{ calendars: CalendarSyncStateItem[] }>(
        'GET',
        '/calendar/sync-status'
      )
      return data?.calendars ?? []
    },

    calendarNames: (): Promise<string[]> => this.req<string[]>('GET', '/calendar/names'),

    syncTrigger: () => notImplemented('calendar.syncTrigger'),
    eventReplay: () => notImplemented('calendar.eventReplay'),
    eventRsvp: () => notImplemented('calendar.eventRsvp'),
    eventCreate: () => notImplemented('calendar.eventCreate'),
    eventUpdate: () => notImplemented('calendar.eventUpdate'),
    eventDelete: () => notImplemented('calendar.eventDelete')
  }

  // task 06-08-chat 第二波 — 远程 config: 只读配置端点接线（serve-api 读 host .env）。
  // secretsStatus / get 走 serve-api（settings AI tab loading gate）；写 + 原生 folder
  // picker + ping test 仍 stub —— 远程无 keychain / 无 .app dialog / 用 host 已配置。
  settings = {
    secretsStatus: (): Promise<SecretsStatus> =>
      this.req<SecretsStatus>('GET', '/settings/secrets-status'),
    setSecret: () => notImplemented('settings.setSecret'),
    clearSecret: () => notImplemented('settings.clearSecret'),
    get: (): Promise<PersistentSettings> => this.req<PersistentSettings>('GET', '/settings'),
    set: () => notImplemented('settings.set'),
    pickFolder: () => notImplemented('settings.pickFolder'),
    testLlm: () => notImplemented('settings.testLlm'),
    testCustomApi: () => notImplemented('settings.testCustomApi')
  }

  // No in-app updater in the browser; no endpoint. onEvent → noop unsub.
  updater = {
    // web 无 in-app updater: 返回 dev-disabled 态 (enabled:false → UpdateReadyBanner
    // 不渲染), graceful 而非 throw —— 启动期 updater state hydration 会调它。
    status: async () => ({
      state: 'dev-disabled' as const,
      currentVersion: '',
      latestVersion: null,
      downloadPercent: null,
      message: null,
      updatedAt: 0,
      enabled: false
    }),
    check: () => notImplemented('updater.check'),
    download: () => notImplemented('updater.download'),
    quitAndInstall: () => notImplemented('updater.quitAndInstall'),
    onEvent: (): (() => void) => () => undefined
  }

  // SSE bridge deferred; remote falls back to react-query polling.
  // status/reconnect stay notImplemented; onEvent/onStatus → noop unsub.
  events = {
    // web 走 react-query polling 而非 SSE: 返回 disabled 态, graceful 不 throw。
    status: async () => ({
      state: 'disabled' as const,
      lastError: null,
      lastEventTs: null,
      url: ''
    }),
    reconnect: async () => ({
      state: 'disabled' as const,
      lastError: null,
      lastEventTs: null,
      url: ''
    }),
    onEvent: (): (() => void) => () => undefined,
    onStatus: (): (() => void) => () => undefined
  }

  // task 06-08-chat Bug 6 — 远程 config: env.get 读 host .env 受管快照经 serve-api
  // （GET /api/env，secret 脱敏 + 非受管 key 不出网）。SettingsShell mount 必调它，
  // 否则 EnvField 全卡 loading。env.set 仍 stub —— 远程只读，EnvField 在 web 下控件 disabled。
  env = {
    get: (): Promise<EnvSnapshot> => this.req<EnvSnapshot>('GET', '/env'),
    set: () => notImplemented('env.set')
  }

  services = {
    restart: () => notImplemented('services.restart'),
    // web 无 pm2 服务管理: 返回空数组, graceful 不 throw。
    status: async () => []
  }

  // task 06-08-chat 第二波 — 远程 config: prompt 文件读经 serve-api（host fs，clamp
  // 在 data root）。write 仍 stub —— 远程只读 host 已配置的 prompt。
  prompts = {
    list: (): Promise<{ inbox: PromptInfo; sent: PromptInfo }> =>
      this.req<{ inbox: PromptInfo; sent: PromptInfo }>('GET', '/prompts'),
    read: (slot: PromptSlot): Promise<PromptContent> =>
      this.req<PromptContent>('GET', `/prompts/${encodeURIComponent(slot)}`),
    write: () => notImplemented('prompts.write')
  }

  // task 06-08-chat 第二波 — 远程 config: notion-agent 账户/model/agent 读经 serve-api
  // （host ~/.notionagents + CLI spawn）。getConfig 是 chat 启动 gate 第一读，必须成功。
  // doctor / setAgent / setModel 仍 stub —— 远程无 CLI 写/连通性写场景，用 host 已绑定。
  notionAgent = {
    getConfig: (): Promise<NotionAgentConfig> =>
      this.req<NotionAgentConfig>('GET', '/notion-agent/config'),
    listModels: (): Promise<string[]> => this.req<string[]>('GET', '/notion-agent/models'),
    doctor: () => notImplemented('notionAgent.doctor'),
    listAgents: (): Promise<NotionAgentListItem[]> =>
      this.req<NotionAgentListItem[]>('GET', '/notion-agent/agents'),
    setAgent: () => notImplemented('notionAgent.setAgent'),
    setModel: () => notImplemented('notionAgent.setModel')
  }

  // Ping-island lives on the Mac host; web stubs are no-ops, onEvent → noop.
  island = {
    // web 无 ping-island: 返回 disabled 态, graceful 不 throw —— TitleBar/Settings
    // mount 时 island state hydration 会调它。
    status: async () => ({
      state: 'disabled' as const,
      socketPath: '',
      lastProbeAt: null,
      lastError: null
    }),
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

  // V2.1 — 报告 Agent: serve-api /api/reports + /api/report-agents 端点（in-process
  // ReportStore + wire.py，镜像 IPC report:*）。读优雅降级（失败返 []/null → /agents 页
  // 空态，守 ReportApi「失败返 []/null」契约，与 ElectronApi 依赖 handler graceful 对齐）；
  // 写经 req() 解包 envelope（成功返 data，失败 throw，镜像 ElectronApi unwrap）。
  report: ReportApi = {
    list: async (opts?: {
      cadence?: ReportCadence
      agentId?: string
      limit?: number
    }): Promise<ReportListItem[]> => {
      try {
        return await this.req<ReportListItem[]>('GET', '/reports', {
          query: { cadence: opts?.cadence, agentId: opts?.agentId, limit: opts?.limit }
        })
      } catch {
        return []
      }
    },
    get: async (reportId: string): Promise<ReportDetail | null> => {
      try {
        return await this.req<ReportDetail>('GET', `/reports/${encodeURIComponent(reportId)}`)
      } catch {
        return null
      }
    },
    getConfig: async (): Promise<ReportAgentConfig[]> => {
      try {
        return await this.req<ReportAgentConfig[]>('GET', '/report-agents')
      } catch {
        return []
      }
    },
    setConfig: (agentId: string, patch: ReportConfigPatch): Promise<ReportAgentConfig> =>
      this.req<ReportAgentConfig>('PUT', `/report-agents/${encodeURIComponent(agentId)}`, {
        body: patch
      }),
    runNow: (agentId: string, opts?: { cadence?: ReportCadence }): Promise<ReportRunResult> =>
      this.req<ReportRunResult>('POST', `/report-agents/${encodeURIComponent(agentId)}/run`, {
        body: opts ?? {}
      }),
    delete: async (reportId: string): Promise<void> => {
      await this.req('DELETE', `/reports/${encodeURIComponent(reportId)}`)
    }
  }
}
