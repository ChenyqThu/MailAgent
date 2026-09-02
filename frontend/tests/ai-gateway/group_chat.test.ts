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
  GROUP_MAIN_AGENT_LABEL,
  GROUP_MENTION_ALL_TOKENS,
  GROUP_USER_LABEL,
  assembleGroupHistory,
  buildGroupWindow,
  isChainRootRow,
  parseGroupMemberIds,
  parseGroupMentions,
  type GroupTranscriptRow
} from '../../src/ai-gateway/groupChat'
import {
  MAIN_AGENT_MEMBER_ID,
  SILENCE_SENTINEL,
  isSilence,
  normalizeForDup
} from '../../src/ai-gateway/groupFloors'
import {
  buildCurrentDateBlock,
  buildGatewaySystemPrompt,
  buildGroupChatIdentityBlock,
  buildTeamAgentIdentityBlock,
  executionDisciplineFor,
  type GatewaySystemPromptConfig
} from '../../src/ai-gateway/systemPrompt'
import {
  buildStableSystemPrompt,
  type ChatModelConfig
} from '../../src/ai-gateway/prompts/stable_prompt'
import type { GroupAttachment } from '../../src/shared/chat_model'
import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type {
  AiGatewayConfig,
  GroupHistoryRow,
  GroupTurnInsert,
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

// ── g1：窗口 / 链根 / via 标签 / 哨兵 / mentions 下沉 ─────────────────────────────

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
    chainId: role === 'user' ? id : 1,
    via: null,
    createdAt: id * 1000,
    ...extra
  }
}

