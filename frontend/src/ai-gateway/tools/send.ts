// chat-panel P4 Phase 04b — high-risk outbound send tool (AI SDK Gateway, blocking HITL).
//
// email_prepare_send is the ONE tool that triggers a real, irreversible SMTP send. It is
// blocking-tier: it ALWAYS needs approval (a SendApprovalCard), and even after approval it only
// sends through the "double guard" (architecture §13.10.3 / phase-04 §6):
//   gateway:  approval exists · not expired · approved/edited · idempotency consumed once ·
//             content hash computed over the EFFECTIVE (post-edit) payload + HMAC-signed token;
//   Python:   token signature valid · token not expired · payload hash matches · idempotency not
//             in the send ledger · backend supports send  → then a real send.
// Any failure on either side → the email is NOT sent (tool-error + audit error code).
//
// 🔴 Gated behind MAILAGENT_AI_SDK_SEND_TOOL (buildGatewayTools sendToolEnabled) — off by
//    default, so the model never sees it unless the flag is on (with the Gateway + write tools).
// 🔴 The tool is NOT named `email_send` (the R2 forbidden "bare send" name); it is a human-gated
//    prepare-then-send, distinct from any auto-send the eval safety floor forbids.

import type { Tool } from 'ai'

import { DomainError, type MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard } from '../security/approval'
import { hashOutbound, signSendApprovalToken } from '../security/sendToken'
import type { OutboundPayload } from '../../shared/assistant/tools/security/hashOutboundPayload'
import { auditedSendTool, type GatewayToolAuditCollector } from './types'
import type { AgentContextMode } from './policy'
import { emailPrepareSendSchema, type EmailPrepareSendInput } from './schemas'

/** Name of the high-risk send tool the gateway exposes when MAILAGENT_AI_SDK_SEND_TOOL is on. */
export const GATEWAY_SEND_TOOL_NAMES = ['email_prepare_send'] as const

/** Trim + drop-empty an address list (the gateway's normalization; the canonical hash applies
 *  the SAME trim/compact, and Python mirrors it — so the hash is order-preserving + stable). */
function cleanList(xs: readonly string[] | undefined): string[] {
  return (xs ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
}

/** The hashable outbound payload (only the fields that actually go out). */
function outboundFromInput(input: EmailPrepareSendInput): OutboundPayload {
  return {
    to: cleanList(input.to),
    cc: cleanList(input.cc),
    bcc: cleanList(input.bcc),
    subject: input.subject,
    body: input.body_markdown
  }
}

const PREPARE_SEND_DESCRIPTION =
  'Prepare a real outbound email and send it ONLY after the user explicitly approves it in a ' +
  'send-confirmation card (blocking tier — it can never auto-send). Recipients are explicit: ' +
  'this composes a NEW message to the given to/cc/bcc with the given subject + markdown body — ' +
  'it does NOT reply to or quote a source email (use email_draft_reply for a reply draft). The ' +
  'user can edit every field (recipients / subject / body) on the card before approving; only ' +
  'then is a real SMTP send performed and the message filed to Sent. internal_id is optional ' +
  'context (which email this relates to), not a reply target. Use this ONLY when the user has ' +
  'clearly asked to actually send an email. davmail-only.'

/**
 * Build the email_prepare_send tool bound to the domain client + audit collector + approval
 * guard. The HMAC signing secret is the per-session local API token (shared with the Python
 * serve-api via env) so the approval token Python verifies needs no new key distribution.
 */
export function createSendTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector,
  guard: ApprovalGuard,
  opts: { signingSecret: string; a2uiEnabled?: boolean; contextMode?: AgentContextMode }
): Record<string, Tool> {
  const email_prepare_send = auditedSendTool<EmailPrepareSendInput>(
    {
      name: 'email_prepare_send',
      description: PREPARE_SEND_DESCRIPTION,
      inputSchema: emailPrepareSendSchema,
      // The user may edit recipients / subject / body on the SendApprovalCard; internal_id is
      // pinned (identity) so the side-channel can never retarget the send.
      editableFields: ['to', 'cc', 'bcc', 'subject', 'body_markdown'],
      a2uiEnabled: opts.a2uiEnabled,
      // S2 W0 — class outbound: outside manual_chat the send neither registers nor executes.
      contextMode: opts.contextMode,
      run: async (input, { signal, record }) => {
        const payload = outboundFromInput(input)
        if (payload.to.length === 0) {
          throw new DomainError('E_INVALID_ARG', 'at least one recipient (to) is required')
        }
        if (!record.idempotencyKey) {
          // A blocking record always carries one (register generates it) — defensive.
          throw new DomainError('E_INTERNAL', 'send approval is missing its idempotency key')
        }
        const contentHash = hashOutbound(payload)
        const idempotencyKey = record.idempotencyKey
        const expiresAt = record.expiresAt
        const approvalToken = signSendApprovalToken(opts.signingSecret, {
          contentHash,
          idempotencyKey,
          expiresAt
        })
        const internalId = typeof input.internal_id === 'number' ? input.internal_id : -1
        const data = await domain.sendApproved(
          {
            to: payload.to,
            cc: payload.cc ?? [],
            bcc: payload.bcc ?? [],
            subject: payload.subject,
            bodyText: payload.body,
            internalId,
            contentHash,
            idempotencyKey,
            approvalToken,
            expiresAt
          },
          signal
        )
        const output = {
          internal_id: internalId,
          sent: data.sent ?? true,
          message_id: data.message_id ?? null,
          archived_to_sent: data.archived_to_sent ?? false,
          method: data.method ?? null,
          to_count: data.to_count ?? payload.to.length,
          cc_count: data.cc_count ?? payload.cc?.length ?? 0,
          // Surface exactly what went out so the LLM next-turn states the truth.
          to: payload.to,
          cc: payload.cc ?? [],
          bcc_count: payload.bcc?.length ?? 0,
          subject: payload.subject
        }
        return { output, contentHash }
      }
    },
    collector,
    guard
  )
  return { email_prepare_send }
}
