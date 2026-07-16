// harness-chat lane A (B1, task 07-15) — per-session active chat-run registry for detached runs.
//
// With MAILAGENT_CHAT_DETACHED_RUNS on, a client disconnect no longer aborts the upstream LLM call
// (the run drains server-side to onFinish → persistTurn). That removes the implicit "close the tab
// to stop it" channel, so this registry provides the two replacements:
//   1. `POST /api/ai/run/stop` — the EXPLICIT stop channel (the composer stop button's fetch-abort
//      side-channel posts here; see useMailAgentAiSdkRuntime's transport fetch wrapper).
//   2. `GET /api/ai/run/active?sessionId=N` — the truth probe a panel uses after a session switch to
//      render the "AI 仍在后台输出…" placeholder (and to reload when the run settles).
// It is ALSO the same-session concurrency gate: while a run is active for a session, a second
// POST /api/ai/chat for that session is rejected 409 (E_RUN_ACTIVE) — without it, a user switching
// back mid-run and sending again would interleave two turns' persistence (行序交错 / duplicate
// semantics; research §3.2).
//
// 🔴 Pure Node (node:crypto only) — no electron / ai / http. One instance per gateway process,
//    constructed by the lifecycle and injected via cfg.activeRuns (mirrors the ApprovalRunStash
//    discipline: process-memory, a gateway restart drops all entries — /run/active then reports the
//    fail-closed truth "nothing running").

import { randomUUID } from 'node:crypto'

/** Hard staleness cap. A drain that somehow never terminates (upstream hangs without honoring the
 *  abort) must not wedge its session forever: entries older than this are treated as gone by
 *  hasActive/getActive, and register() aborts + replaces them. Generous vs the longest legitimate
 *  tool-loop turn. */
export const STALE_RUN_MS = 15 * 60 * 1000

export interface ActiveRunEntry {
  runId: string
  sessionId: number
  startedAt: number
}

interface StoredRun extends ActiveRunEntry {
  controller: AbortController
}

/**
 * Per-gateway map of in-flight detached chat runs, keyed by ai_chat.db session id. register() is the
 * atomic same-session gate (an existing live entry → null → the caller answers 409); release() is
 * runId-matched so a stale finally can never evict a newer run; stop() aborts + removes so a fresh
 * run can start immediately after an explicit stop.
 */
export class ActiveRunRegistry {
  private readonly bySession = new Map<number, StoredRun>()
  private readonly now: () => number

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now())
  }

  /** True when a LIVE (non-stale) run is registered for this session. */
  hasActive(sessionId: number): boolean {
    return this.getActive(sessionId) != null
  }

  /** The live run entry for a session (never the controller — read-only probe), or null. */
  getActive(sessionId: number): ActiveRunEntry | null {
    const entry = this.bySession.get(sessionId)
    if (!entry) return null
    if (this.now() - entry.startedAt >= STALE_RUN_MS) return null
    return { runId: entry.runId, sessionId: entry.sessionId, startedAt: entry.startedAt }
  }

  /**
   * Register a new run for a session. Returns the minted runId, or null when a LIVE run already
   * holds the session (the caller rejects the second POST with 409). A STALE entry (drain wedged
   * past STALE_RUN_MS) is aborted + replaced rather than blocking the session forever.
   */
  register(sessionId: number, controller: AbortController): { runId: string } | null {
    const existing = this.bySession.get(sessionId)
    if (existing) {
      if (this.now() - existing.startedAt < STALE_RUN_MS) return null
      // stale — abort the wedged run defensively and take the slot.
      try {
        existing.controller.abort()
      } catch {
        /* already settled */
      }
    }
    const runId = randomUUID()
    this.bySession.set(sessionId, { runId, sessionId, startedAt: this.now(), controller })
    return { runId }
  }

  /** Remove a finished run. runId-matched: a stale release (this run was already stopped and a new
   *  one registered) is a no-op, so a finally can always call it safely. */
  release(sessionId: number, runId: string): void {
    const entry = this.bySession.get(sessionId)
    if (entry && entry.runId === runId) this.bySession.delete(sessionId)
  }

  /** Explicit stop (POST /api/ai/run/stop): abort the run's controller AND remove the entry so the
   *  session is immediately free for a fresh turn (the aborted drain's finally release is a no-op).
   *  Returns whether anything was stopped. */
  stop(sessionId: number): { stopped: boolean; runId?: string } {
    const entry = this.bySession.get(sessionId)
    if (!entry) return { stopped: false }
    this.bySession.delete(sessionId)
    try {
      entry.controller.abort()
    } catch {
      /* already settled */
    }
    return { stopped: true, runId: entry.runId }
  }

  size(): number {
    return this.bySession.size
  }
}
