// chat-panel P4 Phase 05 — AG-UI interrupt ↔ ai@6 tool-approval bridge.
//
// The MailAgent HITL approval (a write / high-risk-send tool that needs human sign-off) is, in
// AG-UI terms, an INTERRUPT: the run pauses and surfaces a "requires action" outcome the client
// must answer before it can resume. This module is the PURE, two-way translation between:
//   - the MailAgent / ai@6 approval REQUEST  ↔  the AG-UI interrupt value (forward), and
//   - the AG-UI interrupt RESPONSE           ↔  the ai@6 tool-approval-response transition (reverse).
//
// 🔴 SECURITY — the reverse path must NEVER become an alternate send path that skips the guard.
//    In ai@6 an approval is not a standalone message; it is a STATE TRANSITION on the existing tool
//    UI part: `state: 'approval-requested'` (carrying `approval: { id, signature }`) →
//    `state: 'approval-responded'` (carrying `approval: { id, approved, signature }`). We ONLY flip
//    that state + set `approved`; we KEEP the original ai@6 `signature` and DO NOT touch the part's
//    `input`. So when the route replays the history through the SAME streamText + tools +
//    experimental_toolApprovalSecret, ai@6 re-verifies the unchanged signed input and the domain
//    ApprovalGuard.verify/consume + content-hash + idempotency all fire in the tool's execute —
//    exactly the /api/ai/chat double guard (architecture §13.10.3 / §13.12.2). An `edited` decision
//    rides the 04a resolve side-channel (POST /api/ai/approval/resolve), which is unchanged here;
//    this module never rewrites the history input, so the signature stays valid.
//
// 🔴 Pure TS (no node:* / electron / crypto) — harness-testable; the only `ai` import is type-only.

import type { UIMessage } from 'ai'

import {
  AG_UI_INTERRUPT_CUSTOM_NAME,
  AgUiEventType,
  type AgUiCustomEvent,
  type AgUiEvent,
  type AgUiInterruptValue,
  type AgUiRunFinishedEvent
} from './events'

// ── protocol-contracts §7 payloads (the AI SDK Gateway approval contract) ─────────────────────

/** The approval REQUEST the gateway raises for a write / send tool (protocol-contracts §7). The
 *  route assembles it by joining the ai@6 `tool-approval-request` chunk (approvalId/toolCallId) +
 *  the accumulated tool input (toolName/input) + the domain ApprovalGuard record (risk/reason/
 *  expiry). 🔴 NO token / signing secret — those never leave the main process. */
export interface ToolApprovalRequestPayload {
  toolCallId: string
  toolName: string
  input: unknown
  approval: {
    id: string
    risk: 'preview' | 'edit' | 'blocking'
    reason: string
    /** ISO-8601 expiry (the approval TTL). The client must respond before it. */
    expiresAt: string
    contentHash?: string
  }
  /** Optional A2UI render payload (the same one the SendApprovalCard / write cards show). */
  a2ui?: unknown
}

/** The user's RESPONSE to an approval (protocol-contracts §7). `decision` maps to ai@6's
 *  `approved` boolean; `editedInput` is informational here (the actual edit rides the resolve
 *  side-channel), `contentHash` lets a caller bind the response to specific content. */
export interface ToolApprovalResponsePayload {
  toolCallId: string
  approvalId: string
  decision: 'approved' | 'rejected' | 'edited'
  editedInput?: unknown
  reason?: string
  contentHash?: string
}

/** The AG-UI interrupt-response wire shape the mirror accepts (AG-UI core does not standardize a
 *  HITL response, so this is the mirror's contract; a CopilotKit / custom client posts it back). */
export interface AgUiInterruptResponse {
  /** The interrupt id (== the approval id we surfaced). */
  id: string
  toolCallId: string
  decision: 'approved' | 'rejected' | 'edited'
  reason?: string
  editedInput?: unknown
  contentHash?: string
}

// ── forward: approval request → AG-UI interrupt ───────────────────────────────────────────────

/** Map an approval REQUEST to the AG-UI interrupt value (phase-05 §7). `name` = the tool name;
 *  the payload carries exactly what a client needs to render the approval card (NO secrets). */
export function approvalToAgUiInterrupt(req: ToolApprovalRequestPayload): AgUiInterruptValue {
  return {
    id: req.approval.id,
    name: req.toolName,
    payload: {
      toolCallId: req.toolCallId,
      input: req.input,
      risk: req.approval.risk,
      reason: req.approval.reason,
      expiresAt: req.approval.expiresAt,
      ...(req.a2ui !== undefined ? { a2ui: req.a2ui } : {})
    }
  }
}

/** The AG-UI events that express an interrupt: a CUSTOM `Interrupt` event carrying the value, then
 *  a RUN_FINISHED whose `result` is `requires_action` (the run paused; the client must respond).
 *  This is the AG-UI-faithful representation of "approval request → interrupt / requires-action
 *  outcome" (protocol-contracts §8: approval request → RUN_FINISHED with requires-action). */
