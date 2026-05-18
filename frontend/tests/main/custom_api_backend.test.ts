// Sprint 4 Task #11 — Custom API backend behavioural contract.
//
// Exercises the Anthropic SSE parser + the high-level ChatBackend
// `stream()` contract by mocking `global.fetch` and feeding the parser
// known SSE chunks. No real network — all happy-dom-free, pure node.
//
// Covered:
//   - SSE chunk parser (helper)
//   - Anthropic message conversion (helper)
//   - happy path: message_start → content_block_delta(×N) → message_delta → message_stop
//     → orchestrator-shaped events (chunk × N, usage, done)
//   - upstream HTTP 429 → ErrorEvent(E_QUOTA)
//   - missing API key → ErrorEvent(E_NO_LLM_KEY)
//   - non-Anthropic model → ErrorEvent(E_MODEL_UNSUPPORTED)
//   - abort before send → no events emitted
//   - mid-stream abort → loop exits, no `done` event

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { CustomApiBackend, __testing } from '../../src/electron/main/chat/backends/custom_api'
import type { ChatStreamEvent } from '../../src/electron/main/chat/types'
import type { ChatMessage } from '../../src/electron/main/chat_db'

vi.mock('../../src/electron/main/llm_settings', () => ({
  getLlmApiKey: vi.fn(async () => 'cr_TESTING_KEY'),
  getLlmBaseUrl: () => 'https://crs.example.com',
  getLlmModel: () => 'claude-sonnet-4-6'
}))

import { getLlmApiKey } from '../../src/electron/main/llm_settings'

function userMsg(content: string, id = 1): ChatMessage {
  return {
    id,
    session_id: 1,
    role: 'user',
    content,
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    created_at: Date.now(),
    updated_at: Date.now()
  }
}

function sseStream(chunks: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function neverEndingStream(): { response: Response; close: () => void } {
  let controllerRef!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream({
    start(c) {
      controllerRef = c
    }
  })
  return {
    response: new Response(stream, { status: 200 }),
    close: () => controllerRef.close()
  }
}

async function collect(
  it: AsyncIterable<ChatStreamEvent>,
  limit = 100
): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = []
  for await (const e of it) {
    out.push(e)
    if (out.length >= limit) break
  }
  return out
}

let originalFetch: typeof fetch

beforeEach(() => {
  originalFetch = global.fetch
  vi.mocked(getLlmApiKey).mockResolvedValue('cr_TESTING_KEY')
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('CustomApiBackend — SSE chunk parser', () => {
  test('splits one block with a single data line', () => {
    const state = { buffer: '' }
    const events = __testing.parseSseChunk(state, 'data: {"type":"x"}\n\n')
    expect(events).toEqual([{ type: 'x' }])
    expect(state.buffer).toBe('')
  })

  test('coalesces multi-line data into one JSON', () => {
    const state = { buffer: '' }
    const events = __testing.parseSseChunk(state, 'data: {"a":1}\ndata: \n\n')
    expect(events).toEqual([{ a: 1 }])
  })

  test('preserves partial block across chunks', () => {
    const state = { buffer: '' }
    expect(__testing.parseSseChunk(state, 'data: {"a"')).toEqual([])
    expect(__testing.parseSseChunk(state, ':1}\n\n')).toEqual([{ a: 1 }])
  })

  test('swallows malformed JSON without throwing', () => {
    const state = { buffer: '' }
    expect(__testing.parseSseChunk(state, 'data: not-json\n\n')).toEqual([])
  })

  test('detects [DONE] sentinel', () => {
    const state = { buffer: '' }
    const events = __testing.parseSseChunk(state, 'data: [DONE]\n\n')
    expect(events).toEqual([{ __done: true }])
  })
})

describe('CustomApiBackend — buildAnthropicMessages', () => {
  test('preserves user / assistant order', () => {
    const messages = __testing.buildAnthropicMessages({
      history: [
        userMsg('hi', 1),
        { ...userMsg('', 2), role: 'assistant', content: 'hello' },
        userMsg('how are you', 3)
      ],
      model: null,
      agentPageId: null,
      signal: new AbortController().signal
    })
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you' }
    ])
  })

  test('drops aborted / error assistant rows', () => {
    const messages = __testing.buildAnthropicMessages({
      history: [
        userMsg('hi', 1),
        { ...userMsg('', 2), role: 'assistant', content: 'broken', status: 'error' },
        userMsg('try again', 3),
        { ...userMsg('', 4), role: 'assistant', content: 'partial', status: 'aborted' }
      ],
      model: null,
      agentPageId: null,
      signal: new AbortController().signal
    })
    expect(messages.map((m) => m.role)).toEqual(['user', 'user'])
  })

  test('folds tool rows as breadcrumbs into the assistant role', () => {
    const messages = __testing.buildAnthropicMessages({
      history: [
        userMsg('look it up', 1),
        {
          ...userMsg('', 2),
          role: 'tool',
          content: JSON.stringify({ name: 'lookup', detail: 'found 3 hits' })
        },
        { ...userMsg('', 3), role: 'assistant', content: 'Here it is.' }
      ],
      model: null,
      agentPageId: null,
      signal: new AbortController().signal
    })
    expect(messages[messages.length - 1].content).toContain('[tool: lookup')
    expect(messages[messages.length - 1].content).toContain('Here it is.')
  })

  test('inserts a placeholder when history is empty (avoids Anthropic 400)', () => {
    const messages = __testing.buildAnthropicMessages({
      history: [],
      model: null,
      agentPageId: null,
      signal: new AbortController().signal
    })
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
  })
})

