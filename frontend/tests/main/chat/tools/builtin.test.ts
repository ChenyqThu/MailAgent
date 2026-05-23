// Sprint 19 PR-1b — Builtin tool catalog smoke tests.
//
// Verifies static shape (names, schemas, tiers) without hitting the real
// sync_store.db. Actual handler execution is covered by integration tests
// in PR-1d once dispatcher + custom_api.ts + mail-sync DB fixture all align.

import { describe, expect, test } from 'vitest'
import { createToolRegistry } from '../../../../src/electron/main/chat/tools/registry'
import {
  allEmailTools,
  allAttachmentTools,
  registerBuiltinTools
} from '../../../../src/electron/main/chat/tools/builtin'

describe('builtin tool catalog — M1', () => {
  test('email tools: exactly 6 tools, all silent-tier read', () => {
    expect(allEmailTools).toHaveLength(6)
    for (const t of allEmailTools) {
      expect(t.category).toBe('read')
      expect(t.confirmationTier).toBe('silent')
      expect(t.surface).toBe('ipc')
    }
  })

  test('attachment tools: exactly 1 (M1 ships only attachment_list)', () => {
    expect(allAttachmentTools).toHaveLength(1)
    expect(allAttachmentTools[0]?.name).toBe('attachment_list')
  })

  test('all builtin names are stable + snake_case', () => {
    const names = [...allEmailTools, ...allAttachmentTools].map((t) => t.name)
    expect(names).toEqual([
      'email_search',
      'email_get',
      'email_body',
      'email_list_thread',
      'email_search_fulltext',
      'email_get_ai_fields',
      'attachment_list'
    ])
    for (const n of names) {
      expect(n).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  test('every tool has actionable LLM-facing description (≥ 30 chars)', () => {
    for (const t of [...allEmailTools, ...allAttachmentTools]) {
      expect(t.description.length).toBeGreaterThanOrEqual(30)
    }
  })

  test('every tool has type=object inputSchema with explicit required array', () => {
    for (const t of [...allEmailTools, ...allAttachmentTools]) {
      const s = t.inputSchema as { type?: string; required?: unknown }
      expect(s.type).toBe('object')
      expect(Array.isArray(s.required)).toBe(true)
    }
  })

  test('email_get / email_body / email_list_thread / email_get_ai_fields / attachment_list all require their primary id', () => {
    const tools = [...allEmailTools, ...allAttachmentTools]
    const requirements: Record<string, string[]> = {
      email_search: [], // optional filters
      email_get: ['internal_id'],
      email_body: ['internal_id'],
      email_list_thread: ['thread_id'],
      email_search_fulltext: ['query'],
      email_get_ai_fields: ['internal_id'],
      attachment_list: ['internal_id']
    }
    for (const t of tools) {
      const expected = requirements[t.name]
      const actual = (t.inputSchema as { required: string[] }).required
      expect(actual.sort()).toEqual(expected.sort())
    }
  })
})

describe('registerBuiltinTools — boot wiring', () => {
  test('registers all 7 M1 tools into a fresh registry', () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    expect(r.names().sort()).toEqual(
      [
        'attachment_list',
        'email_body',
        'email_get',
        'email_get_ai_fields',
        'email_list_thread',
        'email_search',
        'email_search_fulltext'
      ].sort()
    )
  })

  test('emits a clean Anthropic schema (every entry has name/description/input_schema)', () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    const schema = r.toAnthropicSchema()
    expect(schema).toHaveLength(7)
    for (const t of schema) {
      expect(t.name).toBeTruthy()
      expect(t.description).toBeTruthy()
      expect(t.input_schema).toBeTruthy()
    }
  })

  test('double-register throws (registry duplicate-name guard)', () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    expect(() => registerBuiltinTools(r)).toThrow(/already registered/)
  })
})
