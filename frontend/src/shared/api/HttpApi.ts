// V2 Web SPA / PWA MailApi implementation. Built against the local FastAPI
// service (127.0.0.1:8200 via a cloudflared tunnel; default baseUrl '/api'
// for same-origin). See REMOTE-ACCESS.md §4 (data layer) +
// docs/archive/2026-05/v2-backend-sprint12-handoff.md (endpoint matrix + 减法清单).
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
// recurringDiscover/recurringReplay/expand (legacy Notion-mirror 运维面),
// folder WRITES, settings WRITE/secret, updater.*, env.set, services.*,
// notionAgent WRITES, island.*, notion.updateFlag, events.status/
// reconnect. Implemented surfaces: email/attachment (full read + write),
// ai.getCached/deleteCached, llm.run/stats/selftest, admin.*, calendar READS
// + event WRITES (阶段 3.1 #11: create/update/delete/rsvp/replay),
// folder READS, env.get (read-only .env snapshot), prompts.read/write,
// notionAgent.getConfig/listModels/listAgents, settings.get/secretsStatus.

import type {
  AgentRunHistoryItem,
  AgentRunPendingCount,
  AgentRunState,
  AgentRunToolOptions,
  ReportApi,
  ReportAgentConfig,
  ReportAgentCreateInput,
  ReportCadence,
  ReportConfigPatch,
  ReportDetail,
  ReportListItem,
  ReportPagedResult,
  ReportRunResult,
  ProjectProgressRunItem,
  AdminHealthData,
  AdminStatsData,
  AgendaEntry,
  AgendaOpts,
  AIFields,
  AttachmentMeta,
  BodyOpts,
  CalendarEventDetail,
  CalendarEventOccurrence,
  CalendarSyncStateItem,
  ChatApi,
  ConnectorApi,
  EmailCalendarLink,
  EventCreateOpts,
  EventDeleteOpts,
  EventGetOpts,
  EventReplayOpts,
  EventRsvpOpts,
  EventSourceEmail,
  EventsListOpts,
  EventUpdateOpts,
  SyncNowOpts,
  CleanupDeadLetterOpts,
  ComposeDraftOpts,
  ContactSuggestion,
  DavMailHealthData,
  DeadLetterItem,
  DeadLetterListOpts,
  DraftPlanOpts,
  SetReplySuggestionOpts,
  SetReplySuggestionResult,
  DraftPlanResult,
  EmailBody,
  EmailDetail,
  EmailFlagOpts,
  EmailPinOpts,
  EmailMeta,
  EnrichedEmailMeta,
  EnvSnapshot,
  FolderCleanupResult,
  FolderDiscoverResult,
  FolderManageResult,
  FolderPref,
  FolderPrefPatch,
  FolderPrefsResult,
  FolderSetWhitelistResult,
  FolderWhitelistResult,
  JobEnqueueResult,
  JobRecord,
  KosStatsData,
  ListOpts,
  LlmRunOpts,
  LlmSelfTestData,
  LlmStatsData,
  LlmUpstreamModelsData,
  MailApi,
  MailboxSummary,
  NlToDslResult,
  NotionAgentConfig,
  NotionAgentListItem,
  PersistentSettings,
  PromptContent,
  PromptInfo,
  PromptSlot,
  PromptWriteResult,
  ResyncOpts,
  ResyncResult,
  SearchOpts,
  SearchResult,
  SecretsStatus,
  SendEmailOpts,
  StagedAttachment,
  SystemAlertsData,
  UploadComposeAttachmentOpts,
  TargetLang,
  TranslationCache
} from './types'
import {
  fetchAsDataUrl,
  request,
  requestRaw,
  requestWithMeta,
  type QueryValue,
  type RequestOptions
} from './http_client'
import { createChatRuntime } from './chat_api'
import { createConnectorApi } from './connector_api'

