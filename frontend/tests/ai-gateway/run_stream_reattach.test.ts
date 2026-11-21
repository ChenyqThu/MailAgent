import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig, PersistTurnInput } from '../../src/ai-gateway/config'
import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'

const handles: AiGatewayHandle[] = []
async function start(cfg: Parameters<typeof startAiGatewayServer>[0]): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

function slowTextModel(parts: string[], chunkDelayInMs: number): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs,
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: '1' },
          ...parts.map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
          { type: 'text-end' as const, id: '1' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: parts.length, text: parts.length, reasoning: 0 }
            }
          }
        ]
      })
    })
  })
}

function baseCfg(opts: {
  model: MockLanguageModelV3
  persisted: PersistTurnInput[]
  detached?: boolean
  registry?: ActiveRunRegistry
}): AiGatewayConfig {
  const detached = opts.detached ?? true
  return {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => opts.model,
    persistTurn: (t) => {
      opts.persisted.push(t)
    },
    ...(detached ? { detachedRunsEnabled: true } : {}),
    activeRuns: opts.registry ?? new ActiveRunRegistry()
  }
}

function postChat(port: number, sessionId: number, signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] }]
    }),
    ...(signal ? { signal } : {})
  })
}

function getRunStream(
  port: number,
  sessionId: number | string,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/run/stream?sessionId=${sessionId}`, {
    ...(signal ? { signal } : {})
  })
}

async function readSomeFramesThenAbort(
  res: Response,
  ac: AbortController,
  minTextDeltas: number
): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
  let deltas = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.replace(/^data: /, '').trim()
        if (!line || line === '[DONE]') continue
        try {
          const parsed = JSON.parse(line) as { type?: string; delta?: string }
          if (parsed.type === 'text-delta' && typeof parsed.delta === 'string') {
            text += parsed.delta
            deltas += 1
          }
        } catch {
          /* ignore non-JSON */
        }
      }
      if (deltas >= minTextDeltas) {
        ac.abort()
        return text
      }
    }
  } catch {
    /* abort expected */
  }
  return text
}

async function drainSse(res: Response): Promise<{ text: string; sawDone: boolean; frames: string[] }> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
  let sawDone = false
  const frames: string[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.replace(/^data: /, '').trim()
      if (!line) continue
      frames.push(line)
      if (line === '[DONE]') {
        sawDone = true
        continue
      }
      try {
        const parsed = JSON.parse(line) as { type?: string; delta?: string }
        if (parsed.type === 'text-delta' && typeof parsed.delta === 'string') {
          text += parsed.delta
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  }
  return { text, sawDone, frames }
}

describe('GET /api/ai/run/stream live replay & reattach', () => {
  test('replays buffered SSE prefix and streams remaining live chunks + [DONE] after client disconnect', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start(
      baseCfg({
        model: slowTextModel(['一', '二', '三', '四', '五'], 45),
        persisted
      })
    )

    const ac = new AbortController()
    const chatRes = await postChat(h.port, 101, ac.signal)
    expect(chatRes.status).toBe(200)
    const runId = chatRes.headers.get('x-mailagent-run-id')
    expect(runId).toBeTruthy()

    const initialPrefix = await readSomeFramesThenAbort(chatRes, ac, 2)
    expect(initialPrefix).toBe('一二')

    const reattachRes = await getRunStream(h.port, 101)
    expect(reattachRes.status).toBe(200)
    expect(reattachRes.headers.get('content-type')).toBe('text/event-stream')
    expect(reattachRes.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    expect(reattachRes.headers.get('x-mailagent-run-id')).toBe(runId)
    expect(reattachRes.headers.get('access-control-expose-headers')).toContain('x-mailagent-run-id')

    const replayed = await drainSse(reattachRes)
    expect(replayed.text).toBe('一二三四五')
    expect(replayed.sawDone).toBe(true)

    await vi.waitFor(() => expect(persisted).toHaveLength(1), { timeout: 3000 })
    const afterRes = await getRunStream(h.port, 101)
    expect(afterRes.status).toBe(204)
  })

  test('disconnecting a reattached subscriber never aborts upstream; second subscriber still receives full replay + tail', async () => {
    const persisted: PersistTurnInput[] = []
    let releaseTail!: () => void
    const tailGate = new Promise<void>((resolve) => {
      releaseTail = resolve
    })
    type StreamChunk =
      Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer T>
        ? T
        : never
    const gatedModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream<StreamChunk>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            controller.enqueue({ type: 'text-start', id: '1' })
            // CJK characters flush immediately past the gateway's word-based smoothStream.
            controller.enqueue({ type: 'text-delta', id: '1', delta: '一' })
            controller.enqueue({ type: 'text-delta', id: '1', delta: '二' })
            controller.enqueue({ type: 'text-delta', id: '1', delta: '三' })
            void tailGate.then(() => {
              controller.enqueue({ type: 'text-delta', id: '1', delta: '四' })
              controller.enqueue({ type: 'text-delta', id: '1', delta: '五' })
              controller.enqueue({ type: 'text-delta', id: '1', delta: '六' })
              controller.enqueue({ type: 'text-end', id: '1' })
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 6, text: 6, reasoning: 0 }
                }
              })
              controller.close()
            })
          }
        })
      })
    })
    const h = await start(
      baseCfg({
        model: gatedModel,
        persisted
      })
    )

    const ac1 = new AbortController()
    const res1 = await postChat(h.port, 102, ac1.signal)
    expect(res1.status).toBe(200)
    await readSomeFramesThenAbort(res1, ac1, 1)

    const ac2 = new AbortController()
    const sub1 = await getRunStream(h.port, 102, ac2.signal)
    expect(sub1.status).toBe(200)
    const sub1Prefix = await readSomeFramesThenAbort(sub1, ac2, 2)
    expect(sub1Prefix.length).toBeGreaterThanOrEqual(2)
    expect('一二三'.startsWith(sub1Prefix)).toBe(true)

    const sub2 = await getRunStream(h.port, 102)
    expect(sub2.status).toBe(200)
    releaseTail()
    const sub2Result = await drainSse(sub2)
    expect(sub2Result.text).toBe('一二三四五六')
    expect(sub2Result.sawDone).toBe(true)

    await vi.waitFor(() => expect(persisted).toHaveLength(1), { timeout: 3000 })
  })

  test('returns 204 for idle/non-streamable/overflowed sessions and 400 on invalid sessionId', async () => {
    const persisted: PersistTurnInput[] = []
    const registry = new ActiveRunRegistry({ maxBufferedBytes: 64 })
    const h = await start(
      baseCfg({
        model: slowTextModel(['1234567890', '1234567890', '1234567890', '1234567890'], 35),
        persisted,
        registry
      })
    )

    // Invalid sessionId
    const badRes = await getRunStream(h.port, 'not-an-int')
    expect(badRes.status).toBe(400)

    // Idle session
    const idleRes = await getRunStream(h.port, 999)
    expect(idleRes.status).toBe(204)

    // Non-streamable active run (approval resume / group scheduler)
    const nonStreamAc = new AbortController()
    registry.register(202, nonStreamAc) // streamable defaults to false
    const nonStreamRes = await getRunStream(h.port, 202)
    expect(nonStreamRes.status).toBe(204)
    registry.stop(202)

    // Buffer overflow degrades cleanly to 204 without aborting the upstream run
    const ac = new AbortController()
    const chatRes = await postChat(h.port, 103, ac.signal)
    await readSomeFramesThenAbort(chatRes, ac, 2)

    await vi.waitFor(async () => {
      const probe = await getRunStream(h.port, 103)
      expect(probe.status).toBe(204)
    })
    await vi.waitFor(() => expect(persisted).toHaveLength(1), { timeout: 3000 })
  })

  test('POST /api/ai/run/stop closes live stream subscribers without [DONE]', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start(
      baseCfg({
        model: slowTextModel(['x', 'y', 'z', 'w'], 120),
        persisted
      })
    )

    const ac = new AbortController()
    const chatRes = await postChat(h.port, 104, ac.signal)
    await readSomeFramesThenAbort(chatRes, ac, 1)

    const sub = await getRunStream(h.port, 104)
    expect(sub.status).toBe(200)

    const drainPromise = drainSse(sub)
    await new Promise((r) => setTimeout(r, 30))

    const stopRes = await fetch(`http://127.0.0.1:${h.port}/api/ai/run/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 104 })
    })
    expect(stopRes.status).toBe(200)

    const drained = await drainPromise
    expect(drained.sawDone).toBe(false)
    expect(persisted).toHaveLength(0)
  })
})
