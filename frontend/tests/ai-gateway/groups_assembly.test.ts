// L4 群聊 g2 — 群工具面的装配 / 守卫 / 调度器接线。
//
// 钉的是「谁在什么条件下拿到哪一版群工具」，不是工具本体（那在 tools/groups.test.ts）：
//   AS1–AS6  prepareChatRun 自算 buildTools 第 8 槽 { isGroupSession, enabled }：群会话判定
//            单源在这里（handleChat / compact 溢出重试 / approvalResume 三入口都经它），
//            resolveGroupSession 抛错 → fail-closed 当群会话；labs 任何失败 → enabled:false。
//   AS7–AS9  群 speaker run 只在 identity.group.groupSpeakerRun===true 时调 buildGroupSpeakerTools
//            （成员 / 法官分支），v30 renderer-driven 分支两者都不调；headless 三元包装器结构性
//            丢掉第 8 槽。
//   AS10–11  buildGatewayTools 装配门六分支（AC1）+ owner deny 剔除接线。
//   AS12     调度器把 via='judge_post' 的 assistant 链根行判成 triggerKind 'judge_post'。
//   AS13     createAiGatewayServer 把投递缝写回 cfg.deliverGroupMessage。
//   AS14     lifecycle 的 computeJudgeScopeStale：members_json 原文 sha256 与 judgeScopeHash 比对。
//
// 工具工厂本体（createGroupTools）在本文件里用 vi.mock 换成「按名造四个假工具」——这里只关心
// 装配门的开合，工具行为在 tools/groups.test.ts；GATEWAY_GROUP_TOOL_NAMES 仍取真模块。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream, type Tool, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import { wrapCfgForAgentRun } from '../../src/ai-gateway/agentRun'
import { resumeApprovalRun } from '../../src/ai-gateway/approvalResume'
import { ApprovalRunStash } from '../../src/ai-gateway/approvalStash'
import { prepareChatRun } from '../../src/ai-gateway/chatRun'
import type {
  AiGatewayConfig,
  GroupSessionFacts,
  SessionAgentIdentity
} from '../../src/ai-gateway/config'
import type { GroupTranscriptRow } from '../../src/ai-gateway/groupChat'
import {
  GroupOrchestrator,
  type GroupOrchestratorDeps,
  type GroupRunFacts,
  type GroupTurnRow
} from '../../src/ai-gateway/groupOrchestrator'
import type { GroupTurnEvent } from '../../src/ai-gateway/groupTurnEvent'
import type { MailAgentDomainClient } from '../../src/ai-gateway/python/domainClient'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { createAiGatewayServer } from '../../src/ai-gateway/server'
import { buildGatewayTools } from '../../src/ai-gateway/tools'
import {
  createGroupTools,
  GATEWAY_GROUP_TOOL_NAMES,
  type GroupToolHooks
} from '../../src/ai-gateway/tools/groups'
import type { AgentContextMode } from '../../src/ai-gateway/tools/policy'
import type { GatewayToolAuditEntry } from '../../src/ai-gateway/tools/types'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

const { appMock } = vi.hoisted(() => ({
  appMock: { isPackaged: false, getPath: (_k: string) => '/tmp' }
}))
// AS14 动态 import lifecycle（它顶层 import electron）；其余用例不碰这个 mock。
vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: {},
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  }
}))
vi.mock('../../src/ai-gateway/tools/groups', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/ai-gateway/tools/groups')>()
  return {
    ...original,
    createGroupTools: vi.fn(
      (): Record<string, Tool> =>
        Object.fromEntries(
          original.GATEWAY_GROUP_TOOL_NAMES.map((name) => [
            name,
            { description: name, execute: async () => ({}) } as unknown as Tool
          ])
        )
    )
  }
})

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 }
}
type MockDoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']

