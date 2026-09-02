// L4 群聊 g3 — 零-LLM 整局狼人杀（CI 硬闸）：证明群聊多 agent 机制能把一局从「开始」推到
// 终局（法官以 GAME_OVER_PREFIX 开头宣布），且夜晚信息只在子群、全程受地板约束。
//
// 组合固定（只 mock 模型，其余全真）：
//   • 真 GroupOrchestrator（cascade 默认 true）+ 内存 World（M / W / S 三群，各自 facts 带
//     familySessionIds / parentSessionId / config {judgeAgentId, preset:'werewolf', game}；
//     法官 realtime、玩家 mention）；
//   • deps.speak = 真 speakAsGroupMember（真 prepareChatRun → 真 buildGroupChatIdentityBlock →
//     <game_secret>），cfg.buildGroupSpeakerTools = 真 createGroupJudgeTools / createGroupMemberTools
//     + 假 GroupToolHooks + 真 ApprovalGuard；假 hooks 的投递缝惰性指向 orch.onGroupMessage；
//   • 脚本化 MockLanguageModelV3：按 <members> 成员数判群（M=7 / W=3 / S=2）、按最后一条 user
//     文本与自己的历史判阶段；法官轮先回 tool-call group_post、下一 step 回文本；
//   • 假时钟（每次落行 / 落 turn 推进 1s，回放排序有意义）+ sleep 只记录；🔴 不用 vi.useFakeTimers。
// 最短合法一局：夜 1 狼杀玩家丁 → 白天放逐玩家戊 → 2 狼 2 好 → 法官宣布终局。判据是机制不是
// 游戏正确性。判据常量全部从 groupFloors import。一个 describe 跑一局，各 test 断一条判据。

import type { Tool } from 'ai'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { beforeAll, describe, expect, test } from 'vitest'

import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import type { AiGatewayConfig, GroupSessionFacts } from '../../src/ai-gateway/config'
import type { GroupTranscriptRow } from '../../src/ai-gateway/groupChat'
import {
  GAME_OVER_PREFIX,
  POSTS_PER_TURN_CAP,
  SILENCE_SENTINEL,
  WEREWOLF_SESSION_TURN_CAP
} from '../../src/ai-gateway/groupFloors'
import type { WerewolfGame } from '../../src/ai-gateway/groupGame'
import {
  GroupOrchestrator,
  type GroupOrchestratorDeps,
  type GroupRunFacts,
  type GroupTurnRow
} from '../../src/ai-gateway/groupOrchestrator'
import { exportGroupReplay } from '../../src/ai-gateway/groupReplay'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { speakAsGroupMember } from '../../src/ai-gateway/server'
import {
  createGroupJudgeTools,
  createGroupMemberTools,
  type GroupToolHooks
} from '../../src/ai-gateway/tools/groups'
import type { GatewayToolAuditEntry } from '../../src/ai-gateway/tools/types'

// ── 局面 ─────────────────────────────────────────────────────────────────────────

const M = 10
const W = 11
const S = 12
const JUDGE = 'judge'
const TITLES: Record<string, string> = {
  [JUDGE]: '法官',
  p1: '玩家甲',
  p2: '玩家乙',
  p3: '玩家丙',
  p4: '玩家丁',
  p5: '玩家戊',
  p6: '玩家己'
}
const PLAYERS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
const GAME: WerewolfGame = {
  kind: 'werewolf',
  seed: 1,
  roles: { p1: 'wolf', p2: 'wolf', p3: 'seer', p4: 'villager', p5: 'villager', p6: 'villager' },
  titles: TITLES
}
const MEMBERS: Record<number, string[]> = {
  [M]: [JUDGE, ...PLAYERS],
  [W]: [JUDGE, 'p1', 'p2'],
  [S]: [JUDGE, 'p3']
}
const FAMILY: Record<number, number[]> = { [M]: [M, W, S], [W]: [W, M], [S]: [S, M] }
const PARENT: Record<number, number | null> = { [M]: null, [W]: M, [S]: M }
const GROUP_TITLES: Record<number, string> = {
  [M]: '狼人杀 #1',
  [W]: '狼人杀 #1 · 狼群',
  [S]: '狼人杀 #1 · 预言家'
}

/** 阶段词（脚本与判据共用；机制判据只认 GAME_OVER_PREFIX）。 */
const NIGHT = '天黑'
const DAWN = '【天亮】'
const VOTE = '请投票'
const ALIVE_MENTIONS = '@玩家甲 @玩家乙 @玩家丙 @玩家戊 @玩家己'

