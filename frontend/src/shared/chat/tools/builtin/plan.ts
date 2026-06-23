// Plan artifact tool (P2d, task 06-23) — a lightweight plan / subgoal artifact for
// multi-step or cross-domain tasks. The agent calls plan_update at the start of a task
// that spans domains (email + report, email + memory, …) to lay out steps, then again
// to update each step's status as it progresses. The plan rides in the chat trace as a
// normal tool_use / tool_result, so it is visible in the timeline AND replayable in eval
// reports — without any view-layer change.
//
// It is bookkeeping ONLY: it executes nothing, persists nothing, and is dispatched by the
// SAME harness loop as every other tool (NO second orchestration engine — the artifact is
// data the single loop produces). Silent tier: no external side effect → no confirmation.
// A step whose capability is missing (e.g. there is no calendar tool) should be marked
// 'unavailable' rather than faked — pairs with the skill-transparency honesty policy.
//
// Zero Electron/Node import (invariant 1, pnpm build:web): pure compute, no platform.

import type { ToolDef, ToolResult } from '../registry'

const STEP_STATUSES = ['pending', 'running', 'done', 'blocked', 'unavailable'] as const
type StepStatus = (typeof STEP_STATUSES)[number]

interface PlanStep {
  id: string
  domain: string
  status: StepStatus
  evidence?: Array<{ type: string; id: string | number }>
}

function ok<O>(output: O, start: number): ToolResult<O> {
  return { ok: true, output, durationMs: Date.now() - start }
}
function err(code: string, message: string, start: number): ToolResult {
  return { ok: false, code, message, durationMs: Date.now() - start }
}

/** Normalize one raw step into a typed PlanStep: keep only {id, domain, status, evidence?},
 *  default a missing id/domain, clamp status to the known set, and coerce evidence to
 *  {type, id} pairs (dropping malformed entries). Tolerant by design — the artifact is a
 *  scratchpad, not a strict contract. */
function normalizeStep(raw: unknown, index: number): PlanStep {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : `s${index + 1}`
  const domain = typeof r.domain === 'string' && r.domain.length > 0 ? r.domain : 'general'
  const status = STEP_STATUSES.includes(r.status as StepStatus)
    ? (r.status as StepStatus)
    : 'pending'
  const step: PlanStep = { id, domain, status }
  if (Array.isArray(r.evidence)) {
    const ev = r.evidence
      .map((e) => (e ?? {}) as Record<string, unknown>)
      .filter(
        (e) => typeof e.type === 'string' && (typeof e.id === 'string' || typeof e.id === 'number')
      )
      .map((e) => ({ type: e.type as string, id: e.id as string | number }))
    if (ev.length > 0) step.evidence = ev
  }
  return step
}

export function createPlanTools(): ToolDef[] {
  const planUpdate: ToolDef = {
    name: 'plan_update',
    description:
      'Record or update a lightweight plan for a multi-step or cross-domain task (e.g. email + ' +
      'report, or email + memory). Call it once at the start to lay out the steps, then again to ' +
      'mark each step done / blocked / unavailable as you progress. Each step has an id, a domain ' +
      '(email / report / memory / calendar / …), a status, and optional evidence ids. This is a ' +
      'planning scratchpad shown to the user and recorded for replay — it executes nothing and ' +
      'does NOT replace calling the real tools. Mark a step "unavailable" when you lack that ' +
      'capability instead of faking it. Skip this tool for simple single-step asks.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'Stable id to update an existing plan; omit to start a new one.'
        },
        goal: { type: 'string', description: 'One-line goal of the overall task.' },
        steps: {
          type: 'array',
          description: 'Ordered steps, each { id, domain, status, evidence? }.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'short step id, e.g. "s1"' },
              domain: { type: 'string', description: 'email / report / memory / calendar / …' },
              status: {
                type: 'string',
                description: 'pending | running | done | blocked | unavailable'
              },
              evidence: {
                type: 'array',
                description: 'optional evidence ids backing this step',
                items: { type: 'object', properties: { type: { type: 'string' }, id: {} } }
              }
            },
            required: ['id', 'domain', 'status']
          }
        }
      },
      required: ['goal', 'steps']
    },
    confirmationTier: 'silent',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (input, ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      const goal = typeof i.goal === 'string' ? i.goal.trim() : ''
      if (!goal) return err('E_INVALID_ARG', 'goal is required (non-empty string)', start)
      if (!Array.isArray(i.steps)) return err('E_INVALID_ARG', 'steps must be an array', start)
      const planId =
        typeof i.plan_id === 'string' && i.plan_id.length > 0 ? i.plan_id : `plan:${ctx.sessionId}`
      const steps = i.steps.map((s, idx) => normalizeStep(s, idx))
      return ok(
        { plan_id: planId, goal, steps, step_count: steps.length, updated_at: Date.now() },
        start
      )
    }
  }

  return [planUpdate]
}
