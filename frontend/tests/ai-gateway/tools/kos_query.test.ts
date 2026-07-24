// chat-panel P4 Phase 03a — kos_query gateway tool.

import { describe, expect, test } from 'vitest'

import { createKosReadTools } from '../../../src/ai-gateway/tools/kos'
import { kosQuerySchema } from '../../../src/ai-gateway/tools/schemas'
import { type GatewayToolAuditEntry } from '../../../src/ai-gateway/tools/types'
import { errEnvelope, mockDomain, okEnvelope, runTool } from './_helpers'

describe('kos_query tool', () => {
  test('massages KOS hits to {count, hits}; passes through when time-decay off', async () => {
    // Opaque numeric slugs so the shape survives the projection verbatim — that is what makes
    // "no reshaping when decay is off" observable. A READABLE slug would be fenced (by design,
    // see kos_read_tools.test.ts), which would hide the pass-through this test is about.
    const hits = [
      { slug: '42856', score: 2 },
      { slug: '42857', score: 1 }
    ]
    const domain = mockDomain(() => okEnvelope(hits))
    const tool = createKosReadTools(domain, [], { timeDecayEnabled: false }).kos_query
    const out = (await runTool(tool, kosQuerySchema.parse({ query: 'acme' }))) as {
      count: number
      hits: unknown[]
    }
    expect(out.count).toBe(2)
    expect(out.hits).toEqual(hits)
  })

  test('reranks by recency when time-decay enabled (newer hit floats up)', async () => {
    const now = Date.now()
    const hits = [
      { slug: '1000', score: 1, updated_at: now - 200 * 86_400_000 },
      { slug: '2000', score: 1, updated_at: now }
    ]
    const domain = mockDomain(() => okEnvelope(hits))
    const tool = createKosReadTools(domain, [], { timeDecayEnabled: true }).kos_query
    const out = (await runTool(tool, kosQuerySchema.parse({ query: 'acme' }))) as {
      hits: Array<{ slug: string }>
    }
    // same base score → the recent hit outranks the 200-day-old one after decay.
    expect(out.hits[0].slug).toBe('2000')
  })

  test('constructs args {query, limit, expand} + source_id only when present', async () => {
    let captured: unknown
    const domain = mockDomain((_url, body) => {
      captured = JSON.parse(body as string)
      return okEnvelope([])
    })
    const tool = createKosReadTools(domain).kos_query
    await runTool(tool, kosQuerySchema.parse({ query: 'acme', source_id: 'omada' }))
    expect(captured).toEqual({
      name: 'query',
      args: { query: 'acme', limit: 10, expand: false, source_id: 'omada' }
    })

    captured = undefined
    await runTool(tool, kosQuerySchema.parse({ query: 'acme' }))
    expect((captured as { args: Record<string, unknown> }).args.source_id).toBeUndefined()
  })

  test('KOS unreachable (E_KOS_*) surfaces as a typed tool error', async () => {
    const domain = mockDomain(() => errEnvelope('E_KOS_UNREACHABLE', 'kos down', 502))
    const auditEntries: GatewayToolAuditEntry[] = []
    await expect(
      runTool(
        createKosReadTools(domain, auditEntries).kos_query,
        kosQuerySchema.parse({ query: 'x' })
      )
    ).rejects.toMatchObject({ code: 'E_KOS_UNREACHABLE' })
    expect(auditEntries[0]).toMatchObject({ toolName: 'kos_query', status: 'error' })
  })
})
