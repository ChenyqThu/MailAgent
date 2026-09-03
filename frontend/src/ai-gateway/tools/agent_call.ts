import type { Tool } from 'ai'

import type { AgentCallReference } from '@shared/agentCallReference'
import { projectAgentCallState } from '@shared/lib/agentCallState'
import type { MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard } from '../security/approval'
import { classOfTool, type AgentContextMode } from './policy'
import { customAgentCallSchema, type CustomAgentCallInput } from './schemas'
import { auditedWriteTool, type GatewayToolAuditCollector } from './types'
import type { GatewayApprovalMode, GatewayToolApprovalPrefs } from './types'

export const GATEWAY_AGENT_CALL_TOOL_NAMES = ['custom_agent_call'] as const
export const CUSTOM_AGENT_CALL_WAIT_MS = 180_000
const CUSTOM_AGENT_CALL_POLL_MS = 2_000

function inputReferences(input: CustomAgentCallInput): AgentCallReference[] {
  return [
    ...(input.source_session_id == null
      ? []
      : [{ type: 'session' as const, id: input.source_session_id }]),
    ...(input.email_internal_ids ?? []).map((id) => ({ type: 'email' as const, id })),
    ...(input.email_thread_ids ?? []).map((id) => ({ type: 'email' as const, id })),
    ...(input.calendar_event_ids ?? []).map((id) => ({ type: 'calendar' as const, id })),
    ...(input.notion_refs ?? []).map((ref) => ({ type: 'notion' as const, id: ref.object_id })),
    ...(input.report_ids ?? []).map((id) => ({ type: 'report' as const, id })),
    ...(input.library_file_ids ?? []).map((id) => ({ type: 'library' as const, id }))
  ]
}

function isRiskyAgent(agent: Awaited<ReturnType<MailAgentDomainClient['getReportAgent']>>): boolean {
  if (!agent) return true
  const policy = agent.tool_policy
  if (policy?.grant_exec === true || (policy?.grant_web ?? 'off') !== 'off') return true
  if (policy?.grant_connectors && Object.keys(policy.grant_connectors).length > 0) return true
  return (policy?.allowed_tools ?? []).some((name) => {
    const toolClass = classOfTool(name)
    return toolClass !== 'read' && toolClass !== 'artifact'
  })
}

async function waitForPoll(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, CUSTOM_AGENT_CALL_POLL_MS)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

export function createAgentCallTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector,
  guard: ApprovalGuard,
  opts: {
    contextMode: AgentContextMode
    approvalMode?: GatewayApprovalMode
    toolApprovalPrefs?: GatewayToolApprovalPrefs['tools']
    parentSessionId: number
    findSessionByParentToolCall: (parentSessionId: number, parentToolCallId: string) => number | null
    createAgentSession: (input: {
      agentId: string
      title: string
      parentSessionId: number
      parentToolCallId: string
      invokedBy: 'user' | 'main_agent'
    }) => number
    setAgentSessionJobId: (sessionId: number, jobId: number) => void
  }
): Record<string, Tool> {
  return {
    custom_agent_call: auditedWriteTool({
      name: 'custom_agent_call',
      description:
        'Delegate a bounded instruction to an enabled Custom Agent. The child run gets its own ' +
        'auditable session and never receives custom_agent_call, so recursive delegation is impossible.',
      inputSchema: customAgentCallSchema,
      risk: 'edit',
      contextMode: opts.contextMode,
      approvalMode: opts.approvalMode,
      toolApprovalPrefs: opts.toolApprovalPrefs,
      policyEvaluate: async (input: CustomAgentCallInput) => {
        if (input.user_requested === true) {
          return { decision: 'auto_allow', rule_id: null, audit_status: 'auto_user_requested' }
        }
        const agent = await domain.getReportAgent(input.agent_id)
        if (!isRiskyAgent(agent)) {
          return { decision: 'auto_allow', rule_id: null, audit_status: 'auto_delegation_readonly' }
        }
        return { decision: 'ask', rule_id: null }
      },
      run: async (input: CustomAgentCallInput, { signal, toolCallId }) => {
        const agent = await domain.getReportAgent(input.agent_id, signal)
        if (!agent || agent.type !== 'custom' || agent.enabled !== true) {
          throw new Error(`custom agent ${input.agent_id} not found or disabled`)
        }
        let sessionId = opts.findSessionByParentToolCall(opts.parentSessionId, toolCallId)
        if (sessionId == null) {
          sessionId = opts.createAgentSession({
            agentId: input.agent_id,
            title: agent.title || input.agent_id,
            parentSessionId: opts.parentSessionId,
            parentToolCallId: toolCallId,
            invokedBy: input.user_requested === true ? 'user' : 'main_agent'
          })
        }
        const references = inputReferences(input)
        const enqueued = await domain.enqueueAgentCall(
          {
            agent_id: input.agent_id,
            fire_key: `agent-call:${opts.parentSessionId}:${toolCallId}`,
            session_id: sessionId,
            invocation: {
              instruction: input.instruction,
              contextNote: input.context_note,
              references,
              parentSessionId: opts.parentSessionId,
              parentToolCallId: toolCallId,
              invokedBy: input.user_requested === true ? 'user' : 'main_agent',
              userRequested: input.user_requested === true
            }
          },
          signal
        )
        sessionId = enqueued.sessionId
        opts.setAgentSessionJobId(sessionId, enqueued.jobId)
        const startedAt = Date.now()
        let run = await domain.getAgentRun(enqueued.jobId, signal)
        while (
          Date.now() - startedAt < CUSTOM_AGENT_CALL_WAIT_MS &&
          (run.state === 'queued' || run.state === 'running')
        ) {
          await waitForPoll(signal)
          run = await domain.getAgentRun(enqueued.jobId, signal)
        }
        const projected = projectAgentCallState({
          state: run.state,
          lastError: run.error,
          outcome: run.outcome
        })
        const base = {
          agent_id: input.agent_id,
          agent_title: run.agentTitle || agent.title || input.agent_id,
          job_id: enqueued.jobId,
          session_id: sessionId
        }
        if (projected.status === 'completed') {
          return {
            ...base,
            status: 'completed' as const,
            final_answer: run.finalAnswer ?? '',
            truncated: run.finalAnswerTruncated === true,
            references: [...references, { type: 'session' as const, id: sessionId }],
            duration_ms: Math.round((run.durationSeconds ?? 0) * 1000),
            ...(run.tokens ? { usage: run.tokens as Record<string, number | null> } : {})
          }
        }
        if (projected.status === 'failed' || projected.status === 'stopped') {
          return { ...base, status: projected.status, error: projected.error }
        }
        return { ...base, status: projected.status, ...(run.summary ? { summary: run.summary } : {}) }
      }
    }, collector, guard)
  }
}
