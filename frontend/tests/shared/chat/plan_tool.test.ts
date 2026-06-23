// P2d — plan_update tool: the lightweight cross-domain plan / subgoal artifact. Pure
// compute (no platform) → the harness single loop produces/updates it as data, with no
// second orchestration engine. Verifies the silent tier, plan_id derivation, step
// normalization (status clamp + id/domain defaults + evidence coercion), the honest
// 'unavailable' status, and input validation.

import { describe, expect, test } from 'vitest'

import { createPlanTools } from '../../../src/shared/chat/tools/builtin/plan'
import type { ToolExecCtx, ToolResult } from '../../../src/shared/chat/tools/registry'

const ctx: ToolExecCtx = {
  sessionId: 7,
  emailId: null,
  signal: new AbortController().signal
}

const planUpdate = createPlanTools()[0]

function run(input: unknown): Promise<ToolResult> {
  return planUpdate.handler(input, ctx)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function out(r: ToolResult): any {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  return r.output
}

describe('plan_update — tier + identity', () => {
  test('silent meta tool (single-loop bookkeeping, no confirmation)', () => {
    expect(planUpdate.name).toBe('plan_update')
    expect(planUpdate.confirmationTier).toBe('silent')
    expect(planUpdate.category).toBe('meta')
  })
})

describe('plan_update — plan id + normalization', () => {
  test('derives plan_id from session when omitted + normalizes steps', async () => {
    const o = out(
      await run({
        goal: 'reconcile email with report',
        steps: [
          { id: 's1', domain: 'email', status: 'running' },
          { id: 's2', domain: 'report', status: 'pending' }
        ]
      })
    )
    expect(o.plan_id).toBe('plan:7')
    expect(o.goal).toBe('reconcile email with report')
    expect(o.step_count).toBe(2)
    expect(o.steps[0]).toMatchObject({ id: 's1', domain: 'email', status: 'running' })
  })

  test('keeps a provided plan_id (update path)', async () => {
    expect(out(await run({ plan_id: 'plan:custom', goal: 'g', steps: [] })).plan_id).toBe(
      'plan:custom'
    )
  })

  test('clamps unknown status to pending + defaults missing id/domain', async () => {
    const step = out(await run({ goal: 'g', steps: [{ status: 'frobnicate' }] })).steps[0]
    expect(step.status).toBe('pending')
    expect(step.id).toBe('s1')
    expect(step.domain).toBe('general')
  })

  test('coerces evidence to {type,id} + drops malformed entries', async () => {
    const step = out(
      await run({
        goal: 'g',
        steps: [
          {
            id: 's1',
            domain: 'email',
            status: 'done',
            evidence: [{ type: 'email', id: 51250 }, { type: 'x' }, { id: 9 }, 'bad']
          }
        ]
      })
    ).steps[0]
    expect(step.evidence).toEqual([{ type: 'email', id: 51250 }])
  })

  test('honors unavailable status (honest missing-capability step)', async () => {
    const step = out(
      await run({
        goal: 'put meeting on calendar',
        steps: [{ id: 's1', domain: 'calendar', status: 'unavailable' }]
      })
    ).steps[0]
    expect(step.status).toBe('unavailable')
  })
})

describe('plan_update — validation', () => {
  test('rejects missing goal', async () => {
    const r = await run({ steps: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_INVALID_ARG')
  })

  test('rejects non-array steps', async () => {
    const r = await run({ goal: 'g', steps: 'nope' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_INVALID_ARG')
  })
})
