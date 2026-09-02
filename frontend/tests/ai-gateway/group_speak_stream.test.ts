// L4 群聊 UX 批 — server.ts 的 speak 适配器（speakAsGroupMember）与 /api/ai/group-chat retry 分支。
//
//   S1–S3 流式：textStream 累计 → onDelta（节流 + 尾帧），GroupSpeakResult.text 恒为全文；
//   S4 modelOverride 是全群统一模型的唯一读点（优先于成员 model；缺省用成员 model）；
//   S5 retry 分支：labs off → 409 E_LABS_ORCHESTRATED；非成员 → 403；停掉的链 → 409
//   E_RUN_STOPPED；成员 → 调度器.requeue 被调、200 {ok, queued}。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'
import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import {
  GroupOrchestrator,
  type GroupRunFacts,
  type GroupSpeakInput
} from '../../src/ai-gateway/groupOrchestrator'
import {
  speakAsGroupMember,
  startAiGatewayServer,
  type AiGatewayHandle
} from '../../src/ai-gateway/server'

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 }
}

type MockDoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']

function chunkModel(chunks: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: '1' },
          ...chunks.map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
          { type: 'text-end' as const, id: '1' },
          { type: 'finish' as const, finishReason: { unified: 'stop' as const }, usage: USAGE }
        ]
      })
    })) as unknown as MockDoStream
  })
}

function cfgWith(chunks: string[]): {
  cfg: AiGatewayConfig
  createModel: ReturnType<typeof vi.fn>
} {
  const createModel = vi.fn(() => chunkModel(chunks))
  return {
    createModel,
    cfg: {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'gateway-default-model',
      createModel,
      systemPromptProvider: async () => ({ standingContext: 'STAND' })
    }
  }
}

const FACTS: GroupRunFacts = {
  members: [
    { agentId: 'a', title: '调研员', duty: null, model: 'member-model' },
    { agentId: 'b', title: '跟进官', duty: null, model: null }
  ],
  modes: { a: 'realtime', b: 'mention' },
  config: {},
  familySessionIds: [1]
}

function speakInput(overrides: Partial<GroupSpeakInput> = {}): GroupSpeakInput {
  return {
    sessionId: 1,
    agentId: 'a',
    member: FACTS.members[0]!,
    facts: FACTS,
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '[用户] 你好' }] }
    ] as MailAgentUIMessage[],
    chainId: 1,
    runId: 'run-1',
    signal: new AbortController().signal,
    ...overrides
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('speakAsGroupMember — 流式 onDelta', () => {
  test('S1 onDelta 收到累计文本（每帧都是全文前缀），尾帧 = 全文；result.text 恒为全文', async () => {
    const { cfg } = cfgWith(['你', '好', '，世', '界'])
    const frames: string[] = []
    const result = await speakAsGroupMember(cfg, speakInput({ onDelta: (acc) => frames.push(acc) }))
    expect(result.text).toBe('你好，世界')
    expect(frames.length).toBeGreaterThan(0)
    for (const f of frames) expect('你好，世界'.startsWith(f)).toBe(true)
    expect(frames.at(-1)).toBe('你好，世界')
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 })
  })

  test('S2 100ms 内的多片合并为一帧（假时钟）：首片 + 尾帧恰两帧', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const { cfg } = cfgWith(['你', '好', '世', '界'])
    const frames: string[] = []
    await speakAsGroupMember(cfg, speakInput({ onDelta: (acc) => frames.push(acc) }))
    expect(frames).toEqual(['你', '你好世界'])
  })

  test('S3 不传 onDelta：GroupSpeakResult.text 仍是全文', async () => {
    const { cfg } = cfgWith(['a', 'b', 'c'])
    const result = await speakAsGroupMember(cfg, speakInput())
    expect(result.text).toBe('abc')
    expect(result.modelId).toBe('member-model')
  })
})

describe('speakAsGroupMember — modelOverride 唯一读点', () => {
  test('S4 config.modelOverride 优先于 member.model；缺省用 member.model', async () => {
    const overridden = cfgWith(['ok'])
    await speakAsGroupMember(
      overridden.cfg,
      speakInput({ facts: { ...FACTS, config: { modelOverride: 'override-model' } } })
    )
    expect(overridden.createModel).toHaveBeenCalledWith('override-model')

    const plain = cfgWith(['ok'])
    await speakAsGroupMember(plain.cfg, speakInput())
    expect(plain.createModel).toHaveBeenCalledWith('member-model')

    const nulled = cfgWith(['ok'])
    await speakAsGroupMember(
      nulled.cfg,
      speakInput({ facts: { ...FACTS, config: { modelOverride: null } } })
    )
    expect(nulled.createModel).toHaveBeenCalledWith('member-model')
  })
})

