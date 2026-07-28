// issue #69 — the outbound KOS queue.
//
// A self-hosted gbrain is one PGLite instance and answers serially, so a parallel
// fan-out of kos_query does not go faster — it queues downstream, where every call
// pays the wall-clock of the ones ahead of it AND burns its own request timeout doing
// so (measured in production: 3 concurrent calls = 10607 / 10609 / 10785 ms, all three
// past the 10s limit, entire agent run lost). Moving the queue up here is only a fix if
// waiting in it is genuinely free, so that is the property these tests pin hardest.

import { describe, expect, test, vi } from 'vitest'

import { createKosReadTools } from '../../../src/ai-gateway/tools/kos'
import {
  __resetSharedKosSerializerForTest,
  createKosSerializer,
  resolveKosMaxConcurrency,
  sharedKosSerializer,
  type KosSerializer
} from '../../../src/ai-gateway/tools/kos_concurrency'
import { MailAgentDomainClient } from '../../../src/ai-gateway/python/domainClient'
import { runTool } from './_helpers'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let queued microtasks drain so the serializer's internal handoffs settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('resolveKosMaxConcurrency', () => {
  test('defaults to 1 when unset or blank', () => {
    expect(resolveKosMaxConcurrency({})).toBe(1)
    expect(resolveKosMaxConcurrency({ KOS_TOOL_MAX_CONCURRENCY: '' })).toBe(1)
    expect(resolveKosMaxConcurrency({ KOS_TOOL_MAX_CONCURRENCY: '   ' })).toBe(1)
  })

  test('honours a valid escape-hatch value', () => {
    expect(resolveKosMaxConcurrency({ KOS_TOOL_MAX_CONCURRENCY: '3' })).toBe(3)
    expect(resolveKosMaxConcurrency({ KOS_TOOL_MAX_CONCURRENCY: '2.9' })).toBe(2)
  })

  test('a malformed value falls back to 1 rather than restoring the fan-out', () => {
    // The failure this guards is silent: "abc" or "0" reading as "unlimited" would put
    // the 3-way parallel timeout back with nothing in the logs to say why.
    for (const raw of ['abc', '0', '-1', 'NaN', 'Infinity ']) {
      expect(resolveKosMaxConcurrency({ KOS_TOOL_MAX_CONCURRENCY: raw })).toBe(1)
    }
  })
})

describe('sharedKosSerializer', () => {
  test('is memoized per process (one gbrain, one queue)', () => {
    __resetSharedKosSerializerForTest()
    const a = sharedKosSerializer()
    expect(sharedKosSerializer()).toBe(a)
    __resetSharedKosSerializerForTest()
    expect(sharedKosSerializer()).not.toBe(a)
  })

  test('defaults to a limit of 1', () => {
    __resetSharedKosSerializerForTest()
    expect(sharedKosSerializer().limit).toBe(1)
  })
})

describe('createKosSerializer — serialization', () => {
  test('runs one task at a time and in FIFO order', async () => {
    const s = createKosSerializer(1)
    const gates = [deferred(), deferred(), deferred()]
    const order: string[] = []
    let inFlight = 0
    let peak = 0

    const runs = gates.map((g, i) =>
      s.run(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        order.push(`start${i}`)
        await g.promise
        inFlight -= 1
        order.push(`end${i}`)
      })
    )

    await flush()
    expect(order).toEqual(['start0'])
    gates[0].resolve()
    await runs[0]
    await flush()
    expect(order).toEqual(['start0', 'end0', 'start1'])
    gates[1].resolve()
    await runs[1]
    await flush()
    gates[2].resolve()
    await Promise.all(runs)

    expect(peak).toBe(1)
    expect(order).toEqual(['start0', 'end0', 'start1', 'end1', 'start2', 'end2'])
  })

  test('a limit above 1 allows that many at once', async () => {
    const s = createKosSerializer(3)
    const gates = [deferred(), deferred(), deferred(), deferred()]
    let inFlight = 0
    let peak = 0
    const runs = gates.map((g) =>
      s.run(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await g.promise
        inFlight -= 1
      })
    )
    await flush()
    expect(peak).toBe(3) // the 4th is queued
    gates.forEach((g) => g.resolve())
    await Promise.all(runs)
    expect(peak).toBe(3)
  })

  test('a failing task still releases its slot', async () => {
    // Otherwise one E_KOS_NETWORK wedges every later KOS call in the process — a
    // strictly worse failure than the one being fixed.
    const s = createKosSerializer(1)
    await expect(
      s.run(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await expect(s.run(async () => 'ok')).resolves.toBe('ok')
  })
})

