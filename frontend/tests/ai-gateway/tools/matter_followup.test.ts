// Matters MVP P4 — the follow-up run's tool surface (D6) + the two review-side tools (D8).
//
// Covers what the venue test in ai-gateway/agent_run.test.ts cannot see from the outside:
//   * matter_update_propose — registration condition (a Matter+run anchor), silence (no approval
//     card), and the server-stamped identity (matter/run come from the closure, never the input).
//   * matter_review_update — the DYNAMIC approval verdict (non-manual 恒卡 / manual reject 免卡 /
//     manual accept touching a `field` change 弹卡 / unreadable payload fail-closed).
//   * matter_run_control — start/cancel wire shape + the structurally absent trigger_kind.
//   * the email read tools' Matter scoping: list/search narrowing vs. email_get's membership guard
//     (G5 — the manual filter must NOT start policing email_get).

import { describe, expect, test } from 'vitest'
import type { Tool } from 'ai'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import { createMatterRunTools, createMatterWriteTools } from '../../../src/ai-gateway/tools/matters'
import { createEmailReadTools } from '../../../src/ai-gateway/tools/email'
import {
  matterReviewUpdateSchema,
  matterRunControlSchema,
  matterUpdateProposeSchema
} from '../../../src/ai-gateway/tools/schemas'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import type { AgentContextMode } from '../../../src/ai-gateway/tools/policy'
import type { MailAgentDomainClient } from '../../../src/ai-gateway/python/domainClient'
import { mockDomain, okEnvelope, runTool } from './_helpers'

const MATTER_RUN = { matterId: 42, publicId: 'MAT-000042', runId: 7 }

/** Drive a write tool's full HITL two-call shape (needsApproval registers the approval record the
 *  guard then verifies at execute) — the write_preview.test.ts idiom. */
async function approveAndRun(tool: Tool, input: unknown, toolCallId = 'tc-1'): Promise<unknown> {
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId, messages: [] })
  const exec = tool.execute as (i: unknown, o: unknown) => Promise<unknown>
  return exec(input, { toolCallId, messages: [], abortSignal: undefined })
}

/** Record every request the tool made so the wire shape (path + body) is assertable. */
function recordingDomain(payload: unknown = { ok: true }) {
  const calls: Array<{ url: string; body: unknown }> = []
  const domain = mockDomain((url, body) => {
    calls.push({ url, body: body === undefined ? undefined : JSON.parse(body) })
    return okEnvelope(payload)
  })
  return { domain, calls }
}

function buildRunTools(over?: { matterToolsEnabled?: boolean; anchor?: typeof MATTER_RUN | null }) {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    approvalGuard: new ApprovalGuard(),
    matterToolsEnabled: over?.matterToolsEnabled ?? true,
    contextMode: 'matter_followup',
    agentRunContext: {
      agentId: 'matter:MAT-000042',
      allowedTools: [],
      skills: ['email', 'search'],
      ...(over?.anchor === null ? {} : { matterRun: over?.anchor ?? MATTER_RUN })
    }
  })
}

describe('matter_update_propose — registration is anchored to a run (D6)', () => {
  test('registers only with a Matter+run anchor; silent (no approval hook)', () => {
    const tools = buildRunTools()
    expect(tools.matter_update_propose).toBeDefined()
    // artifact class + auditedReadTool → no needsApproval hook at all (report_write precedent).
    expect(
      (tools.matter_update_propose as { needsApproval?: unknown }).needsApproval
    ).toBeUndefined()
  })

  test('no anchor → absent, even in the matter_followup mode with the flag on', () => {
    expect(buildRunTools({ anchor: null }).matter_update_propose).toBeUndefined()
  })

  test('MAILAGENT_MATTERS_ENABLED off → absent even with an anchor (the family flag still rules)', () => {
    expect(buildRunTools({ matterToolsEnabled: false }).matter_update_propose).toBeUndefined()
  })

  test('MAILAGENT_MATTER_AGENT_ENABLED explicitly false → absent (the registration-side belt)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      matterToolsEnabled: true,
      matterAgentEnabled: false,
      contextMode: 'matter_followup',
      agentRunContext: {
        agentId: 'matter:MAT-000042',
        allowedTools: [],
        skills: ['email', 'search'],
        matterRun: MATTER_RUN
      }
    })
    expect(tools.matter_update_propose).toBeUndefined()
    expect(tools.matter_get).toBeDefined() // only the run tool is withdrawn
  })

  test('a manual assembly never carries it (no run context exists there)', () => {
    const manual = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      matterToolsEnabled: true,
      contextMode: 'manual_chat',
      matterScopeFilter: { matterId: 42 }
    })
    expect(manual.matter_update_propose).toBeUndefined()
    expect(manual.matter_find).toBeDefined() // the rest of the family is there
  })
})