// ── 脚本化模型 ──────────────────────────────────────────────────────────────────

const USAGE = {
  inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 }
}

type Chunk =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; finishReason: 'stop' | 'tool-calls'; usage: typeof USAGE }

type MockDoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']

function scriptModel(
  next: (opts: { prompt: unknown; tools?: unknown }) => Chunk[]
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (async (options: { prompt: unknown; tools?: unknown }) => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          ...next(options).map((c) =>
            c.type === 'finish' ? { ...c, finishReason: { unified: c.finishReason } } : c
          )
        ]
      })
    })) as unknown as MockDoStream
  })
}

function text(t: string): Chunk[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: t },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage: USAGE }
  ]
}

let toolSeq = 0
function post(sessionId: number, t: string): Chunk[] {
  return [
    {
      type: 'tool-call',
      toolCallId: `tc-${++toolSeq}`,
      toolName: 'group_post',
      input: JSON.stringify({ session_id: sessionId, text: t })
    },
    { type: 'finish', finishReason: 'tool-calls', usage: USAGE }
  ]
}

interface PromptMessage {
  role: string
  content: unknown
}

function partsText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (typeof p === 'object' && p != null && 'text' in p ? String(p.text) : ''))
    .join('')
}

function tag(system: string, name: string): string {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(system)?.[1] ?? ''
}

interface PromptView {
  self: string
  memberCount: number
  gameSecret: string
  system: string
  lastUser: string
  own: string
  /** 已回的 tool-result 数 = 本 turn 里的 step 序号。 */
  step: number
}

function readPrompt(prompt: unknown): PromptView {
  const messages = (Array.isArray(prompt) ? prompt : []) as PromptMessage[]
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => partsText(m.content))
    .join('\n')
  const users = messages.filter((m) => m.role === 'user')
  return {
    self: tag(system, 'self_title'),
    memberCount: tag(system, 'members')
      .split('、')
      .filter((s) => s.length > 0).length,
    gameSecret: tag(system, 'game_secret'),
    system,
    lastUser: users.length ? partsText(users[users.length - 1]!.content) : '',
    own: messages
      .filter((m) => m.role === 'assistant')
      .map((m) => partsText(m.content))
      .join('\n'),
    step: messages.filter((m) => m.role === 'tool').length
  }
}

/** 一局的台词表：法官按群 + 阶段 + step，玩家按群 + 阶段。 */
function script(view: PromptView): Chunk[] {
  const { self, memberCount, lastUser, own, step } = view
  if (self === TITLES[JUDGE]) {
    if (memberCount === MEMBERS[M]!.length) {
      if (own.includes(VOTE)) {
        return text(`${GAME_OVER_PREFIX}玩家戊被放逐，场上 2 狼 2 好人，狼人获胜。`)
      }
      if (own.includes(DAWN)) return text(`${VOTE}：${ALIVE_MENTIONS}，放逐谁？`)
      if (step === 0)
        return post(W, `${NIGHT}请闭眼。狼人请睁眼，@玩家甲 @玩家乙 请商量今晚击杀谁。`)
      if (step === 1) return post(S, '预言家请睁眼，@玩家丙 请选择今晚要查验的人。')
      return text(`${NIGHT}请闭眼。`)
    }
    if (memberCount === MEMBERS[W]!.length) {
      if (own.includes('狼人请闭眼')) return text(SILENCE_SENTINEL)
      if (step === 0) return post(M, `${DAWN}昨晚玩家丁被杀。请依次发言：${ALIVE_MENTIONS}`)
      return text('狼人请闭眼。')
    }
    return text('查验结果：玩家甲是狼人。预言家请闭眼。')
  }
  if (memberCount === MEMBERS[W]!.length) {
    return text(self === '玩家甲' ? '我提议今晚杀玩家丁。' : '同意，就杀玩家丁。')
  }
  if (memberCount === MEMBERS[S]!.length) return text('我查验玩家甲。')
  if (lastUser.includes(VOTE)) return text(`${self}投给玩家戊。`)
  if (self === '玩家己') return text(SILENCE_SENTINEL)
  return text(`${self}：我觉得玩家戊有点可疑。`)
}

// ── 假世界 ──────────────────────────────────────────────────────────────────────

interface StoredMessage extends GroupTranscriptRow {
  sessionId: number
  metadata: string | null
}

