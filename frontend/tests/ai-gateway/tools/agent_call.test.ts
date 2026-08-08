import type { Tool } from 'ai'
import { describe, expect, test } from 'vitest'

import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import type { GatewayToolAuditEntry } from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope } from './_helpers'

const readonlyAgent = {
  id: 'reader', type: 'custom', enabled: true, title: 'Reader', description: null,
  schedule: { cadence: 'daily', hours: [9] }, window_hours: null, prompt: '', prompt_is_default: false,
  model: '', kos_enrich: false, trigger_mode: 'rolling_24h', timezone: '', body_full_priorities: [],
  mark_read_after_processing: true, tool_policy: { v: 1, allowed_tools: ['email_get'] }, updated_at: null
}

function build(agent = readonlyAgent, approvalMode?: 'bypass') {
  const collector: GatewayToolAuditEntry[] = []
  let linked: [number, number] | null = null
  const domain = mockDomain((url) => {
    if (url.includes('/report-agents')) return okEnvelope(agent)
    if (url.endsWith('/agent-runs/call')) return okEnvelope({ jobId: 7, wasCreated: true, sessionId: 2 })
    if (url.endsWith('/agent-runs/7')) {
      return okEnvelope({
        jobId: 7, agentId: agent.id, agentTitle: agent.title, state: 'completed', outcome: 'completed',
        sessionId: 2, createdAt: 1, finishedAt: 2, error: null, durationSeconds: 1,
        finalAnswer: 'done', finalAnswerTruncated: false
      })
    }
    return okEnvelope([])
  })
  const tools = buildGatewayTools({
    domain,
    approvalGuard: new ApprovalGuard(),
    customAgentToolsEnabled: true,
    customAgentCallEnabled: true,
    contextMode: 'manual_chat',
    parentSessionId: 1,
    findSessionByParentToolCall: () => null,
    createAgentCallSession: () => 2,
    setAgentSessionJobId: (sessionId, jobId) => { linked = [sessionId, jobId] },
    approvalMode
  }, collector)
  return { tool: tools.custom_agent_call as Tool, collector, linked: () => linked }
}

async function needs(tool: Tool, input: unknown, toolCallId = 'tc-call') {
  return await (tool.needsApproval as (i: unknown, o: unknown) => boolean | Promise<boolean>)(input, { toolCallId })
}

async function execute(tool: Tool, input: unknown, toolCallId = 'tc-call') {
  return await (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, {
    toolCallId, messages: [], abortSignal: undefined
  })
}

describe('custom_agent_call', () => {
  test('registers only in manual_chat when flag + custom-agent surface + hooks are present', () => {
    expect(build().tool).toBeDefined()
    const off = buildGatewayTools({ domain: mockDomain(() => okEnvelope([])), contextMode: 'manual_chat' })
    expect(off.custom_agent_call).toBeUndefined()
    for (const mode of ['cron_headless', 'untrusted_trigger', 'im_chat'] as const) {
      const tools = buildGatewayTools({
        domain: mockDomain(() => okEnvelope([])), approvalGuard: new ApprovalGuard(),
        customAgentToolsEnabled: true, customAgentCallEnabled: true, contextMode: mode,
        parentSessionId: 1, findSessionByParentToolCall: () => null,
        createAgentCallSession: () => 2, setAgentSessionJobId: () => undefined
      })
      expect(tools.custom_agent_call).toBeUndefined()
    }
  })

  test('readonly delegation auto-allows and audits auto_delegation_readonly', async () => {
    const built = build()
    const input = { agent_id: 'reader', instruction: 'summarize' }
    expect(await needs(built.tool, input)).toBe(false)
    expect(await execute(built.tool, input)).toMatchObject({ status: 'completed', final_answer: 'done' })
    expect(built.collector[0]?.approvalStatus).toBe('auto_delegation_readonly')
    expect(built.linked()).toEqual([2, 7])
  })

  test('risky delegation asks unless user_requested', async () => {
    const risky = { ...readonlyAgent, tool_policy: { v: 1, allowed_tools: ['email_archive'] } }
    expect(await needs(build(risky).tool, { agent_id: 'reader', instruction: 'archive' })).toBe(true)
    const user = build(risky)
    const input = { agent_id: 'reader', instruction: 'archive', user_requested: true }
    expect(await needs(user.tool, input)).toBe(false)
    await execute(user.tool, input)
    expect(user.collector[0]?.approvalStatus).toBe('auto_user_requested')
  })

  test('owner bypass outranks risky policy and audits auto_bypass', async () => {
    const risky = { ...readonlyAgent, tool_policy: { v: 1, allowed_tools: ['email_archive'] } }
    const built = build(risky, 'bypass')
    const input = { agent_id: 'reader', instruction: 'archive' }
    expect(await needs(built.tool, input)).toBe(false)
    await execute(built.tool, input)
    expect(built.collector[0]?.approvalStatus).toBe('auto_bypass')
  })
})
