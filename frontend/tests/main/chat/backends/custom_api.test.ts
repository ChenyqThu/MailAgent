// Sprint 19 PR-1c — Anthropic SSE state machine + cache_control breakpoint
// + tool_use accumulator. Drives processAnthropicEvent against fixture-style
// Anthropic stream blocks (no fetch, no network).
//
// What's NOT covered here (deferred to PR-1d integration test):
//   - End-to-end: a real fetch round-trip with a mock /v1/messages server.
//   - Multi-turn harness loop (lives in dispatcher, not the backend).
// The state machine is pure mutation on a struct, so unit fixtures cover
// the protocol surface cleanly.

import { describe, expect, test } from 'vitest'
import { __testing } from '../../../../src/electron/main/chat/backends/custom_api'
import type { ChatStreamEvent } from '../../../../src/shared/chat/types'
import {
  __resetCacheForTests as resetSenderDigestCache,
  __setCacheClientForTests as setSenderDigestClient,
  prefetchSenderDigest
} from '../../../../src/electron/main/kos/sender_digest_cache'
import type { KOSClient } from '../../../../src/electron/main/kos/client'

const {
  buildSystemBlocks,
  buildSystemPrompt,
  decorateToolsWithCacheControl,
  createStreamState,
  processAnthropicEvent
} = __testing

describe('buildSystemBlocks — cache_control breakpoint', () => {
  test('null ctx → single stable block with cache_control:ephemeral', () => {
    const blocks = buildSystemBlocks(null)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[0]?.text.length).toBeGreaterThan(0)
  })

  test('PR-2f: splits into [stable, ctx] blocks; cache_control only on stable', () => {
    const blocks = buildSystemBlocks({
      internalId: 42,
      subject: 'Q3 OKR review',
      senderName: 'Bob',
      senderAddr: 'bob@acme.com',
      dateIso: '2026-05-22T10:00:00Z',
      bodyMarkdown: 'Hello world',
      notionPageId: null
    })
    expect(blocks).toHaveLength(2)
    // Block 1: stable prefix (STATIC header) with cache_control
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[0]?.text).toContain('You are the AI assistant inside MailAgent')
    expect(blocks[0]?.text).not.toContain('Q3 OKR review') // ctx not in stable
    // Block 2: session-specific email context; NO cache_control
    expect(blocks[1]?.cache_control).toBeUndefined()
    expect(blocks[1]?.text).toContain('Q3 OKR review')
    expect(blocks[1]?.text).toContain('Bob')
    expect(blocks[1]?.text).toContain('bob@acme.com')
    expect(blocks[1]?.text).toContain('Hello world')
  })

  test('buildSystemPrompt stays available for non-blocks consumers (legacy combined form)', () => {
    expect(typeof buildSystemPrompt(null)).toBe('string')
    // 含 ctx 时 legacy form 把 stable + ctx 拼一起
    const combined = buildSystemPrompt({
      internalId: 1,
      subject: 'merged',
      senderName: null,
      senderAddr: null,
      dateIso: null,
      bodyMarkdown: 'body',
      notionPageId: null
    })
    expect(combined).toContain('You are the AI assistant')
    expect(combined).toContain('merged')
    expect(combined).toContain('body')
  })
})

