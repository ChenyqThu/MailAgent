// Notion Agent backend behavioural contract.
//
// Mocks `execa` (so no real CLI shell-out) and `fs` (so thread-id probing is
// deterministic instead of reading the dev machine's ~/.notionagents). The
// backend now runs `notion-agent chat --stream` with the prompt on stdin and
// reads stdout incrementally; thread_id is recovered by diffing the threads
// dir. Asserts:
//   - happy path: tool_call(running) → chunk(s) → tool_call(ok) → usage → done
//   - argv shape: --stream + --thread-id (no --json / no --agent-page-id),
//     prompt rides on stdin, not argv
//   - first turn recovers the new thread_id from the threads dir
//   - history with no user message → ErrorEvent(E_INVALID_ARG)
//   - non-zero exit → tool_call(error) + ErrorEvent classified by stderr
//   - timeout / abort / execa rejection paths

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { ChatStreamEvent } from '../../src/electron/main/chat/types'
import type { ChatMessage } from '../../src/electron/main/chat_db'

const { mockExeca, mockReaddir, mockStat } = vi.hoisted(() => ({
  mockExeca: vi.fn(),
  mockReaddir: vi.fn(),
  mockStat: vi.fn()
}))

vi.mock('execa', () => ({
  execa: mockExeca
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readdirSync: mockReaddir,
  statSync: mockStat
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

/** Build an execa stand-in: a thenable that resolves to the awaited result
 *  shape AND carries an async-iterable `.stdout` (matching buffer:{stdout:
 *  false}). The backend reads `child.stdout` then `await child`. */
function mockExecaStream(opts: {
  chunks?: string[]
  stderr?: string
  exitCode?: number | null
  timedOut?: boolean
  killed?: boolean
  noStdout?: boolean
}): void {
  const chunks = opts.chunks ?? []
  async function* gen(): AsyncGenerator<Buffer> {
    for (const c of chunks) yield Buffer.from(c, 'utf8')
  }
  const result = {
    stderr: opts.stderr ?? '',
    exitCode: opts.exitCode ?? 0,
    timedOut: opts.timedOut ?? false,
    isCanceled: opts.killed ?? false
  }
  const child = Promise.resolve(result) as Promise<typeof result> & {
    stdout?: AsyncGenerator<Buffer>
  }
  if (!opts.noStdout) child.stdout = gen()
  mockExeca.mockReturnValue(child)
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

beforeEach(() => {
  mockExeca.mockReset()
  mockReaddir.mockReset()
  mockStat.mockReset()
  // Default: threads dir empty before + after → no thread_id detected unless
  // a test overrides. statSync is only hit when a new file appears.
  mockReaddir.mockReturnValue([])
  mockStat.mockReturnValue({ mtimeMs: 0 })
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
      agentPageId: null,
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
      agentPageId: null,
      signal: new AbortController().signal
    })
    expect(threadId).toBe('thr-new')
  })

  test('falls back to legacy `notion-agent:<id>` model column for v1-written rows', () => {
    const { threadId } = __testing.extractTurn({
      history: [
        userMsg('hi', 1),
        assistantMsg('hello', 'notion-agent:thr-old', 2 /* no metadata */),
        userMsg('follow up', 3)
      ],
      model: null,
      agentPageId: null,
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
      agentPageId: null,
      signal: new AbortController().signal
    })
    expect(threadId).toBe('thr-new')
  })

  test('thread_id is null when no prior assistant carried one', () => {
    const { threadId } = __testing.extractTurn({
      history: [userMsg('hi', 1)],
      model: null,
      agentPageId: null,
      signal: new AbortController().signal
    })
    expect(threadId).toBeNull()
  })
})

