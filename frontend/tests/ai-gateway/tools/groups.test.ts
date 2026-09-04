// L4 群聊 g2 — the group tool family (tools/groups.ts): three factories, one declaration.
// Pure Node: fake hooks + a REAL ApprovalGuard, zero chat_db. What is pinned here: the per-venue
// scope predicates, the judge's card-free posture (needsApproval never true) with its judge_denied
// forensic rows, the per-turn / per-family caps, the server-verified user_requested of the main
// agent, the delivery-row shape, and the single-declaration invariant validate_catalog depends on.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from 'ai'
import { describe, expect, test, vi } from 'vitest'

import type { GroupSessionFacts } from '../../../src/ai-gateway/config'
import type { GroupTranscriptRow } from '../../../src/ai-gateway/groupChat'
import {
  GROUP_HISTORY_LIMIT_MAX,
  MAIN_AGENT_MEMBER_ID,
  POSTS_PER_TURN_CAP,
  SUBGROUPS_PER_FAMILY_CAP
} from '../../../src/ai-gateway/groupFloors'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import {
  GATEWAY_GROUP_TOOL_NAMES,
  createGroupJudgeTools,
  createGroupMemberTools,
  createGroupTools,
  denyOnlyPrefs,
  type GroupToolHooks
} from '../../../src/ai-gateway/tools/groups'
import {
  stripOwnerDeniedTools,
  type GatewayToolAuditEntry,
  type GatewayToolApprovalPrefs
} from '../../../src/ai-gateway/tools/types'

// ── fixture world ──────────────────────────────────────────────────────────────────────────────
// 10 = main group (judge j + a b c, children 11 / 12) · 11 = wolves (j a b) · 12 = seer (j c) ·
// 20 = an unrelated group · 5 = a plain (non-group) session · 1 = the main agent's chat session.

const MAIN = 10
const SUB_A = 11
const SUB_B = 12
const OTHER = 20
const PLAIN = 5

function mkFacts(members: string[], p: Partial<GroupSessionFacts> = {}): GroupSessionFacts {
  return {
    members: members.map((id) => ({ agentId: id, title: `T-${id}` })),
    config: { v: 1 },
    modes: {},
    parentSessionId: null,
    childSessionIds: [],
    judgeScopeStale: false,
    ...p
  }
}

function row(
  id: number,
  role: 'user' | 'assistant' | 'system',
  content: string,
  speakerAgentId: string | null = null,
  extra: Partial<GroupTranscriptRow> = {}
): GroupTranscriptRow {
  return {
    id,
    role,
    content,
    speakerAgentId,
    status: 'complete',
    chainId: null,
    via: null,
    createdAt: 1_700_000_000_000 + id,
    ...extra
  }
}

interface World {
  hooks: GroupToolHooks
  facts: Map<number, GroupSessionFacts>
  rows: Map<number, GroupTranscriptRow[]>
  appended: Array<{
    sessionId: number
    msg: Parameters<GroupToolHooks['appendGroupMessage']>[1]
    id: number
  }>
  deliver: ReturnType<typeof vi.fn> | undefined
  last: string | null
}

function world(): World {
  const facts = new Map<number, GroupSessionFacts>([
    [
      MAIN,
      mkFacts(['j', 'a', 'b', 'c'], {
        config: { v: 1, judgeAgentId: 'j', chainCap: 5 },
        modes: { a: 'realtime' },
        childSessionIds: [SUB_A, SUB_B]
      })
    ],
    [SUB_A, mkFacts(['j', 'a', 'b'], { parentSessionId: MAIN })],
    [SUB_B, mkFacts(['j', 'c'], { parentSessionId: MAIN })],
    [OTHER, mkFacts(['x', 'y'])]
  ])
  const titles = new Map<number, string>([
    [MAIN, '项目主群'],
    [SUB_A, '子群甲'],
    [SUB_B, '子群乙'],
    [OTHER, '别的群'],
    [PLAIN, '普通会话']
  ])
  const rows = new Map<number, GroupTranscriptRow[]>([
    [MAIN, []],
    [SUB_A, []],
    [SUB_B, []],
    [OTHER, []]
  ])
  let nextId = 1000
  const w: World = {
    facts,
    rows,
    appended: [],
    deliver: vi.fn(async () => ({ queued: ['a', 'b'] })),
    last: null,
    hooks: {
      resolveGroupSession: vi.fn((id: number) => facts.get(id) ?? null),
      listGroupHistory: vi.fn((id: number) => rows.get(id) ?? []),
      appendGroupMessage: vi.fn((sessionId: number, msg) => {
        const id = ++nextId
        w.appended.push({ sessionId, msg, id })
        return id
      }),
      groupUsage: vi.fn(() => ({ turns: 3, tokens: 1234, costUsd: null })),
      deliverGroupMessage: () =>
        w.deliver as unknown as ReturnType<GroupToolHooks['deliverGroupMessage']>,
      getSessionTitle: (id: number) => titles.get(id) ?? null,
      lastHumanMessageText: vi.fn(() => w.last),
      createGroupSession: vi.fn(async (input) => ({
        sessionId: 77,
        title: input.title,
        members: input.memberAgentIds,
        parentSessionId: input.parentSessionId
      })),
      setGroupConfig: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined)
    }
  }
  return w
}

const calls = (fn: unknown): number => (fn as ReturnType<typeof vi.fn>).mock.calls.length
const lastCall = (fn: unknown): unknown[] => {
  const c = (fn as ReturnType<typeof vi.fn>).mock.calls
  return c[c.length - 1] as unknown[]
}
const systemRows = (w: World, sessionId: number): Array<Record<string, unknown>> =>
  w.appended
    .filter((a) => a.sessionId === sessionId && a.msg.role === 'system')
    .map((a) => JSON.parse(a.msg.metadata ?? 'null') as Record<string, unknown>)

