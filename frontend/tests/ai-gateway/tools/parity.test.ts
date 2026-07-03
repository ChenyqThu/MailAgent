// chat-panel P4 Phase 03a → S3 W2 — read-tool output snapshots (AI SDK Gateway).
//
// Originally a legacy⋈gateway parity harness (the migration contract: key-for-key
// identical output given the same domain data). The legacy runtime is deleted, so
// the migration contract is fulfilled — these tests now PIN the gateway tools'
// output shape against fixed fixtures (the exact values the parity run asserted),
// so an accidental output-shape change still fails loudly.

import { describe, expect, test } from 'vitest'

import { createEmailReadTools } from '../../../src/ai-gateway/tools/email'
import { createReportReadTools } from '../../../src/ai-gateway/tools/report'
import {
  emailBodySchema,
  emailSearchSchema,
  reportGetSchema
} from '../../../src/ai-gateway/tools/schemas'
import { mockDomain, okEnvelope, runTool } from './_helpers'

const EMAIL_ITEMS = [
  { internal_id: 1, subject: 'redis timeout', sender: 'a@x.test', date_received: '2026-06-01' },
  { internal_id: 2, subject: 'redis config', sender: 'b@x.test', date_received: '2026-06-02' }
]

describe('snapshot — email_search', () => {
  test('output pins {count, items}', async () => {
    const gateway = createEmailReadTools(mockDomain(() => okEnvelope(EMAIL_ITEMS)))

    const input = { subject_contains: 'redis', limit: 10 }
    const gatewayOut = await runTool(gateway.email_search, emailSearchSchema.parse(input))

    expect(gatewayOut).toEqual({ count: 2, items: EMAIL_ITEMS })
  })
})

describe('snapshot — email_body (truncation)', () => {
  test('output pins the truncated content + `…[truncated]` marker', async () => {
    const body = {
      internal_id: 5,
      content: 'y'.repeat(5000),
      size_bytes: 5000,
      fetched_at: 999,
      fetched_source: 'mime'
    }
    const gateway = createEmailReadTools(mockDomain(() => okEnvelope(body)))

    const input = { internal_id: 5, max_chars: 2000 }
    const gatewayOut = await runTool(gateway.email_body, emailBodySchema.parse(input))

    expect(gatewayOut).toEqual({
      internal_id: 5,
      content: 'y'.repeat(2000) + '\n\n…[truncated]',
      size_bytes: 5000,
      fetched_at: 999,
      fetched_source: 'mime',
      format: 'markdown'
    })
  })
})

describe('snapshot — report_get (found / not-found)', () => {
  test('not found → {found:false, report_id}', async () => {
    const gateway = createReportReadTools(mockDomain(() => okEnvelope(null)))

    const input = { report_id: 'daily:daily:2026-06-01' }
    const gatewayOut = await runTool(gateway.report_get, reportGetSchema.parse(input))

    expect(gatewayOut).toEqual({ found: false, report_id: 'daily:daily:2026-06-01' })
  })

  test('found → {found:true, report_id, ...detail}', async () => {
    const detail = { id: 'r1', cadence: 'daily', headline: 'h', doc: null } as never
    const gateway = createReportReadTools(mockDomain(() => okEnvelope(detail)))

    const input = { report_id: 'r1' }
    const gatewayOut = await runTool(gateway.report_get, reportGetSchema.parse(input))

    expect(gatewayOut).toEqual({
      found: true,
      report_id: 'r1',
      id: 'r1',
      cadence: 'daily',
      headline: 'h',
      doc: null
    })
  })
})