export function interruptToAgUiEvents(
  interrupt: AgUiInterruptValue,
  ids: { threadId: string; runId: string }
): AgUiEvent[] {
  const custom: AgUiCustomEvent<AgUiInterruptValue> = {
    type: AgUiEventType.Custom,
    name: AG_UI_INTERRUPT_CUSTOM_NAME,
    value: interrupt
  }
  const finished: AgUiRunFinishedEvent = {
    type: AgUiEventType.RunFinished,
    threadId: ids.threadId,
    runId: ids.runId,
    result: { status: 'requires_action', interrupt }
  }
  return [custom, finished]
}

// ── reverse: AG-UI interrupt response → ai@6 tool-approval transition ──────────────────────────

/** Normalize an AG-UI interrupt response to the protocol-contracts §7 ToolApprovalResponsePayload
 *  (the canonical internal shape). Throws on a missing id / toolCallId so a malformed response can
 *  never be silently treated as an approval. */
export function aguiInterruptResponseToApproval(
  resp: AgUiInterruptResponse
): ToolApprovalResponsePayload {
  if (!resp || typeof resp.id !== 'string' || resp.id.length === 0) {
    throw new Error('AG-UI interrupt response missing approval id')
  }
  if (typeof resp.toolCallId !== 'string' || resp.toolCallId.length === 0) {
    throw new Error('AG-UI interrupt response missing toolCallId')
  }
  const decision: ToolApprovalResponsePayload['decision'] =
    resp.decision === 'approved' || resp.decision === 'edited' || resp.decision === 'rejected'
      ? resp.decision
      : 'rejected' // fail-closed: an unknown decision is treated as a rejection, never an approval
  return {
    toolCallId: resp.toolCallId,
    approvalId: resp.id,
    decision,
    ...(resp.editedInput !== undefined ? { editedInput: resp.editedInput } : {}),
    ...(resp.reason !== undefined ? { reason: resp.reason } : {}),
    ...(resp.contentHash !== undefined ? { contentHash: resp.contentHash } : {})
  }
}

/** A structural view of an ai@6 tool UI part in the `approval-requested` / `approval-responded`
 *  state (we narrow by these fields rather than importing ai's heavy generic ToolUIPart). */
interface ToolApprovalPartLike {
  type: string
  toolCallId?: string
  state?: string
  approval?: { id: string; approved?: boolean; reason?: string; signature?: string }
  [key: string]: unknown
}

function isApprovalRequestedPart(part: unknown): part is ToolApprovalPartLike {
  if (!part || typeof part !== 'object') return false
  const p = part as ToolApprovalPartLike
  return (
    typeof p.type === 'string' &&
    p.type.startsWith('tool-') &&
    p.state === 'approval-requested' &&
    !!p.approval &&
    typeof p.approval.id === 'string'
  )
}

/**
 * Apply an interrupt response to a UIMessage history: find the tool part awaiting this approval
 * (matched by approvalId, and — when the part carries one — toolCallId) and transition it from
 * `approval-requested` → `approval-responded`, setting `approved` from the decision and KEEPING
 * the original ai@6 `signature`. Returns the (new) messages + whether a part was found.
 *
 * 🔴 This is the ONLY mutation the reverse path performs. It does NOT change the part's `input`
 *    (so the signed input is unchanged → ai@6's signature stays valid on replay) and it does NOT
 *    perform any write itself — the route replays these messages through the same approval-gated
 *    tools, where the domain guard runs. An `edited` / `approved` decision both set approved=true
 *    (the edit itself rides the resolve side-channel); `rejected` sets approved=false → ai@6 emits
 *    a denied tool output and no execute runs.
 */
export function applyApprovalResponseToMessages(
  messages: readonly UIMessage[],
  resp: ToolApprovalResponsePayload
): { messages: UIMessage[]; applied: boolean } {
  const approved = resp.decision === 'approved' || resp.decision === 'edited'
  let applied = false
  const next = messages.map((msg) => {
    if (!Array.isArray(msg.parts)) return msg
    const parts = msg.parts.map((part) => {
      if (applied) return part
      if (!isApprovalRequestedPart(part)) return part
      if (part.approval!.id !== resp.approvalId) return part
      if (
        typeof part.toolCallId === 'string' &&
        part.toolCallId.length > 0 &&
        part.toolCallId !== resp.toolCallId
      ) {
        return part
      }
      applied = true
      return {
        ...part,
        state: 'approval-responded',
        approval: {
          id: part.approval!.id,
          approved,
          ...(resp.reason !== undefined ? { reason: resp.reason } : {}),
          ...(part.approval!.signature !== undefined ? { signature: part.approval!.signature } : {})
        }
      }
    })
    return applied ? ({ ...msg, parts } as UIMessage) : msg
  })
  return { messages: next, applied }
}