describe('createKosSerializer — waiting in the queue is free', () => {
  test('a queued task is not started, so its downstream timeout has not begun', async () => {
    // This is THE load-bearing property. The request timeout lives in
    // src/kos/client.py (httpx) and starts when serve-api issues the HTTP request —
    // which happens inside the task. A queued task has not run, so no fetch exists and
    // no clock is counting. Measured against an explicit clock: task 1 waits 100 units
    // in the queue, and still gets its full budget once it starts.
    const s = createKosSerializer(1)
    let clock = 0
    const startedAt: number[] = []
    const elapsed: number[] = []
    const gates = [deferred(), deferred()]

    const runs = gates.map((g, i) =>
      s.run(async () => {
        const began = clock
        startedAt.push(began)
        await g.promise
        elapsed.push(clock - began)
      })
    )

    await flush()
    expect(startedAt).toEqual([0]) // task 1 has NOT been invoked

    clock = 100 // 100 units pass while task 1 sits in the queue
    gates[0].resolve()
    await runs[0]
    await flush()

    expect(startedAt).toEqual([0, 100]) // its clock starts on dequeue, not on submit
    clock = 105
    gates[1].resolve()
    await Promise.all(runs)

    expect(elapsed[0]).toBe(100) // task 0 really did occupy 100 units
    expect(elapsed[1]).toBe(5) // task 1 spent 5 of its own, not 105
  })
})

describe('createKosSerializer — abort', () => {
  test('aborting while queued rejects without ever running the task', async () => {
    const s = createKosSerializer(1)
    const gate = deferred()
    const held = s.run(() => gate.promise)
    const ctrl = new AbortController()
    const task = vi.fn(async () => 'never')

    const queued = s.run(task, ctrl.signal)
    await flush()
    ctrl.abort()

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(task).not.toHaveBeenCalled()

    gate.resolve()
    await held
  })

  test('an already-aborted signal rejects immediately and consumes no slot', async () => {
    const s = createKosSerializer(1)
    const ctrl = new AbortController()
    ctrl.abort()
    const task = vi.fn(async () => 'never')
    await expect(s.run(task, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(task).not.toHaveBeenCalled()
    // The slot was never taken, so the next call runs without waiting for anything.
    await expect(s.run(async () => 'ok')).resolves.toBe('ok')
  })

  test('an aborted waiter does not block the ones behind it', async () => {
    const s = createKosSerializer(1)
    const gate = deferred()
    const held = s.run(() => gate.promise)
    const ctrl = new AbortController()
    const abandoned = s.run(async () => 'never', ctrl.signal)
    const after = s.run(async () => 'after')

    await flush()
    ctrl.abort()
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    gate.resolve()
    await held
    await expect(after).resolves.toBe('after')
  })
})

// ── the six tools actually go through the queue ───────────────────────────────────────

/** A domain client whose every request hangs until the test releases it, so "how many
 *  are in flight" is observable rather than a matter of timing luck. */
function deferredDomain(): {
  domain: MailAgentDomainClient
  inFlight: () => number
  peak: () => number
  releaseAll: () => void
} {
  let current = 0
  let peak = 0
  const gates: Array<Deferred<void>> = []
  const fetchImpl = (async () => {
    current += 1
    peak = Math.max(peak, current)
    const g = deferred()
    gates.push(g)
    await g.promise
    current -= 1
    return new Response(JSON.stringify({ status: 'success', data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as unknown as typeof fetch

  return {
    domain: new MailAgentDomainClient({
      baseUrl: 'http://127.0.0.1:8200/api',
      localToken: 't',
      fetchImpl
    }),
    inFlight: () => current,
    peak: () => peak,
    releaseAll: () => gates.forEach((g) => g.resolve())
  }
}

describe('createKosReadTools — every KOS tool is behind the queue', () => {
  test('three parallel kos_query calls reach gbrain one at a time', async () => {
    const d = deferredDomain()
    const tools = createKosReadTools(d.domain, [], { serializer: createKosSerializer(1) })
    const calls = [1, 2, 3].map(() =>
      runTool(tools.kos_query, { query: 'acme', limit: 5, expand: false })
    )

    await flush()
    expect(d.inFlight()).toBe(1) // the other two never left the gateway

    d.releaseAll()
    await flush()
    d.releaseAll()
    await flush()
    d.releaseAll()
    await Promise.all(calls)

    expect(d.peak()).toBe(1)
  })

  test.each([
    ['kos_query', { query: 'q', limit: 5, expand: false }],
    ['kos_search', { query: 'q', limit: 5 }],
    ['kos_get_page', { slug: 'people/lucien' }],
    ['kos_find_experts', { topic: 't', limit: 5 }],
    ['kos_list_pages', { limit: 5 }],
    ['kos_get_backlinks', { slug: 'people/lucien', limit: 5 }]
  ])('%s routes through the serializer', async (toolName, input) => {
    // A tool added later that calls domain.kosCall directly would be invisible to the
    // concurrency test above (it only exercises kos_query), so each one is pinned.
    const seen: string[] = []
    const spy: KosSerializer = {
      limit: 1,
      run: async (task) => {
        seen.push('run')
        return task()
      }
    }
    const d = deferredDomain()
    d.releaseAll() // not testing timing here — just that the queue is on the path
    const tools = createKosReadTools(d.domain, [], { serializer: spy })
    const call = runTool(tools[toolName as keyof typeof tools], input)
    await flush()
    d.releaseAll()
    await call
    expect(seen).toEqual(['run'])
  })
})
