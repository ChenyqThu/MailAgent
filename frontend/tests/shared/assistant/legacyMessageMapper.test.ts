// chat-panel P4 Phase 01 — legacyMessageMapper golden tests.
//
// Asserts the ChatMessage(+sidecar) → ThreadMessageLike mapping the assistant-ui
// ExternalStore adapter relies on. Each case mirrors a legacy ChatStreamEvent
// outcome already folded into ChatMessage state by useEmailChat:
//   chunk/done   → content     → assistant `text` part
//   thinking     → thinking    → assistant `reasoning` part
//   tool_use(+result) → toolSteps → assistant `tool-call` part (running / settled / error)
//   done / error → status      → assistant message status
// Pure module (no DOM) → runs in the default node env.

import { describe, expect, test } from 'vitest'

import {
  legacyMessageToThreadMessage,
  toAssistantStatus,
  type LegacyEnrichedMessage
} from '@shared/assistant/runtime/legacyMessageMapper'
import type { ChatMessage } from '@shared/api/types'
import type { ToolStepData } from '@shared/components/chat/tool_steps'

function fakeMessage(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    session_id: 10,
    role: 'assistant',
    content: '',
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over
  }
}

function fakeStep(over: Partial<ToolStepData>): ToolStepData {
  return {
    key: 'tool-1',
    toolName: 'email_search',
    inputJson: '{"query":"redis"}',
    outputJson: '{"hits":3}',
    status: 'ok',
    durationMs: 420,
    userEdited: false,
    ...over
  }
}

function enrich(over: Partial<LegacyEnrichedMessage>): LegacyEnrichedMessage {
  return { message: fakeMessage({}), toolSteps: [], isStreaming: false, ...over }
}

/** Narrow the (string | parts[]) content union to the parts array for assertions. */
function parts(content: ReturnType<typeof legacyMessageToThreadMessage>['content']) {
  if (typeof content === 'string') throw new Error('expected structured parts, got string')
  return content
}

describe('legacyMessageToThreadMessage — roles', () => {
  test('user row → user text bubble, NO status field', () => {
    const out = legacyMessageToThreadMessage(
      enrich({ message: fakeMessage({ id: 5, role: 'user', content: 'hi there' }) })
    )
    expect(out.role).toBe('user')
    expect(out.id).toBe('5')
    expect(parts(out.content)).toEqual([{ type: 'text', text: 'hi there' }])
    // status is assistant-only — fromThreadMessageLike throws otherwise.
    expect(out.status).toBeUndefined()
  })

  test('system row → system text bubble', () => {
    const out = legacyMessageToThreadMessage(
      enrich({ message: fakeMessage({ role: 'system', content: '已截断早期 3 条' }) })
    )
    expect(out.role).toBe('system')
    expect(parts(out.content)).toEqual([{ type: 'text', text: '已截断早期 3 条' }])
  })

  test('legacy standalone tool row → system note (not dropped)', () => {
    const out = legacyMessageToThreadMessage(
      enrich({ message: fakeMessage({ role: 'tool', content: '{"name":"x"}' }) })
    )
    expect(out.role).toBe('system')
    expect(parts(out.content)).toEqual([{ type: 'text', text: '{"name":"x"}' }])
  })
})