describe('matter_update_propose — identity is stamped, never taken from the model', () => {
  test('the Matter + run ride in the PATH; the body is the proposal verbatim', async () => {
    const { domain, calls } = recordingDomain({ update_id: 5 })
    const tools = createMatterRunTools(domain, [], MATTER_RUN)
    await runTool(tools.matter_update_propose, {
      summary: '客户已确认启动日期',
      changes: [
        {
          id: 'chg_01',
          kind: 'field',
          target: { entity: 'matter', id: 'MAT-000042', field: 'status' },
          operation: 'replace',
          before: 'planned',
          after: 'active',
          sources: [{ resource_id: 91, evidence: '邮件正文第 3 段' }]
        }
      ],
      open_questions: ['是否需要同步给法务？'],
      confidence: 0.8
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/matters/MAT-000042/runs/7/proposal')
    const body = calls[0].body as Record<string, unknown>
    // 🔴 no matter_id / run_id / watermark keys leave the gateway — the server stamps them.
    expect(Object.keys(body).sort()).toEqual(['changes', 'confidence', 'open_questions', 'summary'])
  })

  test('the schema has no identity/watermark fields at all (they are unrepresentable)', () => {
    const parsed = matterUpdateProposeSchema.safeParse({
      summary: 's',
      changes: [],
      matter_id: 'MAT-000001',
      run_id: 99,
      anchored_matter_version: 3
    })
    // .strict() — a model that tries to address another Matter/run fails validation outright.
    expect(parsed.success).toBe(false)
  })

  test('a change carrying more than five sources is rejected (bounded evidence)', () => {
    const change = {
      id: 'chg_01',
      kind: 'fact',
      sources: Array.from({ length: 6 }, (_, i) => ({ resource_id: i + 1 }))
    }
    expect(matterUpdateProposeSchema.safeParse({ summary: 's', changes: [change] }).success).toBe(
      false
    )
  })
})

describe('matter_run_control — start/cancel wire shape (D8)', () => {
  const writeTools = (
    domain: MailAgentDomainClient,
    contextMode: AgentContextMode = 'manual_chat'
  ) => createMatterWriteTools(domain, [], new ApprovalGuard(), { contextMode })

  test('start posts a mutation-only envelope and carries NO trigger_kind', async () => {
    const { domain, calls } = recordingDomain({ run: { id: 3 }, coalesced: false })
    await approveAndRun(writeTools(domain).matter_run_control, {
      public_id: 'MAT-000042',
      operation: 'start',
      expected_version: 4,
      idempotency_key: 'idem-1'
    })
    expect(calls[0].url).toContain('/matters/MAT-000042/runs')
    const body = calls[0].body as { mutation: Record<string, unknown> }
    expect(Object.keys(body)).toEqual(['mutation'])
    expect(body.mutation.expected_version).toBe(4)
    expect(body.mutation.source).toBe('ai_gateway')
  })

  test('cancel targets the run path; run_id is required for cancel and forbidden for start', async () => {
    const { domain, calls } = recordingDomain({ run: { id: 3 } })
    await approveAndRun(writeTools(domain).matter_run_control, {
      public_id: 'MAT-000042',
      operation: 'cancel',
      run_id: 3
    })
    expect(calls[0].url).toContain('/matters/MAT-000042/runs/3/cancel')
    expect(matterRunControlSchema.safeParse({ public_id: 'M', operation: 'cancel' }).success).toBe(
      false
    )
    expect(
      matterRunControlSchema.safeParse({ public_id: 'M', operation: 'start', run_id: 3 }).success
    ).toBe(false)
  })

  test("trigger_kind is not a field — a forged 'schedule' start cannot reach the wire", () => {
    // The schema has no such key, so zod DROPS it (the family's non-strict top-level shape) and
    // the domain client builds the body itself: nothing the model writes can become a trigger kind.
    const parsed = matterRunControlSchema.safeParse({
      public_id: 'MAT-000042',
      operation: 'start',
      trigger_kind: 'schedule'
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && 'trigger_kind' in parsed.data).toBe(false)
  })
})

describe('matter_review_update — schema refinements (contracts §4.4)', () => {
  const base = { public_id: 'MAT-000042', update_id: 5, expected_version: 4 }

  test('reject requires a reason and forbids selection/edits', () => {
    expect(matterReviewUpdateSchema.safeParse({ ...base, decision: 'reject' }).success).toBe(false)
    expect(
      matterReviewUpdateSchema.safeParse({ ...base, decision: 'reject', reason: 'stale' }).success
    ).toBe(true)
    expect(
      matterReviewUpdateSchema.safeParse({
        ...base,
        decision: 'reject',
        reason: 'stale',
        selected_change_ids: ['chg_01']
      }).success
    ).toBe(false)
  })

  test('accept requires selected_change_ids to be PRESENT; [] is the summary-only case', () => {
    expect(matterReviewUpdateSchema.safeParse({ ...base, decision: 'accept' }).success).toBe(false)
    expect(
      matterReviewUpdateSchema.safeParse({ ...base, decision: 'accept', selected_change_ids: [] })
        .success
    ).toBe(true)
  })

  test('an edited change must reference a SELECTED change id', () => {
    expect(
      matterReviewUpdateSchema.safeParse({
        ...base,
        decision: 'accept',
        selected_change_ids: ['chg_01'],
        edited_changes: [{ change_id: 'chg_09', after: 'x' }]
      }).success
    ).toBe(false)
    expect(
      matterReviewUpdateSchema.safeParse({
        ...base,
        decision: 'accept',
        selected_change_ids: ['chg_01'],
        edited_changes: [{ change_id: 'chg_01', after: 'x' }]
      }).success
    ).toBe(true)
  })
})

describe('matter_review_update — the dynamic approval verdict (D8)', () => {
  /** The proposal the seam fetches: one `field` change + one `fact` change. */
  const UPDATE_PAYLOAD = {
    update: {
      id: 5,
      changes: [
        { id: 'chg_01', kind: 'field' },
        { id: 'chg_02', kind: 'fact' }
      ]
    }
  }

  function reviewTool(
    contextMode: AgentContextMode,
    payload: unknown = UPDATE_PAYLOAD,
    status?: number
  ) {
    const domain = mockDomain(() =>
      status != null
        ? { status, json: { status: 'error', error: { code: 'E_NOT_FOUND', message: 'x' } } }
        : okEnvelope(payload)
    )
    const tools = createMatterWriteTools(domain, [], new ApprovalGuard(), { contextMode })
    return tools.matter_review_update as {
      needsApproval: (input: unknown, ctx: { toolCallId: string }) => boolean | Promise<boolean>
    }
  }

  const ask = (tool: ReturnType<typeof reviewTool>, input: unknown) =>
    Promise.resolve(tool.needsApproval(input, { toolCallId: 'tc-1' }))

  const accept = (ids: string[]) => ({
    public_id: 'MAT-000042',
    update_id: 5,
    decision: 'accept',
    selected_change_ids: ids,
    expected_version: 4
  })
  const reject = {
    public_id: 'MAT-000042',
    update_id: 5,
    decision: 'reject',
    reason: 'not now',
    expected_version: 4
  }

  test('manual reject → card-free', async () => {
    expect(await ask(reviewTool('manual_chat'), reject)).toBe(false)
  })

  test('manual accept touching a field change → card', async () => {
    expect(await ask(reviewTool('manual_chat'), accept(['chg_01']))).toBe(true)
    expect(await ask(reviewTool('manual_chat'), accept(['chg_01', 'chg_02']))).toBe(true)
  })

  test('manual accept of non-field changes only → card-free', async () => {
    expect(await ask(reviewTool('manual_chat'), accept(['chg_02']))).toBe(false)
    // summary-only acceptance selects nothing → nothing to escalate
    expect(await ask(reviewTool('manual_chat'), accept([]))).toBe(false)
  })

  test.each(['im_chat', 'untrusted_trigger', 'cron_headless'] as const)(
    '%s → 恒卡 even for a reject (the manual venue is the only card-free one)',
    async (mode) => {
      expect(await ask(reviewTool(mode), reject)).toBe(true)
      expect(await ask(reviewTool(mode), accept(['chg_02']))).toBe(true)
    }
  )

  test('matter_followup: not a card — the tool cannot run there at all (class denied)', async () => {
    // A follow-up run never even sees this tool (applyContextModePolicy strips domain_write). If a
    // hand-built assembly smuggled it in, needsApproval returns false ON PURPOSE — pausing on a
    // card for a call that can never execute would be misleading — and execute hard-rejects.
    const tool = reviewTool('matter_followup')
    expect(await ask(tool, reject)).toBe(false)
    await expect(runTool(tool as unknown as Tool, reject)).rejects.toThrow(/E_CONTEXT_MODE_DENIED/)
  })

  test('unreadable / failing proposal fetch → fail-closed card', async () => {
    expect(await ask(reviewTool('manual_chat', undefined, 500), accept(['chg_02']))).toBe(true)
    // shape drift (no changes array anywhere) must not silently auto-allow
    expect(await ask(reviewTool('manual_chat', { update: {} }), accept(['chg_02']))).toBe(true)
  })

  test('a bare row (no `update` wrapper) is also understood', async () => {
    const bare = { id: 5, changes: [{ id: 'chg_01', kind: 'field' }] }
    expect(await ask(reviewTool('manual_chat', bare), accept(['chg_01']))).toBe(true)
    expect(await ask(reviewTool('manual_chat', bare), accept([]))).toBe(false)
  })

  test('accept/reject post to the matching endpoint with the right payload', async () => {
    const { domain, calls } = recordingDomain({ matter: { version: 5 } })
    const tools = createMatterWriteTools(domain, [], new ApprovalGuard(), {
      contextMode: 'manual_chat'
    })
    // 🔴 the approval seam itself GETs the proposal first, so index by URL, not by call order.
    const decisionCall = (kind: 'accept' | 'reject') =>
      calls.find((call) => call.url.endsWith(`/updates/5/${kind}`))?.body as Record<string, unknown>
    await approveAndRun(tools.matter_review_update, accept(['chg_02']), 'tc-accept')
    expect(decisionCall('accept')?.selected_change_ids).toEqual(['chg_02'])
    await approveAndRun(tools.matter_review_update, reject, 'tc-reject')
    expect(decisionCall('reject')?.reason).toBe('not now')
  })
})

describe('email read tools — Matter scoping (G5: list/search narrow, email_get guards)', () => {
  test('a run context scopes list/search AND passes email_get the membership guard', async () => {
    const { domain, calls } = recordingDomain({ items: [] })
    const tools = createEmailReadTools(domain, [], {
      matterScopeFilter: { matterId: 42 },
      matterGetScope: { matterId: 42 }
    })
    await runTool(tools.email_list_filter, { limit: 20 })
    await runTool(tools.email_get, { internal_id: 51201 })
    expect(calls[0].url).toContain('matter_id=42')
    expect(calls[1].url).toContain('matter_scope=42')
  })

  test('the MANUAL shape (filter only) leaves email_get byte-identical to P3', async () => {
    const { domain, calls } = recordingDomain({ items: [] })
    const tools = createEmailReadTools(domain, [], { matterScopeFilter: { matterId: 42 } })
    await runTool(tools.email_list_filter, { limit: 20 })
    await runTool(tools.email_get, { internal_id: 51201 })
    expect(calls[0].url).toContain('matter_id=42')
    expect(calls[1].url).not.toContain('matter_scope')
  })

  test('no scope at all → neither param appears', async () => {
    const { domain, calls } = recordingDomain({ items: [] })
    const tools = createEmailReadTools(domain, [])
    await runTool(tools.email_list_filter, { limit: 20 })
    await runTool(tools.email_get, { internal_id: 51201 })
    expect(calls[0].url).not.toContain('matter_id')
    expect(calls[1].url).not.toContain('matter_scope')
  })

  test('buildGatewayTools derives the run scope from the anchor (no caller filter needed)', async () => {
    const { domain, calls } = recordingDomain({ items: [] })
    const tools = buildGatewayTools({
      domain,
      approvalGuard: new ApprovalGuard(),
      matterToolsEnabled: true,
      contextMode: 'matter_followup',
      agentRunContext: {
        agentId: 'matter:MAT-000042',
        allowedTools: [],
        skills: ['email', 'search'],
        matterRun: MATTER_RUN
      }
    })
    await runTool(tools.email_list_filter, { limit: 20 })
    await runTool(tools.email_get, { internal_id: 51201 })
    expect(calls[0].url).toContain('matter_id=42')
    expect(calls[1].url).toContain('matter_scope=42')
  })
})
