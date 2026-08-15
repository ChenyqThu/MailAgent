// task 08-14 PR1 — 内建 agent 只读面（internal_agent_list / internal_agent_get）。
//
// 盯三件事：
//   ① 它真的补上了 custom_agent_list 看不见的那五行（这正是本任务的起因：owner 库里零 custom 行）。
//   ② 🔴 死键既不出现在返回里、也不被当成可改的旋钮 —— preprocess 的 prompt/enabled 与 report
//      顶层 cadence/hours。把死键报成有效配置，会让模型（进而让 owner）以为改得动纹丝不动的东西。
//   ③ flag / 场地门：显式 false 字节级回退；class capability_change ⇒ 非 manual run 里整面消失。

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  createInternalAgentTools,
  GATEWAY_INTERNAL_AGENT_TOOL_NAMES
} from '../../../src/ai-gateway/tools/internal_agents'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { mockDomain, okEnvelope, runTool } from './_helpers'

/** owner 活库的形状：四类内建行 + 一行 custom（用来断言过滤）。字段取 wire ReportAgentConfig。 */
const BASE = {
  description: null,
  window_hours: null,
  prompt: '',
  prompt_is_default: true,
  model: '',
  tools_json: null,
  kos_enrich: false,
  trigger_mode: 'rolling_24h' as const,
  timezone: '',
  body_full_priorities: [],
  mark_read_after_processing: true,
  trigger: null,
  tool_policy: null,
  budget: null,
  updated_at: 1750000000000
}

/** 🔴 真实形状：owner 库里的 report 行是**混合**的 —— 顶层 legacy 键与新 rule 形状并存，
 *  而运行时以 rule.freq 为权威（src/reports/store.py）。 */
const DAILY_REPORT = {
  ...BASE,
  id: 'daily_email_digest',
  type: 'report',
  enabled: true,
  title: '邮件日报',
  prompt: '汇总今日邮件。',
  prompt_is_default: false,
  model: 'claude-opus-4-8',
  window_hours: 24,
  timezone: 'America/Los_Angeles',
  body_full_priorities: ['🔴 紧急', '🟡 重要'],
  kos_enrich: true,
  context_docs: ['soul', 'user'],
  schedule: {
    cadence: 'daily',
    hours: [9],
    v: 1 as const,
    kind: 'schedule' as const,
    rule: {
      freq: 'daily' as const,
      interval: 1,
      weekdays: [1],
      monthMode: 'date' as const,
      monthDay: 1,
      ordinal: 1,
      weekday: 1,
      hour: 9,
      minute: 0,
      clamp: false
    },
    anchor: '2020-01-01',
    timezone: 'America/Los_Angeles'
  }
}

const SEARCH_AGENT = {
  ...BASE,
  id: 'email_search_agent',
  type: 'search',
  enabled: true,
  title: '邮件搜索',
  schedule: { cadence: 'daily' as const, hours: [9] },
  tools_json: ['email_search_fulltext']
}

/** enabled=0 且 prompt 有残留值 —— 两者都是死列，投影必须不把它们当有效配置。 */
const PREPROCESS_AGENT = {
  ...BASE,
  id: 'email_preprocess_agent',
  type: 'preprocess',
  enabled: false,
  title: 'AI 邮件预处理',
  prompt: '你是一个邮件分类助手。',
  prompt_is_default: false,
  schedule: { cadence: 'daily' as const, hours: [9] },
  context_docs: ['soul', 'user'],
  context_source: 'standing_docs',
  mark_read_after_processing: false,
  fallback_models: ['claude-haiku-4-5-20251001']
}

const PROJECT_PROGRESS = {
  ...BASE,
  id: 'project_progress_sync',
  type: 'project_progress',
  enabled: true,
  title: '项目周报同步',
  schedule: { cadence: 'daily' as const, hours: [9] },
  trigger: {
    v: 1 as const,
    kind: 'email_filter' as const,
    subject_pattern: '【项目进度】项目deadline汇报',
    sender_pattern: 'evelyn.wei@tp-link.com'
  }
}

const CUSTOM_AGENT = {
  ...BASE,
  id: 'dms-approver',
  type: 'custom',
  enabled: true,
  title: 'DMS Approver',
  schedule: { cadence: 'daily' as const, hours: [9] }
}

