// PART 2 (auto-approval) — needsApproval gating by approvalMode.
//
// 'always' (default / absent) → every write tool asks (preview + edit), the blocking send asks.
// 'auto-reversible'           → reversible preview-tier writes skip the card (needsApproval false);
//                               edit-tier still asks; the irreversible send ALWAYS asks (safety floor).
// The approval record is always registered (execute's guard.verify + the audit need it), so an
// auto-approved preview write still executes through guard.verify and audits approval_status='approved'.
//
// S2 W0 (ADR-001 D3) — auto-approve additionally requires class==='domain_write' AND
// contextMode==='manual_chat': a preview-tier capability change (set_skill_enabled) now ALWAYS
// asks (the auto-reversible escape is closed), and outside manual_chat nothing auto-approves.
// Test factories pass contextMode:'manual_chat' explicitly (the run-mode a renderer session has);
// the mode is a trusted server parameter, fail-closed 'untrusted_trigger' when absent.

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { createWriteTools } from '../../../src/ai-gateway/tools/write'
import { createSendTools } from '../../../src/ai-gateway/tools/send'
import { createSelfMountTools } from '../../../src/ai-gateway/tools/self_mount'
import type { AgentContextMode } from '../../../src/ai-gateway/tools/policy'
import type {
  GatewayApprovalMode,
  GatewayToolAuditEntry
} from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope } from './_helpers'

const needsApprovalOf = (tool: Tool) =>
  tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
const executeOf = (tool: Tool) =>
  tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>

function writeTools(
  approvalMode?: GatewayApprovalMode,
  contextMode: AgentContextMode | undefined = 'manual_chat'
): {
  tools: Record<string, Tool>
  guard: ApprovalGuard
  collector: GatewayToolAuditEntry[]
  domainCalls: string[]
} {
  const collector: GatewayToolAuditEntry[] = []
  const guard = new ApprovalGuard()
  const domainCalls: string[] = []
  const domain = mockDomain((url) => {
    domainCalls.push(url)
    return okEnvelope({ updated_ids: [9], outbox_entries: [], is_pinned: true, changed: true })
  })
  const tools = createWriteTools(domain, collector, guard, { approvalMode, contextMode })
  return { tools, guard, collector, domainCalls }
}

function sendTool(): { tool: Tool } {
  const collector: GatewayToolAuditEntry[] = []
  const guard = new ApprovalGuard()
  const domain = mockDomain(() => okEnvelope({ sent: true }))
  const tools = createSendTools(domain, collector, guard, {
    signingSecret: 's',
    contextMode: 'manual_chat'
  })
  return { tool: tools.email_prepare_send }
}

function selfMountTools(
  approvalMode?: GatewayApprovalMode,
  contextMode: AgentContextMode | undefined = 'manual_chat'
): { tools: Record<string, Tool>; collector: GatewayToolAuditEntry[] } {
  const collector: GatewayToolAuditEntry[] = []
  const domain = mockDomain(() => okEnvelope({ name: 'email', enabled: true }))
  const tools = createSelfMountTools(domain, collector, new ApprovalGuard(), {
    approvalMode,
    contextMode
  })
  return { tools, collector }
}

describe("approvalMode 'always' (default) — every write asks", () => {
  test('preview-tier (email_flag / email_pin / email_archive / email_resync) → needsApproval true', async () => {
    const { tools } = writeTools('always')
    for (const name of ['email_flag', 'email_pin', 'email_archive', 'email_resync']) {
      const needs = await needsApprovalOf(tools[name])(
        { internal_id: 9, is_flagged: true, pinned: true },
        { toolCallId: `tc-${name}`, messages: [] }
      )
      expect(needs, `${name} should ask in 'always'`).toBe(true)
    }
  })

  test('edit-tier (email_draft_reply) → needsApproval true', async () => {
    const { tools } = writeTools('always')
    const needs = await needsApprovalOf(tools.email_draft_reply)(
      { internal_id: 9, body_markdown: 'hi' },
      { toolCallId: 'tc-draft', messages: [] }
    )
    expect(needs).toBe(true)
  })

  test('absent approvalMode behaves like always (preview asks)', async () => {
    const { tools } = writeTools(undefined)
    const needs = await needsApprovalOf(tools.email_flag)(
      { internal_id: 9, is_flagged: true },
      { toolCallId: 'tc1', messages: [] }
    )
    expect(needs).toBe(true)
  })
})

