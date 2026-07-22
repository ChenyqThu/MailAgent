// task 07-21 — notion_agent tool: flag gate (byte-identical off), SKILL-gating via advertisedSkills
// (unlike the CORE_UNGATED families), edit-tier 恒 HITL (always asks — auto-reversible / acceptEdits
// never relax it), the /api/skills/invoke wire body, UNTRUSTED_NOTION_AGENT fencing of the answer,
// and class 'outbound' → stripped from a headless run.

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  createNotionAgentTools,
  GATEWAY_NOTION_AGENT_TOOL_NAMES
} from '../../../src/ai-gateway/tools/notion_agent'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { mockDomain, okEnvelope } from './_helpers'

const CHAT_RESULT = {
  final_content: 'The Q3 plan ships in September.',
  thread_id: 'thr-abc'
}

/** Mock domain answering /skills/invoke; `capture` records the wire body, `result` overrides. */
function notionDomain(overrides?: {
  result?: unknown
  onCall?: (url: string, body?: string) => void
}) {
  return mockDomain((url, body) => {
    overrides?.onCall?.(url, body)
    if (url.includes('/skills/invoke')) return okEnvelope(overrides?.result ?? CHAT_RESULT)
    return okEnvelope({})
  })
}

/** Drive the HITL two-call shape: needsApproval (registers) → execute. */
async function approveAndRun(
  guard: ApprovalGuard,
  tool: Tool,
  input: unknown,
  toolCallId = 'tc-na1'
): Promise<{ needs: boolean | Promise<boolean>; out: unknown }> {
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  const needs = await needsApproval(input, { toolCallId, messages: [] })
  const exec = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  const out = await exec(input, { toolCallId, messages: [], abortSignal: undefined })
  return { needs, out }
}

