// L4 群聊 g3 — 狼人杀实验的 gateway 面：身份注入（buildGameSecret + speakAsGroupMember 接线）、
// 预设地板（resolveGroupRunConfig 按 preset 取缺省）、game_over（两条路径 + gameOver 集合 +
// best-effort setSessionTurnCap）、stopFamily 的 family 语义、GAME_OVER_PREFIX 单源。
//
// 假 deps 世界照 group_orchestrator.test.ts（内存库 + 真 ActiveRunRegistry + 假时钟 / 假 sleep）；
// 那个文件的断言一条不动，新用例全在这里。

import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'
import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import type { AiGatewayConfig, SessionAgentIdentity } from '../../src/ai-gateway/config'
import type { GroupTranscriptRow } from '../../src/ai-gateway/groupChat'
import {
  CHAIN_CAP_DEFAULT,
  GAME_OVER_PREFIX,
  HOURLY_TOKENS_DEFAULT,
  HOURLY_TURNS_DEFAULT,
  HOURLY_USD_DEFAULT,
  SESSION_TURN_CAP_DEFAULT,
  SILENCE_SENTINEL,
  WEREWOLF_CHAIN_CAP,
  WEREWOLF_HOURLY_TOKENS,
  WEREWOLF_HOURLY_TURNS,
  WEREWOLF_HOURLY_USD,
  WEREWOLF_SESSION_TURN_CAP,
  type GroupStopReason
} from '../../src/ai-gateway/groupFloors'
import { buildGameSecret, type WerewolfGame } from '../../src/ai-gateway/groupGame'
import {
  GroupOrchestrator,
  resolveGroupRunConfig,
  type GroupAppendInput,
  type GroupOrchestratorDeps,
  type GroupRunFacts,
  type GroupSpeakInput,
  type GroupSpeakResult,
  type GroupTurnRow,
  type GroupUsage
} from '../../src/ai-gateway/groupOrchestrator'
import { speakAsGroupMember } from '../../src/ai-gateway/server'
import {
  buildCurrentDateBlock,
  buildGatewaySystemPrompt,
  buildTeamAgentIdentityBlock,
  executionDisciplineFor,
  type GatewaySystemPromptConfig
} from '../../src/ai-gateway/systemPrompt'
import {
  buildStableSystemPrompt,
  type ChatModelConfig
} from '../../src/ai-gateway/prompts/stable_prompt'

// ── 固定局面 ───────────────────────────────────────────────────────────────────

const JUDGE = 'judge'
const TITLES = new Map<string, string>([
  [JUDGE, '法官'],
  ['p1', '玩家甲'],
  ['p2', '玩家乙'],
  ['p3', '玩家丙'],
  ['p4', '玩家丁']
])
/** 两狼（p1 / p4）+ 预言家 p2 + 村民 p3。 */
const GAME: WerewolfGame = {
  kind: 'werewolf',
  seed: 1,
  roles: { p1: 'wolf', p2: 'seer', p3: 'villager', p4: 'wolf' }
}
const M = 1
const W = 2
const S = 3

// ── 假世界（照 group_orchestrator.test.ts，裁到本文件用到的面）──────────────────

interface StoredMessage extends GroupTranscriptRow {
  sessionId: number
  metadata: string | null
}

interface World {
  clock: { now: number }
  messages: StoredMessage[]
  turns: GroupTurnRow[]
  facts: Map<number, GroupRunFacts>
  usageOverride: GroupUsage | null
  registry: ActiveRunRegistry
  speakImpl: (input: GroupSpeakInput, n: number) => Promise<GroupSpeakResult>
  capCalls: Array<[number, number]>
  warns: Array<{ message: string; data: Record<string, unknown> }>
  deps: GroupOrchestratorDeps
  nextId: number
  systemRows(sessionId?: number): Array<{ sessionId: number; meta: Record<string, unknown> }>
  stopReasons(sessionId?: number): GroupStopReason[]
  outcomes(): string[]
  human(sessionId: number, content: string): StoredMessage
}