const ALL_ROWS = [DAILY_REPORT, SEARCH_AGENT, PREPROCESS_AGENT, PROJECT_PROGRESS, CUSTOM_AGENT]

function toolsWithRows(rows: unknown[] = ALL_ROWS): Record<string, unknown> {
  return createInternalAgentTools(
    mockDomain((url) => {
      const match = /agentId=([^&]+)/.exec(url)
      if (match) {
        const id = decodeURIComponent(match[1])
        const row = (rows as { id: string }[]).find((r) => r.id === id)
        return row
          ? okEnvelope(row)
          : {
              status: 404,
              json: { status: 'error', error: { code: 'E_NOT_FOUND', message: 'no' } }
            }
      }
      return okEnvelope(rows)
    })
  ) as unknown as Record<string, unknown>
}

type ListResult = { count: number; items: Record<string, unknown>[] }
type GetResult = { found: boolean; agent?: Record<string, unknown> }
type UpdateResult = {
  updated: boolean
  before: Record<string, unknown>
  after: Record<string, unknown>
}

/** 带写工具的一套（PR2）。记录 PUT 的 url/body 供断言 wire 保真。 */
function writableTools(rows: unknown[] = ALL_ROWS): {
  tools: Record<string, Tool>
  puts: { url: string; body: Record<string, unknown> }[]
} {
  const puts: { url: string; body: Record<string, unknown> }[] = []
  const domain = mockDomain((url, body) => {
    const match = /agentId=([^&]+)/.exec(url)
    if (match) {
      const id = decodeURIComponent(match[1])
      const row = (rows as { id: string }[]).find((r) => r.id === id)
      return row
        ? okEnvelope(row)
        : { status: 404, json: { status: 'error', error: { code: 'E_NOT_FOUND', message: 'no' } } }
    }
    if (body !== undefined) {
      const parsed = JSON.parse(body) as Record<string, unknown>
      puts.push({ url, body: parsed })
      const id = decodeURIComponent(url.split('/report-agents/')[1] ?? '')
      const row = (rows as Record<string, unknown>[]).find((r) => r.id === id)!
      return okEnvelope({ ...row, ...parsed })
    }
    return okEnvelope(rows)
  })
  const tools = createInternalAgentTools(domain, [], new ApprovalGuard(), {
    contextMode: 'manual_chat'
  })
  return { tools, puts }
}

/** 走写工具的 HITL 两段形状（register → execute）。 */
async function approveAndRun(tool: Tool, input: unknown, callId = 'tc-ia1'): Promise<unknown> {
  const toolCallId = callId
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId, messages: [] })
  const exec = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  return exec(input, { toolCallId, messages: [], abortSignal: undefined })
}

describe('internal_agent_list — the built-in agents custom_agent_list cannot see', () => {
  test('lists the four built-in types and filters custom out', async () => {
    const tools = toolsWithRows()
    const out = (await runTool(tools.internal_agent_list as never, { limit: 50 })) as ListResult
    expect(out.count).toBe(4)
    expect(out.items.map((i) => i.id)).toEqual([
      'daily_email_digest',
      'email_search_agent',
      'email_preprocess_agent',
      'project_progress_sync'
    ])
    // 起因回归：这四行正是 custom_agent_list 结构性看不见的那些。
    expect(out.items.some((i) => i.type === 'custom')).toBe(false)
  })

  test('🔴 preprocess row reports enabled:null + the env note (the row column is DEAD)', async () => {
    const tools = toolsWithRows()
    const out = (await runTool(tools.internal_agent_list as never, { limit: 50 })) as ListResult
    const row = out.items.find((i) => i.id === 'email_preprocess_agent')!
    // 行里 enabled=0，但运行时根本不读它 —— 报 false 会被读成「预处理关着」，报 true 更糟。
    expect(row.enabled).toBeNull()
    expect(String(row.enabled_note)).toContain('LLM_AGENT_ENABLED')
    // 其余类型照常如实报。
    expect(out.items.find((i) => i.id === 'daily_email_digest')!.enabled).toBe(true)
  })

  test('activation summary is derived per type (schedule / trigger / none)', async () => {
    const tools = toolsWithRows()
    const out = (await runTool(tools.internal_agent_list as never, { limit: 50 })) as ListResult
    const byId = Object.fromEntries(out.items.map((i) => [i.id, i]))
    // report 走 rule（不是顶层 cadence）；复用 triggerSummary ⇒ 与 custom agent 同一套措辞。
    expect(String(byId.daily_email_digest.activation)).toContain('schedule daily')
    expect(String(byId.project_progress_sync.activation)).toContain('email_filter')
    expect(String(byId.email_preprocess_agent.activation)).toContain('per incoming email')
    expect(String(byId.email_search_agent.activation)).toContain('on demand')
  })

  test('limit truncates', async () => {
    const tools = toolsWithRows()
    const out = (await runTool(tools.internal_agent_list as never, { limit: 2 })) as ListResult
    expect(out.count).toBe(2)
  })
})

