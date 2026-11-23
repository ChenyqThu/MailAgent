import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { DomainError } from '../../src/ai-gateway/python/domainClient'
import {
  buildTurnPersistenceHooks,
  captureTurnMemoryWithRetry,
  isRetryableMemoryCaptureError,
  MEMORY_CAPTURE_RETRY_DELAYS_MS
} from '../../src/electron/main/ai_gateway/persistenceGlue'
import type { PersistTurnInput } from '../../src/ai-gateway/config'

const samplePayload = { userText: 'hello', assistantText: 'world', sessionId: 42 }

describe('captureTurnMemoryWithRetry', () => {
  test('uses [3000, 10000] default retry backoff schedule', () => {
    expect(MEMORY_CAPTURE_RETRY_DELAYS_MS).toEqual([3_000, 10_000])
  })

  test('succeeds on first attempt without delay', async () => {
    const captureMemory = vi.fn(async () => ({ captured: [], count: 1 }))
    const delayFn = vi.fn(async () => {})

    await captureTurnMemoryWithRetry({ captureMemory }, samplePayload, { delayFn })

    expect(captureMemory).toHaveBeenCalledTimes(1)
    expect(captureMemory).toHaveBeenCalledWith(samplePayload, expect.any(AbortSignal))
    expect(delayFn).not.toHaveBeenCalled()
  })

  test('retries transient 5xx and E_NETWORK failures then succeeds', async () => {
    const captureMemory = vi
      .fn()
      .mockRejectedValueOnce(new DomainError('E_UPSTREAM', '502 bad gateway', { httpStatus: 502 }))
      .mockRejectedValueOnce(new DomainError('E_NETWORK', 'connection reset'))
      .mockResolvedValueOnce({ captured: [], count: 2 })
    const delays: number[] = []

    await captureTurnMemoryWithRetry({ captureMemory }, samplePayload, {
      delayFn: async (ms) => {
        delays.push(ms)
      }
    })

    expect(captureMemory).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([3_000, 10_000])
  })

  test('stops after max 2 retries (3 total attempts) and rethrows final error', async () => {
    const finalErr = new DomainError('E_UPSTREAM', '503 unavailable', { httpStatus: 503 })
    const captureMemory = vi.fn().mockRejectedValue(finalErr)
    const delays: number[] = []

    await expect(
      captureTurnMemoryWithRetry({ captureMemory }, samplePayload, {
        delayFn: async (ms) => {
          delays.push(ms)
        }
      })
    ).rejects.toBe(finalErr)

    expect(captureMemory).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([3_000, 10_000])
  })

  test('does NOT retry 4xx DomainError', async () => {
    const clientErr = new DomainError('E_INVALID_ARG', 'bad request', { httpStatus: 400 })
    const captureMemory = vi.fn().mockRejectedValue(clientErr)
    const delayFn = vi.fn(async () => {})

    await expect(
      captureTurnMemoryWithRetry({ captureMemory }, samplePayload, { delayFn })
    ).rejects.toBe(clientErr)

    expect(captureMemory).toHaveBeenCalledTimes(1)
    expect(delayFn).not.toHaveBeenCalled()
  })

  test('does NOT retry AbortError or TimeoutError', async () => {
    const abortErr = Object.assign(new Error('Aborted'), { name: 'AbortError' })
    const timeoutErr = Object.assign(new Error('Timed out'), { name: 'TimeoutError' })
    const delayFn = vi.fn(async () => {})

    for (const err of [abortErr, timeoutErr]) {
      const captureMemory = vi.fn().mockRejectedValue(err)
      await expect(
        captureTurnMemoryWithRetry({ captureMemory }, samplePayload, { delayFn })
      ).rejects.toBe(err)
      expect(captureMemory).toHaveBeenCalledTimes(1)
      expect(isRetryableMemoryCaptureError(err)).toBe(false)
    }
    expect(delayFn).not.toHaveBeenCalled()
  })

  test('buildTurnPersistenceHooks captureTurnMemory stays fire-and-forget and swallows 4xx', async () => {
    const captureMemory = vi
      .fn()
      .mockRejectedValue(new DomainError('E_INVALID_ARG', 'rejected', { httpStatus: 422 }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const hooks = buildTurnPersistenceHooks({
        domain: { captureMemory } as unknown as Parameters<typeof buildTurnPersistenceHooks>[0]['domain'],
        captureTurnMemoryEnabled: true,
        serverResumeEnabled: false,
        customAgentsEnabled: false,
        imFeishuEnabled: false
      })
      const turn: PersistTurnInput = {
        sessionId: 99,
        model: 'gpt-4o-mini',
        userMessage: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        responseMessage: { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] }
      }
      const ret = hooks.captureTurnMemory?.(turn)
      expect(ret).toBeUndefined()
      await vi.waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1))
      expect(captureMemory).toHaveBeenCalledTimes(1)
    } finally {
      errSpy.mockRestore()
    }
  })
})
