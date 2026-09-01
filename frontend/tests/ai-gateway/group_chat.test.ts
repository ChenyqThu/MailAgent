// L4 群聊 (CHAT_DB v30) — gateway 群聊发言 run 的行为契约。
//
// 钉五件事（任务规格 §2 + 验收 ②③④）：
//   ① 成员校验是**服务端事实**：POST /api/ai/group-chat 的 speakAsAgentId 必须 ∈ 服务端
//     resolveGroupSession 的 members（非成员 → 403 E_NOT_GROUP_MEMBER，零模型调用）；
//     非群聊 session → 400 E_NOT_GROUP；/api/ai/chat 从不读 body.speakAsAgentId（结构性忽略）。
//   ② 🔴 群聊发言 turn 恒零工具：identity.group 在场 → prepareChatRun 结构性跳过 buildTools
//     （变异验证：去掉 chatRun.ts 的 isGroupSpeakerRun 守卫，本用例必红）。
//   ③ 历史装配多人约定：自己的行 → assistant；其他成员/用户 → user role 带「[名字]」前缀，
//     连续 user 合并（assembleGroupHistory 纯函数单测 + 端点集成里进模型的 prompt）。
//   ④ 群聊语境块 <current_group_chat> 取代 <current_team_agent>（成员名单 + 不冒充他人）。
//   ⑤ 发言持久化带 speaker_agent_id（appendGroupMessage hook 收到 role assistant + speaker）。

import { describe, expect, test, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { ToolSet } from 'ai'

import { prepareChatRun } from '../../src/ai-gateway/chatRun'
import {
  GROUP_USER_LABEL,
  assembleGroupHistory,
  parseGroupMemberIds
} from '../../src/ai-gateway/groupChat'
import {
  buildGatewaySystemPrompt,
  buildGroupChatIdentityBlock
} from '../../src/ai-gateway/systemPrompt'
import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type {
  AiGatewayConfig,
  GroupHistoryRow,
  SessionAgentIdentity
} from '../../src/ai-gateway/config'

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 }
}

type MockDoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']

function capturingModel(captured: { options?: unknown }): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (async (options: unknown) => {
      captured.options = options
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: '1' },
            { type: 'text-delta' as const, id: '1', delta: 'ok' },
            { type: 'text-end' as const, id: '1' },
            { type: 'finish' as const, finishReason: { unified: 'stop' as const }, usage: USAGE }
          ]
        })
      }
    }) as unknown as MockDoStream
  })
}

function cfg(overrides: Partial<AiGatewayConfig> = {}): AiGatewayConfig {
  const captured: { options?: unknown } = {}
  return {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'gateway-default-model',
    createModel: () => capturingModel(captured),
    ...overrides
  }
}

const MESSAGES = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }]

const GROUP_IDENTITY: SessionAgentIdentity = {
  agentId: 'agent_b',
  agentTitle: '跟进官',
  duty: '盯住每条行动项的进展',
  model: 'member-model',
  scheduleLine: null,
  group: {
    members: [
      { agentId: 'agent_a', title: '调研员' },
      { agentId: 'agent_b', title: '跟进官' }
    ]
  }
}

describe('groupChat 纯函数', () => {
  test('parseGroupMemberIds — 容错口径：坏 JSON / 非数组 / 非字符串项全部收敛', () => {
    expect(parseGroupMemberIds('["a","b"]')).toEqual(['a', 'b'])
    expect(parseGroupMemberIds('not-json')).toEqual([])
    expect(parseGroupMemberIds('{"a":1}')).toEqual([])
    expect(parseGroupMemberIds('["a", 42, "", "b"]')).toEqual(['a', 'b'])
    expect(parseGroupMemberIds(null)).toEqual([])
  })

  test('③ assembleGroupHistory — 自己→assistant；他人/用户→带前缀 user；连续 user 合并', () => {
    const titles = new Map([
      ['agent_a', '调研员'],
      ['agent_b', '跟进官']
    ])
    const rows: GroupHistoryRow[] = [
      { role: 'user', content: '大家汇报下', speakerAgentId: null, status: 'complete' },
      { role: 'assistant', content: '调研进展如下', speakerAgentId: 'agent_a', status: 'complete' },
      { role: 'assistant', content: '我的跟进结论', speakerAgentId: 'agent_b', status: 'complete' },
      { role: 'assistant', content: '坏行不进模型', speakerAgentId: 'agent_a', status: 'error' },
      { role: 'user', content: '继续', speakerAgentId: null, status: 'complete' }
    ]
    const messages = assembleGroupHistory(rows, 'agent_b', titles)
    // [user 大家汇报下 + [调研员]调研进展如下（连续 user 合并）] → [assistant 我的跟进结论] → [user 继续]
    expect(messages).toHaveLength(3)
    expect(messages[0]?.role).toBe('user')
    const merged = (messages[0]?.parts[0] as { text: string }).text
    expect(merged).toBe(`[${GROUP_USER_LABEL}] 大家汇报下\n\n[调研员] 调研进展如下`)
    expect(messages[1]?.role).toBe('assistant')
    expect((messages[1]?.parts[0] as { text: string }).text).toBe('我的跟进结论')
    expect(messages[2]?.role).toBe('user')
    expect((messages[2]?.parts[0] as { text: string }).text).toBe(`[${GROUP_USER_LABEL}] 继续`)
  })
})

