// chat-panel P4 Phase 03a — buildGatewayTools assembly + audit-collector wiring.
//
// Proves the exact path server.ts uses: cfg.buildTools(collector) → a ToolSet whose
// tools push audit entries into that collector (closure). This is the deterministic
// proof of the audit mechanism that the closure design enables — no streamText tool
// loop / mock model needed.

import { describe, expect, test } from 'vitest'

import { buildGatewayTools, GATEWAY_READ_TOOL_NAMES } from '../../../src/ai-gateway/tools'
import type { GatewayToolAuditEntry } from '../../../src/ai-gateway/tools/types'
import { emailSearchSchema } from '../../../src/ai-gateway/tools/schemas'
import { mockDomain, okEnvelope, runTool } from './_helpers'

describe('buildGatewayTools', () => {
  test('exposes exactly the 9 read tools — read-only (no write tools, none need approval)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat'
    })
    expect(Object.keys(tools).sort()).toEqual([...GATEWAY_READ_TOOL_NAMES].sort())
    for (const name of Object.keys(tools)) {
      expect(typeof tools[name].execute).toBe('function')
      // read-only scope: no write tool, and no read tool carries needsApproval.
      expect((tools[name] as { needsApproval?: unknown }).needsApproval).toBeUndefined()
    }
  })

  test('writeToolsEnabled gate is a no-op in 03a (still read-only)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      writeToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    expect(Object.keys(tools).sort()).toEqual([...GATEWAY_READ_TOOL_NAMES].sort())
  })

  test('threads the audit collector to the built tools (the server.ts onFinish path)', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const tools = buildGatewayTools(
      { domain: mockDomain(() => okEnvelope([{ internal_id: 1 }])), contextMode: 'manual_chat' },
      collector
    )
    await runTool(tools.email_search, emailSearchSchema.parse({ subject_contains: 'x' }))
    expect(collector).toHaveLength(1)
    expect(collector[0]).toMatchObject({ toolName: 'email_search', status: 'ok' })
    expect(JSON.parse(collector[0].outputJson)).toEqual({ count: 1, items: [{ internal_id: 1 }] })
  })
})