function defaultSpeak(input: GroupSpeakInput, n: number): Promise<GroupSpeakResult> {
  return Promise.resolve({
    text: `${input.agentId} 第 ${n} 次发言`,
    modelId: 'claude-sonnet-4-5',
    usage: { inputTokens: 100, outputTokens: 10 },
    protocol: 'anthropic'
  })
}

function makeWorld(opts: { speak?: World['speakImpl'] } = {}): World {
  const clock = { now: 1_000_000 }
  const registry = new ActiveRunRegistry({ now: () => clock.now })
  let speakCount = 0
  const world: World = {
    clock,
    messages: [],
    turns: [],
    facts: new Map(),
    usageOverride: null,
    registry,
    speakImpl: opts.speak ?? defaultSpeak,
    capCalls: [],
    warns: [],
    deps: undefined as unknown as GroupOrchestratorDeps,
    nextId: 1,
    systemRows(sessionId) {
      return world.messages
        .filter((m) => m.role === 'system' && (sessionId == null || m.sessionId === sessionId))
        .map((m) => ({
          sessionId: m.sessionId,
          meta: JSON.parse(m.metadata ?? '{}') as Record<string, unknown>
        }))
    },
    stopReasons(sessionId) {
      return world
        .systemRows(sessionId)
        .filter((r) => r.meta.kind === 'group_stop')
        .map((r) => r.meta.reason as GroupStopReason)
    },
    outcomes() {
      return world.turns.map((t) => t.outcome)
    },
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
        createdAt: clock.now,
        metadata: null
      }
      world.messages.push(row)
      return row
    }
  }
  const append = (sessionId: number, input: GroupAppendInput): number => {
    const id = world.nextId++
    world.messages.push({
      sessionId,
      id,
      role: input.role,
      content: input.content,
      speakerAgentId: input.speakerAgentId,
      status: 'complete',
      chainId: input.chainId ?? null,
      via: null,
      createdAt: clock.now,
      metadata: input.metadata ?? null
    })
    return id
  }
  const cursors = new Map<string, number>()
  world.deps = {
    resolveFacts: (sessionId) => world.facts.get(sessionId) ?? null,
    listHistory: (sessionId) => world.messages.filter((m) => m.sessionId === sessionId),
    appendMessage: append,
    getSeenCursor: (sessionId, agentId) => cursors.get(`${sessionId}:${agentId}`) ?? null,
    advanceSeenCursor: (sessionId, agentId, throughId) =>
      cursors.set(`${sessionId}:${agentId}`, throughId),
    insertTurn: (row) => world.turns.push(row),
    groupUsage: (sessionIds, sinceMs) => {
      if (world.usageOverride) return world.usageOverride
      const rows = world.turns.filter(
        (t) => sessionIds.includes(t.sessionId) && t.startedAt >= sinceMs
      )
      return { turns: rows.length, tokens: 0, costUsd: null }
    },
    resolveLabs: () => Promise.resolve({ groupAgents: true }),
    speak: (input) => world.speakImpl(input, ++speakCount),
    registerRun: (sessionId, controller) => registry.register(sessionId, controller),
    releaseRun: (sessionId, runId) => registry.release(sessionId, runId),
    setSessionTurnCap: (sessionId, cap) => {
      world.capCalls.push([sessionId, cap])
    },
    now: () => clock.now,
    sleep: () => Promise.resolve(),
    warn: (message, data) => world.warns.push({ message, data })
  }
  return world
}

function member(agentId: string): GroupRunFacts['members'][number] {
  return { agentId, title: TITLES.get(agentId) ?? agentId, duty: null, model: null }
}

/** 三群一 family：M（法官 + 四玩家，法官 / p1 realtime）、W（法官 + 两狼）、S（法官 + 预言家）。 */
function werewolfFamily(
  world: World,
  config: GroupRunFacts['config'] = { judgeAgentId: JUDGE, preset: 'werewolf', game: GAME }
): void {
  const build = (
    sessionId: number,
    ids: string[],
    realtime: string[],
    family: number[],
    parent: number | null
  ): void => {
    world.facts.set(sessionId, {
      members: ids.map(member),
      modes: Object.fromEntries(
        ids.map((id) => [id, realtime.includes(id) ? 'realtime' : 'mention'])
      ),
      config,
      familySessionIds: family,
      parentSessionId: parent
    })
  }
  build(M, [JUDGE, 'p1', 'p2', 'p3', 'p4'], [JUDGE, 'p1'], [M, W, S], null)
  build(W, [JUDGE, 'p1', 'p4'], [JUDGE], [W, M], M)
  build(S, [JUDGE, 'p2'], [JUDGE], [S, M], M)
}