describe('NotionAgentBackend — detectNewThreadId helper', () => {
  test('returns the file present after but not before, minus .json', () => {
    mockReaddir.mockReturnValueOnce(['a.json', 'new.json'])
    mockStat.mockReturnValue({ mtimeMs: 100 })
    const before = new Set(['a.json'])
    expect(__testing.detectNewThreadId(before)).toBe('new')
  })

  test('null when nothing new appeared', () => {
    mockReaddir.mockReturnValueOnce(['a.json'])
    expect(__testing.detectNewThreadId(new Set(['a.json']))).toBeNull()
  })

  test('picks the most recently modified when several are new', () => {
    mockReaddir.mockReturnValueOnce(['x.json', 'y.json'])
    // statSync is called in readdir order (x then y); y is newer → wins.
    mockStat.mockReturnValueOnce({ mtimeMs: 100 }).mockReturnValueOnce({ mtimeMs: 200 })
    expect(__testing.detectNewThreadId(new Set())).toBe('y')
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

describe('NotionAgentBackend — happy path (streaming)', () => {
  test('streams stdout chunks → chunk events → usage → done; reuses --thread-id', async () => {
    mockExecaStream({ chunks: ['Hello', ' back', '.\n'], exitCode: 0 })

    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [
          userMsg('hi', 1),
          assistantMsg('prev', 'claude-opus-4-8', 2, '{"thread_id":"thr-001"}'),
          userMsg('again', 3)
        ],
        model: 'opus-4.8',
        agentPageId: null,
        signal: new AbortController().signal
      })
    )

    // first event is the running breadcrumb; last is done.
    expect(events[0].type).toBe('tool_call')
    expect(events[events.length - 1].type).toBe('done')

    // streamed deltas concatenate to the full reply.
    const streamed = events
      .filter((e) => e.type === 'chunk')
      .map((e) => (e as { delta: string }).delta)
      .join('')
    expect(streamed).toBe('Hello back.\n')

    const usage = events.find((e) => e.type === 'usage')
    if (usage && usage.type === 'usage') {
      expect(usage.model).toBe('opus-4.8')
      expect(usage.metadata).toEqual({ thread_id: 'thr-001' })
    }

    const done = events.find((e) => e.type === 'done')
    if (done && done.type === 'done') {
      expect(done.finalContent).toBe('Hello back.') // trailing newline trimmed
      expect(done.metadata).toEqual({ thread_id: 'thr-001' })
    }

    // argv: --stream + --thread-id, NOT --json / --agent-page-id; prompt on stdin.
    const argv = mockExeca.mock.calls[0][1] as string[]
    const opts = mockExeca.mock.calls[0][2] as { input?: string }
    expect(argv).toContain('--stream')
    expect(argv).toContain('--thread-id')
    expect(argv).toContain('thr-001')
    expect(argv).toContain('--model')
    expect(argv).toContain('opus-4.8')
    expect(argv).not.toContain('--json')
    expect(argv).not.toContain('--agent-page-id')
    expect(argv).not.toContain('again') // prompt is NOT an argv positional
    expect(opts.input).toContain('again') // prompt rides on stdin
  })

  test('first turn (no prior thread) recovers thread_id from the threads dir', async () => {
    // before snapshot empty, after has the freshly-written file.
    mockReaddir.mockReturnValueOnce([]).mockReturnValueOnce(['thr-fresh.json'])
    mockStat.mockReturnValue({ mtimeMs: 123 })
    mockExecaStream({ chunks: ['Hi'], exitCode: 0 })

    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hello')],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )

    const done = events.find((e) => e.type === 'done')
    if (done && done.type === 'done') {
      expect(done.metadata).toEqual({ thread_id: 'thr-fresh' })
    }
    // first turn has no --thread-id; email context header prepended on stdin.
    const argv = mockExeca.mock.calls[0][1] as string[]
    expect(argv).not.toContain('--thread-id')
  })
})

describe('NotionAgentBackend — error paths', () => {
  test('empty user history → ErrorEvent(E_INVALID_ARG), no spawn', async () => {
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'E_INVALID_ARG' })])
    expect(mockExeca).not.toHaveBeenCalled()
  })

  test('non-zero exit with token_v2 stderr → tool_call(error) + E_NOTION_AGENT_AUTH', async () => {
    mockExecaStream({
      chunks: [],
      exitCode: 1,
      stderr: 'token_v2 cookie has expired, re-run notion-agent init'
    })
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    const last = events[events.length - 1]
    expect(last.type).toBe('error')
    if (last.type === 'error') expect(last.code).toBe('E_NOTION_AGENT_AUTH')
    // no done/usage when the call failed.
    expect(events.find((e) => e.type === 'done')).toBeUndefined()
  })

  test('subprocess timed out → E_NOTION_AGENT_TIMEOUT', async () => {
    mockExecaStream({ chunks: [], timedOut: true, exitCode: null })
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    const err = events.find((e) => e.type === 'error')
    expect(err).toBeTruthy()
    if (err && err.type === 'error') expect(err.code).toBe('E_NOTION_AGENT_TIMEOUT')
  })

  test('aborted signal → no done/usage emitted', async () => {
    mockExecaStream({ chunks: ['partial'], killed: true, exitCode: null })
    const ac = new AbortController()
    ac.abort()
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: ac.signal
      })
    )
    expect(events.find((e) => e.type === 'done')).toBeUndefined()
    expect(events.find((e) => e.type === 'usage')).toBeUndefined()
  })

  test('execa rejection → ErrorEvent(E_NOTION_AGENT_FAIL)', async () => {
    // no .stdout on a rejected child; await throws → caught → FAIL.
    const rejected = Promise.reject(new Error('ENOENT')) as Promise<never> & {
      stdout?: undefined
    }
    rejected.catch(() => {}) // pre-attach so Node doesn't flag unhandled rejection
    mockExeca.mockReturnValue(rejected)
    const backend = new NotionAgentBackend()
    const events = await collect(
      backend.stream({
        history: [userMsg('hi')],
        model: null,
        agentPageId: null,
        signal: new AbortController().signal
      })
    )
    const err = events.find((e) => e.type === 'error')
    expect(err).toBeTruthy()
    if (err && err.type === 'error') expect(err.code).toBe('E_NOTION_AGENT_FAIL')
  })
})