function textModel(text = 'ok'): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: '1' },
          { type: 'text-delta' as const, id: '1', delta: text },
          { type: 'text-end' as const, id: '1' },
          { type: 'finish' as const, finishReason: { unified: 'stop' as const }, usage: USAGE }
        ]
      })
    })) as unknown as MockDoStream
  })
}

const MESSAGES = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }]

const FACTS: GroupSessionFacts = {
  members: [
    { agentId: 'judge', title: '法官' },
    { agentId: 'a', title: '调研员' },
    { agentId: 'b', title: '跟进官' }
  ],
  config: { v: 1, judgeAgentId: 'judge' },
  modes: { a: 'realtime', b: 'realtime' },
  parentSessionId: null,
  childSessionIds: [3],
  judgeScopeStale: false
}

function fakeHooks(): GroupToolHooks {
  return {
    resolveGroupSession: () => null,
    listGroupHistory: () => [],
    appendGroupMessage: () => 1,
    groupUsage: () => ({ turns: 0, tokens: 0, costUsd: null }),
    deliverGroupMessage: () => undefined,
    getSessionTitle: () => null,
    lastHumanMessageText: () => null,
    createGroupSession: async () => ({
      sessionId: 1,
      title: null,
      members: [],
      parentSessionId: null
    }),
    setGroupConfig: async () => {}
  }
}

type BuildToolsSpy = ReturnType<typeof vi.fn<(...args: unknown[]) => ToolSet>>

function makeCfg(overrides: Partial<AiGatewayConfig> = {}): {
  cfg: AiGatewayConfig
  buildTools: BuildToolsSpy
} {
  const buildTools = vi.fn<(...args: unknown[]) => ToolSet>(() => ({}))
  return {
    buildTools,
    cfg: {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'gateway-default-model',
      createModel: () => textModel(),
      buildTools: buildTools as unknown as AiGatewayConfig['buildTools'],
      ...overrides
    }
  }
}

async function prep(
  cfg: AiGatewayConfig,
  body: Record<string, unknown>,
  mode: AgentContextMode = 'manual_chat',
  identity: SessionAgentIdentity | null = null
): Promise<{ toolNames: string[] }> {
  const prepared = await prepareChatRun(body, cfg, new AbortController().signal, mode, identity)
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) throw new Error(prepared.body.error)
  return { toolNames: prepared.run.toolNames }
}

const slot8 = (spy: { mock: { calls: unknown[][] } }, call = 0): unknown =>
  spy.mock.calls[call]?.[7]

afterEach(() => {
  vi.restoreAllMocks()
})

// ── AS1–AS6 prepareChatRun 第 8 槽 ─────────────────────────────────────────────────

