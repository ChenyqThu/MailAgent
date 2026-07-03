// task 06-08-chat PR B → S3 W2 — tool classification + JSON pretty-printer.
//
// The legacy step normalizers (liveSteps / auditSteps) were deleted with the
// legacy MessageList + ExternalStore adapter; what survives is classifyTool +
// prettyJson, consumed by the assistant-ui ToolTraceCard.

import { describe, expect, test } from 'vitest'

import { classifyTool, prettyJson } from '@shared/components/chat/tool_steps'

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
