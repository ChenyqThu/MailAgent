import { describe, expect, test } from 'vitest'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import { createReportTools } from '../../../src/ai-gateway/tools/report'
import { reportWriteSchema } from '../../../src/ai-gateway/tools/schemas'
import type { GatewayToolAuditCollector } from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope, runTool } from './_helpers'

const DETAIL = {
  id: 'agent-7:custom:2026-07-31:0001',
  agent_id: 'agent-7',
  cadence: 'custom',
  report_date: '2026-07-31',
  window_start: '2026-07-31T12:00:00Z',
  window_end: '2026-07-31T12:00:00Z',
  status: 'ready',
  counts: { total: 2 },
  headline: 'Daily decisions',
  model: 'custom-agent',
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  error: null,
  created_at: 1,
  generated_at: 1,
  doc: null
}

describe('report_write', () => {
  test('uses the trusted run agent id and records a silent audit row', async () => {
    let requestBody: Record<string, unknown> | undefined
    const collector: GatewayToolAuditCollector = []
    const domain = mockDomain((_url, body) => {
      requestBody = JSON.parse(body ?? '{}') as Record<string, unknown>
      return okEnvelope(DETAIL)
    })
    const tools = createReportTools(domain, collector, 'agent-7')
    const input = reportWriteSchema.parse({
      title: 'Daily decisions',
      mode: 'new',
      blocks: [{ type: 'overview', text: 'Two decisions need review.' }]
    })

    await expect(runTool(tools.report_write, input)).resolves.toEqual({
      report_id: DETAIL.id,
      title: 'Daily decisions',
      mode: 'new',
      status: 'ready',
      cadence: 'custom'
    })
    expect(requestBody).toEqual({ agentId: 'agent-7', ...input })
    expect(collector).toHaveLength(1)
    expect(collector[0]).toMatchObject({
      toolName: 'report_write',
      status: 'ok'
    })
    expect(collector[0].confirmationTier).toBeUndefined()
  })

  test.each(['manual_chat', 'untrusted_trigger', 'cron_headless'] as const)(
    'is registered in %s because artifact writes are local and reversible',
    (contextMode) => {
      const tools = buildGatewayTools({
        domain: mockDomain(() => okEnvelope(DETAIL)),
        contextMode,
        agentRunContext: { agentId: 'agent-7' }
      })
      expect(tools.report_write).toBeDefined()
    }
  )

  test('manual assembly uses the built-in assistant identity', async () => {
    let requestBody: Record<string, unknown> | undefined
    const tools = createReportTools(
      mockDomain((_url, body) => {
        requestBody = JSON.parse(body ?? '{}') as Record<string, unknown>
        return okEnvelope({ ...DETAIL, agent_id: 'custom_ai' })
      })
    )
    const input = reportWriteSchema.parse({
      title: 'Manual artifact',
      blocks: [{ type: 'quote', text: 'Local only.' }]
    })
    await runTool(tools.report_write, input)
    expect(requestBody?.agentId).toBe('custom_ai')
  })
})