/** Parse like ai would before execute (zod defaults / bounds apply). */
function parseInput(tool: Tool, raw: unknown): unknown {
  const schema = tool.inputSchema as { parse?: (v: unknown) => unknown }
  return schema.parse ? schema.parse(raw) : raw
}
async function needs(tool: Tool, input: unknown, toolCallId = 'tc-1'): Promise<boolean> {
  const fn = tool.needsApproval as
    | ((i: unknown, o: unknown) => boolean | Promise<boolean>)
    | boolean
    | undefined
  if (typeof fn !== 'function') return fn === true
  return await fn(parseInput(tool, input), { toolCallId })
}
async function execute(tool: Tool, input: unknown, toolCallId = 'tc-1'): Promise<unknown> {
  const exec = tool.execute as (i: unknown, o: unknown) => Promise<unknown>
  return exec(parseInput(tool, input), { toolCallId, messages: [], abortSignal: undefined })
}
/** needsApproval (registers the guard record) then execute — the two-call HITL flow. */
async function runWrite(tool: Tool, input: unknown, toolCallId = 'tc-1'): Promise<unknown> {
  await needs(tool, input, toolCallId)
  return execute(tool, input, toolCallId)
}

function mainTools(w: World, opts: Partial<Parameters<typeof createGroupTools>[3]> = {}) {
  const collector: GatewayToolAuditEntry[] = []
  const tools = createGroupTools(collector, new ApprovalGuard(), w.hooks, {
    sessionId: 1,
    contextMode: 'manual_chat',
    ...opts
  })
  return { tools, collector }
}
function judgeTools(w: World, opts: Partial<Parameters<typeof createGroupJudgeTools>[3]> = {}) {
  const collector: GatewayToolAuditEntry[] = []
  const tools = createGroupJudgeTools(collector, new ApprovalGuard(), w.hooks, {
    sessionId: MAIN,
    judgeAgentId: 'j',
    familySessionIds: [MAIN, SUB_A, SUB_B],
    judgeScopeStale: false,
    contextMode: 'manual_chat',
    ...opts
  })
  return { tools, collector }
}
function memberTools(w: World, sessionId = SUB_A) {
  const collector: GatewayToolAuditEntry[] = []
  return { tools: createGroupMemberTools(collector, w.hooks, { sessionId }), collector }
}

const FOUR = [...GATEWAY_GROUP_TOOL_NAMES].sort()
const POST = { session_id: SUB_A, text: '子群里说一句' }

// ── G1–G3 factory surfaces ──────────────────────────────────────────────────────────────────────

describe('group tool factories — surfaces', () => {
  test('G1 main-agent factory keys = the four names, all ∈ GATEWAY_GROUP_TOOL_NAMES', () => {
    const { tools } = mainTools(world())
    expect(Object.keys(tools).sort()).toEqual(FOUR)
    for (const k of Object.keys(tools)) expect(GATEWAY_GROUP_TOOL_NAMES).toContain(k)
  })

  test('G2 member factory keys ⊆ {group_history, group_members}, no writes at all', () => {
    const { tools } = memberTools(world())
    expect(Object.keys(tools).sort()).toEqual(['group_history', 'group_members'])
    expect(tools.group_post).toBeUndefined()
    expect(tools.group_create).toBeUndefined()
    for (const t of Object.values(tools)) expect(t.needsApproval).toBeUndefined()
  })

  test('G3 judge factory keys = the four names', () => {
    const { tools } = judgeTools(world())
    expect(Object.keys(tools).sort()).toEqual(FOUR)
  })
})

// ── G4–G5 read scope ────────────────────────────────────────────────────────────────────────────

