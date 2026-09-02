// L4 群聊 g1 — 服务端群 run 调度器（groupOrchestrator）的行为契约。
//
// 假 deps = 一个内存「库」（消息 / turn 台账 / 游标 / 事实 / labs / 假时钟 / 假 sleep）+ 真的
// ActiveRunRegistry（纯 Node）。每条地板一正例 + 一变异用例（把对应常量 doMock 成 Infinity、
// 或把注入的 config 撤掉，断言正例的期望必红 —— `rejects` 形态固化进 CI，防「地板被优雅删除」）。
// 另有一条用真 prepareChatRun + MockLanguageModelV3 做 speak 适配器的集成用例（K-B 接线形状）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import { prepareChatRun } from '../../src/ai-gateway/chatRun'
import type { AiGatewayConfig, SessionAgentIdentity } from '../../src/ai-gateway/config'
import type { GroupTranscriptRow } from '../../src/ai-gateway/groupChat'
import {
  CHAIN_CAP_DEFAULT,
  HOURLY_TOKENS_DEFAULT,
  HOURLY_TURNS_DEFAULT,
  HOURLY_USD_DEFAULT,
  MIN_TURN_GAP_MS,
  PER_AGENT_RUN_CAP,
  RATE_PER_MINUTE,
  RUN_WALL_MS,
  SILENCE_SENTINEL,
  type GroupStopReason
} from '../../src/ai-gateway/groupFloors'
import {
  GroupOrchestrator,
  type GroupAppendInput,
  type GroupOrchestratorDeps,
  type GroupRunFacts,
  type GroupSpeakInput,
  type GroupSpeakResult,
  type GroupTurnRow,
  type GroupUsage
} from '../../src/ai-gateway/groupOrchestrator'
import { GROUP_SKIP_REASONS, type GroupTurnEvent } from '../../src/ai-gateway/groupTurnEvent'

type OrchestratorModule = typeof import('../../src/ai-gateway/groupOrchestrator')
type FloorsModule = typeof import('../../src/ai-gateway/groupFloors')

// ── 假世界 ─────────────────────────────────────────────────────────────────────

interface StoredMessage extends GroupTranscriptRow {
  sessionId: number
  metadata: string | null
  model: string | null
  tokensInput: number | null
  tokensOutput: number | null
  costUsd: number | null
}

interface World {
  clock: { now: number }
  messages: StoredMessage[]
  turns: GroupTurnRow[]
  cursors: Map<string, number>
  sleeps: number[]
  speakCalls: GroupSpeakInput[]
  facts: Map<number, GroupRunFacts>
  labs: boolean
  usageOverride: GroupUsage | null
  registry: ActiveRunRegistry
  mirrored: Array<Record<string, unknown>>
  speakImpl: (input: GroupSpeakInput, n: number) => Promise<GroupSpeakResult>
  /** deps.emitEvent 收到的事件，按发出序（UX 批）。 */
  events: GroupTurnEvent[]
  /** 可选的 emitEvent 替身（EV11：抛错）；先于 events.push 调用。 */
  emitImpl: ((event: GroupTurnEvent) => void) | null
  deps: GroupOrchestratorDeps
  nextId: number
  /** system 行的 metadata.reason，按写入序。 */
  stopReasons(sessionId?: number): GroupStopReason[]
  outcomes(): string[]
  assistantRows(sessionId?: number): StoredMessage[]
  human(sessionId: number, content: string, via?: 'main_agent' | null): StoredMessage
}

const SONNET = 'claude-sonnet-4-5'

function defaultSpeak(input: GroupSpeakInput, n: number): Promise<GroupSpeakResult> {
  return Promise.resolve({
    text: `${input.agentId} 第 ${n} 次发言`,
    modelId: SONNET,
    usage: { inputTokens: 100, outputTokens: 10 },
    protocol: 'anthropic'
  })
}

function makeWorld(opts: { speak?: World['speakImpl']; labs?: boolean } = {}): World {
  const clock = { now: 1_000_000 }
  const registry = new ActiveRunRegistry({ now: () => clock.now })
  let speakCount = 0
  const world: World = {
    clock,
    messages: [],
    turns: [],
    cursors: new Map(),
    sleeps: [],
    speakCalls: [],
    facts: new Map(),
    labs: opts.labs ?? true,
    usageOverride: null,
    registry,
    mirrored: [],
    speakImpl: opts.speak ?? defaultSpeak,
    events: [],
    emitImpl: null,
    nextId: 1,
    deps: undefined as unknown as GroupOrchestratorDeps,
    stopReasons(sessionId) {
      return world.messages
        .filter((m) => m.role === 'system' && (sessionId == null || m.sessionId === sessionId))
        .map((m) => (JSON.parse(m.metadata ?? '{}') as { reason: GroupStopReason }).reason)
    },
    outcomes() {
      return world.turns.map((t) => t.outcome)
    },
    assistantRows(sessionId) {
      return world.messages.filter(
        (m) => m.role === 'assistant' && (sessionId == null || m.sessionId === sessionId)
      )
    },
    human(sessionId, content, via = null) {
      const id = world.nextId++
      const row: StoredMessage = {
        sessionId,
        id,
        role: 'user',
        content,
        speakerAgentId: null,
        status: 'complete',
        chainId: id,
        via,
        createdAt: clock.now,
        metadata: via ? JSON.stringify({ via }) : null,
        model: null,
        tokensInput: null,
        tokensOutput: null,
        costUsd: null
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
      metadata: input.metadata ?? null,
      model: input.model ?? null,
      tokensInput: input.tokensInput ?? null,
      tokensOutput: input.tokensOutput ?? null,
      costUsd: input.costUsd ?? null
    })
    return id
  }
  world.deps = {
    resolveFacts: (sessionId) => world.facts.get(sessionId) ?? null,
    listHistory: (sessionId) => world.messages.filter((m) => m.sessionId === sessionId),
    appendMessage: append,
    getSeenCursor: (sessionId, agentId) => world.cursors.get(`${sessionId}:${agentId}`) ?? null,
    advanceSeenCursor: (sessionId, agentId, throughId) =>
      world.cursors.set(`${sessionId}:${agentId}`, throughId),
    insertTurn: (row) => world.turns.push(row),
    groupUsage: (sessionIds, sinceMs) => {
      if (world.usageOverride) return world.usageOverride
      const rows = world.turns.filter(
        (t) => sessionIds.includes(t.sessionId) && t.startedAt >= sinceMs
      )
      const costs = rows.map((t) => t.costUsd).filter((c): c is number => c != null)
      return {
        turns: rows.length,
        tokens: rows.reduce((n, t) => n + (t.tokensInput ?? 0) + (t.tokensOutput ?? 0), 0),
        costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null
      }
    },
    resolveLabs: () => Promise.resolve({ groupAgents: world.labs }),
    speak: (input) => {
      world.speakCalls.push(input)
      return world.speakImpl(input, ++speakCount)
    },
    registerRun: (sessionId, controller) => registry.register(sessionId, controller),
    releaseRun: (sessionId, runId) => registry.release(sessionId, runId),
    mirrorRunLog: (input) => {
      world.mirrored.push(input as unknown as Record<string, unknown>)
      return Promise.resolve()
    },
    emitEvent: (event) => {
      world.emitImpl?.(event)
      world.events.push(event)
    },
    now: () => clock.now,
    sleep: (ms) => {
      world.sleeps.push(ms)
      return Promise.resolve()
    },
    warn: () => {}
  }
  return world
}

