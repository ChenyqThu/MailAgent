// L4 群聊 g1 — labs `groupAgents` OFF 的回归契约（AC9：off = v1 / v30 语义，字节级不变）。
//
// 钉三件事：
//   ① off（hook 返 off / hook 缺席 / hook 抛错）下 append 只落用户行，`orchestrated:false`，
//     不唤醒任何成员：零模型调用、零 turn 台账、零游标。
//   ② off 下 speaker 模式的 SSE 帧 / 持久化形状与 v30 逐字节一致；进模型的 system prompt 自 T4
//     （design M7）起与调度器 turn 同为减重态（无 memory.md / 技能名单 / connector 名单）+ 沉默契约，
//     与 buildGatewaySystemPrompt({groupSpeakerRun:true}) 逐字节相等；按契约回 [沉默] 的 turn 不落行。
//   ③ /api/ai/chat 不读任何群 / labs hook：labs on 与 off 的同一请求体 → 响应体 diff 为空。

import { describe, expect, test, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import type { AiGatewayConfig, GroupTurnInsert } from '../../src/ai-gateway/config'
import type { GroupTranscriptRow } from '../../src/ai-gateway/groupChat'
import { SILENCE_SENTINEL } from '../../src/ai-gateway/groupFloors'
import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import {
  buildGatewaySystemPrompt,
  type GatewaySystemPromptConfig
} from '../../src/ai-gateway/systemPrompt'

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 }
}

type MockDoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']

function okModel(captured: { options?: unknown } = {}, text = 'ok'): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (async (options: unknown) => {
      captured.options = options
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: '1' },
            { type: 'text-delta' as const, id: '1', delta: text },
            { type: 'text-end' as const, id: '1' },
            { type: 'finish' as const, finishReason: { unified: 'stop' as const }, usage: USAGE }
          ]
        })
      }
    }) as unknown as MockDoStream
  })
}

const RICH_PROMPT: GatewaySystemPromptConfig = {
  standingContext: 'STAND-CTX',
  memorySummary: 'MEMORY-LINE',
  trustedSkillFragments: 'FRAGMENT-LINE',
  skillCatalog: [
    {
      name: 'skill_x',
      title: 'Skill X',
      description: 'SKILL-X-DESC',
      enabled: true,
      available: true,
      unavailableReason: null
    }
  ]
}

const MEMBERS = [
  { agentId: 'agent_a', title: '调研员', duty: null, model: null },
  { agentId: 'agent_b', title: '跟进官', duty: '盯进展', model: 'member-model' }
]

interface StoredRow extends GroupTranscriptRow {
  sessionId: number
  metadata: string | null
}

interface World {
  config: AiGatewayConfig
  messages: StoredRow[]
  turns: GroupTurnInsert[]
  cursors: Map<string, number>
  captured: { options?: unknown }
  createModel: ReturnType<typeof vi.fn>
  resolveLabsFlags: ReturnType<typeof vi.fn>
}

