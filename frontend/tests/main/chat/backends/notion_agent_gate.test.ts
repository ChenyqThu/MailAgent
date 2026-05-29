// NotionAgentSerialGate — the prevention-layer gate that stops concurrent
// `notion-agent chat` subprocesses (cross-session / popout windows) from
// tripping Notion's trust-rule strict mode (exit 75). Two guarantees:
//   - MUTEX: at most one holder at a time.
//   - RATE LIMIT: consecutive grant *starts* spaced ≥ minInterval apart,
//     measured from the previous start (so a long call overlaps the interval).
// Plus: abort-while-queued dequeues promptly without holding the gate, and
// drain() (app-quit) rejects every queued waiter + cancels the pending timer.
//
// Timing is fully deterministic via an injected clock + manual scheduler — no
// real timers, no flakiness. (The custom-api backend never touches this gate;
// it's wired only inside notion_agent.ts.)

import { describe, expect, test } from 'vitest'

import { NotionAgentSerialGate } from '../../../../src/electron/main/chat/backends/notion_agent_gate'

/** Manual clock + scheduler. `advance(ms)` moves the clock and fires every
 *  timer whose deadline has passed (in deadline order). pump() only ever
 *  schedules timers strictly in the future, so a single pass suffices. */
function makeEnv(minIntervalMs: number) {
  let nowMs = 1_000_000
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const now = (): number => nowMs
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const id = nextId++
    timers.set(id, { at: nowMs + ms, fn })
    return () => {
      timers.delete(id)
    }
  }
  const advance = (ms: number): void => {
    nowMs += ms
    const due = [...timers.entries()]
      .filter(([, t]) => t.at <= nowMs)
      .sort((a, b) => a[1].at - b[1].at)
    for (const [id, t] of due) {
      timers.delete(id)
      t.fn()
    }
  }
  const gate = new NotionAgentSerialGate({ getMinIntervalMs: () => minIntervalMs, now, schedule })
  return { gate, advance, pendingTimers: () => timers.size }
}

/** Resolve on next microtask so a just-resolved acquire() promise settles. */
const tick = (): Promise<void> => Promise.resolve()

describe('NotionAgentSerialGate — mutex', () => {
  test('first acquire is granted immediately', async () => {
    const { gate } = makeEnv(0)
    const ac = new AbortController()
    const release = await gate.acquire(ac.signal)
    expect(typeof release).toBe('function')
    expect(gate.__activeForTests).toBe(true)
  })

  test('second acquire waits until the first releases', async () => {
    const { gate } = makeEnv(0)
    const a = new AbortController()
    const b = new AbortController()

    const release1 = await gate.acquire(a.signal)

    let bGranted = false
    const p2 = gate.acquire(b.signal).then((r) => {
      bGranted = true
      return r
    })

    await tick()
    expect(bGranted).toBe(false) // mutex held by #1
    expect(gate.__queueLengthForTests).toBe(1)

    release1()
    await tick()
    expect(bGranted).toBe(true)
    const release2 = await p2
    expect(typeof release2).toBe('function')
  })

  test('FIFO order: waiters granted in arrival order', async () => {
    const { gate } = makeEnv(0)
    const order: string[] = []
    const r0 = await gate.acquire(new AbortController().signal)

    const labels = ['a', 'b', 'c']
    const releases: Array<() => void> = []
    const pending = labels.map((l) =>
      gate.acquire(new AbortController().signal).then((r) => {
        order.push(l)
        releases.push(r)
      })
    )

    r0()
    // Drain the chain: each grant needs the prior release + a microtask.
    for (let i = 0; i < labels.length; i++) {
      await tick()
      await tick()
      releases[i]?.()
    }
    await Promise.all(pending)
    expect(order).toEqual(['a', 'b', 'c'])
  })
})

describe('NotionAgentSerialGate — min interval (rate limit)', () => {
  test('next grant waits minInterval measured from the PREVIOUS start', async () => {
    const { gate, advance } = makeEnv(30_000)
    const r1 = await gate.acquire(new AbortController().signal)
    // Release almost immediately (a fast call). The next start must still be
    // spaced 30s from the FIRST start, not the release.
    r1()

    let granted = false
    void gate.acquire(new AbortController().signal).then(() => {
      granted = true
    })

    await tick()
    expect(granted).toBe(false) // within the 30s window

    advance(29_999)
    await tick()
    expect(granted).toBe(false)

    advance(1) // exactly at start+30s
    await tick()
    expect(granted).toBe(true)
  })

  test('a call longer than minInterval lets the next start immediately on release', async () => {
    const { gate, advance } = makeEnv(30_000)
    const r1 = await gate.acquire(new AbortController().signal)

    let granted = false
    void gate.acquire(new AbortController().signal).then(() => {
      granted = true
    })

    advance(45_000) // call ran 45s (> 30s interval) while holding the mutex
    r1()
    await tick()
    expect(granted).toBe(true) // interval already elapsed → no extra wait
  })

  test('minInterval=0 → back-to-back grants with no wait', async () => {
    const { gate } = makeEnv(0)
    const r1 = await gate.acquire(new AbortController().signal)
    r1()
    let granted = false
    void gate.acquire(new AbortController().signal).then(() => {
      granted = true
    })
    await tick()
    expect(granted).toBe(true)
  })
})

