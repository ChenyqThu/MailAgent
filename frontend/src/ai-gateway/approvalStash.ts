// chat-panel Part B (harness 上岛) — server-side approval-run stash for full-offline island resume.
//
// Problem (design harness-island-integration-design.md §4): the AI SDK HITL is a TWO-call flow. On
// the first /api/ai/chat the write tool's needsApproval ends the run with a `tool-approval-request`
// part; the run is NOT resumed by the gateway — the RENDERER replays the full history + a
// `tool-approval-response` on a second /api/ai/chat. If the user leaves the app (renderer unmounted),
// nobody sends that second call → the tool never resumes. "完全离岛" requires the gateway to resume
// itself when the island approval comes back.
//
// This stash is the missing piece: when a turn pauses awaiting approval (makePersistOnFinish sees a
// `tool-approval-request` part), it stashes the run context (the original request body + the paused
// assistant message) keyed by toolCallId. POST /api/ai/approval/decide then reconstructs the resume
// history from the stash and re-runs streamText server-side (approvalResume.ts).
//
// 🔴 Pure Node (node:crypto only) — no electron / ai / http. Directly unit-testable. One instance per
//    gateway process (the lifecycle constructs it and injects it via cfg.approvalStash), mirroring the
//    ApprovalGuard's per-gateway-start lifetime: a gateway restart drops all pending → /decide fails
//    closed (fail-closed is safe for a write gate).
//
// 🔴 SECURITY — the `resumeToken` is an unguessable capability the gateway generates at stash time and
//    hands to serve-api's announce; serve-api stores it in the island ack pending and echoes it back on
//    /decide. claim() rejects a wrong token WITHOUT deleting (no grief), so only the legitimate
//    serve-api round-trip can resume. Combined with the ApprovalGuard's input-hash + one-shot consume,
//    a same-machine process cannot forge an approval it didn't originate.

import { randomUUID } from 'node:crypto'

import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
import type { AgentContextMode, AgentRunContext } from './tools/policy'

/** 30 min — long enough for a human to notice the island card and come back; matches the island ack
 *  pending TTL (island_agent.DEFAULT_AGENT_ACK_TTL_SEC) AND the extended ApprovalGuard TTL the
 *  lifecycle sets when island agent is on (so verify() doesn't expire before the stash does). */
export const DEFAULT_STASH_TTL_MS = 30 * 60 * 1000

/** Cap the pending map so a stream of never-clicked approvals can't grow unbounded (each paused turn
 *  adds one row; normal use is far below this — an overflow drops the oldest). */
const MAX_STASH = 200

/** What makePersistOnFinish hands the stash when a turn pauses at an approval gate. */
export interface StashInput {
  toolCallId: string
  /** The ai@6/ai@7 approval id carried on the paused tool part (applyApprovalResponseToMessages
   *  matches on it when folding the decision back in). */
  approvalId: string
  toolName: string
  sessionId: number | null
  /** The ORIGINAL request body — kept verbatim so the resume re-runs with the same model / thinking /
   *  contextSnapshot / system / approvalMode. injectedContext is stripped at resume time (the chips
   *  were consumed on the first send; the renderer doesn't re-inject on its resume either). */
  body: Record<string, unknown>
  /** The paused assistant UIMessage carrying the `tool-approval-request` part. Appended to
   *  body.messages to form the resume history. */
  responseMessage: MailAgentUIMessage
  /** S2 W0 (ADR-001 D1) — the trusted context mode FROZEN at pause time. The mode never rides the
   *  body (a client could forge it there); the resume reads it back from here and passes it to
   *  prepareChatRun as the trusted parameter, so an island resume runs under exactly the mode the
   *  original entrypoint asserted — it can never escalate. REQUIRED: the stash is process-memory
   *  (gateway restart drops it), so there is no cross-version row to stay compatible with. */
  contextMode: AgentContextMode
  /** S5 W4 (ADR-004 §4.4) — the per-agent tool context FROZEN at pause time (same discipline as
   *  contextMode: read from the pause-time server cfg, never from a body). The island resume
   *  rebuilds cfg through wrapCfgForAgentRun with exactly this object, so the resumed drain keeps
   *  the same allowedTools narrowing + grants — pause→resume can never widen the tool face. Also
   *  the fix for the S4 defect where a resumed agent run silently lost its allowedTools narrowing
   *  (resume used the base cfg). Manual runs stash undefined here → byte-identical to the
   *  pre-ADR-004 stash. */
  agentRunContext?: AgentRunContext
  /** Stage 2 PR-4 (task 08-01 messenger) — is the paused tool DESTRUCTIVE (the MCP server's own
   *  `destructive_hint`)? Frozen here so an OUT-OF-APP approval surface (the Feishu card today,
   *  any future messenger) can render the same red warning the desktop McpApprovalCard does.
   *  🔴 Sourced from the runtime connector registry (`isRuntimeToolDestructive`), NEVER from the
   *  model-proposed args — a model must not be able to spoof the warning away (the
   *  McpApprovalCard / CalendarApprovalCard precedent). Undefined for every non-connector tool
   *  and for connector tools registered before this field existed → `/pending` reports false,
   *  i.e. "no warning", which is the pre-PR-4 behaviour byte for byte. */
  destructive?: boolean
}

