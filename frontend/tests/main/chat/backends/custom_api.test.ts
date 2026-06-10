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
import { __testing } from '../../../../src/shared/chat/backends/custom_api'
import type { ChatStreamEvent, ChatStreamRequest } from '../../../../src/shared/chat/types'
import type { ChatModelConfig } from '../../../../src/shared/chat/platform'

const {
  buildSystemBlocks,
  buildSystemPrompt,
  buildStableSystemPrompt,
  decorateToolsWithCacheControl,
  createStreamState,
  processAnthropicEvent,
  modelSupportsManualThinking,
  buildAnthropicRequestBody
} = __testing

// 3b-1：buildSystemBlocks/buildSystemPrompt 下沉 shared 后接 cfg + getCachedSenderDigest
// 参数（取代直读 env + main 的 sender_digest_cache）。测试用 mock cfg + getDigest 注入 ——
// L1 注入逻辑（flag gate + digest 截断）在此层验，cache miss/null-entry 的差异已下沉到
// sender_digest_cache 自己的测试（本层只看 digest: string | null）。
function cfg(opts?: Partial<ChatModelConfig>): ChatModelConfig {
  return {
    defaultModel: 'claude-sonnet-4-6',
    kosConsumerEnabled: false,
    kosL1HotBlockEnabled: false,
    userContext: null,
    ...opts
  }
}
const noDigest = (): string | null => null

