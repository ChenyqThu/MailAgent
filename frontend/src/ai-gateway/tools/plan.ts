import type { Tool } from 'ai'

import { PLAN_UPDATE_TOOL_NAME } from '../../shared/assistant/plan'
import { planUpdateSchema, type PlanUpdateInput } from './schemas'
import { auditedReadTool, type GatewayToolAuditCollector } from './types'

/** Quoted literal required by the gateway↔catalog static completeness scanner. */
export const GATEWAY_PLAN_TOOL_NAMES = ['plan_update'] as const
const _planNameGuard: typeof PLAN_UPDATE_TOOL_NAME = GATEWAY_PLAN_TOOL_NAMES[0]
void _planNameGuard

function normalizePlan(input: PlanUpdateInput): PlanUpdateInput {
  return {
    goal: input.goal,
    steps: input.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      ...(step.note ? { note: step.note } : {})
    }))
  }
}

/** Build the side-effect-free plan artifact tool for every gateway context mode. */
export function createPlanTools(
  collector: GatewayToolAuditCollector = []
): Record<string, Tool> {
  const plan_update = auditedReadTool(
    {
      name: 'plan_update',
      description:
        'Create or update a concise execution plan for a complex task. Use at most 12 uniquely ' +
        'identified steps and keep each status current. Mark unavailable capabilities honestly. ' +
        'This tool only records a plan artifact and has no external side effects.',
      inputSchema: planUpdateSchema,
      run: async (input) => normalizePlan(input)
    },
    collector
  )
  return { [PLAN_UPDATE_TOOL_NAME]: plan_update }
}