describe('g1 groupChat 纯函数', () => {
  test('parseGroupMentions 下沉后语义不变：@显示名 → 成员序输出、边界判定、未知名不命中', () => {
    const members = [
      { agentId: 'a', title: '调研员' },
      { agentId: 'b', title: '跟进官' },
      { agentId: 'c', title: 'agent1' }
    ]
    expect(parseGroupMentions('大家汇报下', members)).toEqual([])
    expect(parseGroupMentions('@跟进官 然后 @调研员 补充', members)).toEqual(['a', 'b'])
    expect(parseGroupMentions('@agent1x 你好', members)).toEqual([])
    expect(parseGroupMentions('@agent1，你好', members)).toEqual(['c'])
    expect(parseGroupMentions('@路人甲', members)).toEqual([])
  })

  test('assembleGroupHistory — via=main_agent 的 user 行标 [主助理]，普通 user 行仍标 [用户]', () => {
    const titles = new Map([['agent_a', '调研员']])
    const messages = assembleGroupHistory(
      [
        row(1, 'user', '主 agent 转来的任务', null, { via: 'main_agent' }),
        row(2, 'assistant', '收到', 'agent_a'),
        row(3, 'user', '再补充一句')
      ],
      'agent_b',
      titles
    )
    expect(messages).toHaveLength(1)
    expect((messages[0]?.parts[0] as { text: string }).text).toBe(
      `[${GROUP_MAIN_AGENT_LABEL}] 主 agent 转来的任务\n\n[调研员] 收到\n\n[${GROUP_USER_LABEL}] 再补充一句`
    )
  })

  test('T4 assembleGroupHistory — speakAs=main：自己的行走 assistant，他人行走 [名字]；别人视角里它是 [名字]', () => {
    const titles = new Map([
      ['agent_a', '调研员'],
      [MAIN_AGENT_MEMBER_ID, '小助']
    ])
    const rows = [
      row(1, 'user', '大家汇报下'),
      row(2, 'assistant', '我先说', MAIN_AGENT_MEMBER_ID),
      row(3, 'assistant', '收到', 'agent_a'),
      // 主 agent 从单聊投递的行（保留字不是它的 speaker）仍按 via 标 [主助理]
      row(4, 'user', '单聊转来的', null, { via: 'main_agent' })
    ]
    const own = assembleGroupHistory(rows, MAIN_AGENT_MEMBER_ID, titles)
    expect(own.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect((own[1]?.parts[0] as { text: string }).text).toBe('我先说')
    expect((own[2]?.parts[0] as { text: string }).text).toBe(
      `[调研员] 收到\n\n[${GROUP_MAIN_AGENT_LABEL}] 单聊转来的`
    )
    const other = assembleGroupHistory(rows.slice(0, 2), 'agent_a', titles)
    expect(other).toHaveLength(1)
    expect((other[0]?.parts[0] as { text: string }).text).toBe(
      `[${GROUP_USER_LABEL}] 大家汇报下\n\n[小助] 我先说`
    )
  })

  test('isChainRootRow — user 行是根；带 chain_id 的成员回复不是；无 chain_id 的遗留行按根处理', () => {
    expect(isChainRootRow(row(1, 'user', 'x'))).toBe(true)
    expect(isChainRootRow(row(2, 'assistant', 'x', 'a', { chainId: 1 }))).toBe(false)
    expect(isChainRootRow(row(3, 'assistant', 'x', 'a', { chainId: null }))).toBe(true)
    expect(isChainRootRow(row(4, 'assistant', 'x', 'a', { chainId: 4 }))).toBe(true)
  })

  test('buildGroupWindow — 首轮（游标空）= 最后 maxRows 行；othersNew 不含自己的行', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row(i + 1, i % 2 === 0 ? 'user' : 'assistant', `m${i + 1}`, i % 2 === 0 ? null : 'a')
    )
    const w = buildGroupWindow(rows, 'b', null)
    expect(w.rows).toHaveLength(40)
    expect(w.fromId).toBe(11)
    expect(w.toId).toBe(50)
    expect(w.maxId).toBe(50)
    expect(w.othersNew).toHaveLength(50)
    // 自己的行不算「他人新消息」。
    const own = buildGroupWindow(rows, 'a', null)
    expect(own.othersNew.every((r) => r.speakerAgentId !== 'a')).toBe(true)
    expect(own.othersNew).toHaveLength(25)
  })

  test('buildGroupWindow — 游标之后的行 ∪ 之前尾部 tail 行；othersNew 只看 id > 游标', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, 'user', `m${i + 1}`))
    const w = buildGroupWindow(rows, 'a', 15, { tail: 3, maxRows: 40, maxChars: 12_000 })
    expect(w.rows.map((r) => r.id)).toEqual([13, 14, 15, 16, 17, 18, 19, 20])
    expect(w.othersNew.map((r) => r.id)).toEqual([16, 17, 18, 19, 20])
    // 游标已到最新 → 无他人新消息，但尾部仍给上下文。
    const stale = buildGroupWindow(rows, 'a', 20, { tail: 3, maxRows: 40, maxChars: 12_000 })
    expect(stale.othersNew).toEqual([])
    expect(stale.rows.map((r) => r.id)).toEqual([18, 19, 20])
  })

  test('buildGroupWindow — 从旧端裁剪（行数 / 字符），保新弃旧', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, 'user', 'x'.repeat(100)))
    const byRows = buildGroupWindow(rows, 'a', null, { tail: 6, maxRows: 4, maxChars: 12_000 })
    expect(byRows.rows.map((r) => r.id)).toEqual([7, 8, 9, 10])
    const byChars = buildGroupWindow(rows, 'a', null, { tail: 6, maxRows: 40, maxChars: 250 })
    expect(byChars.rows.map((r) => r.id)).toEqual([9, 10])
  })

  test('buildGroupWindow — 首条若是本人 assistant 行则丢到首条为 user；system / 非 complete 行不进窗口', () => {
    const rows = [
      row(1, 'assistant', '我先说', 'a', { chainId: 1 }),
      row(2, 'assistant', '我再说', 'a', { chainId: 1 }),
      row(3, 'system', 'chain_cap'),
      row(4, 'user', '人类插话'),
      row(5, 'assistant', '坏行', 'b', { status: 'error' }),
      row(6, 'assistant', '别人说', 'b')
    ]
    const w = buildGroupWindow(rows, 'a', null)
    expect(w.rows.map((r) => r.id)).toEqual([4, 6])
    expect(w.othersNew.map((r) => r.id)).toEqual([4, 6])
    expect(w.maxId).toBe(6)
  })

  test('isSilence — 空串 / 哨兵 / 哨兵+短尾巴 = 沉默；哨兵+长文 / 普通文本 ≠ 沉默', () => {
    expect(isSilence('')).toBe(true)
    expect(isSilence('   \n')).toBe(true)
    expect(isSilence(SILENCE_SENTINEL)).toBe(true)
    expect(isSilence(`  ${SILENCE_SENTINEL}（无需补充）`)).toBe(true)
    expect(
      isSilence(`${SILENCE_SENTINEL} 但我还是想说一句很长很长很长很长很长的话，超过二十个字符`)
    ).toBe(false)
    expect(isSilence('我有话说')).toBe(false)
    expect(isSilence(`我先说一句 ${SILENCE_SENTINEL}`)).toBe(false)
  })

  test('normalizeForDup — 去空白 / 标点 / 符号 + 小写，逐字重复判定不受排版影响', () => {
    expect(normalizeForDup('同意，按 A 方案推进！')).toBe(normalizeForDup('同意 按a方案推进'))
    expect(normalizeForDup('Hello, World!')).toBe('helloworld')
    expect(normalizeForDup('同意')).not.toBe(normalizeForDup('不同意'))
  })
})

// ── T2 群附件：装配前置围栏块 + 窗口字符预算 ─────────────────────────────────────────