/** The full g1 hook set (调度器 buildable) with labs in one of three OFF shapes, or ON. */
function world(labs: 'off' | 'absent' | 'throws' | 'on'): World {
  const messages: StoredRow[] = []
  const turns: GroupTurnInsert[] = []
  const cursors = new Map<string, number>()
  const captured: { options?: unknown } = {}
  let nextId = 1
  const createModel = vi.fn(() => okModel(captured))
  const resolveLabsFlags = vi.fn(async () => {
    if (labs === 'throws') throw new Error('labs unreachable')
    return { groupAgents: labs === 'on' }
  })
  const config: AiGatewayConfig = {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'gateway-default-model',
    createModel,
    systemPromptProvider: async () => RICH_PROMPT,
    activeRuns: new ActiveRunRegistry(),
    resolveGroupSession: (sessionId) =>
      sessionId === 7
        ? {
            members: MEMBERS,
            config: { v: 1 as const },
            modes: { agent_a: 'realtime', agent_b: 'realtime' },
            parentSessionId: null,
            childSessionIds: [],
            judgeScopeStale: false
          }
        : null,
    listGroupHistory: (sessionId) => messages.filter((m) => m.sessionId === sessionId),
    appendGroupMessage: (sessionId, message) => {
      const id = nextId++
      messages.push({
        sessionId,
        id,
        role: message.role,
        content: message.content,
        speakerAgentId: message.speakerAgentId,
        status: 'complete',
        chainId: message.chainId ?? null,
        via: null,
        createdAt: Date.now(),
        metadata: message.metadata ?? null
      })
      return id
    },
    getSeenCursor: (sessionId, agentId) => cursors.get(`${sessionId}:${agentId}`) ?? null,
    advanceSeenCursor: (sessionId, agentId, throughId) => {
      cursors.set(`${sessionId}:${agentId}`, throughId)
    },
    insertGroupTurn: (row) => turns.push(row),
    groupUsage: () => ({ turns: 0, tokens: 0, costUsd: null }),
    ...(labs === 'absent' ? {} : { resolveLabsFlags })
  }
  return { config, messages, turns, cursors, captured, createModel, resolveLabsFlags }
}

async function readSseFrames(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  return text
    .split('\n\n')
    .map((f) => f.replace(/^data: /, '').trim())
    .filter((f) => f.length > 0)
    .map((f) => JSON.parse(f) as Record<string, unknown>)
}

function systemPromptOf(captured: { options?: unknown }): string {
  const prompt = (captured.options as { prompt: Array<{ role: string; content: unknown }> }).prompt
  const system = prompt.find((m) => m.role === 'system')
  return typeof system?.content === 'string' ? system.content : ''
}

const handles: AiGatewayHandle[] = []
async function start(config: AiGatewayConfig): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(config)
  handles.push(h)
  return h
}
async function closeAll(): Promise<void> {
  while (handles.length) await handles.pop()!.close()
}

function postGroup(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/group-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('AC9 ① labs off — append 不唤醒任何成员', () => {
  test.each(['off', 'absent', 'throws'] as const)(
    'labs=%s：append → {ok,messageId,orchestrated:false}；两个 realtime 成员都不醒（零模型 / 零台账 / 零游标）',
    async (labs) => {
      const w = world(labs)
      const h = await start(w.config)
      try {
        const res = await postGroup(h.port, { sessionId: 7, userText: '大家汇报下' })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, messageId: 1, orchestrated: false })
        // 给足一个 MIN_TURN_GAP 还多：真要编排，这时候早就调过模型了。
        await new Promise((r) => setTimeout(r, 800))
        expect(w.messages.map((m) => m.role)).toEqual(['user'])
        expect(w.createModel).not.toHaveBeenCalled()
        expect(w.turns).toEqual([])
        expect(w.cursors.size).toBe(0)
      } finally {
        await closeAll()
      }
    }
  )
})

