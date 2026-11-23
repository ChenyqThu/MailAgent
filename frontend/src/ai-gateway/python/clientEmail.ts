// Email reads/writes, drafts, attachments, KOS passthrough, and reports.
import { DomainError, type DomainHttpCore } from './clientCore'
import type {
  DomainEmailListOpts,
  DomainSearchOpts,
  DomainReportListOpts,
  DomainAttachmentSearchResult,
  DomainThreadAttachmentsResult,
  DomainAttachmentTextResult,
  DomainFlagPatch,
  DomainFlagResult,
  DomainArchiveResult,
  DomainPinResult,
  DomainResyncResult,
  DomainDraftResult,
  DomainComposeDraftInput,
  DomainComposeDraftResult,
  DomainDeleteDraftResult,
  DomainSendApprovedRequest,
  DomainSendApprovedResult
} from './domainTypes'
import type {
  EmailGet_EmailRecord,
  EmailList_EmailListItem,
  MailagentEmailBody
} from '@shared/types/cli.gen'
import type { ReportBlock, ReportDetail, ReportListItem, SearchResult } from '@shared/api/types'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- inferred for MailAgentDomainClient declaration merging
export function createEmailMethods(http: DomainHttpCore) {
  return {
  // ── read primitives (one per gateway read tool) ──────────────────────────

  /** email_list_filter — metadata-filter list. GET /email/list (camelCase alias query).
   *  🔴 `exclude_drafts` is snake_case on purpose — it is the ONE key of this endpoint that is
   *  not a camelCase alias (prd 07-27 C-1 cross-lane contract); FastAPI would silently drop an
   *  `excludeDrafts` and the drafts would quietly return to the model's results. */
  searchEmails(
    opts: DomainEmailListOpts,
    signal?: AbortSignal
  ): Promise<EmailList_EmailListItem[]> {
    return http.req<EmailList_EmailListItem[]>('GET', '/email/list', {
      query: {
        subject: opts.subject,
        fromAddr: opts.fromAddr,
        mailbox: opts.mailbox,
        sinceDate: opts.sinceDate,
        untilDate: opts.untilDate,
        isRead: opts.isRead,
        isFlagged: opts.isFlagged,
        exclude_drafts: opts.excludeDrafts,
        matter_id: opts.matterId,
        limit: opts.limit
      },
      signal
    })
  },

  /** email_search_fulltext — FTS body search. GET /email/search (param is `q`). */
  searchEmailsFulltext(opts: DomainSearchOpts, signal?: AbortSignal): Promise<SearchResult> {
    return http.req<SearchResult>('GET', '/email/search', {
      query: {
        q: opts.query,
        mailbox: opts.mailbox,
        since: opts.since,
        until: opts.until,
        limit: opts.limit,
        matter_id: opts.matterId
      },
      signal
    })
  },

  /** email_get — single email metadata. GET /email/{id}?include=attachments.
   *  E_NOT_FOUND → null (mirrors httpApi.email.get).
   *
   *  `matterScope` (internal int matter id) is the SERVER-side membership guard: when present the
   *  endpoint verifies internal_id ∈ that Matter's access_policy='allowed' resource set and 403s
   *  E_MATTER_SCOPE otherwise. 🔴 0812 owner拍板 —— NO gateway caller passes it any more (the
   *  follow-up run's anchor narrowing and the manual 事项对话 检索范围 toggle were both retired,
   *  see tools/email.ts). Kept as the typed mirror of a query param the Python endpoint still
   *  serves and still tests; it is a wire capability, not tool plumbing. */
  async getEmail(
    internalId: number,
    signal?: AbortSignal,
    matterScope?: number
  ): Promise<EmailGet_EmailRecord | null> {
    try {
      return await http.req<EmailGet_EmailRecord>('GET', `/email/${internalId}`, {
        query: { include: 'attachments', matter_scope: matterScope },
        signal
      })
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  },

  /** email_body — body in one format. GET /email/{id}/body?format=markdown (default) | html.
   *  E_NOT_FOUND → null (mirrors httpApi.email.body; the endpoint 404s both for "no body row"
   *  and "that format column is null", so an html miss degrades to null, not a throw).
   *  `format` is only ever passed by email_draft_update, which re-posts an unchanged draft body
   *  VERBATIM as html — a markdown round-trip would silently flatten tables / styling. */
  async getEmailBody(
    internalId: number,
    signal?: AbortSignal,
    format: 'markdown' | 'html' = 'markdown',
    preserveMissingReason = false
  ): Promise<NonNullable<MailagentEmailBody['data']> | null> {
    try {
      return await http.req<NonNullable<MailagentEmailBody['data']>>(
        'GET',
        `/email/${internalId}/body`,
        { query: { format }, signal }
      )
    } catch (e) {
      if (!preserveMissingReason && e instanceof DomainError && e.code === 'E_NOT_FOUND')
        return null
      throw e
    }
  },

  /** email_list_thread — sibling emails by thread_id. GET /email/thread/{tid}. */
  listEmailsByThread(threadId: string, signal?: AbortSignal): Promise<EmailList_EmailListItem[]> {
    return http.req<EmailList_EmailListItem[]>(
      'GET',
      `/email/thread/${encodeURIComponent(threadId)}`,
      { signal }
    )
  },

  /** email_search_attachments — FTS over extracted attachment text. GET /attachment/search
   *  (param is `q`). */
  searchAttachments(
    opts: DomainSearchOpts,
    signal?: AbortSignal
  ): Promise<DomainAttachmentSearchResult> {
    return http.req<DomainAttachmentSearchResult>('GET', '/attachment/search', {
      query: {
        q: opts.query,
        mailbox: opts.mailbox,
        since: opts.since,
        until: opts.until,
        limit: opts.limit
      },
      signal
    })
  },

  /** email_thread_attachments — every attachment across a thread (metadata + owning-email
   *  provenance). GET /attachment/thread/{thread_id}. The endpoint returns {thread_id, items}. */
  threadAttachments(
    threadId: string,
    signal?: AbortSignal
  ): Promise<DomainThreadAttachmentsResult> {
    return http.req<DomainThreadAttachmentsResult>(
      'GET',
      `/attachment/thread/${encodeURIComponent(threadId)}`,
      { signal }
    )
  },

  /** email_attachment_text — one page of an attachment's extracted text (server returns
   *  [offset, offset+max_chars) plus total_chars / next_offset). GET
   *  /attachment/{id}/text?max_chars=N&offset=M. Non-extracted statuses
   *  (pending/failed/unsupported) return text_content=null + a `hint`. */
  attachmentText(
    attachmentId: number,
    maxChars: number,
    offset: number,
    signal?: AbortSignal
  ): Promise<DomainAttachmentTextResult> {
    return http.req<DomainAttachmentTextResult>('GET', `/attachment/${attachmentId}/text`, {
      query: { max_chars: maxChars, offset },
      signal
    })
  },

  /** kos_query — KOS tool proxy. POST /chat/kos-call {name, args}. Returns the raw
   *  KOS result (list/dict/str). E_KOS_* errors surface as DomainError. */
  kosCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return http.req<unknown>('POST', '/chat/kos-call', { body: { name, args }, signal })
  },

  /** report_list — generated reports. GET /reports (agentId alias). */
  listReports(opts: DomainReportListOpts, signal?: AbortSignal): Promise<ReportListItem[]> {
    return http.req<ReportListItem[]>('GET', '/reports', {
      query: { cadence: opts.cadence, agentId: opts.agentId, limit: opts.limit },
      signal
    })
  },

  /** report_get — one report incl. doc blocks. GET /reports/{id}.
   *  E_NOT_FOUND → null (mirrors httpApi.report.get). */
  async getReport(reportId: string, signal?: AbortSignal): Promise<ReportDetail | null> {
    try {
      return await http.req<ReportDetail>('GET', `/reports/${encodeURIComponent(reportId)}`, {
        signal
      })
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  },

  /** report_write — persist a local custom ReportDoc artifact. */
  writeCustomReport(
    agentId: string,
    input: { title: string; blocks: ReportBlock[]; mode: 'new' | 'replace' },
    signal?: AbortSignal
  ): Promise<ReportDetail> {
    return http.req<ReportDetail>('POST', '/reports/custom', {
      body: { agentId, ...input },
      signal
    })
  },

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
    return http.req<DomainFlagResult>('POST', `/email/${internalId}/flag`, { body, signal })
  },

  /** email_archive — IMAP MOVE INBOX→Archive + Mailbox→存档. POST /email/{id}/archive. */
  archiveEmail(internalId: number, signal?: AbortSignal): Promise<DomainArchiveResult> {
    return http.req<DomainArchiveResult>('POST', `/email/${internalId}/archive`, {
      body: {},
      signal
    })
  },

  /** email_pin — pin/unpin (local UI flag). POST /email/{id}/pin {pinned}. */
  setPin(internalId: number, pinned: boolean, signal?: AbortSignal): Promise<DomainPinResult> {
    return http.req<DomainPinResult>('POST', `/email/${internalId}/pin`, {
      body: { pinned },
      signal
    })
  },

  /** email_resync — re-push to Notion from the SQLite SSoT. POST /email/{id}/resync. */
  resyncEmail(internalId: number, signal?: AbortSignal): Promise<DomainResyncResult> {
    return http.req<DomainResyncResult>('POST', `/email/${internalId}/resync`, {
      body: {},
      signal
    })
  },

  /** email_draft_reply — create a reply / reply-all draft (davmail IMAP APPEND). POST
   *  /email/draft with {internalId, mode, bodyText, quoteOriginal:true} — mode defaults to
   *  'reply-all'; when opts.to/cc/bcc are present they ride along as FULL recipient-list
   *  overrides (serve-api _compose_request_from_body → service to_override; absent = the
   *  server derives them). Projects the data block exactly like the legacy
   *  HttpChatPlatform.draftReply so the tool's massage matches the legacy tool. */
  async draftReply(
    internalId: number,
    bodyMarkdown: string,
    opts: {
      mode?: 'reply' | 'reply-all'
      to?: string[]
      cc?: string[]
      bcc?: string[]
      signal?: AbortSignal
    } = {}
  ): Promise<DomainDraftResult> {
    const data = await http.req<{
      internal_id: number
      drafts_folder?: string | null
      method?: string | null
    }>('POST', '/email/draft', {
      body: {
        internalId,
        mode: opts.mode ?? 'reply-all',
        bodyText: bodyMarkdown,
        quoteOriginal: true,
        ...(opts.to?.length ? { to: opts.to } : {}),
        ...(opts.cc?.length ? { cc: opts.cc } : {}),
        ...(opts.bcc?.length ? { bcc: opts.bcc } : {})
      },
      signal: opts.signal
    })
    return {
      internalId: data.internal_id,
      mailbox: data.drafts_folder ?? null,
      accountName: null,
      draftId: data.method ?? 'reply_all'
    }
  },

  /** email_draft_compose / email_draft_update (prd 07-27 C-3/C-4) — create a draft through the
   *  SAME endpoint the renderer's composer uses (POST /email/draft). ONE wire method for both
   *  tools so the (camelCase) body key names are pinned in exactly one place:
   *    - compose new  → {internalId:-1 (sentinel — the route relaxes its non-negative check for
   *      mode 'new'), mode:'new', subject, to/cc/bcc, bodyText}
   *    - compose fwd  → {internalId:<source>, mode:'forward', quoteOriginal, …} (the service
   *      auto-collects the source email's attachments when no `attachments` key is sent)
   *    - update       → {internalId:<draft>, mode:'new', sourceDraftId:<the SAME draft id>, …}
   *      🔴 sourceDraftId MUST equal internalId — mail_write._prepare_draft rejects any other
   *      pairing (binding check) and silently falls back to zero thread derivation, i.e. the
   *      edited draft would lose its In-Reply-To/References. The renderer sends both keys with
   *      the same id for exactly this reason (ComposePanel.buildComposePayload).
   *  Returns the endpoint's data block verbatim (snake_case, like the other write primitives).
   *  🔴 The response `internal_id` is an ECHO of the request's id, NOT the new draft's row id
   *  (the row is allocated by _mirror_draft_locally and never returned) — callers must not
   *  present it as "the new draft". */
  composeDraft(
    input: DomainComposeDraftInput,
    signal?: AbortSignal
  ): Promise<DomainComposeDraftResult> {
    return http.req<DomainComposeDraftResult>('POST', '/email/draft', {
      body: {
        internalId: input.internalId,
        mode: input.mode,
        ...(input.sourceDraftId !== undefined ? { sourceDraftId: input.sourceDraftId } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.bodyHtml ? { bodyHtml: input.bodyHtml } : {}),
        ...(input.bodyText ? { bodyText: input.bodyText } : {}),
        ...(input.quoteOriginal !== undefined ? { quoteOriginal: input.quoteOriginal } : {}),
        ...(input.to?.length ? { to: input.to } : {}),
        ...(input.cc?.length ? { cc: input.cc } : {}),
        ...(input.bcc?.length ? { bcc: input.bcc } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {})
      },
      signal
    })
  },

  /** email_draft_update step 3 — delete the superseded draft. DELETE /email/draft/{id}
   *  (IMAP \Deleted+EXPUNGE + local row cleanup). davmail-only; the endpoint itself refuses a
   *  row whose mailbox is not the Drafts folder (E_INVALID_ARG). */
  deleteDraft(internalId: number, signal?: AbortSignal): Promise<DomainDeleteDraftResult> {
    return http.req<DomainDeleteDraftResult>('DELETE', `/email/draft/${internalId}`, { signal })
  },

  /** email_prepare_send (Phase 04b) — real SMTP send AFTER the double guard. POST
   *  /email/send-approved with the outbound fields + content hash + idempotency key + HMAC
   *  approval token + expiry. The Python guard verifies the token signature / expiry, recomputes
   *  the payload hash, checks the idempotency send ledger, and confirms the backend supports
   *  send — then sends. Any guard failure → DomainError (the email is never sent). */
  sendApproved(
    req: DomainSendApprovedRequest,
    signal?: AbortSignal
  ): Promise<DomainSendApprovedResult> {
    return http.req<DomainSendApprovedResult>('POST', '/email/send-approved', {
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
  },

  /** M1 auto-capture — fire a finished turn at the mem0 extraction endpoint. POST
   *  /chat/memory/capture {userText, assistantText, sessionId?}. Returns the captured-entry
   *  summary; the caller (lifecycle, fire-and-forget) ignores it. INDEPENDENT from the
   *  agent_memory_kv layer (now retired). sessionId (provenance) only goes on the wire when it is a real number. */
  captureMemory(
    input: {
      userText: string
      assistantText: string
      sessionId?: number | null
      idempotencyKey?: string
    },
    signal?: AbortSignal
  ): Promise<{ captured: unknown[]; count: number }> {
    const body: Record<string, unknown> = {
      userText: input.userText,
      assistantText: input.assistantText
    }
    if (typeof input.sessionId === 'number') body.sessionId = input.sessionId
    if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
      body.idempotencyKey = input.idempotencyKey
    }
    return http.req<{ captured: unknown[]; count: number }>('POST', '/chat/memory/capture', {
      body,
      signal
    })
  },

  /** Wave 4C — Persist on-demand translation segments via serve-api (single-writer sync_store.db). */
  saveTranslation(
    internalId: number,
    input: {
      targetLang: 'zh' | 'en'
      segments: Array<{ src: string; tgt: string }>
      model: string
      source: 'on_demand' | 'llm_agent'
    },
    signal?: AbortSignal
  ): Promise<{
    internalId: number
    targetLang: 'zh' | 'en'
    segments: Array<{ src: string; tgt: string }>
    source: string | null
    model: string | null
    fetchedAt: number | null
    saved: boolean
    cacheKept?: boolean
  }> {
    return http.req('PUT', `/ai/translation/${internalId}`, {
      body: input,
      signal
    })
  }
  }
}

export type EmailMethods = ReturnType<typeof createEmailMethods>
