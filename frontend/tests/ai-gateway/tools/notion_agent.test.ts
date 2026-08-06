// task 07-21 — notion_agent tool: flag gate (byte-identical off), SKILL-gating via advertisedSkills
// (unlike the CORE_UNGATED families), edit-tier default-ask (auto-reversible
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

  test('default per-tool tier keeps it asking (factory default ask, D2=a)', async () => {
    // 08-05 WP-11 — the old「恒 HITL」demoted to the tool's factory-default 'ask' tier: with the
    // prefs threaded and no owner override, it still asks.
    const guard = new ApprovalGuard()
    const { notion_agent_chat } = createNotionAgentTools(notionDomain(), [], guard, {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { notion_agent_chat: { tier: 'ask', source: 'default' } }
    })
    const needsApproval = notion_agent_chat.needsApproval as (
      i: unknown,
      o: { toolCallId: string; messages: unknown[] }
    ) => boolean | Promise<boolean>
    expect(await needsApproval({ prompt: 'hi' }, { toolCallId: 'tc-ae', messages: [] })).toBe(true)
  })

  test("owner per-tool 'auto' DOES relax it (danger-confirmed owner override, D2=a)", async () => {
    // 08-05 WP-11 — the owner can explicitly set it to 'auto' (Settings shows the red one-time
    // confirm; dangerAuto). The gateway honors the explicit tier — no card.
    const guard = new ApprovalGuard()
    const { notion_agent_chat } = createNotionAgentTools(notionDomain(), [], guard, {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { notion_agent_chat: { tier: 'auto', source: 'owner' } }
    })
    const needsApproval = notion_agent_chat.needsApproval as (
      i: unknown,
      o: { toolCallId: string; messages: unknown[] }
    ) => boolean | Promise<boolean>
    expect(await needsApproval({ prompt: 'hi' }, { toolCallId: 'tc-auto', messages: [] })).toBe(
      false
    )
  })

  test('bypass DOES auto-approve it now (08-05 D1=a — BYPASS_STILL_ASK retired)', async () => {
    // 07-21 codex HIGH-1's carve-out is retired by the 08-05 owner 拍板: bypass = 字面「无例外」.
    // The 外呼-不可撤回 rationale survives as the factory-default 'ask' tier + the danger
    // confirm on setting 'auto' — a data-level default, no longer a code floor.
    const guard = new ApprovalGuard()
    const { notion_agent_chat } = createNotionAgentTools(notionDomain(), [], guard, {
      contextMode: 'manual_chat',
      approvalMode: 'bypass'
    })
    const needsApproval = notion_agent_chat.needsApproval as (
      i: unknown,
      o: { toolCallId: string; messages: unknown[] }
    ) => boolean | Promise<boolean>
    expect(await needsApproval({ prompt: 'hi' }, { toolCallId: 'tc-by', messages: [] })).toBe(false)
  })

  test("bypass outranks even an explicit per-tool 'ask' (D1=a: 无例外)", async () => {
    const guard = new ApprovalGuard()
    const { notion_agent_chat } = createNotionAgentTools(notionDomain(), [], guard, {
      contextMode: 'manual_chat',
      approvalMode: 'bypass',
      toolApprovalPrefs: { notion_agent_chat: { tier: 'ask', source: 'owner' } }
    })
    const needsApproval = notion_agent_chat.needsApproval as (
      i: unknown,
      o: { toolCallId: string; messages: unknown[] }
    ) => boolean | Promise<boolean>
    expect(await needsApproval({ prompt: 'hi' }, { toolCallId: 'tc-by2', messages: [] })).toBe(
      false
    )
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
      confirm?: unknown
    }
    expect(body.skill).toBe('notion_agent')
    expect(body.tool).toBe('notion_agent_chat')
    // codex HIGH-2 — the tool is confirmation_tier=edit server-side, so the invoke body carries an
    // explicit boolean confirm=true (this execute only runs AFTER the gateway's 恒-HITL card was
    // approved). Without it the Python invoke chokepoint 403s a direct call.
    expect(body.confirm).toBe(true)
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
