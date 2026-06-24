// chat-panel P4 Phase 03a — email_get + email_body gateway tools.

import { describe, expect, test } from 'vitest'

import { createEmailReadTools } from '../../../src/ai-gateway/tools/email'
import { emailBodySchema, emailGetSchema } from '../../../src/ai-gateway/tools/schemas'
import { ToolExecutionError, type GatewayToolAuditEntry } from '../../../src/ai-gateway/tools/types'
import { errEnvelope, mockDomain, okEnvelope, runTool } from './_helpers'

describe('email_get tool', () => {
  test('returns the email row on success', async () => {
    const row = { internal_id: 7, subject: 'hi', sender: 'a@x.test', thread_id: 't1' }
    const domain = mockDomain(() => okEnvelope(row))
    const out = await runTool(
      createEmailReadTools(domain).email_get,
      emailGetSchema.parse({ internal_id: 7 })
    )
    expect(out).toEqual(row)
  })

  test('E_NOT_FOUND (domain → null) surfaces as a typed tool error', async () => {
    const domain = mockDomain(() => errEnvelope('E_NOT_FOUND', 'no such email', 404))
    const auditEntries: GatewayToolAuditEntry[] = []
    await expect(
      runTool(
        createEmailReadTools(domain, auditEntries).email_get,
        emailGetSchema.parse({ internal_id: 999 })
      )
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    expect(auditEntries[0]).toMatchObject({ toolName: 'email_get', status: 'error' })
  })

  test('zod schema requires internal_id', () => {
    expect(emailGetSchema.safeParse({}).success).toBe(false)
    expect(emailGetSchema.safeParse({ internal_id: 'x' }).success).toBe(false)
    expect(emailGetSchema.safeParse({ internal_id: 7 }).success).toBe(true)
  })
})

describe('email_body tool', () => {
  test('truncates over max_chars and appends the marker (parity with legacy)', async () => {
    const longContent = 'x'.repeat(20000)
    const domain = mockDomain(() =>
      okEnvelope({
        internal_id: 5,
        content: longContent,
        size_bytes: 20000,
        fetched_at: 123,
        fetched_source: 'mime'
      })
    )
    const tool = createEmailReadTools(domain).email_body
    const out = (await runTool(
      tool,
      emailBodySchema.parse({ internal_id: 5, max_chars: 1000 })
    )) as {
      content: string
      format: string
    }
    expect(out.content.endsWith('…[truncated]')).toBe(true)
    expect(out.content.length).toBe(1000 + '\n\n…[truncated]'.length)
    expect(out.format).toBe('markdown')
  })

  test('returns full content under the cap (no marker)', async () => {
    const domain = mockDomain(() =>
      okEnvelope({
        internal_id: 5,
        content: 'short body',
        size_bytes: 10,
        fetched_at: 1,
        fetched_source: 'mime'
      })
    )
    const out = (await runTool(
      createEmailReadTools(domain).email_body,
      emailBodySchema.parse({ internal_id: 5 })
    )) as { content: string }
    expect(out.content).toBe('short body')
  })

  test('missing body → typed E_NOT_FOUND tool error', async () => {
    const domain = mockDomain(() => errEnvelope('E_NOT_FOUND', 'no body', 404))
    await expect(
      runTool(createEmailReadTools(domain).email_body, emailBodySchema.parse({ internal_id: 5 }))
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })
})
