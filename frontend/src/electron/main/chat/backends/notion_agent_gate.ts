// Global serial gate for the notion-agent backend (prevention layer).
//
// WHY: every `notion-agent chat` subprocess drives Notion's internal ✦ AI
// endpoint, which a server-side anti-automation "trust rule" protects. A
// burst of *concurrent* automated calls pushes the session into strict mode
// → exit 75 (E_NOTION_AGENT_RATE_LIMIT) + a multi-minute ban. The per-session
// AbortController in dispatcher.ts only serializes within ONE sessionId;
// cross-session sends and chat popout windows each spawn their own subprocess
// against the same endpoint concurrently — the main strict-mode trigger.
//
// commit 571ae22 added the *reactive* side (exit 75 → cooldown backoff). This
// is the *preventive* side. It lives in the Electron main process, where EVERY
// notion-agent subprocess is spawned (popout windows are BrowserWindows in the
// same process), so a module-level singleton serializes them all:
//   - at most ONE notion-agent subprocess runs at a time (mutex), and
//   - consecutive subprocess *starts* are spaced ≥ minInterval apart (rate
//     limit). Measured from the previous start (not its end) so it overlaps
//     the usually-long (10–90s) call duration and only adds wait on a genuine
//     back-to-back burst (popout + main window firing together, rapid resend).
//
// custom-api never touches this gate — it hits the Anthropic API, which has no
// trust rule. See dispatcher.ts (drain on app-quit) + config.getNotionAgentMinIntervalMs.

import { getNotionAgentMinIntervalMs } from '../config'

export type GateRelease = () => void

interface Waiter {
  signal: AbortSignal
  resolve: (release: GateRelease) => void
  reject: (err: Error) => void
  onAbort: () => void
  settled: boolean
}

export interface SerialGateOptions {
  /** Minimum ms between consecutive grant *starts*. Read fresh on every pump
   *  so an env change (or a test override) takes effect without a restart. */
  getMinIntervalMs: () => number
  /** Clock seam — tests inject a manual clock. Default: `Date.now`. */
  now?: () => number
  /** Timer seam — tests inject a manual scheduler. Returns a canceler.
   *  Default: `setTimeout` / `clearTimeout`. */
  schedule?: (fn: () => void, ms: number) => () => void
}

/** AbortError shape the generator branches on (`req.signal.aborted` check). */
function abortError(): Error {
  const err = new Error('notion-agent gate: aborted before acquire')
  err.name = 'AbortError'
  return err
}

export class NotionAgentSerialGate {
  private readonly queue: Waiter[] = []
  private active = false
  // Start at -∞ so the very first call never waits on the min-interval.
  private lastStartMs = Number.NEGATIVE_INFINITY
  private cancelTimer: (() => void) | null = null

  private readonly getMinIntervalMs: () => number
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => () => void

  constructor(opts: SerialGateOptions) {
    this.getMinIntervalMs = opts.getMinIntervalMs
    this.now = opts.now ?? (() => Date.now())
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      })
  }

  /** Acquire the gate. The returned promise resolves with a `release()` once
   *  it's this caller's turn (mutex free AND min-interval elapsed). It rejects
   *  with an AbortError if `signal` fires while still queued, or if the gate is
   *  drained at shutdown — in both cases the caller never held the gate, so
   *  there is nothing to release. `release()` is idempotent; call it exactly
   *  once (a `finally` block) when the granted work finishes. */
  acquire(signal: AbortSignal): Promise<GateRelease> {
    return new Promise<GateRelease>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError())
        return
      }
      const waiter: Waiter = { signal, resolve, reject, settled: false, onAbort: () => {} }
      waiter.onAbort = () => {
        if (waiter.settled) return
        waiter.settled = true
        const i = this.queue.indexOf(waiter)
        if (i >= 0) this.queue.splice(i, 1)
        reject(abortError())
        // This waiter may have been the head a timer was scheduled for; pump
        // so the next waiter isn't stranded. The pending timer (if any) still
        // targets the correct absolute earliest-start time and will grant the
        // new head when it fires.
        this.pump()
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.queue.push(waiter)
      this.pump()
    })
  }

  private pump(): void {
    if (this.active) return // a caller holds the gate
    if (this.cancelTimer) return // a grant is already scheduled
    // Defensive: drop any aborted heads (onAbort already splices, but a
    // settled waiter that lost its race could linger).
    while (this.queue.length > 0 && this.queue[0]!.settled) this.queue.shift()
    const head = this.queue[0]
    if (!head) return
    const minInterval = Math.max(0, this.getMinIntervalMs())
    const wait = Math.max(0, this.lastStartMs + minInterval - this.now())
    if (wait <= 0) {
      this.grant(head)
      return
    }
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      this.pump()
    }, wait)
  }

  private grant(head: Waiter): void {
    this.queue.shift()
    head.settled = true
    head.signal.removeEventListener('abort', head.onAbort)
    this.active = true
    this.lastStartMs = this.now()
    let released = false
    const release: GateRelease = () => {
      if (released) return
      released = true
      this.active = false
      this.pump()
    }
    head.resolve(release)
  }

  /** Shutdown hook (app-quit, via dispatcher.abortAllChatSessions) + test
   *  reset. Cancels the pending min-interval timer and rejects every QUEUED
   *  waiter so no cancelled send keeps holding a slot. Does NOT touch an
   *  already-granted (active) caller — its own AbortSignal + execa cancelSignal
   *  tear the subprocess down, and its `release()` runs in the generator's
   *  `finally`. */
  drain(): void {
    if (this.cancelTimer) {
      this.cancelTimer()
      this.cancelTimer = null
    }
    const pending = this.queue.splice(0, this.queue.length)
    for (const w of pending) {
      if (w.settled) continue
      w.settled = true
      w.signal.removeEventListener('abort', w.onAbort)
      w.reject(abortError())
    }
  }

  /** Test-only — full reset to construction state (drain queue + clear the
   *  mutex + reset the rate-limit clock so the next acquire grants instantly). */
  __reset(): void {
    this.drain()
    this.active = false
    this.lastStartMs = Number.NEGATIVE_INFINITY
  }

  /** Test-only introspection. */
  get __activeForTests(): boolean {
    return this.active
  }

  get __queueLengthForTests(): number {
    return this.queue.length
  }
}

/** Production singleton — the one gate every notion-agent subprocess passes
 *  through. Min-interval is read from the env on each pump via config. */
export const notionAgentGate = new NotionAgentSerialGate({
  getMinIntervalMs: getNotionAgentMinIntervalMs
})

/** App-quit cleanup entrypoint. See dispatcher.abortAllChatSessions. */
export function drainNotionAgentGate(): void {
  notionAgentGate.drain()
}