describe('prepareChatRun — buildTools 第 8 槽 { isGroupSession, enabled }（单源 + fail-closed）', () => {
  test('AS1 manual_chat + sessionId=7（resolveGroupSession 返 null）+ labs on → {isGroupSession:false, enabled:true}', async () => {
    const resolveGroupSession = vi.fn(() => null)
    const { cfg, buildTools } = makeCfg({
      resolveGroupSession,
      resolveLabsFlags: () => ({ groupAgents: true })
    })
    await prep(cfg, { messages: MESSAGES, sessionId: 7 })
    expect(resolveGroupSession).toHaveBeenCalledWith(7)
    expect(slot8(buildTools)).toEqual({ isGroupSession: false, enabled: true })
  })

  test('AS2 sessionId=7 是群（facts 非 null）→ isGroupSession:true（AC7 主体）', async () => {
    const { cfg, buildTools } = makeCfg({
      resolveGroupSession: () => FACTS,
      resolveLabsFlags: () => ({ groupAgents: true })
    })
    await prep(cfg, { messages: MESSAGES, sessionId: 7 })
    expect(slot8(buildTools)).toEqual({ isGroupSession: true, enabled: true })
  })

  test('AS3 resolveGroupSession 抛错 → isGroupSession:true（fail-closed）且 console.warn 一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { cfg, buildTools } = makeCfg({
      resolveGroupSession: () => {
        throw new Error('db locked')
      },
      resolveLabsFlags: () => ({ groupAgents: true })
    })
    await prep(cfg, { messages: MESSAGES, sessionId: 7 })
    expect(slot8(buildTools)).toEqual({ isGroupSession: true, enabled: true })
    const groupWarns = warn.mock.calls.filter((c) => String(c[0]).includes('resolveGroupSession'))
    expect(groupWarns).toHaveLength(1)
  })

  test('AS4 labs off / resolveLabsFlags 抛错 / 无 hook → enabled:false（三分支）', async () => {
    const off = makeCfg({
      resolveGroupSession: () => null,
      resolveLabsFlags: () => ({ groupAgents: false })
    })
    await prep(off.cfg, { messages: MESSAGES, sessionId: 7 })
    expect(slot8(off.buildTools)).toEqual({ isGroupSession: false, enabled: false })

    const throws = makeCfg({
      resolveGroupSession: () => null,
      resolveLabsFlags: () => {
        throw new Error('labs unreachable')
      }
    })
    await prep(throws.cfg, { messages: MESSAGES, sessionId: 7 })
    expect(slot8(throws.buildTools)).toEqual({ isGroupSession: false, enabled: false })

    const absent = makeCfg({ resolveGroupSession: () => null })
    await prep(absent.cfg, { messages: MESSAGES, sessionId: 7 })
    expect(slot8(absent.buildTools)).toEqual({ isGroupSession: false, enabled: false })
  })

  test('AS4b 非 manual 场地 / 无 sessionId → 两个 hook 都不调，第 8 槽恒 {false,false}', async () => {
    const resolveGroupSession = vi.fn(() => FACTS)
    const resolveLabsFlags = vi.fn(() => ({ groupAgents: true }))
    const im = makeCfg({ resolveGroupSession, resolveLabsFlags })
    await prep(im.cfg, { messages: MESSAGES, sessionId: 7 }, 'im_chat')
    expect(slot8(im.buildTools)).toEqual({ isGroupSession: false, enabled: false })
    const noSession = makeCfg({ resolveGroupSession, resolveLabsFlags })
    await prep(noSession.cfg, { messages: MESSAGES })
    expect(slot8(noSession.buildTools)).toEqual({ isGroupSession: false, enabled: false })
    expect(resolveGroupSession).not.toHaveBeenCalled()
    expect(resolveLabsFlags).not.toHaveBeenCalled()
  })

  test('AS5 approvalResume 重放 sessionId=7 群会话的 stash entry → prepareChatRun 内算出 isGroupSession:true（AC7 resume 路径）', async () => {
    const TC = 'tc_draft'
    const AP = 'ap_draft'
    const DRAFT_INPUT = { internal_id: 5, body_markdown: 'draft body' }
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const domain = {
      draftReply: async (internalId: number) => ({
        internalId,
        mailbox: '草稿箱',
        accountName: 'acct',
        draftId: 'd1'
      })
    } as unknown as MailAgentDomainClient
    const buildTools = vi.fn(
      (collector: GatewayToolAuditEntry[], _mode: unknown, contextMode: AgentContextMode) =>
        buildGatewayTools(
          {
            domain,
            writeToolsEnabled: true,
            approvalGuard: guard,
            oneShotWrites: true,
            contextMode
          },
          collector
        )
    )
    const resolveGroupSession = vi.fn(() => FACTS)
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => textModel('草稿已创建。'),
      buildTools: buildTools as unknown as AiGatewayConfig['buildTools'],
      approvalStash: stash,
      resolveGroupSession,
      resolveLabsFlags: () => ({ groupAgents: true })
    }
    guard.register(TC, 'email_draft_reply', 'edit', DRAFT_INPUT, ['body_markdown'])
    const token = stash.stash({
      toolCallId: TC,
      approvalId: AP,
      toolName: 'email_draft_reply',
      sessionId: 7,
      body: { messages: MESSAGES, model: 'claude-sonnet-4-6', sessionId: 7 },
      responseMessage: {
        id: 'a-paused',
        role: 'assistant',
        parts: [
          {
            type: 'tool-email_draft_reply',
            toolCallId: TC,
            state: 'approval-requested',
            input: DRAFT_INPUT,
            approval: { id: AP }
          }
        ]
      } as unknown as MailAgentUIMessage,
      contextMode: 'manual_chat'
    })
    const result = await resumeApprovalRun(
      cfg,
      { toolCallId: TC, decision: 'approve', resumeToken: token },
      new AbortController().signal
    )
    expect(result.status).toBe('completed')
    // 反查发生在 prepareChatRun 内（approvalResume 自己零 resolveGroupSession 调用点）。
    expect(resolveGroupSession).toHaveBeenCalledWith(7)
    expect(slot8(buildTools as unknown as { mock: { calls: unknown[][] } })).toEqual({
      isGroupSession: true,
      enabled: true
    })
  })

  test('AS6 同一会话连做两次 prepareChatRun（compact 溢出重试形状）→ 两次都算第 8 槽', async () => {
    const resolveGroupSession = vi.fn(() => FACTS)
    const { cfg, buildTools } = makeCfg({
      resolveGroupSession,
      resolveLabsFlags: () => ({ groupAgents: true })
    })
    await prep(cfg, { messages: MESSAGES, sessionId: 7 })
    await prep(cfg, { messages: MESSAGES, sessionId: 7 })
    expect(resolveGroupSession).toHaveBeenCalledTimes(2)
    expect(slot8(buildTools, 0)).toEqual({ isGroupSession: true, enabled: true })
    expect(slot8(buildTools, 1)).toEqual({ isGroupSession: true, enabled: true })
  })
})

