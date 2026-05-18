// Sprint 4 Task #12 — Notion Agent backend behavioural contract.
//
// Mocks `execa` so the test doesn't shell out to the real notion-agent
// CLI. Asserts:
//   - happy path: --json shaped reply → tool_call(running) →
//     tool_call(ok) → chunk → usage → done events
//   - missing agent_page_id → ErrorEvent(E_INVALID_ARG)
//   - history with no user message → ErrorEvent(E_INVALID_ARG)
//   - non-zero exit → tool_call(error) + ErrorEvent classified by stderr
//   - malformed JSON stdout → ErrorEvent(E_NOTION_AGENT_PARSE)
//   - thread_id reuse across turns (model field carries it back)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { ChatStreamEvent } from '../../src/electron/main/chat/types'
import type { ChatMessage } from '../../src/electron/main/chat_db'

const { mockExeca } = vi.hoisted(() => ({
  mockExeca: vi.fn()
}))

vi.mock('execa', () => ({
  execa: mockExeca
}))

vi.mock('../../src/electron/main/bin_resolver', () => ({
  whichSync: () => '/usr/local/bin/notion-agent'
}))

import {
  NotionAgentBackend,
  __resetNotionAgentBinCache,
  __testing,
  resolveNotionAgentBin
} from '../../src/electron/main/chat/backends/notion_agent'

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

function assistantMsg(
  content: string,
  model: string | null,
  id = 2,
  metadata: string | null = null
): ChatMessage {
  return {
    ...userMsg('', id),
    role: 'assistant',
    content,
    model,
    metadata
  }
}

