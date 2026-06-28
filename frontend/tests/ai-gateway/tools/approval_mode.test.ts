// PART 2 (auto-approval) — needsApproval gating by approvalMode.
//
// 'always' (default / absent) → every write tool asks (preview + edit), the blocking send asks.
// 'auto-reversible'           → reversible preview-tier writes skip the card (needsApproval false);
//                               edit-tier still asks; the irreversible send ALWAYS asks (safety floor).
// The approval record is always registered (execute's guard.verify + the audit need it), so an
// auto-approved preview write still executes through guard.verify and audits approval_status='approved'.

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { createWriteTools } from '../../../src/ai-gateway/tools/write'
import { createMemoryTools } from '../../../src/ai-gateway/tools/memory'
import { createSendTools } from '../../../src/ai-gateway/tools/send'
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

function writeTools(approvalMode?: GatewayApprovalMode): {
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
  const tools = createWriteTools(domain, collector, guard, { approvalMode })
  return { tools, guard, collector, domainCalls }
}

function memoryTools(approvalMode?: GatewayApprovalMode): { tools: Record<string, Tool> } {
  const collector: GatewayToolAuditEntry[] = []
  const guard = new ApprovalGuard()
  const domain = mockDomain(() => okEnvelope({ saved: true, scope: 'user', key: 'k' }))
  const tools = createMemoryTools(domain, collector, guard, { approvalMode })
  return { tools }
}

function sendTool(): { tool: Tool } {
  const collector: GatewayToolAuditEntry[] = []
  const guard = new ApprovalGuard()
  const domain = mockDomain(() => okEnvelope({ sent: true }))
  const tools = createSendTools(domain, collector, guard, { signingSecret: 's' })
  return { tool: tools.email_prepare_send }
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

  test('memory writes (preview) → needsApproval true', async () => {
    const { tools } = memoryTools('always')
    for (const name of ['memory_write', 'memory_delete']) {
      const needs = await needsApprovalOf(tools[name])(
        { scope: 'user', key: 'k', value: 'v' },
        { toolCallId: `tc-${name}`, messages: [] }
      )
      expect(needs, `${name} should ask in 'always'`).toBe(true)
    }
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

  test('memory writes (preview) → needsApproval false (auto-approved)', async () => {
    const { tools } = memoryTools('auto-reversible')
    for (const name of ['memory_write', 'memory_delete']) {
      const needs = await needsApprovalOf(tools[name])(
        { scope: 'user', key: 'k', value: 'v' },
        { toolCallId: `tc-${name}`, messages: [] }
      )
      expect(needs, `${name} should auto-approve in 'auto-reversible'`).toBe(false)
    }
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
