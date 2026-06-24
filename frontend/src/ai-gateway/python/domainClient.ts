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
}
