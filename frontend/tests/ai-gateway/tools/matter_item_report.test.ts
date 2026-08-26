// L4 批次3 (task 08-25) — the 行动项 dispatch run's delivery tool.
//
// Covers what the venue test in ai-gateway/agent_run.test.ts cannot see from the outside:
//   * registration is anchored to a DISPATCH (no anchor → absent, even in the matter venue), and
//     it is silent (artifact class, no approval hook — the report_write / matter_update_propose
//     precedent);
//   * identity is stamped from the closure: the schema has no matter / item / dispatch id at all,
//     so the model cannot address another dispatch even by trying;
//   * 🔴 the schema stays FLAT — result XOR needs_input is judged in Python (D11), so a
//     both-shapes / neither-shape input must sail through zod and be REJECTED by the server. A
//     top-level oneOf here is the exact shape that took the tool chain down twice.

import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  createMatterItemRunTools,
  GATEWAY_MATTER_ITEM_RUN_TOOL_NAMES
} from '../../../src/ai-gateway/tools/matters'
import { matterItemReportSchema } from '../../../src/ai-gateway/tools/schemas'
import { MATTER_ITEM_REPORT_TOOL } from '../../../src/ai-gateway/tools/policy'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import type { MailAgentDomainClient } from '../../../src/ai-gateway/python/domainClient'
import { mockDomain, okEnvelope, runTool } from './_helpers'

const ITEM_RUN = { matterId: 42, publicId: 'MAT-000042', itemId: 9, dispatchId: 3 }

function buildItemRunTools(over?: { anchor?: typeof ITEM_RUN | null }) {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope({})),
    approvalGuard: new ApprovalGuard(),
    contextMode: 'matter_followup',
    agentRunContext: {
      agentId: 'matter_item:MAT-000042:9',
      allowedTools: [],
      skills: [],
      ...(over?.anchor === null ? {} : { matterItemRun: over?.anchor ?? ITEM_RUN })
    }
  })
}

describe('matter_item_report — registration is anchored to a dispatch', () => {
  test('registers with an item+dispatch anchor; silent (no approval hook)', () => {
    const tools = buildItemRunTools()
    expect(tools.matter_item_report).toBeDefined()
    expect((tools.matter_item_report as { needsApproval?: unknown }).needsApproval).toBeUndefined()
  })

  test('no anchor → absent, even in the matter venue', () => {
    expect(buildItemRunTools({ anchor: null }).matter_item_report).toBeUndefined()
  })

  test('a manual assembly never carries it, and a follow-up run gets the OTHER channel', () => {
    const manual = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    expect(manual.matter_item_report).toBeUndefined()
    expect(manual.matter_find).toBeDefined() // the rest of the family is there

    const followUp = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'matter_followup',
      agentRunContext: {
        agentId: 'matter:MAT-000042',
        allowedTools: [],
        skills: [],
        matterRun: { matterId: 42, publicId: 'MAT-000042', runId: 7 }
      }
    })
    expect(followUp.matter_item_report).toBeUndefined()
    expect(followUp.matter_update_propose).toBeDefined()
  })

  test('the by-name admission constant === the tool module name array (one hand-copy, one gate)', () => {
    // 🔴 policy.ts cannot import tools/matters.ts (class layer = zero-dependency root), so the
    // name lives in two places. Without this gate a rename would silently stop the matrix from
    // admitting it — the run would drain with no way to deliver anything.
    expect([MATTER_ITEM_REPORT_TOOL]).toEqual([...GATEWAY_MATTER_ITEM_RUN_TOOL_NAMES])
  })
})

describe('matter_item_report — identity is stamped, never taken from the model', () => {
  test('the closure supplies publicId + dispatchId; the input carries neither', async () => {
    const calls: Array<[string, number, Record<string, unknown>]> = []
    const domain = {
      reportItemDispatch: async (
        publicId: string,
        dispatchId: number,
        report: Record<string, unknown>
      ) => {
        calls.push([publicId, dispatchId, report])
        return { dispatch_id: dispatchId, state: 'proposed', update_id: 11, dropped: [] }
      }
    } as unknown as MailAgentDomainClient
    const tools = createMatterItemRunTools(domain, [], ITEM_RUN)

    const out = await runTool(tools.matter_item_report, {
      summary: '对方已回签',
      changes: [
        {
          id: 'chg_01',
          kind: 'action',
          target: { entity: 'item', id: 9 },
          after: 'done',
          sources: []
        }
      ]
    })

    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('MAT-000042')
    expect(calls[0][1]).toBe(3)
    expect(out).toMatchObject({ state: 'proposed', update_id: 11 })
    // there is no id-shaped key the model could have set
    expect(Object.keys(calls[0][2]).sort()).toEqual(['changes', 'summary'])
  })

  test('anchor keys are structurally unrepresentable in the input schema', () => {
    const rejected = matterItemReportSchema.safeParse({
      summary: 'x',
      dispatch_id: 999,
      public_id: 'MAT-000099'
    })
    expect(rejected.success).toBe(false)
  })
})

describe('matter_item_report — the schema is FLAT (branch rules live in Python, D11)', () => {
  test('both shapes at once parse fine here — the server is the judge', () => {
    const parsed = matterItemReportSchema.safeParse({
      summary: '写了一半',
      needs_input: { question: '还有个问题' }
    })
    expect(parsed.success).toBe(true)
  })

  test('an empty object parses too (neither shape) — again the server rejects it', () => {
    expect(matterItemReportSchema.safeParse({}).success).toBe(true)
  })

  test('the JSON schema has no top-level branch keyword', () => {
    // `io: 'input'` because the change schema carries a leaf transform (happened_at 宽收严归一)
    // — the same call shape matter_followup.test.ts uses for matterUpdateProposeSchema.
    const json = z.toJSONSchema(matterItemReportSchema, { io: 'input' }) as Record<string, unknown>
    for (const keyword of ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'dependentRequired']) {
      expect(
        json[keyword],
        `${keyword} at the top level is the two-time outage shape`
      ).toBeUndefined()
    }
    expect(json.required, 'a conditional/required top level is the same trap').toBeUndefined()
  })

  test('needs_input still validates its own leaf shape (empty question rejected)', () => {
    expect(matterItemReportSchema.safeParse({ needs_input: { question: '   ' } }).success).toBe(
      false
    )
    expect(
      matterItemReportSchema.safeParse({ needs_input: { question: '选哪个？', options: ['A'] } })
        .success
    ).toBe(true)
  })
})
