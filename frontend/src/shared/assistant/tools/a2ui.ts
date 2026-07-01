// chat-panel P4 Phase 04a — A2UI payload contract + tool→card mapper (single source).
//
// A2UI is MailAgent's typed "tool UI render payload" (protocol-contracts §3): NOT a
// replacement for AI SDK / AG-UI, just a typed payload that carries WHICH card renders a
// tool's approval / result and WITH WHAT props. This module is the ONE place that
//   1. declares the A2UIPayload shape + a runtime zod validator (parseA2UIPayload), and
//   2. maps a gateway tool's (name, args, result) → an A2UIPayload (buildToolA2UIPayload).
//
// It is consumed by BOTH sides so the render and the audit can never drift:
//   - the rich tool cards (frontend, @shared) call buildToolA2UIPayload to derive their
//     typed props from the live tool part (args at approval-request time, args+result at
//     output time), then render from those props;
//   - the AI SDK Gateway write tools (relative import, pure Node) call it in `execute` to
//     stamp the SAME payload into chat_tool_call.ui_payload_json (audit). The payload is
//     NEVER added to the model-visible tool result (that would break 03b parity + add model
//     noise) — it is a UI/audit concern only.
//
// 🔴 Pure TS (types + zod, no react / electron / ai imports) so the gateway core stays
//    harness-loadable under tsx and this module is directly unit-testable. The react cards
//    that use these props live in their own *.tsx files.

import { z } from 'zod'

/** A2UI protocol identity (protocol-contracts §3 + §9 versioning). A breaking props change
 *  must bump the major (1.0 → 2.0); additive props stay 1.0. */
export const A2UI_PROTOCOL = 'a2ui.mailagent' as const
export const A2UI_VERSION = '1.0' as const

/** Risk tier carried in the audit envelope. Mirrors the write-tool confirmationTier plus
 *  the read-tool 'trace' floor (protocol-contracts §3). */
export type A2UIRisk = 'trace' | 'preview' | 'edit' | 'blocking'

/** A user-actionable intent a card MAY surface (protocol-contracts §3). Phase 04a cards
 *  drive approval through assistant-ui's native respondToApproval rather than these, so
 *  intents are carried for audit/forward-compat but not required to render. */
export interface A2UIIntent {
  id: string
  label: string
  kind: 'primary' | 'secondary' | 'danger'
  payload?: unknown
}

/** The typed tool-UI render payload (protocol-contracts §3). `component` selects the card
 *  (the ComponentRegistry key); `props` is the card's typed input. */
export interface A2UIPayload<Props = Record<string, unknown>> {
  protocol: typeof A2UI_PROTOCOL
  version: typeof A2UI_VERSION
  component: string
  props: Props
  intents?: A2UIIntent[]
  audit?: {
    risk: A2UIRisk
    requiresApproval: boolean
    approvalId?: string
    contentHash?: string
  }
}

const intentSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['primary', 'secondary', 'danger']),
  payload: z.unknown().optional()
})

/** Runtime validator — an UNTRUSTED a2ui blob (e.g. round-tripped through persistence or a
 *  remote turn) is parsed through this; a malformed payload yields null so the caller can
 *  fall back to the generic ToolTraceCard instead of throwing (registry-miss-never-blocks). */
export const a2uiPayloadSchema = z.object({
  protocol: z.literal(A2UI_PROTOCOL),
  version: z.literal(A2UI_VERSION),
  component: z.string().min(1),
  props: z.record(z.string(), z.unknown()),
  intents: z.array(intentSchema).optional(),
  audit: z
    .object({
      risk: z.enum(['trace', 'preview', 'edit', 'blocking']),
      requiresApproval: z.boolean(),
      approvalId: z.string().optional(),
      contentHash: z.string().optional()
    })
    .optional()
})

/** Parse an untrusted value into an A2UIPayload, or null when it does not validate. Never
 *  throws — a schema-invalid payload must degrade to the generic card, not break the chat. */
export function parseA2UIPayload(value: unknown): A2UIPayload | null {
  const r = a2uiPayloadSchema.safeParse(value)
  return r.success ? (r.data as A2UIPayload) : null
}

// ── component names (the ComponentRegistry keys) ─────────────────────────────

