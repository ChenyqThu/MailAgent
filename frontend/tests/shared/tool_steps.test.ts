// task 06-08-chat PR B — Cowork tool group normalization helpers.
//
// The AssistantBubble feeds two different shapes into a single ToolStepData:
//   - LiveToolCall  (renderer-memory, built from the harness stream)
//   - ChatToolCall  (persisted DB audit row, fetched post-done)
// `liveSteps` / `auditSteps` are the pure normalizers; this suite locks in the
// status/output/userEdited mapping and the JSON pretty-printing fallbacks so the
// two phases dovetail without a contract drift.

import { describe, expect, test } from 'vitest'

import { auditSteps, classifyTool, liveSteps, prettyJson } from '@shared/components/chat/tool_steps'
import type { LiveToolCall } from '@shared/hooks/useEmailChat'
import type { ChatToolCall } from '@shared/api/types'

function liveCall(over: Partial<LiveToolCall> = {}): LiveToolCall {
  return {
    toolUseId: 'tu_1',
    name: 'email_search',
    input: { query: 'redis' },
    status: 'running',
    durationMs: null,
    ...over
  }
}

function auditRow(over: Partial<ChatToolCall> = {}): ChatToolCall {
  return {
    id: 7,
    message_id: 101,
    tool_use_id: 'tu_7',
    tool_name: 'email_get_body',
    input_json: '{"internal_id":53675}',
    user_edited_input_json: null,
    output_json: '{"ok":true}',
    status: 'ok',
    duration_ms: 1234,
    confirmation_tier: 'silent',
    confirmed_at: null,
    content_offset: null,
    created_at: 0,
    updated_at: 0,
    ...over
  }
}

describe('liveSteps', () => {
  test('empty / undefined → []', () => {
    expect(liveSteps(undefined)).toEqual([])
    expect(liveSteps([])).toEqual([])
  })

  test('running call has no output and null duration', () => {
    const [s] = liveSteps([liveCall()])
    expect(s.key).toBe('tu_1')
    expect(s.toolName).toBe('email_search')
    expect(s.status).toBe('running')
    expect(s.outputJson).toBeNull()
    expect(s.durationMs).toBeNull()
    expect(s.userEdited).toBe(false)
    // input is pretty-printed (multi-line) JSON.
    expect(s.inputJson).toContain('"query"')
  })

  test('ok call surfaces pretty-printed output', () => {
    const [s] = liveSteps([liveCall({ status: 'ok', output: { hits: 3 }, durationMs: 42 })])
    expect(s.status).toBe('ok')
    expect(s.durationMs).toBe(42)
    expect(JSON.parse(s.outputJson as string)).toEqual({ hits: 3 })
  })

  test('error call prefers errorMessage over output for outputJson', () => {
    const [s] = liveSteps([
      liveCall({ status: 'error', errorMessage: 'boom', output: undefined, durationMs: 9 })
    ])
    expect(s.status).toBe('error')
    // errorMessage is a plain string → prettyJson returns it verbatim (not re-quoted).
    expect(s.outputJson).toBe('boom')
  })

  test('error call with neither errorMessage nor output → null output', () => {
    const [s] = liveSteps([liveCall({ status: 'error', durationMs: 9 })])
    expect(s.outputJson).toBeNull()
  })
})

describe('auditSteps', () => {
  test('maps persisted row fields through', () => {
    const [s] = auditSteps([auditRow()])
    expect(s.key).toBe('7')
    expect(s.toolName).toBe('email_get_body')
    expect(s.status).toBe('ok')
    expect(s.durationMs).toBe(1234)
    expect(s.userEdited).toBe(false)
    expect(JSON.parse(s.outputJson as string)).toEqual({ ok: true })
  })

  test('user-edited input wins and flags userEdited', () => {
    const [s] = auditSteps([auditRow({ user_edited_input_json: '{"internal_id":99999}' })])
    expect(s.userEdited).toBe(true)
    expect(JSON.parse(s.inputJson)).toEqual({ internal_id: 99999 })
  })

  test('null output_json stays null', () => {
    const [s] = auditSteps([auditRow({ output_json: null, status: 'running' })])
    expect(s.outputJson).toBeNull()
  })
})

describe('prettyJson', () => {
  test('re-pretty-prints a JSON string', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
  })

  test('non-JSON string passes through verbatim', () => {
    expect(prettyJson('not json')).toBe('not json')
  })

  test('object value is serialized', () => {
    expect(JSON.parse(prettyJson({ b: 2 }))).toEqual({ b: 2 })
  })
})

describe('classifyTool', () => {
  test.each([
    ['email_flag', 'write'],
    ['email_archive', 'write'],
    ['kos_save', 'link'],
    ['run_bash', 'cmd'],
    ['email_get_body', 'read'],
    ['extract_action_items', 'task'],
    ['email_search', 'search'],
    ['totally_unknown_tool', 'search']
  ])('%s → %s', (name, kind) => {
    expect(classifyTool(name)).toBe(kind)
  })
})
