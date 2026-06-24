// chat-panel P4 Phase 03a — email_search gateway tool.

import { describe, expect, test } from 'vitest'

import { createEmailReadTools } from '../../../src/ai-gateway/tools/email'
import { emailSearchSchema } from '../../../src/ai-gateway/tools/schemas'
import { ToolExecutionError, type GatewayToolAuditEntry } from '../../../src/ai-gateway/tools/types'
import { errEnvelope, mockDomain, okEnvelope, runTool } from './_helpers'

const ITEMS = [
  { internal_id: 1, subject: 'redis timeout', sender: 'a@x.test' },
  { internal_id: 2, subject: 'redis config', sender: 'b@x.test' }
]

describe('email_search tool', () => {
  test('runs the domain search and massages to {count, items}', async () => {
    const domain = mockDomain(() => okEnvelope(ITEMS))
    const tool = createEmailReadTools(domain).email_search
    const input = emailSearchSchema.parse({ subject_contains: 'redis', limit: 10 })
    const out = await runTool(tool, input)
    expect(out).toEqual({ count: 2, items: ITEMS })
  })

  test('records an ok audit entry (input/output/duration) into the bound collector', async () => {
    const domain = mockDomain(() => okEnvelope(ITEMS))
    const auditEntries: GatewayToolAuditEntry[] = []
    // the collector is bound at tool creation (closure) — drained by the gateway in onFinish.
    const tool = createEmailReadTools(domain, auditEntries).email_search
    await runTool(tool, emailSearchSchema.parse({ subject_contains: 'redis' }))
    expect(auditEntries).toHaveLength(1)
    const e = auditEntries[0]
    expect(e).toMatchObject({ toolUseId: 'tc-1', toolName: 'email_search', status: 'ok' })
    expect(typeof e.durationMs).toBe('number')
    expect(JSON.parse(e.outputJson)).toEqual({ count: 2, items: ITEMS })
  })

  test('a serve-api error becomes a thrown ToolExecutionError + error audit entry', async () => {
    const domain = mockDomain(() => errEnvelope('E_INVALID_ARG', 'bad status'))
    const auditEntries: GatewayToolAuditEntry[] = []
    const tool = createEmailReadTools(domain, auditEntries).email_search
    await expect(runTool(tool, emailSearchSchema.parse({}))).rejects.toBeInstanceOf(
      ToolExecutionError
    )
    expect(auditEntries[0]).toMatchObject({ status: 'error' })
    expect(JSON.parse(auditEntries[0].outputJson)).toMatchObject({ error: 'E_INVALID_ARG' })
  })

  test('is a silent read tool — never requests approval', () => {
    const domain = mockDomain(() => okEnvelope([]))
    const tool = createEmailReadTools(domain).email_search
    // read tools must not carry a needsApproval policy.
    expect((tool as { needsApproval?: unknown }).needsApproval).toBeUndefined()
  })

  test('zod schema rejects a malformed limit (out of range) before execute', () => {
    expect(emailSearchSchema.safeParse({ limit: 9999 }).success).toBe(false)
    expect(emailSearchSchema.safeParse({ limit: 0 }).success).toBe(false)
    // all filters optional → empty input is valid (defaults limit to 20).
    const parsed = emailSearchSchema.parse({})
    expect(parsed.limit).toBe(20)
  })
})