describe('read scope', () => {
  test('G4 member reading its parent / a sibling → E_GROUP_SCOPE with zero hook calls; own group ok', async () => {
    const w = world()
    const { tools } = memberTools(w, SUB_A)
    for (const target of [MAIN, SUB_B, OTHER]) {
      await expect(execute(tools.group_history!, { session_id: target })).rejects.toMatchObject({
        code: 'E_GROUP_SCOPE'
      })
      await expect(execute(tools.group_members!, { session_id: target })).rejects.toMatchObject({
        code: 'E_GROUP_SCOPE'
      })
    }
    expect(calls(w.hooks.resolveGroupSession)).toBe(0)
    expect(calls(w.hooks.listGroupHistory)).toBe(0)
    expect(calls(w.hooks.groupUsage)).toBe(0)
    // omitted session_id = the current group
    expect(await execute(tools.group_members!, {})).toMatchObject({
      session_id: SUB_A,
      title: '子群甲'
    })
    expect(await execute(tools.group_history!, { session_id: SUB_A })).toMatchObject({
      session_id: SUB_A
    })
  })

  test('G5 judge reads the three family groups; outside the family → E_GROUP_SCOPE, zero calls', async () => {
    const w = world()
    const { tools } = judgeTools(w)
    for (const target of [MAIN, SUB_A, SUB_B]) {
      expect(await execute(tools.group_members!, { session_id: target })).toMatchObject({
        session_id: target
      })
      expect(await execute(tools.group_history!, { session_id: target })).toMatchObject({
        session_id: target
      })
    }
    const before = calls(w.hooks.resolveGroupSession)
    await expect(execute(tools.group_history!, { session_id: OTHER })).rejects.toMatchObject({
      code: 'E_GROUP_SCOPE'
    })
    await expect(execute(tools.group_members!, { session_id: OTHER })).rejects.toMatchObject({
      code: 'E_GROUP_SCOPE'
    })
    expect(calls(w.hooks.resolveGroupSession)).toBe(before)
    // group_members projection (own group)
    const m = (await execute(tools.group_members!, {})) as Record<string, unknown>
    expect(m).toMatchObject({
      session_id: MAIN,
      title: '项目主群',
      parent_session_id: null,
      child_sessions: [
        { id: SUB_A, title: '子群甲' },
        { id: SUB_B, title: '子群乙' }
      ],
      judge_scope_stale: false,
      budget: {
        hourly_turns_used: 3,
        hourly_tokens_used: 1234,
        hourly_usd_used: null,
        caps: { chainCap: 5, hourlyTurns: 60 }
      }
    })
    expect(m.members).toEqual([
      { agent_id: 'j', title: 'T-j', response_mode: 'mention', is_judge: true },
      { agent_id: 'a', title: 'T-a', response_mode: 'realtime', is_judge: false },
      { agent_id: 'b', title: 'T-b', response_mode: 'mention', is_judge: false },
      { agent_id: 'c', title: 'T-c', response_mode: 'mention', is_judge: false }
    ])
    const [family, since] = lastCall(w.hooks.groupUsage) as [number[], number]
    expect(family).toEqual([MAIN, SUB_A, SUB_B])
    expect(Date.now() - since).toBeGreaterThanOrEqual(3_600_000 - 50)
  })

  test('T3 group_members: child_sessions 不含话题（只列子群）；预算 family 含话题', async () => {
    const THREAD = 31
    const w = world()
    w.facts.set(MAIN, { ...w.facts.get(MAIN)!, threadSessionIds: [THREAD] })
    const { tools } = judgeTools(w)
    const m = (await execute(tools.group_members!, {})) as Record<string, unknown>
    expect(m.child_sessions).toEqual([
      { id: SUB_A, title: '子群甲' },
      { id: SUB_B, title: '子群乙' }
    ])
    const [family] = lastCall(w.hooks.groupUsage) as [number[], number]
    expect(family).toEqual([MAIN, SUB_A, SUB_B, THREAD])
  })
})

// ── G6–G11 judge writes ─────────────────────────────────────────────────────────────────────────

