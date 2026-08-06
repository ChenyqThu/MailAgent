// chat-panel P4 Phase 03b — email write tools (AI SDK Gateway, HITL approval).
//
// Five state-mutating tools migrated from the legacy harness (shared/chat/tools/builtin/
// write.ts): email_flag / email_archive / email_pin (preview tier) + email_draft_reply
// (edit tier) + email_resync (preview tier — the "sync to Notion" re-push; the rich
// dry-run-diff sync_to_notion card is phase-04a), plus (prd 07-27) the rest of the draft
// family: email_draft_compose (new / forward) + email_draft_update (edit an existing
// draft). Each is an AI SDK `tool()` with
// `needsApproval` so it NEVER executes without explicit user approval (two-call HITL
// flow), runs against the injected MailAgentDomainClient → serve-api write endpoint
// (Python MailWriteService is the authoritative validator — 二次鉴权), and applies the
// SAME validation + output massage as the legacy tool so a parity test sees identical
// fields. Descriptions are reused VERBATIM from the legacy tools (unchanged tool surface).
//
// 🔴 Gated behind MAILAGENT_AI_SDK_WRITE_TOOLS (buildGatewayTools writeToolsEnabled) —
//    an env-only kill-switch, default ON since S3 (env false → the model never sees these).
// 🔴 Approval is enforced by the domain ApprovalGuard (id/hash/expiry, see auditedWriteTool +
//    security/approval.ts) — the AUTHORITATIVE write gate. ai@6's signed-approval layer
//    (streamText experimental_toolApprovalSecret) is intentionally NOT used: the native
//    assistant-ui replay drops the request signature, so it would fail the resume call rather
//    than add protection (chatRun.ts). A write never runs without a valid domain approval.

import type { Tool } from 'ai'
import type { z } from 'zod'

import { DomainError, type MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard, ApprovalRisk } from '../security/approval'
import {
  auditedWriteTool,
  type GatewayApprovalMode,
  type GatewayToolApprovalPrefs,
  type GatewayToolAuditCollector
} from './types'
import { normalizeContextMode, type AgentContextMode, type AgentRunContext } from './policy'
// RELATIVE import (not @shared) so the pure-Node poc harness can load the write tools — same
// rationale as email.ts/sessions.ts. mailboxSemantics is the mirror of the Python single source
// (src/mail/mailbox_semantics.py): the repo forbids new mailbox string comparisons, and the
// drafts label has three historical spellings ('草稿箱'/'草稿'/'Drafts').
import { isDraftsMailbox } from '../../shared/lib/mailboxSemantics'
import {
  emailArchiveSchema,
  emailDraftComposeSchema,
  emailDraftReplySchema,
  emailDraftUpdateSchema,
  emailFlagSchema,
  emailPinSchema,
  emailResyncSchema
} from './schemas'

/** Names of the write tools the gateway exposes when MAILAGENT_AI_SDK_WRITE_TOOLS is on. */
export const GATEWAY_WRITE_TOOL_NAMES = [
  'email_flag',
  'email_archive',
  'email_pin',
  'email_draft_reply',
  'email_draft_compose',
  'email_draft_update',
  'email_resync'
] as const

/** mode-'new' sentinel internal_id (prd 07-27 C-3): a brand-new draft has no source email, and
 *  serve-api `_require_compose_internal_id` relaxes its non-negative check exactly for that mode.
 *  Same value the renderer's composer posts (handlers/draft.ts createDraft default). */
const NEW_DRAFT_SENTINEL_ID = -1

/** Reject an invalid argument the same way the legacy handler did (E_INVALID_ARG). */
function invalidArg(message: string): never {
  throw new DomainError('E_INVALID_ARG', message)
}

/** Mirror legacy asStr: non-empty string → itself, else undefined. */
function nonEmpty(s: string | undefined): string | undefined {
  return s != null && s.length > 0 ? s : undefined
}

/** Recipient-list normalizer for email_draft_reply overrides. The approval applyEdit
 *  side-channel bypasses zod (the card POSTs raw arrays), so defensively keep only
 *  non-empty trimmed strings; an empty/absent list → undefined = "no override, let the
 *  server derive reply-all". */
function normalizeAddrs(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
  return out.length > 0 ? out : undefined
}

