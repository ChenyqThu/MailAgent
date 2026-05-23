// Sprint 19 PR-1b — ToolRegistry contract tests.

import { describe, expect, test } from 'vitest'
import { createToolRegistry, type ToolDef, type ToolResult } from '../../../../src/electron/main/chat/tools/registry'

function makeTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: 'noop',
    description: 'returns the input as-is',
    inputSchema: { type: 'object', properties: {}, required: [] },
    confirmationTier: 'silent',
    category: 'read',
    surface: 'ipc',
    handler: async (input, _ctx): Promise<ToolResult> => ({
      ok: true,
      output: input,
      durationMs: 0
    }),
    ...overrides
  }
}

describe('ToolRegistry — register / get / list', () => {
  test('register + get round-trip', () => {
    const r = createToolRegistry()
    const def = makeTool({ name: 'email_search' })
    r.register(def)
    expect(r.get('email_search')).toBe(def)
  })

  test('get returns undefined for unknown name', () => {
    const r = createToolRegistry()
    expect(r.get('does_not_exist')).toBeUndefined()
  })

  test('duplicate name throws (loud at boot, not silent overwrite)', () => {
    const r = createToolRegistry()
    r.register(makeTool({ name: 'dup' }))
    expect(() => r.register(makeTool({ name: 'dup' }))).toThrow(/already registered/)
  })

  test('list preserves insertion order', () => {
    const r = createToolRegistry()
    r.register(makeTool({ name: 'a', category: 'read' }))
    r.register(makeTool({ name: 'b', category: 'read' }))
    r.register(makeTool({ name: 'c', category: 'write' }))
    expect(r.list().map((t) => t.name)).toEqual(['a', 'b', 'c'])
  })

  test('list filters by category', () => {
    const r = createToolRegistry()
    r.register(makeTool({ name: 'reader1', category: 'read' }))
    r.register(makeTool({ name: 'writer1', category: 'write' }))
    r.register(makeTool({ name: 'reader2', category: 'read' }))
    expect(r.list({ categories: ['read'] }).map((t) => t.name)).toEqual(['reader1', 'reader2'])
    expect(r.list({ categories: ['write'] }).map((t) => t.name)).toEqual(['writer1'])
    expect(r.list({ categories: ['read', 'write'] })).toHaveLength(3)
    expect(r.list({ categories: [] })).toHaveLength(3) // empty filter = all
  })

  test('names() returns registered names', () => {
    const r = createToolRegistry()
    r.register(makeTool({ name: 'a' }))
    r.register(makeTool({ name: 'b' }))
    expect(r.names()).toEqual(['a', 'b'])
  })

  test('__reset clears everything', () => {
    const r = createToolRegistry()
    r.register(makeTool({ name: 'a' }))
    expect(r.list()).toHaveLength(1)
    r.__reset()
    expect(r.list()).toHaveLength(0)
  })
})

describe('ToolRegistry — schema emission', () => {
  test('toAnthropicSchema shape matches Anthropic API contract', () => {
    const r = createToolRegistry()
    r.register(
      makeTool({
        name: 'email_search',
        description: 'Search emails',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q']
        }
      })
    )
    const schema = r.toAnthropicSchema()
    expect(schema).toEqual([
      {
        name: 'email_search',
        description: 'Search emails',
        input_schema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q']
        }
      }
    ])
  })

  test('toAnthropicSchema returns [] when empty (backend must strip the field — Anthropic rejects empty arrays)', () => {
    const r = createToolRegistry()
    expect(r.toAnthropicSchema()).toEqual([])
  })

  test('toOpenAISchema wraps as function-calling shape', () => {
    const r = createToolRegistry()
    r.register(
      makeTool({
        name: 'email_search',
        description: 'Search emails',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } }
        }
      })
    )
    const schema = r.toOpenAISchema()
    expect(schema).toEqual([
      {
        type: 'function',
        function: {
          name: 'email_search',
          description: 'Search emails',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } }
          }
        }
      }
    ])
  })

  test('schema emit honours category filter', () => {
    const r = createToolRegistry()
    r.register(makeTool({ name: 'r1', category: 'read' }))
    r.register(makeTool({ name: 'w1', category: 'write' }))
    expect(r.toAnthropicSchema({ categories: ['read'] })).toHaveLength(1)
    expect(r.toAnthropicSchema({ categories: ['read'] })[0]?.name).toBe('r1')
  })
})