describe('judge group_post / group_create', () => {
  test('G6 fresh judge posts to a subgroup card-free (auto_judge_scope), chain-root assistant row + judge_post trace', async () => {
    const w = world()
    const { tools, collector } = judgeTools(w)
    expect(await needs(tools.group_post!, POST)).toBe(false)
    const out = (await execute(tools.group_post!, POST)) as Record<string, unknown>
    // audit (collector-level — group runs never persist chat_tool_call)
    expect(collector).toHaveLength(1)
    expect(collector[0]).toMatchObject({
      toolName: 'group_post',
      status: 'ok',
      confirmationTier: 'edit',
      approvalStatus: 'auto_judge_scope'
    })
    // the delivery row in the TARGET group
    const delivery = w.appended.find((a) => a.sessionId === SUB_A)!
    expect(delivery.msg).toMatchObject({
      role: 'assistant',
      content: '子群里说一句',
      speakerAgentId: 'j'
    })
    expect(Object.prototype.hasOwnProperty.call(delivery.msg, 'chainId')).toBe(false)
    expect(JSON.parse(delivery.msg.metadata!)).toEqual({
      via: 'judge_post',
      sourceSessionId: MAIN,
      judgeAgentId: 'j'
    })
    // the seam
    expect(calls(w.deliver)).toBe(1)
    const [target, seamRow] = lastCall(w.deliver) as [number, GroupTranscriptRow]
    expect(target).toBe(SUB_A)
    expect(seamRow).toMatchObject({
      id: delivery.id,
      role: 'assistant',
      speakerAgentId: 'j',
      chainId: null,
      via: 'judge_post',
      status: 'complete'
    })
    // return shape
    expect(out).toEqual({
      ok: true,
      message_id: delivery.id,
      chain_id: delivery.id,
      woke: ['a', 'b']
    })
    // the trace in the judge's OWN group
    expect(systemRows(w, MAIN)).toEqual([
      { kind: 'judge_post', targetSessionId: SUB_A, messageId: delivery.id, woke: ['a', 'b'] }
    ])
  })

  test('G7 stale judge scope → E_JUDGE_SCOPE_STALE + ONE judge_denied(scope_stale) row per target', async () => {
    const w = world()
    const { tools } = judgeTools(w, { judgeScopeStale: true })
    await expect(runWrite(tools.group_post!, POST, 'tc-a')).rejects.toMatchObject({
      code: 'E_JUDGE_SCOPE_STALE'
    })
    expect(systemRows(w, MAIN)).toEqual([
      { kind: 'judge_denied', reason: 'scope_stale', targetSessionId: SUB_A }
    ])
    await expect(runWrite(tools.group_post!, POST, 'tc-b')).rejects.toMatchObject({
      code: 'E_JUDGE_SCOPE_STALE'
    })
    expect(systemRows(w, MAIN)).toHaveLength(1)
    expect(calls(w.deliver)).toBe(0)
    expect(w.appended.filter((a) => a.sessionId === SUB_A)).toHaveLength(0)
    // group_create under a stale anchor is refused the same way (no target)
    await expect(
      runWrite(
        tools.group_create!,
        { title: 'x', member_agent_ids: ['j', 'a'], opening_text: 'o' },
        'tc-c'
      )
    ).rejects.toMatchObject({ code: 'E_JUDGE_SCOPE_STALE' })
    expect(systemRows(w, MAIN)).toHaveLength(2)
    expect(systemRows(w, MAIN)[1]).toEqual({ kind: 'judge_denied', reason: 'scope_stale' })
    expect(calls(w.hooks.createGroupSession)).toBe(0)
  })

  test('G8 the third group_post of one factory instance → E_GROUP_POST_CAP; a new factory starts at zero', async () => {
    const w = world()
    const { tools } = judgeTools(w)
    for (let i = 0; i < POSTS_PER_TURN_CAP; i++) {
      await expect(runWrite(tools.group_post!, POST, `tc-${i}`)).resolves.toMatchObject({
        ok: true
      })
    }
    await expect(
      runWrite(tools.group_post!, { session_id: SUB_B, text: '第三次投递' }, 'tc-cap')
    ).rejects.toMatchObject({ code: 'E_GROUP_POST_CAP' })
    expect(systemRows(w, MAIN).filter((r) => r.kind === 'judge_denied')).toEqual([
      { kind: 'judge_denied', reason: 'posts_per_turn', targetSessionId: SUB_B }
    ])
    expect(calls(w.deliver)).toBe(POSTS_PER_TURN_CAP)
    const fresh = judgeTools(w)
    await expect(runWrite(fresh.tools.group_post!, POST, 'tc-fresh')).resolves.toMatchObject({
      ok: true
    })
  })

  test('G9 structural: the judge factory NEVER asks — needsApproval is false for every tool in every state', async () => {
    const w = world()
    const prefs: GatewayToolApprovalPrefs['tools'] = {
      group_post: { tier: 'ask', source: 'owner' },
      group_create: { tier: 'ask', source: 'owner' }
    }
    const { tools } = judgeTools(w, { judgeScopeStale: true, toolApprovalPrefs: prefs })
    const inputs: Record<string, unknown[]> = {
      group_history: [{}, { session_id: OTHER }],
      group_members: [{}, { session_id: OTHER }],
      group_post: [POST, { session_id: OTHER, text: 'x' }, { session_id: MAIN, text: 'x' }],
      group_create: [
        { title: 't', member_agent_ids: ['j', 'a'], opening_text: 'o' },
        { title: 't', member_agent_ids: ['x'], opening_text: 'o', parent_session_id: 999 }
      ]
    }
    for (const name of GATEWAY_GROUP_TOOL_NAMES) {
      for (const [i, input] of inputs[name]!.entries()) {
        expect(await needs(tools[name]!, input, `tc-${name}-${i}`)).toBe(false)
      }
    }
  })

  test('G10 owner deny survives denyOnlyPrefs → E_TOOL_DENIED; owner ask is dropped → still auto_judge_scope', async () => {
    const deny: GatewayToolApprovalPrefs['tools'] = {
      group_post: { tier: 'deny', source: 'owner' },
      email_archive: { tier: 'auto', source: 'default' }
    }
    expect(denyOnlyPrefs(deny)).toEqual({ group_post: { tier: 'deny', source: 'owner' } })
    expect(denyOnlyPrefs(undefined)).toBeUndefined()
    const w1 = world()
    const denied = judgeTools(w1, { toolApprovalPrefs: deny })
    expect(await needs(denied.tools.group_post!, POST)).toBe(false)
    await expect(execute(denied.tools.group_post!, POST)).rejects.toMatchObject({
      code: 'E_TOOL_DENIED'
    })
    expect(denied.collector[0]).toMatchObject({ status: 'error', approvalStatus: 'rejected' })
    expect(calls(w1.deliver)).toBe(0)

    const ask: GatewayToolApprovalPrefs['tools'] = { group_post: { tier: 'ask', source: 'owner' } }
    expect(denyOnlyPrefs(ask)).toEqual({})
    const w2 = world()
    const asked = judgeTools(w2, { toolApprovalPrefs: ask })
    expect(await needs(asked.tools.group_post!, POST)).toBe(false)
    await execute(asked.tools.group_post!, POST)
    expect(asked.collector[0]?.approvalStatus).toBe('auto_judge_scope')
  })

  test('G11 judge group_create: subset+judge ok with parent pinned to its own group; no judge / outsider → E_GROUP_SCOPE; cap → E_SUBGROUP_CAP', async () => {
    const w = world()
    const { tools, collector } = judgeTools(w)
    const out = (await runWrite(tools.group_create!, {
      title: '子群甲',
      member_agent_ids: ['j', 'a', 'b'],
      opening_text: '开场白',
      parent_session_id: 999
    })) as Record<string, unknown>
    expect(lastCall(w.hooks.createGroupSession)[0]).toEqual({
      title: '子群甲',
      memberAgentIds: ['j', 'a', 'b'],
      parentSessionId: MAIN,
      invokedBy: 'judge'
    })
    expect(out).toMatchObject({
      session_id: 77,
      parent_session_id: MAIN,
      config_applied: true,
      woke: ['a', 'b']
    })
    expect(collector[0]?.approvalStatus).toBe('auto_judge_scope')
    // the opening is a judge_post delivery row in the NEW group + a trace in the judge's group
    const opening = w.appended.find((a) => a.sessionId === 77)!
    expect(opening.msg).toMatchObject({
      role: 'assistant',
      speakerAgentId: 'j',
      content: '开场白'
    })
    expect(systemRows(w, MAIN)).toEqual([
      { kind: 'judge_post', targetSessionId: 77, messageId: opening.id, woke: ['a', 'b'] }
    ])

    await expect(
      runWrite(
        tools.group_create!,
        { title: 'x', member_agent_ids: ['a', 'b'], opening_text: 'o' },
        'tc-nojudge'
      )
    ).rejects.toMatchObject({ code: 'E_GROUP_SCOPE' })
    await expect(
      runWrite(
        tools.group_create!,
        { title: 'x', member_agent_ids: ['j', 'zz'], opening_text: 'o' },
        'tc-outsider'
      )
    ).rejects.toMatchObject({ code: 'E_GROUP_SCOPE' })
    expect(calls(w.hooks.createGroupSession)).toBe(1)

    w.facts.set(
      MAIN,
      mkFacts(['j', 'a', 'b', 'c'], {
        config: { v: 1, judgeAgentId: 'j' },
        childSessionIds: Array.from({ length: SUBGROUPS_PER_FAMILY_CAP }, (_, i) => 100 + i)
      })
    )
    await expect(
      runWrite(
        tools.group_create!,
        { title: 'x', member_agent_ids: ['j', 'a'], opening_text: 'o' },
        'tc-cap'
      )
    ).rejects.toMatchObject({ code: 'E_SUBGROUP_CAP' })
    expect(systemRows(w, MAIN).at(-1)).toEqual({ kind: 'judge_denied', reason: 'subgroup_cap' })
    expect(calls(w.hooks.createGroupSession)).toBe(1)
  })
})

