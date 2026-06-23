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
  createWriteTools,
  createReportTools
} from '../../../../src/shared/chat/tools/builtin'
import type { ChatToolPlatform } from '../../../../src/shared/chat/platform'

/** Stub platform — catalog shape 测试只读 ToolDef 元数据（不调 handler），方法 stub 即可；
 *  kosConfig().configured 决定 createBuiltinTools 是否含 9 KOS 工具（默认 false = 18 工具）。 */
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
    listFolders: async () => [],
    flagEmail: async () => ({}),
    draftReply: async () => ({ internalId: 0, mailbox: null, accountName: null, draftId: '' }),
    setReplySuggestion: async () => ({ internalId: 0, replySuggestionMd: '', chars: 0 }),
    setAiFields: async () => ({
      internalId: 0,
      aiAction: null,
      aiPriority: null,
      aiReviewStatus: null
    }),
    setPin: async () => ({}),
    moveEmail: async () => ({}),
    resyncEmail: async () => ({}),
    archiveEmail: async () => ({}),
    listReports: async () => [],
    getReport: async () => null,
    runReport: async () => ({ report_id: '', status: 'ready', headline: '' }),
    kosConfig: () => ({ configured: false, timeDecayEnabled: false }),
    kosCallTool: async () => null,
    saveToKos: async () => ({ slug: '', status: 'unknown', contentBytes: 0 }),
    // P2f/P2g/P2b platform methods (handlers never invoked in these construction tests).
    listMemory: async () => [],
    getMemory: async () => null,
    writeMemory: async () => ({
      scope: 'user',
      key: '',
      value_json: 'null',
      source_wiki_path: null,
      created_at: 0,
      updated_at: 0
    }),
    deleteMemory: async () => 0,
    notionAgentChat: async () => ({
      text: '',
      threadId: null,
      status: 'ok' as const,
      metadata: null
    }),
    invokeSkillTool: async () => null,
    ...over
  }
}

const platform = makePlatform()
const allEmailTools = createEmailTools(platform)
const allAttachmentTools = createAttachmentTools(platform)
const allWriteTools = createWriteTools(platform)
const allReportTools = createReportTools(platform)