type AppendMessage = Parameters<NonNullable<AiGatewayConfig['appendGroupMessage']>>[1]

interface World {
  clock: { now: number }
  messages: StoredMessage[]
  turns: GroupTurnRow[]
  cursors: Map<string, number>
  sleeps: number[]
  mirrored: number
  capCalls: Array<{ sessionId: number; cap: number }>
  prompts: PromptView[]
  warnings: string[]
  hooks: GroupToolHooks
  deps: GroupOrchestratorDeps
  cfg: AiGatewayConfig
  guard: ApprovalGuard
  orch: GroupOrchestrator
  nextId: number
  human(sessionId: number, content: string): StoredMessage
  rows(sessionId: number): StoredMessage[]
  systemKinds(sessionId: number): string[]
}

function runFacts(sessionId: number): GroupRunFacts {
  return {
    members: MEMBERS[sessionId]!.map((id) => ({
      agentId: id,
      title: TITLES[id]!,
      duty: null,
      model: null
    })),
    modes: Object.fromEntries(
      MEMBERS[sessionId]!.map((id) => [id, id === JUDGE ? 'realtime' : 'mention'])
    ),
    config: { judgeAgentId: JUDGE, preset: 'werewolf', game: GAME },
    familySessionIds: FAMILY[sessionId]!,
    parentSessionId: PARENT[sessionId] ?? null
  }
}

function sessionFacts(sessionId: number): GroupSessionFacts {
  const run = runFacts(sessionId)
  return {
    members: run.members,
    config: { v: 1, judgeAgentId: JUDGE, preset: 'werewolf', game: GAME },
    modes: run.modes,
    parentSessionId: PARENT[sessionId] ?? null,
    childSessionIds: sessionId === M ? [W, S] : [],
    judgeScopeStale: false
  }
}

function kindOf(m: StoredMessage): string {
  try {
    return String((JSON.parse(m.metadata ?? '{}') as { kind?: unknown }).kind)
  } catch {
    return ''
  }
}

function readVia(metadata: string | null | undefined): GroupTranscriptRow['via'] {
  if (!metadata) return null
  try {
    const via = (JSON.parse(metadata) as { via?: unknown }).via
    return via === 'main_agent' || via === 'judge_post' ? via : null
  } catch {
    return null
  }
}