async function send(
  orch: GroupOrchestrator,
  world: World,
  sessionId: number,
  text: string
): Promise<string[]> {
  const row = world.human(sessionId, text)
  const { queued } = await orch.onGroupMessage(sessionId, row)
  await orch.idle()
  return queued
}

/** 法官在 M 宣布终局的 speak 替身；其余成员按默认台词。 */
function judgeEndsGame(input: GroupSpeakInput, n: number): Promise<GroupSpeakResult> {
  if (input.agentId === JUDGE) {
    return Promise.resolve({
      text: `${GAME_OVER_PREFIX}狼人胜`,
      modelId: 'claude-sonnet-4-5',
      usage: { inputTokens: 10, outputTokens: 5 },
      protocol: 'anthropic'
    })
  }
  return defaultSpeak(input, n)
}

// ── GS1–GS3 buildGameSecret ─────────────────────────────────────────────────────

describe('GS1–GS3 buildGameSecret（服务端事实 → 本 speaker 可见的身份字符串）', () => {
  test('GS1 法官 → 按 roles 键序全表，用 title；缺 title 用 agentId', () => {
    const three: WerewolfGame = {
      kind: 'werewolf',
      seed: 7,
      roles: { p1: 'wolf', p2: 'seer', p3: 'villager' }
    }
    expect(buildGameSecret(three, JUDGE, JUDGE, TITLES)).toBe(
      '玩家甲=狼人；玩家乙=预言家；玩家丙=村民'
    )
    expect(buildGameSecret(three, JUDGE, JUDGE, new Map([['p1', '玩家甲']]))).toBe(
      '玩家甲=狼人；p2=预言家；p3=村民'
    )
  })

  test('GS1b game.titles 优先：法官在子群（titleById 只含本群）仍全表用标题；titles 缺的 id 退 titleById 再退 agentId；狼人队友同序', () => {
    const wolfGroupOnly = new Map([
      [JUDGE, '法官'],
      ['p1', '玩家甲'],
      ['p4', '玩家丁']
    ])
    const withTitles: WerewolfGame = { ...GAME, titles: Object.fromEntries(TITLES) }
    expect(buildGameSecret(withTitles, JUDGE, JUDGE, wolfGroupOnly)).toBe(
      '玩家甲=狼人；玩家乙=预言家；玩家丙=村民；玩家丁=狼人'
    )
    expect(buildGameSecret(GAME, JUDGE, JUDGE, wolfGroupOnly)).toBe(
      '玩家甲=狼人；p2=预言家；p3=村民；玩家丁=狼人'
    )
    const partial: WerewolfGame = { ...GAME, titles: { p2: '玩家乙' } }
    expect(buildGameSecret(partial, JUDGE, JUDGE, wolfGroupOnly)).toBe(
      '玩家甲=狼人；玩家乙=预言家；p3=村民；玩家丁=狼人'
    )
    expect(buildGameSecret(withTitles, 'p1', JUDGE, new Map([['p1', '玩家甲']]))).toBe(
      '你是狼人；队友：玩家丁'
    )
  })

  test('GS2 狼人 → 「你是狼人；队友：…」；两个队友用「、」；无队友无分号段', () => {
    expect(buildGameSecret(GAME, 'p1', JUDGE, TITLES)).toBe('你是狼人；队友：玩家丁')
    const threeWolves: WerewolfGame = {
      kind: 'werewolf',
      seed: 1,
      roles: { p1: 'wolf', p2: 'wolf', p3: 'wolf', p4: 'villager' }
    }
    expect(buildGameSecret(threeWolves, 'p1', JUDGE, TITLES)).toBe('你是狼人；队友：玩家乙、玩家丙')
    const lone: WerewolfGame = { kind: 'werewolf', seed: 1, roles: { p1: 'wolf', p2: 'villager' } }
    expect(buildGameSecret(lone, 'p1', JUDGE, TITLES)).toBe('你是狼人')
  })

  test('GS3 预言家 / 村民只有自己；非 werewolf / game 缺 / speaker 不在 roles 且非法官 → null', () => {
    expect(buildGameSecret(GAME, 'p2', JUDGE, TITLES)).toBe('你是预言家')
    expect(buildGameSecret(GAME, 'p3', JUDGE, TITLES)).toBe('你是村民')
    expect(
      buildGameSecret({ ...GAME, kind: 'chess' as 'werewolf' }, 'p1', JUDGE, TITLES)
    ).toBeNull()
    expect(buildGameSecret(undefined, 'p1', JUDGE, TITLES)).toBeNull()
    expect(buildGameSecret(null, JUDGE, JUDGE, TITLES)).toBeNull()
    expect(buildGameSecret(GAME, 'stranger', JUDGE, TITLES)).toBeNull()
    expect(buildGameSecret(GAME, 'stranger', null, TITLES)).toBeNull()
  })
})