// ── AS7–AS9 群 speaker run 的工厂分支 ───────────────────────────────────────────────

describe('prepareChatRun — 群 speaker run 走 buildGroupSpeakerTools', () => {
  const groupIdentity = (
    group: NonNullable<SessionAgentIdentity['group']>
  ): SessionAgentIdentity => ({
    agentId: 'a',
    agentTitle: '调研员',
    duty: null,
    model: null,
    scheduleLine: null,
    group
  })
  const roster = FACTS.members.map((m) => ({ agentId: m.agentId, title: m.title }))

  test('AS7 groupSpeakerRun=true + isJudge=false → buildGroupSpeakerTools 被调 spec.isJudge=false，buildTools 未被调', async () => {
    const buildGroupSpeakerTools = vi.fn<NonNullable<AiGatewayConfig['buildGroupSpeakerTools']>>(
      () => ({
        group_history: { description: 'x', execute: async () => ({}) } as unknown as Tool
      })
    )
    const { cfg, buildTools } = makeCfg({ buildGroupSpeakerTools })
    const { toolNames } = await prep(
      cfg,
      { messages: MESSAGES },
      'manual_chat',
      groupIdentity({
        members: roster,
        sessionId: 7,
        isJudge: false,
        familySessionIds: [7, 3],
        groupSpeakerRun: true
      })
    )
    expect(buildTools).not.toHaveBeenCalled()
    expect(buildGroupSpeakerTools).toHaveBeenCalledTimes(1)
    expect(buildGroupSpeakerTools.mock.calls[0]?.[1]).toEqual({
      sessionId: 7,
      agentId: 'a',
      isJudge: false,
      familySessionIds: [7, 3],
      toolApprovalPrefs: null
    })
    expect(toolNames).toEqual(['group_history'])

    const judgeFactory = vi.fn<NonNullable<AiGatewayConfig['buildGroupSpeakerTools']>>(() => ({}))
    const judge = makeCfg({ buildGroupSpeakerTools: judgeFactory })
    await prep(
      judge.cfg,
      { messages: MESSAGES },
      'manual_chat',
      groupIdentity({ members: roster, sessionId: 7, isJudge: true, groupSpeakerRun: true })
    )
    expect(judgeFactory.mock.calls[0]?.[1]).toMatchObject({
      isJudge: true,
      familySessionIds: [7]
    })
  })

  test('AS8 identity.group 有值但 groupSpeakerRun 未设（v30 renderer-driven）→ 两者都未被调，tools undefined', async () => {
    const buildGroupSpeakerTools = vi.fn(() => ({}))
    const { cfg, buildTools } = makeCfg({ buildGroupSpeakerTools })
    const { toolNames } = await prep(
      cfg,
      { messages: MESSAGES },
      'manual_chat',
      groupIdentity({ members: roster, sessionId: 7 })
    )
    expect(buildTools).not.toHaveBeenCalled()
    expect(buildGroupSpeakerTools).not.toHaveBeenCalled()
    expect(toolNames).toEqual([])
  })

  test('AS9 headless（wrapCfgForAgentRun 包装 cfg）→ buildTools 只收 4 参，第 8 槽 undefined', async () => {
    const resolveGroupSession = vi.fn(() => FACTS)
    const { cfg, buildTools } = makeCfg({
      resolveGroupSession,
      resolveLabsFlags: () => ({ groupAgents: true })
    })
    const wrapped = wrapCfgForAgentRun(cfg, { agentId: 'x', allowedTools: [], skills: [] })
    await prep(wrapped, { messages: MESSAGES, sessionId: 7 }, 'cron_headless')
    expect(buildTools).toHaveBeenCalledTimes(1)
    expect(buildTools.mock.calls[0]).toHaveLength(4)
    expect(slot8(buildTools)).toBeUndefined()
    expect(resolveGroupSession).not.toHaveBeenCalled()
  })
})