function mockExecaResult(opts: {
  stdout?: string
  stderr?: string
  exitCode?: number
  timedOut?: boolean
  killed?: boolean
}): void {
  // execa returns a "thenable child" — vitest's vi.fn lets us return a
  // resolved promise that mimics the awaited shape used by the backend.
  mockExeca.mockReturnValue(
    Promise.resolve({
      stdout: opts.stdout ?? '',
      stderr: opts.stderr ?? '',
      exitCode: opts.exitCode ?? 0,
      timedOut: opts.timedOut ?? false,
      killed: opts.killed ?? false
    })
  )
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

beforeEach(() => {
  mockExeca.mockReset()
  __resetNotionAgentBinCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NotionAgentBackend — binary resolution', () => {
  test('resolveNotionAgentBin returns the `which` hit', () => {
    expect(resolveNotionAgentBin()).toBe('/usr/local/bin/notion-agent')
  })

  test('caches across calls', () => {
    expect(resolveNotionAgentBin()).toBe(resolveNotionAgentBin())
  })

  test('honours $NOTION_AGENT_BIN when present', () => {
    process.env['NOTION_AGENT_BIN'] = '/usr/local/bin/notion-agent'
    __resetNotionAgentBinCache()
    try {
      expect(resolveNotionAgentBin()).toBe('/usr/local/bin/notion-agent')
    } finally {
      delete process.env['NOTION_AGENT_BIN']
      __resetNotionAgentBinCache()
    }
  })
})

describe('NotionAgentBackend — extractTurn helper', () => {
  test('picks the most recent user message as the prompt', () => {
    const { prompt } = __testing.extractTurn({
      history: [userMsg('first', 1), assistantMsg('hi', null, 2), userMsg('second', 3)],
      model: null,
      agentPageId: 'a1',
      signal: new AbortController().signal
    })
    expect(prompt).toBe('second')
  })

  test('extracts thread_id from prior assistant.metadata (v2 schema)', () => {
    const { threadId } = __testing.extractTurn({
      history: [
        userMsg('hi', 1),
        assistantMsg('hello', 'claude-sonnet-4-6', 2, '{"thread_id":"thr-new"}'),
        userMsg('follow up', 3)
      ],
      model: null,
      agentPageId: 'a1',
      signal: new AbortController().signal
    })
    expect(threadId).toBe('thr-new')
  })

  test('falls back to legacy `notion-agent:<id>` model column for v1-written rows', () => {
    // Sprint 5 Day 1 (opus L carry-forward): users with pre-migration
    // ai_chat.db rows have thread_id encoded in `model`, not metadata.
    // The reader must keep working until they roll past those turns.
    const { threadId } = __testing.extractTurn({
      history: [
        userMsg('hi', 1),
        assistantMsg('hello', 'notion-agent:thr-old', 2 /* no metadata */),
        userMsg('follow up', 3)
      ],
      model: null,
      agentPageId: 'a1',
      signal: new AbortController().signal
    })
    expect(threadId).toBe('thr-old')
  })

  test('metadata takes precedence over the legacy model encoding when both present', () => {
    const { threadId } = __testing.extractTurn({
      history: [
        userMsg('hi', 1),
        assistantMsg('hello', 'notion-agent:thr-old', 2, '{"thread_id":"thr-new"}'),
        userMsg('follow up', 3)
      ],
      model: null,
      agentPageId: 'a1',
      signal: new AbortController().signal
    })
    expect(threadId).toBe('thr-new')
  })

  test('malformed metadata JSON falls through to the model column', () => {
    const { threadId } = __testing.extractTurn({
      history: [
        userMsg('hi', 1),
        assistantMsg('hello', 'notion-agent:thr-fallback', 2, '{not-json'),
        userMsg('follow up', 3)
      ],
      model: null,
      agentPageId: 'a1',
      signal: new AbortController().signal
    })
    expect(threadId).toBe('thr-fallback')
  })

  test('thread_id is null when no prior assistant carried one', () => {
    const { threadId } = __testing.extractTurn({
      history: [userMsg('hi', 1)],
      model: null,
      agentPageId: 'a1',
      signal: new AbortController().signal
    })
    expect(threadId).toBeNull()
  })
})

describe('NotionAgentBackend — classifyExit', () => {
  test('detects token_v2 / unauthorized → E_NOTION_AGENT_AUTH', () => {
    expect(__testing.classifyExit(1, 'token_v2 cookie expired')).toBe('E_NOTION_AGENT_AUTH')
    expect(__testing.classifyExit(1, 'unauthorized')).toBe('E_NOTION_AGENT_AUTH')
  })

  test('detects cloudflare / network → E_NOTION_AGENT_NETWORK', () => {
    expect(__testing.classifyExit(1, 'cloudflare blocked')).toBe('E_NOTION_AGENT_NETWORK')
    expect(__testing.classifyExit(1, 'network unreachable')).toBe('E_NOTION_AGENT_NETWORK')
  })

  test('127 → E_NOTION_AGENT_NOT_INSTALLED', () => {
    expect(__testing.classifyExit(127, '')).toBe('E_NOTION_AGENT_NOT_INSTALLED')
  })

  test('default → E_NOTION_AGENT_FAIL', () => {
    expect(__testing.classifyExit(1, 'unknown')).toBe('E_NOTION_AGENT_FAIL')
  })
})

describe('NotionAgentBackend — happy path', () => {
  test('emits tool_call(running) → tool_call(ok) → chunk → usage → done', async () => {
    mockExecaResult({
      stdout: JSON.stringify({
        text: 'Hello back.',
        thread_id: 'thr-001',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 14, output_tokens: 5 }
      }),
      exitCode: 0
    })

    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: 'gpt-5.4',
        agentPageId: 'agent-1',
        signal: new AbortController().signal
      })
    )

    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_call', 'chunk', 'usage', 'done'])
    const ok = events[1]
    if (ok.type === 'tool_call') expect(ok.status).toBe('ok')

    const chunk = events[2]
    if (chunk.type === 'chunk') expect(chunk.delta).toBe('Hello back.')

    // Sprint 5 Day 1 (opus L carry-forward): model column carries the
    // real upstream model name; thread_id rides in metadata.
    const usage = events[3]
    if (usage.type === 'usage') {
      expect(usage.inputTokens).toBe(14)
      expect(usage.outputTokens).toBe(5)
      expect(usage.model).toBe('claude-sonnet-4-6')
      expect(usage.metadata).toEqual({ thread_id: 'thr-001' })
    }

    const done = events[4]
    if (done.type === 'done') {
      expect(done.finalContent).toBe('Hello back.')
      expect(done.model).toBe('claude-sonnet-4-6')
      expect(done.metadata).toEqual({ thread_id: 'thr-001' })
    }

    // execa called with the expected argv shape.
    expect(mockExeca).toHaveBeenCalledTimes(1)
    const call = mockExeca.mock.calls[0]
    expect(call[1]).toEqual(
      expect.arrayContaining([
        'chat',
        'hi',
        '--json',
        '--agent-page-id',
        'agent-1',
        '--model',
        'gpt-5.4'
      ])
    )
  })

  test('reuses thread_id from history metadata (v2: --thread-id appended)', async () => {
    mockExecaResult({
      stdout: JSON.stringify({ text: 'and another', thread_id: 'thr-001' }),
      exitCode: 0
    })
    const backend = new NotionAgentBackend()
    await collect(
      backend.stream({
        history: [
          userMsg('hi', 1),
          assistantMsg('hello', 'claude-sonnet-4-6', 2, '{"thread_id":"thr-001"}'),
          userMsg('follow up', 3)
        ],
        model: null,
        agentPageId: 'agent-1',
        signal: new AbortController().signal
      })
    )
    const argv = mockExeca.mock.calls[0][1] as string[]
    expect(argv).toContain('--thread-id')
    expect(argv).toContain('thr-001')
  })

  test('reuses thread_id from v1 legacy `notion-agent:<id>` model field', async () => {
    mockExecaResult({
      stdout: JSON.stringify({ text: 'and another', thread_id: 'thr-001' }),
      exitCode: 0
    })
    const backend = new NotionAgentBackend()
    await collect(
      backend.stream({
        history: [
          userMsg('hi', 1),
          // v1-written row: no metadata, thread_id stuffed in model.
          assistantMsg('hello', 'notion-agent:thr-001', 2),
          userMsg('follow up', 3)
        ],
        model: null,
        agentPageId: 'agent-1',
        signal: new AbortController().signal
      })
    )
    const argv = mockExeca.mock.calls[0][1] as string[]
    expect(argv).toContain('--thread-id')
    expect(argv).toContain('thr-001')
  })
})

