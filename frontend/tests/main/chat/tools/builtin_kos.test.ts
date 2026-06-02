// Sprint 19 PR-2e — KOS consumer chat tools (kos_query / kos_digest) tests.
//
// Mock 策略: __setKosClientForTests 注入 mock KOSClient 实现 query() —
// 测试不调真实 OAuth + MCP, 不依赖 env var.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createToolRegistry } from '../../../../src/electron/main/chat/tools/registry'
import {
  kosQuery,
  kosDigest,
  kosRecall,
  kosFindExperts,
  kosGetPage,
  kosListSkills,
  kosGetSkill,
  kosExtractFacts,
  kosPutPage,
  allKosTools,
  __setKosClientForTests
} from '../../../../src/electron/main/chat/tools/builtin/kos'
import { registerBuiltinTools } from '../../../../src/electron/main/chat/tools/builtin'
import { KOSError, KOSClient } from '../../../../src/electron/main/kos/client'

const dummyCtx = {
  sessionId: 1,
  emailId: 0,
  signal: new AbortController().signal
} as const

function makeMockClient(query: KOSClient['query']): KOSClient {
  return { query } as unknown as KOSClient
}

afterEach(() => {
  __setKosClientForTests(null)
})

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
  test('allKosTools exports 9 curated tools', () => {
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
    const required = (kosQuery.inputSchema as { required: string[] }).required
    expect(required).toEqual(['query'])
  })

  test('kos_digest requires slug field', () => {
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
    const queryFn = vi.fn().mockResolvedValue([
      { slug: 'people/bob', title: 'Bob', score: 0.9, chunk_text: 'about bob' },
      { slug: 'companies/acme', title: 'Acme', score: 0.7 }
    ])
    __setKosClientForTests(makeMockClient(queryFn))
    const r = await kosQuery.handler({ query: 'bob acme', limit: 5 }, dummyCtx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output).toMatchObject({ count: 2 })
      expect((r.output as { hits: unknown[] }).hits).toHaveLength(2)
    }
    expect(queryFn).toHaveBeenCalledWith('bob acme', { limit: 5, expand: false })
  })

  test('rejects empty query with E_INVALID_ARG', async () => {
    __setKosClientForTests(makeMockClient(vi.fn()))
    const r = await kosQuery.handler({ query: '' }, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_INVALID_ARG')
  })

  test('rejects missing query with E_INVALID_ARG', async () => {
    __setKosClientForTests(makeMockClient(vi.fn()))
    const r = await kosQuery.handler({}, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_INVALID_ARG')
  })

  test('clamps limit to [1, 30]', async () => {
    const queryFn = vi.fn().mockResolvedValue([])
    __setKosClientForTests(makeMockClient(queryFn))
    // Over-cap → 30
    await kosQuery.handler({ query: 'x', limit: 500 }, dummyCtx)
    expect(queryFn).toHaveBeenLastCalledWith('x', { limit: 30, expand: false })
    // Under-floor → 1
    await kosQuery.handler({ query: 'x', limit: 0 }, dummyCtx)
    expect(queryFn).toHaveBeenLastCalledWith('x', { limit: 1, expand: false })
  })

  test('expand=true passed through', async () => {
    const queryFn = vi.fn().mockResolvedValue([])
    __setKosClientForTests(makeMockClient(queryFn))
    await kosQuery.handler({ query: 'x', expand: true }, dummyCtx)
    expect(queryFn).toHaveBeenLastCalledWith('x', { limit: 10, expand: true })
  })

  test('KOSError surfaces with stable code', async () => {
    const queryFn = vi.fn().mockRejectedValue(
      new KOSError('rate limited', 'E_KOS_RATE_LIMIT', 429)
    )
    __setKosClientForTests(makeMockClient(queryFn))
    const r = await kosQuery.handler({ query: 'x' }, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('E_KOS_RATE_LIMIT')
      expect(r.message).toContain('rate limited')
    }
  })

  test('unknown exception falls through as E_INTERNAL', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('boom'))
    __setKosClientForTests(makeMockClient(queryFn))
    const r = await kosQuery.handler({ query: 'x' }, dummyCtx)
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
    const queryFn = vi.fn().mockResolvedValue([
      {
        slug: 'people/bob-acme',
        title: 'Bob Acme',
        type: 'person',
        chunk_text: '# Bob Acme\n\nCTO at Acme. Met 2026-05.',
        score: 0.95
      }
    ])
    __setKosClientForTests(makeMockClient(queryFn))
    const r = await kosDigest.handler({ slug: 'people/bob-acme' }, dummyCtx)
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
    // 内部用 query(slug, limit=1, expand=true) 拉档案
    expect(queryFn).toHaveBeenCalledWith('people/bob-acme', {
      limit: 1,
      expand: true
    })
  })

  test('returns found=false when KOS has no page', async () => {
    const queryFn = vi.fn().mockResolvedValue([])
    __setKosClientForTests(makeMockClient(queryFn))
    const r = await kosDigest.handler({ slug: 'people/unknown' }, dummyCtx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output).toEqual({ found: false, slug: 'people/unknown' })
    }
  })

  test('rejects empty slug', async () => {
    __setKosClientForTests(makeMockClient(vi.fn()))
    const r = await kosDigest.handler({ slug: '' }, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_INVALID_ARG')
  })

  test('KOSError E_KOS_UNREACHABLE surfaces', async () => {
    const queryFn = vi.fn().mockRejectedValue(
      new KOSError('network down', 'E_KOS_NETWORK')
    )
    __setKosClientForTests(makeMockClient(queryFn))
    const r = await kosDigest.handler({ slug: 'companies/acme' }, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_KOS_NETWORK')
  })

  test('uses top hit slug if query returns canonical slug different from input', async () => {
    const queryFn = vi.fn().mockResolvedValue([
      { slug: 'people/bob-acme-cto', title: 'Bob (CTO @ Acme)', score: 0.9 }
    ])
    __setKosClientForTests(makeMockClient(queryFn))
    const r = await kosDigest.handler({ slug: 'people/bob' }, dummyCtx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // canonical slug 替换原 query slug
      expect((r.output as { slug: string }).slug).toBe('people/bob-acme-cto')
    }
  })
})

