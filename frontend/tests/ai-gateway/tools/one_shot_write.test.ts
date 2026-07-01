// Part B (harness 上岛) — one-shot write claim (single-resolver across island + renderer resume).
//
// When island agent is on the lifecycle passes oneShotWrites → createWriteTools({oneShot:true}) →
// auditedWriteTool consumes the approval on execute, so the SAME approval can execute AT MOST ONCE
// across the two resume paths (island /api/ai/approval/decide + renderer /api/ai/chat). This proves:
//   - oneShot OFF (default) → a second execute of the same toolCallId still runs (byte-identical to
//     the pre-Part-B write path);
//   - oneShot ON → the second execute throws E_APPROVAL_USED and the domain write runs exactly once.

import { describe, expect, test } from 'vitest'
import type { Tool } from 'ai'

import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { createWriteTools } from '../../../src/ai-gateway/tools/write'
import type { GatewayToolAuditEntry } from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope } from './_helpers'

function harness(oneShot: boolean) {
  const collector: GatewayToolAuditEntry[] = []
  const guard = new ApprovalGuard()
  const domainCalls: string[] = []
  const domain = mockDomain((url) => {
    domainCalls.push(url)
    return okEnvelope({ updated_ids: [9], outbox_entries: [] })
  })
  const tools = createWriteTools(domain, collector, guard, { oneShot })
  return { tools, collector, guard, domainCalls }
}

const needsApprovalOf = (tool: Tool) =>
  tool.needsApproval as (i: unknown, o: { toolCallId: string; messages: unknown[] }) => boolean
const executeOf = (tool: Tool) =>
  tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>

const INPUT = { internal_id: 9, is_flagged: true }

describe('one-shot write claim', () => {
  test('oneShot OFF (default) → same toolCallId executes twice (byte-identical pre-Part-B)', async () => {
    const h = harness(false)
    needsApprovalOf(h.tools.email_flag)(INPUT, { toolCallId: 'tc1', messages: [] })
    await executeOf(h.tools.email_flag)(INPUT, { toolCallId: 'tc1', messages: [] })
    // a second execute of the SAME approval still runs (no consume)
    await executeOf(h.tools.email_flag)(INPUT, { toolCallId: 'tc1', messages: [] })
    expect(h.domainCalls).toHaveLength(2)
  })

  test('oneShot ON → second execute throws E_APPROVAL_USED, write runs exactly once', async () => {
    const h = harness(true)
    needsApprovalOf(h.tools.email_flag)(INPUT, { toolCallId: 'tc1', messages: [] })
    await executeOf(h.tools.email_flag)(INPUT, { toolCallId: 'tc1', messages: [] })
    await expect(
      executeOf(h.tools.email_flag)(INPUT, { toolCallId: 'tc1', messages: [] })
    ).rejects.toThrow(/E_APPROVAL_USED/)
    expect(h.domainCalls).toHaveLength(1) // never double-written
    // the second (rejected) attempt audited as rejected
    const rejected = h.collector.filter((e) => e.approvalStatus === 'rejected')
    expect(rejected).toHaveLength(1)
  })

  test('oneShot ON → a normal single approve → execute still succeeds (one consume)', async () => {
    const h = harness(true)
    needsApprovalOf(h.tools.email_flag)(INPUT, { toolCallId: 'tc2', messages: [] })
    const out = await executeOf(h.tools.email_flag)(INPUT, { toolCallId: 'tc2', messages: [] })
    expect(out).toMatchObject({ internal_id: 9 })
    expect(h.domainCalls).toHaveLength(1)
  })
})