describe('buildGatewayTools — MAILAGENT_NOTION_AGENT_TOOL gate', () => {
  test('flag off (default) → no notion_agent_chat tool', () => {
    const tools = buildGatewayTools({
      domain: notionDomain(),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    expect(tools.notion_agent_chat).toBeUndefined()
  })

  test('flag on + guard → notion_agent_chat present', () => {
    const tools = buildGatewayTools({
      domain: notionDomain(),
      approvalGuard: new ApprovalGuard(),
      notionAgentToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    for (const n of GATEWAY_NOTION_AGENT_TOOL_NAMES) expect(tools[n]).toBeDefined()
  })

  test('flag on but NO approvalGuard → not added (a write tool cannot exist without its guard)', () => {
    const tools = buildGatewayTools({
      domain: notionDomain(),
      notionAgentToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    expect(tools.notion_agent_chat).toBeUndefined()
  })
})

describe('notion_agent skill-gating (unlike CORE_UNGATED web/calendar)', () => {
  test('skill NOT advertised → notion_agent_chat dropped by applySkillGating', () => {
    const tools = buildGatewayTools({
      domain: notionDomain(),
      approvalGuard: new ApprovalGuard(),
      notionAgentToolsEnabled: true,
      skillGatingEnabled: true,
      advertisedSkills: ['email', 'search', 'report'], // notion_agent NOT advertised
      contextMode: 'manual_chat'
    })
    expect(tools.notion_agent_chat).toBeUndefined()
  })

  test('skill advertised → notion_agent_chat survives gating', () => {
    const tools = buildGatewayTools({
      domain: notionDomain(),
      approvalGuard: new ApprovalGuard(),
      notionAgentToolsEnabled: true,
      skillGatingEnabled: true,
      advertisedSkills: ['notion_agent'],
      contextMode: 'manual_chat'
    })
    expect(tools.notion_agent_chat).toBeDefined()
  })
})

describe('notion_agent_chat — 恒 HITL + wire + fencing', () => {
  test('always asks in manual_chat (edit tier)', async () => {
    const guard = new ApprovalGuard()
    const { notion_agent_chat } = createNotionAgentTools(notionDomain(), [], guard, {
      contextMode: 'manual_chat'
    })
    const { needs } = await approveAndRun(guard, notion_agent_chat, {
      prompt: 'what is the Q3 plan?'
    })
    expect(needs).toBe(true)
  })

  test('auto-reversible does NOT relax it (edit tier always asks)', async () => {
    const guard = new ApprovalGuard()
    const { notion_agent_chat } = createNotionAgentTools(notionDomain(), [], guard, {
      contextMode: 'manual_chat',
      approvalMode: 'auto-reversible'
    })
    const needsApproval = notion_agent_chat.needsApproval as (
      i: unknown,
      o: { toolCallId: string; messages: unknown[] }
    ) => boolean | Promise<boolean>
    expect(await needsApproval({ prompt: 'hi' }, { toolCallId: 'tc-ar', messages: [] })).toBe(true)
  })

  test('acceptEdits does NOT auto-approve it (not on the allow-list)', async () => {
    const guard = new ApprovalGuard()
    const { notion_agent_chat } = createNotionAgentTools(notionDomain(), [], guard, {
      contextMode: 'manual_chat',
      approvalMode: 'acceptEdits'
    })
    const needsApproval = notion_agent_chat.needsApproval as (
      i: unknown,
      o: { toolCallId: string; messages: unknown[] }
    ) => boolean | Promise<boolean>
    expect(await needsApproval({ prompt: 'hi' }, { toolCallId: 'tc-ae', messages: [] })).toBe(true)
  })

  test('execute posts the /api/skills/invoke body and fences the answer', async () => {
    const guard = new ApprovalGuard()
    let capturedUrl = ''
    let capturedBody: string | undefined
    const domain = notionDomain({
      onCall: (url, body) => {
        if (url.includes('/skills/invoke')) {
          capturedUrl = url
          capturedBody = body
        }
      }
    })
    const { notion_agent_chat } = createNotionAgentTools(domain, [], guard, {
      contextMode: 'manual_chat'
    })
    const { out } = await approveAndRun(guard, notion_agent_chat, {
      prompt: 'update the schedule',
      thread_id: 'thr-abc',
      model: 'claude-haiku-4-5'
    })
    // wire: unified skill invoke面, exact skill/tool + snake_case input.
    expect(capturedUrl).toContain('/api/skills/invoke')
    const body = JSON.parse(capturedBody ?? '{}') as {
      skill: string
      tool: string
      input: Record<string, unknown>
    }
    expect(body.skill).toBe('notion_agent')
    expect(body.tool).toBe('notion_agent_chat')
    expect(body.input).toEqual({
      prompt: 'update the schedule',
      thread_id: 'thr-abc',
      model: 'claude-haiku-4-5'
    })
    // output: answer fenced as UNTRUSTED_NOTION_AGENT; thread_id echoed.
    const result = out as { final_content: string; thread_id: string | null; truncated: boolean }
    expect(result.final_content).toContain('UNTRUSTED_NOTION_AGENT_START')
    expect(result.final_content).toContain('The Q3 plan ships in September.')
    expect(result.final_content).toContain('UNTRUSTED_NOTION_AGENT_END')
    expect(result.thread_id).toBe('thr-abc')
    expect(result.truncated).toBe(false)
  })

  test('omitted thread_id/model are not sent on the wire; null thread_id echoed', async () => {
    const guard = new ApprovalGuard()
    let capturedBody: string | undefined
    const domain = notionDomain({
      result: { final_content: 'answer', thread_id: null },
      onCall: (url, body) => {
        if (url.includes('/skills/invoke')) capturedBody = body
      }
    })
    const { notion_agent_chat } = createNotionAgentTools(domain, [], guard, {
      contextMode: 'manual_chat'
    })
    const { out } = await approveAndRun(guard, notion_agent_chat, { prompt: 'quick lookup' })
    const body = JSON.parse(capturedBody ?? '{}') as { input: Record<string, unknown> }
    expect(body.input).toEqual({ prompt: 'quick lookup' })
    expect((out as { thread_id: string | null }).thread_id).toBeNull()
  })
})

describe('notion_agent_chat — class outbound (headless-stripped)', () => {
  test('cron_headless run → notion_agent_chat is NOT in the ToolSet (un-grantable)', () => {
    const tools = buildGatewayTools({
      domain: notionDomain(),
      approvalGuard: new ApprovalGuard(),
      notionAgentToolsEnabled: true,
      contextMode: 'cron_headless',
      agentRunContext: { agentId: 'dms', skills: ['notion_agent'] }
    })
    expect(tools.notion_agent_chat).toBeUndefined()
  })
})
