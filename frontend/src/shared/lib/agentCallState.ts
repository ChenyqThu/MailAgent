import type { AgentRunState } from '@shared/api/types/report'

export type AgentCallProjectedState =
  | { status: 'queued' | 'running' | 'waiting_approval' | 'completed' }
  | { status: 'failed' | 'stopped'; error: { code: string; message: string } }

export interface AgentCallStateInput {
  state: AgentRunState
  lastError?: string | null
  outcome?: string | null
}

/** Presentation-only projection. paused_approved/rejected are terminal in the v1 job ledger even
 * though a later resume completion is not tracked on that job; callers read the child session's
 * latest assistant message as the best available final answer. */
export function projectAgentCallState(input: AgentCallStateInput): AgentCallProjectedState {
  if (input.lastError === 'E_RUN_STOPPED' || input.outcome === 'stopped') {
    return { status: 'stopped', error: { code: 'E_RUN_STOPPED', message: 'Agent run stopped' } }
  }
  switch (input.state) {
    case 'queued':
      return { status: 'queued' }
    case 'running':
      return { status: 'running' }
    case 'paused_pending':
      return { status: 'waiting_approval' }
    case 'completed':
    case 'paused_approved':
    case 'paused_rejected':
      return { status: 'completed' }
    case 'paused_expired':
      return {
        status: 'failed',
        error: { code: 'E_APPROVAL_EXPIRED', message: 'Approval expired before the run resumed' }
      }
    case 'skipped':
      return {
        status: 'failed',
        error: { code: 'E_RUNS_BUDGET', message: 'Custom agent daily run limit reached' }
      }
    case 'failed': {
      const code = input.lastError || 'E_AGENT_RUN_FAILED'
      return { status: 'failed', error: { code, message: code } }
    }
  }
}