// ============================================================
// PR-2f — L1 hot block KOS digest injection
// ============================================================
describe('buildSystemBlocks — PR-2f L1 hot block', () => {
  const ctx = {
    internalId: 7,
    subject: 'hello',
    senderName: 'Bob',
    senderAddr: 'bob@acme.com',
    dateIso: '2026-05-22T10:00:00Z',
    bodyMarkdown: 'body',
    notionPageId: null
  }

  function fakeClient(
    query: (q: string, opts?: { limit?: number; expand?: boolean }) => Promise<unknown[]>,
    configured: boolean = true
  ): KOSClient {
    return { query, configured } as unknown as KOSClient
  }

  test('flag OFF → no L1 even if cache has digest', async () => {
    delete process.env.MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED
    resetSenderDigestCache()
    setSenderDigestClient(
      fakeClient(async () => [
        { slug: 'people/bob-acme-com', chunk_text: 'CTO at Acme', score: 0.9 }
      ])
    )
    await prefetchSenderDigest('bob@acme.com')

    const blocks = buildSystemBlocks(ctx)
    expect(blocks[0]?.text).not.toContain('KOS sender digest')
    expect(blocks[0]?.text).not.toContain('CTO at Acme')
    setSenderDigestClient(null)
  })

  test('flag ON + cache hit → injects L1 hot block into stable prefix', async () => {
    process.env.MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED = 'true'
    resetSenderDigestCache()
    setSenderDigestClient(
      fakeClient(async () => [
        { slug: 'people/bob-acme-com', chunk_text: 'CTO at Acme since 2024', score: 0.95 }
      ])
    )
    await prefetchSenderDigest('bob@acme.com')

    const blocks = buildSystemBlocks(ctx)
    expect(blocks[0]?.text).toContain('--- KOS sender digest ---')
    expect(blocks[0]?.text).toContain('sender: bob@acme.com')
    expect(blocks[0]?.text).toContain('CTO at Acme since 2024')
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[1]?.text).toContain('hello')
    delete process.env.MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED
    setSenderDigestClient(null)
  })

  test('flag ON + cache miss → no L1 (graceful no-injection)', () => {
    process.env.MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED = 'true'
    resetSenderDigestCache()

    const blocks = buildSystemBlocks(ctx)
    expect(blocks[0]?.text).not.toContain('KOS sender digest')
    delete process.env.MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED
  })

  test('flag ON + cache null entry (KOS returned no hits) → no L1', async () => {
    process.env.MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED = 'true'
    resetSenderDigestCache()
    setSenderDigestClient(fakeClient(async () => []))
    await prefetchSenderDigest('bob@acme.com')

    const blocks = buildSystemBlocks(ctx)
    expect(blocks[0]?.text).not.toContain('KOS sender digest')
    delete process.env.MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED
    setSenderDigestClient(null)
  })

  test('flag ON + huge digest truncated to ≤ 4000 chars + (truncated) marker', async () => {
    process.env.MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED = 'true'
    resetSenderDigestCache()
    const big = 'x'.repeat(8000)
    setSenderDigestClient(
      fakeClient(async () => [{ slug: 'people/x', chunk_text: big, score: 0.9 }])
    )
    await prefetchSenderDigest('bob@acme.com')

    const blocks = buildSystemBlocks(ctx)
    expect(blocks[0]?.text).toContain('--- KOS sender digest ---')
    expect(blocks[0]?.text).toContain('... (truncated)')
    delete process.env.MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED
    setSenderDigestClient(null)
  })
})

describe('decorateToolsWithCacheControl', () => {
  test('returns undefined when tools array is missing or empty', () => {
    expect(decorateToolsWithCacheControl(undefined)).toBeUndefined()
    expect(decorateToolsWithCacheControl([])).toBeUndefined()
  })

  test('only the LAST tool gets cache_control (covers the entire tools prefix)', () => {
    const tools = [
      { name: 'a', description: 'tool a', input_schema: { type: 'object' } },
      { name: 'b', description: 'tool b', input_schema: { type: 'object' } },
      { name: 'c', description: 'tool c', input_schema: { type: 'object' } }
    ]
    const out = decorateToolsWithCacheControl(tools)!
    expect(out).toHaveLength(3)
    expect((out[0] as { cache_control?: unknown }).cache_control).toBeUndefined()
    expect((out[1] as { cache_control?: unknown }).cache_control).toBeUndefined()
    expect((out[2] as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral' })
  })

  test('does not mutate the caller-provided tools array (defensive copy)', () => {
    const tools = [
      { name: 'a', description: 'tool a', input_schema: { type: 'object' } }
    ]
    decorateToolsWithCacheControl(tools)
    expect((tools[0] as { cache_control?: unknown }).cache_control).toBeUndefined()
  })
})

describe('processAnthropicEvent — text streaming (legacy path unchanged)', () => {
  test('message_start populates input_tokens + model', () => {
    const state = createStreamState('claude-sonnet-4-6')
    processAnthropicEvent(
      {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4-6-2026-05-01',
          usage: { input_tokens: 123 }
        }
      },
      state
    )
    expect(state.inputTokens).toBe(123)
    expect(state.modelSeen).toBe('claude-sonnet-4-6-2026-05-01')
  })

  test('text_delta yields chunk events + accumulates body', () => {
    const state = createStreamState('claude-sonnet-4-6')
    const a = processAnthropicEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
      state
    )
    const b = processAnthropicEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
      state
    )
    expect(a).toEqual([{ type: 'chunk', delta: 'Hello ' }])
    expect(b).toEqual([{ type: 'chunk', delta: 'world' }])
    expect(state.accumulated).toBe('Hello world')
  })

  test('message_delta with output_tokens + stop_reason updates state', () => {
    const state = createStreamState('claude-sonnet-4-6')
    processAnthropicEvent(
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 256 }
      },
      state
    )
    expect(state.outputTokens).toBe(256)
    expect(state.messageStopReason).toBe('end_turn')
  })

  test('error event sets sawError + emits error ChatStreamEvent', () => {
    const state = createStreamState('claude-sonnet-4-6')
    const out = processAnthropicEvent(
      { type: 'error', error: { type: 'rate_limit_error', message: 'too many' } },
      state
    )
    expect(state.sawError).toBe(true)
    expect(out).toEqual([{ type: 'error', code: 'rate_limit_error', message: 'too many' }])
  })

  test('unknown event type silently no-ops (forward-compat)', () => {
    const state = createStreamState(null)
    const out = processAnthropicEvent({ type: 'future_event_we_dont_know' }, state)
    expect(out).toEqual([])
    expect(state.sawError).toBe(false)
  })

  test('legacy [DONE] sentinel tolerated', () => {
    const state = createStreamState(null)
    const out = processAnthropicEvent({ __done: true }, state)
    expect(out).toEqual([])
  })
})