// ── GS4–GS5 speakAsGroupMember 接线 + 其他路径字节不变 ────────────────────────────

const USAGE = {
  inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
type MockDoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']

const PROMPT: GatewaySystemPromptConfig = { standingContext: 'STAND' }

function capturingCfg(): { cfg: AiGatewayConfig; captured: { options?: unknown } } {
  const captured: { options?: unknown } = {}
  const model = new MockLanguageModelV3({
    doStream: (async (options: unknown) => {
      captured.options = options
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: '1' },
            { type: 'text-delta' as const, id: '1', delta: '我说一句' },
            { type: 'text-end' as const, id: '1' },
            { type: 'finish' as const, finishReason: { unified: 'stop' as const }, usage: USAGE }
          ]
        })
      }
    }) as unknown as MockDoStream
  })
  return {
    captured,
    cfg: {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'gateway-default-model',
      createModel: () => model,
      systemPromptProvider: async () => PROMPT
    }
  }
}

function systemPromptOf(captured: { options?: unknown }): string {
  const prompt = (captured.options as { prompt: Array<{ role: string; content: unknown }> }).prompt
  const system = prompt.find((m) => m.role === 'system')
  return typeof system?.content === 'string' ? system.content : ''
}

function speakInput(facts: GroupRunFacts, agentId: string): GroupSpeakInput {
  return {
    sessionId: M,
    agentId,
    member: facts.members.find((m) => m.agentId === agentId)!,
    facts,
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '[用户] 开始' }] }
    ] as MailAgentUIMessage[],
    chainId: 1,
    runId: 'run-1',
    signal: new AbortController().signal
  }
}

function stableFor(): string {
  const cfg: ChatModelConfig = {
    defaultModel: '',
    kosConsumerEnabled: false,
    kosConfigured: false,
    kosL1HotBlockEnabled: false,
    userContext: null,
    memorySummary: null,
    skillFragments: null,
    skillCatalog: null,
    connectorCatalog: null,
    standingContext: 'STAND'
  }
  return buildStableSystemPrompt(null, cfg, () => null)
}