describe('④ <current_group_chat> 群聊语境块', () => {
  test('unit — 含自我身份 + 成员名单 + 发言纪律；duty 条件句', () => {
    const block = buildGroupChatIdentityBlock({
      agentId: 'agent_b',
      agentTitle: '跟进官',
      duty: '盯进展',
      group: GROUP_IDENTITY.group!
    })
    expect(block).toContain('<current_group_chat>')
    expect(block).toContain('<self_id>agent_b</self_id>')
    expect(block).toContain('<members>调研员、跟进官</members>')
    expect(block).toContain('不要冒充或代替其他成员发言')
    expect(block).toContain('仅作背景参考')
    const bare = buildGroupChatIdentityBlock({
      agentId: 'x',
      agentTitle: 'X',
      group: { members: [{ agentId: 'x', title: 'X' }] }
    })
    expect(bare).not.toContain('<duty>')
  })

  test('unit — buildGatewaySystemPrompt：group 身份渲染群块、不渲染 team 块；无 group 走 team 块', () => {
    const grouped = buildGatewaySystemPrompt({
      promptConfig: { standingContext: 'STAND' },
      contextSnapshot: null,
      sessionAgentIdentity: GROUP_IDENTITY
    })
    expect(grouped).toContain('<current_group_chat>')
    expect(grouped).not.toContain('<current_team_agent>')
    const team = buildGatewaySystemPrompt({
      promptConfig: { standingContext: 'STAND' },
      contextSnapshot: null,
      sessionAgentIdentity: { ...GROUP_IDENTITY, group: null }
    })
    expect(team).toContain('<current_team_agent>')
    expect(team).not.toContain('<current_group_chat>')
  })
})

describe('🔴 ② 群聊发言 turn 恒零工具（prepareChatRun 结构守卫）', () => {
  test('group 身份 → buildTools 不被调用、toolNames 空；无 group 身份（对照，防恒绿）→ 调用', async () => {
    const buildTools = vi.fn<NonNullable<AiGatewayConfig['buildTools']>>(
      (): ToolSet => ({ some_tool: {} as ToolSet[string] })
    )
    const grouped = await prepareChatRun(
      { messages: MESSAGES },
      cfg({ buildTools }),
      new AbortController().signal,
      'manual_chat',
      GROUP_IDENTITY
    )
    expect(grouped.ok).toBe(true)
    if (grouped.ok) expect(grouped.run.toolNames).toEqual([])
    expect(buildTools).not.toHaveBeenCalled()

    const teamOnly = await prepareChatRun(
      { messages: MESSAGES },
      cfg({ buildTools }),
      new AbortController().signal,
      'manual_chat',
      { ...GROUP_IDENTITY, group: null }
    )
    expect(teamOnly.ok).toBe(true)
    expect(buildTools).toHaveBeenCalledTimes(1)
  })
})

// ── 端点集成 ─────────────────────────────────────────────────────────────────

async function readSseFrames(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  return text
    .split('\n\n')
    .map((f) => f.replace(/^data: /, '').trim())
    .filter((f) => f.length > 0)
    .map((f) => JSON.parse(f) as Record<string, unknown>)
}

