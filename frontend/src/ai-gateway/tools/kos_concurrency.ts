// issue #69 — serialize the gateway's outbound KOS calls.
//
// The problem is downstream, not here: a self-hosted gbrain runs on a single PGLite
// instance and processes queries serially. When the model opens three `kos_query`
// calls in one step (which it does — an agent chasing three topics is the normal
// shape), they do not run three times faster; they queue inside gbrain and each one
// pays the FULL wall-clock of the ones ahead of it. Reported production numbers on a
// 20,423-page brain: 1 call ≈ 9.1s average, 3 concurrent calls = 10607 / 10609 /
// 10785 ms — all three past the client timeout, whole run wasted, and the agent's
// daily run quota consumed by a run that produced nothing.
//
// So the fan-out buys nothing and costs everything. We queue the calls here instead,
// where waiting is free, rather than inside gbrain, where waiting burns the timeout.
//
// 🔴 Why the queue wait does not eat the request timeout: the timeout lives in
// src/kos/client.py (httpx `timeout=`), which starts when serve-api issues the HTTP
// request to gbrain. A queued call has not yet been handed to `domain.kosCall`, so no
// fetch, no serve-api request, no httpx clock. The gateway's fetch (domainClient._req)
// sets no timeout of its own — only the caller's abort signal — so nothing else is
// counting down either. Waiting costs latency, not failures.
//
// Prompting cannot fix this (the issue reporter tried): whether a model obeys "never
// call kos_query in parallel" is luck. A queue is not luck.
//
// Scope is the process, not the request: the constraint being modelled is one gbrain
// instance, and the embedded gateway is one process per app. Two chat turns racing
// each other hit exactly the same wall as one turn fanning out — and a headless
// custom-agent run shares the process with interactive chat, so it shares the queue.
//
// Accepted trade-off: a slot is held for as long as its call takes, and the gateway
// deliberately sets no timeout of its own (that would be a second clock competing with
// KOS_TIMEOUT_SECONDS). So a call that never settles would hold the queue. It is bounded
// in practice — serve-api answers within its own httpx timeout, and an aborted run
// releases the slot through the `finally` below — and the only way to hang past that is
// a wholly deadlocked serve-api, at which point KOS queueing is not the visible symptom.

/** Escape hatch. Raise it if your KOS deployment is genuinely concurrent (Postgres
 *  rather than PGLite); a large value effectively disables the queue. main-env only —
 *  read in the Electron main process, no vite define, no Settings UI. */
export const KOS_MAX_CONCURRENCY_ENV = 'KOS_TOOL_MAX_CONCURRENCY'

const DEFAULT_MAX_CONCURRENCY = 1

/** Parse `KOS_TOOL_MAX_CONCURRENCY`. Unset / blank / non-numeric / < 1 → 1: a
 *  malformed value must not silently restore the broken fan-out this exists to stop. */
export function resolveKosMaxConcurrency(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[KOS_MAX_CONCURRENCY_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONCURRENCY
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENCY
  return Math.floor(parsed)
}

export interface KosSerializer {
  /** Run `task` once a slot is free. Rejects with the abort reason — without running
   *  `task` — if `signal` fires while queued. */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>
  /** Slots. Exposed for tests and diagnostics. */
  readonly limit: number
}

interface Waiter {
  grant: () => void
  cancel: (reason: unknown) => void
}

function abortReason(signal: AbortSignal): unknown {
  // `signal.reason` is what fetch itself would have thrown, so the caller sees the
  // same error whether the abort landed in the queue or mid-flight. The fallback
  // keeps `name === 'AbortError'`, which is what auditedReadTool's isAbortError and
  // domainClient._req both key off.
  if (signal.reason !== undefined) return signal.reason
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

/** FIFO semaphore. Separate from the shared instance so tests can drive one directly. */
export function createKosSerializer(limit: number): KosSerializer {
  const slots = Math.max(1, Math.floor(limit))
  let active = 0
  const waiting: Waiter[] = []

  function release(): void {
    active -= 1
    const next = waiting.shift()
    if (next) {
      active += 1
      next.grant()
    }
  }

  function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    if (active < slots) {
      active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const entry: Waiter = {
        grant: () => {
          cleanup()
          resolve()
        },
        cancel: (reason: unknown) => {
          cleanup()
          reject(reason)
        }
      }
      const onAbort = (): void => {
        // Drop out of the queue rather than waking up later to a slot nobody wants —
        // leaving the entry in would hold the next caller behind a dead one.
        const at = waiting.indexOf(entry)
        if (at >= 0) waiting.splice(at, 1)
        entry.cancel(abortReason(signal as AbortSignal))
      }
      function cleanup(): void {
        signal?.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiting.push(entry)
    })
  }

  return {
    limit: slots,
    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquire(signal)
      try {
        return await task()
      } finally {
        release()
      }
    }
  }
}

let shared: KosSerializer | null = null

/** The process-wide serializer every KOS tool goes through. Built on first use so the
 *  env read happens after the main process has loaded its .env. */
export function sharedKosSerializer(): KosSerializer {
  if (!shared) shared = createKosSerializer(resolveKosMaxConcurrency())
  return shared
}

/** Test-only: drop the memoized instance so a test can re-resolve it from a patched env. */
export function __resetSharedKosSerializerForTest(): void {
  shared = null
}