describe('internal_agent_get — effective config only (dead keys structurally absent)', () => {
  test('🔴 preprocess: no prompt key at all, and enabled stays null', async () => {
    const tools = toolsWithRows()
    const out = (await runTool(tools.internal_agent_get as never, {
      agent_id: 'email_preprocess_agent'
    })) as GetResult
    expect(out.found).toBe(true)
    // 行里 prompt 有值（'你是一个邮件分类助手。'），但 v1.1.0 起运行时一律忽略 ⇒ 不得出现。
    expect(out.agent).not.toHaveProperty('prompt')
    expect(out.agent!.enabled).toBeNull()
    // 真正承担「人设」的字段必须在场，否则模型无从下手只能去改那个死列。
    expect(out.agent!.context_docs).toEqual(['soul', 'user'])
    expect(out.agent!.context_source).toBe('standing_docs')
    expect(out.agent!.mark_read_after_processing).toBe(false)
    expect(out.agent!.fallback_models).toEqual(['claude-haiku-4-5-20251001'])
    expect(String(out.agent!.persona_note)).toContain('context_docs')
  })

  test('🔴 report: schedule projects rule/anchor/timezone — the legacy cadence mirror is absent', async () => {
    const tools = toolsWithRows()
    const out = (await runTool(tools.internal_agent_get as never, {
      agent_id: 'daily_email_digest'
    })) as GetResult
    const schedule = out.agent!.schedule as Record<string, unknown>
    expect(Object.keys(schedule).sort()).toEqual(['anchor', 'rule', 'timezone'])
    // 顶层 cadence/hours/weekday 是降级镜像（权威是 rule.freq）——报出来会被当成可独立调整的旋钮。
    expect(schedule).not.toHaveProperty('cadence')
    expect(schedule).not.toHaveProperty('hours')
    expect(out.agent!.schedule_shape).toBe('rule')
    // freq 改动的真实后果（换报告种类 + 换 report id）必须说在明处。
    expect(String(out.agent!.cadence_note)).toContain('report KIND')
    // report 的 prompt 有真实消费者（reports/worker.py persona_prompt）⇒ 必须在场。
    expect(out.agent!.prompt).toBe('汇总今日邮件。')
    expect(out.agent!.window_hours).toBe(24)
    expect(out.agent!.body_full_priorities).toEqual(['🔴 紧急', '🟡 重要'])
  })

  test('legacy-shaped report row is labelled, not silently presented as rule shape', async () => {
    const legacy = { ...DAILY_REPORT, schedule: { cadence: 'weekly' as const, hours: [8] } }
    const tools = toolsWithRows([legacy])
    const out = (await runTool(tools.internal_agent_get as never, {
      agent_id: 'daily_email_digest'
    })) as GetResult
    expect(out.agent!.schedule).toBeNull()
    expect(out.agent!.schedule_shape).toBe('legacy')
    expect(String(out.agent!.schedule_summary)).toContain('legacy shape')
  })

  test('project_progress: ETL note + trigger, no prompt', async () => {
    const tools = toolsWithRows()
    const out = (await runTool(tools.internal_agent_get as never, {
      agent_id: 'project_progress_sync'
    })) as GetResult
    expect(out.agent).not.toHaveProperty('prompt')
    expect(String(out.agent!.execution_note)).toContain('PROJECT_PROGRESS_SYNC_ENABLED')
    expect(String(out.agent!.trigger_summary)).toContain('email_filter')
  })

  test('a custom agent id → found:false (it belongs to custom_agent_get)', async () => {
    const tools = toolsWithRows()
    const out = (await runTool(tools.internal_agent_get as never, {
      agent_id: 'dms-approver'
    })) as GetResult
    expect(out.found).toBe(false)
  })

  test('unknown id → found:false', async () => {
    const tools = toolsWithRows()
    const out = (await runTool(tools.internal_agent_get as never, {
      agent_id: 'nope'
    })) as GetResult
    expect(out.found).toBe(false)
  })
})

