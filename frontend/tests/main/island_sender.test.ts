// Sprint 9 D3 — `sendEnvelope` failure-bucket + happy-path tests.
//
// We don't open a real unix socket; we inject a `SocketFactory` returning a
// hand-rolled `SocketLike` so we control the connect/data/end/error event
// timing and the response bytes. This keeps the suite cross-platform (the
// CI containers don't have a /tmp/island.sock peer) and lets us assert the
// fail-open buckets fail-fast on the right errors.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  buildAppearanceChange,
  buildPing,
  sendEnvelope,
  __wire,
  type SocketFactory,
  type SocketLike
} from '../../src/electron/main/island'

type Listener = (...args: unknown[]) => void

interface FakeSocket {
  socket: SocketLike
  fire(event: 'connect' | 'data' | 'end' | 'close' | 'error', ...args: unknown[]): void
  writes: Buffer[]
  ended: boolean
  destroyed: boolean
}

function makeFakeSocket(): FakeSocket {
  const listeners: Record<string, Listener[]> = {}
  const writes: Buffer[] = []
  let ended = false
  let destroyed = false

  const socket = {
    on(event: string, listener: Listener): typeof socket {
      ;(listeners[event] ??= []).push(listener)
      return socket
    },
    write(chunk: Buffer, cb?: (err?: Error | null) => void): boolean {
      writes.push(chunk)
      // Async callback to mimic real `net.Socket.write` semantics; we use
      // queueMicrotask so the test stays synchronous-ish.
      if (cb) queueMicrotask(() => cb(null))
      return true
    },
    end(): void {
      ended = true
    },
    destroy(): void {
      destroyed = true
    }
  } as unknown as SocketLike

  const fire = (event: string, ...args: unknown[]): void => {
    for (const l of listeners[event] ?? []) l(...args)
  }
  return {
    socket,
    fire: fire as FakeSocket['fire'],
    writes,
    get ended() {
      return ended
    },
    get destroyed() {
      return destroyed
    }
  } as FakeSocket
}

function factoryReturning(fake: FakeSocket): SocketFactory {
  return () => fake.socket
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sendEnvelope: failure buckets', () => {
  test('ENOENT (socket file missing) → reason=enoent', async () => {
    const fake = makeFakeSocket()
    const promise = sendEnvelope(buildPing(), {
      factory: factoryReturning(fake)
    })
    const err = Object.assign(new Error('connect ENOENT /tmp/island.sock'), { code: 'ENOENT' })
    fake.fire('error', err)
    const out = await promise
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('enoent')
  })

  test('ECONNREFUSED → reason=refused', async () => {
    const fake = makeFakeSocket()
    const promise = sendEnvelope(buildPing(), { factory: factoryReturning(fake) })
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    fake.fire('error', err)
    const out = await promise
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('refused')
  })

  test('shared deadline elapses → reason=timeout', async () => {
    const fake = makeFakeSocket()
    const promise = sendEnvelope(buildPing(), {
      factory: factoryReturning(fake),
      timeoutMs: 50
    })
    // No events fire — let the setTimeout watchdog elapse.
    await vi.advanceTimersByTimeAsync(60)
    const out = await promise
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('timeout')
  })

  test('unknown socket error → reason=unknown', async () => {
    const fake = makeFakeSocket()
    const promise = sendEnvelope(buildPing(), { factory: factoryReturning(fake) })
    const err = Object.assign(new Error('EPIPE'), { code: 'EPIPE' })
    fake.fire('error', err)
    const out = await promise
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('unknown')
  })

  test('factory throw (createConnection-time) → reason=unknown (no hang)', async () => {
    const factory: SocketFactory = () => {
      throw new Error('unix sockets unavailable')
    }
    const out = await sendEnvelope(buildPing(), { factory })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('unknown')
  })
})