// ── AS10–AS11 buildGatewayTools 装配门 ─────────────────────────────────────────────

describe('buildGatewayTools — 主 agent 版群工具装配门（AC1）', () => {
  const domain = {} as MailAgentDomainClient
  const groupTools = (
    over: Partial<NonNullable<Parameters<typeof buildGatewayTools>[0]['groupTools']>> = {}
  ) => ({
    enabled: true,
    isGroupSession: false,
    hooks: fakeHooks(),
    sessionId: 7,
    ...over
  })
  const names = (tools: ToolSet): string[] =>
    Object.keys(tools).filter((n) => (GATEWAY_GROUP_TOOL_NAMES as readonly string[]).includes(n))

  test('AS10 六分支：labs on + 非群 + guard → 四名；isGroupSession / team 身份 / enabled=false / 无 guard / headless / im → 缺席', () => {
    const hooks = fakeHooks()
    const on = buildGatewayTools({
      domain,
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat',
      groupTools: groupTools({ hooks })
    })
    expect(names(on).sort()).toEqual([...GATEWAY_GROUP_TOOL_NAMES].sort())
    const factory = vi.mocked(createGroupTools)
    const lastCall = factory.mock.calls.at(-1) as unknown[] | undefined
    expect(lastCall?.[2]).toBe(hooks)
    expect(lastCall?.[3]).toMatchObject({ sessionId: 7, contextMode: 'manual_chat' })

    const inGroup = buildGatewayTools({
      domain,
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat',
      groupTools: groupTools({ isGroupSession: true })
    })
    expect(names(inGroup)).toEqual([])

    const team = buildGatewayTools({
      domain,
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat',
      sessionAgentId: 'daily_digest',
      groupTools: groupTools()
    })
    expect(names(team)).toEqual([])

    const off = buildGatewayTools({
      domain,
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat',
      groupTools: groupTools({ enabled: false })
    })
    expect(names(off)).toEqual([])

    const noGuard = buildGatewayTools({
      domain,
      contextMode: 'manual_chat',
      groupTools: groupTools()
    })
    expect(names(noGuard)).toEqual([])

    for (const mode of ['cron_headless', 'im_chat'] as const) {
      const out = buildGatewayTools({
        domain,
        approvalGuard: new ApprovalGuard(),
        contextMode: mode,
        groupTools: groupTools()
      })
      expect(names(out)).toEqual([])
    }
  })

  test('AS11 owner deny group_post → 结果不含 group_post（stripOwnerDeniedTools 接线），其余三名仍在', () => {
    const tools = buildGatewayTools({
      domain,
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat',
      groupTools: groupTools(),
      toolApprovalPrefs: {
        tools: { group_post: { tier: 'deny', source: 'owner' } },
        sendRecipientWhitelist: []
      }
    })
    expect(tools.group_post).toBeUndefined()
    expect(names(tools).sort()).toEqual(['group_create', 'group_history', 'group_members'])
  })
})