describe('GS4–GS5 身份注入接线', () => {
  const MEMBERS = [JUDGE, 'p1', 'p2', 'p3', 'p4'].map(member)
  const roster = MEMBERS.map((m) => ({ agentId: m.agentId, title: m.title }))
  const identityFor = (
    agentId: string,
    group: NonNullable<SessionAgentIdentity['group']>
  ): SessionAgentIdentity => ({
    agentId,
    agentTitle: TITLES.get(agentId)!,
    duty: null,
    model: null,
    scheduleLine: null,
    group
  })
  const baseGroup = {
    members: roster,
    sessionId: M,
    isJudge: false,
    familySessionIds: [M],
    groupSpeakerRun: true,
    topic: null
  }

  test('GS4 facts.config.game 有 → prepareChatRun 收到的 gameSecret 非空且 prompt 含 <game_secret>；无 game → 字节同 g2 基线', async () => {
    const withGame: GroupRunFacts = {
      members: MEMBERS,
      modes: {},
      config: { judgeAgentId: JUDGE, preset: 'werewolf', game: GAME },
      familySessionIds: [M]
    }
    const a = capturingCfg()
    await speakAsGroupMember(a.cfg, speakInput(withGame, 'p1'))
    const secret = buildGameSecret(GAME, 'p1', JUDGE, TITLES)
    expect(secret).toBe('你是狼人；队友：玩家丁')
    const prompt = systemPromptOf(a.captured)
    expect(prompt).toContain(`<game_secret>${secret}</game_secret>`)
    expect(prompt).toBe(
      buildGatewaySystemPrompt({
        promptConfig: PROMPT,
        contextSnapshot: null,
        sessionAgentIdentity: identityFor('p1', { ...baseGroup, gameSecret: secret }),
        groupSpeakerRun: true
      })
    )

    // 法官拿全表。
    const j = capturingCfg()
    await speakAsGroupMember(j.cfg, speakInput(withGame, JUDGE))
    expect(systemPromptOf(j.captured)).toContain(
      `<game_secret>${buildGameSecret(GAME, JUDGE, JUDGE, TITLES)}</game_secret>`
    )

    // 无 game（g2 形状的 facts）→ 键为 null → 身份块字节与「identity.group 没有 gameSecret 键」相同。
    const noGame: GroupRunFacts = {
      members: MEMBERS,
      modes: {},
      config: { judgeAgentId: JUDGE },
      familySessionIds: [M]
    }
    const b = capturingCfg()
    await speakAsGroupMember(b.cfg, speakInput(noGame, 'p1'))
    const baseline = buildGatewaySystemPrompt({
      promptConfig: PROMPT,
      contextSnapshot: null,
      sessionAgentIdentity: identityFor('p1', baseGroup),
      groupSpeakerRun: true
    })
    expect(systemPromptOf(b.captured)).toBe(baseline)
    expect(baseline).not.toContain('<game_secret>')
    expect(
      buildGatewaySystemPrompt({
        promptConfig: PROMPT,
        contextSnapshot: null,
        sessionAgentIdentity: identityFor('p1', { ...baseGroup, gameSecret: null }),
        groupSpeakerRun: true
      })
    ).toBe(baseline)
  })

  test('GS5 主 agent（无 group）与 team 路径 prompt 字节不变，且无 <game_secret>', () => {
    const date = buildCurrentDateBlock(null)
    const main = buildGatewaySystemPrompt({ promptConfig: PROMPT, contextSnapshot: null })
    expect(main).toBe([stableFor(), executionDisciplineFor(false), date].join('\n\n'))
    const team: SessionAgentIdentity = {
      agentId: 'agent_b',
      agentTitle: '跟进官',
      duty: '盯住每条行动项的进展',
      model: null,
      scheduleLine: null,
      group: null
    }
    const teamPrompt = buildGatewaySystemPrompt({
      promptConfig: PROMPT,
      contextSnapshot: null,
      sessionAgentIdentity: team
    })
    expect(teamPrompt).toBe(
      [stableFor(), buildTeamAgentIdentityBlock(team), executionDisciplineFor(false), date].join(
        '\n\n'
      )
    )
    for (const p of [main, teamPrompt]) {
      expect(p).not.toContain('<game_secret>')
      expect(p).not.toContain(SILENCE_SENTINEL)
    }
  })
})

// ── GS6–GS7 预设地板 ─────────────────────────────────────────────────────────────