describe('T2 群附件', () => {
  const DOC: GroupAttachment = {
    filename: '周报.md',
    size: 1024,
    mimeType: 'text/markdown',
    text: '本周完成三件事'
  }

  test('带附件的 user 行：围栏块前置进该行正文，每个候选成员都看得到（D10）', () => {
    const messages = assembleGroupHistory(
      [
        row(1, 'user', '看下这份周报', null, { attachments: [DOC] }),
        row(2, 'assistant', '好的', 'agent_a')
      ],
      'agent_b',
      new Map([['agent_a', '调研员']])
    )
    const text = (messages[0]?.parts[0] as { text: string }).text
    // 标签在最前（块属于这位说话人的这条消息），随后才是不可信内容围栏。
    expect(text.startsWith(`[${GROUP_USER_LABEL}] [Attached files`)).toBe(true)
    expect(text).toContain('[附件 周报.md · 1.0 KB]')
    expect(text).toContain('本周完成三件事')
    // 用户自己打的字在块之后，没被块吃掉。
    expect(text).toContain('---\n\n看下这份周报')
  })

  test('没有 attachments 的行与改动前逐字节相同（无附件路径零影响）', () => {
    const messages = assembleGroupHistory([row(1, 'user', '看下这份周报')], 'agent_b', new Map())
    expect((messages[0]?.parts[0] as { text: string }).text).toBe(
      `[${GROUP_USER_LABEL}] 看下这份周报`
    )
  })

  test('窗口字符预算算上附件正文：长附件把老行挤出去，而不是悄悄撑爆预算', () => {
    const limits = { tail: 6, maxRows: 40, maxChars: 450 }
    const withDoc = buildGroupWindow(
      [
        row(1, 'user', 'a'.repeat(100)),
        row(2, 'user', 'b'.repeat(100)),
        row(3, 'user', 'c', null, { attachments: [{ ...DOC, text: 'z'.repeat(400) }] })
      ],
      'agent_b',
      null,
      limits
    )
    expect(withDoc.rows.map((r) => r.id)).toEqual([3])
    // 对照（防恒绿）：同样三行、附件正文若不计入，100+100+1 远在预算内 → 三行全留。
    const withoutDoc = buildGroupWindow(
      [row(1, 'user', 'a'.repeat(100)), row(2, 'user', 'b'.repeat(100)), row(3, 'user', 'c')],
      'agent_b',
      null,
      limits
    )
    expect(withoutDoc.rows.map((r) => r.id)).toEqual([1, 2, 3])
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
    // T4 (design M6) — 同一个 identity.group 判据还要传下去：PreparedChatRun.groupSpeakerRun 是
    // makePersistOnFinish 跳过 memory 捕获的唯一依据。断在这里而不是只断 makePersistOnFinish，
    // 是因为那边的用例自己造 run 对象 —— 接线断了它照样绿。
    if (grouped.ok) expect(grouped.run.groupSpeakerRun).toBe(true)

    const teamOnly = await prepareChatRun(
      { messages: MESSAGES },
      cfg({ buildTools }),
      new AbortController().signal,
      'manual_chat',
      { ...GROUP_IDENTITY, group: null }
    )
    expect(teamOnly.ok).toBe(true)
    expect(buildTools).toHaveBeenCalledTimes(1)
    if (teamOnly.ok) expect(teamOnly.run.groupSpeakerRun).toBe(false)
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
              ],
              config: { v: 1 as const },
              modes: {},
              parentSessionId: null,
              childSessionIds: [],
              judgeScopeStale: false
            }
          : null,
      listGroupHistory: () => [
        row(1, 'user', '大家汇报下'),
        row(2, 'assistant', '调研进展', 'agent_a', { chainId: 1 })
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

  test('T2 附件 — append 带 attachments → 落 metadata.attachments（上一条用例反过来钉住无附件时不多写 metadata 键）', async () => {
    const { config, appended } = groupHooks()
    const h = await start(config)
    const file = { filename: 'a.md', size: 12, mimeType: 'text/markdown', text: 'hi' }
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/group-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 7, userText: '看下这个', attachments: [file] })
      })
      expect(res.status).toBe(200)
      expect(appended).toHaveLength(1)
      const message = appended[0]!.message
      expect(message.content).toBe('看下这个')
      expect(JSON.parse(message.metadata as string)).toEqual({ attachments: [file] })
    } finally {
      await closeAll()
    }
  })

  test('T2 附件 — 超条数上限 / 形状不合格 / 非数组 → 400 E_INVALID_ARG 且一行都不落', async () => {
    const { config, appended } = groupHooks()
    const h = await start(config)
    const file = { filename: 'a.md', size: 12, mimeType: 'text/markdown', text: 'hi' }
    const post = async (attachments: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${h.port}/api/ai/group-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 7, userText: '看下这个', attachments })
      })
    try {
      for (const bad of [
        Array.from({ length: 7 }, () => file),
        [file, { size: 3 }],
        'not-an-array'
      ]) {
        const res = await post(bad)
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toBe('E_INVALID_ARG')
      }
      // 🔴 写侧不静默丢：拒了就一行都不落（落一半再报错才是最难查的）。
      expect(appended).toHaveLength(0)
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

// ── g1：groupSpeakerRun 减重门（父设计拍板 D）─────────────────────────────────────
// 三条既有路径（主 agent / headless / team）参数缺省 = groupSpeakerRun:false 字节不变；
// 群 speaker 路径去 skill fragments / skill 目录 / connector 目录 / memory 四段 + 加沉默契约。

const RICH_PROMPT: GatewaySystemPromptConfig = {
  standingContext: 'STAND-CTX',
  userContext: 'USER-CTX',
  memorySummary: 'MEMORY-LINE',
  kosConfigured: true,
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
  ],
  connectorCatalog: [
    {
      connectorId: 'conn_x',
      displayName: 'CONN-X',
      readToolCount: 1,
      writeToolCount: 0,
      updateToolCount: 0
    }
  ]
}
const WEIGHT_MARKERS = ['MEMORY-LINE', 'FRAGMENT-LINE', 'SKILL-X-DESC', 'CONN-X']