// ── AS12 调度器 triggerKind 'judge_post' ───────────────────────────────────────────

describe('GroupOrchestrator.onGroupMessage — 法官跨群投递行', () => {
  function world(realtime: string[]): {
    messages: GroupTranscriptRow[]
    turns: GroupTurnRow[]
    events: GroupTurnEvent[]
    deps: GroupOrchestratorDeps
  } {
    const messages: GroupTranscriptRow[] = []
    const turns: GroupTurnRow[] = []
    const events: GroupTurnEvent[] = []
    let nextId = 100
    const facts: GroupRunFacts = {
      members: [
        { agentId: 'judge', title: '法官' },
        { agentId: 'a', title: 'A' },
        { agentId: 'b', title: 'B' }
      ],
      modes: Object.fromEntries(realtime.map((id) => [id, 'realtime' as const])),
      config: { judgeAgentId: 'judge' },
      familySessionIds: [7]
    }
    const registry = new ActiveRunRegistry()
    const deps: GroupOrchestratorDeps = {
      resolveFacts: (sid) => (sid === 7 ? facts : null),
      listHistory: () => messages,
      appendMessage: (_sid, input) => {
        const id = nextId++
        messages.push({
          id,
          role: input.role,
          content: input.content,
          speakerAgentId: input.speakerAgentId,
          status: 'complete',
          chainId: input.chainId ?? null,
          via: null,
          createdAt: Date.now()
        })
        return id
      },
      getSeenCursor: () => null,
      advanceSeenCursor: () => {},
      insertTurn: (row) => turns.push(row),
      groupUsage: () => ({ turns: 0, tokens: 0, costUsd: null }),
      resolveLabs: async () => ({ groupAgents: true }),
      speak: async (input) => ({
        text: `${input.agentId} 回应`,
        modelId: 'm',
        usage: { inputTokens: 1, outputTokens: 1 },
        protocol: 'anthropic'
      }),
      registerRun: (sid, controller) => registry.register(sid, controller),
      releaseRun: (sid, runId) => registry.release(sid, runId),
      emitEvent: (event) => {
        events.push(event)
      },
      now: () => Date.now(),
      sleep: () => Promise.resolve(),
      warn: () => {}
    }
    return { messages, turns, events, deps }
  }
  const judgeRow = (): GroupTranscriptRow => ({
    id: 10,
    role: 'assistant',
    content: '夜晚开始，请行动',
    speakerAgentId: 'judge',
    status: 'complete',
    chainId: null,
    via: 'judge_post',
    createdAt: Date.now()
  })

  test("AS12 role assistant + via 'judge_post' + chainId null → triggerKind 'judge_post'、chainId=row.id；无候选时发 no_candidates；via null assistant → 'agent'", async () => {
    const w = world(['a', 'b'])
    const orch = new GroupOrchestrator({ deps: w.deps, cascade: false })
    const row = judgeRow()
    w.messages.push(row)
    const { queued } = await orch.onGroupMessage(7, row)
    await orch.idle()
    expect(queued).toEqual(['a', 'b'])
    expect(w.turns.map((t) => [t.agentId, t.triggerKind, t.chainId, t.outcome])).toEqual([
      ['a', 'judge_post', 10, 'spoke'],
      ['b', 'judge_post', 10, 'spoke']
    ])

    const empty = world([])
    const orch2 = new GroupOrchestrator({ deps: empty.deps, cascade: false })
    const row2 = judgeRow()
    empty.messages.push(row2)
    expect(await orch2.onGroupMessage(7, row2)).toEqual({ queued: [] })
    expect(empty.events.filter((e) => e.phase === 'no_candidates')).toHaveLength(1)

    const member = world(['b'])
    const orch3 = new GroupOrchestrator({ deps: member.deps, cascade: false })
    const reply: GroupTranscriptRow = {
      id: 11,
      role: 'assistant',
      content: '我先说',
      speakerAgentId: 'a',
      status: 'complete',
      chainId: 5,
      via: null,
      createdAt: Date.now()
    }
    member.messages.push(reply)
    await orch3.onGroupMessage(7, reply)
    await orch3.idle()
    expect(member.turns.map((t) => [t.agentId, t.triggerKind, t.chainId])).toEqual([
      ['b', 'agent', 5]
    ])
    // 成员级联末尾无候选 = 链正常结束，不发 no_candidates。
    const quiet = world([])
    const orch4 = new GroupOrchestrator({ deps: quiet.deps, cascade: false })
    await orch4.onGroupMessage(7, reply)
    expect(quiet.events.some((e) => e.phase === 'no_candidates')).toBe(false)
  })
})