// ── G12–G14 main agent ──────────────────────────────────────────────────────────────────────────

describe('main-agent group tools', () => {
  test('G12 user_requested is server-verified: title in last human message → auto_user_requested_verified; else ask', async () => {
    const w = world()
    w.last = '把这句话发到子群甲里'
    const { tools, collector } = mainTools(w)
    const verified = { ...POST, user_requested: true }
    expect(await needs(tools.group_post!, verified, 'tc-1')).toBe(false)
    await execute(tools.group_post!, verified, 'tc-1')
    expect(collector[0]?.approvalStatus).toBe('auto_user_requested_verified')
    // claim without the target title → ask
    w.last = '随便聊聊'
    expect(await needs(tools.group_post!, verified, 'tc-2')).toBe(true)
    // another group's title in the message does not verify THIS target
    w.last = '发到子群乙'
    expect(await needs(tools.group_post!, verified, 'tc-3')).toBe(true)
    // no claim → ask even when the title is present
    w.last = '把这句话发到子群甲里'
    expect(await needs(tools.group_post!, POST, 'tc-4')).toBe(true)
    // nothing readable → ask
    w.last = null
    expect(await needs(tools.group_post!, verified, 'tc-5')).toBe(true)
    // no session → ask (lastHumanMessageText never consulted)
    w.last = '把这句话发到子群甲里'
    const nosession = mainTools(w, { sessionId: null })
    const before = calls(w.hooks.lastHumanMessageText)
    expect(await needs(nosession.tools.group_post!, verified, 'tc-6')).toBe(true)
    expect(calls(w.hooks.lastHumanMessageText)).toBe(before)
    // group_create: keyword → auto, none → ask
    const create = {
      title: '讨论组',
      member_agent_ids: ['a', 'b'],
      opening_text: '大家好',
      user_requested: true
    }
    w.last = '帮我建个群，把 a 和 b 拉进来'
    expect(await needs(tools.group_create!, create, 'tc-7')).toBe(false)
    await execute(tools.group_create!, create, 'tc-7')
    expect(collector.at(-1)?.approvalStatus).toBe('auto_user_requested_verified')
    w.last = '今天天气不错'
    expect(await needs(tools.group_create!, create, 'tc-8')).toBe(true)
    w.last = 'please create a group for a and b'
    expect(await needs(tools.group_create!, create, 'tc-9')).toBe(false)
  })

  test('G13 group_post: non-group target → E_NOT_GROUP; missing scheduler → E_GROUP_NOT_ORCHESTRATED before any append', async () => {
    const w = world()
    const { tools } = mainTools(w)
    await expect(
      runWrite(tools.group_post!, { session_id: PLAIN, text: 'hi' }, 'tc-plain')
    ).rejects.toMatchObject({ code: 'E_NOT_GROUP' })
    w.deliver = undefined
    await expect(runWrite(tools.group_post!, POST, 'tc-noseam')).rejects.toMatchObject({
      code: 'E_GROUP_NOT_ORCHESTRATED'
    })
    expect(calls(w.hooks.appendGroupMessage)).toBe(0)
    // and with the seam back: user-role chain-root row, via main_agent, sourceSessionId = the chat
    w.deliver = vi.fn(async () => ({ queued: ['a'] }))
    const out = (await runWrite(tools.group_post!, POST, 'tc-ok')) as Record<string, unknown>
    const delivery = w.appended.find((a) => a.sessionId === SUB_A)!
    expect(delivery.msg).toMatchObject({
      role: 'user',
      speakerAgentId: null,
      content: '子群里说一句'
    })
    expect(Object.prototype.hasOwnProperty.call(delivery.msg, 'chainId')).toBe(false)
    expect(JSON.parse(delivery.msg.metadata!)).toEqual({ via: 'main_agent', sourceSessionId: 1 })
    const [, seamRow] = lastCall(w.deliver) as [number, GroupTranscriptRow]
    expect(seamRow).toMatchObject({
      id: delivery.id,
      role: 'user',
      chainId: null,
      via: 'main_agent'
    })
    expect(out).toEqual({ ok: true, message_id: delivery.id, chain_id: delivery.id, woke: ['a'] })
    // a human-approved main-agent write audits 'approved' (no user_requested claim)
    expect(systemRows(w, MAIN)).toEqual([])
  })

  test('G14 group_create three steps: config failure → deleteSession + throw; without deleteSession → config_applied:false', async () => {
    const create = {
      title: '讨论组',
      member_agent_ids: ['a', 'b'],
      opening_text: '大家好',
      judge_agent_id: 'a',
      modes: { a: 'realtime' as const }
    }
    // happy path: step 2 only runs when there is something to apply; invokedBy main_agent, parent from input
    const w0 = world()
    const happy = mainTools(w0)
    const out = (await runWrite(happy.tools.group_create!, {
      ...create,
      parent_session_id: MAIN
    })) as Record<string, unknown>
    expect(lastCall(w0.hooks.createGroupSession)[0]).toEqual({
      title: '讨论组',
      memberAgentIds: ['a', 'b'],
      parentSessionId: MAIN,
      invokedBy: 'main_agent'
    })
    expect(lastCall(w0.hooks.setGroupConfig)).toEqual([
      77,
      { judgeAgentId: 'a', modes: { a: 'realtime' } }
    ])
    expect(out).toMatchObject({
      session_id: 77,
      title: '讨论组',
      members: ['a', 'b'],
      parent_session_id: MAIN,
      config_applied: true,
      woke: ['a', 'b']
    })
    expect(w0.appended.find((a) => a.sessionId === 77)!.msg).toMatchObject({
      role: 'user',
      content: '大家好'
    })
    expect(happy.collector[0]?.approvalStatus).toBe('approved')
    const plain = mainTools(world())
    const w1 = world()
    await runWrite(mainTools(w1).tools.group_create!, {
      title: 't',
      member_agent_ids: ['a'],
      opening_text: 'o'
    })
    expect(calls(w1.hooks.setGroupConfig)).toBe(0)
    expect(lastCall(w1.hooks.createGroupSession)[0]).toMatchObject({ parentSessionId: null })
    void plain

    // step 2 fails, compensation available → delete + rethrow the ORIGINAL error
    const w2 = world()
    ;(w2.hooks.setGroupConfig as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('config boom')
    )
    await expect(runWrite(mainTools(w2).tools.group_create!, create)).rejects.toMatchObject({
      code: 'E_INTERNAL',
      message: expect.stringContaining('config boom')
    })
    expect(lastCall(w2.hooks.deleteSession)).toEqual([77])
    expect(calls(w2.deliver)).toBe(0)

    // step 2 fails, no compensation hook → the group stays, config_applied:false, opening still delivered
    const w3 = world()
    ;(w3.hooks.setGroupConfig as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('config boom')
    )
    w3.hooks.deleteSession = undefined
    const degraded = (await runWrite(mainTools(w3).tools.group_create!, create)) as Record<
      string,
      unknown
    >
    expect(degraded).toMatchObject({ session_id: 77, config_applied: false, woke: ['a', 'b'] })
    expect(calls(w3.deliver)).toBe(1)

    // step 3 (opening) fails → compensation, throw
    const w4 = world()
    w4.deliver = vi.fn(async () => {
      throw new Error('seam boom')
    })
    await expect(runWrite(mainTools(w4).tools.group_create!, create)).rejects.toMatchObject({
      message: expect.stringContaining('seam boom')
    })
    expect(lastCall(w4.hooks.deleteSession)).toEqual([77])
  })
})