function member(agentId: string, title = agentId): GroupRunFacts['members'][number] {
  return { agentId, title, duty: null, model: null }
}

/** 建群：members 全 realtime（除 mentionOnly 列出的），config 可覆盖。 */
function group(
  world: World,
  sessionId: number,
  agentIds: string[],
  opts: {
    mentionOnly?: string[]
    config?: GroupRunFacts['config']
    family?: number[]
  } = {}
): GroupRunFacts {
  const facts: GroupRunFacts = {
    members: agentIds.map((id) => member(id)),
    modes: Object.fromEntries(
      agentIds.map((id) => [id, opts.mentionOnly?.includes(id) ? 'mention' : 'realtime'])
    ),
    config: opts.config ?? {},
    familySessionIds: opts.family ?? [sessionId]
  }
  world.facts.set(sessionId, facts)
  return facts
}

async function send(
  orch: { onGroupMessage: GroupOrchestrator['onGroupMessage']; idle: GroupOrchestrator['idle'] },
  world: World,
  sessionId: number,
  text: string,
  via: 'main_agent' | null = null
): Promise<string[]> {
  const row = world.human(sessionId, text, via)
  const { queued } = await orch.onGroupMessage(sessionId, row)
  await orch.idle()
  return queued
}

/** 变异：把 groupFloors 的常量换掉后重新加载调度器模块（其余用例仍用顶层 import 的原模块）。 */
/** 常量在模块里是字面量类型（12 / 3 / …），变异要写 Infinity，故按键名放宽成 unknown。 */
type FloorOverrides = Partial<Record<keyof FloorsModule, unknown>>

async function loadMutated(overrides: FloorOverrides): Promise<OrchestratorModule> {
  vi.resetModules()
  vi.doMock('../../src/ai-gateway/groupFloors', async (importOriginal) => ({
    ...(await importOriginal<FloorsModule>()),
    ...overrides
  }))
  try {
    return await import('../../src/ai-gateway/groupOrchestrator')
  } finally {
    vi.doUnmock('../../src/ai-gateway/groupFloors')
  }
}

afterEach(() => {
  vi.resetModules()
})

// ── 候选 / 折叠 ─────────────────────────────────────────────────────────────────

describe('候选集（服务端事实）', () => {
  test('@ 优先：只有被点名的成员被唤醒（mention 模式成员被 @ 也醒）', async () => {
    const world = makeWorld()
    group(world, 1, ['a', 'b', 'c'], { mentionOnly: ['b', 'c'] })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    const queued = await send(orch, world, 1, '@b 你说说')
    expect(queued).toEqual(['b'])
    expect(world.turns.map((t) => [t.agentId, t.outcome])).toEqual([['b', 'spoke']])
    expect(world.turns[0]?.triggerKind).toBe('human')
  })

  test('无 @ → realtime 成员按成员序；主 agent 投递的 triggerKind=main_agent', async () => {
    const world = makeWorld()
    group(world, 1, ['a', 'b', 'c'], { mentionOnly: ['b'] })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    expect(await send(orch, world, 1, '大家汇报下', 'main_agent')).toEqual(['a', 'c'])
    expect(world.turns.map((t) => t.agentId)).toEqual(['a', 'c'])
    expect(world.turns.every((t) => t.triggerKind === 'main_agent')).toBe(true)
  })

  test('self 不唤醒 self：成员自己的回复只唤醒其他 realtime 成员，triggerKind=agent', async () => {
    const world = makeWorld()
    group(world, 1, ['a', 'b'])
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    world.human(1, '开场')
    const own: GroupTranscriptRow = {
      id: 99,
      role: 'assistant',
      content: '我是 a',
      speakerAgentId: 'a',
      status: 'complete',
      chainId: 1,
      via: null,
      createdAt: 0
    }
    const { queued } = await orch.onGroupMessage(1, own)
    expect(queued).toEqual(['b'])
    await orch.idle()
    expect(world.turns.map((t) => [t.agentId, t.triggerKind, t.chainId])).toEqual([
      ['b', 'agent', 1]
    ])
  })

  test('零 realtime 且无 @ → 无人回应（零 turn 零模型调用）', async () => {
    const world = makeWorld()
    group(world, 1, ['a', 'b'], { mentionOnly: ['a', 'b'] })
    const orch = new GroupOrchestrator({ deps: world.deps })
    expect(await send(orch, world, 1, '有人吗')).toEqual([])
    expect(world.turns).toEqual([])
    expect(world.speakCalls).toEqual([])
  })

  test('AC1 模式改后对下一条生效（每次 onGroupMessage 重读事实）', async () => {
    const world = makeWorld()
    group(world, 1, ['a', 'b'], { mentionOnly: ['b'] })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    expect(await send(orch, world, 1, '第一条')).toEqual(['a'])
    group(world, 1, ['a', 'b'], { mentionOnly: ['a'] })
    expect(await send(orch, world, 1, '第二条')).toEqual(['b'])
  })

  test('折叠：同 (session, agent) 在队不重复入队；在飞的成员会为新消息重新入队', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const world = makeWorld({
      speak: async (input, n) => {
        if (n === 1) await gate
        return defaultSpeak(input, n)
      }
    })
    group(world, 1, ['a', 'b', 'c'])
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    const first = await orch.onGroupMessage(1, world.human(1, '一'))
    expect(first.queued).toEqual(['a', 'b', 'c'])
    // 让 worker 走到 a 的 speak（挂在 gate 上）。
    await new Promise((r) => setTimeout(r, 0))
    expect(orch.pendingFor(1)).toEqual(['b', 'c'])
    const second = await orch.onGroupMessage(1, world.human(1, '二'))
    expect(second.queued).toEqual(['a'])
    expect(orch.pendingFor(1)).toEqual(['b', 'c', 'a'])
    release()
    await orch.idle()
    expect(world.turns.map((t) => t.agentId)).toEqual(['a', 'b', 'c', 'a'])
  })
})

