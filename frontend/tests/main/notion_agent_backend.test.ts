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
import { notionAgentGate } from '../../src/electron/main/chat/backends/notion_agent_gate'

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
  // The serial gate is a module-level singleton shared across these cases.
  // Disable the min-interval (0) and reset its mutex/clock so one test's
  // call can't wedge the gate (or impose the 30s default spacing) on the next.
  process.env['NOTION_AGENT_MIN_INTERVAL_MS'] = '0'
  notionAgentGate.__reset()
})

afterEach(() => {
  vi.restoreAllMocks()
  notionAgentGate.__reset()
  delete process.env['NOTION_AGENT_MIN_INTERVAL_MS']
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

  // CLI ≥0.1.11 structured exit codes are authoritative regardless of stderr.
  test('exit 75 → E_NOTION_AGENT_RATE_LIMIT (trust-rule), ignoring stderr', () => {
    expect(__testing.classifyExit(75, '')).toBe('E_NOTION_AGENT_RATE_LIMIT')
    // Even if stderr looks auth-y, the structured code wins.
    expect(__testing.classifyExit(75, 'token_v2 something')).toBe('E_NOTION_AGENT_RATE_LIMIT')
  })

  test('exit 77 → E_NOTION_AGENT_AUTH', () => {
    expect(__testing.classifyExit(77, '')).toBe('E_NOTION_AGENT_AUTH')
  })

  // <0.1.11 fallback: trust-rule denial only surfaced as a stderr substring.
  test('stderr trust-rule-denied → E_NOTION_AGENT_RATE_LIMIT (legacy fallback)', () => {
    expect(__testing.classifyExit(1, 'request failed: trust-rule-denied')).toBe(
      'E_NOTION_AGENT_RATE_LIMIT'
    )
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

  test('exit 75 (trust-rule) → tool_call(error) + E_NOTION_AGENT_RATE_LIMIT', async () => {
    mockExecaStream({ chunks: [], exitCode: 75, stderr: 'error: trust-rule-denied' })
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
    if (last.type === 'error') expect(last.code).toBe('E_NOTION_AGENT_RATE_LIMIT')
    // failed call → no done/usage; the renderer routes this to the cooldown.
    expect(events.find((e) => e.type === 'done')).toBeUndefined()
  })

  test('idle (no-output) timeout → kills the child + E_NOTION_AGENT_TIMEOUT', async () => {
    // Timeout is now an IDLE watchdog, not execa's total `timeout` cap: a
    // healthy long stream re-arms it on every chunk and never trips it. Model a
    // HUNG cli — stdout that never yields, child that only settles once kill()
    // is called. With a tiny idle window the watchdog must fire, kill the
    // child, and surface a timeout (not a generic FAIL).
    process.env['NOTION_AGENT_IDLE_TIMEOUT_MS'] = '40'
    const kill = vi.fn()
    let resolveChild!: (v: unknown) => void
    const childPromise = new Promise((res) => {
      resolveChild = res
    })
    let endHang!: () => void
    const hang = new Promise<void>((res) => {
      endHang = res
    })
    kill.mockImplementation(() => {
      // kill → stdout ends (gen returns) AND the child settles as killed.
      endHang()
      resolveChild({ stderr: '', exitCode: null, isCanceled: false, killed: true })
      return true
    })
    async function* gen(): AsyncGenerator<Buffer> {
      await hang // never yields a chunk; ends only when killed
    }
    const child = childPromise as Promise<unknown> & {
      stdout?: AsyncGenerator<Buffer>
      kill?: typeof kill
    }
    child.stdout = gen()
    child.kill = kill
    mockExeca.mockReturnValue(child)

    try {
      const backend = new NotionAgentBackend()
      const events = await collect(
        backend.stream({
          history: [userMsg('hi')],
          model: null,
          agentPageId: null,
          signal: new AbortController().signal
        })
      )
      expect(kill).toHaveBeenCalled()
      const err = events.find((e) => e.type === 'error')
      expect(err).toBeTruthy()
      if (err && err.type === 'error') expect(err.code).toBe('E_NOTION_AGENT_TIMEOUT')
      // failed call → no done/usage.
      expect(events.find((e) => e.type === 'done')).toBeUndefined()
    } finally {
      delete process.env['NOTION_AGENT_IDLE_TIMEOUT_MS']
    }
  })

  test('streaming keeps the idle watchdog alive past the window (no false timeout)', async () => {
    // A chunk arrives every ~20ms with a 50ms idle window: the deadline is
    // re-armed on each chunk, so the total run far exceeds 50ms yet never trips.
    process.env['NOTION_AGENT_IDLE_TIMEOUT_MS'] = '50'
    async function* gen(): AsyncGenerator<Buffer> {
      for (const c of ['a', 'b', 'c', 'd', 'e']) {
        await new Promise((r) => setTimeout(r, 20))
        yield Buffer.from(c, 'utf8')
      }
    }
    const child = Promise.resolve({
      stderr: '',
      exitCode: 0,
      isCanceled: false,
      killed: false
    }) as Promise<unknown> & { stdout?: AsyncGenerator<Buffer> }
    child.stdout = gen()
    mockExeca.mockReturnValue(child)

    try {
      const backend = new NotionAgentBackend()
      const events = await collect(
        backend.stream({
          history: [userMsg('hi')],
          model: null,
          agentPageId: null,
          signal: new AbortController().signal
        })
      )
      // No timeout despite ~100ms total > 50ms window — re-arm on every chunk.
      expect(events.find((e) => e.type === 'error')).toBeUndefined()
      const done = events.find((e) => e.type === 'done')
      expect(done).toBeTruthy()
      if (done && done.type === 'done') expect(done.finalContent).toBe('abcde')
    } finally {
      delete process.env['NOTION_AGENT_IDLE_TIMEOUT_MS']
    }
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

describe('NotionAgentBackend — serial gate wiring', () => {
  test('two concurrent calls run one at a time: 2nd subprocess waits for the 1st to release', async () => {
    // First call's stdout stays open (awaiting `hold`) so it keeps holding the
    // gate; the second call must NOT spawn until the first finishes + releases.
    let releaseHold!: () => void
    const hold = new Promise<void>((r) => {
      releaseHold = r
    })
    let callIdx = 0
    mockExeca.mockImplementation(() => {
      const idx = callIdx++
      async function* gen(): AsyncGenerator<Buffer> {
        yield Buffer.from('hi', 'utf8')
        if (idx === 0) await hold // call #0 parks here, holding the gate
      }
      const result = { stderr: '', exitCode: 0, timedOut: false, isCanceled: false }
      const child = Promise.resolve(result) as Promise<typeof result> & {
        stdout?: AsyncGenerator<Buffer>
      }
      child.stdout = gen()
      return child as unknown as ReturnType<typeof mockExeca>
    })

    const backend = new NotionAgentBackend()
    const mkReq = (c: string) => ({
      history: [userMsg(c)],
      model: null,
      agentPageId: null,
      signal: new AbortController().signal
    })
    const p1 = collect(backend.stream(mkReq('first')))
    const p2 = collect(backend.stream(mkReq('second')))

    // Let A acquire + spawn and B queue behind the mutex.
    await new Promise((r) => setTimeout(r, 0))
    expect(mockExeca).toHaveBeenCalledTimes(1) // B has NOT spawned yet

    releaseHold() // A's stream ends → A releases the gate → B can spawn
    await Promise.all([p1, p2])
    expect(mockExeca).toHaveBeenCalledTimes(2)
  })

  test('abort while queued: the queued call never spawns a subprocess', async () => {
    // Call #0 holds the gate open; call #1 is aborted while queued and must
    // bail without ever spawning execa.
    let releaseHold!: () => void
    const hold = new Promise<void>((r) => {
      releaseHold = r
    })
    let callIdx = 0
    mockExeca.mockImplementation(() => {
      const idx = callIdx++
      async function* gen(): AsyncGenerator<Buffer> {
        yield Buffer.from('hi', 'utf8')
        if (idx === 0) await hold
      }
      const result = { stderr: '', exitCode: 0, timedOut: false, isCanceled: false }
      const child = Promise.resolve(result) as Promise<typeof result> & {
        stdout?: AsyncGenerator<Buffer>
      }
      child.stdout = gen()
      return child as unknown as ReturnType<typeof mockExeca>
    })

    const backend = new NotionAgentBackend()
    const holderAc = new AbortController()
    const queuedAc = new AbortController()
    const pHolder = collect(
      backend.stream({
        history: [userMsg('a')],
        model: null,
        agentPageId: null,
        signal: holderAc.signal
      })
    )
    const pQueued = collect(
      backend.stream({
        history: [userMsg('b')],
        model: null,
        agentPageId: null,
        signal: queuedAc.signal
      })
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(mockExeca).toHaveBeenCalledTimes(1)

    queuedAc.abort() // cancel the queued send before it ever gets the gate
    const queuedEvents = await pQueued
    // It emitted the running breadcrumb then bailed at acquire — never spawned.
    expect(queuedEvents.find((e) => e.type === 'done')).toBeUndefined()
    expect(mockExeca).toHaveBeenCalledTimes(1)

    releaseHold()
    await pHolder
    expect(mockExeca).toHaveBeenCalledTimes(1) // still only the holder ever spawned
  })
})