export const A2UI_COMPONENTS = {
  DraftReplyCard: 'DraftReplyCard',
  NotionSyncCard: 'NotionSyncCard',
  ApprovalActionCard: 'ApprovalActionCard',
  // Phase 04b — the high-risk outbound send card (email_prepare_send, blocking tier).
  SendApprovalCard: 'SendApprovalCard',
  // M4b — the agent's Standing Context doc edit approval card (update_system_md, edit tier;
  // soul/rules get the high-risk red treatment + the PRODUCT_SAFETY_FLOOR note).
  SystemDocApprovalCard: 'SystemDocApprovalCard',
  // M4c — the skill enable/disable (mount/unmount) approval card (set_skill_enabled, preview tier).
  SkillToggleCard: 'SkillToggleCard'
} as const

/** Which A2UI component renders a given gateway write tool. Unknown / read tools → null
 *  (the card layer falls back to the generic ToolTraceCard; "registry miss never blocks"). */
export function componentForTool(toolName: string): string | null {
  switch (toolName) {
    case 'email_draft_reply':
      return A2UI_COMPONENTS.DraftReplyCard
    case 'email_resync':
      return A2UI_COMPONENTS.NotionSyncCard
    case 'email_flag':
    case 'email_archive':
    case 'email_pin':
      return A2UI_COMPONENTS.ApprovalActionCard
    case 'email_prepare_send':
      return A2UI_COMPONENTS.SendApprovalCard
    case 'update_system_md':
      return A2UI_COMPONENTS.SystemDocApprovalCard
    case 'set_skill_enabled':
      return A2UI_COMPONENTS.SkillToggleCard
    // discover_skills is a silent read → no card (generic ToolTraceCard).
    default:
      return null
  }
}

// ── typed per-card props ──────────────────────────────────────────────────────

/** email_draft_reply (edit tier). At approval-request time only `internalId`+`bodyMarkdown`
 *  are known (from the model input); the draftId/mailbox land after execution. `userEdited`
 *  is true once the user changed the proposed body before approving. */
export interface DraftReplyCardProps {
  internalId: number
  bodyMarkdown: string
  draftId?: string | null
  mailbox?: string | null
  accountName?: string | null
  userEdited?: boolean
}

/** email_resync (preview tier) — re-push to Notion from the SQLite SSoT. */
export interface NotionSyncCardProps {
  internalId: number
  oldPageId?: string | null
  newPageId?: string | null
  action?: string | null
}

/** email_flag / email_archive / email_pin (preview tier) — a generic approve/reject card.
 *  `summary` is a short human description of the proposed change; `applied` echoes the
 *  result (set after execution). */
export interface ApprovalActionCardProps {
  toolName: string
  internalId: number
  summary: string
  applied?: Record<string, unknown> | null
}

/** email_prepare_send (blocking tier) — the high-risk outbound send card. At approval-request
 *  time the recipients / subject / body come from the model input (all editable); after the send
 *  runs, the result fields (sent / messageId / archivedToSent) land. `internalId` is optional
 *  source context, pinned (not editable). */
export interface SendApprovalCardProps {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  bodyMarkdown: string
  internalId?: number
  sent?: boolean
  messageId?: string | null
  archivedToSent?: boolean
}

/** update_system_md (M4b, edit tier) — the agent proposes new content for a Standing Context doc.
 *  `highRisk` is true for soul/rules (identity + hard constraints) → the card uses the red high-risk
 *  treatment + the PRODUCT_SAFETY_FLOOR note. `contentPreview` is a truncated view of the proposed
 *  markdown (the full content rides the editable approval input). `appliedHash` lands after execute. */
export interface SystemDocApprovalCardProps {
  docName: string
  highRisk: boolean
  contentPreview: string
  contentLength: number
  userEdited?: boolean
  appliedHash?: string | null
}

/** set_skill_enabled (M4c, preview tier) — enable/disable a skill (mount/unmount its tools). */
export interface SkillToggleCardProps {
  skillName: string
  enabled: boolean
  applied?: boolean
}

function asNum(v: unknown, fallback = -1): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Build a short human summary for the generic approval card from a flag/archive/pin input. */
function summarizeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'email_flag': {
      const parts: string[] = []
      if (typeof args.is_read === 'boolean') parts.push(args.is_read ? '标为已读' : '标为未读')
      if (typeof args.is_flagged === 'boolean') parts.push(args.is_flagged ? '加旗标' : '去旗标')
      if (typeof args.processing_status === 'string' && args.processing_status)
        parts.push(`处理状态→${String(args.processing_status)}`)
      return parts.length ? parts.join('，') : '更新邮件标记'
    }
    case 'email_archive':
      return '归档邮件（移入存档文件夹）'
    case 'email_pin':
      return args.pinned === false ? '取消置顶' : '置顶邮件'
    default:
      return '执行写操作'
  }
}