describe('buildSystemBlocks — cache_control breakpoint', () => {
  test('null ctx → single stable block with cache_control:ephemeral', () => {
    const blocks = buildSystemBlocks(null, cfg(), noDigest)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[0]?.text.length).toBeGreaterThan(0)
  })

  test('PR-2f: splits into [stable, ctx] blocks; cache_control only on stable', () => {
    const blocks = buildSystemBlocks(
      {
        internalId: 42,
        subject: 'Q3 OKR review',
        senderName: 'Bob',
        senderAddr: 'bob@acme.com',
        dateIso: '2026-05-22T10:00:00Z',
        bodyMarkdown: 'Hello world',
        notionPageId: null
      },
      cfg(),
      noDigest
    )
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
    expect(typeof buildSystemPrompt(null, cfg(), noDigest)).toBe('string')
    // 含 ctx 时 legacy form 把 stable + ctx 拼一起
    const combined = buildSystemPrompt(
      {
        internalId: 1,
        subject: 'merged',
        senderName: null,
        senderAddr: null,
        dateIso: null,
        bodyMarkdown: 'body',
        notionPageId: null
      },
      cfg(),
      noDigest
    )
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

  test('flag OFF → no L1 even if digest available', () => {
    const blocks = buildSystemBlocks(ctx, cfg({ kosL1HotBlockEnabled: false }), () => 'CTO at Acme')
    expect(blocks[0]?.text).not.toContain('KOS sender digest')
    expect(blocks[0]?.text).not.toContain('CTO at Acme')
  })

  test('flag ON + digest hit → injects L1 hot block into stable prefix', () => {
    const blocks = buildSystemBlocks(
      ctx,
      cfg({ kosL1HotBlockEnabled: true }),
      () => 'CTO at Acme since 2024'
    )
    expect(blocks[0]?.text).toContain('--- KOS sender digest ---')
    expect(blocks[0]?.text).toContain('sender: bob@acme.com')
    expect(blocks[0]?.text).toContain('CTO at Acme since 2024')
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[1]?.text).toContain('hello')
  })

  test('flag ON + digest null (cache miss / KOS no hits) → no L1 (graceful)', () => {
    const blocks = buildSystemBlocks(ctx, cfg({ kosL1HotBlockEnabled: true }), () => null)
    expect(blocks[0]?.text).not.toContain('KOS sender digest')
  })

  test('flag ON + huge digest truncated to ≤ 4000 chars + (truncated) marker', () => {
    const big = 'x'.repeat(8000)
    const blocks = buildSystemBlocks(ctx, cfg({ kosL1HotBlockEnabled: true }), () => big)
    expect(blocks[0]?.text).toContain('--- KOS sender digest ---')
    expect(blocks[0]?.text).toContain('... (truncated)')
  })

  test('kosConsumerEnabled gates the KOS guidance block in the stable prefix', () => {
    // 3b-1：buildKosGuidanceBlock 由 cfg.kosConsumerEnabled 控（取代旧 isKosConsumerEnabled()）。
    const on = buildSystemBlocks(null, cfg({ kosConsumerEnabled: true }), noDigest)
    expect(on[0]?.text).toContain('KOS knowledge brain')
    const off = buildSystemBlocks(null, cfg({ kosConsumerEnabled: false }), noDigest)
    expect(off[0]?.text).not.toContain('KOS knowledge brain')
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
    const tools = [{ name: 'a', description: 'tool a', input_schema: { type: 'object' } }]
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
  function feed(events: unknown[]): {
    state: ReturnType<typeof createStreamState>
    emitted: ChatStreamEvent[]
  } {
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
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"sub' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'ject_contains":"' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'q3"}' }
      },
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
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":"a"}' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"id":42}' }
      },
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
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Let me check. ' }
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'email_search' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{}' }
      },
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
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{not valid json' }
      },
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

// ============================================================
// task 06-08-chat 需求 5 — extended-thinking SSE parse
// ============================================================
describe('processAnthropicEvent — extended-thinking (task 06-08-chat 需求 5)', () => {
  function feed(events: unknown[]): {
    state: ReturnType<typeof createStreamState>
    emitted: ChatStreamEvent[]
  } {
    const state = createStreamState('claude-sonnet-4-6')
    const emitted: ChatStreamEvent[] = []
    for (const e of events) {
      emitted.push(...processAnthropicEvent(e, state))
    }
    return { state, emitted }
  }

  test('thinking_delta accumulates into state + emits ThinkingEvent per delta', () => {
    const { emitted, state } = feed([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me ' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'think about it.' }
      }
    ])
    expect(emitted).toEqual([
      { type: 'thinking', delta: 'Let me ' },
      { type: 'thinking', delta: 'think about it.' }
    ])
    expect(state.thinkingAccumulated).toBe('Let me think about it.')
    // 第二波 Bug A — structured block in flight (text accumulated, not yet finalized).
    expect(state.currentThinking?.thinking).toBe('Let me think about it.')
  })

  test('signature_delta is captured on the current block but NOT emitted', () => {
    const { emitted, state } = feed([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM==' }
      }
    ])
    // only the thinking_delta surfaced; signature stored on the current block.
    expect(emitted).toEqual([{ type: 'thinking', delta: 'hmm' }])
    expect(state.currentThinking?.signature).toBe('EqQBCgIYAhIM==')
  })

  // ── 第二波 Bug A (方案 B) — structured thinking block collection for passback ──
  test('full thinking block (start → thinking → signature → stop) collected with byte-exact signature', () => {
    const { state } = feed([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'I should ' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'flag it.' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIMabc==' }
      },
      { type: 'content_block_stop', index: 0 }
    ])
    // finalized into completedThinkingBlocks; currentThinking cleared.
    expect(state.currentThinking).toBeNull()
    expect(state.completedThinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'I should flag it.', signature: 'EqQBCgIYAhIMabc==' }
    ])
  })

  test('thinking block then tool_use: thinking collected + tool_use emitted (方案 B coexist)', () => {
    const { emitted, state } = feed([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'flag this' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'SIG==' }
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_f', name: 'email_flag' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"isFlagged":false}' }
      },
      { type: 'content_block_stop', index: 1 }
    ])
    // thinking events surfaced live; tool_use emitted (real call, not hallucinated text).
    expect(emitted).toEqual([
      { type: 'thinking', delta: 'flag this' },
      { type: 'tool_use', toolUseId: 'toolu_f', name: 'email_flag', input: { isFlagged: false } }
    ])
    expect(state.completedThinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'flag this', signature: 'SIG==' }
    ])
  })

  test('redacted_thinking block collected directly at content_block_start (no deltas)', () => {
    const { emitted, state } = feed([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'ENCRYPTED_BLOB==' }
      },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer.' } }
    ])
    expect(emitted).toEqual([{ type: 'chunk', delta: 'Answer.' }])
    expect(state.completedThinkingBlocks).toEqual([
      { type: 'redacted_thinking', data: 'ENCRYPTED_BLOB==' }
    ])
  })

  test('two thinking blocks in SSE order are both collected in order', () => {
    const { state } = feed([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'first' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'S1' }
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'second' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'S2' }
      },
      { type: 'content_block_stop', index: 1 }
    ])
    expect(state.completedThinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'first', signature: 'S1' },
      { type: 'thinking', thinking: 'second', signature: 'S2' }
    ])
  })

  test('thinking block then text block: thinking events precede chunk events', () => {
    const { emitted } = feed([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'reason ' }
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer.' } }
    ])
    expect(emitted).toEqual([
      { type: 'thinking', delta: 'reason ' },
      { type: 'chunk', delta: 'Answer.' }
    ])
  })

  test('thinking off (no thinking blocks) → text-only stream unchanged + thinking state empty', () => {
    const { emitted, state } = feed([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }
    ])
    expect(emitted).toEqual([{ type: 'chunk', delta: 'Hi' }])
    expect(state.thinkingAccumulated).toBe('')
    expect(state.currentThinking).toBeNull()
    expect(state.completedThinkingBlocks).toEqual([])
  })
})

