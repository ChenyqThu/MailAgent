// chat-panel P4 Phase 02 — AI Gateway /api/ai/chat streaming + abort + typed errors.
//
// Pure-Node: a MockLanguageModelV3 is injected via cfg.createModel so the gateway
// runs streamText → pipeUIMessageStreamToResponse WITHOUT a real provider call. We
// read the AI SDK UIMessage SSE back and reconstruct the text from text-delta
// chunks (the same shape useChatRuntime consumes). persistTurn is a spy so we also
// assert the onFinish dual-write payload.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { PersistTurnInput } from '../../src/ai-gateway/config'

const handles: AiGatewayHandle[] = []
async function start(cfg: Parameters<typeof startAiGatewayServer>[0]): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

/** A v3 language model that streams `parts` as text-delta chunks then finishes. */
function mockTextModel(parts: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          ...parts.map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
          { type: 'text-end', id: '1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 7, text: 7, reasoning: 0 }
            }
          }
        ]
      })
    })
  })
}

/** Read an SSE response into an array of parsed `data:` frames. */
async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const frames: Array<Record<string, unknown>> = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
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
        frames.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        /* skip non-json keepalive frames */
      }
    }
  }
  return frames
}

const CHAT_CFG = {
  port: 0,
  baseUrl: 'https://crs.example/api',
  apiKey: 'sk-test-key',
  model: 'claude-sonnet-4-6'
} as const

function userTurn(text: string): unknown {
  return [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }]
}

describe('ai-gateway — /api/ai/chat streaming', () => {
  test('streams a UIMessage text stream; reconstructs the model text', async () => {
    const h = await start({
      ...CHAT_CFG,
      createModel: () => mockTextModel(['Hello', ', ', 'world'])
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ messages: userTurn('hi') })
    })
    expect(res.status).toBe(200)
    const frames = await readSse(res)
    const text = frames
      .filter((f) => f.type === 'text-delta')
      .map((f) => String(f.delta))
      .join('')
    expect(text).toBe('Hello, world')
    // No error chunk in the stream.
    expect(frames.find((f) => f.type === 'error')).toBeUndefined()
  })

  test('onFinish hands the persist writer the assistant + user turn (dual-write inputs)', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start({
      ...CHAT_CFG,
      createModel: () => mockTextModel(['Done']),
      persistTurn: (turn) => {
        persisted.push(turn)
      }
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 42, model: 'claude-sonnet-4-6', messages: userTurn('go') })
    })
    await readSse(res)
    // onFinish fires after the stream is fully written — give the microtask a beat.
    await vi.waitFor(() => expect(persisted.length).toBe(1))
    const turn = persisted[0]
    expect(turn.sessionId).toBe(42)
    expect(turn.model).toBe('claude-sonnet-4-6')
    expect(turn.userMessage?.role).toBe('user')
    expect(turn.responseMessage.role).toBe('assistant')
    // the assistant UIMessage carries the streamed text.
    const text = turn.responseMessage.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')
    expect(text).toBe('Done')
  })
})

describe('ai-gateway — /api/ai/chat effort seam (WP-16a)', () => {
  /** mockTextModel + a spy on the doStream call options（providerOptions 抵达 wire 前的最后一站）。 */
  function mockCaptureModel(captured: Array<Record<string, unknown> | undefined>) {
    return new MockLanguageModelV3({
      doStream: async (options) => {
        captured.push(options.providerOptions as Record<string, unknown> | undefined)
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: '1' },
              { type: 'text-delta' as const, id: '1', delta: 'ok' },
              { type: 'text-end', id: '1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: {
                  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 7, text: 7, reasoning: 0 }
                }
              }
            ]
          })
        }
      }
    })
  }

  async function postChat(
    port: number,
    body: Record<string, unknown>
  ): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: userTurn('hi'), ...body })
    })
    expect(res.status).toBe(200)
    return readSse(res)
  }

  test('body.effort 合法 → effort 路径（manual 族 budgetTokens 档位映射抵达模型）', async () => {
    const captured: Array<Record<string, unknown> | undefined> = []
    const h = await start({ ...CHAT_CFG, createModel: () => mockCaptureModel(captured) })
    await postChat(h.port, { effort: 'high' })
    expect(captured[0]).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 32_000 } }
    })
  })

  test('effort 缺席 + thinking:true → 旧布尔路径字节级不变（16k budget）', async () => {
    const captured: Array<Record<string, unknown> | undefined> = []
    const h = await start({ ...CHAT_CFG, createModel: () => mockCaptureModel(captured) })
    await postChat(h.port, { thinking: true })
    expect(captured[0]).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 16_000 } }
    })
  })

  test('effort 垃圾值 → 忽略（= 旧路径 thinking 缺席：无 providerOptions）', async () => {
    const captured: Array<Record<string, unknown> | undefined> = []
    const h = await start({ ...CHAT_CFG, createModel: () => mockCaptureModel(captured) })
    await postChat(h.port, { effort: 'EXTRA' })
    expect(captured[0]).toBeUndefined()
  })

  test('effort 显式 none 压过 thinking:true（新路径优先，关断思考）', async () => {
    const captured: Array<Record<string, unknown> | undefined> = []
    const h = await start({ ...CHAT_CFG, createModel: () => mockCaptureModel(captured) })
    await postChat(h.port, { effort: 'none', thinking: true })
    expect(captured[0]).toBeUndefined()
  })
})

describe('ai-gateway — /api/ai/chat typed errors', () => {
  test('missing key → 503 E_NO_LLM_KEY (typed, no stream)', async () => {
    const h = await start({ ...CHAT_CFG, apiKey: null })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: userTurn('hi') })
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('E_NO_LLM_KEY')
  })

  test('empty messages → 400 E_INVALID_ARG', async () => {
    const h = await start({ ...CHAT_CFG, createModel: () => mockTextModel(['x']) })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] })
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('E_INVALID_ARG')
  })
})

describe('ai-gateway — abort (transport)', () => {
  test('client abort stops the stream early (echo-stream, no key needed)', async () => {
    const h = await start(CHAT_CFG)
    const ac = new AbortController()
    let seen = 0
    await expect(
      (async () => {
        const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/echo-stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '一 二 三 四 五 六 七 八 九 十' }),
          signal: ac.signal
        })
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''
          for (const _p of parts) {
            seen += 1
            if (seen === 2) ac.abort()
          }
        }
      })()
    ).rejects.toThrow()
    // aborted after ~2 frames of a 10+ token stream — proves it did not run to completion.
    expect(seen).toBeLessThanOrEqual(4)
  })
})