describe('legacyMessageToThreadMessage — assistant content', () => {
  test('text chunk → single text part + complete status', () => {
    const out = legacyMessageToThreadMessage(
      enrich({ message: fakeMessage({ content: 'Hello world', status: 'complete' }) })
    )
    expect(out.role).toBe('assistant')
    expect(parts(out.content)).toEqual([{ type: 'text', text: 'Hello world' }])
    expect(out.status).toEqual({ type: 'complete', reason: 'stop' })
  })

  test('thinking → reasoning part BEFORE the answer text (legacy order)', () => {
    const out = legacyMessageToThreadMessage(
      enrich({
        message: fakeMessage({ content: 'The answer.', thinking: 'Let me reason…' })
      })
    )
    expect(parts(out.content)).toEqual([
      { type: 'reasoning', text: 'Let me reason…' },
      { type: 'text', text: 'The answer.' }
    ])
  })

  test('whitespace-only thinking → no reasoning part', () => {
    const out = legacyMessageToThreadMessage(
      enrich({ message: fakeMessage({ content: 'A', thinking: '   \n  ' }) })
    )
    expect(parts(out.content)).toEqual([{ type: 'text', text: 'A' }])
  })

  test('empty streaming assistant → zero parts + running status', () => {
    const out = legacyMessageToThreadMessage(
      enrich({ message: fakeMessage({ content: '', status: 'streaming' }), isStreaming: true })
    )
    expect(parts(out.content)).toEqual([])
    expect(out.status).toEqual({ type: 'running' })
  })
})

describe('legacyMessageToThreadMessage — tool steps', () => {
  test('settled tool step → tool-call part with parsed args + result', () => {
    const out = legacyMessageToThreadMessage(
      enrich({
        message: fakeMessage({ content: 'Found 3.' }),
        toolSteps: [fakeStep({ key: 't-9', toolName: 'email_search' })]
      })
    )
    const [toolPart, textPart] = parts(out.content)
    expect(toolPart).toMatchObject({
      type: 'tool-call',
      toolCallId: 't-9',
      toolName: 'email_search',
      args: { query: 'redis' },
      argsText: '{"query":"redis"}',
      result: { hits: 3 },
      isError: false
    })
    // Order: tool group precedes the answer.
    expect(textPart).toEqual({ type: 'text', text: 'Found 3.' })
  })

  test('running tool step → tool-call part WITHOUT result (in-flight)', () => {
    const out = legacyMessageToThreadMessage(
      enrich({
        message: fakeMessage({ content: '', status: 'streaming' }),
        isStreaming: true,
        toolSteps: [fakeStep({ status: 'running', outputJson: null })]
      })
    )
    const [toolPart] = parts(out.content)
    expect(toolPart).toMatchObject({ type: 'tool-call', toolName: 'email_search' })
    expect('result' in (toolPart as object)).toBe(false)
    expect(out.status).toEqual({ type: 'running' })
  })

  test('error tool step → isError true', () => {
    const out = legacyMessageToThreadMessage(
      enrich({
        message: fakeMessage({ content: 'oops' }),
        toolSteps: [fakeStep({ status: 'error', outputJson: '"boom"' })]
      })
    )
    const [toolPart] = parts(out.content)
    expect(toolPart).toMatchObject({ type: 'tool-call', isError: true, result: 'boom' })
  })

  test('non-JSON tool input → args {} but argsText preserved', () => {
    const out = legacyMessageToThreadMessage(
      enrich({
        message: fakeMessage({ content: 'x' }),
        toolSteps: [fakeStep({ inputJson: 'not json', outputJson: null, status: 'running' })]
      })
    )
    const [toolPart] = parts(out.content)
    expect(toolPart).toMatchObject({ type: 'tool-call', args: {}, argsText: 'not json' })
  })
})

describe('toAssistantStatus', () => {
  test('streaming flag wins → running', () => {
    expect(toAssistantStatus('complete', true)).toEqual({ type: 'running' })
  })
  test('pending / streaming → running', () => {
    expect(toAssistantStatus('pending', false)).toEqual({ type: 'running' })
    expect(toAssistantStatus('streaming', false)).toEqual({ type: 'running' })
  })
  test('error → incomplete/error', () => {
    expect(toAssistantStatus('error', false)).toEqual({ type: 'incomplete', reason: 'error' })
  })
  test('aborted → incomplete/cancelled', () => {
    expect(toAssistantStatus('aborted', false)).toEqual({ type: 'incomplete', reason: 'cancelled' })
  })
  test('complete → complete/stop', () => {
    expect(toAssistantStatus('complete', false)).toEqual({ type: 'complete', reason: 'stop' })
  })
})
