// Sprint 19 PR-1d.1 — Multi-turn agent harness integration tests.
//
// Verifies the iter loop end-to-end against a mock backend that scripts a
// sequence of chunk/tool_use/done events. The mock registry hosts an
// in-memory tool whose handler returns a deterministic result so we can
// assert (a) tool execution wired, (b) chat_tool_call audit rows written,
// (c) priorTurns built correctly between iters, (d) terminal conditions
// (end_turn / MAX_ITER / abort / cost cap) flip the assistant row to the
// right status.

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendMessage,
  closeChatDb,
  getMessage,
  getOrCreateSession,
  listToolCallsForMessage
} from '../../../src/electron/main/chat_db'
import { runHarness } from '../../../src/shared/chat/harness'
import { testChatPlatform } from './_fixtures/test_chat_platform'
import {
  createToolRegistry,
  type ToolDef,
  type ToolResult
} from '../../../src/shared/chat/tools/registry'
import { __resetConfirmations } from '../../../src/shared/chat/tools/confirmation'
import type {
  ChatBackend,
  ChatStreamEnvelope,
  ChatStreamEvent,
  ChatStreamRequest
} from '../../../src/shared/chat/types'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-'))
  process.env['AI_CHAT_DB_PATH'] = join(tmpDir, 'ai_chat.db')
  process.env['MAILAGENT_AGENT_HARNESS'] = '1'
  // Conservative defaults so abort-loops in tests stay fast.
  process.env['AGENT_MAX_ITER'] = '4'
  process.env['AGENT_MAX_COST_USD'] = '5'
  closeChatDb()
  __resetConfirmations()
})

afterEach(() => {
  closeChatDb()
  __resetConfirmations()
  delete process.env['AI_CHAT_DB_PATH']
  delete process.env['MAILAGENT_AGENT_HARNESS']
  delete process.env['AGENT_MAX_ITER']
  delete process.env['AGENT_MAX_COST_USD']
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

// ── helpers ────────────────────────────────────────────────────────────

function recordingSink(): {
  events: ChatStreamEvent[]
  envelopes: ChatStreamEnvelope[]
  send: (e: ChatStreamEnvelope) => void
} {
  const envelopes: ChatStreamEnvelope[] = []
  const events: ChatStreamEvent[] = []
  return {
    events,
    envelopes,
    send(env: ChatStreamEnvelope) {
      envelopes.push(env)
      events.push(env.event)
    }
  }
}

/** A scriptable backend: each entry in `iters` is the event sequence for
 *  one runHarness iteration. The mock advances by index per call. */
function scriptedBackend(
  iters: ChatStreamEvent[][]
): ChatBackend & { lastReq: ChatStreamRequest | null } {
  let idx = 0
  const backend = {
    kind: 'custom-api' as const,
    lastReq: null as ChatStreamRequest | null,
    async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
      backend.lastReq = req
      const events = iters[idx] ?? [
        { type: 'done', finalContent: '', model: null, stopReason: 'end_turn' }
      ]
      idx++
      for (const e of events) {
        yield e
      }
    }
  }
  return backend
}

function makeSilentTool(name: string, handler: ToolDef['handler']): ToolDef {
  return {
    name,
    description: 'test tool',
    inputSchema: { type: 'object' },
    confirmationTier: 'silent',
    category: 'read',
    surface: 'ipc',
    handler
  }
}

function seedAssistantTurn(emailId = 101): { sessionId: number; assistantMessageId: number } {
  const session = getOrCreateSession({ emailId, backendKind: 'custom-api' })
  appendMessage({
    sessionId: session.id,
    role: 'user',
    content: 'hello',
    status: 'complete'
  })
  const assistant = appendMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '',
    status: 'streaming'
  })
  return { sessionId: session.id, assistantMessageId: assistant.id }
}

// ── tests ───────────────────────────────────────────────────────────────