/**
 * Map a gateway write tool's (name, args, result?) to its A2UIPayload. `args` is the model
 * input (or, post-edit, the effective executed input); `result` is the tool output once
 * available. Returns null for any tool with no registered card (the caller falls back to the
 * generic ToolTraceCard). This is the SINGLE mapper both the cards (render) and the gateway
 * (audit) call, so what the user sees and what is audited can never diverge.
 */
export function buildToolA2UIPayload(
  toolName: string,
  io: { args: unknown; result?: unknown; userEdited?: boolean; risk?: A2UIRisk }
): A2UIPayload | null {
  const component = componentForTool(toolName)
  if (!component) return null
  const args = asObj(io.args) ?? {}
  const result = asObj(io.result)
  const requiresApproval = true // every write card is approval-gated (preview/edit)

  if (component === A2UI_COMPONENTS.DraftReplyCard) {
    const props: DraftReplyCardProps = {
      internalId: asNum(result?.internal_id ?? args.internal_id),
      // result.final_body_markdown is the EXECUTED body (post-edit); fall back to the
      // proposed input body at approval-request time.
      bodyMarkdown: asStr(result?.final_body_markdown) ?? asStr(args.body_markdown) ?? '',
      draftId: asStr(result?.draft_id) ?? null,
      mailbox: asStr(result?.mailbox) ?? null,
      accountName: asStr(result?.account_name) ?? null,
      userEdited: io.userEdited ?? result?.user_edited === true
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'edit', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.NotionSyncCard) {
    const props: NotionSyncCardProps = {
      internalId: asNum(result?.internal_id ?? args.internal_id),
      oldPageId: asStr(result?.old_page_id) ?? null,
      newPageId: asStr(result?.new_page_id) ?? null,
      action: asStr(result?.action) ?? null
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'preview', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.SendApprovalCard) {
    const props: SendApprovalCardProps = {
      // at approval-request time the fields come from args; after the send the result echoes
      // the exact sent recipients/subject (final source of truth).
      to: asStrArray(result?.to ?? args.to),
      cc: asStrArray(result?.cc ?? args.cc),
      bcc: asStrArray(args.bcc),
      subject: asStr(result?.subject) ?? asStr(args.subject) ?? '',
      bodyMarkdown: asStr(args.body_markdown) ?? '',
      internalId: typeof args.internal_id === 'number' ? args.internal_id : undefined,
      sent: result?.sent === true,
      messageId: asStr(result?.message_id) ?? null,
      archivedToSent: result?.archived_to_sent === true
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'blocking', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.SystemDocApprovalCard) {
    const docName = asStr(args.doc_name) ?? ''
    // M4b review MED-3 — soul/agent/rules are high-risk (identity / operating memory / hard rules);
    // user (preferences) is normal. The flag drives the card's red treatment + safety-floor note.
    const highRisk = docName === 'soul' || docName === 'agent' || docName === 'rules'
    // M4b review HIGH-2 — update_system_md is a FULL doc replacement; NEVER truncate the review
    // surface. The card shows the COMPLETE proposed content (scrollable) so the user reviews exactly
    // what will be written (approve/reject of the full content — the card has no edit UI).
    const content = asStr(result?.content) ?? asStr(args.content) ?? ''
    const props: SystemDocApprovalCardProps = {
      docName,
      highRisk,
      contentPreview: content,
      contentLength: [...content].length,
      userEdited: io.userEdited ?? result?.user_edited === true,
      appliedHash: asStr(result?.content_hash) ?? null
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'edit', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.SkillToggleCard) {
    const props: SkillToggleCardProps = {
      skillName: asStr(args.skill_name) ?? '',
      enabled: args.enabled === true,
      applied: typeof result?.enabled === 'boolean' ? (result.enabled as boolean) : undefined
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'preview', requiresApproval }
    }
  }

  // ApprovalActionCard (flag / archive / pin)
  const props: ApprovalActionCardProps = {
    toolName,
    internalId: asNum(result?.internal_id ?? args.internal_id),
    summary: summarizeAction(toolName, args),
    applied: result ?? null
  }
  return {
    protocol: A2UI_PROTOCOL,
    version: A2UI_VERSION,
    component,
    props: props as unknown as Record<string, unknown>,
    audit: { risk: io.risk ?? 'preview', requiresApproval }
  }
}