describe('GS6–GS7 resolveGroupRunConfig 的 werewolf 缺省', () => {
  test('GS6 preset 无显式键 → 五值 = WEREWOLF_*；显式 chainCap 覆盖；无 preset → 出厂默认；显式 sessionTurnCap null → null', () => {
    expect(resolveGroupRunConfig({ preset: 'werewolf' })).toEqual({
      judgeAgentId: null,
      chainCap: WEREWOLF_CHAIN_CAP,
      hourlyTurns: WEREWOLF_HOURLY_TURNS,
      hourlyTokens: WEREWOLF_HOURLY_TOKENS,
      hourlyUsd: WEREWOLF_HOURLY_USD,
      sessionTurnCap: WEREWOLF_SESSION_TURN_CAP
    })
    expect(resolveGroupRunConfig({ preset: 'werewolf', chainCap: 30 })).toMatchObject({
      chainCap: 30,
      hourlyTurns: WEREWOLF_HOURLY_TURNS,
      sessionTurnCap: WEREWOLF_SESSION_TURN_CAP
    })
    const factory = {
      judgeAgentId: null,
      chainCap: CHAIN_CAP_DEFAULT,
      hourlyTurns: HOURLY_TURNS_DEFAULT,
      hourlyTokens: HOURLY_TOKENS_DEFAULT,
      hourlyUsd: HOURLY_USD_DEFAULT,
      sessionTurnCap: SESSION_TURN_CAP_DEFAULT
    }
    expect(resolveGroupRunConfig({})).toEqual(factory)
    expect(resolveGroupRunConfig(undefined)).toEqual(factory)
    expect(resolveGroupRunConfig({ preset: null })).toEqual(factory)
    expect(
      resolveGroupRunConfig({ preset: 'werewolf', sessionTurnCap: null }).sessionTurnCap
    ).toBeNull()
  })

  test('GS7 checkFloors 按 preset：family 累计 120 → session_cap（三群各一行）；119 → 照常发言', async () => {
    const capped = makeWorld()
    werewolfFamily(capped)
    capped.usageOverride = { turns: 120, tokens: 0, costUsd: null }
    const orch = new GroupOrchestrator({ deps: capped.deps, cascade: false })
    await send(orch, capped, M, '开始')
    expect(capped.outcomes()).toEqual(['stopped'])
    expect(capped.turns[0]?.error).toBe('session_cap')
    for (const sid of [M, W, S]) expect(capped.stopReasons(sid)).toEqual(['session_cap'])

    const under = makeWorld()
    werewolfFamily(under)
    under.usageOverride = { turns: 119, tokens: 0, costUsd: null }
    const orch2 = new GroupOrchestrator({ deps: under.deps, cascade: false })
    await send(orch2, under, M, '开始')
    expect(under.outcomes()).toEqual(['spoke', 'spoke'])
    expect(under.stopReasons()).toEqual([])
  })
})

// ── GS8–GS11 game_over ───────────────────────────────────────────────────────────