function notImplemented(method: string): Promise<never> {
  // V2-Sprint 3 stub. MUST reject, never throw synchronously: every stubbed
  // surface is an async API method whose renderer call sites degrade via
  // `.catch()` / try-await. A sync throw escapes those handlers and trips the
  // React ErrorBoundary ("Something went wrong") — e.g. a stubbed method
  // called on mount when opened from remote. Rejecting keeps the failure
  // inside the promise chain so each call site can fall back to a toast.
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

  /** task 07-21 — same as `req()` but also surfaces `meta` (pagination's `total`). */
  private reqWithMeta<T>(
    method: string,
    path: string,
    opts?: RequestOptions
  ): Promise<{ data: T; meta: Record<string, unknown> }> {
    return requestWithMeta<T>(this.baseUrl, method, path, opts)
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

  /** listEnriched 专属：在共用 filter 之上多带排序键/方向。有意**不**塞进
   *  `listQuery` —— `/email/list` 没有这两个参数，往它的 query 里挂只会造出
   *  「传了但不生效」的假象。 */
  private listEnrichedQuery(opts: ListOpts): Record<string, QueryValue> {
    return { ...this.listQuery(opts), orderBy: opts.orderBy, sortDir: opts.sortDir }
  }

  email = {
    list: (opts: ListOpts): Promise<EmailMeta[]> =>
      this.req<EmailMeta[]>('GET', '/email/list', { query: this.listQuery(opts) }),

    listEnriched: (opts: ListOpts): Promise<EnrichedEmailMeta[]> =>
      this.req<EnrichedEmailMeta[]>('GET', '/email/list-enriched', {
        query: this.listEnrichedQuery(opts)
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

    get: async (internalId: number): Promise<EmailDetail | null> => {
      try {
        // Body content and summary are intentionally excluded from detail reads;
        // EmailBodyFrame loads preview/full content through email.body on demand.
        return await this.req<EmailDetail>('GET', `/email/${internalId}`, {
          query: { include: 'attachments' }
        })
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },

    body: async (internalId: number, opts?: BodyOpts): Promise<EmailBody | null> => {
      try {
        return await this.req<EmailBody>('GET', `/email/${internalId}/body`, {
          query: { format: opts?.format ?? 'markdown', mode: opts?.mode ?? 'full' }
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
      // `mode:'raw'` → serve-api `raw=true` (跳过 DSL 解析, 直传 FTS5); `smart`/
      // 未传 → 省略 raw (默认 smart)。req query builder 丢 undefined。
      this.req<SearchResult>('GET', '/email/search', {
        query: {
          q: opts.query,
          mailbox: opts.mailbox,
          since: opts.since,
          until: opts.until,
          limit: opts.limit,
          raw: opts.mode === 'raw' ? true : undefined
        }
      }),

    contactSuggest: async (
      q: string,
      limit?: number,
      exclude?: string | string[]
    ): Promise<ContactSuggestion[]> => {
      const data = await this.req<{ items: ContactSuggestion[] }>('GET', '/email/contacts', {
        query: { q, limit, exclude }
      })
      return data.items
    },

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

    // F1 — persist a user-edited reply suggestion to the SSoT. davmail-only
    // write; serve-api requires write auth (a remote CF-cookie tab may lack it →
    // the caller catches and keeps the local committed edit for the session).
    setReplySuggestion: (opts: SetReplySuggestionOpts): Promise<SetReplySuggestionResult> =>
      this.req<SetReplySuggestionResult>('POST', `/email/${opts.internalId}/reply-suggestion`, {
        body: { replySuggestionMd: opts.body }
      }),

    draft: (opts: ComposeDraftOpts): Promise<unknown> =>
      // davmail-only. internalId + bodyHtml in BODY (server writes a tmp
      // .html → --body-html-file). Throws Error & { code } on failure.
      this.req<unknown>('POST', '/email/draft', { body: opts }),

    deleteDraft: (internalId: number): Promise<unknown> =>
      // 草稿真删除 (IMAP \Deleted+EXPUNGE + 本地行清理)。davmail-only,
      // 仅 mailbox=草稿箱 (否则 E_INVALID_ARG)。
      this.req<unknown>('DELETE', `/email/draft/${internalId}`),

    send: (opts: SendEmailOpts): Promise<unknown> =>
      // Irreversible SMTP send. Server always passes --yes (the renderer
      // shows SendConfirmDialog first — there is no flag to suppress send).
      this.req<unknown>('POST', '/email/send', { body: opts }),

    uploadComposeAttachment: (opts: UploadComposeAttachmentOpts): Promise<StagedAttachment> =>
      // D1 — staging 上传: raw bytes PUT (application/octet-stream, 服务端无
      // python-multipart), filename/mime 走 query。响应仍是标准 envelope。
      requestRaw<StagedAttachment>(
        this.baseUrl,
        'PUT',
        '/email/compose-attachment',
        new Uint8Array(opts.bytes),
        'application/octet-stream',
        { query: { filename: opts.filename, mime: opts.mime } }
      ),

    draftPlan: (opts: DraftPlanOpts): Promise<DraftPlanResult> =>
      // dry-run, read-only, no auth. The response is snake_case and MUST stay
      // snake_case (reply_html / forward_intro_html / reply_source) — request
      // does no case transform, so this is returned as-is.
      this.req<DraftPlanResult>('POST', `/email/${opts.internalId}/draft-plan`, {
        body: { mode: opts.mode }
      }),

    pin: async (
      internalId: number,
      pinned: boolean,
      opts?: EmailPinOpts
    ): Promise<boolean | null> => {
      // Body parity with write_ops.runPin — only send the optional keys when
      // set so the single-row wire stays byte-identical to before.
      const body: Record<string, unknown> = { pinned }
      if (opts?.ids && opts.ids.length > 0) body.ids = opts.ids
      if (opts?.cascadeThread) body.cascadeThread = true
      try {
        const data = await this.req<{
          internal_id: number
          is_pinned: boolean
          changed: boolean
          dry_run: boolean
        }>('POST', `/email/${internalId}/pin`, { body })
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
      // Thread cascade (虚拟头「标完成」) — only sent when set, keeping the
      // historical single-row wire byte-identical.
      if (opts.cascadeThread) body.cascadeThread = true

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
      }),

    // P4b — AI 自然语言检索: web SPA 进程内无 LLM key/端点 (key 在 main 进程的
    // keychain/.env, 远程 serve-api 也不暴露该桥)。返回结构化 E_UNSUPPORTED 而非
    // reject, 让 CommandPalette 走同一条 banner 提示路径 (与无 key 一致体验)。
    nlToDsl: (_nl: string): Promise<NlToDslResult> =>
      Promise.resolve({
        dsl: '',
        error: 'E_UNSUPPORTED',
        message: 'AI search is only available in the desktop app'
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
    discover: (opts?: { counts?: boolean; refresh?: boolean }): Promise<FolderDiscoverResult> =>
      this.req<FolderDiscoverResult>('GET', '/folder/discover', {
        // 后端默认 counts=false (issue #45: 大邮箱逐文件夹 STATUS 分钟级);
        // 显式传以保持 wire 清晰, counts:true 仍可 opt-in。
        // refresh=true 穿透服务端 60s TTL 缓存 (设置页文件夹管理用)。
        query: { counts: opts?.counts ?? false, refresh: opts?.refresh ?? false }
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
      }),

    // per-folder 配置 (v62) — 纯本地 SQLite, 不 davmail-gated。
    getPrefs: (): Promise<FolderPrefsResult> => this.req<FolderPrefsResult>('GET', '/folder/prefs'),

    // 🔴 patch 原样透传: 省略的字段后端保持原值, `icon: null` 是**清除图标**。
    // 不要在这里补默认值 —— 补了就把"没改的项"变成"改成默认值"。
    setPref: (imapName: string, patch: FolderPrefPatch): Promise<FolderPref> =>
      this.req<FolderPref>('PUT', '/folder/prefs', {
        body: { imap_name: imapName, ...patch }
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

  // V2.1 阶段 3 / S3 — chat 整面 = ChatRuntime（serve-api 直 fetch 薄传输面，
  // shared/api/chat_api.ts）。S3 删 legacy 引擎后 chat turn 全跑 embedded AI SDK
  // Gateway（远程 web 经 serve-api ai_gateway_proxy 同源代理），本面只剩会话/skill/
  // profile 等 fetch 方法。lazy getter：远程 web 不用 chat 时零开销。
  private _chat?: ChatApi
  get chat(): ChatApi {
    if (!this._chat) {
      this._chat = createChatRuntime({ baseUrl: this.baseUrl })
    }
    return this._chat
  }

  // 08-01 PR4 — MCP connector 设置面（serve-api `/api/connector/*` 薄 fetch 面）。
  // lazy getter 同 chat：构造期 `this.baseUrl` 还没赋值（参数属性在字段初始化之后才写），
  // 且远程 web 不开设置页时零开销。
  private _connector?: ConnectorApi
  get connector(): ConnectorApi {
    if (!this._connector) {
      this._connector = createConnectorApi(this.baseUrl)
    }
    return this._connector
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

  // issue #59 — KOS 入库台账统计。桌面走 IPC kos:stats → CLI, 远程 web 走这里;
  // 两端最终都落到同一个 src/kos/stats.py 聚合函数, SQL 不手抄第二份。
  kos = {
    stats: (days = 7): Promise<KosStatsData> =>
      this.req<KosStatsData>('GET', '/kos/stats', { query: { days } })
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

    deadLetterDelete: (internalId: number): Promise<unknown> =>
      this.req<unknown>('POST', `/admin/dead-letter/${internalId}/delete`, { body: {} }),

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
      // C7: serve-api 把 CalendarEventOccurrence[] 放进 envelope.data（裸数组，
      // total/window/filters 落 meta）。req() 已解到 .data，直接当数组用——
      // 旧代码再取 .events 对裸数组永远 undefined → 远程日历永远空。
      const data = await this.req<CalendarEventOccurrence[]>('GET', '/calendar/events', {
        query: {
          fromIso: opts.fromIso,
          toIso: opts.toIso,
          calendarName: opts.calendarName,
          source: opts.source,
          expandRecurrences: opts.expandRecurrences,
          limit: opts.limit
        }
      })
      return data ?? []
    },

    // task 08-27 P3 — 三源聚合 (月/日/周视图 + 二级栏源树)。C7: serve-api 把
    // AgendaEntry[] 放进 envelope.data (total/window/sources 落 meta)。
    // 🔴 path/query 与 Electron 侧 calendar:agenda handler (daemon_api 转发)
    // 严格 mirror, 改 wire 时两处同步。
    agenda: async (opts: AgendaOpts): Promise<AgendaEntry[]> => {
      const data = await this.req<AgendaEntry[]>('GET', '/calendar/agenda', {
        query: {
          fromIso: opts.fromIso,
          toIso: opts.toIso,
          sources: opts.sources?.join(','),
          calendarName: opts.calendarName,
          tz: opts.tz
        }
      })
      return data ?? []
    },

    eventGet: async (opts: EventGetOpts): Promise<CalendarEventDetail | null> => {
      try {
        // C7: serve-api 返裸 CalendarEventDetail 进 envelope.data（非 {event}）。
        const data = await this.req<CalendarEventDetail>(
          'GET',
          `/calendar/events/${encodeURIComponent(opts.icalUid)}`,
          { query: { source: opts.source, recurrenceId: opts.recurrenceId } }
        )
        return data ?? null
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },

    syncStatus: async (): Promise<CalendarSyncStateItem[]> => {
      // C7: serve-api 返裸 CalendarSyncStateItem[] 进 envelope.data
      // （total/worker_enabled 落 meta）。req() 已解到 .data。
      const data = await this.req<CalendarSyncStateItem[]>('GET', '/calendar/sync-status')
      return data ?? []
    },

    // 阶段 2.1 (P1-3) — 邮件 ↔ 日历 ical_uid 双向反查。C7: serve-api 返裸
    // EmailCalendarLink / EventSourceEmail 进 envelope.data; 404 (无映射) → null。
    emailCalendarLink: async (internalId: number): Promise<EmailCalendarLink | null> => {
      try {
        const data = await this.req<EmailCalendarLink>('GET', `/calendar/email-link/${internalId}`)
        return data ?? null
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },

    eventSourceEmail: async (icalUid: string): Promise<EventSourceEmail | null> => {
      try {
        const data = await this.req<EventSourceEmail>(
          'GET',
          `/calendar/events/${encodeURIComponent(icalUid)}/source-email`
        )
        return data ?? null
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },

    calendarNames: (): Promise<string[]> => this.req<string[]>('GET', '/calendar/names'),

    // 远程手动触发 CalDAV → SQLite 同步 (serve-api POST /calendar/sync-trigger,
    // 后端 asyncio.to_thread 跑 CalendarService.sync_now)。data = sync_now 结果 dict,
    // 直接当 unknown 透传 (对齐 ElectronApi calendar:syncTrigger 的 WriteEnvelope)。
    syncTrigger: (opts: SyncNowOpts = {}): Promise<unknown> =>
      this.req<unknown>('POST', '/calendar/sync-trigger', {
        body: { full: opts.full, calendarName: opts.calendarName }
      }),

    // 阶段 3.1 (#11) — event 写路径 (serve-api calendar 写端点)。契约与
    // ElectronApi (calendar-write IPC → fork CLI) 1:1: body 原样 camelCase 透传,
    // 服务端逐字镜像 CLI `calendar create/update/delete/rsvp/replay` 语义
    // (update 三分支 recurrenceId/splitFuture、attendees 三态 [缺席/空数组=不动,
    // clearAttendees=清空, 列表=替换]、rrule ''=删除、isAllDay VALUE=DATE、
    // rsvp response alias→PARTSTAT)。返回 envelope.data = CLI emit 的 data。
    eventReplay: (opts: EventReplayOpts): Promise<unknown> =>
      this.req<unknown>('POST', `/calendar/events/${encodeURIComponent(opts.icalUid)}/replay`, {
        body: { recurrenceId: opts.recurrenceId, source: opts.source, dryRun: opts.dryRun }
      }),

    eventRsvp: (opts: EventRsvpOpts): Promise<unknown> =>
      // ⚠️ 非 dry-run = 真发 iTIP REPLY 信给组织者, 不可撤回 (调用侧确认卡把关)。
      this.req<unknown>('POST', `/calendar/events/${encodeURIComponent(opts.icalUid)}/rsvp`, {
        body: {
          response: opts.response,
          recurrenceId: opts.recurrenceId,
          source: opts.source,
          dryRun: opts.dryRun
        }
      }),

    eventCreate: (opts: EventCreateOpts): Promise<unknown> =>
      this.req<unknown>('POST', '/calendar/events', { body: opts }),

    eventUpdate: (opts: EventUpdateOpts): Promise<unknown> => {
      const { icalUid, ...body } = opts
      return this.req<unknown>('PATCH', `/calendar/events/${encodeURIComponent(icalUid)}`, { body })
    },

    eventDelete: (opts: EventDeleteOpts): Promise<unknown> =>
      // 硬删 (CalDAV DELETE); 5 秒撤销窗口在调用侧, 发出即确认 (= CLI --yes)。
      this.req<unknown>('DELETE', `/calendar/events/${encodeURIComponent(opts.icalUid)}`, {
        query: { calendarName: opts.calendarName }
      })
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
  // 在 data root）。v1.3.0 dogfood — write 也接真端点（PUT /prompts/{slot}，预处理抽屉
  // 分类 prompt 可编辑）；错误不 throw 而是折回 {ok:false} union，镜像 ElectronApi
  // prompts:write 的 PromptWriteResult 形状（call site 统一 `if (!r.ok)` 处理）。
  prompts = {
    read: (slot: PromptSlot): Promise<PromptContent> =>
      this.req<PromptContent>('GET', `/prompts/${encodeURIComponent(slot)}`),
    write: async (slot: PromptSlot, content: string): Promise<PromptWriteResult> => {
      try {
        const info = await this.req<PromptInfo>('PUT', `/prompts/${encodeURIComponent(slot)}`, {
          body: { content }
        })
        return { ok: true, info }
      } catch (e) {
        const err = e as { code?: string; message?: string }
        return { ok: false, code: err.code ?? 'E_WRITE', message: err.message ?? String(e) }
      }
    }
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
  // ReportStore + wire.py，镜像 IPC report:*）。读优雅降级（失败返 []/null/{items:[],total:0}
  // → /agents 页空态，守 ReportApi「失败返空」契约，与 ElectronApi 依赖 handler graceful 对齐）；
  // 写经 req() 解包 envelope（成功返 data，失败 throw，镜像 ElectronApi unwrap）。
  // task 07-21：list/listRuns 改走 reqWithMeta（meta.total 供分页/总数展示），data 形状仍是
  // bare 数组不变（后端向后兼容），前端把 {data, meta.total} 折成 { items, total }。
  report: ReportApi = {
    list: async (opts?: {
      cadence?: ReportCadence
      agentId?: string
      limit?: number
      offset?: number
    }): Promise<ReportPagedResult<ReportListItem>> => {
      try {
        const { data, meta } = await this.reqWithMeta<ReportListItem[]>('GET', '/reports', {
          query: {
            cadence: opts?.cadence,
            agentId: opts?.agentId,
            limit: opts?.limit,
            offset: opts?.offset
          }
        })
        return { items: data, total: typeof meta.total === 'number' ? meta.total : data.length }
      } catch {
        return { items: [], total: 0 }
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
    runNow: async (
      agentId: string,
      opts?: { cadence?: ReportCadence; type?: string }
    ): Promise<ReportRunResult> => {
      if (opts?.type === 'custom') {
        // custom agent：enqueue 一次 headless run → { jobId }；映射进 ReportRunResult
        // （report_id=jobId）走统一 run-now 出口。调用方只需成功信号 + refetch 历史，
        // 真实读态经 listRuns（derive_agent_run_state），此处 status 仅占位。
        const res = await this.req<{ jobId?: number }>(
          'POST',
          `/report-agents/${encodeURIComponent(agentId)}/run`,
          { body: {} }
        )
        return { report_id: String(res.jobId ?? ''), status: 'generating', headline: '' }
      }
      return this.req<ReportRunResult>(
        'POST',
        `/report-agents/${encodeURIComponent(agentId)}/run`,
        { body: opts ?? {} }
      )
    },
    delete: async (reportId: string): Promise<void> => {
      await this.req('DELETE', `/reports/${encodeURIComponent(reportId)}`)
    },
    createAgent: (input: ReportAgentCreateInput): Promise<ReportAgentConfig> =>
      this.req<ReportAgentConfig>('POST', '/report-agents', {
        // serve-api create_agent 读 tools_json（数组）key；input.tools 映射过去。
        body: {
          id: input.id,
          type: input.type ?? 'search',
          title: input.title,
          enabled: input.enabled,
          model: input.model,
          prompt: input.prompt,
          tools_json: input.tools
        }
      }),
    deleteAgent: (agentId: string): Promise<{ deleted: string }> =>
      this.req<{ deleted: string }>('DELETE', `/report-agents/${encodeURIComponent(agentId)}`),
    listRuns: async (opts?: {
      agentId?: string
      limit?: number
      offset?: number
      state?: AgentRunState
    }): Promise<ReportPagedResult<AgentRunHistoryItem>> => {
      try {
        const { data, meta } = await this.reqWithMeta<AgentRunHistoryItem[]>('GET', '/agent-runs', {
          query: {
            agentId: opts?.agentId,
            limit: opts?.limit,
            offset: opts?.offset,
            state: opts?.state
          }
        })
        return { items: data, total: typeof meta.total === 'number' ? meta.total : data.length }
      } catch {
        // flag off → 404 / serve-api 不可达 → 空态（守 ReportApi「读失败返 []」契约）。
        return { items: [], total: 0 }
      }
    },
    pendingCount: async (): Promise<AgentRunPendingCount> => {
      try {
        return await this.req<AgentRunPendingCount>('GET', '/agent-runs/pending-count')
      } catch {
        // flag off / serve-api 不可达 → 零计数（守读优雅降级，红点不渲染）。
        return { total: 0, byAgent: {} }
      }
    },
    toolOptions: async (): Promise<AgentRunToolOptions> => {
      try {
        return await this.req<AgentRunToolOptions>('GET', '/agent-runs/tool-options')
      } catch {
        // flag off / 端点未就绪 → 空清单（守读优雅降级，不硬编码工具名）。
        return { tools: [], defaults: [] }
      }
    },
    projectProgressRuns: async (limit?: number): Promise<ProjectProgressRunItem[]> => {
      try {
        return await this.req<ProjectProgressRunItem[]>('GET', '/project-progress/runs', {
          query: { limit }
        })
      } catch {
        // serve-api 不可达 / 表不存在 → 空态（守 ReportApi「读失败返 []」契约）。
        return []
      }
    }
  }
}