// ============================================================
// task 06-08-chat 需求 5 — request-body thinking matrix (model-aware)
// ============================================================
describe('modelSupportsManualThinking — model matrix (research §1.1)', () => {
  test('sonnet-4-6 (project default) supports manual budget_tokens', () => {
    expect(modelSupportsManualThinking('claude-sonnet-4-6')).toBe(true)
  })
  test('opus-4-7 / opus-4-8 require adaptive (manual budget_tokens → 400)', () => {
    expect(modelSupportsManualThinking('claude-opus-4-7')).toBe(false)
    expect(modelSupportsManualThinking('claude-opus-4-8')).toBe(false)
  })
  test('fable-5 requires adaptive (same surface as opus-4-7/4-8)', () => {
    expect(modelSupportsManualThinking('claude-fable-5')).toBe(false)
  })
  test('claude: prefix opus variant also requires adaptive', () => {
    expect(modelSupportsManualThinking('claude:opus-4-8')).toBe(false)
  })
  test('unknown / other Claude 4 falls to manual (sonnet-style default)', () => {
    expect(modelSupportsManualThinking('claude-opus-4-6')).toBe(true)
    expect(modelSupportsManualThinking('claude-sonnet-4-5')).toBe(true)
  })
})

describe('buildAnthropicRequestBody — thinking toggle (task 06-08-chat 需求 5)', () => {
  const systemBlocks = [{ type: 'text' as const, text: 'sys' }]
  const messages = [{ role: 'user' as const, content: 'hi' }]
  const tools = [
    { name: 'email_search', description: 'd', input_schema: { type: 'object' as const } }
  ]
  // minimal ChatStreamRequest — buildAnthropicRequestBody only reads `thinking`.
  function req(thinking?: { enabled: boolean }): ChatStreamRequest {
    return {
      history: [],
      model: null,
      agentPageId: null,
      emailContext: null,
      signal: new AbortController().signal,
      thinking
    }
  }

  test('thinking off → no thinking param + tools passed through (legacy body)', () => {
    const body = buildAnthropicRequestBody(
      req(undefined),
      'claude-sonnet-4-6',
      systemBlocks,
      messages,
      tools
    )
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
    expect(body.tools).toEqual(tools)
    expect(body.max_tokens).toBe(64000)
  })

  test('thinking on + sonnet → manual {enabled, budget_tokens} (budget < max_tokens) + tools KEPT (第二波 方案 B)', () => {
    const body = buildAnthropicRequestBody(
      req({ enabled: true }),
      'claude-sonnet-4-6',
      systemBlocks,
      messages,
      tools
    )
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 })
    expect(body.output_config).toBeUndefined()
    // 第二波 Bug A (方案 B): thinking on now KEEPS tools (was dropped in MVP方案 A —
    // dropping caused the model to hallucinate <tool_call> text instead of real
    // tool_use blocks → writes never ran). thinking + tool use now coexist.
    expect(body.tools).toEqual(tools)
    expect((body.thinking as { budget_tokens: number }).budget_tokens).toBeLessThan(
      body.max_tokens as number
    )
  })

  test('thinking on + opus-4-8 → adaptive + output_config.effort (manual would 400) + tools KEPT (方案 B)', () => {
    const body = buildAnthropicRequestBody(
      req({ enabled: true }),
      'claude-opus-4-8',
      systemBlocks,
      messages,
      tools
    )
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.tools).toEqual(tools)
  })

  test('thinking on + no tools registered → no tools field (Anthropic rejects tools:[])', () => {
    const body = buildAnthropicRequestBody(
      req({ enabled: true }),
      'claude-sonnet-4-6',
      systemBlocks,
      messages,
      undefined
    )
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 })
    expect(body.tools).toBeUndefined()
  })

  test('thinking enabled:false → treated as off (legacy body, tools kept)', () => {
    const body = buildAnthropicRequestBody(
      req({ enabled: false }),
      'claude-sonnet-4-6',
      systemBlocks,
      messages,
      tools
    )
    expect(body.thinking).toBeUndefined()
    expect(body.tools).toEqual(tools)
  })
})