describe('GS8–GS11 game_over（不是停止：零 group_stop）', () => {
  test('GS8 spoke 路径：法官在 M 说【游戏结束】→ M 一条 game_over 行、三群零 group_stop、W/S 队列清空、之后唤醒 {queued:[]}、无级联', async () => {
    const world = makeWorld()
    werewolfFamily(world)
    let orch!: GroupOrchestrator
    // 法官发言期间往 W / S 各投一条人类消息：worker 在忙，它们停在队列里。
    world.speakImpl = async (input, n) => {
      if (input.agentId === JUDGE) {
        await orch.onGroupMessage(W, world.human(W, '@玩家甲 夜晚'))
        await orch.onGroupMessage(S, world.human(S, '@玩家乙 验人'))
        expect(orch.pendingFor(W)).toEqual(['p1'])
        expect(orch.pendingFor(S)).toEqual(['p2'])
      }
      return judgeEndsGame(input, n)
    }
    orch = new GroupOrchestrator({ deps: world.deps })
    const root = world.human(M, '开始')
    expect((await orch.onGroupMessage(M, root)).queued).toEqual([JUDGE, 'p1'])
    await orch.idle()

    // 只有法官那一个 turn：M 里排在后面的 p1、W / S 里的候选全被清掉，spoke 后也没有级联。
    expect(world.turns.map((t) => [t.sessionId, t.agentId, t.outcome])).toEqual([
      [M, JUDGE, 'spoke']
    ])
    for (const sid of [M, W, S]) expect(orch.pendingFor(sid)).toEqual([])
    const rows = world.systemRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      sessionId: M,
      meta: { kind: 'game_over', runId: world.turns[0]!.runId, chainId: root.id }
    })
    expect(world.messages.find((m) => m.role === 'system')?.content).toBe('')
    expect(world.stopReasons()).toEqual([])

    for (const sid of [M, W, S]) expect(await send(orch, world, sid, '再来一局？')).toEqual([])
    expect(world.turns).toHaveLength(1)
    expect(world.systemRows()).toHaveLength(1)
  })

  test('GS9 judge_post 路径：法官从子群回投 M 的【游戏结束】行（chainId null / via judge_post）→ 同 GS8', async () => {
    const world = makeWorld()
    werewolfFamily(world)
    const orch = new GroupOrchestrator({ deps: world.deps })
    const id = world.nextId++
    const row: StoredMessage = {
      sessionId: M,
      id,
      role: 'assistant',
      content: `${GAME_OVER_PREFIX}好人胜`,
      speakerAgentId: JUDGE,
      status: 'complete',
      chainId: null,
      via: 'judge_post',
      createdAt: world.clock.now,
      metadata: JSON.stringify({ via: 'judge_post' })
    }
    world.messages.push(row)
    expect(await orch.onGroupMessage(M, row)).toEqual({ queued: [] })
    await orch.idle()
    const rows = world.systemRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe(M)
    expect(rows[0]!.meta).toEqual({ kind: 'game_over', runId: expect.any(String), chainId: id })
    expect(world.turns).toEqual([])
    expect(world.stopReasons()).toEqual([])
    for (const sid of [M, W, S]) expect(await send(orch, world, sid, '@法官 再开一局')).toEqual([])
    expect(world.turns).toEqual([])
  })

  test('GS10 非法官说【游戏结束】/ 法官无前缀 / 非 preset 群 → 都不触发（无 game_over 行、级联照常）', async () => {
    const silent = (input: GroupSpeakInput): Promise<GroupSpeakResult> =>
      Promise.resolve({
        text: input.agentId === JUDGE ? SILENCE_SENTINEL : `${GAME_OVER_PREFIX}我赢了`,
        modelId: 'm',
        usage: null,
        protocol: 'anthropic'
      })
    // ① 玩家 p1 说前缀，法官（realtime）被级联唤醒后沉默。
    const a = makeWorld({ speak: silent })
    werewolfFamily(a)
    const orchA = new GroupOrchestrator({ deps: a.deps })
    expect(await send(orchA, a, M, '@玩家甲 说')).toEqual(['p1'])
    expect(a.turns.map((t) => [t.agentId, t.outcome])).toEqual([
      ['p1', 'spoke'],
      [JUDGE, 'silent']
    ])
    expect(a.systemRows()).toEqual([])
    expect(await send(orchA, a, M, '@玩家甲 再说')).toEqual(['p1'])

    // ② 法官说「游戏结束」但没有前缀。
    const noPrefix = (input: GroupSpeakInput): Promise<GroupSpeakResult> =>
      Promise.resolve({
        text: input.agentId === JUDGE ? '游戏结束，狼人胜' : SILENCE_SENTINEL,
        modelId: 'm',
        usage: null,
        protocol: 'anthropic'
      })
    const b = makeWorld({ speak: noPrefix })
    werewolfFamily(b)
    const orchB = new GroupOrchestrator({ deps: b.deps })
    expect(await send(orchB, b, M, '@法官 开始')).toEqual([JUDGE])
    expect(b.turns.map((t) => [t.agentId, t.outcome])).toEqual([
      [JUDGE, 'spoke'],
      ['p1', 'silent']
    ])
    expect(b.systemRows()).toEqual([])
    expect(await send(orchB, b, M, '@法官 继续')).toEqual([JUDGE])

    // ③ 非 preset 群（有法官、无 preset / game）：法官带前缀也不算。
    const c = makeWorld({
      speak: (input) =>
        Promise.resolve({
          text: input.agentId === JUDGE ? `${GAME_OVER_PREFIX}狼人胜` : SILENCE_SENTINEL,
          modelId: 'm',
          usage: null,
          protocol: 'anthropic'
        })
    })
    werewolfFamily(c, { judgeAgentId: JUDGE })
    const orchC = new GroupOrchestrator({ deps: c.deps })
    expect(await send(orchC, c, M, '@法官 开始')).toEqual([JUDGE])
    expect(c.turns.map((t) => [t.agentId, t.outcome])).toEqual([
      [JUDGE, 'spoke'],
      ['p1', 'silent']
    ])
    expect(c.systemRows()).toEqual([])
    expect(await send(orchC, c, M, '@法官 继续')).toEqual([JUDGE])
  })

  test('GS11 setSessionTurnCap：family 每个 sid 各一次，cap == 当时 groupUsage(family,0).turns；hook 缺席不抛；hook 抛 → 只 warn', async () => {
    const a = makeWorld({ speak: judgeEndsGame })
    werewolfFamily(a)
    await send(new GroupOrchestrator({ deps: a.deps }), a, M, '开始')
    expect(a.turns).toHaveLength(1)
    expect([...a.capCalls].sort((x, y) => x[0] - y[0])).toEqual([
      [M, 1],
      [W, 1],
      [S, 1]
    ])
    expect(a.warns).toEqual([])

    const b = makeWorld({ speak: judgeEndsGame })
    werewolfFamily(b)
    delete b.deps.setSessionTurnCap
    await send(new GroupOrchestrator({ deps: b.deps }), b, M, '开始')
    expect(b.systemRows().map((r) => r.meta.kind)).toEqual(['game_over'])
    expect(b.warns).toEqual([])

    const c = makeWorld({ speak: judgeEndsGame })
    werewolfFamily(c)
    c.deps.setSessionTurnCap = (sid) => {
      if (sid === M) throw new Error('boom-sync')
      return Promise.reject(new Error('boom-async'))
    }
    const orchC = new GroupOrchestrator({ deps: c.deps })
    await send(orchC, c, M, '开始')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(c.systemRows().map((r) => r.meta.kind)).toEqual(['game_over'])
    expect(c.warns.map((w) => w.data.error).sort()).toEqual([
      'boom-async',
      'boom-async',
      'boom-sync'
    ])
    expect(c.warns.every((w) => w.message.includes('setSessionTurnCap'))).toBe(true)
    expect(await send(orchC, c, M, '还在吗')).toEqual([])
  })
})

