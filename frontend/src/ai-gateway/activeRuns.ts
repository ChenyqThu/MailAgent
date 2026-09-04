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
  private readonly onSessionIdle?: (sessionId: number) => void

  constructor(opts?: { now?: () => number; onSessionIdle?: (sessionId: number) => void }) {
    this.now = opts?.now ?? (() => Date.now())
    this.onSessionIdle = opts?.onSessionIdle
  }

  /** True when a live run is registered for this session. Aborted entries age out defensively. */
  hasActive(sessionId: number): boolean {
    return this.getActive(sessionId) != null
  }

  /** The live run entry for a session (never the controller — read-only probe), or null. */
  getActive(sessionId: number): ActiveRunEntry | null {
    const entry = this.bySession.get(sessionId)
    if (!entry) return null
    if (this.now() - entry.startedAt >= STALE_RUN_MS && entry.controller.signal.aborted) return null
    return { runId: entry.runId, sessionId: entry.sessionId, startedAt: entry.startedAt }
  }

  /**
   * Register a new run for a session. Returns the minted runId, or null when a live run already
   * holds the session (the caller rejects the second POST with 409). A non-aborted headless run may
   * legitimately outlive STALE_RUN_MS, so only an already-aborted entry can be replaced.
   */
  register(sessionId: number, controller: AbortController): { runId: string } | null {
    const existing = this.bySession.get(sessionId)
    if (existing) {
      if (!existing.controller.signal.aborted) return null
      // already aborted — take the slot; its stale finally cannot evict this newer run.
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
   *  one registered) is a no-op, so a finally can always call it safely. Returns whether THIS call
   *  is the one that ended the run.
   *
   *  0903 —— 这里是「一轮结束了」的唯一收敛点。chat 的三条排干路径（attached response close /
   *  detached finally / overflow finally）、/decide resume、headless agent run、群调度器，全都在
   *  终止时经过这一行；而 onFinish 只覆盖「跑到了收尾回调」的那些（drain 自己抛、pipe 同步抛、
   *  abort 都到不了它）。排队追问的 drain 因此挂在 onSessionIdle 而不是 onFinish 上。
   *  🔴 stop() 有意不通知：那条路的队列语义由 /run/stop（restoreForSession）与 interrupt 端点
   *  自己负责，被停那一轮随后的 release 返回 false，不会再触发一次。 */
  release(sessionId: number, runId: string): boolean {
    const entry = this.bySession.get(sessionId)
    if (!entry || entry.runId !== runId) return false
    this.bySession.delete(sessionId)
    try {
      this.onSessionIdle?.(sessionId)
    } catch (err) {
      // 通知失败绝不能把释放本身变成异常（释放没完成 = 会话被永久锁住，比漏一次 drain 更糟）。
      console.error('[ai-gateway] onSessionIdle threw (run released OK)', err)
    }
    return true
  }

  /** Explicit stop (POST /api/ai/run/stop): abort the run's controller AND remove the entry so the
   *  session is immediately free for a fresh turn (the aborted drain's finally release is a no-op).
   *  Returns whether anything was stopped. */
  stop(sessionId: number): { stopped: boolean; runId?: string } {
    const entry = this.bySession.get(sessionId)
    if (!entry) return { stopped: false }
    this.bySession.delete(sessionId)
    try {
      entry.controller.abort('E_RUN_STOPPED')
    } catch {
      /* already settled */
    }
    return { stopped: true, runId: entry.runId }
  }

  size(): number {
    return this.bySession.size
  }
}