// ============================================================
// task 06-08-chat 第二波 Bug B — user-context injection (custom-api only)
// ============================================================
describe('buildStableSystemPrompt — userContext injection (第二波 Bug B)', () => {
  const CONTEXT = '# Lucien\nRole: ENBU R&D\nSender Priority: boss@acme.com → Critical'

  test('userContext null → not injected (static header unchanged)', () => {
    const text = buildStableSystemPrompt(null, cfg({ userContext: null }), noDigest)
    expect(text).toContain('You are the AI assistant inside MailAgent')
    expect(text).not.toContain('# Reference context')
    expect(text).not.toContain('Lucien')
  })

  test('userContext "" (empty) → not injected', () => {
    const text = buildStableSystemPrompt(null, cfg({ userContext: '' }), noDigest)
    expect(text).not.toContain('# Reference context')
  })

  test('userContext present → injected with the silent-read header (mirrors processor.py format)', () => {
    const text = buildStableSystemPrompt(null, cfg({ userContext: CONTEXT }), noDigest)
    expect(text).toContain('# Reference context (user profile / Sender Priority / focus projects)')
    expect(text).toContain('# Read silently; never echo back.')
    expect(text).toContain('Lucien')
    expect(text).toContain('Sender Priority: boss@acme.com → Critical')
    // injected AFTER the static header (header → context order).
    expect(text.indexOf('You are the AI assistant')).toBeLessThan(
      text.indexOf('# Reference context')
    )
  })

  test('userContext appears in the stable (cacheable) block from buildSystemBlocks', () => {
    const blocks = buildSystemBlocks(null, cfg({ userContext: CONTEXT }), noDigest)
    expect(blocks[0]?.text).toContain('# Reference context')
    expect(blocks[0]?.text).toContain('Lucien')
    // stable block carries cache_control (context is static per session → cacheable).
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('userContext + KOS guidance coexist in the stable prefix', () => {
    const text = buildStableSystemPrompt(
      null,
      cfg({ userContext: CONTEXT, kosConsumerEnabled: true }),
      noDigest
    )
    expect(text).toContain('# Reference context')
    expect(text).toContain('KOS knowledge brain')
  })
})
