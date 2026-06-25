// chat-panel P4 Phase 06a (cutover) — eager ai-sdk session creation latch (resolveAiSdkSessionId).
//
// The AI SDK transport's `body` is a function resolved per send; it calls resolveAiSdkSessionId to
// get the session id to persist into. A brand-new conversation starts with sessionId=null and must
// create the ai-sdk session lazily on the FIRST send (onEnsureSession), at-most-once, injecting the
// new id so the gateway persists from turn 1. These pin the latch's once-semantics + failure
// recovery without standing up React / the transport.

import { describe, expect, test, vi } from 'vitest'

import {
  resolveAiSdkSessionId,
  type AiSdkSessionLatch
} from '../../../src/shared/assistant/runtime/useMailAgentAiSdkRuntime'

function freshLatch(seed: number | null = null): AiSdkSessionLatch {
  return { id: seed, inflight: null }
}

describe('resolveAiSdkSessionId — reload / already-known id', () => {
  test('a non-null sessionId prop short-circuits — onEnsureSession is NOT called', async () => {
    const onEnsureSession = vi.fn(async () => 777)
    const latch = freshLatch(null)
    await expect(resolveAiSdkSessionId(latch, 42, onEnsureSession)).resolves.toBe(42)
    expect(onEnsureSession).not.toHaveBeenCalled()
    expect(latch.id).toBeNull() // the prop wins; the latch is untouched
  })

  test('an already-latched id short-circuits — no second create', async () => {
    const onEnsureSession = vi.fn(async () => 777)
    const latch = freshLatch(99)
    await expect(resolveAiSdkSessionId(latch, null, onEnsureSession)).resolves.toBe(99)
    expect(onEnsureSession).not.toHaveBeenCalled()
  })

  test('no onEnsureSession + null prop → null (Phase 02 behaviour, gateway skips persist)', async () => {
    const latch = freshLatch(null)
    await expect(resolveAiSdkSessionId(latch, null, undefined)).resolves.toBeNull()
    await expect(resolveAiSdkSessionId(latch, undefined, undefined)).resolves.toBeNull()
  })
})

describe('resolveAiSdkSessionId — lazy create on first send', () => {
  test('first send creates once, caches the id; second send reuses it', async () => {
    const onEnsureSession = vi.fn(async () => 555)
    const latch = freshLatch(null)

    await expect(resolveAiSdkSessionId(latch, null, onEnsureSession)).resolves.toBe(555)
    expect(onEnsureSession).toHaveBeenCalledTimes(1)
    expect(latch.id).toBe(555)
    expect(latch.inflight).toBeNull()

    await expect(resolveAiSdkSessionId(latch, null, onEnsureSession)).resolves.toBe(555)
    expect(onEnsureSession).toHaveBeenCalledTimes(1) // still once — reused from the latch
  })

  test('concurrent first sends share a single in-flight create (no double session)', async () => {
    let resolveCreate: ((id: number) => void) | null = null
    const onEnsureSession = vi.fn(
      () =>
        new Promise<number>((res) => {
          resolveCreate = res
        })
    )
    const latch = freshLatch(null)

    const a = resolveAiSdkSessionId(latch, null, onEnsureSession)
    const b = resolveAiSdkSessionId(latch, null, onEnsureSession)
    expect(onEnsureSession).toHaveBeenCalledTimes(1) // deduped synchronously before the await
    resolveCreate!(321)
    await expect(a).resolves.toBe(321)
    await expect(b).resolves.toBe(321)
    expect(latch.id).toBe(321)
  })

  test('create failure clears inflight + leaves id null → a retry re-attempts (no empty session)', async () => {
    const onEnsureSession = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('newSession failed'))
      .mockResolvedValueOnce(888)
    const latch = freshLatch(null)

    await expect(resolveAiSdkSessionId(latch, null, onEnsureSession)).rejects.toThrow(
      'newSession failed'
    )
    expect(latch.inflight).toBeNull() // cleared so a retry isn't wedged on the rejected promise
    expect(latch.id).toBeNull() // no id cached → no phantom session

    await expect(resolveAiSdkSessionId(latch, null, onEnsureSession)).resolves.toBe(888)
    expect(onEnsureSession).toHaveBeenCalledTimes(2) // retried
    expect(latch.id).toBe(888)
  })
})