describe('runHarness — happy path (single tool roundtrip then end_turn)', () => {
  test('one tool_use → dispatch → next iter end_turn', async () => {
    const { sessionId, assistantMessageId } = seedAssistantTurn()
    const registry = createToolRegistry()
    let toolInvokedWith: unknown = null
    registry.register(
      makeSilentTool('echo', async (input): Promise<ToolResult> => {
        toolInvokedWith = input
        return { ok: true, output: { echoed: input }, durationMs: 1 }
      })
    )
    const backend = scriptedBackend([
      [
        { type: 'chunk', delta: 'Let me check. ' },
        {
          type: 'tool_use',
          toolUseId: 'toolu_abc',
          name: 'echo',
          input: { q: 'hello' }
        },
        { type: 'done', finalContent: 'Let me check. ', model: 'm', stopReason: 'tool_use' }
      ],
      [
        { type: 'chunk', delta: 'Done — echoed back.' },
        { type: 'done', finalContent: 'Done — echoed back.', model: 'm', stopReason: 'end_turn' }
      ]
    ])
    const ac = new AbortController()
    const sink = recordingSink()
    await runHarness({
      sessionId,
      assistantMessageId,
      backend,
      initialHistory: [],
      model: 'claude-sonnet-4-6',
      agentPageId: null,
      emailContext: null,
      ac,
      platform: testChatPlatform,
      sink,
      registry
    })

    expect(toolInvokedWith).toEqual({ q: 'hello' })

    // chat_tool_call row persisted with success status.
    const rows = listToolCallsForMessage(assistantMessageId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tool_use_id).toBe('toolu_abc')
    expect(rows[0]?.status).toBe('ok')
    expect(JSON.parse(rows[0]?.output_json ?? 'null')).toEqual({ echoed: { q: 'hello' } })

    // task 06-08-chat Bug 2 — content_offset = buffer length when the harness
    // saw the tool_use, i.e. the length of the text streamed before it
    // ('Let me check. ' = 14 chars). Drives time-ordered chip interleaving.
    expect(rows[0]?.content_offset).toBe('Let me check. '.length)

    // Assistant message flipped to complete + buffer accumulated across iters.
    const finalMsg = getMessage(assistantMessageId)
    expect(finalMsg?.status).toBe('complete')
    expect(finalMsg?.content).toBe('Let me check. Done — echoed back.')

    // Event stream: chunks + tool_use + tool_result + done events all forwarded.
    expect(sink.events.some((e) => e.type === 'tool_use')).toBe(true)
    expect(sink.events.some((e) => e.type === 'tool_result')).toBe(true)
  })

  test('iter-2 backend request carries priorTurns with tool_use + tool_result blocks', async () => {
    const { sessionId, assistantMessageId } = seedAssistantTurn()
    const registry = createToolRegistry()
    registry.register(
      makeSilentTool(
        'noop',
        async (): Promise<ToolResult> => ({ ok: true, output: 'r', durationMs: 0 })
      )
    )
    const backend = scriptedBackend([
      [
        { type: 'tool_use', toolUseId: 'toolu_x', name: 'noop', input: {} },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ],
      [
        { type: 'chunk', delta: 'ok' },
        { type: 'done', finalContent: 'ok', model: null, stopReason: 'end_turn' }
      ]
    ])
    const ac = new AbortController()
    await runHarness({
      sessionId,
      assistantMessageId,
      backend,
      initialHistory: [],
      model: null,
      agentPageId: null,
      emailContext: null,
      ac,
      platform: testChatPlatform,
      sink: recordingSink(),
      registry
    })

    // Iter-2 (the LAST call to backend.stream) saw iterHistory containing
    // both the assistant turn (text + tool_use) and the user tool_result turn.
    const iterHistory = backend.lastReq?.iterHistory ?? []
    expect(iterHistory.length).toBeGreaterThanOrEqual(3) // base user + assistant + user-tool_result
    const last2 = iterHistory.slice(-2)
    expect(last2[0]?.role).toBe('assistant')
    expect(last2[1]?.role).toBe('user')
    const userBlocks = last2[1]?.content as Array<{ type: string; tool_use_id?: string }>
    expect(Array.isArray(userBlocks)).toBe(true)
    expect(userBlocks?.[0]?.type).toBe('tool_result')
    expect(userBlocks?.[0]?.tool_use_id).toBe('toolu_x')
  })
})

