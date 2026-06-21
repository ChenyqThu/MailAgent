// V2.1 阶段 3 — 3b-4：KOS consumer chat tools 测试（工具下沉 shared 后改注入 mock platform）。
//
// Mock 策略变更：原 __setKosClientForTests 注入 mock KOSClient → 现注入 mock ChatToolPlatform
// 的 kosCallTool（vi.fn）。9 KOS 工具全收敛 kosCallTool(name, args)，断言改为校验 kosCallTool
// 被调的 (name, args)（kos_query/kos_digest 复刻 KOSClient.query 的 {query,limit,expand}+source_id
// args 构造；其余直传）。错误用 duck-type code（不 import main KOSError 类）。

import { describe, expect, test, vi } from 'vitest'

import { createKosTools, createBuiltinTools } from '../../../../src/shared/chat/tools/builtin'
import type { ChatToolPlatform } from '../../../../src/shared/chat/platform'

const dummyCtx = {
  sessionId: 1,
  emailId: 0,
  signal: new AbortController().signal
} as const

/** Stub platform（KOS 工具只触 kosCallTool / kosConfig；其余原语 stub）。 */
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
    kosConfig: () => ({ configured: true, timeDecayEnabled: false }),
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

/** Build the KOS tools with a mock kosCallTool, return a by-name lookup. */
function kosToolByName(kosCallTool: ChatToolPlatform['kosCallTool']) {
  const tools = createKosTools(makePlatform({ kosCallTool }))
  return (name: string) => tools.find((t) => t.name === name)!
}

/** KOS 错误 mock：shared kos.ts duck-type 读 `code`（E_KOS_*），不依赖 main KOSError 类。 */
function kosError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

// ============================================================
// Tool catalog shape
// ============================================================

const ALL_KOS_NAMES = [
  'kos_digest',
  'kos_extract_facts',
  'kos_find_experts',
  'kos_get_page',
  'kos_get_skill',
  'kos_list_skills',
  'kos_put_page',
  'kos_query',
  'kos_recall'
]

describe('KOS tools catalog', () => {
  const allKosTools = createKosTools(makePlatform())

  test('createKosTools builds 9 curated tools', () => {
    expect(allKosTools).toHaveLength(9)
    const names = allKosTools.map((t) => t.name).sort()
    expect(names).toEqual(ALL_KOS_NAMES)
  })

  test('read tools silent; write tools (kos_put_page / kos_extract_facts) need confirm', () => {
    const writeTools = new Set(['kos_put_page', 'kos_extract_facts'])
    for (const t of allKosTools) {
      expect(t.category).toBe('meta')
      expect(t.surface).toBe('webhook')
      if (writeTools.has(t.name)) {
        expect(t.confirmationTier).toBe('edit')
      } else {
        expect(t.confirmationTier).toBe('silent')
      }
    }
  })

  test('kos_query requires query field', () => {
    const kosQuery = allKosTools.find((t) => t.name === 'kos_query')!
    const required = (kosQuery.inputSchema as { required: string[] }).required
    expect(required).toEqual(['query'])
  })

  test('kos_digest requires slug field', () => {
    const kosDigest = allKosTools.find((t) => t.name === 'kos_digest')!
    const required = (kosDigest.inputSchema as { required: string[] }).required
    expect(required).toEqual(['slug'])
  })

  test('every tool has actionable LLM description (≥ 60 chars)', () => {
    for (const t of allKosTools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60)
    }
  })
})

// ============================================================
// kos_query handler
// ============================================================

