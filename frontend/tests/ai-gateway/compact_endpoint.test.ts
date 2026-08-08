import { afterEach, describe, expect, test } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'

import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import type { CompactPersistence } from '../../src/ai-gateway/compact'
import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import type { ChatMessage } from '../../src/shared/chat_model'

const handles: AiGatewayHandle[] = []

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.close()
})

function row(id: number, role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id,
    session_id: 1,
    role,
    content,
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: null,
    context_tokens: null,
    created_at: id,
    updated_at: id
  }
}

const rows = [
  row(1, 'user', 'old '.repeat(80_000)),
  row(2, 'assistant', 'answer '.repeat(50_000)),
  row(3, 'user', 'tail'),
  row(4, 'assistant', 'tail answer')
]

function persistence(): CompactPersistence {
  return {
    listSessionMessages: () => rows,
    getSessionModel: () => 'm',
    appendCompactMessage: () => {}
  }
}

async function start(overrides: Partial<AiGatewayConfig>): Promise<string> {
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

describe('compact endpoints', () => {
  test('flag off dependency absence returns 404', async () => {
    const base = await start({})
    expect((await post(base, '/api/ai/compact', { sessionId: 1 })).status).toBe(404)
  })

  test('invalid sessionId returns 400', async () => {
    const base = await start({ compactPersistence: persistence() })
    const response = await post(base, '/api/ai/compact', {})
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('E_INVALID_ARG')
  })

  test('active chat run returns 409 E_RUN_ACTIVE', async () => {
    const activeRuns = new ActiveRunRegistry()
    activeRuns.register(1, new AbortController())
    const base = await start({ activeRuns, compactPersistence: persistence() })
    const response = await post(base, '/api/ai/compact', { sessionId: 1 })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('E_RUN_ACTIVE')
  })

  test('second compact returns 409 E_COMPACT_ACTIVE and stop aborts without persistence', async () => {
    let wrote = false
    const model = new MockLanguageModelV3({
      doGenerate: async (options) =>
        new Promise((resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          void resolve
        })
    })
    const base = await start({
      createModel: () => model,
      compactPersistence: {
        ...persistence(),
        appendCompactMessage: () => {
          wrote = true
        }
      }
    })
    const first = post(base, '/api/ai/compact', { sessionId: 1 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await post(base, '/api/ai/compact', { sessionId: 1 })
    expect(second.status).toBe(409)
    expect((await second.json()).error).toBe('E_COMPACT_ACTIVE')
    expect((await post(base, '/api/ai/compact/stop', { sessionId: 1 })).status).toBe(200)
    expect((await first).status).toBe(500)
    expect(wrote).toBe(false)
  })
})