describe('NotionAgentSerialGate — abort handling', () => {
  test('already-aborted signal rejects immediately, never enters the queue', async () => {
    const { gate } = makeEnv(0)
    const ac = new AbortController()
    ac.abort()
    await expect(gate.acquire(ac.signal)).rejects.toThrow(/aborted/i)
    expect(gate.__queueLengthForTests).toBe(0)
  })

  test('abort while queued dequeues that waiter and does not block the next', async () => {
    const { gate } = makeEnv(0)
    const holder = await gate.acquire(new AbortController().signal)

    const abortable = new AbortController()
    const pAbort = gate.acquire(abortable.signal)
    pAbort.catch(() => {}) // swallow — asserted below

    const next = new AbortController()
    let nextGranted = false
    const pNext = gate.acquire(next.signal).then((r) => {
      nextGranted = true
      return r
    })

    await tick()
    expect(gate.__queueLengthForTests).toBe(2)

    // Cancel the FIRST queued waiter before it ever runs.
    abortable.abort()
    await expect(pAbort).rejects.toThrow(/aborted/i)
    expect(gate.__queueLengthForTests).toBe(1) // only `next` remains

    holder()
    await tick()
    expect(nextGranted).toBe(true) // not stranded by the aborted waiter
    await pNext
  })

  test('aborting the head while it waits on the interval timer promotes the next', async () => {
    const { gate, advance } = makeEnv(30_000)
    const r1 = await gate.acquire(new AbortController().signal)
    r1() // free the mutex; next grant is gated only by the 30s interval timer

    const head = new AbortController()
    const pHead = gate.acquire(head.signal)
    pHead.catch(() => {})

    const next = new AbortController()
    let nextGranted = false
    void gate.acquire(next.signal).then(() => {
      nextGranted = true
    })

    await tick()
    // Abort the head mid-wait; the next waiter should take over when the
    // shared interval timer fires (same absolute deadline).
    head.abort()
    await expect(pHead).rejects.toThrow(/aborted/i)

    advance(30_000)
    await tick()
    expect(nextGranted).toBe(true)
  })
})

describe('NotionAgentSerialGate — drain (app-quit / reset)', () => {
  test('drain rejects every queued waiter and cancels the pending timer', async () => {
    const { gate, advance, pendingTimers } = makeEnv(30_000)
    const r1 = await gate.acquire(new AbortController().signal)
    r1()

    const w1 = gate.acquire(new AbortController().signal)
    const w2 = gate.acquire(new AbortController().signal)
    w1.catch(() => {})
    w2.catch(() => {})
    await tick()
    // No active holder (r1 released); the head waits on the interval timer and
    // stays IN the queue until the timer fires, so both waiters are queued.
    expect(gate.__queueLengthForTests).toBe(2)
    expect(pendingTimers()).toBe(1)

    gate.drain()
    await expect(w1).rejects.toThrow(/aborted/i)
    await expect(w2).rejects.toThrow(/aborted/i)
    expect(gate.__queueLengthForTests).toBe(0)
    expect(pendingTimers()).toBe(0)

    // Timer firing after drain must be inert (no stray grant).
    advance(60_000)
    await tick()
    expect(gate.__activeForTests).toBe(false)
  })

  test('does not reject the active holder — only queued waiters', async () => {
    const { gate } = makeEnv(0)
    const holder = await gate.acquire(new AbortController().signal)
    const queued = gate.acquire(new AbortController().signal)
    queued.catch(() => {})
    await tick()

    gate.drain()
    await expect(queued).rejects.toThrow(/aborted/i)
    // Holder still owns the gate; its release works and frees it.
    expect(gate.__activeForTests).toBe(true)
    holder()
    expect(gate.__activeForTests).toBe(false)
  })

  test('__reset clears the rate-limit clock so the next acquire is instant', async () => {
    const { gate, advance } = makeEnv(30_000)
    const r1 = await gate.acquire(new AbortController().signal)
    r1()
    gate.__reset()

    // Without reset this would wait 30s; after reset lastStart is -∞.
    let granted = false
    void gate.acquire(new AbortController().signal).then(() => {
      granted = true
    })
    await tick()
    expect(granted).toBe(true)
    advance(0)
  })
})

describe('NotionAgentSerialGate — release idempotency', () => {
  test('calling release twice frees the gate once, does not double-grant', async () => {
    const { gate } = makeEnv(0)
    const r1 = await gate.acquire(new AbortController().signal)

    let grantCount = 0
    void gate.acquire(new AbortController().signal).then(() => {
      grantCount++
    })

    r1()
    r1() // second call is a no-op
    await tick()
    expect(grantCount).toBe(1)
  })
})