describe('CustomApiBackend — model gating', () => {
  test('isAnthropicModel accepts claude-* prefix', () => {
    expect(__testing.isAnthropicModel('claude-sonnet-4-6')).toBe(true)
    expect(__testing.isAnthropicModel('claude-opus-4-7')).toBe(true)
    expect(__testing.isAnthropicModel('claude:5')).toBe(true)
  })
  test('isAnthropicModel rejects non-claude', () => {
    expect(__testing.isAnthropicModel('gpt-5.4')).toBe(false)
    expect(__testing.isAnthropicModel('gemini-1.5')).toBe(false)
  })

  test('stream emits E_MODEL_UNSUPPORTED for non-Anthropic models', async () => {
    const backend = new CustomApiBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: 'gpt-5.4',
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'E_MODEL_UNSUPPORTED' })
    ])
  })
})

describe('CustomApiBackend — happy path', () => {
  test('SSE chunks → chunk / usage / done events', async () => {
    const sse = [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12},"model":"claude-sonnet-4-6"}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n'
    ]
    global.fetch = vi.fn(async () => sseStream(sse)) as unknown as typeof fetch
    const backend = new CustomApiBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    const types = events.map((e) => e.type)
    expect(types).toEqual(['chunk', 'chunk', 'usage', 'done'])

    const usage = events.find((e) => e.type === 'usage')!
    if (usage.type === 'usage') {
      expect(usage.inputTokens).toBe(12)
      expect(usage.outputTokens).toBe(3)
      expect(usage.model).toBe('claude-sonnet-4-6')
    }
    const done = events.find((e) => e.type === 'done')!
    if (done.type === 'done') {
      expect(done.finalContent).toBe('Hello world')
      expect(done.model).toBe('claude-sonnet-4-6')
    }
  })

  test('Anthropic-side error event becomes an ErrorEvent', async () => {
    const sse = [
      'event: error\n',
      'data: {"type":"error","error":{"type":"overloaded","message":"servers busy"}}\n\n'
    ]
    global.fetch = vi.fn(async () => sseStream(sse)) as unknown as typeof fetch
    const backend = new CustomApiBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    const err = events.find((e) => e.type === 'error')!
    expect(err).toBeTruthy()
    if (err.type === 'error') expect(err.code).toBe('overloaded')
  })
})

describe('CustomApiBackend — error paths', () => {
  test('missing API key → E_NO_LLM_KEY', async () => {
    vi.mocked(getLlmApiKey).mockResolvedValue(null)
    const backend = new CustomApiBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'E_NO_LLM_KEY' })])
  })

  test('HTTP 429 → E_QUOTA', async () => {
    global.fetch = vi.fn(
      async () => new Response('quota exceeded', { status: 429 })
    ) as unknown as typeof fetch
    const backend = new CustomApiBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    expect(events[0].type).toBe('error')
    if (events[0].type === 'error') expect(events[0].code).toBe('E_QUOTA')
  })

  test('HTTP 500 → E_UPSTREAM', async () => {
    global.fetch = vi.fn(
      async () => new Response('boom', { status: 500 })
    ) as unknown as typeof fetch
    const backend = new CustomApiBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    expect(events[0].type).toBe('error')
    if (events[0].type === 'error') expect(events[0].code).toBe('E_UPSTREAM')
  })

  test('network thrown error → E_UPSTREAM', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('econnrefused')
    }) as unknown as typeof fetch
    const backend = new CustomApiBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    expect(events[0].type).toBe('error')
    if (events[0].type === 'error') {
      expect(events[0].code).toBe('E_UPSTREAM')
      expect(events[0].message).toContain('econnrefused')
    }
  })

  test('abort before send → no events emitted', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('should not be called')
    }) as unknown as typeof fetch
    const ac = new AbortController()
    ac.abort()
    const backend = new CustomApiBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: ac.signal
      })
    )
    // The hook only emits a hint if the upstream HTTP call begins; here we
    // short-circuit before fetch, surfacing an E_ABORTED ErrorEvent.
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'E_ABORTED' })])
  })

  test('mid-stream abort exits the read loop cleanly (no done event)', async () => {
    const { response, close } = neverEndingStream()
    global.fetch = vi.fn(async () => response) as unknown as typeof fetch
    const ac = new AbortController()
    const backend = new CustomApiBackend()
    const it = backend.stream({
      history: [userMsg('hi')],
      model: null,
      agentPageId: null,
      signal: ac.signal
    })
    const events: ChatStreamEvent[] = []
    const collector = (async (): Promise<void> => {
      for await (const e of it) events.push(e)
    })()
    // Wait one microtask tick, then abort + close upstream so reader unwinds.
    await new Promise((r) => setTimeout(r, 10))
    ac.abort()
    close()
    await collector
    expect(events.find((e) => e.type === 'done')).toBeUndefined()
  })
})