describe('NotionAgentBackend — error paths', () => {
  test('missing agentPageId → ErrorEvent(E_INVALID_ARG)', async () => {
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'E_INVALID_ARG' })])
    expect(mockExeca).not.toHaveBeenCalled()
  })

  test('empty user history → ErrorEvent(E_INVALID_ARG)', async () => {
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [],
        model: null,
        agentPageId: 'agent-1',
        signal: new AbortController().signal
      })
    )
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'E_INVALID_ARG' })])
  })

  test('non-zero exit with token_v2 stderr → tool_call(error) + E_NOTION_AGENT_AUTH', async () => {
    mockExecaResult({
      exitCode: 1,
      stderr: 'token_v2 cookie has expired, re-run notion-agent init'
    })
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: 'agent-1',
        signal: new AbortController().signal
      })
    )
    // tool_call(running), tool_call(error), error
    expect(events.length).toBe(3)
    const last = events[2]
    expect(last.type).toBe('error')
    if (last.type === 'error') expect(last.code).toBe('E_NOTION_AGENT_AUTH')
  })

  test('malformed JSON → E_NOTION_AGENT_PARSE', async () => {
    mockExecaResult({ stdout: 'not-json', exitCode: 0 })
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: 'agent-1',
        signal: new AbortController().signal
      })
    )
    const err = events.find((e) => e.type === 'error')!
    expect(err).toBeTruthy()
    if (err.type === 'error') expect(err.code).toBe('E_NOTION_AGENT_PARSE')
  })

  test('subprocess timed out → E_NOTION_AGENT_TIMEOUT', async () => {
    mockExecaResult({ timedOut: true, exitCode: null as unknown as number })
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: 'agent-1',
        signal: new AbortController().signal
      })
    )
    const err = events.find((e) => e.type === 'error')!
    if (err.type === 'error') expect(err.code).toBe('E_NOTION_AGENT_TIMEOUT')
  })

  test('killed by abort signal → no events emitted after kill', async () => {
    mockExecaResult({ killed: true, exitCode: null as unknown as number })
    const ac = new AbortController()
    ac.abort()
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: 'agent-1',
        signal: ac.signal
      })
    )
    // tool_call(running) might still emit before we observe signal,
    // but the run path returns silently afterwards.
    expect(events.find((e) => e.type === 'done')).toBeUndefined()
    expect(events.find((e) => e.type === 'usage')).toBeUndefined()
  })

  test('thrown execa rejection → ErrorEvent(E_NOTION_AGENT_FAIL)', async () => {
    mockExeca.mockReturnValue(Promise.reject(new Error('ENOENT')))
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: 'agent-1',
        signal: new AbortController().signal
      })
    )
    const err = events.find((e) => e.type === 'error')!
    if (err.type === 'error') expect(err.code).toBe('E_NOTION_AGENT_FAIL')
  })
})