describe('AC9 ② labs off — speaker 模式：帧 / 持久化 == v30；prompt == 减重态（T4 M7）', () => {
  test('SSE 帧 / 持久化形状 == v30；system prompt == groupSpeakerRun:true 的 buildGatewaySystemPrompt（去四段 + 沉默契约）；不写 turn 台账', async () => {
    const w = world('off')
    w.config.appendGroupMessage!(7, { role: 'user', content: '大家汇报下', speakerAgentId: null })
    const h = await start(w.config)
    try {
      const res = await postGroup(h.port, { sessionId: 7, speakAsAgentId: 'agent_b' })
      expect(res.status).toBe(200)
      const frames = await readSseFrames(res)
      expect(frames.filter((f) => f.type === 'text-delta').map((f) => f.delta)).toEqual(['ok'])
      expect(frames[frames.length - 1]).toEqual({
        type: 'done',
        messageId: 2,
        content: 'ok',
        speakerAgentId: 'agent_b'
      })
      // 持久化形状 = v30 的四个字段，不多不少（无 token / cost / chain_id）。
      expect(w.messages[1]).toMatchObject({
        role: 'assistant',
        content: 'ok',
        speakerAgentId: 'agent_b',
        chainId: null,
        metadata: null
      })
      expect(w.createModel).toHaveBeenCalledWith('member-model')
      // 进模型的 system == 减重门开着的 buildGatewaySystemPrompt 输出（T4 M7：labs 两态一致）。
      const system = systemPromptOf(w.captured)
      expect(system).toBe(
        buildGatewaySystemPrompt({
          promptConfig: RICH_PROMPT,
          contextSnapshot: null,
          sessionAgentIdentity: {
            agentId: 'agent_b',
            agentTitle: '跟进官',
            duty: '盯进展',
            scheduleLine: null,
            group: { members: MEMBERS.map((m) => ({ agentId: m.agentId, title: m.title })) }
          },
          groupSpeakerRun: true
        })
      )
      expect(system).not.toContain('MEMORY-LINE')
      expect(system).not.toContain('SKILL-X-DESC')
      expect(system).toContain(SILENCE_SENTINEL)
      // v1 路径不经调度器：无台账、无游标。
      expect(w.turns).toEqual([])
      expect(w.cursors.size).toBe(0)
    } finally {
      await closeAll()
    }
  })

  test('T4 沉默契约的 v30 半边：模型回 [沉默] → 不落 assistant 行，done 帧 messageId=null', async () => {
    const w = world('off')
    w.createModel.mockImplementation(() => okModel(w.captured, SILENCE_SENTINEL))
    w.config.appendGroupMessage!(7, { role: 'user', content: '大家汇报下', speakerAgentId: null })
    const h = await start(w.config)
    try {
      const res = await postGroup(h.port, { sessionId: 7, speakAsAgentId: 'agent_a' })
      expect(res.status).toBe(200)
      const frames = await readSseFrames(res)
      expect(frames[frames.length - 1]).toEqual({
        type: 'done',
        messageId: null,
        content: SILENCE_SENTINEL,
        speakerAgentId: 'agent_a'
      })
      expect(w.messages.map((m) => m.role)).toEqual(['user'])
    } finally {
      await closeAll()
    }
  })
})

describe('AC9 ③ /api/ai/chat 与 labs 无关', () => {
  test('labs on / off 的同一请求体 → 响应体 diff 为空；labs 只进 buildTools 第 8 槽，不进响应', async () => {
    const on = world('on')
    const off = world('off')
    const hOn = await start(on.config)
    const hOff = await start(off.config)
    try {
      const body = JSON.stringify({
        sessionId: 7,
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }]
      })
      const post = (port: number): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        })
      const [resOn, resOff] = await Promise.all([post(hOn.port), post(hOff.port)])
      expect(resOn.status).toBe(200)
      expect(resOff.status).toBe(200)
      // 仅有的两处非确定项：每请求铸造的 assistant 消息 id（makeIdGenerator 带时间戳）与
      // finish 帧的墙钟 timing 元数据。两者都不是 labs 的函数。
      const normalize = (s: string): string =>
        s
          .replace(/asst-[0-9a-z]+-[0-9a-z]+/g, 'asst-X')
          .replace(/"timing":\{[^}]*\}/g, '"timing":{}')
      const [textOn, textOff] = await Promise.all([resOn.text(), resOff.text()])
      expect(textOn.length).toBeGreaterThan(0)
      expect(normalize(textOn)).toBe(normalize(textOff))
      // g2 — prepareChatRun 热读 labs 决定主 agent 版群工具的 `enabled`（buildTools 第 8 槽，
      // groups_assembly.test.ts AS4）；本 world 不接 buildTools，所以读了也不改响应一个字节。
      expect(on.resolveLabsFlags).toHaveBeenCalledTimes(1)
      expect(off.resolveLabsFlags).toHaveBeenCalledTimes(1)
      expect(on.turns).toEqual([])
      expect(off.turns).toEqual([])
    } finally {
      await closeAll()
    }
  })
})