describe('sendEnvelope: protocol limits', () => {
  test('oversize envelope (> 64 KiB) → reason=protocol, no socket open', async () => {
    const factory = vi.fn<SocketFactory>(() => makeFakeSocket().socket)
    // Inject a giant metadata field by hand-rolling an envelope past the
    // builder's clip — we build a normal envelope and inflate metadata.
    const env = buildAppearanceChange({ accent: 'coral', theme: 'dark' })
    env.metadata['mailagent.bloat'] = 'x'.repeat(__wire.MAX_ENVELOPE_BYTES)

    const out = await sendEnvelope(env, { factory })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('protocol')
    expect(factory).not.toHaveBeenCalled()
  })

  test('response > 1 MiB → reason=protocol (socket destroyed mid-read)', async () => {
    const fake = makeFakeSocket()
    const promise = sendEnvelope(buildPing(), { factory: factoryReturning(fake) })
    fake.fire('connect')
    // Wait for the queueMicrotask write-callback chain to flush.
    await Promise.resolve()
    fake.fire('data', Buffer.alloc(__wire.MAX_RESPONSE_BYTES + 1, 'a'))
    const out = await promise
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('protocol')
  })

  test('response is malformed JSON → reason=protocol', async () => {
    const fake = makeFakeSocket()
    const promise = sendEnvelope(buildPing(), { factory: factoryReturning(fake) })
    fake.fire('connect')
    await Promise.resolve()
    fake.fire('data', Buffer.from('{not valid json', 'utf8'))
    fake.fire('end')
    const out = await promise
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('protocol')
  })
})

describe('sendEnvelope: happy paths', () => {
  test('connect → write → end → empty response → ok with null', async () => {
    const fake = makeFakeSocket()
    const promise = sendEnvelope(buildPing(), { factory: factoryReturning(fake) })
    fake.fire('connect')
    await Promise.resolve()
    fake.fire('end')
    const out = await promise
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.response).toBeNull()
    expect(fake.writes.length).toBe(1)
    expect(fake.ended).toBe(true)
  })

  test('JSON response is parsed and returned', async () => {
    const fake = makeFakeSocket()
    const promise = sendEnvelope(buildPing(), { factory: factoryReturning(fake) })
    fake.fire('connect')
    await Promise.resolve()
    fake.fire('data', Buffer.from(JSON.stringify({ acknowledged: true, version: '0.14' }), 'utf8'))
    fake.fire('end')
    const out = await promise
    expect(out.ok).toBe(true)
    if (out.ok) {
      const response = out.response as { acknowledged: boolean; version: string }
      expect(response.acknowledged).toBe(true)
      expect(response.version).toBe('0.14')
    }
  })

  test('socket close without prior end (one-shot peer) treated as null OK', async () => {
    const fake = makeFakeSocket()
    const promise = sendEnvelope(buildPing(), { factory: factoryReturning(fake) })
    fake.fire('connect')
    await Promise.resolve()
    fake.fire('close')
    const out = await promise
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.response).toBeNull()
  })

  test('write closes write-half via socket.end (POSIX shutdown SHUT_WR)', async () => {
    const fake = makeFakeSocket()
    const promise = sendEnvelope(buildPing(), { factory: factoryReturning(fake) })
    fake.fire('connect')
    await Promise.resolve()
    expect(fake.ended).toBe(true)
    fake.fire('end')
    await promise
  })

  test('multiple chunks concatenated before JSON.parse', async () => {
    const fake = makeFakeSocket()
    const promise = sendEnvelope(buildPing(), { factory: factoryReturning(fake) })
    fake.fire('connect')
    await Promise.resolve()
    fake.fire('data', Buffer.from('{"ok"', 'utf8'))
    fake.fire('data', Buffer.from(':true,"n":', 'utf8'))
    fake.fire('data', Buffer.from('42}', 'utf8'))
    fake.fire('end')
    const out = await promise
    expect(out.ok).toBe(true)
    if (out.ok) {
      const response = out.response as { ok: boolean; n: number }
      expect(response.ok).toBe(true)
      expect(response.n).toBe(42)
    }
  })
})