// ── 反独白 / 窗口 / 沉默 / 重复 / 游标 ────────────────────────────────────────────

describe('单个 turn 的六种 outcome 与游标', () => {
  test('反独白：上一发言者是自己 → skipped（不是停止），游标推进', async () => {
    const world = makeWorld()
    group(world, 1, ['a'], { mentionOnly: ['a'] })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    const trigger = world.human(1, '@a 说')
    world.messages.push({
      ...trigger,
      id: world.nextId++,
      role: 'assistant',
      content: '我刚说过了',
      speakerAgentId: 'a',
      chainId: trigger.id
    })
    await orch.onGroupMessage(1, trigger)
    await orch.idle()
    expect(world.outcomes()).toEqual(['skipped'])
    expect(world.speakCalls).toEqual([])
    expect(world.cursors.get('1:a')).toBe(trigger.id + 1)
    expect(world.stopReasons()).toEqual([])
  })

  test('无他人新消息 → skipped，窗口 id 落台账，游标推进到快照 maxId', async () => {
    const world = makeWorld()
    group(world, 1, ['a', 'b'], { mentionOnly: ['a', 'b'] })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    const trigger = world.human(1, '@a 说')
    const bRow = world.nextId++
    world.messages.push({
      ...trigger,
      id: bRow,
      role: 'assistant',
      content: 'b 说',
      speakerAgentId: 'b'
    })
    world.cursors.set('1:a', bRow)
    await orch.onGroupMessage(1, trigger)
    await orch.idle()
    expect(world.outcomes()).toEqual(['skipped'])
    expect(world.turns[0]).toMatchObject({ windowFromId: trigger.id, windowToId: bRow })
    expect(world.speakCalls).toEqual([])
  })

  test('spoke：落 assistant 行（token / cost / chain_id）+ turn 行 + 游标 + run_log 镜像', async () => {
    const world = makeWorld()
    group(world, 1, ['a'])
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    await send(orch, world, 1, '开场')
    const rows = world.assistantRows(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      speakerAgentId: 'a',
      model: SONNET,
      tokensInput: 100,
      tokensOutput: 10,
      chainId: 1
    })
    expect(rows[0]?.costUsd).toBeGreaterThan(0)
    expect(world.turns[0]).toMatchObject({
      outcome: 'spoke',
      messageId: rows[0]?.id,
      tokensInput: 100,
      tokensOutput: 10,
      windowFromId: 1,
      windowToId: 1,
      seq: 1
    })
    expect(world.cursors.get('1:a')).toBe(1)
    expect(world.mirrored).toHaveLength(1)
    expect(world.mirrored[0]).toMatchObject({
      status: 'completed',
      agentId: 'a',
      sessionId: 1,
      chainId: 1,
      runId: world.turns[0]?.runId,
      messageId: rows[0]?.id,
      windowFromId: 1,
      windowToId: 1,
      tokensInput: 100,
      tokensOutput: 10
    })
    // speak 收到的历史：首条 user 带 [用户] 前缀。
    const first = world.speakCalls[0]?.messages[0]
    expect(first?.role).toBe('user')
    expect((first?.parts[0] as { text: string }).text).toBe('[用户] 开场')
    // 沉默期间 /run/active 的租约已释放。
    expect(world.registry.hasActive(1)).toBe(false)
  })

  test('silent：不落消息行、有 turn 行且计 token、游标推进', async () => {
    const world = makeWorld({
      speak: () =>
        Promise.resolve({
          text: `${SILENCE_SENTINEL}`,
          modelId: SONNET,
          usage: { inputTokens: 50, outputTokens: 2 },
          protocol: 'anthropic'
        })
    })
    group(world, 1, ['a'])
    const orch = new GroupOrchestrator({ deps: world.deps })
    await send(orch, world, 1, '开场')
    expect(world.assistantRows()).toEqual([])
    expect(world.turns).toHaveLength(1)
    expect(world.turns[0]).toMatchObject({ outcome: 'silent', tokensInput: 50, tokensOutput: 2 })
    expect(world.cursors.get('1:a')).toBe(1)
    expect(world.mirrored).toEqual([])
  })

  test('held_dup：与快照末尾他人消息逐字重复 → 不落行、游标推进', async () => {
    const world = makeWorld({
      speak: () =>
        Promise.resolve({
          text: '同意，按 A 方案推进！',
          modelId: SONNET,
          usage: { inputTokens: 1, outputTokens: 1 },
          protocol: 'anthropic'
        })
    })
    group(world, 1, ['a'])
    const orch = new GroupOrchestrator({ deps: world.deps })
    await send(orch, world, 1, '同意 按a方案推进')
    expect(world.assistantRows()).toEqual([])
    expect(world.outcomes()).toEqual(['held_dup'])
    expect(world.cursors.get('1:a')).toBe(1)
  })

  test('failed：speak 抛错 → 不落行、游标不动、队列继续下一成员；镜像 status=failed', async () => {
    const world = makeWorld({
      speak: (input, n) => (n === 1 ? Promise.reject(new Error('boom')) : defaultSpeak(input, n))
    })
    group(world, 1, ['a', 'b'])
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    await send(orch, world, 1, '开场')
    expect(world.outcomes()).toEqual(['failed', 'spoke'])
    expect(world.turns[0]).toMatchObject({ error: 'boom', messageId: null })
    expect(world.cursors.has('1:a')).toBe(false)
    expect(world.cursors.get('1:b')).toBe(1)
    expect(world.assistantRows().map((r) => r.speakerAgentId)).toEqual(['b'])
    expect(world.mirrored.map((m) => m.status)).toEqual(['failed', 'completed'])
    expect(world.stopReasons()).toEqual([])
    // 租约在 finally 释放：失败后 session 立刻可用。
    expect(world.registry.hasActive(1)).toBe(false)
  })

  test('同一 run 连续 3 次 failed → stop(error)：system 行 + 队列清空', async () => {
    const world = makeWorld({ speak: () => Promise.reject(new Error('down')) })
    group(world, 1, ['a', 'b', 'c', 'd'])
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    await send(orch, world, 1, '开场')
    expect(world.outcomes()).toEqual(['failed', 'failed', 'failed'])
    expect(world.stopReasons(1)).toEqual(['error'])
    expect(orch.pendingFor(1)).toEqual([])
    // 新的人类消息 = 新链，计数从零。
    world.speakImpl = defaultSpeak
    await send(orch, world, 1, '再来')
    expect(world.outcomes().slice(3)).toEqual(['spoke', 'spoke', 'spoke', 'spoke'])
  })

  test('failed 被非 failed 打断则计数重置（不累计到 3）', async () => {
    const world = makeWorld({
      speak: (input, n) =>
        n % 2 === 1 ? Promise.reject(new Error('flaky')) : defaultSpeak(input, n)
    })
    group(world, 1, ['a', 'b', 'c', 'd', 'e', 'f'])
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    await send(orch, world, 1, '开场')
    expect(world.outcomes()).toEqual(['failed', 'spoke', 'failed', 'spoke', 'failed', 'spoke'])
    expect(world.stopReasons()).toEqual([])
  })

  test('节拍：每个 speak 前 sleep(MIN_TURN_GAP_MS)；同一分钟第 RATE_PER_MINUTE+1 个 turn 等令牌', async () => {
    const world = makeWorld()
    group(world, 1, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    const orch = new GroupOrchestrator({ deps: world.deps })
    for (let i = 0; i < 3; i++) await send(orch, world, 1, `第 ${i} 条`)
    const speakTurns = world.turns.filter(
      (t) => t.outcome !== 'stopped' && t.outcome !== 'skipped'
    ).length
    expect(speakTurns).toBeGreaterThan(RATE_PER_MINUTE)
    const gaps = world.sleeps.filter((ms) => ms === MIN_TURN_GAP_MS).length
    const waits = world.sleeps.filter((ms) => ms !== MIN_TURN_GAP_MS)
    expect(gaps).toBe(speakTurns)
    expect(waits).toHaveLength(speakTurns - RATE_PER_MINUTE)
    expect(waits.every((ms) => ms === Math.ceil(60_000 / RATE_PER_MINUTE))).toBe(true)
  })
})