describe('internal_agent_update — per-type allowlist (dead keys rejected at the schema)', () => {
  const parse = (input: unknown): { success: boolean } => {
    const { tools } = writableTools()
    const schema = (
      tools.internal_agent_update as {
        inputSchema: { safeParse(i: unknown): { success: boolean } }
      }
    ).inputSchema
    return schema.safeParse(input)
  }

  test('🔴 preprocess.prompt is structurally unrepresentable', () => {
    expect(
      parse({ type: 'preprocess', agent_id: 'email_preprocess_agent', prompt: 'be nicer' }).success
    ).toBe(false)
    // 同一支的合法字段照常通过，证明拒绝的是 prompt 本身而不是整支坏掉。
    expect(
      parse({ type: 'preprocess', agent_id: 'email_preprocess_agent', context_docs: ['soul'] })
        .success
    ).toBe(true)
  })

  test('🔴 preprocess.enabled is structurally unrepresentable (real switch is env)', () => {
    expect(
      parse({ type: 'preprocess', agent_id: 'email_preprocess_agent', enabled: true }).success
    ).toBe(false)
  })

  test('🔴 report top-level cadence / hours / weekday are unrepresentable (they are mirrors)', () => {
    const withCadence = {
      type: 'report',
      agent_id: 'daily_email_digest',
      schedule: {
        cadence: 'weekly',
        rule: DAILY_REPORT.schedule.rule,
        anchor: '2020-01-01',
        timezone: 'UTC'
      }
    }
    expect(parse(withCadence).success).toBe(false)
    expect(parse({ type: 'report', agent_id: 'daily_email_digest', hours: [8] }).success).toBe(
      false
    )
  })

  test('project_progress has no prompt; report/search do', () => {
    expect(
      parse({ type: 'project_progress', agent_id: 'project_progress_sync', prompt: 'x' }).success
    ).toBe(false)
    expect(parse({ type: 'search', agent_id: 'email_search_agent', prompt: 'x' }).success).toBe(
      true
    )
    expect(parse({ type: 'report', agent_id: 'daily_email_digest', prompt: 'x' }).success).toBe(
      true
    )
  })

  test('tool_policy / budget / avatar cannot enter any branch', () => {
    for (const extra of [{ tool_policy: { v: 1 } }, { budget: { v: 1 } }, { avatar: null }]) {
      expect(parse({ type: 'report', agent_id: 'daily_email_digest', ...extra }).success).toBe(
        false
      )
    }
  })
})