/** `"name" <a@x>, b@y; c@z` → ['a@x','b@y','c@z'] — read a stored to_addr/cc_addr column back
 *  into a recipient list for email_draft_update's backfill. Same shape as the renderer composer's
 *  draft-edit prefill (ComposePanel.parseAddrList — the gateway is pure Node and cannot import
 *  that react module), with ONE addition: a fragment carrying no '@' is dropped. Splitting on
 *  commas cuts a quoted display name in half (`"Doe, Jane" <j@x>` → `"Doe` + `Jane" <j@x>`), and
 *  a leftover like `"Doe` must never become a recipient of a draft the assistant re-saves. */
function splitAddrList(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(/[,;]/)) {
    const m = part.match(/<([^>]+)>/)
    const addr = (m ? m[1] : part).trim()
    if (!addr || !addr.includes('@')) continue
    const lower = addr.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(addr)
  }
  return out
}

/**
 * Build the seven email write tools bound to the injected domain client + audit collector
 * + approval guard. Each pushes a write-audit entry (tier + approval_status + approval_hash
 * + user_edited) into `collector` after a successful approved execution.
 */
export function createWriteTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = [],
  guard: ApprovalGuard,
  opts: {
    a2uiEnabled?: boolean
    approvalMode?: GatewayApprovalMode
    oneShot?: boolean
    contextMode?: AgentContextMode
    /** 08-05 WP-11 — the per-tool tier map of a MANUAL run (types.ts GatewayToolApprovalPrefs.
     *  tools). Absent (headless/im/tests) → pre-WP-11 ask semantics, byte-identical. */
    toolApprovalPrefs?: GatewayToolApprovalPrefs['tools']
    /** S5 W4 (ADR-004 D1/§3.1) — the per-agent run context of a headless custom-agent run. Only
     *  its presence (with a non-empty agentId) UNDER a headless mode turns on the per-agent
     *  domain_write whitelist evaluate below; manual runs never carry one. */
    agentRunContext?: AgentRunContext
  } = {}
): Record<string, Tool> {
  // S5 W4 (ADR-004 §3.1) — headless-ONLY policyEvaluate injection, decided here in the factory
  // (NOT in needsApproval): wiring policyEvaluate unconditionally would SHADOW manual_chat's
  // auto-reversible branch in types.ts (policyEvaluate takes precedence there), regressing the
  // preview-write skip into a loopback RTT + rule requirement. So a domain_write tool gets the
  // hook ONLY when the run is a headless agent run (untrusted_trigger / cron_headless + agentId
  // present); otherwise policyEvaluate stays undefined → types.ts walks its existing branches,
  // byte-identical (asserted by vitest).
  const contextMode = normalizeContextMode(opts.contextMode)
  const agentId = opts.agentRunContext?.agentId
  const headlessAgent =
    (contextMode === 'untrusted_trigger' || contextMode === 'cron_headless') &&
    typeof agentId === 'string' &&
    agentId.length > 0

  const make = <I>(toolOpts: {
    name: string
    description: string
    inputSchema: z.ZodType<I>
    // preview/edit only — the high-risk 'blocking' send tool lives in send.ts (auditedSendTool).
    risk: Exclude<ApprovalRisk, 'blocking'>
    /** Phase 04a — editable fields for edit-tier tools (e.g. ['body_markdown']). */
    editableFields?: readonly string[]
    run: (
      input: I,
      ctx: { userEdited: boolean; signal: AbortSignal | undefined }
    ) => Promise<unknown>
  }): Tool =>
    auditedWriteTool(
      {
        ...toolOpts,
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        // 08-05 WP-11 — the per-tool tier ladder (manual only; consumed in types.ts).
        toolApprovalPrefs: opts.toolApprovalPrefs,
        // Part B — one-shot claim across island + renderer resume (see auditedWriteTool.oneShot).
        oneShot: opts.oneShot,
        // S2 W0 — the run's context mode (auto-approve requires domain_write + manual_chat).
        contextMode: opts.contextMode,
        // S5 W4 (ADR-004 D1) — per-agent domain_write whitelist: matcher V1 pins the tool name
        // only ({v:1, tool}), so the action descriptor is just { tool } (the full input already
        // lands in the chat_tool_call audit). Verdict semantics ride types.ts' existing exec
        // pipeline: auto_allow → no card + approval_status='auto_whitelist' + whitelist_rule_id;
        // ask / timeout (2.5s abort) / error → .catch(() => true) → the card → island or void
        // (fail-closed, ADR-003 D4 semantics unchanged).
        ...(headlessAgent
          ? {
              policyEvaluate: () =>
                domain.policyEvaluate(
                  'domain_write',
                  { tool: toolOpts.name },
                  contextMode,
                  AbortSignal.timeout(2500),
                  agentId
                )
            }
          : {})
      },
      collector,
      guard
    )

  const email_flag = make({
    name: 'email_flag',
    description:
      'Toggle is_read / is_flagged / processing_status on a single email by internal_id. ' +
      'Writes through the Sprint 16 outbox SSoT (~5ms): updates email_metadata + enqueues ' +
      'mailapp + notion outbox rows for fanout. Reversible — call again with inverse values to undo. ' +
      'Requires user confirmation (preview tier).',
    inputSchema: emailFlagSchema,
    risk: 'preview',
    run: async (input, { userEdited, signal }) => {
      if (input.internal_id < 0) invalidArg('internal_id required (non-negative integer)')
      const isRead = input.is_read
      const isFlagged = input.is_flagged
      const processingStatus = nonEmpty(input.processing_status)
      if (isRead === undefined && isFlagged === undefined && processingStatus === undefined) {
        invalidArg('at least one of is_read / is_flagged / processing_status must be set')
      }
      const data = await domain.flagEmail(
        input.internal_id,
        { isRead, isFlagged, processingStatus },
        signal
      )
      // 🔴 set_flags is the ONE write op with a SOFT not-found: a nonexistent internal_id
      // returns HTTP 200 + not_found:[id] having written nothing. Projecting only
      // updated_ids/applied made the tool report "flagged" for an email that doesn't exist.
      // The happy path stays byte-identical (pinned snapshot + Python's own "omit not_found
      // when empty" convention); only the real not-found branch changes shape, dropping the
      // `applied` key — which states the REQUESTED patch, not a landed one — so nothing in
      // the result can be read as success.
      const notFound = data.not_found ?? []
      const updatedIds = data.updated_ids ?? []
      if (notFound.length > 0) {
        return {
          internal_id: input.internal_id,
          ok: false,
          not_found: notFound,
          requested: {
            is_read: isRead,
            is_flagged: isFlagged,
            processing_status: processingStatus
          },
          updated_ids: updatedIds,
          outbox_entries: data.outbox_entries ?? [],
          user_edited: userEdited
        }
      }
      return {
        internal_id: input.internal_id,
        applied: { is_read: isRead, is_flagged: isFlagged, processing_status: processingStatus },
        updated_ids: updatedIds,
        outbox_entries: data.outbox_entries ?? [],
        user_edited: userEdited
      }
    }
  })

  const email_archive = make({
    name: 'email_archive',
    description:
      'Archive an email: move it (IMAP MOVE) into the Archive folder and set its mailbox to ' +
      '"存档" so it leaves the inbox view (and the Notion mirror updates). Use when the user has ' +
      'finished with an email and wants it out of the inbox. Preview tier — reversible (move it ' +
      'back or re-sync). NOT a destructive delete — the message and its body/attachments are ' +
      'kept. davmail-only: on the AppleScript backend this returns an error.',
    inputSchema: emailArchiveSchema,
    risk: 'preview',
    run: async (input, { userEdited, signal }) => {
      if (input.internal_id < 0) invalidArg('internal_id required (non-negative integer)')
      const data = await domain.archiveEmail(input.internal_id, signal)
      return {
        internal_id: input.internal_id,
        archived: true,
        from_mailbox: data.from_mailbox ?? null,
        to_mailbox: data.to_mailbox ?? '存档',
        notion_updated: data.notion_updated ?? false,
        user_edited: userEdited
      }
    }
  })

  const email_pin = make({
    name: 'email_pin',
    description:
      'Pin or unpin an email so it stays at the top of the list (pinned=true to pin, false to ' +
      'unpin). This is a local UI flag only — it does not touch Mail.app / Notion and is fully ' +
      'reversible. Use when the user wants to keep an email handy / stop pinning it. Preview tier.',
    inputSchema: emailPinSchema,
    risk: 'preview',
    run: async (input, { userEdited, signal }) => {
      if (input.internal_id < 0) invalidArg('internal_id required (non-negative integer)')
      const data = await domain.setPin(input.internal_id, input.pinned, signal)
      return {
        internal_id: input.internal_id,
        is_pinned: data.is_pinned ?? input.pinned,
        changed: data.changed ?? false,
        user_edited: userEdited
      }
    }
  })

  const email_draft_reply = make({
    name: 'email_draft_reply',
    description:
      'Compose a reply or reply-all draft for the given email. The user will see your proposed ' +
      'body in a confirmation dialog and CAN edit it before the draft is created. After confirmation, ' +
      'a real draft message is saved to the Drafts folder (not auto-sent — the user still has to click ' +
      'Send); the original message is quoted below your body. Recipients: by default they are derived ' +
      'server-side (mode "reply-all" = original sender + To minus yourself; mode "reply" = sender only). ' +
      'To ADD or REMOVE recipients on top of that, pass to/cc/bcc explicitly — each provided list fully ' +
      'OVERRIDES the derived one (read the source email first via email_get to know the current ' +
      'sender/to/cc, then pass the final lists). Body should be markdown (bold, italics, lists, links ' +
      'supported). Edit tier — the user may modify your draft.',
    inputSchema: emailDraftReplySchema,
    risk: 'edit',
    // Phase 04a — the user may edit body + recipients on the DraftReplyCard; internal_id/mode
    // are pinned to the model's original (the approval side-channel cannot retarget the draft).
    editableFields: ['body_markdown', 'to', 'cc', 'bcc'],
    run: async (input, { userEdited, signal }) => {
      if (input.internal_id < 0) invalidArg('internal_id required (non-negative integer)')
      const data = await domain.draftReply(input.internal_id, input.body_markdown, {
        mode: input.mode,
        to: normalizeAddrs(input.to),
        cc: normalizeAddrs(input.cc),
        bcc: normalizeAddrs(input.bcc),
        signal
      })
      return {
        internal_id: data.internalId,
        mailbox: data.mailbox,
        account_name: data.accountName,
        draft_id: data.draftId,
        user_edited: userEdited,
        // Surface the final body + recipient overrides so the LLM next-turn knows EXACTLY
        // what landed in the draft (empty override = server-derived reply-all).
        final_body_markdown: input.body_markdown,
        final_to: normalizeAddrs(input.to) ?? null,
        final_cc: normalizeAddrs(input.cc) ?? null,
        final_bcc: normalizeAddrs(input.bcc) ?? null
      }
    }
  })

  const email_draft_compose = make({
    name: 'email_draft_compose',
    description:
      'Create a NEW draft (mode "new") or FORWARD an existing email (mode "forward"). THE TWO ' +
      'MODES TAKE DIFFERENT PARAMETERS — mode "new": OMIT internal_id entirely (a new draft has ' +
      'no source email; 0 / -1 / any placeholder is rejected) and pass subject. mode "forward": ' +
      'internal_id = the email to forward; the original is quoted below your body (quote_original, ' +
      'default true) and its attachments ride along automatically, and the subject defaults to ' +
      '"Fwd: <original>" unless you pass one. The draft is saved to the Drafts folder — nothing ' +
      'is sent (to actually send, the user asks and you use email_prepare_send). The user sees ' +
      'your subject / recipients / body in a confirmation dialog and CAN edit them before the ' +
      'draft is created. Recipients are explicit: pass the final to (required) / cc / bcc lists — ' +
      'nothing is derived. Body should be markdown (bold, italics, lists, links supported). To ' +
      'REPLY to an email use email_draft_reply instead (it derives the recipients and threads ' +
      'correctly); to change a draft that already exists use email_draft_update. Edit tier — the ' +
      'user may modify your draft.',
    inputSchema: emailDraftComposeSchema,
    risk: 'edit',
    // The user may rewrite the content on the approval card; mode / internal_id stay pinned to the
    // model's original (the approval side-channel must not be able to retarget which email is
    // forwarded, mirroring email_draft_reply).
    editableFields: ['subject', 'body_markdown', 'to', 'cc', 'bcc'],
    run: async (input, { userEdited, signal }) => {
      const forward = input.mode === 'forward'
      // The applyEdit side-channel bypasses zod, so re-assert the shape the schema promised.
      const sourceId = typeof input.internal_id === 'number' ? input.internal_id : -1
      if (forward && sourceId < 0) {
        invalidArg("mode 'forward' requires internal_id (the source email to forward)")
      }
      const to = normalizeAddrs(input.to)
      const cc = normalizeAddrs(input.cc)
      const bcc = normalizeAddrs(input.bcc)
      // The service rejects a recipient-less forward server-side; fail here with the actionable
      // message instead of a generic upstream error.
      if (forward && !to) invalidArg("mode 'forward' requires at least one recipient in `to`")
      // typeof-guarded for the same reason as normalizeAddrs: the applyEdit side-channel is not
      // zod-validated, and .trim() on a non-string would crash the tool instead of erroring.
      const subject = typeof input.subject === 'string' ? nonEmpty(input.subject.trim()) : undefined
      const data = await domain.composeDraft(
        {
          internalId: forward ? sourceId : NEW_DRAFT_SENTINEL_ID,
          mode: input.mode,
          ...(subject !== undefined ? { subject } : {}),
          bodyText: input.body_markdown,
          to,
          cc,
          bcc,
          // forward-only: append the quoted original under the body. 'new' has nothing to quote,
          // so the key is omitted entirely there (server default false).
          ...(forward ? { quoteOriginal: input.quote_original !== false } : {})
        },
        signal
      )
      return {
        mode: data.mode ?? input.mode,
        // 🔴 NOT the new draft's row id (the endpoint echoes the request id and never returns the
        // created row) — for forward this is the SOURCE email, for new there is none.
        source_internal_id: forward ? sourceId : null,
        drafts_folder: data.drafts_folder ?? null,
        appended_uid: data.appended_uid ?? null,
        method: data.method ?? null,
        to_count: data.to_count ?? 0,
        cc_count: data.cc_count ?? 0,
        attachments: data.attachments ?? 0,
        warnings: data.warnings ?? [],
        user_edited: userEdited,
        // Echo the executed content so the next turn knows EXACTLY what landed in the draft.
        final_subject: subject ?? null,
        final_body_markdown: input.body_markdown,
        final_to: to ?? [],
        final_cc: cc ?? [],
        final_bcc: bcc ?? []
      }
    }
  })

  const email_draft_update = make({
    name: 'email_draft_update',
    description:
      'Edit an EXISTING draft (draft_internal_id = its internal_id, found via email_list_filter ' +
      'with mailbox "草稿箱" or email_search_fulltext with in:drafts). Pass only what changes — ' +
      'subject / body_markdown / to / cc / bcc are each optional and anything you omit keeps its ' +
      'current value (an omitted body is carried over verbatim, so a subject-only edit does not ' +
      'touch the text). The user sees the change in a confirmation dialog and CAN edit it. ' +
      'Mechanically this saves a NEW draft with the merged content and deletes the old one (the ' +
      'reply threading and the attachments carry over, and the draft gets a new id) — if the ' +
      'delete fails the result says so and BOTH drafts remain, which you must tell the user. ' +
      'Two limits worth knowing: a BCC list cannot be read back from an existing draft, so an ' +
      'omitted bcc means the new draft has none; and inline images embedded in the old body are ' +
      'not carried over (regular attachments are). Only works on rows in the Drafts folder — for ' +
      'a new draft use email_draft_compose, for a reply use email_draft_reply. Edit tier.',
    inputSchema: emailDraftUpdateSchema,
    risk: 'edit',
    editableFields: ['subject', 'body_markdown', 'to', 'cc', 'bcc'],
    run: async (input, { userEdited, signal }) => {
      const draftId = input.draft_internal_id
      if (draftId < 0) invalidArg('draft_internal_id required (non-negative integer)')
      const newSubject = typeof input.subject === 'string' ? input.subject : undefined
      const newBody = nonEmpty(
        typeof input.body_markdown === 'string' ? input.body_markdown : undefined
      )
      // An empty/absent list is "no override" (email_draft_reply's documented semantic), NOT
      // "clear the recipients" — so a card that cleared a field falls back to the current value.
      const toOverride = normalizeAddrs(input.to)
      const ccOverride = normalizeAddrs(input.cc)
      const bccOverride = normalizeAddrs(input.bcc)
      if (
        newSubject === undefined &&
        newBody === undefined &&
        !toOverride &&
        !ccOverride &&
        !bccOverride
      ) {
        invalidArg('at least one of subject / body_markdown / to / cc / bcc must be set')
      }

      // 1. Read the current draft: the drafts-folder gate + the backfill source for every field
      //    the caller did not provide.
      const row = await domain.getEmail(draftId, signal)
      if (!row) throw new DomainError('E_NOT_FOUND', `email ${draftId} not found`)
      if (!isDraftsMailbox(row.mailbox)) {
        invalidArg(
          `email ${draftId} is in "${row.mailbox}", not the Drafts folder — email_draft_update ` +
            'only edits drafts (use email_draft_reply / email_draft_compose to create one)'
        )
      }
      const subject = newSubject ?? row.subject
      const to = toOverride ?? splitAddrList(row.to_addr)
      const cc = ccOverride ?? splitAddrList(row.cc_addr)

      // 2. Body: the caller's markdown, else the current body carried over VERBATIM. html first —
      //    re-rendering the existing text through markdown would silently flatten tables /
      //    styling / the signature on an edit that never asked to touch the body.
      let bodyText: string | undefined
      let bodyHtml: string | undefined
      let bodySource: 'model' | 'existing_html' | 'existing_markdown' = 'model'
      if (newBody !== undefined) {
        bodyText = newBody
      } else {
        const html = await domain.getEmailBody(draftId, signal, 'html')
        if (html?.content) {
          bodyHtml = html.content
          bodySource = 'existing_html'
        } else {
          const md = await domain.getEmailBody(draftId, signal)
          if (!md?.content) {
            throw new DomainError(
              'E_NOT_FOUND',
              `draft ${draftId} has no synced body yet — pass body_markdown explicitly ` +
                '(a freshly created draft takes a few seconds to sync)'
            )
          }
          bodyText = md.content
          bodySource = 'existing_markdown'
        }
      }

      // Carry the draft's own (non-inline) attachments into the replacement; without an explicit
      // list a mode-'new' compose collects nothing and the edit would silently drop them.
      const attachments = (row.attachments ?? [])
        .filter((a) => !a.is_inline)
        .map((a) => ({ attachment_id: a.id }))

      // 3. Write the replacement. sourceDraftId === internalId === the draft's own id is what
      //    restores its In-Reply-To/References (the service rejects any other pairing).
      const data = await domain.composeDraft(
        {
          internalId: draftId,
          mode: 'new',
          sourceDraftId: draftId,
          subject,
          bodyText,
          bodyHtml,
          to,
          cc,
          bcc: bccOverride,
          attachments
        },
        signal
      )

      // 4. Delete the superseded draft — NON-FATAL by design: the new draft already exists, so a
      //    failed delete leaves a duplicate (recoverable) while a rollback would risk the content.
      const warnings = [...(data.warnings ?? [])]
      let oldDeleted = false
      let deleteError: string | null = null
      try {
        await domain.deleteDraft(draftId, signal)
        oldDeleted = true
      } catch (e) {
        deleteError = e instanceof DomainError ? `${e.code}: ${e.message}` : String(e)
        warnings.push(
          `the updated draft was saved, but deleting the old draft (internal_id=${draftId}) ` +
            `failed (${deleteError}) — BOTH now sit in the Drafts folder; tell the user to delete ` +
            'the stale one'
        )
      }

      return {
        draft_internal_id: draftId,
        updated: true,
        drafts_folder: data.drafts_folder ?? null,
        appended_uid: data.appended_uid ?? null,
        method: data.method ?? null,
        old_draft_deleted: oldDeleted,
        old_draft_delete_error: deleteError,
        body_source: bodySource,
        attachments_carried: attachments.length,
        warnings,
        user_edited: userEdited,
        final_subject: subject,
        final_body_markdown: newBody ?? null,
        final_to: to,
        final_cc: cc,
        final_bcc: bccOverride ?? []
      }
    }
  })

  const email_resync = make({
    name: 'email_resync',
    description:
      'Re-push an email to Notion from the local SQLite source-of-truth (recreates / refreshes its ' +
      "Notion page). Use when an email's Notion page is missing, stale, or out of sync. Preview " +
      'tier. Idempotent — safe to run again. Returns the old/new Notion page id + action taken.',
    inputSchema: emailResyncSchema,
    risk: 'preview',
    run: async (input, { userEdited, signal }) => {
      if (input.internal_id < 0) invalidArg('internal_id required (non-negative integer)')
      const data = await domain.resyncEmail(input.internal_id, signal)
      return {
        internal_id: input.internal_id,
        old_page_id: data.old_page_id ?? null,
        new_page_id: data.new_page_id ?? null,
        action: data.action ?? 'unknown',
        user_edited: userEdited
      }
    }
  })

  return {
    email_flag,
    email_archive,
    email_pin,
    email_draft_reply,
    email_draft_compose,
    email_draft_update,
    email_resync
  }
}