function makeWorld(): World {
  const clock = { now: 1_700_000_000_000 }
  const tick = (): number => (clock.now += 1_000)
  const registry = new ActiveRunRegistry({ now: () => clock.now })
  const guard = new ApprovalGuard({ now: () => clock.now })
  const world = {
    clock,
    messages: [],
    turns: [],
    cursors: new Map(),
    sleeps: [],
    mirrored: 0,
    capCalls: [],
    prompts: [],
    warnings: [],
    guard,
    nextId: 1,
    human(sessionId, content) {
      const id = world.nextId++
      const row: StoredMessage = {
        sessionId,
        id,
        role: 'user',
        content,
        speakerAgentId: null,
        status: 'complete',
        chainId: id,
        via: null,
        createdAt: tick(),
        metadata: null
      }
      world.messages.push(row)
      return row
    },
    rows(sessionId) {
      return world.messages.filter((m) => m.sessionId === sessionId)
    },
    systemKinds(sessionId) {
      return world
        .rows(sessionId)
        .filter((m) => m.role === 'system')
        .map((m) => kindOf(m))
    }
    // hooks / cfg / deps / orch 在下面依次接线（orch 要先有 deps，deps 的 speak 要先有 cfg）。
  } as unknown as World
  const append = (sessionId: number, input: AppendMessage): number => {
    const id = world.nextId++
    world.messages.push({
      sessionId,
      id,
      role: input.role,
      content: input.content,
      speakerAgentId: input.speakerAgentId,
      status: 'complete',
      chainId: input.chainId ?? null,
      via: readVia(input.metadata),
      createdAt: tick(),
      metadata: input.metadata ?? null
    })
    return id
  }
  const groupUsage: GroupOrchestratorDeps['groupUsage'] = (sessionIds, sinceMs) => {
    const rows = world.turns.filter(
      (t) => sessionIds.includes(t.sessionId) && t.startedAt >= sinceMs
    )
    const costs = rows.map((t) => t.costUsd).filter((c): c is number => c != null)
    return {
      turns: rows.length,
      tokens: rows.reduce((n, t) => n + (t.tokensInput ?? 0) + (t.tokensOutput ?? 0), 0),
      costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null
    }
  }
  const facts = new Map<number, GroupSessionFacts>([M, W, S].map((id) => [id, sessionFacts(id)]))
  world.hooks = {
    resolveGroupSession: (sessionId) => facts.get(sessionId) ?? null,
    listGroupHistory: (sessionId) => world.rows(sessionId),
    appendGroupMessage: append,
    groupUsage,
    // 惰性：构造完 orch 再赋值，与 lifecycle 的 cfg.deliverGroupMessage 写回同形。
    deliverGroupMessage: () => (sessionId, row) => world.orch.onGroupMessage(sessionId, row),
    getSessionTitle: (sessionId) => GROUP_TITLES[sessionId] ?? null,
    lastHumanMessageText: () => null,
    createGroupSession: () => Promise.reject(new Error('group_create is not part of a game')),
    setGroupConfig: () => Promise.resolve()
  }
  world.cfg = {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'script-model',
    createModel: () =>
      scriptModel((opts) => {
        const view = readPrompt(opts.prompt)
        world.prompts.push(view)
        return script(view)
      }),
    systemPromptProvider: async () => ({ standingContext: 'STAND' }),
    resolveLabsFlags: async () => ({ groupAgents: true }),
    buildGroupSpeakerTools: async (collector, spec) => {
      if (!spec.isJudge) {
        return createGroupMemberTools(collector, world.hooks, { sessionId: spec.sessionId })
      }
      return createGroupJudgeTools(collector, guard, world.hooks, {
        sessionId: spec.sessionId,
        judgeAgentId: spec.agentId,
        familySessionIds: spec.familySessionIds,
        judgeScopeStale: false,
        contextMode: 'manual_chat'
      })
    }
  }
  world.deps = {
    resolveFacts: (sessionId) => (facts.has(sessionId) ? runFacts(sessionId) : null),
    listHistory: (sessionId) => world.rows(sessionId),
    appendMessage: append,
    getSeenCursor: (sessionId, agentId) => world.cursors.get(`${sessionId}:${agentId}`) ?? null,
    advanceSeenCursor: (sessionId, agentId, throughId) =>
      world.cursors.set(`${sessionId}:${agentId}`, throughId),
    insertTurn: (row) => {
      world.turns.push(row)
      tick()
      return world.turns.length
    },
    groupUsage,
    resolveLabs: async () => ({ groupAgents: true }),
    speak: (input) => speakAsGroupMember(world.cfg, input),
    registerRun: (sessionId, controller) => registry.register(sessionId, controller),
    releaseRun: (sessionId, runId) => registry.release(sessionId, runId),
    mirrorRunLog: async () => {
      world.mirrored += 1
    },
    setSessionTurnCap: (sessionId, cap) => {
      world.capCalls.push({ sessionId, cap })
    },
    now: () => clock.now,
    sleep: (ms) => {
      world.sleeps.push(ms)
      return Promise.resolve()
    },
    warn: (message, data) => {
      world.warnings.push(`${message} ${JSON.stringify(data)}`)
    }
  }
  world.orch = new GroupOrchestrator({ deps: world.deps })
  return world
}

/** 与 streamText 同形地调 execute（zod 解析后的入参）。 */
async function execute(tool: Tool, raw: unknown): Promise<unknown> {
  const schema = tool.inputSchema as { parse?: (v: unknown) => unknown }
  const exec = tool.execute as (i: unknown, o: unknown) => Promise<unknown>
  return exec(schema.parse ? schema.parse(raw) : raw, {
    toolCallId: 'tc-scope',
    messages: [],
    abortSignal: undefined
  })
}

function playerRows(world: World, sessionId: number): StoredMessage[] {
  return world.rows(sessionId).filter((m) => m.role === 'assistant' && m.speakerAgentId !== JUDGE)
}

function judgeRows(world: World, sessionId: number): StoredMessage[] {
  return world.rows(sessionId).filter((m) => m.role === 'assistant' && m.speakerAgentId === JUDGE)
}

// ── 一局 ────────────────────────────────────────────────────────────────────────