// ── GS12 stopFamily 的 family 语义 ──────────────────────────────────────────────────

describe('GS12 stopFamily（父群停 → 子群连带）', () => {
  test('W 有在队 turn、M 在写时 stopFamily(M) → W 队列清空、当时活动的 family session 各一条 owner_stop、stopped:true', async () => {
    const world = makeWorld()
    werewolfFamily(world)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    world.speakImpl = async (input, n) => {
      if (input.agentId === JUDGE) await gate
      return defaultSpeak(input, n)
    }
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    await orch.onGroupMessage(M, world.human(M, '@法官 开始'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(orch.liveState(M).inFlight).toBe(JUDGE)
    await orch.onGroupMessage(W, world.human(W, '@玩家甲 夜晚'))
    expect(orch.pendingFor(W)).toEqual(['p1'])

    expect(orch.stopFamily(M)).toEqual({ stopped: true })
    release()
    await orch.idle()

    expect(orch.pendingFor(W)).toEqual([])
    const family = world.facts.get(M)!.familySessionIds
    for (const sid of family) expect(world.stopReasons(sid)).toEqual(['owner_stop'])
    expect(world.systemRows()).toHaveLength(family.length)
    expect(world.outcomes()).toEqual(['stopped'])

    const idle = makeWorld()
    werewolfFamily(idle)
    expect(new GroupOrchestrator({ deps: idle.deps }).stopFamily(M)).toEqual({ stopped: false })
    expect(idle.systemRows()).toEqual([])
  })
})

// ── GS13 单源 ─────────────────────────────────────────────────────────────────────

describe('GS13 GAME_OVER_PREFIX 单源', () => {
  test('groupOrchestrator.ts / groupGame.ts 源文件不含前缀字面，只 import groupFloors 的常量', () => {
    for (const rel of ['groupOrchestrator.ts', 'groupGame.ts']) {
      const src = readFileSync(new URL(`../../src/ai-gateway/${rel}`, import.meta.url), 'utf8')
      expect(src).not.toContain(GAME_OVER_PREFIX)
    }
    const orchestrator = readFileSync(
      new URL('../../src/ai-gateway/groupOrchestrator.ts', import.meta.url),
      'utf8'
    )
    expect(orchestrator).toMatch(/\bGAME_OVER_PREFIX\b/)
  })
})