// ── G18–G21 主 agent 入群（T4）────────────────────────────────────────────────────────────────
// 保留字 'main' 没有 report_agent 行；在工具面上它只是又一个成员 id —— 三个工厂零特判。钉的是：
// 成员 run 仍只有两件读；主持人 run 四件恒免卡、子群名单必须含它、投递行以它为 speaker；
// 主 agent 单聊版对「自己已是成员的群」拒 group_post、拒把自己拉进 group_create
// （E_GROUP_SELF_MEMBER：一个身份一条入口）。

describe('T4 主 agent 入群', () => {
  const HOSTED = 30 // main 是成员且坐主持人位
  const JOINED = 31 // main 只是普通成员
  function withMain(w: World): World {
    w.facts.set(
      HOSTED,
      mkFacts([MAIN_AGENT_MEMBER_ID, 'a', 'b'], {
        config: { v: 1, judgeAgentId: MAIN_AGENT_MEMBER_ID }
      })
    )
    w.facts.set(JOINED, mkFacts(['a', MAIN_AGENT_MEMBER_ID], { modes: { main: 'realtime' } }))
    w.rows.set(HOSTED, [])
    w.rows.set(JOINED, [])
    return w
  }

  test('G18 main 作为普通成员：成员工厂仍只有两件读；group_members 把它当普通成员列出', async () => {
    const w = withMain(world())
    const { tools } = memberTools(w, JOINED)
    expect(Object.keys(tools).sort()).toEqual(['group_history', 'group_members'])
    const out = (await execute(tools.group_members!, {})) as {
      members: Array<Record<string, unknown>>
    }
    expect(out.members).toEqual([
      { agent_id: 'a', title: 'T-a', response_mode: 'mention', is_judge: false },
      {
        agent_id: MAIN_AGENT_MEMBER_ID,
        title: 'T-main',
        response_mode: 'realtime',
        is_judge: false
      }
    ])
  })

  test('G19 main 坐主持人位：四件、needsApproval 恒 false、子群名单必须含 main、投递行 speaker=main', async () => {
    const w = withMain(world())
    const { tools } = judgeTools(w, {
      sessionId: HOSTED,
      judgeAgentId: MAIN_AGENT_MEMBER_ID,
      familySessionIds: [HOSTED]
    })
    expect(Object.keys(tools).sort()).toEqual(FOUR)
    const create = { title: '子群', member_agent_ids: ['a', 'b'], opening_text: '开会' }
    expect(await needs(tools.group_create!, create, 'tc-c1')).toBe(false)
    expect(await needs(tools.group_post!, { session_id: HOSTED, text: 'x' }, 'tc-p1')).toBe(false)
    // 子群名单不含主持人 → E_GROUP_SCOPE：保留字走的是同一条「必须含 judge」规则
    await expect(runWrite(tools.group_create!, create, 'tc-c2')).rejects.toMatchObject({
      code: 'E_GROUP_SCOPE'
    })
    const ok = (await runWrite(
      tools.group_create!,
      { ...create, member_agent_ids: [MAIN_AGENT_MEMBER_ID, 'a'] },
      'tc-c3'
    )) as Record<string, unknown>
    expect(ok).toMatchObject({ session_id: 77, parent_session_id: HOSTED })
    const opening = w.appended.find((x) => x.sessionId === 77)!
    expect(opening.msg).toMatchObject({ role: 'assistant', speakerAgentId: MAIN_AGENT_MEMBER_ID })
    expect(JSON.parse(opening.msg.metadata!)).toMatchObject({
      via: 'judge_post',
      judgeAgentId: MAIN_AGENT_MEMBER_ID
    })
  })

  test('G20 主 agent 单聊版 group_post：目标群含 main → E_GROUP_SELF_MEMBER（零投递零落行）；不含 → 照常', async () => {
    const w = withMain(world())
    const { tools } = mainTools(w)
    await expect(
      runWrite(tools.group_post!, { session_id: JOINED, text: '我来说两句' }, 'tc-self')
    ).rejects.toMatchObject({
      code: 'E_GROUP_SELF_MEMBER',
      message: expect.stringContaining('你已是该群成员，请直接在群里发言')
    })
    expect(calls(w.hooks.appendGroupMessage)).toBe(0)
    expect(calls(w.deliver)).toBe(0)
    // 对照（防恒绿）：main 不在的群照常投递
    expect(await runWrite(tools.group_post!, POST, 'tc-ok')).toMatchObject({ ok: true })
    // 非群目标仍先于成员判定报 E_NOT_GROUP（G13 的口径不变）
    await expect(
      runWrite(tools.group_post!, { session_id: PLAIN, text: 'hi' }, 'tc-plain')
    ).rejects.toMatchObject({ code: 'E_NOT_GROUP' })
  })

  test('G21 主 agent 单聊版 group_create：member_agent_ids 含 main → E_GROUP_SELF_MEMBER，一步都不走', async () => {
    const w = world()
    const { tools } = mainTools(w)
    await expect(
      runWrite(
        tools.group_create!,
        { title: 't', member_agent_ids: ['a', MAIN_AGENT_MEMBER_ID], opening_text: 'o' },
        'tc-cm'
      )
    ).rejects.toMatchObject({ code: 'E_GROUP_SELF_MEMBER' })
    expect(calls(w.hooks.createGroupSession)).toBe(0)
    expect(calls(w.deliver)).toBe(0)
  })
})