describe('processAnthropicEvent — tool_use accumulation (Sprint 19)', () => {
  function feed(events: unknown[]): { state: ReturnType<typeof createStreamState>; emitted: ChatStreamEvent[] } {
    const state = createStreamState('claude-sonnet-4-6')
    const emitted: ChatStreamEvent[] = []
    for (const e of events) {
      emitted.push(...processAnthropicEvent(e, state))
    }
    return { state, emitted }
  }

  test('single tool_use round-trip: start → delta+ → stop emits ToolUseEvent with parsed input', () => {
    const { emitted, state } = feed([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01abc', name: 'email_search' }
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"sub' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ject_contains":"' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'q3"}' } },
      { type: 'content_block_stop', index: 0 }
    ])
    expect(emitted).toEqual([
      {
        type: 'tool_use',
        toolUseId: 'toolu_01abc',
        name: 'email_search',
        input: { subject_contains: 'q3' }
      }
    ])
    expect(state.pendingToolBlocks.size).toBe(0)
  })

  test('tool_use with empty input ({} when no delta arrived)', () => {
    const { emitted } = feed([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_x', name: 'list_mailboxes' }
      },
      { type: 'content_block_stop', index: 0 }
    ])
    expect(emitted).toHaveLength(1)
    if (emitted[0]?.type === 'tool_use') {
      expect(emitted[0].input).toEqual({})
    }
  })

  test('two parallel tool_use blocks at different indices stay partitioned', () => {
    const { emitted } = feed([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'email_search' }
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_b', name: 'email_get' }
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"a"}' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"id":42}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_stop', index: 1 }
    ])
    const toolUses = emitted.filter((e) => e.type === 'tool_use')
    expect(toolUses).toHaveLength(2)
    if (toolUses[0]?.type === 'tool_use' && toolUses[1]?.type === 'tool_use') {
      expect(toolUses[0].toolUseId).toBe('toolu_a')
      expect(toolUses[0].input).toEqual({ q: 'a' })
      expect(toolUses[1].toolUseId).toBe('toolu_b')
      expect(toolUses[1].input).toEqual({ id: 42 })
    }
  })

  test('text_delta and tool_use can interleave in the same turn', () => {
    const { emitted, state } = feed([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check. ' } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'email_search' }
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 }
    ])
    expect(emitted[0]).toEqual({ type: 'chunk', delta: 'Let me check. ' })
    expect(emitted[emitted.length - 1]?.type).toBe('tool_use')
    expect(state.accumulated).toBe('Let me check. ')
  })

  test('broken JSON in tool input surfaces __parse_error envelope (so LLM can self-correct)', () => {
    const { emitted } = feed([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_bad', name: 'email_search' }
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{not valid json' } },
      { type: 'content_block_stop', index: 0 }
    ])
    expect(emitted).toHaveLength(1)
    if (emitted[0]?.type === 'tool_use') {
      const input = emitted[0].input as { __parse_error?: string; __raw?: string }
      expect(input.__parse_error).toBeTruthy()
      expect(input.__raw).toBe('{not valid json')
    }
  })

  test('content_block_stop for an unknown index is a no-op (text blocks)', () => {
    const { emitted } = feed([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_stop', index: 0 }
    ])
    expect(emitted).toEqual([])
  })
})

describe('processAnthropicEvent — stop_reason captured for harness loop', () => {
  test('stop_reason=tool_use lands in state (harness uses this to decide "iter again")', () => {
    const state = createStreamState(null)
    processAnthropicEvent(
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      state
    )
    expect(state.messageStopReason).toBe('tool_use')
  })

  test('stop_reason=end_turn lands in state (harness terminates)', () => {
    const state = createStreamState(null)
    processAnthropicEvent(
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
      state
    )
    expect(state.messageStopReason).toBe('end_turn')
  })

  test('stop_reason=max_tokens propagated (caller can detect truncation)', () => {
    const state = createStreamState(null)
    processAnthropicEvent({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, state)
    expect(state.messageStopReason).toBe('max_tokens')
  })

  test('unknown stop_reason ignored (state stays null, generator defaults to end_turn)', () => {
    const state = createStreamState(null)
    processAnthropicEvent({ type: 'message_delta', delta: { stop_reason: 'future_reason' } }, state)
    expect(state.messageStopReason).toBeNull()
  })
})