// ── 停止 ──────────────────────────────────────────────────────────────────────────

describe('停止（stopFamily / owner_stop）', () => {
  test('speak 期间 /run/active 可见；stopFamily 中止在飞 turn（outcome stopped，游标不动）、清队列、family 各群一条 system 行', async () => {
    let seenActive: boolean | null = null
    const world = makeWorld({
      speak: (input) =>
        new Promise((_, reject) => {
          seenActive = world.registry.hasActive(input.sessionId)
          input.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })
    group(world, 1, ['a', 'b', 'c'], { family: [1, 2] })
    group(world, 2, ['x'], { family: [1, 2] })
    const orch = new GroupOrchestrator({ deps: world.deps })
    await orch.onGroupMessage(1, world.human(1, '开场'))
    await new Promise((r) => setTimeout(r, 0))
    expect(seenActive).toBe(true)
    expect(orch.pendingFor(1)).toEqual(['b', 'c'])
    // 与 server.ts handleRunStop 的顺序一致：先 registry.stop 再 stopFamily。
    world.registry.stop(1)
    expect(orch.stopFamily(1)).toEqual({ stopped: true })
    await orch.idle()
    expect(world.outcomes()).toEqual(['stopped'])
    expect(world.turns[0]?.error).toBe('owner_stop')
    expect(world.cursors.size).toBe(0)
    expect(orch.pendingFor(1)).toEqual([])
    expect(world.stopReasons(1)).toEqual(['owner_stop'])
    expect(world.stopReasons(2)).toEqual(['owner_stop'])
    const meta = JSON.parse(world.messages.find((m) => m.role === 'system')?.metadata ?? '{}')
    expect(meta).toMatchObject({
      kind: 'group_stop',
      reason: 'owner_stop',
      runId: world.turns[0]?.runId
    })
    expect(world.assistantRows()).toEqual([])
  })

  test('stopFamily 只经 orchestrator（registry 没先 abort）也能中止在飞 turn，且不写第二条 system 行', async () => {
    const world = makeWorld({
      speak: (input) =>
        new Promise((_, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })
    group(world, 1, ['a', 'b'])
    const orch = new GroupOrchestrator({ deps: world.deps })
    await orch.onGroupMessage(1, world.human(1, '开场'))
    await new Promise((r) => setTimeout(r, 0))
    expect(orch.stopFamily(1)).toEqual({ stopped: true })
    await orch.idle()
    expect(world.outcomes()).toEqual(['stopped'])
    expect(world.stopReasons(1)).toEqual(['owner_stop'])
  })

  test('无事可停 → {stopped:false}，不写 system 行', async () => {
    const world = makeWorld()
    group(world, 1, ['a'])
    const orch = new GroupOrchestrator({ deps: world.deps })
    await send(orch, world, 1, '开场')
    expect(orch.stopFamily(1)).toEqual({ stopped: false })
    expect(world.stopReasons()).toEqual([])
  })

  test('级联开关：cascade=false 时成员回复不再唤醒他人；默认 true 会级联直到地板', async () => {
    const off = makeWorld()
    group(off, 1, ['a', 'b'])
    await send(new GroupOrchestrator({ deps: off.deps, cascade: false }), off, 1, '开场')
    expect(off.outcomes()).toEqual(['spoke', 'spoke'])
    expect(off.stopReasons()).toEqual([])

    const on = makeWorld()
    group(on, 1, ['a', 'b'])
    await send(new GroupOrchestrator({ deps: on.deps }), on, 1, '开场')
    expect(on.outcomes().filter((o) => o === 'spoke').length).toBeGreaterThan(2)
    expect(on.stopReasons()).toHaveLength(1)
  })
})

// ── 地板：每条一正例 + 一变异用例（AC3）────────────────────────────────────────────

interface FloorCase {
  reason: GroupStopReason
  /** 布置世界 + 建群；返回要发的第一条人类消息文本。 */
  arrange: (world: World) => void
  /** 变异：constants → 改常量重载模块；world → 改注入的 config / labs。 */
  mutation: { constants?: FloorOverrides; world?: (world: World) => void }
  /** 正例的附加断言。 */
  also?: (world: World) => void
}

const EIGHT = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

const FLOOR_CASES: FloorCase[] = [
  {
    reason: 'chain_cap',
    arrange: (world) => group(world, 1, EIGHT),
    mutation: { constants: { CHAIN_CAP_DEFAULT: Infinity } },
    also: (world) => {
      const counted = world.turns.filter((t) => ['spoke', 'silent', 'held_dup'].includes(t.outcome))
      expect(counted).toHaveLength(CHAIN_CAP_DEFAULT)
      expect(world.turns[world.turns.length - 1]).toMatchObject({
        outcome: 'stopped',
        error: 'chain_cap'
      })
      // 红线 4 守恒：台账行数 = run 的全部 turn。
      expect(world.turns).toHaveLength(CHAIN_CAP_DEFAULT + 1)
    }
  },
  {
    reason: 'per_agent_cap',
    // 法官在场 → lapping 不适用；法官 mention 模式不被唤醒 → a↔b 乒乓直到 a 第 4 次尝试。
    arrange: (world) =>
      group(world, 1, ['judge', 'a', 'b'], {
        mentionOnly: ['judge'],
        config: { judgeAgentId: 'judge' }
      }),
    mutation: { constants: { PER_AGENT_RUN_CAP: Infinity } },
    also: (world) => {
      const aSpoke = world.turns.filter((t) => t.agentId === 'a' && t.outcome === 'spoke')
      expect(aSpoke).toHaveLength(PER_AGENT_RUN_CAP)
    }
  },
  {
    reason: 'lapping',
    arrange: (world) => group(world, 1, ['a', 'b']),
    mutation: { constants: { LAPPING_FACTOR: Infinity } },
    also: (world) => {
      const spoke = world.turns.filter((t) => t.outcome === 'spoke')
      // 2 人群：发言数 > 2 × 2 时停 → 第 5 次发言后的下一次尝试。
      expect(spoke).toHaveLength(5)
    }
  },
  {
    reason: 'hourly_turns',
    arrange: (world) => {
      group(world, 1, ['a'])
      world.usageOverride = { turns: HOURLY_TURNS_DEFAULT, tokens: 0, costUsd: null }
    },
    mutation: { constants: { HOURLY_TURNS_DEFAULT: Infinity } }
  },
  {
    reason: 'hourly_tokens',
    arrange: (world) => {
      group(world, 1, ['a'])
      world.usageOverride = { turns: 0, tokens: HOURLY_TOKENS_DEFAULT, costUsd: null }
    },
    mutation: { constants: { HOURLY_TOKENS_DEFAULT: Infinity } }
  },
  {
    reason: 'hourly_budget',
    arrange: (world) => {
      group(world, 1, ['a'])
      world.usageOverride = { turns: 0, tokens: 0, costUsd: HOURLY_USD_DEFAULT }
    },
    mutation: { constants: { HOURLY_USD_DEFAULT: Infinity } }
  },
  {
    reason: 'session_cap',
    arrange: (world) => group(world, 1, ['a', 'b'], { config: { sessionTurnCap: 2 } }),
    mutation: {
      world: (world) => group(world, 1, ['a', 'b'], { config: { sessionTurnCap: null } })
    },
    also: (world) => expect(world.outcomes()).toEqual(['spoke', 'spoke', 'stopped'])
  },
  {
    reason: 'wall',
    arrange: (world) => {
      group(world, 1, ['a', 'b'])
      world.speakImpl = (input, n) => {
        world.clock.now += RUN_WALL_MS
        return defaultSpeak(input, n)
      }
    },
    mutation: { constants: { RUN_WALL_MS: Infinity } },
    also: (world) => expect(world.outcomes()).toEqual(['spoke', 'stopped'])
  },
  {
    reason: 'labs_off',
    arrange: (world) => {
      group(world, 1, ['a', 'b'])
      world.speakImpl = (input, n) => {
        world.labs = false
        return defaultSpeak(input, n)
      }
    },
    mutation: {
      world: (world) => {
        world.speakImpl = defaultSpeak
      }
    },
    also: (world) => expect(world.outcomes()).toEqual(['spoke', 'stopped'])
  }
]

/** 跑场景并断言停止原因 —— 变异用例对它取 rejects。 */
async function assertStopsWith(
  mod: OrchestratorModule,
  world: World,
  reason: GroupStopReason
): Promise<void> {
  const orch = new mod.GroupOrchestrator({ deps: world.deps })
  await send(orch, world, 1, '开场')
  expect(world.stopReasons(1)).toEqual([reason])
  expect(world.turns[world.turns.length - 1]).toMatchObject({ outcome: 'stopped', error: reason })
  expect(orch.pendingFor(1)).toEqual([])
}

describe('地板（groupFloors 单源；每条正例 + mutation）', () => {
  const original: OrchestratorModule = { GroupOrchestrator } as OrchestratorModule
  for (const c of FLOOR_CASES) {
    test(`${c.reason} — 正例：命中即停，system 行 metadata.reason=${c.reason}`, async () => {
      const world = makeWorld()
      c.arrange(world)
      await assertStopsWith(original, world, c.reason)
      c.also?.(world)
    })

    test(`${c.reason} — mutation：地板失效后正例必红`, async () => {
      const world = makeWorld()
      c.arrange(world)
      let mod = original
      if (c.mutation.constants) mod = await loadMutated(c.mutation.constants)
      c.mutation.world?.(world)
      await expect(assertStopsWith(mod, world, c.reason)).rejects.toThrow()
      // 变异下场景仍有界（别的地板兜住），不是死循环。
      expect(world.turns.length).toBeLessThan(200)
    })
  }

  test('chain_cap 可由群设置覆盖（config.chainCap），且 seq / chain_id 连贯', async () => {
    const world = makeWorld()
    group(world, 1, EIGHT, { config: { chainCap: 3 } })
    const orch = new GroupOrchestrator({ deps: world.deps })
    await send(orch, world, 1, '开场')
    expect(world.outcomes()).toEqual(['spoke', 'spoke', 'spoke', 'stopped'])
    expect(world.turns.map((t) => t.seq)).toEqual([1, 2, 3, 4])
    expect(new Set(world.turns.map((t) => t.chainId)).size).toBe(1)
    expect(new Set(world.turns.map((t) => t.runId)).size).toBe(1)
    // 成员回复继承触发消息的 chain_id。
    expect(world.assistantRows().every((r) => r.chainId === 1)).toBe(true)
  })

  test('hourly_budget：cost 全 NULL 时不生效（tokens 地板兜底）', async () => {
    const world = makeWorld()
    group(world, 1, ['a'])
    world.usageOverride = { turns: 0, tokens: 0, costUsd: null }
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    await send(orch, world, 1, '开场')
    expect(world.outcomes()).toEqual(['spoke'])
  })

  test('地板按 family 停：子群队列一并清（一个 turn 都不跑）、各群各一条 system 行', async () => {
    const world = makeWorld()
    group(world, 1, ['a', 'b'], { family: [1, 2], config: { chainCap: 1 } })
    group(world, 2, ['x', 'y'], { family: [1, 2] })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    world.speakImpl = async (input, n) => {
      // a 发言期间子群来了消息：x / y 入队，排在 b 后面。
      if (n === 1) await orch.onGroupMessage(2, world.human(2, '子群开场'))
      return defaultSpeak(input, n)
    }
    await send(orch, world, 1, '开场')
    // a spoke（counted=1）→ b 命中 chainCap=1 → family 全停：x / y 从未跑。
    expect(world.turns.map((t) => [t.sessionId, t.agentId, t.outcome])).toEqual([
      [1, 'a', 'spoke'],
      [1, 'b', 'stopped']
    ])
    expect(orch.pendingFor(2)).toEqual([])
    expect(world.stopReasons(1)).toEqual(['chain_cap'])
    expect(world.stopReasons(2)).toEqual(['chain_cap'])
  })
})

// ── K-B 接线形状：真 prepareChatRun + MockLanguageModelV3 做 speak 适配器 ────────────

describe('speak 适配器（prepareChatRun 集成）', () => {
  test('adapter：identity.group + 成员 model 中层优先 + usage 透传 + 零工具', async () => {
    const USAGE = {
      inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 3, text: 3, reasoning: 0 }
    }
    const captured: { options?: unknown } = {}
    const createModel = vi.fn(
      () =>
        new MockLanguageModelV3({
          doStream: (async (options: unknown) => {
            captured.options = options
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start' as const, warnings: [] },
                  { type: 'text-start' as const, id: '1' },
                  { type: 'text-delta' as const, id: '1', delta: '我说一句' },
                  { type: 'text-end' as const, id: '1' },
                  {
                    type: 'finish' as const,
                    finishReason: { unified: 'stop' as const },
                    usage: USAGE
                  }
                ]
              })
            }
          }) as unknown as NonNullable<
            ConstructorParameters<typeof MockLanguageModelV3>[0]
          >['doStream']
        })
    )
    const buildTools = vi.fn(() => ({}))
    const gatewayCfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'gateway-default-model',
      createModel,
      buildTools,
      systemPromptProvider: async () => ({ standingContext: 'STAND' })
    }
    const world = makeWorld({
      speak: async (input) => {
        const identity: SessionAgentIdentity = {
          agentId: input.member.agentId,
          agentTitle: input.member.title,
          duty: input.member.duty ?? null,
          model: input.member.model ?? null,
          scheduleLine: null,
          group: {
            members: input.facts.members.map((m) => ({ agentId: m.agentId, title: m.title }))
          }
        }
        const prepared = await prepareChatRun(
          { messages: input.messages },
          gatewayCfg,
          input.signal,
          'manual_chat',
          identity
        )
        if (!prepared.ok) throw new Error(prepared.body.error)
        const text = await prepared.run.result.text
        const usage = await prepared.run.result.usage
        return {
          text,
          modelId: prepared.run.modelId,
          usage: {
            inputTokens: usage.inputTokens ?? null,
            outputTokens: usage.outputTokens ?? null
          },
          protocol: prepared.run.protocol
        }
      }
    })
    world.facts.set(1, {
      members: [
        { agentId: 'a', title: '调研员', duty: null, model: 'member-model' },
        { agentId: 'b', title: '跟进官', duty: null, model: null }
      ],
      modes: { a: 'realtime', b: 'mention' },
      config: {},
      familySessionIds: [1]
    })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    await send(orch, world, 1, '大家汇报下')
    expect(world.outcomes()).toEqual(['spoke'])
    expect(world.assistantRows()[0]).toMatchObject({
      content: '我说一句',
      model: 'member-model',
      tokensInput: 7,
      tokensOutput: 3
    })
    expect(createModel).toHaveBeenCalledWith('member-model')
    expect(buildTools).not.toHaveBeenCalled()
    const wire = JSON.stringify(captured.options)
    expect(wire).toContain('<current_group_chat>')
    expect(wire).toContain('[用户] 大家汇报下')
  })
})