// ── AS13 投递缝写回 ────────────────────────────────────────────────────────────────

describe('createAiGatewayServer — cfg.deliverGroupMessage 写回', () => {
  test('AS13 有调度器 → cfg.deliverGroupMessage 存在且等价 groupScheduler.onGroupMessage；无调度器 → 缺席', async () => {
    const onGroupMessage = vi.fn(async () => ({ queued: ['a'] }))
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'm',
      groupScheduler: { onGroupMessage } as unknown as GroupOrchestrator
    }
    expect(cfg.deliverGroupMessage).toBeUndefined()
    const server = createAiGatewayServer(cfg)
    expect(typeof cfg.deliverGroupMessage).toBe('function')
    const row: GroupTranscriptRow = {
      id: 1,
      role: 'user',
      content: 'hi',
      speakerAgentId: null,
      status: 'complete',
      chainId: null,
      via: 'main_agent',
      createdAt: 0
    }
    await expect(cfg.deliverGroupMessage!(7, row)).resolves.toEqual({ queued: ['a'] })
    expect(onGroupMessage).toHaveBeenCalledWith(7, row)
    server.close()

    const bare: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'k',
      model: 'm'
    }
    createAiGatewayServer(bare).close()
    expect(bare.deliverGroupMessage).toBeUndefined()
  })
})

// ── AS14 judgeScopeStale ────────────────────────────────────────────────────────────

describe('lifecycle computeJudgeScopeStale — members_json 原文 sha256 vs judgeScopeHash', () => {
  test('AS14 原文 + 匹配 hash → false；改一个空格 → true；无法官 → false', async () => {
    const { computeJudgeScopeStale } = await import('../../src/electron/main/ai_gateway_lifecycle')
    const { createHash } = await import('node:crypto')
    const raw = '["judge","a","b"]'
    const hash = createHash('sha256').update(raw, 'utf8').digest('hex')
    expect(computeJudgeScopeStale(raw, { judgeAgentId: 'judge', judgeScopeHash: hash })).toBe(false)
    // 等价重排也算变：写侧钉的是 owner 确认那一刻的原文字节。
    expect(
      computeJudgeScopeStale('["judge", "a","b"]', { judgeAgentId: 'judge', judgeScopeHash: hash })
    ).toBe(true)
    expect(computeJudgeScopeStale(raw, { judgeAgentId: null, judgeScopeHash: 'stale' })).toBe(false)
    expect(computeJudgeScopeStale(null, { judgeAgentId: 'judge', judgeScopeHash: hash })).toBe(true)
  })
})
