// chat-panel P4 Phase 03a — buildGatewayTools assembly + audit-collector wiring.
//
// Proves the exact path server.ts uses: cfg.buildTools(collector) → a ToolSet whose
// tools push audit entries into that collector (closure). This is the deterministic
// proof of the audit mechanism that the closure design enables — no streamText tool
// loop / mock model needed.

import { describe, expect, test } from 'vitest'

import { buildGatewayTools, GATEWAY_DEFAULT_TOOL_NAMES } from '../../../src/ai-gateway/tools'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import type { GatewayToolAuditEntry } from '../../../src/ai-gateway/tools/types'
import {
  chatSessionListProvenanceSchema,
  chatSessionListSchema,
  emailSearchSchema
} from '../../../src/ai-gateway/tools/schemas'
import { mockDomain, okEnvelope, runTool } from './_helpers'

describe('buildGatewayTools', () => {
  test('session provenance off keeps catalog tools absent; enabled granted headless registers them', () => {
    const base = { domain: mockDomain(() => okEnvelope([])), sessionToolsEnabled: true } as const
    const off = buildGatewayTools({
      ...base,
      sessionProvenanceEnabled: false,
      contextMode: 'cron_headless',
      agentRunContext: { agentId: 'a', allowedTools: ['chat_session_list'], skills: [] }
    })
    expect(off.agent_catalog_list).toBeUndefined()
    expect(off.agent_catalog_get).toBeUndefined()
    const on = buildGatewayTools({
      ...base,
      sessionProvenanceEnabled: true,
      contextMode: 'cron_headless',
      agentRunContext: { agentId: 'a', allowedTools: ['chat_session_list'], skills: [] }
    })
    expect(on.agent_catalog_list).toBeDefined()
    expect(on.agent_catalog_get).toBeDefined()
    expect(chatSessionListSchema.parse({ agentId: 'ignored' })).toEqual({ limit: 20 })
    expect(chatSessionListProvenanceSchema.parse({ agentId: 'kept' })).toMatchObject({
      agentId: 'kept',
      limit: 20
    })
  })
  test('exposes exactly the default silent tools — no approval requirements', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat'
    })
    expect(Object.keys(tools).sort()).toEqual([...GATEWAY_DEFAULT_TOOL_NAMES].sort())
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
    expect(Object.keys(tools).sort()).toEqual([...GATEWAY_DEFAULT_TOOL_NAMES].sort())
  })

  test('threads the audit collector to the built tools (the server.ts onFinish path)', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const tools = buildGatewayTools(
      { domain: mockDomain(() => okEnvelope([{ internal_id: 1 }])), contextMode: 'manual_chat' },
      collector
    )
    await runTool(tools.email_list_filter, emailSearchSchema.parse({ subject_contains: 'x' }))
    expect(collector).toHaveLength(1)
    expect(collector[0]).toMatchObject({ toolName: 'email_list_filter', status: 'ok' })
    expect(JSON.parse(collector[0].outputJson)).toEqual({ count: 1, items: [{ internal_id: 1 }] })
  })
})

// ── 08-05 WP-11 — owner per-tool 'deny' strips the tool from the MANUAL assembly ───────────────

describe("buildGatewayTools — per-tool 'deny' (WP-11)", () => {
  const guardOpts = () => ({
    domain: mockDomain(() => okEnvelope([])),
    writeToolsEnabled: true,
    approvalGuard: new ApprovalGuard()
  })

  test("an explicit owner 'deny' removes the tool from a manual ToolSet (model cannot see it)", () => {
    const base = buildGatewayTools({ ...guardOpts(), contextMode: 'manual_chat' })
    expect(base.email_flag).toBeDefined()
    const tools = buildGatewayTools({
      ...guardOpts(),
      contextMode: 'manual_chat',
      toolApprovalPrefs: {
        tools: { email_flag: { tier: 'deny', source: 'owner' } },
        sendRecipientWhitelist: []
      }
    })
    expect(tools.email_flag).toBeUndefined()
    expect(tools.email_archive).toBeDefined() // siblings untouched
  })

  test('🔴 the deny strip is approvalMode-independent — bypass does not resurrect a denied tool', () => {
    // check 2026-08-05 — D1=a makes bypass outrank a per-tool 'ask'; deny lives on the
    // AVAILABILITY axis (mirror of connector 'off'), so bypass must never re-register it.
    const tools = buildGatewayTools({
      ...guardOpts(),
      contextMode: 'manual_chat',
      approvalMode: 'bypass',
      toolApprovalPrefs: {
        tools: { email_flag: { tier: 'deny', source: 'owner' } },
        sendRecipientWhitelist: []
      }
    })
    expect(tools.email_flag).toBeUndefined()
    expect(tools.email_archive).toBeDefined()
  })

  test("a 'default'-sourced tier never strips (only explicit owner overrides deny)", () => {
    const tools = buildGatewayTools({
      ...guardOpts(),
      contextMode: 'manual_chat',
      toolApprovalPrefs: {
        tools: { email_flag: { tier: 'deny', source: 'default' } as never },
        sendRecipientWhitelist: []
      }
    })
    expect(tools.email_flag).toBeDefined()
  })

  test('🔴 验收⑤ — prefs are DROPPED for non-manual assemblies (headless matrix zero diff)', () => {
    for (const mode of ['untrusted_trigger', 'cron_headless', 'im_chat'] as const) {
      const withPrefs = buildGatewayTools({
        ...guardOpts(),
        contextMode: mode,
        toolApprovalPrefs: {
          tools: { email_flag: { tier: 'deny', source: 'owner' } },
          sendRecipientWhitelist: []
        }
      })
      const without = buildGatewayTools({ ...guardOpts(), contextMode: mode })
      expect(Object.keys(withPrefs).sort(), mode).toEqual(Object.keys(without).sort())
      expect(withPrefs.email_flag, mode).toBeDefined() // deny never reaches a non-manual matrix
    }
  })
})
