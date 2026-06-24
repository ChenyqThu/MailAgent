// chat-panel P4 Phase 03a — read-tool parity (legacy harness ⋈ AI SDK Gateway).
//
// The migration contract (phase-03 §7): a migrated tool's output must match the legacy
// tool's output key-for-key given the SAME underlying domain data. We drive both
// implementations from one fixture: the legacy ToolDef (createEmailTools / createReportTools
// over a mock ChatToolPlatform) and the gateway tool (createEmailReadTools /
// createReportReadTools over a mockDomain returning the SAME data), then compare the legacy
// `ToolResult.output` against the gateway tool's return value.

import { describe, expect, test } from 'vitest'

import { createEmailTools } from '@shared/chat/tools/builtin/email'
import { createReportTools } from '@shared/chat/tools/builtin/report'
import type { ChatToolPlatform } from '@shared/chat/platform'
import type { ToolDef, ToolExecCtx } from '@shared/chat/tools/registry'

import { createEmailReadTools } from '../../../src/ai-gateway/tools/email'
import { createReportReadTools } from '../../../src/ai-gateway/tools/report'
import {
  emailBodySchema,
  emailSearchSchema,
  reportGetSchema
} from '../../../src/ai-gateway/tools/schemas'
import { mockDomain, okEnvelope, runTool } from './_helpers'

const CTX: ToolExecCtx = { sessionId: 0, emailId: null, signal: new AbortController().signal }

/** Run a legacy ToolDef and unwrap its ToolResult.output (throws on ok:false). */
async function legacyOutput(tools: ToolDef[], name: string, input: unknown): Promise<unknown> {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`legacy tool ${name} not found`)
  const r = await def.handler(input, CTX)
  if (!r.ok) throw new Error(`legacy ${name} failed: ${r.code}`)
  return r.output
}

/** Minimal ChatToolPlatform — only the read primitives the migrated tools call. */
function mockPlatform(over: Partial<ChatToolPlatform>): ChatToolPlatform {
  return over as unknown as ChatToolPlatform
}

const EMAIL_ITEMS = [
  { internal_id: 1, subject: 'redis timeout', sender: 'a@x.test', date_received: '2026-06-01' },
  { internal_id: 2, subject: 'redis config', sender: 'b@x.test', date_received: '2026-06-02' }
]

describe('parity — email_search', () => {
  test('legacy {count, items} === gateway {count, items}', async () => {
    const legacy = createEmailTools(mockPlatform({ listEmails: async () => EMAIL_ITEMS as never }))
    const gateway = createEmailReadTools(mockDomain(() => okEnvelope(EMAIL_ITEMS)))

    const input = { subject_contains: 'redis', limit: 10 }
    const legacyOut = await legacyOutput(legacy, 'email_search', input)
    const gatewayOut = await runTool(gateway.email_search, emailSearchSchema.parse(input))

    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toEqual({ count: 2, items: EMAIL_ITEMS })
  })
})

describe('parity — email_body (truncation)', () => {
  test('legacy truncated output === gateway truncated output', async () => {
    const body = {
      internal_id: 5,
      content: 'y'.repeat(5000),
      size_bytes: 5000,
      fetched_at: 999,
      fetched_source: 'mime'
    }
    const legacy = createEmailTools(mockPlatform({ getEmailBody: async () => body as never }))
    const gateway = createEmailReadTools(mockDomain(() => okEnvelope(body)))

    const input = { internal_id: 5, max_chars: 2000 }
    const legacyOut = await legacyOutput(legacy, 'email_body', input)
    const gatewayOut = await runTool(gateway.email_body, emailBodySchema.parse(input))

    expect(gatewayOut).toEqual(legacyOut)
    expect((gatewayOut as { content: string }).content.endsWith('…[truncated]')).toBe(true)
  })
})

describe('parity — report_get (found / not-found)', () => {
  test('not found → both {found:false, report_id}', async () => {
    const legacy = createReportTools(mockPlatform({ getReport: async () => null }))
    const gateway = createReportReadTools(mockDomain(() => okEnvelope(null)))

    const input = { report_id: 'daily:daily:2026-06-01' }
    const legacyOut = await legacyOutput(legacy, 'report_get', input)
    const gatewayOut = await runTool(gateway.report_get, reportGetSchema.parse(input))

    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toEqual({ found: false, report_id: 'daily:daily:2026-06-01' })
  })

  test('found → both {found:true, report_id, ...detail}', async () => {
    const detail = { id: 'r1', cadence: 'daily', headline: 'h', doc: null } as never
    const legacy = createReportTools(mockPlatform({ getReport: async () => detail }))
    const gateway = createReportReadTools(mockDomain(() => okEnvelope(detail)))

    const input = { report_id: 'r1' }
    const legacyOut = await legacyOutput(legacy, 'report_get', input)
    const gatewayOut = await runTool(gateway.report_get, reportGetSchema.parse(input))

    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toMatchObject({ found: true, report_id: 'r1', id: 'r1' })
  })
})
