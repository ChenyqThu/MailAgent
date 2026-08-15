// task 08-14 — matter_followup_mutate：事项跟进配置的逐条编辑。
//
// 语义与校验的权威在 Python（followup_config.py → triggers.py，那边有 20 个用例盯着逐条纪律）。
// 这里只盯 TS 侧该负责的三件事：payload 逐字段组装、wire 落点、以及 class capability_change
// 带来的场地约束（🔴 与 matter 写家族的 domain_write 不同 —— im_chat 里也没有）。

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import { createMatterWriteTools } from '../../../src/ai-gateway/tools/matters'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { mockDomain, okEnvelope } from './_helpers'

function followupTool(): {
  tool: Tool
  calls: { url: string; body: Record<string, unknown> }[]
} {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const domain = mockDomain((url, body) => {
    if (body !== undefined) calls.push({ url, body: JSON.parse(body) as Record<string, unknown> })
    return okEnvelope({ matter: { public_id: 'MAT-0001', version: 8 } })
  })
  const tools = createMatterWriteTools(domain, [], new ApprovalGuard(), {
    contextMode: 'manual_chat'
  })
  return { tool: tools.matter_followup_mutate, calls }
}

async function approveAndRun(tool: Tool, input: unknown, callId = 'tc-fu1'): Promise<unknown> {
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId: callId, messages: [] })
  const exec = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  return exec(input, { toolCallId: callId, messages: [], abortSignal: undefined })
}

const BASE = { public_id: 'MAT-0001', expected_version: 8, idempotency_key: 'idem-1' }

describe('matter_followup_mutate — wire shape', () => {
  test('hits the followup endpoint with operation + payload + mutation', async () => {
    const { tool, calls } = followupTool()
    await approveAndRun(tool, {
      ...BASE,
      operation: 'remove_trigger',
      trigger_id: 'mtr_cond'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/matters/MAT-0001/followup')
    expect(calls[0].body.operation).toBe('remove_trigger')
    expect(calls[0].body.payload).toEqual({ trigger_id: 'mtr_cond' })
    expect((calls[0].body.mutation as Record<string, unknown>).expected_version).toBe(8)
  })

  test('payload carries ONLY the keys this operation was given', async () => {
    const { tool, calls } = followupTool()
    await approveAndRun(tool, { ...BASE, operation: 'set_enabled', enabled: false })
    // 未传的键不进 wire —— 否则 Python 侧会把一堆 undefined/null 当成「显式清空」。
    expect(calls[0].body.payload).toEqual({ enabled: false })
  })

  test('a schedule edit passes the trigger object through verbatim', async () => {
    const { tool, calls } = followupTool()
    const trigger = {
      rule: {
        freq: 'weekly',
        interval: 1,
        weekdays: [2],
        monthMode: 'date',
        monthDay: 1,
        ordinal: 1,
        weekday: 1,
        hour: 18,
        minute: 0,
        clamp: false
      },
      anchor: '2026-08-14',
      timezone: 'America/Los_Angeles'
    }
    await approveAndRun(tool, {
      ...BASE,
      operation: 'update_trigger',
      trigger_id: 'mtr_sched',
      trigger
    })
    expect(calls[0].body.payload).toEqual({ trigger_id: 'mtr_sched', trigger })
  })

  test('null clears are distinguishable from omission', async () => {
    const { tool, calls } = followupTool()
    await approveAndRun(tool, { ...BASE, operation: 'set_profile', profile_id: null })
    expect(calls[0].body.payload).toEqual({ profile_id: null })
  })
})

describe('matter_followup_mutate — venue floor (class capability_change)', () => {
  const build = (contextMode: 'manual_chat' | 'im_chat' | 'cron_headless' | 'matter_followup') =>
    buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      matterToolsEnabled: true,
      contextMode
    })

  test('registers in manual chat', () => {
    expect(build('manual_chat').matter_followup_mutate).toBeDefined()
  })

  test('🔴 absent from im_chat — unlike the domain_write matter family', () => {
    const im = build('im_chat')
    // 同族的 domain_write 写工具在飞书里是有的，这一个没有：改的是无人值守 run 的触发条件。
    expect(im.matter_add_note).toBeDefined()
    expect(im.matter_followup_mutate).toBeUndefined()
  })

  test('absent from headless and from a follow-up run itself', () => {
    expect(build('cron_headless').matter_followup_mutate).toBeUndefined()
    // 🔴 跟进 run 改不了自己的跟进配置。
    expect(build('matter_followup').matter_followup_mutate).toBeUndefined()
  })
})

describe('matter_get — the followup read face', () => {
  test('include accepts "followup" (the only face handing out trigger ids)', async () => {
    const seen: string[] = []
    const domain = mockDomain((url) => {
      seen.push(url)
      return okEnvelope({ matter: { public_id: 'MAT-0001' }, followup: { triggers: [] } })
    })
    const tools = buildGatewayTools({
      domain,
      approvalGuard: new ApprovalGuard(),
      matterToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    const exec = tools.matter_get.execute as (i: unknown, o: unknown) => Promise<unknown>
    const out = (await exec(
      { public_id: 'MAT-0001', include: ['followup'] },
      { toolCallId: 'tc-g1', messages: [] }
    )) as Record<string, unknown>
    expect(seen[0]).toContain('followup')
    expect(out.followup).toBeDefined()
  })
})
