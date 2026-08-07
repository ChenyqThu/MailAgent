export const PLAN_UPDATE_TOOL_NAME = 'plan_update' as const

export type PlanStepStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'blocked'
  | 'unavailable'

export interface PlanUpdateValue {
  goal: string
  steps: Array<{
    id: string
    title: string
    status: PlanStepStatus
    note?: string
  }>
}
