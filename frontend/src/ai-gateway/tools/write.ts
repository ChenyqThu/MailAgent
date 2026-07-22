// chat-panel P4 Phase 03b — email write tools (AI SDK Gateway, HITL approval).
//
// Five state-mutating tools migrated from the legacy harness (shared/chat/tools/builtin/
// write.ts): email_flag / email_archive / email_pin (preview tier) + email_draft_reply
// (edit tier) + email_resync (preview tier — the "sync to Notion" re-push; the rich
// dry-run-diff sync_to_notion card is phase-04a). Each is an AI SDK `tool()` with
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
import { auditedWriteTool, type GatewayApprovalMode, type GatewayToolAuditCollector } from './types'
import { normalizeContextMode, type AgentContextMode, type AgentRunContext } from './policy'
import {
  emailArchiveSchema,
  emailDraftReplySchema,
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
  'email_resync'
] as const

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

/**
 * Build the five email write tools bound to the injected domain client + audit collector
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
      return {
        internal_id: input.internal_id,
        applied: { is_read: isRead, is_flagged: isFlagged, processing_status: processingStatus },
        updated_ids: data.updated_ids ?? [],
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

  return { email_flag, email_archive, email_pin, email_draft_reply, email_resync }
}
