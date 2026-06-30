// chat-panel P4 Phase 03a — MailAgentDomainClient (AI SDK Gateway → Python serve-api).
//
// The AI SDK Gateway read tools (frontend/src/ai-gateway/tools/*) reach the
// MailAgent domain through this typed HTTP client — never SQLite directly. It is
// pure Node (global `fetch`, no electron/keytar/chat_db), so the gateway core stays
// harness-testable; the Electron wrapper (ai_gateway_lifecycle.ts) constructs one
// with the loopback serve-api base URL (resolveApiPort) + the same-machine local
// token (local_token.ts) and injects it into the tool registry.
//
// 🔴 Auth: every request carries the `X-MailAgent-Local-Token` header (mirrors
//    src/api/auth.py's local-token leg). The token lives only in main; the renderer
//    never sees it. loopback ≠ safe → the custom header is the CSRF guard.
//
// 🔴 Wire-param fidelity (spike-discovered, see the per-endpoint notes): the serve-api
//    read endpoints use INCONSISTENT param names — /email/list takes camelCase aliases
//    (sinceDate/fromAddr/isRead), /email/search takes `q`/`since`/`until`,
//    /attachment/search takes `q`. The methods below encode the exact wire names so a
//    gateway tool's result matches the legacy HttpChatPlatform byte-for-byte (parity).

import type {
  EmailGet_EmailRecord,
  EmailList_EmailListItem,
  MailagentEmailBody
} from '@shared/types/cli.gen'
import type { ReportDetail, ReportListItem, SearchResult } from '@shared/api/types'

/** A serve-api domain error surfaced to the caller (tool execute turns it into a
 *  tool-error part). Mirrors the http_client ApiError shape ({code, message, hint?,
 *  httpStatus?}). `code` is the serve-api envelope error code (E_NOT_FOUND /
 *  E_INVALID_ARG / E_KOS_* / E_UPSTREAM / E_INTERNAL / E_NETWORK …). */
export class DomainError extends Error {
  readonly code: string
  readonly hint?: string
  readonly httpStatus?: number
  constructor(code: string, message: string, opts?: { hint?: string; httpStatus?: number }) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.hint = opts?.hint
    this.httpStatus = opts?.httpStatus
  }
}

type QueryValue = string | number | boolean | undefined | null