describe('builtin tool catalog — M1', () => {
  test('email tools: exactly 7 tools, all silent-tier read (incl. email_list_folders)', () => {
    expect(allEmailTools).toHaveLength(7)
    for (const t of allEmailTools) {
      expect(t.category).toBe('read')
      expect(t.confirmationTier).toBe('silent')
      expect(t.surface).toBe('ipc')
    }
    expect(allEmailTools.map((t) => t.name)).toContain('email_list_folders')
  })

  test('attachment tools: 2 (PR-2b adds email_search_attachments on top of M1 attachment_list)', () => {
    expect(allAttachmentTools).toHaveLength(2)
    const names = allAttachmentTools.map((t) => t.name).sort()
    expect(names).toEqual(['attachment_list', 'email_search_attachments'])
  })

  test('write tools: exactly 8 (flag/archive/draft_reply/set_reply_suggestion/set_ai_fields/pin/move/resync)', () => {
    expect(allWriteTools).toHaveLength(8)
    const writeNames = allWriteTools.map((t) => t.name).sort()
    expect(writeNames).toEqual(
      [
        'email_archive',
        'email_draft_reply',
        'email_flag',
        'email_move',
        'email_pin',
        'email_resync',
        'email_set_ai_fields',
        'email_set_reply_suggestion'
      ].sort()
    )
    for (const t of allWriteTools) {
      expect(t.category).toBe('write')
      expect(t.surface).toBe('ipc')
      // tier is preview / edit (never silent for writes)
      expect(['preview', 'edit']).toContain(t.confirmationTier)
    }
  })

  test('report tools: exactly 3 (report_list / report_get read + report_run write)', () => {
    expect(allReportTools).toHaveLength(3)
    const names = allReportTools.map((t) => t.name).sort()
    expect(names).toEqual(['report_get', 'report_list', 'report_run'])
    expect(allReportTools.find((t) => t.name === 'report_list')?.confirmationTier).toBe('silent')
    expect(allReportTools.find((t) => t.name === 'report_get')?.confirmationTier).toBe('silent')
    expect(allReportTools.find((t) => t.name === 'report_run')?.confirmationTier).toBe('edit')
    expect(allReportTools.find((t) => t.name === 'report_run')?.category).toBe('write')
  })

  test('edit-tier writes (draft_reply / set_reply_suggestion / set_ai_fields) — user MAY change before write', () => {
    expect(allWriteTools.find((t) => t.name === 'email_draft_reply')?.confirmationTier).toBe('edit')
    expect(
      allWriteTools.find((t) => t.name === 'email_set_reply_suggestion')?.confirmationTier
    ).toBe('edit')
    expect(allWriteTools.find((t) => t.name === 'email_set_ai_fields')?.confirmationTier).toBe(
      'edit'
    )
  })

  test('preview-tier writes (flag / archive / pin / move / resync) are reversible', () => {
    for (const name of ['email_flag', 'email_archive', 'email_pin', 'email_move', 'email_resync']) {
      expect(allWriteTools.find((t) => t.name === name)?.confirmationTier).toBe('preview')
    }
  })

  test('all builtin names are stable + snake_case', () => {
    const names = [
      ...allEmailTools,
      ...allAttachmentTools,
      ...allWriteTools,
      ...allReportTools
    ].map((t) => t.name)
    expect(names.sort()).toEqual(
      [
        'attachment_list',
        'email_archive',
        'email_body',
        'email_draft_reply',
        'email_flag',
        'email_get',
        'email_get_ai_fields',
        'email_list_folders',
        'email_list_thread',
        'email_move',
        'email_pin',
        'email_resync',
        'email_search',
        'email_search_attachments', // PR-2b
        'email_search_fulltext',
        'email_set_ai_fields',
        'email_set_reply_suggestion',
        'report_get',
        'report_list',
        'report_run'
      ].sort()
    )
    for (const n of names) {
      expect(n).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  test('every tool has actionable LLM-facing description (≥ 30 chars)', () => {
    for (const t of [
      ...allEmailTools,
      ...allAttachmentTools,
      ...allWriteTools,
      ...allReportTools
    ]) {
      expect(t.description.length).toBeGreaterThanOrEqual(30)
    }
  })

  test('every tool has type=object inputSchema with explicit required array', () => {
    for (const t of [
      ...allEmailTools,
      ...allAttachmentTools,
      ...allWriteTools,
      ...allReportTools
    ]) {
      const s = t.inputSchema as { type?: string; required?: unknown }
      expect(s.type).toBe('object')
      expect(Array.isArray(s.required)).toBe(true)
    }
  })

  test('each tool requires its primary id (internal_id / thread_id / query)', () => {
    const tools = [...allEmailTools, ...allAttachmentTools, ...allWriteTools, ...allReportTools]
    const requirements: Record<string, string[]> = {
      email_search: [], // optional filters
      email_get: ['internal_id'],
      email_body: ['internal_id'],
      email_list_thread: ['thread_id'],
      email_search_fulltext: ['query'],
      email_search_attachments: ['query'], // PR-2b
      email_get_ai_fields: ['internal_id'],
      email_list_folders: [], // no args — lists all folders
      attachment_list: ['internal_id'],
      // write tools require internal_id + per-tool extra args.
      email_flag: ['internal_id'],
      email_archive: ['internal_id'],
      email_draft_reply: ['internal_id', 'body_markdown'],
      email_set_reply_suggestion: ['internal_id', 'reply_suggestion_md'],
      email_set_ai_fields: ['internal_id'], // at-least-one validated in handler, not schema-required
      email_pin: ['internal_id', 'pinned'],
      email_move: ['internal_id', 'dst_imap_name'],
      email_resync: ['internal_id'],
      // report tools
      report_list: [], // optional filters
      report_get: ['report_id'],
      report_run: ['agent_id']
    }
    for (const t of tools) {
      const expected = requirements[t.name]
      const actual = (t.inputSchema as { required: string[] }).required
      expect(actual.sort()).toEqual(expected.sort())
    }
  })
})

describe('createBuiltinTools — boot wiring', () => {
  test('builds all 37 default tools (KOS off) into a fresh registry (11 read + 9 write + 4 memory + 1 notion + 5 agent_profile + 6 skill + 1 plan)', () => {
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
        'email_list_folders',
        'email_list_thread',
        'email_move',
        'email_pin',
        'email_resync',
        'email_search',
        'email_search_attachments', // PR-2b
        'email_search_fulltext',
        'email_set_ai_fields',
        'email_set_reply_suggestion',
        'report_get',
        'report_list',
        'report_run',
        // P2f memory WAL
        'memory_list',
        'memory_get',
        'memory_write',
        'memory_delete',
        // P2g notion_agent_chat
        'notion_agent_chat',
        // PR6 — agent self-config: Standing Context docs (read/edit)
        'agent_profile_list_docs',
        'agent_profile_read_doc',
        'agent_profile_history',
        'agent_profile_apply_patch',
        'agent_profile_rollback',
        // PR6 — installed skill management
        'skill_list_installed',
        'skill_read',
        'skill_enable',
        'skill_disable',
        'skill_install',
        'skill_uninstall',
        // P2d — cross-domain plan artifact (silent, category 'meta')
        'plan_update'
      ].sort()
    )
  })

  test('emits a clean Anthropic schema (every entry has name/description/input_schema)', () => {
    const r = createToolRegistry()
    for (const t of createBuiltinTools(makePlatform())) r.register(t)
    const schema = r.toAnthropicSchema()
    expect(schema).toHaveLength(37)
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
    // 9 email/attachment read (incl. email_list_folders) + report_list + report_get = 11
    expect(readOnly).toHaveLength(11)
    for (const t of readOnly) {
      expect(t.name).not.toMatch(
        /_flag|_archive|_draft_reply|_pin|email_move|_resync|_set_reply|_set_ai_fields|report_run/
      )
    }
  })

  test('KOS gate — kosConfig().configured=true adds the 9 KOS tools (37 → 46)', () => {
    const off = createBuiltinTools(makePlatform())
    expect(off).toHaveLength(37)
    const on = createBuiltinTools(
      makePlatform({ kosConfig: () => ({ configured: true, timeDecayEnabled: false }) })
    )
    expect(on).toHaveLength(46) // 37 default (incl. 4 memory + 1 notion + 5 agent_profile + 6 skill + 1 plan) + 9 KOS
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