describe('POST /api/ai/group-chat（服务端成员校验 + 发言 run）', () => {
  const handles: AiGatewayHandle[] = []
  async function start(config: AiGatewayConfig): Promise<AiGatewayHandle> {
    const h = await startAiGatewayServer(config)
    handles.push(h)
    return h
  }
  async function closeAll(): Promise<void> {
    while (handles.length) await handles.pop()!.close()
  }

  function groupHooks(overrides: Partial<AiGatewayConfig> = {}): {
    appended: Array<{ sessionId: number; message: Record<string, unknown> }>
    config: AiGatewayConfig
    captured: { options?: unknown }
  } {
    const appended: Array<{ sessionId: number; message: Record<string, unknown> }> = []
    const captured: { options?: unknown } = {}
    const config = cfg({
      createModel: () => capturingModel(captured),
      systemPromptProvider: async () => ({ standingContext: 'STAND' }),
      resolveGroupSession: (sessionId) =>
        sessionId === 7
          ? {
              members: [
                { agentId: 'agent_a', title: '调研员', duty: null, model: null },
                { agentId: 'agent_b', title: '跟进官', duty: '盯进展', model: 'member-model' }
              ]
            }
          : null,
      listGroupHistory: () => [
        { role: 'user', content: '大家汇报下', speakerAgentId: null, status: 'complete' },
        { role: 'assistant', content: '调研进展', speakerAgentId: 'agent_a', status: 'complete' }
      ],
      appendGroupMessage: (sessionId, message) => {
        appended.push({ sessionId, message: message as unknown as Record<string, unknown> })
        return 99
      },
      ...overrides
    })
    return { appended, config, captured }
  }

  test('hooks 缺席 → 404（哨兵：群聊面未接线的 cfg 不暴露端点）', async () => {
    const h = await start(cfg())
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/group-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 7, speakAsAgentId: 'agent_b' })
      })
      expect(res.status).toBe(404)
    } finally {
      await closeAll()
    }
  })

  test('① 非群聊 session → 400 E_NOT_GROUP；非成员 → 403 E_NOT_GROUP_MEMBER 且零模型调用', async () => {
    const createModel = vi.fn(() => capturingModel({}))
    const { config, appended } = groupHooks({ createModel })
    const h = await start(config)
    try {
      const notGroup = await fetch(`http://127.0.0.1:${h.port}/api/ai/group-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 8, speakAsAgentId: 'agent_b' })
      })
      expect(notGroup.status).toBe(400)
      expect(((await notGroup.json()) as { error: string }).error).toBe('E_NOT_GROUP')

      const outsider = await fetch(`http://127.0.0.1:${h.port}/api/ai/group-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 7, speakAsAgentId: 'agent_evil' })
      })
      expect(outsider.status).toBe(403)
      expect(((await outsider.json()) as { error: string }).error).toBe('E_NOT_GROUP_MEMBER')
      expect(createModel).not.toHaveBeenCalled()
      expect(appended).toHaveLength(0)
    } finally {
      await closeAll()
    }
  })

  test('userText 模式 — 落用户消息（speaker NULL），不跑模型', async () => {
    const createModel = vi.fn(() => capturingModel({}))
    const { config, appended } = groupHooks({ createModel })
    const h = await start(config)
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/group-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 7, userText: '新消息' })
      })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { messageId: number }).messageId).toBe(99)
      expect(appended).toEqual([
        {
          sessionId: 7,
          message: { role: 'user', content: '新消息', speakerAgentId: null }
        }
      ])
      expect(createModel).not.toHaveBeenCalled()
    } finally {
      await closeAll()
    }
  })

  test('⑤ 成员发言 run — SSE 流式 + 持久化带 speaker + 成员 model 优先 + 群块/前缀历史进模型', async () => {
    const groupHooksRef = groupHooks()
    const createModel = vi.fn(() => capturingModel(groupHooksRef.captured))
    const config = { ...groupHooksRef.config, createModel }
    const h = await start(config)
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/group-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ sessionId: 7, speakAsAgentId: 'agent_b' })
      })
      expect(res.ok).toBe(true)
      const frames = await readSseFrames(res)
      const deltas = frames.filter((f) => f.type === 'text-delta')
      expect(deltas.map((f) => f.delta).join('')).toBe('ok')
      const done = frames.find((f) => f.type === 'done')
      expect(done).toMatchObject({ messageId: 99, content: 'ok', speakerAgentId: 'agent_b' })
      // 持久化：assistant + speaker_agent_id + 成员 model。
      expect(groupHooksRef.appended).toEqual([
        {
          sessionId: 7,
          message: {
            role: 'assistant',
            content: 'ok',
            speakerAgentId: 'agent_b',
            model: 'member-model'
          }
        }
      ])
      // model 中层优先级：body 无 model → 用成员行 model。
      expect(createModel).toHaveBeenCalledWith('member-model')
      // 进模型的 system 含群块；prompt 历史带「[名字]」前缀 user 装配。
      const wire = JSON.stringify(groupHooksRef.captured.options)
      expect(wire).toContain('<current_group_chat>')
      expect(wire).not.toContain('<current_team_agent>')
      expect(wire).toContain(`[${GROUP_USER_LABEL}] 大家汇报下`)
      expect(wire).toContain('[调研员] 调研进展')
    } finally {
      await closeAll()
    }
  })

  test('① /api/ai/chat 结构性忽略 body.speakAsAgentId（origin!==group 语义零变化）', async () => {
    const resolveGroupSession = vi.fn(() => null)
    const createModel = vi.fn(() => capturingModel({}))
    const h = await start(cfg({ createModel, resolveGroupSession }))
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: MESSAGES, speakAsAgentId: 'agent_evil' })
      })
      expect(res.ok).toBe(true)
      await res.text() // drain
      // 主 chat 路径既不解析该字段、也不触碰群聊 resolver；模型走默认。
      expect(resolveGroupSession).not.toHaveBeenCalled()
      expect(createModel).toHaveBeenCalledWith('gateway-default-model')
    } finally {
      await closeAll()
    }
  })
})