export interface StashedApprovalRun extends StashInput {
  resumeToken: string
  createdAt: number
  expiresAt: number
}

/**
 * Per-gateway store of paused approval runs awaiting an island decision. stash() returns an
 * unguessable resumeToken; claim() is a one-shot: it validates the token + expiry and removes the
 * entry so a decision can be applied at most once (a second /decide → not found). peek() is a
 * read-only probe (never mutates).
 */
export class ApprovalRunStash {
  private readonly store = new Map<string, StashedApprovalRun>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly genToken: () => string

  constructor(opts?: { ttlMs?: number; now?: () => number; genToken?: () => string }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_STASH_TTL_MS
    this.now = opts?.now ?? (() => Date.now())
    this.genToken = opts?.genToken ?? (() => randomUUID())
  }

  /** Stash a paused run; returns the resumeToken (the lifecycle sends it to serve-api's announce). A
   *  re-stash of the same toolCallId overwrites (keep-latest) — a re-evaluation of the SAME approval
   *  yields a fresh token, and only the latest announce is live. GCs expired rows + caps size. */
  stash(input: StashInput): string {
    this.gc()
    if (this.store.size >= MAX_STASH && !this.store.has(input.toolCallId)) {
      // drop the oldest (insertion order = Map iteration order)
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    const createdAt = this.now()
    const resumeToken = this.genToken()
    this.store.set(input.toolCallId, {
      ...input,
      resumeToken,
      createdAt,
      expiresAt: createdAt + this.ttlMs
    })
    return resumeToken
  }

  /**
   * One-shot claim for resume. Returns the entry and removes it when the token matches and it hasn't
   * expired; returns null (leaving the entry intact) on a wrong token so a forger can't grief the
   * legitimate approval. An expired entry is dropped + rejected. A missing entry → null (fail-closed:
   * gateway restarted / already claimed).
   */
  claim(toolCallId: string, resumeToken: string): StashedApprovalRun | null {
    const entry = this.store.get(toolCallId)
    if (!entry) return null
    if (this.now() >= entry.expiresAt) {
      this.store.delete(toolCallId)
      return null
    }
    if (entry.resumeToken !== resumeToken) return null // wrong token → do NOT delete (no grief)
    this.store.delete(toolCallId) // valid → one-shot
    return entry
  }

  /** Read-only probe (never mutates / never expires it) — for diagnostics. */
  peek(toolCallId: string): StashedApprovalRun | null {
    return this.store.get(toolCallId) ?? null
  }

  /** Read-only per-session probe (GET /api/ai/approval/pending): the latest LIVE stashed run
   *  belonging to this ai_chat.db session, or null. Never consumes, never extends TTL, never
   *  deletes — expired rows are skipped, not GC'd (gc stays on the stash() write path). Keep-latest
   *  matches stash(): on a repause chain only the most recently stashed approval is live. */
  peekBySession(sessionId: number): StashedApprovalRun | null {
    const now = this.now()
    let latest: StashedApprovalRun | null = null
    for (const entry of this.store.values()) {
      if (entry.sessionId !== sessionId || now >= entry.expiresAt) continue
      if (latest === null || entry.createdAt >= latest.createdAt) latest = entry
    }
    return latest
  }

  /** S6 W2 (PRD P9) — read-only lookup by the ai@6/ai@7 approvalId. The in-record /decide takes only
   *  { approvalId, decision } (no resumeToken): it resolves the internal toolCallId + resumeToken from
   *  the matching LIVE entry so the capability token NEVER leaves the gateway. Returns the latest live
   *  match (keep-latest, mirrors peekBySession) or null (expired/absent skipped; never mutates). A
   *  wrong/stale approvalId → null → the /decide route fails closed (404 not_found). */
  peekByApprovalId(approvalId: string): StashedApprovalRun | null {
    const now = this.now()
    let latest: StashedApprovalRun | null = null
    for (const entry of this.store.values()) {
      if (entry.approvalId !== approvalId || now >= entry.expiresAt) continue
      if (latest === null || entry.createdAt >= latest.createdAt) latest = entry
    }
    return latest
  }

  /** Drop expired rows. Called on stash(); cheap (map scan). */
  gc(): void {
    const now = this.now()
    for (const [k, v] of this.store) {
      if (now >= v.expiresAt) this.store.delete(k)
    }
  }

  size(): number {
    return this.store.size
  }
}