describe('internal_agent_update — wire fidelity + server-side guards', () => {
  test('🔴 changing rule.freq syncs the cadence mirror (weekly report must not decay to daily)', async () => {
    const { tools, puts } = writableTools()
    await approveAndRun(tools.internal_agent_update, {
      type: 'report',
      agent_id: 'daily_email_digest',
      schedule: {
        rule: { ...DAILY_REPORT.schedule.rule, freq: 'weekly', weekdays: [2] },
        anchor: '2026-08-14',
        timezone: 'America/Los_Angeles'
      }
    })
    expect(puts).toHaveLength(1)
    const schedule = puts[0].body.schedule as Record<string, unknown>
    // cadence 由 writeReportSchedule 恒同步为 rule.freq —— 模型碰不到它，也就无法让二者劈叉。
    expect(schedule.cadence).toBe('weekly')
    expect((schedule.rule as Record<string, unknown>).freq).toBe('weekly')
    // legacy 降级镜像：weekday 用 Python 口径（0=周一），契约口径的 2（周二）→ 1。
    expect(schedule.weekday).toBe(1)
    expect(schedule.kind).toBe('schedule')
  })

  test('before/after both come from the server, never from model input', async () => {
    const { tools } = writableTools()
    const out = (await approveAndRun(tools.internal_agent_update, {
      type: 'report',
      agent_id: 'daily_email_digest',
      title: '新的日报标题'
    })) as UpdateResult
    expect(out.updated).toBe(true)
    expect(out.before.title).toBe('邮件日报') // 服务端改动前那一读
    expect(out.after.title).toBe('新的日报标题') // 服务端写入返回值
  })

  test('preprocess patch reaches the wire with its real fields', async () => {
    const { tools, puts } = writableTools()
    await approveAndRun(tools.internal_agent_update, {
      type: 'preprocess',
      agent_id: 'email_preprocess_agent',
      context_docs: ['soul', 'agent', 'user'],
      context_source: 'notion_context',
      mark_read_after_processing: true
    })
    expect(puts[0].body).toEqual({
      context_docs: ['soul', 'agent', 'user'],
      context_source: 'notion_context',
      mark_read_after_processing: true
    })
  })

  test('project_progress email_filter becomes a v1 trigger envelope', async () => {
    const { tools, puts } = writableTools()
    await approveAndRun(tools.internal_agent_update, {
      type: 'project_progress',
      agent_id: 'project_progress_sync',
      email_filter: { sender_pattern: 'new.sender@tp-link.com' }
    })
    expect(puts[0].body.trigger).toEqual({
      v: 1,
      kind: 'email_filter',
      sender_pattern: 'new.sender@tp-link.com'
    })
  })

  test('🔴 declared type must match the server row (read A, write B is refused)', async () => {
    const { tools, puts } = writableTools()
    await expect(
      approveAndRun(tools.internal_agent_update, {
        type: 'report',
        agent_id: 'email_search_agent',
        title: 'x'
      })
    ).rejects.toThrow(/type 'search'/)
    expect(puts).toHaveLength(0)
  })

  test('a custom agent is refused and points at custom_agent_update', async () => {
    const { tools, puts } = writableTools()
    await expect(
      approveAndRun(tools.internal_agent_update, {
        type: 'report',
        agent_id: 'dms-approver',
        title: 'x'
      })
    ).rejects.toThrow(/custom_agent_update/)
    expect(puts).toHaveLength(0)
  })

  test('unknown agent / empty patch are refused before any write', async () => {
    const { tools, puts } = writableTools()
    await expect(
      approveAndRun(tools.internal_agent_update, { type: 'report', agent_id: 'nope', title: 'x' })
    ).rejects.toThrow(/no agent nope/)
    await expect(
      approveAndRun(
        tools.internal_agent_update,
        { type: 'report', agent_id: 'daily_email_digest' },
        'tc-ia2' // 换一个 toolCallId：同一个 id 复用会撞上 identity pin 而不是本用例要断言的拒绝
      )
    ).rejects.toThrow(/at least one field/)
    expect(puts).toHaveLength(0)
  })
})

describe('registration — flag gate + venue floor', () => {
  test('explicit false → not added; ToolSet keys byte-identical to the pre-08-14 set', () => {
    const base = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    const flagOff = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      internalAgentToolsEnabled: false,
      contextMode: 'manual_chat'
    })
    expect(Object.keys(flagOff)).toEqual(Object.keys(base))
    for (const name of GATEWAY_INTERNAL_AGENT_TOOL_NAMES) {
      expect(base[name]).toBeUndefined()
      expect(flagOff[name]).toBeUndefined()
    }
  })

  test('flag on + guard → all three register in manual chat', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      internalAgentToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    for (const name of GATEWAY_INTERNAL_AGENT_TOOL_NAMES) expect(tools[name]).toBeDefined()
  })

  test('flag on but NO guard → none of the three (all-or-nothing: half a capability never registers)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      internalAgentToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    for (const name of GATEWAY_INTERNAL_AGENT_TOOL_NAMES) expect(tools[name]).toBeUndefined()
  })

  test('🔴 class capability_change ⇒ absent from every non-manual venue', () => {
    for (const mode of [
      'cron_headless',
      'untrusted_trigger',
      'im_chat',
      'matter_followup'
    ] as const) {
      const tools = buildGatewayTools({
        domain: mockDomain(() => okEnvelope([])),
        approvalGuard: new ApprovalGuard(),
        internalAgentToolsEnabled: true,
        contextMode: mode
      })
      for (const name of GATEWAY_INTERNAL_AGENT_TOOL_NAMES) {
        expect(tools[name], `${name} must not register in ${mode}`).toBeUndefined()
      }
    }
  })
})
