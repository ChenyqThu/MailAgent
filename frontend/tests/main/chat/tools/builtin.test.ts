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
  allWriteTools,
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

  test('write tools: exactly 3 (email_flag / email_archive / email_draft_reply)', () => {
    expect(allWriteTools).toHaveLength(3)
    const writeNames = allWriteTools.map((t) => t.name).sort()
    expect(writeNames).toEqual(['email_archive', 'email_draft_reply', 'email_flag'])
    for (const t of allWriteTools) {
      expect(t.category).toBe('write')
      expect(t.surface).toBe('ipc')
      // tier is preview / edit (never silent for writes)
      expect(['preview', 'edit']).toContain(t.confirmationTier)
    }
  })

  test('email_draft_reply specifically uses tier=edit (user MAY change body before draft creation)', () => {
    const draft = allWriteTools.find((t) => t.name === 'email_draft_reply')
    expect(draft?.confirmationTier).toBe('edit')
  })

  test('email_flag / email_archive use tier=preview (reversible, no edit needed)', () => {
    expect(allWriteTools.find((t) => t.name === 'email_flag')?.confirmationTier).toBe('preview')
    expect(allWriteTools.find((t) => t.name === 'email_archive')?.confirmationTier).toBe('preview')
  })

  test('all builtin names are stable + snake_case', () => {
    const names = [...allEmailTools, ...allAttachmentTools, ...allWriteTools].map((t) => t.name)
    expect(names.sort()).toEqual(
      [
        'attachment_list',
        'email_archive',
        'email_body',
        'email_draft_reply',
        'email_flag',
        'email_get',
        'email_get_ai_fields',
        'email_list_thread',
        'email_search',
        'email_search_fulltext'
      ].sort()
    )
    for (const n of names) {
      expect(n).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  test('every tool has actionable LLM-facing description (≥ 30 chars)', () => {
    for (const t of [...allEmailTools, ...allAttachmentTools, ...allWriteTools]) {
      expect(t.description.length).toBeGreaterThanOrEqual(30)
    }
  })

  test('every tool has type=object inputSchema with explicit required array', () => {
    for (const t of [...allEmailTools, ...allAttachmentTools, ...allWriteTools]) {
      const s = t.inputSchema as { type?: string; required?: unknown }
      expect(s.type).toBe('object')
      expect(Array.isArray(s.required)).toBe(true)
    }
  })

  test('each tool requires its primary id (internal_id / thread_id / query)', () => {
    const tools = [...allEmailTools, ...allAttachmentTools, ...allWriteTools]
    const requirements: Record<string, string[]> = {
      email_search: [], // optional filters
      email_get: ['internal_id'],
      email_body: ['internal_id'],
      email_list_thread: ['thread_id'],
      email_search_fulltext: ['query'],
      email_get_ai_fields: ['internal_id'],
      attachment_list: ['internal_id'],
      // write tools require internal_id + (for draft) body_markdown.
      email_flag: ['internal_id'],
      email_archive: ['internal_id'],
      email_draft_reply: ['internal_id', 'body_markdown']
    }
    for (const t of tools) {
      const expected = requirements[t.name]
      const actual = (t.inputSchema as { required: string[] }).required
      expect(actual.sort()).toEqual(expected.sort())
    }
  })
})

describe('registerBuiltinTools — boot wiring', () => {
  test('registers all 10 M1 tools into a fresh registry (7 read + 3 write)', () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    expect(r.names().sort()).toEqual(
      [
        'attachment_list',
        'email_archive',
        'email_body',
        'email_draft_reply',
        'email_flag',
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
    expect(schema).toHaveLength(10)
    for (const t of schema) {
      expect(t.name).toBeTruthy()
      expect(t.description).toBeTruthy()
      expect(t.input_schema).toBeTruthy()
    }
  })

  test('category filter — toAnthropicSchema({categories:["read"]}) excludes write tools', () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    const readOnly = r.toAnthropicSchema({ categories: ['read'] })
    expect(readOnly).toHaveLength(7)
    for (const t of readOnly) {
      expect(t.name).not.toMatch(/_flag|_archive|_draft_reply/)
    }
  })

  test('double-register throws (registry duplicate-name guard)', () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    expect(() => registerBuiltinTools(r)).toThrow(/already registered/)
  })
})
