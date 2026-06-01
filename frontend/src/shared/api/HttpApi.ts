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
// WRITES, folder WRITES, settings WRITE/secret, updater.*, env.*, services.*,
// prompts.*, notionAgent.*, island.*, notion.updateFlag, events.status/
// reconnect. Implemented surfaces: email/attachment (full read + write),
// ai.getCached/deleteCached, llm.run/stats/selftest, admin.*, calendar READS,
// folder READS.

import type {
  AdminHealthData,
  AdminStatsData,
  AIFields,
  AttachmentMeta,
  BodyOpts,
  CalendarEventDetail,
  CalendarEventOccurrence,
  CalendarSyncStateItem,
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
  FolderEmailDetail,
  FolderEmailMeta,
  FolderListOpts,
  FolderSearchOpts,
  FolderSearchResult,
  FolderSyncStatusResult,
  ListOpts,
  LlmRunOpts,
  LlmSelfTestData,
  LlmStatsData,
  MailApi,
  MailboxSummary,
  ResyncOpts,
  ResyncResult,
  SearchOpts,
  SearchResult,
  SendEmailOpts,
  SystemAlertsData,
  TargetLang,
  TranslationCache
} from './types'
import { fetchAsDataUrl, request, type QueryValue, type RequestOptions } from './http_client'

function notImplemented(method: string): never {
  throw new Error(`HttpApi.${method}() not implemented yet (V2-Sprint 3)`)
}

/** True only for an ApiError whose code === 'E_NOT_FOUND'. Used by the few
 *  methods whose interface returns `T | null` on a missing row (email.get,
 *  email.body, email.pin, calendar.eventGet, folder.get) — mirrors
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
      this.req<unknown>('POST', `/email/${internalId}/archive`, { body: {} })
  }

  // Phase C — 存档 / 草稿箱. READS implemented (better-sqlite3-backed FastAPI
  // routes); WRITES stay stubbed (CalDAV/IMAP-write CLI forks on the Mac host).
  folder = {
    list: (opts: FolderListOpts): Promise<FolderEmailMeta[]> =>
      this.req<FolderEmailMeta[]>('GET', `/folder/${opts.folder}/list`, {
        query: { limit: opts.limit, offset: opts.offset }
      }),

    get: async (id: number): Promise<FolderEmailDetail | null> => {
      // FolderApi.get(id) carries only the numeric row id. The backend
      // /folder/by-id/{id} route resolves the folder from the folder_email
      // row (mirrors Electron folder:get(id)); the old /folder/_/{id} path
      // tripped _validate_folder('_') → 400.
      try {
        return await this.req<FolderEmailDetail>('GET', `/folder/by-id/${id}`)
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },

    search: (opts: FolderSearchOpts): Promise<FolderSearchResult> =>
      this.req<FolderSearchResult>('GET', `/folder/${opts.folder ?? '_'}/search`, {
        query: { q: opts.query, raw: opts.raw, limit: opts.limit }
      }),

    syncStatus: (): Promise<FolderSyncStatusResult> =>
      // Returns the whole {states, counts} shape.
      this.req<FolderSyncStatusResult>('GET', '/folder/sync-status'),

    // Writes — CLI-write/CalDAV-write, deferred.
    syncNow: () => notImplemented('folder.syncNow'),
    deleteMsg: () => notImplemented('folder.deleteMsg'),
    move: () => notImplemented('folder.move'),
    sendDraft: () => notImplemented('folder.sendDraft'),
    createDraft: () => notImplemented('folder.createDraft'),
    editDraft: () => notImplemented('folder.editDraft')
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

  // Sprint 4 §2.1 — AI Chat. SSE deferred to V2.1; all chat methods stay as
  // notImplemented / noop stubs (kosAvailable→false so the save button doesn't
  // render, listToolCalls→[], confirmTool→ok:false, onStream→noop unsub).
  chat = {
    start: () => notImplemented('chat.start'),
    abort: () => {
      /* no-op stub */
    },
    listMessages: () => notImplemented('chat.listMessages'),
    listSessions: () => notImplemented('chat.listSessions'),
    listAllSessions: () => notImplemented('chat.listAllSessions'),
    editMessage: () => notImplemented('chat.editMessage'),
    openPopout: () => {
      /* no-op stub — no second-window in V2 web SPA */
    },
    deleteSession: () => {
      /* no-op stub */
    },
    newSession: () => notImplemented('chat.newSession'),
    saveToKos: () => notImplemented('chat.saveToKos'),
    kosAvailable: async () => false,
    listToolCalls: async () => [],
    confirmTool: async () => ({
      ok: false as const,
      code: 'E_NOT_IMPLEMENTED',
      message: 'chat.confirmTool not implemented in HttpApi stub'
    }),
    onStream: (): (() => void) => () => undefined
  }

  llm = {
    run: (internalId: number, opts?: LlmRunOpts): Promise<unknown> =>
      this.req<unknown>('POST', `/llm/run/${internalId}`, {
        query: { dry_run: opts?.dryRun, force: opts?.force, no_overwrite: opts?.noOverwrite }
      }),

    stats: (days = 7): Promise<LlmStatsData> =>
      this.req<LlmStatsData>('GET', '/llm/stats', { query: { days } }),

    selftest: (): Promise<LlmSelfTestData> => this.req<LlmSelfTestData>('GET', '/llm/selftest')
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

  // No OS keychain / native folder picker on web — all writes + secret slots
  // stay stubbed. settings.get has no endpoint yet; keep stub for now.
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

  // No in-app updater in the browser; no endpoint. onEvent → noop unsub.
  updater = {
    status: () => notImplemented('updater.status'),
    check: () => notImplemented('updater.check'),
    download: () => notImplemented('updater.download'),
    quitAndInstall: () => notImplemented('updater.quitAndInstall'),
    onEvent: (): (() => void) => () => undefined
  }

  // SSE bridge deferred; remote falls back to react-query polling.
  // status/reconnect stay notImplemented; onEvent/onStatus → noop unsub.
  events = {
    status: () => notImplemented('events.status'),
    reconnect: () => notImplemented('events.reconnect'),
    onEvent: (): (() => void) => () => undefined,
    onStatus: (): (() => void) => () => undefined
  }

  // No `.env` access / pm2 spawn from a remote browser; no endpoint.
  env = {
    get: () => notImplemented('env.get'),
    set: () => notImplemented('env.set')
  }

  services = {
    restart: () => notImplemented('services.restart'),
    status: () => notImplemented('services.status')
  }

  // No host fs access to the Mac's prompt files; no endpoint.
  prompts = {
    list: () => notImplemented('prompts.list'),
    read: () => notImplemented('prompts.read'),
    write: () => notImplemented('prompts.write')
  }

  // Notion Agent CLI is Mac-host-only (~/.notionagents + local binary).
  notionAgent = {
    getConfig: () => notImplemented('notionAgent.getConfig'),
    listModels: () => notImplemented('notionAgent.listModels'),
    doctor: () => notImplemented('notionAgent.doctor'),
    listAgents: () => notImplemented('notionAgent.listAgents'),
    setAgent: () => notImplemented('notionAgent.setAgent'),
    setModel: () => notImplemented('notionAgent.setModel')
  }

  // Ping-island lives on the Mac host; web stubs are no-ops, onEvent → noop.
  island = {
    status: () => notImplemented('island.status'),
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
}