/** The stable prefix buildGatewaySystemPrompt derives from RICH_PROMPT, with per-path nulls. */
function stableFor(overrides: Partial<ChatModelConfig>): string {
  const full: ChatModelConfig = {
    defaultModel: '',
    kosConsumerEnabled: false,
    kosConfigured: true,
    kosL1HotBlockEnabled: false,
    userContext: 'USER-CTX',
    memorySummary: 'MEMORY-LINE',
    skillFragments: 'FRAGMENT-LINE',
    skillCatalog: RICH_PROMPT.skillCatalog!,
    connectorCatalog: RICH_PROMPT.connectorCatalog!,
    standingContext: 'STAND-CTX',
    ...overrides
  }
  return buildStableSystemPrompt(null, full, () => null)
}

describe('g1 groupSpeakerRun 减重门', () => {
  const TEAM_IDENTITY: SessionAgentIdentity = { ...GROUP_IDENTITY, group: null }
  const HEADLESS = { agentId: 'h', agentTitle: 'H', jobId: 1, sessionId: 2 }

  test('主 agent / headless / team 三条路径：参数缺省 == groupSpeakerRun:false，字节不变且四段仍在', () => {
    const date = buildCurrentDateBlock(null)
    const cases: Array<{
      args: Parameters<typeof buildGatewaySystemPrompt>[0]
      expected: string
      keeps: string[]
    }> = [
      {
        args: { promptConfig: RICH_PROMPT, contextSnapshot: null },
        expected: [stableFor({}), executionDisciplineFor(false), date].join('\n\n'),
        keeps: WEIGHT_MARKERS
      },
      {
        args: {
          promptConfig: RICH_PROMPT,
          contextSnapshot: null,
          headlessAgentRun: true,
          headlessAgentIdentity: HEADLESS
        },
        expected: [
          stableFor({ skillFragments: null, skillCatalog: null }),
          `<current_custom_agent>\n  <id>h</id>\n  <title>H</title>\n  <job_id>1</job_id>\n  <session_id>2</session_id>\n</current_custom_agent>`,
          executionDisciplineFor(true),
          date
        ].join('\n\n'),
        keeps: ['MEMORY-LINE', 'CONN-X']
      },
      {
        args: {
          promptConfig: RICH_PROMPT,
          contextSnapshot: null,
          sessionAgentIdentity: TEAM_IDENTITY
        },
        expected: [
          stableFor({}),
          buildTeamAgentIdentityBlock(TEAM_IDENTITY),
          executionDisciplineFor(false),
          date
        ].join('\n\n'),
        keeps: WEIGHT_MARKERS
      }
    ]
    for (const c of cases) {
      const out = buildGatewaySystemPrompt(c.args)
      expect(out).toBe(c.expected)
      expect(buildGatewaySystemPrompt({ ...c.args, groupSpeakerRun: false })).toBe(out)
      for (const marker of c.keeps) expect(out).toContain(marker)
      expect(out).not.toContain(SILENCE_SENTINEL)
    }
  })

  test('群 speaker 路径：去四段 + 沉默契约；v30 群路径（无门，labs off 的 renderer 驱动）字节不变', () => {
    const date = buildCurrentDateBlock(null)
    const speaker = buildGatewaySystemPrompt({
      promptConfig: RICH_PROMPT,
      contextSnapshot: null,
      sessionAgentIdentity: GROUP_IDENTITY,
      groupSpeakerRun: true
    })
    expect(speaker).toBe(
      [
        stableFor({
          memorySummary: null,
          skillFragments: null,
          skillCatalog: null,
          connectorCatalog: null
        }),
        buildGroupChatIdentityBlock({
          ...GROUP_IDENTITY,
          group: GROUP_IDENTITY.group!,
          silenceContract: true
        }),
        executionDisciplineFor(false),
        date
      ].join('\n\n')
    )
    for (const marker of WEIGHT_MARKERS) expect(speaker).not.toContain(marker)
    expect(speaker).toContain('STAND-CTX')
    expect(speaker).toContain('USER-CTX')
    expect(speaker).toContain(`若这轮无需你发言，只回复 ${SILENCE_SENTINEL}。`)

    const v30 = buildGatewaySystemPrompt({
      promptConfig: RICH_PROMPT,
      contextSnapshot: null,
      sessionAgentIdentity: GROUP_IDENTITY
    })
    expect(v30).toBe(
      [
        stableFor({}),
        buildGroupChatIdentityBlock({ ...GROUP_IDENTITY, group: GROUP_IDENTITY.group! }),
        executionDisciplineFor(false),
        date
      ].join('\n\n')
    )
    for (const marker of WEIGHT_MARKERS) expect(v30).toContain(marker)
    expect(v30).not.toContain(SILENCE_SENTINEL)
  })

  test('buildGroupChatIdentityBlock — gameSecret 参数位（g3）：给了才渲染 <game_secret>，且转义', () => {
    const base = {
      agentId: 'x',
      agentTitle: 'X',
      group: { members: [{ agentId: 'x', title: 'X' }] }
    }
    expect(buildGroupChatIdentityBlock(base)).not.toContain('<game_secret>')
    expect(buildGroupChatIdentityBlock({ ...base, gameSecret: '  ' })).not.toContain(
      '<game_secret>'
    )
    expect(buildGroupChatIdentityBlock({ ...base, gameSecret: '你是狼人 <队友: Y>' })).toContain(
      '  <game_secret>你是狼人 &lt;队友: Y&gt;</game_secret>'
    )
  })
})