describe("approvalMode 'auto-reversible' — reversible preview writes skip the card", () => {
  test('preview-tier writes → needsApproval false (no card)', async () => {
    const { tools } = writeTools('auto-reversible')
    for (const name of ['email_flag', 'email_pin', 'email_archive', 'email_resync']) {
      const needs = await needsApprovalOf(tools[name])(
        { internal_id: 9, is_flagged: true, pinned: true },
        { toolCallId: `tc-${name}`, messages: [] }
      )
      expect(needs, `${name} should auto-approve in 'auto-reversible'`).toBe(false)
    }
  })

  test('edit-tier (email_draft_reply) STILL asks → needsApproval true', async () => {
    const { tools } = writeTools('auto-reversible')
    const needs = await needsApprovalOf(tools.email_draft_reply)(
      { internal_id: 9, body_markdown: 'hi' },
      { toolCallId: 'tc-draft', messages: [] }
    )
    expect(needs).toBe(true)
  })

  test('an auto-approved preview write still registers + verifies + executes + audits approved', async () => {
    const { tools, domainCalls, collector } = writeTools('auto-reversible')
    const input = { internal_id: 9, is_flagged: true }
    // needsApproval returns false (no card) AND registers the record (side-effect).
    const needs = await needsApprovalOf(tools.email_flag)(input, {
      toolCallId: 'tc1',
      messages: []
    })
    expect(needs).toBe(false)
    // ai@6 then runs execute in the SAME call; guard.verify finds the record + hash matches.
    const out = await executeOf(tools.email_flag)(input, { toolCallId: 'tc1', messages: [] })
    expect(out).toMatchObject({ internal_id: 9, user_edited: false })
    expect(domainCalls).toHaveLength(1) // the write actually ran
    expect(collector[0]).toMatchObject({
      toolName: 'email_flag',
      status: 'ok',
      confirmationTier: 'preview',
      approvalStatus: 'approved' // auto-approved still audits 'approved' (no new enum)
    })
    expect(collector[0].approvalHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('blocking send (email_prepare_send) — ALWAYS asks regardless of mode (safety floor)', () => {
  // The send tool takes no approvalMode param; its needsApproval hard-returns true. There is no
  // mode threading that can relax it — assert it asks even though we built it with no mode (= the
  // gateway never passes a mode to createSendTools).
  test('needsApproval true (the tool has no path to auto-approve)', async () => {
    const { tool } = sendTool()
    const needs = await needsApprovalOf(tool)(
      { to: ['x@corp.test'], subject: 's', body_markdown: 'b' },
      { toolCallId: 'tc-send', messages: [] }
    )
    expect(needs).toBe(true)
  })
})

// ── S2 W0 (ADR-001 D3) — contextMode × toolClass matrix ────────────────────────────────────────

describe('S2 W0 — set_skill_enabled (preview + capability_change) NEVER auto-approves', () => {
  // 🔴 The escape codex flagged: pre-W0, auto-reversible skipped the card for EVERY preview-tier
  // write, including set_skill_enabled → a poisoned run could silently enable capabilities. The
  // predicate now requires class==='domain_write', so the capability change always asks. This is
  // a DELIBERATE behaviour change (unflagged security fix) — the old "preview ⇒ skip" assertion
  // is inverted for this tool.
  test('auto-reversible + manual_chat → set_skill_enabled STILL pauses (needsApproval true)', async () => {
    const { tools } = selfMountTools('auto-reversible')
    const needs = await needsApprovalOf(tools.set_skill_enabled)(
      { skill_name: 'email', enabled: true },
      { toolCallId: 'tc-skill', messages: [] }
    )
    expect(needs).toBe(true)
  })

  test("update_system_md (edit + capability_change) still asks in auto-reversible (unchanged)", async () => {
    const { tools } = selfMountTools('auto-reversible')
    const needs = await needsApprovalOf(tools.update_system_md)(
      { doc_name: 'agent', content: 'x' },
      { toolCallId: 'tc-doc', messages: [] }
    )
    expect(needs).toBe(true)
  })
})

describe('S2 W0 — auto-approve requires manual_chat (domain_write in a non-manual run asks)', () => {
  test.each(['untrusted_trigger', 'cron_headless'] as const)(
    'auto-reversible + %s → email_flag (preview + domain_write) still asks',
    async (mode) => {
      const { tools } = writeTools('auto-reversible', mode)
      const needs = await needsApprovalOf(tools.email_flag)(
        { internal_id: 9, is_flagged: true },
        { toolCallId: 'tc1', messages: [] }
      )
      expect(needs).toBe(true)
    }
  )

  test('absent contextMode fail-closes: auto-reversible does NOT skip the card', async () => {
    // Build WITHOUT a contextMode key at all (the helper's default would re-fill 'manual_chat'
    // on an explicit undefined) — the factory must fail-close to untrusted_trigger.
    const tools = createWriteTools(
      mockDomain(() => okEnvelope({ updated_ids: [9] })),
      [],
      new ApprovalGuard(),
      { approvalMode: 'auto-reversible' }
    )
    const needs = await needsApprovalOf(tools.email_flag)(
      { internal_id: 9, is_flagged: true },
      { toolCallId: 'tc1', messages: [] }
    )
    expect(needs).toBe(true)
  })
})

describe('S2 W0 — runtime double-insurance: a mode-denied tool hard-rejects at execute', () => {
  // Registration-time filtering (applyContextModePolicy) normally keeps a capability_change/
  // outbound tool OUT of a non-manual ToolSet — these assertions drive the factory directly to
  // prove the second line of defense: no card (needsApproval false, no misleading pause) and a
  // typed E_CONTEXT_MODE_DENIED tool-error, with the write never reaching the domain.
  test('set_skill_enabled under untrusted_trigger → no card + execute rejects, domain untouched', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const domainCalls: string[] = []
    const domain = mockDomain((url) => {
      domainCalls.push(url)
      return okEnvelope({ name: 'email', enabled: true })
    })
    const tools = createSelfMountTools(domain, collector, new ApprovalGuard(), {
      contextMode: 'untrusted_trigger'
    })
    const input = { skill_name: 'email', enabled: true }
    const needs = await needsApprovalOf(tools.set_skill_enabled)(input, {
      toolCallId: 'tc-deny',
      messages: []
    })
    expect(needs).toBe(false) // no approval card — the tool can never execute in this mode
    await expect(
      executeOf(tools.set_skill_enabled)(input, { toolCallId: 'tc-deny', messages: [] })
    ).rejects.toThrow(/E_CONTEXT_MODE_DENIED/)
    expect(domainCalls).toHaveLength(0) // the write never ran
    expect(collector[0]).toMatchObject({
      toolName: 'set_skill_enabled',
      status: 'error',
      confirmationTier: 'preview',
      approvalStatus: 'rejected'
    })
  })

  test('email_prepare_send under cron_headless → execute rejects even after an approved card', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const guard = new ApprovalGuard()
    const domainCalls: string[] = []
    const domain = mockDomain((url) => {
      domainCalls.push(url)
      return okEnvelope({ sent: true })
    })
    const tools = createSendTools(domain, collector, guard, {
      signingSecret: 's',
      contextMode: 'cron_headless'
    })
    const input = { to: ['x@corp.test'], subject: 's', body_markdown: 'b' }
    // needsApproval keeps its hard true (safety floor unchanged) — but even a user-approved send
    // cannot execute outside a manual session.
    const needs = await needsApprovalOf(tools.email_prepare_send)(input, {
      toolCallId: 'tc-send-deny',
      messages: []
    })
    expect(needs).toBe(true)
    await expect(
      executeOf(tools.email_prepare_send)(input, { toolCallId: 'tc-send-deny', messages: [] })
    ).rejects.toThrow(/E_CONTEXT_MODE_DENIED/)
    expect(domainCalls).toHaveLength(0)
  })

  test('email_flag (domain_write) under untrusted_trigger is NOT mode-denied (HITL path intact)', async () => {
    const { tools, domainCalls } = writeTools('always', 'untrusted_trigger')
    const input = { internal_id: 9, is_flagged: true }
    const needs = await needsApprovalOf(tools.email_flag)(input, {
      toolCallId: 'tc-dw',
      messages: []
    })
    expect(needs).toBe(true) // asks (never auto in non-manual) …
    const out = await executeOf(tools.email_flag)(input, { toolCallId: 'tc-dw', messages: [] })
    expect(out).toMatchObject({ internal_id: 9 }) // … and executes after approval
    expect(domainCalls).toHaveLength(1)
  })
})