// ── UX 批：事件通道 / 成员复核 / requeue / liveState ──────────────────────────────

/** resolveFacts 按调用序返回不同事实（模拟 owner 在排队 / 发言期间改名单或设置）。 */
function factsByCall(world: World, ...sequence: GroupRunFacts[]): { calls: () => number } {
  let n = 0
  world.deps.resolveFacts = () => {
    n += 1
    return sequence[Math.min(n, sequence.length) - 1]!
  }
  return { calls: () => n }
}

function phases(world: World, sessionId?: number): string[] {
  return world.events
    .filter((e) => sessionId == null || e.sessionId === sessionId)
    .map((e) => e.phase)
}

describe('UX 批 — group turn 事件（服务端事实的投影）', () => {
  test('EV1 人类 @a → queued → start → spoke，每条带 queued[] 与 chainProgress；spoke 带 messageId / text / usage', async () => {
    const world = makeWorld()
    group(world, 1, ['a', 'b'], { mentionOnly: ['a', 'b'] })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    const root = world.human(1, '@a 说')
    await orch.onGroupMessage(1, root)
    await orch.idle()
    expect(phases(world)).toEqual(['queued', 'start', 'spoke'])
    for (const e of world.events) {
      expect(e.v).toBe(1)
      expect(e.sessionId).toBe(1)
      expect(e.chainId).toBe(root.id)
      expect(Array.isArray(e.queued)).toBe(true)
      expect(e.chainProgress).toEqual({ counted: expect.any(Number), cap: CHAIN_CAP_DEFAULT })
      expect(e.ts).toBe(world.clock.now)
    }
    const [queued, start, spoke] = world.events
    expect(queued).toMatchObject({ agentId: null, seq: null, queued: ['a'], runId: expect.any(String) })
    expect(queued!.chainProgress.counted).toBe(0)
    expect(start).toMatchObject({ agentId: 'a', seq: 1, queued: [] })
    expect(spoke).toMatchObject({
      agentId: 'a',
      seq: 1,
      messageId: world.assistantRows(1)[0]?.id,
      text: 'a 第 1 次发言',
      usage: { model: SONNET, tokensInput: 100, tokensOutput: 10, costUsd: expect.any(Number) },
      chainProgress: { counted: 1, cap: CHAIN_CAP_DEFAULT }
    })
    expect(spoke!.runId).toBe(world.turns[0]?.runId)
  })

  test('EV2 无 @ 零 realtime → no_candidates{reason:no_realtime_members}；成员级联末尾候选空不发', async () => {
    const world = makeWorld()
    group(world, 1, ['a', 'b'], { mentionOnly: ['a', 'b'] })
    const orch = new GroupOrchestrator({ deps: world.deps })
    await send(orch, world, 1, '有人吗')
    expect(world.events).toHaveLength(1)
    expect(world.events[0]).toMatchObject({
      phase: 'no_candidates',
      reason: 'no_realtime_members',
      runId: null,
      agentId: null,
      queued: []
    })

    // 级联：a 回复后候选 = realtime − self = 空，这是链正常结束，不发 no_candidates。
    const cascade = makeWorld()
    group(cascade, 2, ['a'])
    await send(new GroupOrchestrator({ deps: cascade.deps }), cascade, 2, '开场')
    expect(cascade.outcomes()).toEqual(['spoke'])
    expect(phases(cascade)).not.toContain('no_candidates')
  })

  test('EV3 沉默 → silent 事件带 usage，不落消息行', async () => {
    const world = makeWorld({
      speak: () =>
        Promise.resolve({
          text: SILENCE_SENTINEL,
          modelId: SONNET,
          usage: { inputTokens: 50, outputTokens: 2 },
          protocol: 'anthropic'
        })
    })
    group(world, 1, ['a'])
    await send(new GroupOrchestrator({ deps: world.deps }), world, 1, '开场')
    expect(world.assistantRows()).toEqual([])
    const silent = world.events.find((e) => e.phase === 'silent')
    expect(silent).toMatchObject({
      agentId: 'a',
      usage: { model: SONNET, tokensInput: 50, tokensOutput: 2 },
      chainProgress: { counted: 1, cap: CHAIN_CAP_DEFAULT }
    })
    expect(silent?.text).toBeUndefined()
  })

  test('EV4 反独白 / 无新消息 → skipped{reason}，turn 行 error 同词', async () => {
    const mono = makeWorld()
    group(mono, 1, ['a'], { mentionOnly: ['a'] })
    const trigger = mono.human(1, '@a 说')
    mono.messages.push({
      ...trigger,
      id: mono.nextId++,
      role: 'assistant',
      content: '我刚说过了',
      speakerAgentId: 'a',
      chainId: trigger.id
    })
    const orch = new GroupOrchestrator({ deps: mono.deps, cascade: false })
    await orch.onGroupMessage(1, trigger)
    await orch.idle()
    expect(mono.turns[0]).toMatchObject({ outcome: 'skipped', error: 'monologue' })
    expect(mono.events.find((e) => e.phase === 'skipped')).toMatchObject({
      agentId: 'a',
      reason: 'monologue'
    })

    const stale = makeWorld()
    group(stale, 1, ['a', 'b'], { mentionOnly: ['a', 'b'] })
    const t2 = stale.human(1, '@a 说')
    const bRow = stale.nextId++
    stale.messages.push({ ...t2, id: bRow, role: 'assistant', content: 'b 说', speakerAgentId: 'b' })
    stale.cursors.set('1:a', bRow)
    const orch2 = new GroupOrchestrator({ deps: stale.deps, cascade: false })
    await orch2.onGroupMessage(1, t2)
    await orch2.idle()
    expect(stale.turns[0]).toMatchObject({ outcome: 'skipped', error: 'no_new_messages' })
    expect(stale.events.find((e) => e.phase === 'skipped')).toMatchObject({
      agentId: 'a',
      reason: 'no_new_messages'
    })
  })

  test('EV5 speak 抛错 → failed{error}', async () => {
    const world = makeWorld({ speak: () => Promise.reject(new Error('boom')) })
    group(world, 1, ['a'])
    await send(new GroupOrchestrator({ deps: world.deps, cascade: false }), world, 1, '开场')
    expect(phases(world)).toEqual(['queued', 'start', 'failed'])
    expect(world.events[2]).toMatchObject({ agentId: 'a', seq: 1, error: 'boom' })
  })

  test('EV6 地板命中 → stopped 每 family session 一条，与 system 行数相等；processItem 的 stopped 不单发', async () => {
    const world = makeWorld()
    group(world, 1, ['a', 'b'], { family: [1, 2], config: { chainCap: 1 } })
    group(world, 2, ['x'], { family: [1, 2] })
    await send(new GroupOrchestrator({ deps: world.deps, cascade: false }), world, 1, '开场')
    const stopped = world.events.filter((e) => e.phase === 'stopped')
    const systemRows = world.messages.filter((m) => m.role === 'system')
    expect(systemRows).toHaveLength(2)
    expect(stopped).toHaveLength(systemRows.length)
    expect(stopped.map((e) => e.sessionId).sort()).toEqual([1, 2])
    for (const e of stopped) {
      expect(e).toMatchObject({ reason: 'chain_cap', agentId: null, seq: null, queued: [] })
      expect(e.runId).toBe(world.turns[0]?.runId)
    }
  })

  test('EV7 排队期间踢人 → skipped{reason:removed}，error=removed，游标不推进，不 speak', async () => {
    const world = makeWorld()
    const withA = group(world, 1, ['a', 'b'])
    const withoutA: GroupRunFacts = { ...withA, members: [member('b')], modes: { b: 'realtime' } }
    factsByCall(world, withA, withoutA)
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    await orch.onGroupMessage(1, world.human(1, '开场'))
    await orch.idle()
    expect(world.turns.map((t) => [t.agentId, t.outcome, t.error])).toEqual([
      ['a', 'skipped', 'removed'],
      ['b', 'spoke', null]
    ])
    expect(world.events.find((e) => e.phase === 'skipped')).toMatchObject({
      agentId: 'a',
      reason: 'removed'
    })
    expect(world.cursors.has('1:a')).toBe(false)
    expect(world.speakCalls.map((c) => c.agentId)).toEqual(['b'])
  })

  test('EV7b 复核通过、advance 前名单已不含 a（resolveFacts 再读）→ advanceSeenCursor 不写', async () => {
    const world = makeWorld()
    const withA = group(world, 1, ['a'])
    const withoutA: GroupRunFacts = { ...withA, members: [], modes: {} }
    // 1 = onGroupMessage，2 = 取出时复核，3+ = 写游标前再读。
    factsByCall(world, withA, withA, withoutA)
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    await orch.onGroupMessage(1, world.human(1, '开场'))
    await orch.idle()
    expect(world.outcomes()).toEqual(['spoke'])
    expect(world.assistantRows()).toHaveLength(1)
    expect(world.cursors.has('1:a')).toBe(false)
  })

  test('EV8 requeue：非成员 → E_NOT_GROUP_MEMBER；成员 → queued 事件 + 折叠（连点两次只一项）', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const world = makeWorld({
      speak: async (input, n) => {
        if (n === 1) await gate
        return defaultSpeak(input, n)
      }
    })
    group(world, 1, ['a'], { mentionOnly: ['a'] })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    const root = world.human(1, '@a 说')
    await orch.onGroupMessage(1, root)
    await new Promise((r) => setTimeout(r, 0))
    expect(await orch.requeue(1, 'zzz', root.id)).toEqual({
      queued: false,
      error: 'E_NOT_GROUP_MEMBER'
    })
    expect(await orch.requeue(1, 'a', root.id)).toEqual({ queued: true })
    expect(await orch.requeue(1, 'a', root.id)).toEqual({ queued: false })
    expect(orch.pendingFor(1)).toEqual(['a'])
    expect(phases(world).filter((p) => p === 'queued')).toHaveLength(3)
    release()
    await orch.idle()
    expect(world.turns.filter((t) => t.agentId === 'a')).toHaveLength(2)
  })

  test('EV8b requeue 目标链已被地板 / owner 停掉 → E_RUN_STOPPED，队列不变、无事件', async () => {
    const world = makeWorld()
    group(world, 1, EIGHT, { config: { chainCap: 1 } })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    const root = world.human(1, '开场')
    await orch.onGroupMessage(1, root)
    await orch.idle()
    expect(world.stopReasons(1)).toEqual(['chain_cap'])
    const before = world.events.length
    expect(await orch.requeue(1, 'c', root.id)).toEqual({ queued: false, error: 'E_RUN_STOPPED' })
    expect(orch.pendingFor(1)).toEqual([])
    expect(world.events).toHaveLength(before)

    // owner_stop 同样登记。
    const owner = makeWorld({
      speak: (input) =>
        new Promise((_, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })
    group(owner, 1, ['a', 'b'])
    const orch2 = new GroupOrchestrator({ deps: owner.deps })
    const root2 = owner.human(1, '开场')
    await orch2.onGroupMessage(1, root2)
    await new Promise((r) => setTimeout(r, 0))
    expect(orch2.stopFamily(1)).toEqual({ stopped: true })
    await orch2.idle()
    expect(await orch2.requeue(1, 'b', root2.id)).toEqual({ queued: false, error: 'E_RUN_STOPPED' })
  })

  test('EV9 requeue 在 run 正常跑完被 reap 后重建 run：新 runId，chainProgress.counted 从 0', async () => {
    const world = makeWorld()
    group(world, 1, ['a'], { mentionOnly: ['a'] })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    const root = world.human(1, '@a 说')
    await orch.onGroupMessage(1, root)
    await orch.idle()
    const firstRunId = world.turns[0]!.runId
    expect(world.events.at(-1)?.chainProgress.counted).toBe(1)
    expect(await orch.requeue(1, 'a', root.id)).toEqual({ queued: true })
    const queued = world.events.at(-1)!
    expect(queued.phase).toBe('queued')
    expect(queued.chainProgress.counted).toBe(0)
    expect(queued.runId).not.toBe(firstRunId)
    await orch.idle()
    expect(world.turns[1]).toMatchObject({ chainId: root.id, seq: 1 })
    expect(world.turns[1]!.runId).not.toBe(firstRunId)
  })

  test('EV10 liveState：出队后租约前 preparing=a / queued=[] / inFlight=null；speak 期间 inFlight=a；结束后全空', async () => {
    let releaseSleep!: () => void
    const sleepGate = new Promise<void>((r) => (releaseSleep = r))
    let releaseSpeak!: () => void
    const speakGate = new Promise<void>((r) => (releaseSpeak = r))
    const world = makeWorld({
      speak: async (input, n) => {
        await speakGate
        return defaultSpeak(input, n)
      }
    })
    world.deps.sleep = (ms) => (ms === MIN_TURN_GAP_MS ? sleepGate : Promise.resolve())
    group(world, 1, ['a'], { mentionOnly: ['a'] })
    const orch = new GroupOrchestrator({ deps: world.deps, cascade: false })
    await orch.onGroupMessage(1, world.human(1, '@a 说'))
    await new Promise((r) => setTimeout(r, 0))
    expect(orch.liveState(1)).toEqual({ inFlight: null, preparing: 'a', queued: [] })
    expect(world.registry.hasActive(1)).toBe(false)
    expect(orch.liveState(2)).toEqual({ inFlight: null, preparing: null, queued: [] })
    releaseSleep()
    await new Promise((r) => setTimeout(r, 0))
    expect(orch.liveState(1).inFlight).toBe('a')
    expect(world.registry.hasActive(1)).toBe(true)
    releaseSpeak()
    await orch.idle()
    expect(orch.liveState(1)).toEqual({ inFlight: null, preparing: null, queued: [] })
  })

  test('EV11 emitEvent 抛错只 warn，turn 照常落账', async () => {
    const world = makeWorld()
    const warned: string[] = []
    world.deps.warn = (message) => warned.push(message)
    world.emitImpl = () => {
      throw new Error('renderer gone')
    }
    group(world, 1, ['a'])
    await send(new GroupOrchestrator({ deps: world.deps, cascade: false }), world, 1, '开场')
    expect(world.outcomes()).toEqual(['spoke'])
    expect(world.assistantRows()).toHaveLength(1)
    expect(world.events).toEqual([])
    expect(warned.some((m) => m.includes('emitEvent'))).toBe(true)
  })

  test('EV12 排队项取出时刷新事实：入队后改 modelOverride，speak 收到的 facts.config 是新值', async () => {
    const world = makeWorld()
    const before = group(world, 1, ['a'])
    const after: GroupRunFacts = { ...before, config: { modelOverride: 'override-model' } }
    factsByCall(world, before, after)
    await send(new GroupOrchestrator({ deps: world.deps, cascade: false }), world, 1, '开场')
    expect(world.speakCalls).toHaveLength(1)
    expect(world.speakCalls[0]?.facts.config.modelOverride).toBe('override-model')
  })

  test('EV13 三种 skipped 的 turn 行 error 互不相同且 ⊆ GROUP_SKIP_REASONS', async () => {
    const errors = new Set<string>()

    const mono = makeWorld()
    group(mono, 1, ['a'], { mentionOnly: ['a'] })
    const trigger = mono.human(1, '@a 说')
    mono.messages.push({
      ...trigger,
      id: mono.nextId++,
      role: 'assistant',
      content: '刚说过',
      speakerAgentId: 'a',
      chainId: trigger.id
    })
    const o1 = new GroupOrchestrator({ deps: mono.deps, cascade: false })
    await o1.onGroupMessage(1, trigger)
    await o1.idle()

    const stale = makeWorld()
    group(stale, 1, ['a', 'b'], { mentionOnly: ['a', 'b'] })
    const t2 = stale.human(1, '@a 说')
    const bRow = stale.nextId++
    stale.messages.push({ ...t2, id: bRow, role: 'assistant', content: 'b 说', speakerAgentId: 'b' })
    stale.cursors.set('1:a', bRow)
    const o2 = new GroupOrchestrator({ deps: stale.deps, cascade: false })
    await o2.onGroupMessage(1, t2)
    await o2.idle()

    const kicked = makeWorld()
    const withA = group(kicked, 1, ['a'], { mentionOnly: ['a'] })
    factsByCall(kicked, withA, { ...withA, members: [], modes: {} })
    const o3 = new GroupOrchestrator({ deps: kicked.deps, cascade: false })
    await o3.onGroupMessage(1, kicked.human(1, '@a 说'))
    await o3.idle()

    for (const w of [mono, stale, kicked]) {
      expect(w.turns).toHaveLength(1)
      expect(w.turns[0]?.outcome).toBe('skipped')
      errors.add(w.turns[0]!.error!)
      expect(w.events.find((e) => e.phase === 'skipped')?.reason).toBe(w.turns[0]!.error)
    }
    expect(errors.size).toBe(3)
    for (const e of errors) expect(GROUP_SKIP_REASONS).toContain(e)
  })
})