// ── g1：labs on 编排接线（§5.9）────────────────────────────────────────────────

/** Deterministic text model whose reply text is read per call (distinct replies dodge held_dup). */
function textModel(
  nextText: () => string,
  captured: { options?: unknown } = {}
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (async (options: unknown) => {
      captured.options = options
      const text = nextText()
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

/** A model that never answers until the run's abort signal fires (then rejects). */
function hangingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: ((options: { abortSignal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener(
          'abort',
          () => reject(new Error('aborted by /run/stop')),
          { once: true }
        )
      })) as unknown as MockDoStream
  })
}

interface StoredRow extends GroupTranscriptRow {
  sessionId: number
  model: string | null
  tokensInput: number | null
  tokensOutput: number | null
  costUsd: number | null
  metadata: string | null
}

interface GroupStore {
  messages: StoredRow[]
  turns: GroupTurnInsert[]
  cursors: Map<string, number>
}

/** The full g1 hook set over an in-memory store (session 7 = the group; everything else → null). */
function orchestratedHooks(opts: {
  modes: Record<string, 'realtime' | 'mention'>
  createModel: NonNullable<AiGatewayConfig['createModel']>
  labs?: boolean | 'absent' | 'throws'
  promptConfig?: GatewaySystemPromptConfig
}): {
  config: AiGatewayConfig
  store: GroupStore
  registry: ActiveRunRegistry
  resolveLabsFlags: ReturnType<typeof vi.fn>
} {
  const store: GroupStore = { messages: [], turns: [], cursors: new Map() }
  let nextId = 1
  const registry = new ActiveRunRegistry()
  const resolveLabsFlags = vi.fn(async () => {
    if (opts.labs === 'throws') throw new Error('labs unreachable')
    return { groupAgents: opts.labs !== false }
  })
  const config = cfg({
    createModel: opts.createModel,
    systemPromptProvider: async () => opts.promptConfig ?? { standingContext: 'STAND' },
    activeRuns: registry,
    resolveGroupSession: (sessionId) =>
      sessionId === 7
        ? {
            members: [
              { agentId: 'agent_a', title: '调研员', duty: null, model: null },
              { agentId: 'agent_b', title: '跟进官', duty: '盯进展', model: 'member-model' }
            ],
            config: { v: 1 as const },
            modes: opts.modes,
            parentSessionId: null,
            childSessionIds: [],
            judgeScopeStale: false
          }
        : null,
    listGroupHistory: (sessionId) => store.messages.filter((m) => m.sessionId === sessionId),
    appendGroupMessage: (sessionId, message) => {
      const id = nextId++
      store.messages.push({
        sessionId,
        id,
        role: message.role,
        content: message.content,
        speakerAgentId: message.speakerAgentId,
        status: 'complete',
        chainId: message.chainId ?? null,
        via: null,
        createdAt: Date.now(),
        model: message.model ?? null,
        tokensInput: message.tokensInput ?? null,
        tokensOutput: message.tokensOutput ?? null,
        costUsd: message.costUsd ?? null,
        metadata: message.metadata ?? null
      })
      return id
    },
    getSeenCursor: (sessionId, agentId) => store.cursors.get(`${sessionId}:${agentId}`) ?? null,
    advanceSeenCursor: (sessionId, agentId, throughId) => {
      store.cursors.set(`${sessionId}:${agentId}`, throughId)
    },
    insertGroupTurn: (row) => store.turns.push(row),
    groupUsage: (sessionIds, sinceMs) => {
      const rows = store.turns.filter(
        (t) => sessionIds.includes(t.sessionId) && t.startedAt >= sinceMs
      )
      return {
        turns: rows.length,
        tokens: rows.reduce((n, t) => n + (t.tokensInput ?? 0) + (t.tokensOutput ?? 0), 0),
        costUsd: null
      }
    },
    ...(opts.labs === 'absent' ? {} : { resolveLabsFlags })
  })
  return { config, store, registry, resolveLabsFlags }
}