describe('狼人杀整局（零-LLM，真调度器 + 真 speak + 真群工具）', () => {
  const world = makeWorld()
  let turnsAtGameOver = 0

  beforeAll(async () => {
    const opening = world.human(M, '@法官 开始游戏')
    const { queued } = await world.orch.onGroupMessage(M, opening)
    expect(queued).toEqual([JUDGE])
    await world.orch.idle()
    turnsAtGameOver = world.turns.length
  })

  test('WW-a 终局：M 恰一条 game_over 行、三群零 group_stop、之后唤醒零候选零 turn、setSessionTurnCap 对 M/W/S 各调一次', async () => {
    expect(world.warnings).toEqual([])
    expect(world.systemKinds(M).filter((k) => k === 'game_over')).toHaveLength(1)
    expect(world.systemKinds(W)).not.toContain('game_over')
    expect(world.systemKinds(S)).not.toContain('game_over')
    for (const sid of [M, W, S]) expect(world.systemKinds(sid)).not.toContain('group_stop')
    expect(world.turns.filter((t) => t.outcome === 'stopped')).toEqual([])
    const last = judgeRows(world, M).at(-1)
    expect(last?.content.startsWith(GAME_OVER_PREFIX)).toBe(true)

    const after = world.human(M, '@法官 再来一局')
    expect(await world.orch.onGroupMessage(M, after)).toEqual({ queued: [] })
    await world.orch.idle()
    expect(world.turns).toHaveLength(turnsAtGameOver)

    expect(world.capCalls.map((c) => c.sessionId).sort((a, b) => a - b)).toEqual([M, W, S])
    for (const c of world.capCalls) expect(c.cap).toBe(turnsAtGameOver)
  })

  test('WW-b 夜晚只在子群：M 的每个夜晚区间无玩家行；W / S 每一行 speaker ∈ 该群 members', () => {
    const rows = world.rows(M)
    const nightStarts = judgeRows(world, M).filter((m) => m.content.includes(NIGHT))
    expect(nightStarts.length).toBeGreaterThanOrEqual(1)
    for (const start of nightStarts) {
      const dawn = judgeRows(world, M).find((m) => m.id > start.id && m.content.includes(DAWN))
      expect(dawn).toBeDefined()
      const inside = rows.filter((m) => m.id > start.id && m.id < dawn!.id)
      expect(inside.filter((m) => m.role === 'assistant' && m.speakerAgentId !== JUDGE)).toEqual([])
    }
    for (const sid of [W, S]) {
      const spoken = world.rows(sid).filter((m) => m.role === 'assistant')
      expect(spoken.length).toBeGreaterThan(0)
      for (const m of spoken) expect(MEMBERS[sid]).toContain(m.speakerAgentId)
      expect(spoken.some((m) => m.via === 'judge_post')).toBe(true)
    }
    // 白天：玩家在 M 发过言且投过票
    expect(playerRows(world, M).length).toBeGreaterThan(0)
  })

  test('WW-c 预算：family turn 行数 ≤ WEREWOLF_SESSION_TURN_CAP；run_log 镜像 == spoke + failed；法官每 turn group_post ≤ POSTS_PER_TURN_CAP', () => {
    const family = world.turns.filter((t) => [M, W, S].includes(t.sessionId))
    expect(family.length).toBe(world.turns.length)
    expect(family.length).toBeLessThanOrEqual(WEREWOLF_SESSION_TURN_CAP)
    expect(family.length).toBeGreaterThan(0)
    const spokeOrFailed = family.filter((t) => t.outcome === 'spoke' || t.outcome === 'failed')
    expect(world.mirrored).toBe(spokeOrFailed.length)
    expect(family.filter((t) => t.outcome === 'failed')).toEqual([])
    // 每条 judge_post 标记行落在发出它的法官 turn 的 [startedAt, finishedAt] 内（假时钟每次落行推进）。
    const judgeTurns = family.filter((t) => t.agentId === JUDGE)
    const posts = world.messages.filter((m) => m.role === 'system' && kindOf(m) === 'judge_post')
    expect(posts.length).toBeGreaterThan(0)
    const perTurn = new Map<string, number>()
    for (const p of posts) {
      const owner = judgeTurns.find(
        (t) =>
          t.sessionId === p.sessionId &&
          t.startedAt <= p.createdAt &&
          (t.finishedAt ?? Infinity) >= p.createdAt
      )
      expect(owner).toBeDefined()
      const key = `${owner!.runId}:${owner!.seq}`
      perTurn.set(key, (perTurn.get(key) ?? 0) + 1)
    }
    for (const n of perTurn.values()) expect(n).toBeLessThanOrEqual(POSTS_PER_TURN_CAP)
    expect(Math.max(...perTurn.values())).toBe(POSTS_PER_TURN_CAP)
  })

  test('WW-d 回放：exportGroupReplay([M,W,S]) 非空、行数 ≥ 消息数 + 非 spoke turn 数、时间列单调、含「(沉默)」', () => {
    const md = exportGroupReplay([M, W, S], {
      listHistory: (sid) => world.rows(sid),
      listTurns: (sid) => world.turns.filter((t) => t.sessionId === sid),
      getTitle: (sid) => GROUP_TITLES[sid] ?? null,
      titleOf: (agentId) => TITLES[agentId] ?? null
    })
    const lines = md.split('\n').slice(2)
    const readable = world.messages.filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && m.content.length > 0
    ).length
    const nonSpoke = world.turns.filter((t) => t.messageId == null).length
    expect(lines.length).toBeGreaterThanOrEqual(readable + nonSpoke)
    const times = lines.map((l) => Date.parse(l.split(' | ')[0]!.slice(2)))
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]!)
    expect(world.turns.some((t) => t.outcome === 'silent')).toBe(true)
    expect(md).toContain('(沉默)')
    expect(md).toContain('(游戏结束)')
    expect(md).toContain(GROUP_TITLES[W])
  })

  test('WW-e 作用域：玩家的成员工具对 W 调 group_history → E_GROUP_SCOPE；法官工具对 W 通过', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const member = createGroupMemberTools(collector, world.hooks, { sessionId: M })
    await expect(execute(member.group_history!, { session_id: W })).rejects.toMatchObject({
      code: 'E_GROUP_SCOPE'
    })
    const judge = createGroupJudgeTools(collector, world.guard, world.hooks, {
      sessionId: M,
      judgeAgentId: JUDGE,
      familySessionIds: FAMILY[M]!,
      judgeScopeStale: false,
      contextMode: 'manual_chat'
    })
    const page = (await execute(judge.group_history!, { session_id: W })) as {
      session_id: number
      messages: unknown[]
    }
    expect(page.session_id).toBe(W)
    expect(page.messages.length).toBe(world.rows(W).filter((m) => m.role !== 'system').length)
  })

  test('WW-f 身份注入实证：法官 turn 含全表 <game_secret>、狼人含「队友」、村民只有「你是村民」、预言家在 S 含「你是预言家」', () => {
    // 法官全表按 roles 键序，名字优先取 game.titles（建局写入的七个显示名）：子群名单只有
    // 本群成员，没有这份表法官在 W / S 里只认得出 agentId。三群的全表因此字节相同。
    const ROLE_LABEL = { wolf: '狼人', seer: '预言家', villager: '村民' } as const
    const judgeTable = Object.entries(GAME.roles)
      .map(([id, role]) => `${TITLES[id]}=${ROLE_LABEL[role]}`)
      .join('；')
    expect(judgeTable).toBe(
      '玩家甲=狼人；玩家乙=狼人；玩家丙=预言家；玩家丁=村民；玩家戊=村民；玩家己=村民'
    )
    const judgePrompts = world.prompts.filter((p) => p.self === TITLES[JUDGE])
    expect(judgePrompts.length).toBeGreaterThan(0)
    const seen = new Set<number>()
    for (const p of judgePrompts) {
      const sid = [M, W, S].find((id) => MEMBERS[id]!.length === p.memberCount)!
      seen.add(sid)
      expect(p.gameSecret).toBe(judgeTable)
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([M, W, S])
    const wolfA = world.prompts.filter((p) => p.self === '玩家甲')
    expect(wolfA.length).toBeGreaterThan(0)
    for (const p of wolfA) expect(p.gameSecret).toBe('你是狼人；队友：玩家乙')
    const wolfB = world.prompts.filter((p) => p.self === '玩家乙')
    for (const p of wolfB) expect(p.gameSecret).toBe('你是狼人；队友：玩家甲')
    const villager = world.prompts.filter((p) => p.self === '玩家戊')
    expect(villager.length).toBeGreaterThan(0)
    for (const p of villager) {
      expect(p.gameSecret).toBe('你是村民')
      expect(p.system).not.toContain('队友')
    }
    const seerInS = world.prompts.filter(
      (p) => p.self === '玩家丙' && p.memberCount === MEMBERS[S]!.length
    )
    expect(seerInS.length).toBeGreaterThan(0)
    for (const p of seerInS) expect(p.gameSecret).toBe('你是预言家')
    // 每个 turn 的 system prompt 恰含一个 <game_secret>
    for (const p of world.prompts) expect(p.system.split('<game_secret>').length).toBe(2)
  })
})