// ── G15 history paging ──────────────────────────────────────────────────────────────────────────

describe('group_history', () => {
  test('G15 default 20 / max 50 / before_message_id paging / GROUP_HISTORY fence', async () => {
    const w = world()
    const transcript: GroupTranscriptRow[] = []
    for (let id = 1; id <= 60; id++) {
      transcript.push(
        id % 3 === 0
          ? row(id, 'assistant', `m${id}`, 'a', { chainId: id - 1 })
          : row(id, 'user', `m${id}`, null, id % 5 === 0 ? { via: 'main_agent' } : {})
      )
    }
    transcript.push(row(61, 'system', '', null))
    transcript.push(row(62, 'assistant', 'streaming…', 'b', { status: 'streaming' }))
    w.rows.set(MAIN, transcript)
    const { tools } = judgeTools(w)
    const h = tools.group_history!

    const page1 = (await execute(h, {})) as {
      messages: Array<Record<string, unknown>>
      has_more: boolean
      oldest_id: number | null
      title: string | null
    }
    expect(page1.messages).toHaveLength(20)
    expect(page1.messages[0]!.id).toBe(41)
    expect(page1.messages.at(-1)!.id).toBe(60)
    expect(page1.has_more).toBe(true)
    expect(page1.oldest_id).toBe(41)
    expect(page1.title).toBe('项目主群')
    expect(page1.messages.map((m) => m.id)).not.toContain(61)
    expect(page1.messages.map((m) => m.id)).not.toContain(62)

    const page2 = (await execute(h, { before_message_id: page1.oldest_id })) as typeof page1
    expect(page2.messages.map((m) => m.id)).toEqual(Array.from({ length: 20 }, (_, i) => 21 + i))
    expect(page2.has_more).toBe(true)
    const page3 = (await execute(h, { before_message_id: page2.oldest_id })) as typeof page1
    expect(page3.messages.map((m) => m.id)).toEqual(Array.from({ length: 20 }, (_, i) => 1 + i))
    expect(page3.has_more).toBe(false)
    expect(page3.oldest_id).toBe(1)

    const big = (await execute(h, { limit: GROUP_HISTORY_LIMIT_MAX })) as typeof page1
    expect(big.messages).toHaveLength(50)
    expect(() => parseInput(h, { limit: GROUP_HISTORY_LIMIT_MAX + 1 })).toThrow()
    expect(() => parseInput(h, { limit: 0 })).toThrow()

    // row projection + fence
    const m45 = page1.messages.find((m) => m.id === 45)!
    expect(m45).toMatchObject({
      role: 'assistant',
      speaker: 'a',
      speaker_title: 'T-a',
      chain_id: 44
    })
    expect(m45.text).toMatch(
      /^UNTRUSTED_GROUP_HISTORY_START session_id=10 message_id=45\nm45\nUNTRUSTED_GROUP_HISTORY_END$/
    )
    expect(page1.messages.find((m) => m.id === 50)).toMatchObject({
      role: 'user',
      speaker: 'main_agent',
      speaker_title: '主助理'
    })
    expect(page1.messages.find((m) => m.id === 46)).toMatchObject({
      role: 'user',
      speaker: 'user',
      speaker_title: '用户'
    })
    expect(typeof m45.created_at).toBe('string')
  })
})