export interface DomainClientConfig {
  /** serve-api base URL incl. the /api prefix, e.g. http://127.0.0.1:8200/api. */
  baseUrl: string
  /** X-MailAgent-Local-Token value (main-process ephemeral token). null → header
   *  omitted (dev / pm2 backend where the local-token leg is disabled). */
  localToken: string | null
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/** Search filters for the metadata-filter email list (email_search tool). */
export interface DomainEmailListOpts {
  subject?: string
  fromAddr?: string
  mailbox?: string
  sinceDate?: string
  untilDate?: string
  isRead?: boolean
  isFlagged?: boolean
  limit?: number
}

/** Search filters for FTS (email_search_fulltext / email_search_attachments). */
export interface DomainSearchOpts {
  query: string
  mailbox?: string
  since?: string
  until?: string
  limit?: number
}

/** Filters for report_list. */
export interface DomainReportListOpts {
  cadence?: 'daily' | 'weekly' | 'monthly'
  agentId?: string
  limit?: number
}

// ── write-endpoint shapes (Phase 03b) — mirror the legacy ChatToolPlatform data
//    blocks (shared/chat/tools/builtin/write.ts) byte-for-byte so a gateway write
//    tool's massaged output matches the legacy tool's (parity). ──────────────────

/** email_flag patch — only the provided fields go on the wire (mirrors HttpApi.flag). */
export interface DomainFlagPatch {
  isRead?: boolean
  isFlagged?: boolean
  processingStatus?: string
}

/** POST /email/{id}/flag data block (FlagResult — the relevant subset the tool reads). */
export interface DomainFlagResult {
  updated_ids?: number[]
  outbox_entries?: unknown[]
}

/** POST /email/{id}/archive | /move data block (Archive/MoveResult). */
export interface DomainArchiveResult {
  from_mailbox?: string | null
  to_mailbox?: string | null
  notion_updated?: boolean
}

/** POST /email/{id}/pin data block (PinResult). */
export interface DomainPinResult {
  is_pinned?: boolean
  changed?: boolean
}

/** POST /email/{id}/resync data block (ResyncResult). */
export interface DomainResyncResult {
  old_page_id?: string | null
  new_page_id?: string | null
  action?: string
}

/** Projected reply-draft result — mirrors HttpChatPlatform.draftReply's projection of
 *  the POST /email/draft data block ({internal_id, drafts_folder?, method?}). */
export interface DomainDraftResult {
  internalId: number
  mailbox: string | null
  accountName: string | null
  draftId: string
}

/** POST /email/send-approved request body (Phase 04b). The outbound fields + the double-guard
 *  envelope (content hash + idempotency key + HMAC approval token + expiry) the Python guard
 *  re-verifies before a real SMTP send. */
export interface DomainSendApprovedRequest {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  bodyText: string
  /** Optional source-email context (audit / threading); the send itself is a fresh 'new'
   *  compose using the explicit recipients/subject/body. -1 = no source. */
  internalId: number
  contentHash: string
  idempotencyKey: string
  approvalToken: string
  expiresAt: number
}

/** POST /email/send-approved data block (the relevant subset the tool reads). */
export interface DomainSendApprovedResult {
  sent?: boolean
  message_id?: string | null
  archived_to_sent?: boolean
  method?: string | null
  to_count?: number
  cc_count?: number
}

const LOCAL_TOKEN_HEADER = 'X-MailAgent-Local-Token'

function buildQuery(query: Record<string, QueryValue>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    // String(false) → 'false' / String(10) → '10' — the wire form serve-api expects.
    params.set(k, String(v))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

/**
 * Typed HTTP client to the Python serve-api read endpoints. Each method maps one
 * tool's primitive to one endpoint, unwrapping the `{status, data, error}` envelope
 * (returns `data` on success/partial_failure, throws DomainError on `status:error`).
 */
/** M4b — one Standing Context doc (soul/agent/rules/user) from /agent/profile/docs/{name}. */
export interface DomainProfileDocResult {
  docName: string
  content: string
  contentHash: string
  updatedBy: string
  updatedAt: string | null
  editable: boolean
}

/** M4c — one resolved skill from /agent/skills (discover_skills projection). */
export interface DomainResolvedSkill {
  name: string
  title: string
  description: string
  defaultEnabled: boolean
  enabled: boolean
  overridden: boolean
  available: boolean
  unavailableReason: string | null
  toolCount: number
  scopes: string[]
  sourceType: string
}

export class MailAgentDomainClient {
  private readonly baseUrl: string
  private readonly localToken: string | null
  private readonly fetchImpl: typeof fetch

  constructor(config: DomainClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.localToken = config.localToken
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  /** Core request: build URL + query, inject the local token, parse the envelope. */
  private async _req<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, QueryValue>; body?: unknown; signal?: AbortSignal }
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${opts?.query ? buildQuery(opts.query) : ''}`
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.localToken) headers[LOCAL_TOKEN_HEADER] = this.localToken
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json'

    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts?.signal
      })
    } catch (e) {
      // Network failure / abort. Re-throw abort as-is (AI SDK / caller distinguishes
      // it); other fetch failures become a typed E_NETWORK DomainError.
      if (e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))) throw e
      throw new DomainError('E_NETWORK', e instanceof Error ? e.message : String(e))
    }

    let parsed: unknown
    try {
      parsed = await resp.json()
    } catch {
      // Non-JSON body. If the status was an error, synthesize one; success non-JSON
      // shouldn't happen for these envelope endpoints.
      if (!resp.ok) {
        throw new DomainError('E_UPSTREAM', `serve-api ${resp.status} (non-JSON body)`, {
          httpStatus: resp.status
        })
      }
      throw new DomainError('E_SCHEMA_MISMATCH', 'serve-api returned a non-JSON success body')
    }

    const envelope = parsed as {
      status?: string
      data?: unknown
      error?: { code?: string; message?: string; hint?: string }
    }
    if (envelope.status === 'success' || envelope.status === 'partial_failure') {
      return envelope.data as T
    }
    // status:error (or missing/unknown status) → typed DomainError.
    const err = envelope.error ?? {}
    throw new DomainError(err.code ?? 'E_UPSTREAM', err.message ?? `serve-api ${resp.status}`, {
      hint: err.hint,
      httpStatus: resp.status
    })
  }

  // ── read primitives (one per gateway read tool) ──────────────────────────

  /** email_search — metadata-filter list. GET /email/list (camelCase alias query). */
  searchEmails(
    opts: DomainEmailListOpts,
    signal?: AbortSignal
  ): Promise<EmailList_EmailListItem[]> {
    return this._req<EmailList_EmailListItem[]>('GET', '/email/list', {
      query: {
        subject: opts.subject,
        fromAddr: opts.fromAddr,
        mailbox: opts.mailbox,
        sinceDate: opts.sinceDate,
        untilDate: opts.untilDate,
        isRead: opts.isRead,
        isFlagged: opts.isFlagged,
        limit: opts.limit
      },
      signal
    })
  }

  /** email_search_fulltext — FTS body search. GET /email/search (param is `q`). */
  searchEmailsFulltext(opts: DomainSearchOpts, signal?: AbortSignal): Promise<SearchResult> {
    return this._req<SearchResult>('GET', '/email/search', {
      query: {
        q: opts.query,
        mailbox: opts.mailbox,
        since: opts.since,
        until: opts.until,
        limit: opts.limit
      },
      signal
    })
  }

  /** email_get — single email metadata. GET /email/{id}?include=body,attachments.
   *  E_NOT_FOUND → null (mirrors httpApi.email.get). */
  async getEmail(internalId: number, signal?: AbortSignal): Promise<EmailGet_EmailRecord | null> {
    try {
      return await this._req<EmailGet_EmailRecord>('GET', `/email/${internalId}`, {
        query: { include: 'body,attachments' },
        signal
      })
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  }

  /** email_body — markdown body. GET /email/{id}/body?format=markdown.
   *  E_NOT_FOUND → null (mirrors httpApi.email.body). */
  async getEmailBody(
    internalId: number,
    signal?: AbortSignal
  ): Promise<NonNullable<MailagentEmailBody['data']> | null> {
    try {
      return await this._req<NonNullable<MailagentEmailBody['data']>>(
        'GET',
        `/email/${internalId}/body`,
        { query: { format: 'markdown' }, signal }
      )
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  }

  /** email_list_thread — sibling emails by thread_id. GET /email/thread/{tid}. */
  listEmailsByThread(threadId: string, signal?: AbortSignal): Promise<EmailList_EmailListItem[]> {
    return this._req<EmailList_EmailListItem[]>(
      'GET',
      `/email/thread/${encodeURIComponent(threadId)}`,
      { signal }
    )
  }

  /** email_search_attachments — FTS over extracted attachment text. GET /attachment/search
   *  (param is `q`). The result is passed through to the model untyped (unknown). */
  searchAttachments(opts: DomainSearchOpts, signal?: AbortSignal): Promise<unknown> {
    return this._req<unknown>('GET', '/attachment/search', {
      query: {
        q: opts.query,
        mailbox: opts.mailbox,
        since: opts.since,
        until: opts.until,
        limit: opts.limit
      },
      signal
    })
  }

  /** kos_query — KOS tool proxy. POST /chat/kos-call {name, args}. Returns the raw
   *  KOS result (list/dict/str). E_KOS_* errors surface as DomainError. */
  kosCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this._req<unknown>('POST', '/chat/kos-call', { body: { name, args }, signal })
  }

  /** report_list — generated reports. GET /reports (agentId alias). */
  listReports(opts: DomainReportListOpts, signal?: AbortSignal): Promise<ReportListItem[]> {
    return this._req<ReportListItem[]>('GET', '/reports', {
      query: { cadence: opts.cadence, agentId: opts.agentId, limit: opts.limit },
      signal
    })
  }

  /** report_get — one report incl. doc blocks. GET /reports/{id}.
   *  E_NOT_FOUND → null (mirrors httpApi.report.get). */
  async getReport(reportId: string, signal?: AbortSignal): Promise<ReportDetail | null> {
    try {
      return await this._req<ReportDetail>('GET', `/reports/${encodeURIComponent(reportId)}`, {
        signal
      })
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  }

  // ── write primitives (Phase 03b — one per gateway write tool) ─────────────
  // Each mirrors the legacy HttpChatPlatform write method's exact wire call
  // (body shape + path) so the gateway write tool is byte-for-byte parity with
  // the legacy tool over the same serve-api endpoint. The Python MailWriteService
  // remains the authoritative validator (二次鉴权): davmail-only checks, ai-field
  // enum/mailbox subset, outbox SSoT — the gateway approval guard is additive.

  /** email_flag — toggle is_read/is_flagged/processing_status. POST /email/{id}/flag.
   *  Only provided fields go on the wire (mirrors HttpApi.flag single mode). */
  flagEmail(
    internalId: number,
    patch: DomainFlagPatch,
    signal?: AbortSignal
  ): Promise<DomainFlagResult> {
    const body: Record<string, unknown> = {}
    if (patch.isRead !== undefined) body.isRead = patch.isRead
    if (patch.isFlagged !== undefined) body.isFlagged = patch.isFlagged
    if (patch.processingStatus !== undefined) body.processingStatus = patch.processingStatus
    return this._req<DomainFlagResult>('POST', `/email/${internalId}/flag`, { body, signal })
  }

  /** email_archive — IMAP MOVE INBOX→Archive + Mailbox→存档. POST /email/{id}/archive. */
  archiveEmail(internalId: number, signal?: AbortSignal): Promise<DomainArchiveResult> {
    return this._req<DomainArchiveResult>('POST', `/email/${internalId}/archive`, {
      body: {},
      signal
    })
  }

  /** email_pin — pin/unpin (local UI flag). POST /email/{id}/pin {pinned}. */
  setPin(internalId: number, pinned: boolean, signal?: AbortSignal): Promise<DomainPinResult> {
    return this._req<DomainPinResult>('POST', `/email/${internalId}/pin`, {
      body: { pinned },
      signal
    })
  }

  /** email_resync — re-push to Notion from the SQLite SSoT. POST /email/{id}/resync. */
  resyncEmail(internalId: number, signal?: AbortSignal): Promise<DomainResyncResult> {
    return this._req<DomainResyncResult>('POST', `/email/${internalId}/resync`, {
      body: {},
      signal
    })
  }

  /** email_draft_reply — create a reply-all draft (davmail IMAP APPEND). POST /email/draft
   *  with {internalId, mode:'reply-all', bodyText, quoteOriginal:true} (server derives
   *  recipients + quotes the source). Projects the data block exactly like
   *  HttpChatPlatform.draftReply so the tool's massage matches the legacy tool. */
  async draftReply(
    internalId: number,
    bodyMarkdown: string,
    signal?: AbortSignal
  ): Promise<DomainDraftResult> {
    const data = await this._req<{
      internal_id: number
      drafts_folder?: string | null
      method?: string | null
    }>('POST', '/email/draft', {
      body: { internalId, mode: 'reply-all', bodyText: bodyMarkdown, quoteOriginal: true },
      signal
    })
    return {
      internalId: data.internal_id,
      mailbox: data.drafts_folder ?? null,
      accountName: null,
      draftId: data.method ?? 'reply_all'
    }
  }

  /** email_prepare_send (Phase 04b) — real SMTP send AFTER the double guard. POST
   *  /email/send-approved with the outbound fields + content hash + idempotency key + HMAC
   *  approval token + expiry. The Python guard verifies the token signature / expiry, recomputes
   *  the payload hash, checks the idempotency send ledger, and confirms the backend supports
   *  send — then sends. Any guard failure → DomainError (the email is never sent). */
  sendApproved(
    req: DomainSendApprovedRequest,
    signal?: AbortSignal
  ): Promise<DomainSendApprovedResult> {
    return this._req<DomainSendApprovedResult>('POST', '/email/send-approved', {
      body: {
        to: req.to,
        cc: req.cc,
        bcc: req.bcc,
        subject: req.subject,
        bodyText: req.bodyText,
        internalId: req.internalId,
        contentHash: req.contentHash,
        idempotencyKey: req.idempotencyKey,
        approvalToken: req.approvalToken,
        expiresAt: req.expiresAt
      },
      signal
    })
  }

  /** M1 auto-capture — fire a finished turn at the mem0 extraction endpoint. POST
   *  /chat/memory/capture {userText, assistantText, sessionId?}. Returns the captured-entry
   *  summary; the caller (lifecycle, fire-and-forget) ignores it. INDEPENDENT from the
   *  agent_memory_kv layer (now retired). sessionId (provenance) only goes on the wire when it is a real number. */
  captureMemory(
    input: { userText: string; assistantText: string; sessionId?: number | null },
    signal?: AbortSignal
  ): Promise<{ captured: unknown[]; count: number }> {
    const body: Record<string, unknown> = {
      userText: input.userText,
      assistantText: input.assistantText
    }
    if (typeof input.sessionId === 'number') body.sessionId = input.sessionId
    return this._req<{ captured: unknown[]; count: number }>('POST', '/chat/memory/capture', {
      body,
      signal
    })
  }

  /** M2 recall — fetch memories relevant to a query from the mem0 store. POST /chat/memory/search
   *  {query, limit?}. Returns the projected memories; the caller (lifecycle retrieveMemory, on the
   *  TTFT path) injects them into the system prompt as an untrusted block. Hits the mem0
   *  auto-extraction store (the agent_memory_kv layer is now retired). limit only goes on the wire
   *  when it is a real number. */
  searchMemory(
    input: { query: string; limit?: number },
    signal?: AbortSignal
  ): Promise<{ memories: Array<{ id: string; memory: string; score?: number }>; count: number }> {
    const body: Record<string, unknown> = { query: input.query }
    if (typeof input.limit === 'number') body.limit = input.limit
    return this._req<{
      memories: Array<{ id: string; memory: string; score?: number }>
      count: number
    }>('POST', '/chat/memory/search', { body, signal })
  }

  // ── self-mount primitives (M4) — the agent reads/proposes its own Standing Context docs +
  //    skills. All hit /agent/* (verify_cf_access dual-auth: the embedded gateway's local-token leg
  //    passes — owner-equivalent on loopback). The gateway ApprovalGuard gates the writes; rules
  //    content is validated server-side. The tools that call these are only registered when
  //    MAILAGENT_SKILL_SELF_MOUNT is on.

  /** update_system_md (M4b) — overwrite a Standing Context doc. POST /agent/profile/docs/{name}.
   *  For name==='rules' the server runs validate_rules_content → 400 E_INVALID_ARG (→ DomainError)
   *  on a jailbreak/override phrase. The tool passes updatedBy='agent_proposed'. */
  setProfileDoc(
    name: string,
    body: { content: string; updatedBy?: string; sessionId?: number; messageId?: number },
    signal?: AbortSignal
  ): Promise<DomainProfileDocResult> {
    return this._req<DomainProfileDocResult>(
      'POST',
      `/agent/profile/docs/${encodeURIComponent(name)}`,
      { body, signal }
    )
  }

  /** discover_skills (M4c) — list resolved skills (enabled/available/unavailableReason/toolCount).
   *  GET /agent/skills → data.skills. */
  async listResolvedSkills(signal?: AbortSignal): Promise<DomainResolvedSkill[]> {
    const data = await this._req<{ skills: DomainResolvedSkill[] }>('GET', '/agent/skills', {
      signal
    })
    return data.skills ?? []
  }

  /** set_skill_enabled (M4c) — enable/disable a skill (mount/unmount its tools). POST
   *  /agent/skills/{name}/enabled {enabled}. */
  setSkillEnabled(
    name: string,
    enabled: boolean,
    signal?: AbortSignal
  ): Promise<{ name: string; enabled: boolean }> {
    return this._req<{ name: string; enabled: boolean }>(
      'POST',
      `/agent/skills/${encodeURIComponent(name)}/enabled`,
      { body: { enabled }, signal }
    )
  }
}
