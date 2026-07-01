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
