// V2.1 阶段 3 — 3b-4：Builtin tool catalog smoke tests（工具下沉 shared 后改注入 mock platform）。
//
// Verifies static shape (names, schemas, tiers) + createBuiltinTools wiring without hitting
// the real sync_store.db. 工具下沉 shared 后经 createBuiltinTools(platform) factory 构造，
// 注入 stub ChatToolPlatform（catalog shape 测试只读 ToolDef 元数据，不调 handler）。

import { describe, expect, test } from 'vitest'
import { createToolRegistry } from '../../../../src/shared/chat/tools/registry'
import {
  createBuiltinTools,
  createEmailTools,
  createAttachmentTools,
  createWriteTools
} from '../../../../src/shared/chat/tools/builtin'
import type { ChatToolPlatform } from '../../../../src/shared/chat/platform'

/** Stub platform — catalog shape 测试只读 ToolDef 元数据（不调 handler），方法 stub 即可；
 *  kosConfig().configured 决定 createBuiltinTools 是否含 9 KOS 工具（默认 false = 11 工具）。 */
function makePlatform(over: Partial<ChatToolPlatform> = {}): ChatToolPlatform {
  return {
    listEmails: async () => [],
    getEmail: async () => null,
    getEmailBody: async () => null,
    getAiFields: async () => null,
    listEmailsByThread: async () => [],
    searchEmailsFulltext: async () => ({ items: [], total_indexed: 0 }),
    listAttachments: async () => [],
    searchAttachments: async () => ({ items: [], total_indexed: 0 }),
    flagEmail: async () => ({}),
    draftReply: async () => ({ internalId: 0, mailbox: null, accountName: null, draftId: '' }),
    kosConfig: () => ({ configured: false, timeDecayEnabled: false }),
    kosCallTool: async () => null,
    saveToKos: async () => ({ slug: '', status: 'unknown', contentBytes: 0 }),
    ...over
  }
}

const platform = makePlatform()
const allEmailTools = createEmailTools(platform)
const allAttachmentTools = createAttachmentTools(platform)
const allWriteTools = createWriteTools(platform)

describe('builtin tool catalog — M1', () => {
  test('email tools: exactly 6 tools, all silent-tier read', () => {
    expect(allEmailTools).toHaveLength(6)
    for (const t of allEmailTools) {
      expect(t.category).toBe('read')
      expect(t.confirmationTier).toBe('silent')
      expect(t.surface).toBe('ipc')
    }
  })

  test('attachment tools: 2 (PR-2b adds email_search_attachments on top of M1 attachment_list)', () => {
    expect(allAttachmentTools).toHaveLength(2)
    const names = allAttachmentTools.map((t) => t.name).sort()
    expect(names).toEqual(['attachment_list', 'email_search_attachments'])
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
        'email_search_attachments', // PR-2b
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
      email_search_attachments: ['query'], // PR-2b
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

describe('createBuiltinTools — boot wiring', () => {
  test('builds all 11 default tools (KOS off) into a fresh registry (8 read + 3 write)', () => {
    const r = createToolRegistry()
    for (const t of createBuiltinTools(makePlatform())) r.register(t)
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
        'email_search_attachments', // PR-2b
        'email_search_fulltext'
      ].sort()
    )
  })

  test('emits a clean Anthropic schema (every entry has name/description/input_schema)', () => {
    const r = createToolRegistry()
    for (const t of createBuiltinTools(makePlatform())) r.register(t)
    const schema = r.toAnthropicSchema()
    expect(schema).toHaveLength(11) // PR-2b: 10 → 11
    for (const t of schema) {
      expect(t.name).toBeTruthy()
      expect(t.description).toBeTruthy()
      expect(t.input_schema).toBeTruthy()
    }
  })

  test('category filter — toAnthropicSchema({categories:["read"]}) excludes write tools', () => {
    const r = createToolRegistry()
    for (const t of createBuiltinTools(makePlatform())) r.register(t)
    const readOnly = r.toAnthropicSchema({ categories: ['read'] })
    expect(readOnly).toHaveLength(8) // PR-2b: 7 → 8
    for (const t of readOnly) {
      expect(t.name).not.toMatch(/_flag|_archive|_draft_reply/)
    }
  })

  test('KOS gate — kosConfig().configured=true adds the 9 KOS tools (11 → 20)', () => {
    const off = createBuiltinTools(makePlatform())
    expect(off).toHaveLength(11)
    const on = createBuiltinTools(
      makePlatform({ kosConfig: () => ({ configured: true, timeDecayEnabled: false }) })
    )
    expect(on).toHaveLength(20) // 11 default + 9 KOS
    const names = on.map((t) => t.name)
    expect(names).toContain('kos_query')
    expect(names).toContain('kos_put_page')
  })

  test('duplicate registration throws (registry duplicate-name guard)', () => {
    const r = createToolRegistry()
    const tools = createBuiltinTools(makePlatform())
    for (const t of tools) r.register(t)
    expect(() => r.register(tools[0]!)).toThrow(/already registered/)
  })
})