// ============================================================
// Extended KOS tools (callTool / putPage proxy)
// ============================================================

describe('KOS extended tools', () => {
  function mockClientWith(over: Partial<KOSClient>): KOSClient {
    return over as unknown as KOSClient
  }

  test('kos_recall proxies callTool(recall) with entity + limit', async () => {
    const callTool = vi.fn().mockResolvedValue([{ fact: 'x' }])
    __setKosClientForTests(mockClientWith({ callTool }))
    const r = await kosRecall.handler({ entity: 'people/bob', limit: 5 }, dummyCtx)
    expect(r.ok).toBe(true)
    expect(callTool).toHaveBeenCalledWith('recall', { limit: 5, entity: 'people/bob' })
  })

  test('kos_find_experts requires topic + proxies callTool', async () => {
    const callTool = vi.fn().mockResolvedValue([])
    __setKosClientForTests(mockClientWith({ callTool }))
    const bad = await kosFindExperts.handler({}, dummyCtx)
    expect(bad.ok).toBe(false)
    await kosFindExperts.handler({ topic: 'RADIUS portal' }, dummyCtx)
    expect(callTool).toHaveBeenCalledWith('find_experts', { topic: 'RADIUS portal', limit: 10 })
  })

  test('kos_get_page requires slug + passes fuzzy', async () => {
    const callTool = vi.fn().mockResolvedValue({ slug: 'people/bob' })
    __setKosClientForTests(mockClientWith({ callTool }))
    const bad = await kosGetPage.handler({}, dummyCtx)
    expect(bad.ok).toBe(false)
    await kosGetPage.handler({ slug: 'people/bob', fuzzy: true }, dummyCtx)
    expect(callTool).toHaveBeenCalledWith('get_page', { slug: 'people/bob', fuzzy: true })
  })

  test('kos_list_skills + kos_get_skill proxy callTool', async () => {
    const callTool = vi.fn().mockResolvedValue({ ok: 1 })
    __setKosClientForTests(mockClientWith({ callTool }))
    await kosListSkills.handler({}, dummyCtx)
    expect(callTool).toHaveBeenCalledWith('list_skills', {})
    const bad = await kosGetSkill.handler({}, dummyCtx)
    expect(bad.ok).toBe(false)
    await kosGetSkill.handler({ name: 'query' }, dummyCtx)
    expect(callTool).toHaveBeenCalledWith('get_skill', { name: 'query' })
  })

  test('kos_extract_facts requires turn_text', async () => {
    const callTool = vi.fn().mockResolvedValue([])
    __setKosClientForTests(mockClientWith({ callTool }))
    const bad = await kosExtractFacts.handler({}, dummyCtx)
    expect(bad.ok).toBe(false)
    await kosExtractFacts.handler({ turn_text: 'Bob agreed to ship Friday.' }, dummyCtx)
    expect(callTool).toHaveBeenCalledWith('extract_facts', { turn_text: 'Bob agreed to ship Friday.' })
  })

  test('kos_put_page is edit-tier, requires slug+content, proxies putPage', async () => {
    expect(kosPutPage.confirmationTier).toBe('edit')
    const putPage = vi.fn().mockResolvedValue({ slug: 'notes/x', status: 'created_or_updated' })
    __setKosClientForTests(mockClientWith({ putPage }))
    const bad = await kosPutPage.handler({ slug: 'notes/x' }, dummyCtx) // missing content
    expect(bad.ok).toBe(false)
    const r = await kosPutPage.handler(
      { slug: 'notes/x', content: '---\ntype: note\n---\nbody' },
      dummyCtx
    )
    expect(r.ok).toBe(true)
    expect(putPage).toHaveBeenCalledWith('notes/x', '---\ntype: note\n---\nbody')
  })

  test('extended-tool KOSError surfaces stable code', async () => {
    const callTool = vi.fn().mockRejectedValue(new KOSError('down', 'E_KOS_NETWORK'))
    __setKosClientForTests(mockClientWith({ callTool }))
    const r = await kosRecall.handler({ entity: 'x' }, dummyCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_KOS_NETWORK')
  })
})

// ============================================================
// Registration gate by MAILAGENT_KOS_CONSUMER_ENABLED
// ============================================================

describe('registerBuiltinTools KOS gate', () => {
  beforeEach(() => {
    // 保险: 每次测试前清掉 KOS_CONSUMER env, 避免互相污染
    delete process.env.MAILAGENT_KOS_CONSUMER_ENABLED
  })

  afterEach(() => {
    delete process.env.MAILAGENT_KOS_CONSUMER_ENABLED
  })

  test('flag OFF (default) — KOS tools NOT registered', () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    const names = r.names()
    expect(names).not.toContain('kos_query')
    expect(names).not.toContain('kos_digest')
  })

  test('flag ON — KOS tools registered alongside default 11', () => {
    process.env.MAILAGENT_KOS_CONSUMER_ENABLED = 'true'
    const r = createToolRegistry()
    registerBuiltinTools(r)
    const names = r.names().sort()
    expect(names).toContain('kos_query')
    expect(names).toContain('kos_put_page')
    expect(names).toHaveLength(20) // 11 default + 9 KOS
  })

  test('flag ON with value "1" also works', () => {
    process.env.MAILAGENT_KOS_CONSUMER_ENABLED = '1'
    const r = createToolRegistry()
    registerBuiltinTools(r)
    expect(r.names()).toContain('kos_query')
  })

  test('flag ON: KOS tools live in category=meta only', () => {
    process.env.MAILAGENT_KOS_CONSUMER_ENABLED = 'true'
    const r = createToolRegistry()
    registerBuiltinTools(r)
    const metaSchema = r.toAnthropicSchema({ categories: ['meta'] })
    expect(metaSchema).toHaveLength(9)
    const metaNames = metaSchema.map((s) => s.name).sort()
    expect(metaNames).toEqual(ALL_KOS_NAMES)
  })
})