describe('runHarness — content_offset (task 06-08-chat Bug 2)', () => {
  test('offsets track the running buffer across text + multiple tool_use across iters', async () => {
    const { sessionId, assistantMessageId } = seedAssistantTurn()
    const registry = createToolRegistry()
    registry.register(
      makeSilentTool(
        'noop',
        async (): Promise<ToolResult> => ({ ok: true, output: 'r', durationMs: 0 })
      )
    )
    // iter-1: "AAAA" then tool a, then "BB" then tool b (still in iter-1).
    // iter-2: "CCC" then tool c, then end_turn.
    // Running buffer at each tool_use:
    //   a → 4   ("AAAA")
    //   b → 6   ("AAAA" + "BB")
    //   c → 9   ("AAAA" + "BB" + "CCC")
    const backend = scriptedBackend([
      [
        { type: 'chunk', delta: 'AAAA' },
        { type: 'tool_use', toolUseId: 'toolu_a', name: 'noop', input: {} },
        { type: 'chunk', delta: 'BB' },
        { type: 'tool_use', toolUseId: 'toolu_b', name: 'noop', input: {} },
        { type: 'done', finalContent: 'AAAABB', model: null, stopReason: 'tool_use' }
      ],
      [
        { type: 'chunk', delta: 'CCC' },
        { type: 'tool_use', toolUseId: 'toolu_c', name: 'noop', input: {} },
        { type: 'done', finalContent: 'CCC', model: null, stopReason: 'tool_use' }
      ],
      [{ type: 'done', finalContent: '', model: null, stopReason: 'end_turn' }]
    ])
    const ac = new AbortController()
    await runHarness({
      sessionId,
      assistantMessageId,
      backend,
      initialHistory: [],
      model: null,
      agentPageId: null,
      emailContext: null,
      ac,
      platform: testChatPlatform,
      sink: recordingSink(),
      registry
    })

    const rows = listToolCallsForMessage(assistantMessageId)
    const byId = new Map(rows.map((r) => [r.tool_use_id, r.content_offset]))
    expect(byId.get('toolu_a')).toBe(4)
    expect(byId.get('toolu_b')).toBe(6)
    expect(byId.get('toolu_c')).toBe(9)
    // Final content is the full buffer so offsets index into it cleanly.
    expect(getMessage(assistantMessageId)?.content).toBe('AAAABBCCC')
  })

  test('a tool_use with no preceding text gets content_offset 0', async () => {
    const { sessionId, assistantMessageId } = seedAssistantTurn()
    const registry = createToolRegistry()
    registry.register(
      makeSilentTool(
        'noop',
        async (): Promise<ToolResult> => ({ ok: true, output: 'r', durationMs: 0 })
      )
    )
    const backend = scriptedBackend([
      [
        { type: 'tool_use', toolUseId: 'toolu_first', name: 'noop', input: {} },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ],
      [
        { type: 'chunk', delta: 'after' },
        { type: 'done', finalContent: 'after', model: null, stopReason: 'end_turn' }
      ]
    ])
    const ac = new AbortController()
    await runHarness({
      sessionId,
      assistantMessageId,
      backend,
      initialHistory: [],
      model: null,
      agentPageId: null,
      emailContext: null,
      ac,
      platform: testChatPlatform,
      sink: recordingSink(),
      registry
    })
    const rows = listToolCallsForMessage(assistantMessageId)
    expect(rows[0]?.tool_use_id).toBe('toolu_first')
    expect(rows[0]?.content_offset).toBe(0)
  })
})

