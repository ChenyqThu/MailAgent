// chat-panel P4 Phase 03a — email_list_filter gateway tool (renamed from email_search, PR-D).

import { describe, expect, test } from 'vitest'

import { createEmailReadTools } from '../../../src/ai-gateway/tools/email'
import { emailSearchSchema } from '../../../src/ai-gateway/tools/schemas'
import { ToolExecutionError, type GatewayToolAuditEntry } from '../../../src/ai-gateway/tools/types'
import { errEnvelope, mockDomain, okEnvelope, runTool } from './_helpers'

const ITEMS = [
  { internal_id: 1, subject: 'redis timeout', sender: 'a@x.test' },
  { internal_id: 2, subject: 'redis config', sender: 'b@x.test' }
]

describe('email_list_filter tool', () => {
  test('runs the domain search and massages to {count, items}', async () => {
    const domain = mockDomain(() => okEnvelope(ITEMS))
    const tool = createEmailReadTools(domain).email_list_filter
    const input = emailSearchSchema.parse({ subject_contains: 'redis', limit: 10 })
    const out = await runTool(tool, input)
    expect(out).toEqual({ count: 2, items: ITEMS })
  })

  test('records an ok audit entry (input/output/duration) into the bound collector', async () => {
    const domain = mockDomain(() => okEnvelope(ITEMS))
    const auditEntries: GatewayToolAuditEntry[] = []
    // the collector is bound at tool creation (closure) — drained by the gateway in onFinish.
    const tool = createEmailReadTools(domain, auditEntries).email_list_filter
    await runTool(tool, emailSearchSchema.parse({ subject_contains: 'redis' }))
    expect(auditEntries).toHaveLength(1)
    const e = auditEntries[0]
    expect(e).toMatchObject({ toolUseId: 'tc-1', toolName: 'email_list_filter', status: 'ok' })
    expect(typeof e.durationMs).toBe('number')
    expect(JSON.parse(e.outputJson)).toEqual({ count: 2, items: ITEMS })
  })

  test('a serve-api error becomes a thrown ToolExecutionError + error audit entry', async () => {
    const domain = mockDomain(() => errEnvelope('E_INVALID_ARG', 'bad status'))
    const auditEntries: GatewayToolAuditEntry[] = []
    const tool = createEmailReadTools(domain, auditEntries).email_list_filter
    await expect(runTool(tool, emailSearchSchema.parse({}))).rejects.toBeInstanceOf(
      ToolExecutionError
    )
    expect(auditEntries[0]).toMatchObject({ status: 'error' })
    expect(JSON.parse(auditEntries[0].outputJson)).toMatchObject({ error: 'E_INVALID_ARG' })
  })

  test('is a silent read tool — never requests approval', () => {
    const domain = mockDomain(() => okEnvelope([]))
    const tool = createEmailReadTools(domain).email_list_filter
    // read tools must not carry a needsApproval policy.
    expect((tool as { needsApproval?: unknown }).needsApproval).toBeUndefined()
  })

  // prd 07-27 C-1 — the cross-folder view must not mix the user's own unsent drafts in, while an
  // explicitly requested folder (草稿箱 included) is always honoured verbatim.
  describe('drafts exclusion (exclude_drafts wire param)', () => {
    const queryOf = async (input: unknown): Promise<URLSearchParams> => {
      let seen = ''
      const domain = mockDomain((url) => {
        seen = url
        return okEnvelope([])
      })
      await runTool(createEmailReadTools(domain).email_list_filter, emailSearchSchema.parse(input))
      return new URLSearchParams(seen.split('?')[1] ?? '')
    }

    test('no mailbox → exclude_drafts=true rides the query', async () => {
      const q = await queryOf({ subject_contains: 'redis' })
      expect(q.get('exclude_drafts')).toBe('true')
    })

    test('an explicit mailbox (incl. 草稿箱) → the param is absent entirely', async () => {
      for (const mailbox of ['草稿箱', '收件箱', 'Some Custom Folder']) {
        const q = await queryOf({ mailbox })
        expect(q.has('exclude_drafts'), mailbox).toBe(false)
        expect(q.get('mailbox'), mailbox).toBe(mailbox)
      }
    })

    test('a blank mailbox is "no folder asked", not a folder named "" (the exclusion still applies)', async () => {
      const q = await queryOf({ mailbox: '   ' })
      expect(q.get('exclude_drafts')).toBe('true')
      expect(q.has('mailbox')).toBe(false)
    })
  })

  test('zod schema rejects a malformed limit (out of range) before execute', () => {
    expect(emailSearchSchema.safeParse({ limit: 9999 }).success).toBe(false)
    expect(emailSearchSchema.safeParse({ limit: 0 }).success).toBe(false)
    // all filters optional → empty input is valid (defaults limit to 20).
    const parsed = emailSearchSchema.parse({})
    expect(parsed.limit).toBe(20)
  })
})