describe('kos_query handler', () => {
  test('returns hits on success', async () => {
    const kosCallTool = vi.fn().mockResolvedValue([
      { slug: 'people/bob', title: 'Bob', score: 0.9, chunk_text: 'about bob' },
      { slug: 'companies/acme', title: 'Acme', score: 0.7 }
    ])
    const r = await kosToolByName(kosCallTool)('kos_query').handler(
      { query: 'bob acme', limit: 5 },
      dummyCtx
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output).toMatchObject({ count: 2 })
      expect((r.output as { hits: unknown[] }).hits).toHaveLength(2)
    }
    expect(kosCallTool).toHaveBeenCalledWith('query', {
      query: 'bob acme',
      limit: 5,
      expand: false
    })
  })

  test('rejects empty query with E_INVALID_ARG', async () => {
    const r = await kosToolByName(vi.fn())('kos_query').handler({ query: '' }, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_INVALID_ARG')
  })

  test('rejects missing query with E_INVALID_ARG', async () => {
    const r = await kosToolByName(vi.fn())('kos_query').handler({}, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_INVALID_ARG')
  })

  test('clamps limit to [1, 30]', async () => {
    const kosCallTool = vi.fn().mockResolvedValue([])
    const kosQuery = kosToolByName(kosCallTool)('kos_query')
    // Over-cap → 30
    await kosQuery.handler({ query: 'x', limit: 500 }, dummyCtx)
    expect(kosCallTool).toHaveBeenLastCalledWith('query', { query: 'x', limit: 30, expand: false })
    // Under-floor → 1
    await kosQuery.handler({ query: 'x', limit: 0 }, dummyCtx)
    expect(kosCallTool).toHaveBeenLastCalledWith('query', { query: 'x', limit: 1, expand: false })
  })

  test('expand=true passed through', async () => {
    const kosCallTool = vi.fn().mockResolvedValue([])
    await kosToolByName(kosCallTool)('kos_query').handler({ query: 'x', expand: true }, dummyCtx)
    expect(kosCallTool).toHaveBeenLastCalledWith('query', { query: 'x', limit: 10, expand: true })
  })

  test('source_id only added when present (mirror KOSClient.query)', async () => {
    const kosCallTool = vi.fn().mockResolvedValue([])
    await kosToolByName(kosCallTool)('kos_query').handler(
      { query: 'x', source_id: 'mailagent-emails' },
      dummyCtx
    )
    expect(kosCallTool).toHaveBeenLastCalledWith('query', {
      query: 'x',
      limit: 10,
      expand: false,
      source_id: 'mailagent-emails'
    })
  })

  test('KOSError surfaces with stable code', async () => {
    const kosCallTool = vi.fn().mockRejectedValue(kosError('rate limited', 'E_KOS_RATE_LIMIT'))
    const r = await kosToolByName(kosCallTool)('kos_query').handler({ query: 'x' }, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('E_KOS_RATE_LIMIT')
      expect(r.message).toContain('rate limited')
    }
  })

  test('unknown exception falls through as E_INTERNAL', async () => {
    const kosCallTool = vi.fn().mockRejectedValue(new Error('boom'))
    const r = await kosToolByName(kosCallTool)('kos_query').handler({ query: 'x' }, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('E_INTERNAL')
      expect(r.message).toBe('boom')
    }
  })
})

// ============================================================
// kos_digest handler
// ============================================================

describe('kos_digest handler', () => {
  test('returns found=true with entity summary on top hit', async () => {
    const kosCallTool = vi.fn().mockResolvedValue([
      {
        slug: 'people/bob-acme',
        title: 'Bob Acme',
        type: 'person',
        chunk_text: '# Bob Acme\n\nCTO at Acme. Met 2026-05.',
        score: 0.95
      }
    ])
    const r = await kosToolByName(kosCallTool)('kos_digest').handler(
      { slug: 'people/bob-acme' },
      dummyCtx
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output).toMatchObject({
        found: true,
        slug: 'people/bob-acme',
        title: 'Bob Acme',
        type: 'person',
        score: 0.95
      })
      expect((r.output as { chunk_text: string }).chunk_text).toContain('CTO at Acme')
    }
    // 内部用 query(slug, limit=1, expand=true) 拉档案 → kosCallTool('query', {query, limit, expand})
    expect(kosCallTool).toHaveBeenCalledWith('query', {
      query: 'people/bob-acme',
      limit: 1,
      expand: true
    })
  })

  test('returns found=false when KOS has no page', async () => {
    const kosCallTool = vi.fn().mockResolvedValue([])
    const r = await kosToolByName(kosCallTool)('kos_digest').handler(
      { slug: 'people/unknown' },
      dummyCtx
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output).toEqual({ found: false, slug: 'people/unknown' })
    }
  })

  test('rejects empty slug', async () => {
    const r = await kosToolByName(vi.fn())('kos_digest').handler({ slug: '' }, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_INVALID_ARG')
  })

  test('KOSError E_KOS_NETWORK surfaces', async () => {
    const kosCallTool = vi.fn().mockRejectedValue(kosError('network down', 'E_KOS_NETWORK'))
    const r = await kosToolByName(kosCallTool)('kos_digest').handler(
      { slug: 'companies/acme' },
      dummyCtx
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_KOS_NETWORK')
  })

  test('uses top hit slug if query returns canonical slug different from input', async () => {
    const kosCallTool = vi
      .fn()
      .mockResolvedValue([{ slug: 'people/bob-acme-cto', title: 'Bob (CTO @ Acme)', score: 0.9 }])
    const r = await kosToolByName(kosCallTool)('kos_digest').handler(
      { slug: 'people/bob' },
      dummyCtx
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      // canonical slug 替换原 query slug
      expect((r.output as { slug: string }).slug).toBe('people/bob-acme-cto')
    }
  })
})

// ============================================================
// Extended KOS tools (kosCallTool proxy)
// ============================================================

describe('KOS extended tools', () => {
  test('kos_recall proxies kosCallTool(recall) with entity + limit', async () => {
    const kosCallTool = vi.fn().mockResolvedValue([{ fact: 'x' }])
    const r = await kosToolByName(kosCallTool)('kos_recall').handler(
      { entity: 'people/bob', limit: 5 },
      dummyCtx
    )
    expect(r.ok).toBe(true)
    expect(kosCallTool).toHaveBeenCalledWith('recall', { limit: 5, entity: 'people/bob' })
  })

  test('kos_find_experts requires topic + proxies kosCallTool', async () => {
    const kosCallTool = vi.fn().mockResolvedValue([])
    const tool = kosToolByName(kosCallTool)('kos_find_experts')
    const bad = await tool.handler({}, dummyCtx)
    expect(bad.ok).toBe(false)
    await tool.handler({ topic: 'RADIUS portal' }, dummyCtx)
    expect(kosCallTool).toHaveBeenCalledWith('find_experts', { topic: 'RADIUS portal', limit: 10 })
  })

  test('kos_get_page requires slug + passes fuzzy', async () => {
    const kosCallTool = vi.fn().mockResolvedValue({ slug: 'people/bob' })
    const tool = kosToolByName(kosCallTool)('kos_get_page')
    const bad = await tool.handler({}, dummyCtx)
    expect(bad.ok).toBe(false)
    await tool.handler({ slug: 'people/bob', fuzzy: true }, dummyCtx)
    expect(kosCallTool).toHaveBeenCalledWith('get_page', { slug: 'people/bob', fuzzy: true })
  })

  test('kos_list_skills + kos_get_skill proxy kosCallTool', async () => {
    const kosCallTool = vi.fn().mockResolvedValue({ ok: 1 })
    const byName = kosToolByName(kosCallTool)
    await byName('kos_list_skills').handler({}, dummyCtx)
    expect(kosCallTool).toHaveBeenCalledWith('list_skills', {})
    const bad = await byName('kos_get_skill').handler({}, dummyCtx)
    expect(bad.ok).toBe(false)
    await byName('kos_get_skill').handler({ name: 'query' }, dummyCtx)
    expect(kosCallTool).toHaveBeenCalledWith('get_skill', { name: 'query' })
  })

  test('kos_extract_facts requires turn_text', async () => {
    const kosCallTool = vi.fn().mockResolvedValue([])
    const tool = kosToolByName(kosCallTool)('kos_extract_facts')
    const bad = await tool.handler({}, dummyCtx)
    expect(bad.ok).toBe(false)
    await tool.handler({ turn_text: 'Bob agreed to ship Friday.' }, dummyCtx)
    expect(kosCallTool).toHaveBeenCalledWith('extract_facts', {
      turn_text: 'Bob agreed to ship Friday.'
    })
  })

  test('kos_put_page is edit-tier, requires slug+content, proxies kosCallTool(put_page)', async () => {
    const kosCallTool = vi.fn().mockResolvedValue({ slug: 'notes/x', status: 'created_or_updated' })
    const tool = kosToolByName(kosCallTool)('kos_put_page')
    expect(tool.confirmationTier).toBe('edit')
    const bad = await tool.handler({ slug: 'notes/x' }, dummyCtx) // missing content
    expect(bad.ok).toBe(false)
    const r = await tool.handler(
      { slug: 'notes/x', content: '---\ntype: note\n---\nbody' },
      dummyCtx
    )
    expect(r.ok).toBe(true)
    expect(kosCallTool).toHaveBeenCalledWith('put_page', {
      slug: 'notes/x',
      content: '---\ntype: note\n---\nbody'
    })
  })

  test('extended-tool KOSError surfaces stable code', async () => {
    const kosCallTool = vi.fn().mockRejectedValue(kosError('down', 'E_KOS_NETWORK'))
    const r = await kosToolByName(kosCallTool)('kos_recall').handler({ entity: 'x' }, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_KOS_NETWORK')
  })
})

// ============================================================
// Registration gate by platform.kosConfig().configured
// ============================================================

describe('createBuiltinTools KOS gate', () => {
  test('configured=false (default) — KOS tools NOT registered', () => {
    const tools = createBuiltinTools(
      makePlatform({ kosConfig: () => ({ configured: false, timeDecayEnabled: false }) })
    )
    const names = tools.map((t) => t.name)
    expect(names).not.toContain('kos_query')
    expect(names).not.toContain('kos_digest')
    expect(tools).toHaveLength(25) // 11 read + 9 write + 4 memory (P2f) + 1 notion (P2g), no KOS
  })

  test('configured=true — KOS tools registered alongside default 25 (→ 34)', () => {
    const tools = createBuiltinTools(
      makePlatform({ kosConfig: () => ({ configured: true, timeDecayEnabled: false }) })
    )
    const names = tools.map((t) => t.name).sort()
    expect(names).toContain('kos_query')
    expect(names).toContain('kos_put_page')
    expect(tools).toHaveLength(34) // 25 default (incl. 4 memory + 1 notion) + 9 KOS
  })

  test('configured=true: category=meta holds the KOS tools + the 4 memory tools', () => {
    const tools = createBuiltinTools(
      makePlatform({ kosConfig: () => ({ configured: true, timeDecayEnabled: false }) })
    )
    const metaNames = tools
      .filter((t) => t.category === 'meta')
      .map((t) => t.name)
      .sort()
    // P2f — memory tools are also category 'meta' (agent-meta), alongside KOS.
    const MEMORY_NAMES = ['memory_delete', 'memory_get', 'memory_list', 'memory_write']
    expect(metaNames).toEqual([...ALL_KOS_NAMES, ...MEMORY_NAMES].sort())
    // every KOS tool is still meta-categorized (the original invariant).
    expect(metaNames.filter((n) => n.startsWith('kos_'))).toEqual(ALL_KOS_NAMES)
  })
})