// ── G16–G17 structural guards ───────────────────────────────────────────────────────────────────

describe('structural guards', () => {
  test('G16 every group tool name literal appears exactly once across tools/*.ts (validate_catalog scan_tiers)', () => {
    const dir = join(__dirname, '../../../src/ai-gateway/tools')
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
    for (const name of GATEWAY_GROUP_TOOL_NAMES) {
      const re = new RegExp(`^\\s*name:\\s*'${name}'`, 'gm')
      let hits = 0
      for (const f of files) hits += (readFileSync(join(dir, f), 'utf8').match(re) ?? []).length
      expect({ name, hits }).toEqual({ name, hits: 1 })
    }
    const groupsSrc = readFileSync(join(dir, 'groups.ts'), 'utf8')
    expect((groupsSrc.match(/^\s*risk:\s*'edit'/gm) ?? []).length).toBe(2)
    // validate_catalog's FACTORY_RE needs the bare `auditedReadTool(` / `auditedWriteTool(` token
    // (an explicit `<Generic>(` hides the read factory → the reads lose their silent tier).
    expect((groupsSrc.match(/auditedReadTool\(/g) ?? []).length).toBe(2)
    expect((groupsSrc.match(/auditedWriteTool\(/g) ?? []).length).toBe(2)
    expect(groupsSrc).not.toMatch(/audited(Read|Write)Tool</)
  })

  test('G17 stripOwnerDeniedTools: no hit → the same object; a hit → a new object without the denied name', () => {
    const { tools } = mainTools(world())
    expect(stripOwnerDeniedTools(tools)).toBe(tools)
    expect(
      stripOwnerDeniedTools(tools, {
        group_post: { tier: 'ask', source: 'owner' },
        other: { tier: 'deny', source: 'owner' }
      })
    ).toBe(tools)
    const stripped = stripOwnerDeniedTools(tools, { group_post: { tier: 'deny', source: 'owner' } })
    expect(stripped).not.toBe(tools)
    expect(Object.keys(stripped).sort()).toEqual(['group_create', 'group_history', 'group_members'])
    expect(Object.keys(tools).sort()).toEqual(FOUR)
  })
})

// ── P2-L13 群内 run 的资料库读工具（design §9.3 (b)）──────────────────────────────────────────

describe('group venues — library read tools', () => {
  /** 只实现两个读工具真正会碰的方法；多一个都不给，被调错方法就 TypeError。 */
  function fakeLibraryDomain(hits: unknown[] = []) {
    const calls: string[] = []
    const domain = {
      librarySearch: (input: { q: string; limit: number }) => {
        calls.push(`search:${input.q}`)
        return Promise.resolve({ query: input.q, mode: 'like', hits, warnings: [] })
      },
      libraryFile: (fileId: number) => {
        calls.push(`file:${fileId}`)
        return Promise.resolve({
          id: fileId,
          path: 'my-docs/a.md',
          filename: 'a.md',
          kind: 'markdown',
          status: 'present',
          content: '正文一行'
        })
      }
    }
    return { domain: domain as never, calls }
  }

  test('L13-1 成员 run 拿到 library_read / library_search（不含 library_list）', () => {
    const collector: GatewayToolAuditEntry[] = []
    const tools = createGroupMemberTools(collector, world().hooks, {
      sessionId: SUB_A,
      libraryDomain: fakeLibraryDomain().domain
    })
    expect(Object.keys(tools).sort()).toEqual([
      'group_history',
      'group_members',
      'library_read',
      'library_search'
    ])
  })

  test('L13-2 法官 run 同样给（四件群工具 + 两件资料读）', () => {
    const { tools } = judgeTools(world(), { libraryDomain: fakeLibraryDomain().domain })
    expect(Object.keys(tools).sort()).toEqual([...FOUR, 'library_read', 'library_search'].sort())
  })

  test('L13-3 缺 libraryDomain（老调用点）时与改动前逐字一致', () => {
    const { tools } = memberTools(world())
    expect(Object.keys(tools).sort()).toEqual(['group_history', 'group_members'])
  })

  test('L13-4 两件都是 silent read：零审批面（群 run 里一张卡没人点得动）', () => {
    const collector: GatewayToolAuditEntry[] = []
    const tools = createGroupMemberTools(collector, world().hooks, {
      sessionId: SUB_A,
      libraryDomain: fakeLibraryDomain().domain
    })
    for (const name of ['library_read', 'library_search']) {
      const tool = tools[name] as Tool & { needsApproval?: unknown }
      expect(tool.needsApproval).not.toBe(true)
    }
  })

  test('L13-5 走的是 tools/library.ts 的真实现（打到同一个 domain 方法）', async () => {
    const { domain, calls } = fakeLibraryDomain()
    const collector: GatewayToolAuditEntry[] = []
    const tools = createGroupMemberTools(collector, world().hooks, {
      sessionId: SUB_A,
      libraryDomain: domain
    })
    const read = tools.library_read as Tool & {
      execute: (i: unknown, o: unknown) => Promise<unknown>
    }
    const out = (await read.execute({ file_id: 42, max_chars: 2000 }, {})) as {
      content: string | null
    }
    expect(calls).toEqual(['file:42'])
    // 围栏是 library.ts 那一份的产物 —— 这里没有第二份实现可以漏掉它。
    expect(out.content).toContain('UNTRUSTED_LIBRARY_FILE')
  })
})
