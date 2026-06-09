// task 06-08-chat Bug 2 — unit tests for the pure tool-call interleaving
// planner (planAssistantSegments). Keeps the time-ordering logic verifiable
// without rendering the heavy MessageList component (GSAP / Streamdown / IPC).
//
// The renderer maps the returned plan to elements 1:1, so asserting the plan
// is equivalent to asserting the rendered order ("text → chip → text …").

import { describe, expect, test } from 'vitest'

import { planAssistantSegments } from '../../src/shared/components/chat/tool_interleave'
import type { ChatToolCall } from '../../src/shared/api/types'

/** Minimal ChatToolCall factory — only id + content_offset matter to the
 *  planner; the rest are filler to satisfy the type. */
function call(id: number, contentOffset: number | null): ChatToolCall {
  return {
    id,
    message_id: 1,
    tool_use_id: `toolu_${id}`,
    tool_name: 'email_search',
    input_json: '{}',
    user_edited_input_json: null,
    output_json: null,
    status: 'ok',
    duration_ms: 1,
    confirmation_tier: 'silent',
    confirmed_at: null,
    content_offset: contentOffset,
    created_at: 0,
    updated_at: 0
  }
}

describe('planAssistantSegments — degrade (no offsets)', () => {
  test('no tool calls → single text segment, no trailing', () => {
    const { segments, trailing } = planAssistantSegments('hello world', [])
    expect(segments).toEqual([{ kind: 'text', text: 'hello world', isLast: true }])
    expect(trailing).toEqual([])
  })

  test('all chips null offset (pre-v5 rows) → body text + chips trailing below', () => {
    const calls = [call(1, null), call(2, null)]
    const { segments, trailing } = planAssistantSegments('legacy body', calls)
    // Body renders as one text segment; chips degrade to "below the body".
    expect(segments).toEqual([{ kind: 'text', text: 'legacy body', isLast: true }])
    expect(trailing.map((c) => c.id)).toEqual([1, 2])
  })
})

describe('planAssistantSegments — interleave', () => {
  test('single chip after some text → [text, chip, text]', () => {
    // 'Let me check. ' = 14 chars, then chip, then 'Done.'
    const content = 'Let me check. Done.'
    const { segments, trailing } = planAssistantSegments(content, [call(1, 14)])
    expect(trailing).toEqual([])
    expect(segments).toEqual([
      { kind: 'text', text: 'Let me check. ', isLast: false },
      { kind: 'chip', call: expect.objectContaining({ id: 1 }) },
      { kind: 'text', text: 'Done.', isLast: true }
    ])
  })

  test('chip at offset 0 → no leading empty text segment', () => {
    const { segments } = planAssistantSegments('after tool', [call(1, 0)])
    expect(segments).toEqual([
      { kind: 'chip', call: expect.objectContaining({ id: 1 }) },
      { kind: 'text', text: 'after tool', isLast: true }
    ])
  })

  test('chip at end (offset == content.length) → no trailing empty text', () => {
    const { segments } = planAssistantSegments('all text', [call(1, 8)])
    expect(segments).toEqual([
      { kind: 'text', text: 'all text', isLast: false },
      { kind: 'chip', call: expect.objectContaining({ id: 1 }) }
    ])
  })

  test('two chips at the same offset → no blank text between them', () => {
    // 'AB' (2) then chip 1 then chip 2 (both at offset 2) then 'CD'.
    const { segments } = planAssistantSegments('ABCD', [call(1, 2), call(2, 2)])
    expect(segments).toEqual([
      { kind: 'text', text: 'AB', isLast: false },
      { kind: 'chip', call: expect.objectContaining({ id: 1 }) },
      { kind: 'chip', call: expect.objectContaining({ id: 2 }) },
      { kind: 'text', text: 'CD', isLast: true }
    ])
  })

  test('multiple chips across the body interleave in order', () => {
    // 'AAAA'(4) chip1 'BB'(6) chip2 'CCC'(9) chip3 → matches the harness
    // multi-iter offsets test.
    const content = 'AAAABBCCC'
    const calls = [call(1, 4), call(2, 6), call(3, 9)]
    const { segments } = planAssistantSegments(content, calls)
    expect(segments).toEqual([
      { kind: 'text', text: 'AAAA', isLast: false },
      { kind: 'chip', call: expect.objectContaining({ id: 1 }) },
      { kind: 'text', text: 'BB', isLast: false },
      { kind: 'chip', call: expect.objectContaining({ id: 2 }) },
      { kind: 'text', text: 'CCC', isLast: false },
      { kind: 'chip', call: expect.objectContaining({ id: 3 }) }
    ])
  })

  test('positioned + null-offset chips coexist (mixed old/new) — null ones trail', () => {
    const content = 'AAAABB'
    const calls = [call(1, 4), call(2, null), call(3, 6)]
    const { segments, trailing } = planAssistantSegments(content, calls)
    expect(segments).toEqual([
      { kind: 'text', text: 'AAAA', isLast: false },
      { kind: 'chip', call: expect.objectContaining({ id: 1 }) },
      { kind: 'text', text: 'BB', isLast: false },
      { kind: 'chip', call: expect.objectContaining({ id: 3 }) }
    ])
    expect(trailing.map((c) => c.id)).toEqual([2])
  })
})

describe('planAssistantSegments — defensive clamping', () => {
  test('offset beyond content length is clamped to the end', () => {
    const { segments } = planAssistantSegments('short', [call(1, 999)])
    expect(segments).toEqual([
      { kind: 'text', text: 'short', isLast: false },
      { kind: 'chip', call: expect.objectContaining({ id: 1 }) }
    ])
  })

  test('a decreasing offset is clamped up to the running min (no negative slice)', () => {
    // chip1 at 4, chip2 at 2 (< 4) → chip2 clamped to 4 so no overlap/negative.
    const content = 'AAAABBBB'
    const calls = [call(1, 4), call(2, 2)]
    const { segments } = planAssistantSegments(content, calls)
    expect(segments).toEqual([
      { kind: 'text', text: 'AAAA', isLast: false },
      { kind: 'chip', call: expect.objectContaining({ id: 1 }) },
      { kind: 'chip', call: expect.objectContaining({ id: 2 }) },
      { kind: 'text', text: 'BBBB', isLast: true }
    ])
  })
})