describe('runHarness — terminal conditions', () => {
  test('end_turn on iter-1 with zero tools collected terminates immediately', async () => {
    const { sessionId, assistantMessageId } = seedAssistantTurn()
    const backend = scriptedBackend([
      [
        { type: 'chunk', delta: 'Just a text reply.' },
        { type: 'done', finalContent: 'Just a text reply.', model: null, stopReason: 'end_turn' }
      ]
    ])
    const ac = new AbortController()
    await runHarness({
      sessionId,
      assistantMessageId,
      backend,
      initialHistory: [],
      model: null,
      agentPageId: null,
      emailContext: null,
      ac,
      platform: testChatPlatform,
      sink: recordingSink(),
      registry: createToolRegistry()
    })
    expect(getMessage(assistantMessageId)?.status).toBe('complete')
    expect(getMessage(assistantMessageId)?.content).toBe('Just a text reply.')
  })

  test('MAX_ITER exceeded → error event + assistant flipped to error', async () => {
    process.env['AGENT_MAX_ITER'] = '2'
    const { sessionId, assistantMessageId } = seedAssistantTurn()
    const registry = createToolRegistry()
    registry.register(
      makeSilentTool(
        'spin',
        async (): Promise<ToolResult> => ({ ok: true, output: 1, durationMs: 0 })
      )
    )
    // Each iter keeps emitting tool_use → harness never gets end_turn.
    const looper = (): ChatStreamEvent[] => [
      { type: 'tool_use', toolUseId: `toolu_${Math.random()}`, name: 'spin', input: {} },
      { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
    ]
    const backend = scriptedBackend([looper(), looper(), looper()])
    const ac = new AbortController()
    const sink = recordingSink()
    await runHarness({
      sessionId,
      assistantMessageId,
      backend,
      initialHistory: [],
      model: null,
      agentPageId: null,
      emailContext: null,
      ac,
      platform: testChatPlatform,
      sink,
      registry
    })
    const errEv = sink.events.find((e) => e.type === 'error') as
      | { type: 'error'; code: string; message: string }
      | undefined
    expect(errEv?.code).toBe('E_MAX_ITER')
    expect(getMessage(assistantMessageId)?.status).toBe('error')
    expect(getMessage(assistantMessageId)?.error_message).toMatch(/max iter/i)
  })

  test('cost cap exceeded → E_COST_BUDGET + assistant error', async () => {
    process.env['AGENT_MAX_COST_USD'] = '0.10'
    const { sessionId, assistantMessageId } = seedAssistantTurn()
    const registry = createToolRegistry()
    registry.register(
      makeSilentTool(
        'spin',
        async (): Promise<ToolResult> => ({ ok: true, output: 1, durationMs: 0 })
      )
    )
    const backend = scriptedBackend([
      [
        {
          type: 'usage',
          inputTokens: 1000,
          outputTokens: 100,
          costUsd: 0.5,
          model: null
        },
        { type: 'tool_use', toolUseId: 'toolu_burn', name: 'spin', input: {} },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ]
    ])
    const ac = new AbortController()
    const sink = recordingSink()
    await runHarness({
      sessionId,
      assistantMessageId,
      backend,
      initialHistory: [],
      model: null,
      agentPageId: null,
      emailContext: null,
      ac,
      platform: testChatPlatform,
      sink,
      registry
    })
    const errEv = sink.events.find((e) => e.type === 'error') as
      | { type: 'error'; code: string }
      | undefined
    expect(errEv?.code).toBe('E_COST_BUDGET')
    expect(getMessage(assistantMessageId)?.status).toBe('error')
  })

  test('session abort mid-iter terminates without flipping to complete', async () => {
    const { sessionId, assistantMessageId } = seedAssistantTurn()
    const ac = new AbortController()
    // Backend yields one chunk, then we abort BEFORE done arrives.
    const backend: ChatBackend = {
      kind: 'custom-api',
      async *stream() {
        yield { type: 'chunk', delta: 'partial...' }
        ac.abort('user_left')
        yield { type: 'done', finalContent: 'partial...', model: null, stopReason: 'end_turn' }
      }
    }
    await runHarness({
      sessionId,
      assistantMessageId,
      backend,
      initialHistory: [],
      model: null,
      agentPageId: null,
      emailContext: null,
      ac,
      platform: testChatPlatform,
      sink: recordingSink(),
      registry: createToolRegistry()
    })
    // assistant row marked 'aborted' via abortStreamingMessages.
    expect(getMessage(assistantMessageId)?.status).toBe('aborted')
  })

  test('abort before first iteration → aborted, not E_MAX_ITER 误报 (codex MEDIUM-1)', async () => {
    const { sessionId, assistantMessageId } = seedAssistantTurn()
    const ac = new AbortController()
    ac.abort('pre-aborted') // 模拟 http 下 await resolveConfig 让步窗口内被 chat:abort 取消
    const backend = scriptedBackend([
      [{ type: 'done', finalContent: '', model: null, stopReason: 'end_turn' }]
    ])
    const sink = recordingSink()
    await runHarness({
      sessionId,
      assistantMessageId,
      backend,
      initialHistory: [],
      model: null,
      agentPageId: null,
      emailContext: null,
      ac,
      sink,
      platform: testChatPlatform,
      registry: createToolRegistry()
    })
    // while 顶部 abort 检测应标 aborted + return，不落到末尾 E_MAX_ITER。
    expect(getMessage(assistantMessageId)?.status).toBe('aborted')
    expect(sink.events.find((e) => e.type === 'error')).toBeUndefined()
  })

  test('backend yields error event → harness propagates + flips assistant to error', async () => {
    const { sessionId, assistantMessageId } = seedAssistantTurn()
    const backend = scriptedBackend([
      [
        { type: 'chunk', delta: 'partial' },
        { type: 'error', code: 'E_QUOTA', message: 'rate limit' }
      ]
    ])
    const ac = new AbortController()
    const sink = recordingSink()
    await runHarness({
      sessionId,
      assistantMessageId,
      backend,
      initialHistory: [],
      model: null,
      agentPageId: null,
      emailContext: null,
      ac,
      platform: testChatPlatform,
      sink,
      registry: createToolRegistry()
    })
    const errEv = sink.events.find((e) => e.type === 'error') as
      | { type: 'error'; code: string }
      | undefined
    expect(errEv?.code).toBe('E_QUOTA')
    expect(getMessage(assistantMessageId)?.status).toBe('error')
  })
})

describe('runHarness — unknown tool resilience', () => {
  test('LLM hallucinates a tool name → tool_result has error, harness continues to next iter', async () => {
    const { sessionId, assistantMessageId } = seedAssistantTurn()
    const registry = createToolRegistry() // no tools registered
    const backend = scriptedBackend([
      [
        { type: 'tool_use', toolUseId: 'toolu_huh', name: 'phantom_tool', input: {} },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ],
      [
        { type: 'chunk', delta: 'Sorry, I cant.' },
        { type: 'done', finalContent: 'Sorry, I cant.', model: null, stopReason: 'end_turn' }
      ]
    ])
    const ac = new AbortController()
    const sink = recordingSink()
    await runHarness({
      sessionId,
      assistantMessageId,
      backend,
      initialHistory: [],
      model: null,
      agentPageId: null,
      emailContext: null,
      ac,
      platform: testChatPlatform,
      sink,
      registry
    })
    const toolResultEv = sink.events.find((e) => e.type === 'tool_result') as
      | { type: 'tool_result'; status: string; errorMessage?: string }
      | undefined
    expect(toolResultEv?.status).toBe('error')
    expect(toolResultEv?.errorMessage).toMatch(/Unknown tool/)
    expect(getMessage(assistantMessageId)?.status).toBe('complete')
    expect(getMessage(assistantMessageId)?.content).toBe('Sorry, I cant.')
  })
})
