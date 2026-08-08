import { afterEach, describe, expect, test, vi } from 'vitest'

import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import type {
  AiGatewayConfig,
  GatewayQueuedInput,
  QueuedInputStore
} from '../../src/ai-gateway/config'
import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'

const handles: AiGatewayHandle[] = []

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.close()
})

function makeStore(): QueuedInputStore & { items: GatewayQueuedInput[]; restoreForSession: ReturnType<typeof vi.fn> } {
  let nextId = 1
  const items: GatewayQueuedInput[] = []
  const get = (id: number): GatewayQueuedInput | null => items.find((item) => item.id === id) ?? null
  return {
    items,
    list: (sessionId) =>
      items.filter(
        (item) =>
          item.sessionId === sessionId &&
          (item.status === 'queued' || item.status === 'claimed' || item.status === 'restored')
      ),
    enqueue: (sessionId, content) => {
      const normalized = content.trim()
      if (!normalized || normalized.length > 16_384) throw new Error('E_INVALID_ARG')
      if (
        items.filter(
          (item) =>
            item.sessionId === sessionId && (item.status === 'queued' || item.status === 'claimed')
        ).length >= 20
      ) {
        throw new Error('E_QUEUE_FULL')
      }
      const item: GatewayQueuedInput = {
        id: nextId++,
        sessionId,
        runId: null,
        mode: 'follow_up',
        content: normalized,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deliveredMessageId: null
      }
      items.push(item)
      return item
    },
    get,
    update: (id, content) => {
      const item = get(id)
      if (!item || (item.status !== 'queued' && item.status !== 'restored') || !content.trim()) {
        return false
      }
      item.content = content.trim()
      return true
    },
    cancel: (id) => {
      const item = get(id)
      if (!item || (item.status !== 'queued' && item.status !== 'restored')) return false
      item.status = 'canceled'
      return true
    },
    confirm: (id) => {
      const item = get(id)
      if (!item || item.status !== 'restored') return false
      item.status = 'queued'
      return true
    },
    restoreForSession: vi.fn((sessionId: number) => {
      let changed = 0
      for (const item of items) {
        if (item.sessionId === sessionId && (item.status === 'queued' || item.status === 'claimed')) {
          item.status = 'restored'
          changed += 1
        }
      }
      return changed
    })
  }
}

async function start(overrides: Partial<AiGatewayConfig> = {}): Promise<string> {
  const handle = await startAiGatewayServer({
    port: 0,
    baseUrl: 'http://example.invalid',
    apiKey: 'test',
    model: 'm',
    ...overrides
  })
  handles.push(handle)
  return `http://127.0.0.1:${handle.port}`
}

const post = (base: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

describe('queued input endpoints', () => {
  test('flag off returns 404 E_NOT_IMPLEMENTED for all five endpoints', async () => {
    const base = await start()
    const responses = [
      await fetch(`${base}/api/ai/queued-input?sessionId=1`),
      await post(base, '/api/ai/queued-input', { sessionId: 1, content: 'x' }),
      await post(base, '/api/ai/queued-input/update', { id: 1, content: 'x' }),
      await post(base, '/api/ai/queued-input/cancel', { id: 1 }),
      await post(base, '/api/ai/queued-input/send', { id: 1 })
    ]
    for (const response of responses) {
      expect(response.status).toBe(404)
      expect((await response.json()).error).toBe('E_NOT_IMPLEMENTED')
    }
  })

  test('enqueue validation and cap errors are mapped to 400', async () => {
    const store = makeStore()
    const base = await start({ queuedInputStore: store })
    expect((await post(base, '/api/ai/queued-input', { content: 'x' })).status).toBe(400)
    expect((await post(base, '/api/ai/queued-input', { sessionId: 1, content: '   ' })).status).toBe(400)
    expect(
      (await post(base, '/api/ai/queued-input', { sessionId: 1, content: 'x'.repeat(16_385) })).status
    ).toBe(400)
    for (let index = 0; index < 20; index += 1) store.enqueue(1, `row-${index}`)
    const response = await post(base, '/api/ai/queued-input', { sessionId: 1, content: 'overflow' })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('E_QUEUE_FULL')
  })

  test('enqueue dispatches immediately only when no run is active', async () => {
    const idleDispatch = vi.fn()
    const idleBase = await start({
      queuedInputStore: makeStore(),
      dispatchQueuedInputIfIdle: idleDispatch
    })
    expect((await post(idleBase, '/api/ai/queued-input', { sessionId: 1, content: 'idle' })).status).toBe(
      200
    )
    expect(idleDispatch).toHaveBeenCalledWith(1)

    const activeRuns = new ActiveRunRegistry()
    activeRuns.register(2, new AbortController())
    const activeDispatch = vi.fn()
    const activeBase = await start({
      activeRuns,
      queuedInputStore: makeStore(),
      dispatchQueuedInputIfIdle: activeDispatch
    })
    expect(
      (await post(activeBase, '/api/ai/queued-input', { sessionId: 2, content: 'active' })).status
    ).toBe(200)
    expect(activeDispatch).not.toHaveBeenCalled()
  })

  test('GET validates query and returns session items', async () => {
    const store = makeStore()
    store.enqueue(3, 'hello')
    const base = await start({ queuedInputStore: store })
    expect((await fetch(`${base}/api/ai/queued-input`)).status).toBe(400)
    expect((await fetch(`${base}/api/ai/queued-input?sessionId=nope`)).status).toBe(400)
    const response = await fetch(`${base}/api/ai/queued-input?sessionId=3`)
    expect(response.status).toBe(200)
    expect((await response.json()).items).toHaveLength(1)
  })

  test('update/cancel/send enforce state CAS and restored send schedules dispatch', async () => {
    const store = makeStore()
    const dispatch = vi.fn()
    const base = await start({ queuedInputStore: store, dispatchQueuedInputIfIdle: dispatch })
    expect((await post(base, '/api/ai/queued-input/update', { id: 999, content: 'x' })).status).toBe(409)
    expect((await post(base, '/api/ai/queued-input/cancel', { id: 999 })).status).toBe(409)
    expect((await post(base, '/api/ai/queued-input/send', { id: 999 })).status).toBe(409)

    const sent = store.enqueue(1, 'sent')
    sent.status = 'sent'
    expect((await post(base, '/api/ai/queued-input/update', { id: sent.id, content: 'x' })).status).toBe(
      409
    )

    const restored = store.enqueue(1, 'restored')
    restored.status = 'restored'
    expect((await post(base, '/api/ai/queued-input/send', { id: restored.id })).status).toBe(200)
    expect(restored.status).toBe('queued')
    expect(dispatch).toHaveBeenCalledWith(1)
  })

  test('run stop restores queued and claimed rows and broadcasts even when nothing stopped', async () => {
    const store = makeStore()
    store.enqueue(4, 'queued')
    const claimed = store.enqueue(4, 'claimed')
    claimed.status = 'claimed'
    const changed = vi.fn()
    const base = await start({
      activeRuns: new ActiveRunRegistry(),
      queuedInputStore: store,
      onQueuedInputChanged: changed
    })

    const response = await post(base, '/api/ai/run/stop', { sessionId: 4 })

    expect(response.status).toBe(200)
    expect(store.restoreForSession).toHaveBeenCalledWith(4)
    expect(store.items.map((item) => item.status)).toEqual(['restored', 'restored'])
    expect(changed).toHaveBeenCalledWith(4)
  })
})