describe('POST /api/ai/group-chat retry 分支', () => {
  const handles: AiGatewayHandle[] = []
  afterEach(async () => {
    while (handles.length) await handles.pop()!.close()
  })

  function serverCfg(opts: { labs: boolean; scheduler: GroupOrchestrator }): AiGatewayConfig {
    const { cfg } = cfgWith(['ok'])
    return {
      ...cfg,
      groupScheduler: opts.scheduler,
      resolveGroupSession: (sessionId) =>
        sessionId === 7
          ? {
              members: FACTS.members,
              config: { v: 1 as const },
              modes: FACTS.modes,
              parentSessionId: null,
              childSessionIds: []
            }
          : null,
      listGroupHistory: () => [],
      appendGroupMessage: () => 1,
      ...(opts.labs ? { resolveLabsFlags: () => ({ groupAgents: true }) } : {})
    }
  }

  function scheduler(): GroupOrchestrator {
    return new GroupOrchestrator({
      deps: {
        resolveFacts: (sessionId) => (sessionId === 7 ? FACTS : null),
        listHistory: () => [],
        appendMessage: () => 1,
        getSeenCursor: () => null,
        advanceSeenCursor: () => {},
        insertTurn: () => 1,
        groupUsage: () => ({ turns: 0, tokens: 0, costUsd: null }),
        resolveLabs: async () => ({ groupAgents: true }),
        speak: () => Promise.reject(new Error('not exercised')),
        registerRun: () => null,
        releaseRun: () => {},
        now: () => Date.now(),
        sleep: () => Promise.resolve(),
        warn: () => {}
      }
    })
  }

  async function post(port: number, body: Record<string, unknown>): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/ai/group-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  test('S5 labs off → 409 E_LABS_ORCHESTRATED；非成员 → 403；停掉的链 → 409 E_RUN_STOPPED；成员 → requeue 被调 + 200', async () => {
    const off = scheduler()
    const offSpy = vi.spyOn(off, 'requeue')
    const h1 = await startAiGatewayServer(serverCfg({ labs: false, scheduler: off }))
    handles.push(h1)
    const r1 = await post(h1.port, { sessionId: 7, retry: { agentId: 'a', chainId: 1 } })
    expect(r1.status).toBe(409)
    expect(((await r1.json()) as { error: string }).error).toBe('E_LABS_ORCHESTRATED')
    expect(offSpy).not.toHaveBeenCalled()

    const on = scheduler()
    const onSpy = vi.spyOn(on, 'requeue')
    const h2 = await startAiGatewayServer(serverCfg({ labs: true, scheduler: on }))
    handles.push(h2)
    const bad = await post(h2.port, { sessionId: 7, retry: { agentId: 'a' } })
    expect(bad.status).toBe(400)

    const nonMember = await post(h2.port, { sessionId: 7, retry: { agentId: 'zzz', chainId: 1 } })
    expect(nonMember.status).toBe(403)
    expect(((await nonMember.json()) as { error: string }).error).toBe('E_NOT_GROUP_MEMBER')

    onSpy.mockResolvedValueOnce({ queued: false, error: 'E_RUN_STOPPED' })
    const stopped = await post(h2.port, { sessionId: 7, retry: { agentId: 'a', chainId: 1 } })
    expect(stopped.status).toBe(409)
    expect(((await stopped.json()) as { error: string }).error).toBe('E_RUN_STOPPED')

    const ok = await post(h2.port, { sessionId: 7, retry: { agentId: 'a', chainId: 1 } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, queued: true })
    expect(onSpy).toHaveBeenLastCalledWith(7, 'a', 1)
    expect(on.pendingFor(7)).toEqual([])
    // 非群 session → 400 E_NOT_GROUP（facts 在 retry 之前就已判）。
    const notGroup = await post(h2.port, { sessionId: 8, retry: { agentId: 'a', chainId: 1 } })
    expect(notGroup.status).toBe(400)
    expect(((await notGroup.json()) as { error: string }).error).toBe('E_NOT_GROUP')
  })
})

describe('GET /api/ai/run/active — 群在场三元组', () => {
  const handles: AiGatewayHandle[] = []
  afterEach(async () => {
    while (handles.length) await handles.pop()!.close()
  })

  test('S6 registry 无租约但 liveState 有 preparing / queued → 200 {active, runId:null, group}；三者都空 → 404', async () => {
    const sched = new GroupOrchestrator({
      deps: {
        resolveFacts: () => null,
        listHistory: () => [],
        appendMessage: () => 1,
        getSeenCursor: () => null,
        advanceSeenCursor: () => {},
        insertTurn: () => 1,
        groupUsage: () => ({ turns: 0, tokens: 0, costUsd: null }),
        resolveLabs: async () => ({ groupAgents: true }),
        speak: () => Promise.reject(new Error('not exercised')),
        registerRun: () => null,
        releaseRun: () => {},
        now: () => Date.now(),
        sleep: () => Promise.resolve(),
        warn: () => {}
      }
    })
    const live = vi.spyOn(sched, 'liveState')
    const { cfg } = cfgWith(['ok'])
    const h = await startAiGatewayServer({
      ...cfg,
      groupScheduler: sched,
      activeRuns: new ActiveRunRegistry()
    })
    handles.push(h)
    const probe = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${h.port}/api/ai/run/active?sessionId=7`)

    live.mockReturnValue({ inFlight: null, preparing: 'a', queued: [] })
    const preparing = await probe()
    expect(preparing.status).toBe(200)
    expect(await preparing.json()).toEqual({
      active: true,
      runId: null,
      group: { inFlight: null, preparing: 'a', queued: [] }
    })

    live.mockReturnValue({ inFlight: null, preparing: null, queued: ['b'] })
    expect((await probe()).status).toBe(200)

    live.mockReturnValue({ inFlight: null, preparing: null, queued: [] })
    const idle = await probe()
    expect(idle.status).toBe(404)
    expect(await idle.json()).toEqual({ active: false })
    expect(live).toHaveBeenCalledWith(7)
  })
})