async function waitFor(pred: () => boolean, timeoutMs = 8_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

function postGroup(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/group-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('g1 — labs on：append 即应答、链 detached、/run/active、/run/stop、token 透传、守恒', () => {
  const handles: AiGatewayHandle[] = []
  async function start(config: AiGatewayConfig): Promise<AiGatewayHandle> {
    const h = await startAiGatewayServer(config)
    handles.push(h)
    return h
  }
  async function closeAll(): Promise<void> {
    while (handles.length) await handles.pop()!.close()
  }

  test('append：先应答 {ok,messageId,orchestrated:true}，链在 res.end 后继续；token / chain_id 透传到 appendGroupMessage（AC2 / AC6）', async () => {
    const captured: { options?: unknown } = {}
    const createModel = vi.fn(() => textModel(() => 'ok', captured))
    const { config, store } = orchestratedHooks({
      modes: { agent_a: 'realtime' },
      createModel,
      promptConfig: RICH_PROMPT
    })
    const h = await start(config)
    try {
      const res = await postGroup(h.port, { sessionId: 7, userText: '大家汇报下' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, messageId: 1, orchestrated: true })
      // 应答时刻只有用户行：成员 turn 在 MIN_TURN_GAP 之后才起跑，链不挂 req。
      expect(store.messages.map((m) => m.role)).toEqual(['user'])
      expect(createModel).not.toHaveBeenCalled()

      await waitFor(() => store.turns.length >= 1)
      const reply = store.messages.find((m) => m.role === 'assistant')
      expect(reply).toMatchObject({
        speakerAgentId: 'agent_a',
        content: 'ok',
        chainId: 1,
        model: 'gateway-default-model',
        tokensInput: 5,
        tokensOutput: 2
      })
      // agent_b 是 mention 模式且未被 @ → 不醒；级联后无候选，链就此结束（恰一次唤醒）。
      expect(store.turns.map((t) => t.outcome)).toEqual(['spoke'])
      expect(store.turns[0]).toMatchObject({
        sessionId: 7,
        chainId: 1,
        seq: 1,
        agentId: 'agent_a',
        triggerKind: 'human',
        messageId: reply!.id,
        tokensInput: 5,
        tokensOutput: 2
      })
      // 游标推进到本 turn 开始时快照的 maxId（用户行 1），不是自己刚落的那行。
      expect(store.cursors.get('7:agent_a')).toBe(1)
      expect(createModel).toHaveBeenCalledTimes(1)
      // 调度器 turn 走减重门：chatRun 把 identity.group.groupSpeakerRun 送进了 prompt 装配。
      const prompt = (captured.options as { prompt: Array<{ role: string; content: unknown }> })
        .prompt
      const system = prompt.find((m) => m.role === 'system')?.content
      expect(system).toContain(`只回复 ${SILENCE_SENTINEL}`)
      for (const marker of WEIGHT_MARKERS) expect(system).not.toContain(marker)
      expect(system).toContain('STAND-CTX')
    } finally {
      await closeAll()
    }
  })

  test('speaker 模式在 labs on 下 → 409 E_LABS_ORCHESTRATED（两种驱动互斥，零模型调用）', async () => {
    const createModel = vi.fn(() => textModel(() => 'ok'))
    const { config, store } = orchestratedHooks({ modes: {}, createModel })
    const h = await start(config)
    try {
      const res = await postGroup(h.port, { sessionId: 7, speakAsAgentId: 'agent_b' })
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toBe('E_LABS_ORCHESTRATED')
      expect(createModel).not.toHaveBeenCalled()
      expect(store.messages).toEqual([])
    } finally {
      await closeAll()
    }
  })

  test('停止：发言中 /run/active 200；/run/stop → group_stop 系统行（owner_stop）+ turn stopped + 队列清空', async () => {
    const createModel = vi.fn(() => hangingModel())
    const { config, store, registry } = orchestratedHooks({
      modes: { agent_a: 'realtime', agent_b: 'realtime' },
      createModel
    })
    const h = await start(config)
    try {
      const res = await postGroup(h.port, { sessionId: 7, userText: '大家汇报下' })
      expect(((await res.json()) as { orchestrated: boolean }).orchestrated).toBe(true)
      await waitFor(() => registry.hasActive(7))
      const active = await fetch(`http://127.0.0.1:${h.port}/api/ai/run/active?sessionId=7`)
      expect(active.status).toBe(200)

      const stop = await fetch(`http://127.0.0.1:${h.port}/api/ai/run/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 7 })
      })
      expect(stop.status).toBe(200)
      expect(((await stop.json()) as { stopped: boolean }).stopped).toBe(true)
      // 系统行在 /run/stop 应答前就已写入（stopFamily 同步）。
      const system = store.messages.filter((m) => m.role === 'system')
      expect(system).toHaveLength(1)
      expect(JSON.parse(system[0]!.metadata!)).toMatchObject({
        kind: 'group_stop',
        reason: 'owner_stop'
      })
      await waitFor(() => store.turns.length >= 1)
      expect(store.turns.map((t) => t.outcome)).toEqual(['stopped'])
      expect(store.turns[0]!.error).toBe('owner_stop')
      expect(store.messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
      // 排在后面的 agent_b 被清掉：再等一个间隔也没有第二次模型调用；租约已释放。
      await new Promise((r) => setTimeout(r, 700))
      expect(createModel).toHaveBeenCalledTimes(1)
      expect(store.messages.filter((m) => m.role === 'system')).toHaveLength(1)
      const after = await fetch(`http://127.0.0.1:${h.port}/api/ai/run/active?sessionId=7`)
      expect(after.status).toBe(404)
    } finally {
      await closeAll()
    }
  })

  test('停止：无租约窗口（成员排队中、还没开口）的 /run/stop 也按 family 清队列 + 写 owner_stop 行，成员永不开口', async () => {
    const createModel = vi.fn(() => textModel(() => 'ok'))
    const { config, store, registry } = orchestratedHooks({
      modes: { agent_a: 'realtime', agent_b: 'realtime' },
      createModel
    })
    const h = await start(config)
    try {
      const res = await postGroup(h.port, { sessionId: 7, userText: '大家汇报下' })
      expect(((await res.json()) as { orchestrated: boolean }).orchestrated).toBe(true)
      // 紧接着停：成员 turn 还在 MIN_TURN_GAP 里，registry 无租约 —— 只有 stopFamily 能停下它。
      expect(registry.hasActive(7)).toBe(false)
      const stop = await fetch(`http://127.0.0.1:${h.port}/api/ai/run/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 7 })
      })
      expect(stop.status).toBe(200)
      expect(((await stop.json()) as { stopped: boolean }).stopped).toBe(true)
      const system = store.messages.filter((m) => m.role === 'system')
      expect(system).toHaveLength(1)
      expect(JSON.parse(system[0]!.metadata!)).toMatchObject({
        kind: 'group_stop',
        reason: 'owner_stop'
      })
      await new Promise((r) => setTimeout(r, 900))
      expect(createModel).not.toHaveBeenCalled()
      expect(store.messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
      // 已出队的那个 turn 醒来发现 run 已停 → 记一行 stopped；还在队里的被清掉 → 无行。
      expect(store.turns.every((t) => t.outcome === 'stopped')).toBe(true)
      expect(store.turns.length).toBeLessThanOrEqual(1)
      expect(store.messages.filter((m) => m.role === 'system')).toHaveLength(1)
    } finally {
      await closeAll()
    }
  })

  test('group_metrics_before_cascade 守恒：链跑完后每次唤醒恰一行 turn（seq 1..N 连续、同 run / 同链），spoke 行数 == 落库发言数', async () => {
    let n = 0
    const createModel = vi.fn(() => textModel(() => `reply-${++n}`))
    const { config, store } = orchestratedHooks({
      modes: { agent_a: 'realtime', agent_b: 'realtime' },
      createModel
    })
    const h = await start(config)
    try {
      const res = await postGroup(h.port, { sessionId: 7, userText: '大家汇报下' })
      expect(((await res.json()) as { orchestrated: boolean }).orchestrated).toBe(true)
      // 两个 realtime 成员互相级联，直到地板（无法官群 → lapping）写下系统行。
      await waitFor(() => store.messages.some((m) => m.role === 'system'), 15_000)
      const turns = store.turns
      expect(turns.length).toBeGreaterThan(1)
      expect(turns.map((t) => t.seq)).toEqual(turns.map((_, i) => i + 1))
      expect(new Set(turns.map((t) => t.runId)).size).toBe(1)
      expect(turns.every((t) => t.chainId === 1 && t.sessionId === 7)).toBe(true)
      const spoke = turns.filter((t) => t.outcome === 'spoke')
      const replies = store.messages.filter((m) => m.role === 'assistant')
      expect(spoke.map((t) => t.messageId)).toEqual(replies.map((r) => r.id))
      expect(replies.every((r) => r.chainId === 1)).toBe(true)
      expect(createModel).toHaveBeenCalledTimes(spoke.length)
      expect(turns[turns.length - 1]).toMatchObject({ outcome: 'stopped', error: 'lapping' })
      const system = store.messages.filter((m) => m.role === 'system')
      expect(system).toHaveLength(1)
      expect(JSON.parse(system[0]!.metadata!).reason).toBe('lapping')
    } finally {
      await closeAll()
    }
  }, 20_000)
})

// ── UX 批：@全员 保留字 + 群用途进身份块 ──────────────────────────────────────────

describe('UX 批 — parseGroupMentions 保留字 @所有人 / @all', () => {
  const members = [
    { agentId: 'b', title: '跟进官' },
    { agentId: 'a', title: '调研员' },
    { agentId: 'c', title: 'agent1' }
  ]

  test('M1 @所有人 → 全体成员 id（成员序）', () => {
    expect(parseGroupMentions('@所有人 各说一轮', members)).toEqual(['b', 'a', 'c'])
    expect(parseGroupMentions('大家好@所有人', members)).toEqual(['b', 'a', 'c'])
  })

  test('M2 @all 同 M1；@allx 不命中；@all，（中文标点）命中', () => {
    expect(parseGroupMentions('@all please', members)).toEqual(['b', 'a', 'c'])
    expect(parseGroupMentions('@allx please', members)).toEqual([])
    expect(parseGroupMentions('@all，请', members)).toEqual(['b', 'a', 'c'])
    expect(GROUP_MENTION_ALL_TOKENS).toEqual(['@所有人', '@all'])
  })

  test('M3 保留字与成员名同时出现 → 全体（去重，仍是成员序）', () => {
    expect(parseGroupMentions('@调研员 你先，@所有人 补充', members)).toEqual(['b', 'a', 'c'])
  })

  test('M4 成员名恰为「所有人」被保留字遮蔽（记录行为）', () => {
    const shadowed = [
      { agentId: 'x', title: '所有人' },
      { agentId: 'y', title: '评审' }
    ]
    expect(parseGroupMentions('@所有人 说', shadowed)).toEqual(['x', 'y'])
  })
})

describe('UX 批 — buildGroupChatIdentityBlock 的 group.topic', () => {
  test('T1 有值 → 含 <topic> 与「群用途：」；缺省 / null / 空白 → 与 g1 字节相同', () => {
    const base = {
      agentId: 'agent_b',
      agentTitle: '跟进官',
      group: GROUP_IDENTITY.group!
    }
    const g1 = buildGroupChatIdentityBlock(base)
    expect(g1).not.toContain('topic')
    expect(buildGroupChatIdentityBlock({ ...base, group: { ...base.group, topic: null } })).toBe(g1)
    expect(buildGroupChatIdentityBlock({ ...base, group: { ...base.group, topic: '  ' } })).toBe(g1)
    const withTopic = buildGroupChatIdentityBlock({
      ...base,
      group: { ...base.group, topic: '讨论 <Q3> 招聘计划' }
    })
    expect(withTopic).toContain('  <topic>讨论 &lt;Q3&gt; 招聘计划</topic>')
    expect(withTopic).toContain('群用途：讨论 <Q3> 招聘计划。')
    // 透传：buildGatewaySystemPrompt 整体透传 group（chatRun 零改动的挂点）。
    const prompt = buildGatewaySystemPrompt({
      promptConfig: { standingContext: 'STAND' },
      contextSnapshot: null,
      sessionAgentIdentity: {
        ...GROUP_IDENTITY,
        group: { ...GROUP_IDENTITY.group!, topic: '周报' }
      }
    })
    expect(prompt).toContain('<topic>周报</topic>')
  })
})
