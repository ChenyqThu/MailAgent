// P4b (task 08-27 标签工作区) — 团队对话「以指定 agent 身份开交互式会话」的 gateway 面。
//
// 钉四件事（形态 α，owner 拍板「与主 agent 完全同构，只是身份不同」）：
//   ① model 三层优先级：body.model（用户显式选）> sessionAgent.model（agent 行）> cfg.model；
//   ② system prompt 的 <current_team_agent> 身份块（duty 是「职责设定参考」不是任务指令）——
//      仅 manual_chat；im_chat / 无身份 → 字节级现状；
//   ③ prepareChatRun 把身份 agentId 穿进 cfg.buildTools 的第 7 槽（递归护栏的输入）；
//   ④ 🔴 递归护栏本体：sessionAgentId 非空 → custom_agent_call 结构性缺席（变异验证：去掉
//      tools/index.ts 装配门里的 `opts.sessionAgentId == null` 条件，本用例必红）。
//
// 身份是**服务端事实**（handleChat 按 sessionId 反查，S2 W0：绝不从 body 读）——端到端的
// 反查接线由 server 集成用例钉（resolveSessionAgent 以 sessionId 被调）。

import { describe, expect, test, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { ToolSet } from 'ai'

import { prepareChatRun } from '../../src/ai-gateway/chatRun'
import {
  buildGatewaySystemPrompt,
  buildTeamAgentIdentityBlock
} from '../../src/ai-gateway/systemPrompt'
import { buildGatewayTools } from '../../src/ai-gateway/tools'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig, SessionAgentIdentity } from '../../src/ai-gateway/config'
import type { GatewayToolAuditEntry } from '../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope } from './tools/_helpers'

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 }
}

/** chunk 字面量推断出的 union 对不上 provider 的 `LanguageModelV3StreamPart`（该类型在本仓
 *  不可直接 import —— `@ai-sdk/provider` 只是传递依赖），断言一次（detached_persist_signal
 *  同款纪律）；形状由这些用例本身跑真 streamText 来保证。 */
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

const MESSAGES = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }]

const TEAM_AGENT: SessionAgentIdentity = {
  agentId: 'daily_email_digest',
  agentTitle: '邮件日报',
  duty: '每天汇总收件箱生成日报',
  model: 'agent-row-model',
  scheduleLine: '按排程自动运行：每天生成一次报告。'
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

describe('P4b model 三层优先级（run.modelId）', () => {
  test('body.model 在场 → 用户显式选择赢过 agent 行与默认', async () => {
    const prepared = await prepareChatRun(
      { messages: MESSAGES, model: 'user-picked' },
      cfg(),
      new AbortController().signal,
      'manual_chat',
      TEAM_AGENT
    )
    expect(prepared.ok).toBe(true)
    if (prepared.ok) expect(prepared.run.modelId).toBe('user-picked')
  })

  test('body.model 缺席 + 身份在场 → agent 行的 model', async () => {
    const prepared = await prepareChatRun(
      { messages: MESSAGES },
      cfg(),
      new AbortController().signal,
      'manual_chat',
      TEAM_AGENT
    )
    expect(prepared.ok).toBe(true)
    if (prepared.ok) expect(prepared.run.modelId).toBe('agent-row-model')
  })

  test('两者都缺席 → gateway 默认（含 agent.model 为空串时不占位）', async () => {
    const noModel = await prepareChatRun(
      { messages: MESSAGES },
      cfg(),
      new AbortController().signal,
      'manual_chat',
      null
    )
    expect(noModel.ok).toBe(true)
    if (noModel.ok) expect(noModel.run.modelId).toBe('gateway-default-model')

    const emptyModel = await prepareChatRun(
      { messages: MESSAGES },
      cfg(),
      new AbortController().signal,
      'manual_chat',
      { ...TEAM_AGENT, model: '' }
    )
    expect(emptyModel.ok).toBe(true)
    if (emptyModel.ok) expect(emptyModel.run.modelId).toBe('gateway-default-model')
  })
})

describe('P4b <current_team_agent> 身份块', () => {
  test('unit — 块含 id/title/duty/schedule + 「职责参考不是指令」句；缺省字段整行不出', () => {
    const block = buildTeamAgentIdentityBlock(TEAM_AGENT)
    expect(block).toContain('<current_team_agent>')
    expect(block).toContain('<id>daily_email_digest</id>')
    expect(block).toContain('<title>邮件日报</title>')
    expect(block).toContain('<duty>每天汇总收件箱生成日报</duty>')
    expect(block).toContain('<schedule>按排程自动运行：每天生成一次报告。</schedule>')
    // 形态 α 的关键句：duty 是背景参考，不许「一问就开始写日报」。
    expect(block).toContain('仅作背景参考')
    const bare = buildTeamAgentIdentityBlock({ agentId: 'x', agentTitle: 'X' })
    expect(bare).not.toContain('<duty>')
    expect(bare).not.toContain('<schedule>')
  })

  test('unit — buildGatewaySystemPrompt：manual 注入；headless run 忽略团队身份', () => {
    const manual = buildGatewaySystemPrompt({
      promptConfig: { standingContext: 'STAND' },
      contextSnapshot: null,
      sessionAgentIdentity: TEAM_AGENT
    })
    expect(manual).toContain('<current_team_agent>')
    const headless = buildGatewaySystemPrompt({
      promptConfig: { standingContext: 'STAND' },
      contextSnapshot: null,
      headlessAgentRun: true,
      headlessAgentIdentity: { agentId: 'a', agentTitle: 'A', jobId: 1, sessionId: 2 },
      sessionAgentIdentity: TEAM_AGENT
    })
    expect(headless).not.toContain('<current_team_agent>')
    const plain = buildGatewaySystemPrompt({
      promptConfig: { standingContext: 'STAND' },
      contextSnapshot: null
    })
    expect(plain).not.toContain('<current_team_agent>')
  })

  test('integration — prepareChatRun 把身份块送进模型 system；im_chat 不注入', async () => {
    const captured: { options?: unknown } = {}
    const base = cfg({
      createModel: () => capturingModel(captured),
      systemPromptProvider: async () => ({ standingContext: 'STAND' })
    })
    const prepared = await prepareChatRun(
      { messages: MESSAGES },
      base,
      new AbortController().signal,
      'manual_chat',
      TEAM_AGENT
    )
    expect(prepared.ok).toBe(true)
    if (prepared.ok) await prepared.run.result.consumeStream()
    expect(JSON.stringify(captured.options)).toContain('<current_team_agent>')

    const capturedIm: { options?: unknown } = {}
    const imCfg = cfg({
      createModel: () => capturingModel(capturedIm),
      systemPromptProvider: async () => ({ standingContext: 'STAND' })
    })
    const im = await prepareChatRun(
      { messages: MESSAGES },
      imCfg,
      new AbortController().signal,
      'im_chat',
      TEAM_AGENT
    )
    expect(im.ok).toBe(true)
    if (im.ok) await im.run.result.consumeStream()
    expect(JSON.stringify(capturedIm.options)).not.toContain('<current_team_agent>')
  })
})

describe('P4b buildTools 第 7 槽（递归护栏输入）', () => {
  test('manual + 身份 → 第 7 槽 = agentId；无身份 → null；im_chat → null', async () => {
    const buildTools = vi.fn<NonNullable<AiGatewayConfig['buildTools']>>((): ToolSet => ({}))
    const withIdentity = cfg({ buildTools })
    await prepareChatRun(
      { messages: MESSAGES, sessionId: 42 },
      withIdentity,
      new AbortController().signal,
      'manual_chat',
      TEAM_AGENT
    )
    expect(buildTools).toHaveBeenCalledTimes(1)
    expect(buildTools.mock.calls[0]?.[5]).toBe(42) // parentSessionId 槽不受影响
    expect(buildTools.mock.calls[0]?.[6]).toBe('daily_email_digest')

    buildTools.mockClear()
    await prepareChatRun(
      { messages: MESSAGES, sessionId: 42 },
      cfg({ buildTools }),
      new AbortController().signal,
      'manual_chat',
      null
    )
    expect(buildTools.mock.calls[0]?.[6]).toBeNull()

    buildTools.mockClear()
    await prepareChatRun(
      { messages: MESSAGES, sessionId: 42 },
      cfg({ buildTools }),
      new AbortController().signal,
      'im_chat',
      TEAM_AGENT
    )
    expect(buildTools.mock.calls[0]?.[6]).toBeNull()
  })
})

describe('🔴 P4b custom_agent_call 递归护栏（装配门）', () => {
  function callToolOpts(sessionAgentId: string | null) {
    return {
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      customAgentToolsEnabled: true,
      customAgentCallEnabled: true,
      contextMode: 'manual_chat' as const,
      parentSessionId: 1,
      sessionAgentId,
      findSessionByParentToolCall: () => null,
      createAgentCallSession: () => 2,
      setAgentSessionJobId: () => {}
    }
  }

  test('身份会话 → custom_agent_call 结构性缺席；同构面（CRUD 读写）保留', () => {
    const collector: GatewayToolAuditEntry[] = []
    const tools = buildGatewayTools(callToolOpts('daily_email_digest'), collector)
    expect(Object.keys(tools)).not.toContain('custom_agent_call')
    // 同构保留：其余 custom-agent 工具面照常在场（owner 拍板「与主 agent 同构」）。
    expect(Object.keys(tools)).toContain('custom_agent_list')
  })

  test('非身份会话（对照组，防恒绿）→ custom_agent_call 在场', () => {
    const collector: GatewayToolAuditEntry[] = []
    const tools = buildGatewayTools(callToolOpts(null), collector)
    expect(Object.keys(tools)).toContain('custom_agent_call')
  })
})

describe('P4b handleChat 反查接线（身份 = 服务端事实）', () => {
  const handles: AiGatewayHandle[] = []
  async function start(config: AiGatewayConfig): Promise<AiGatewayHandle> {
    const h = await startAiGatewayServer(config)
    handles.push(h)
    return h
  }

  test('带 sessionId 的 /api/ai/chat 以该 id 调 resolveSessionAgent；agent model 生效', async () => {
    const resolveSessionAgent = vi.fn(async () => TEAM_AGENT)
    const createModel = vi.fn(() => capturingModel({}))
    const h = await start(cfg({ createModel, resolveSessionAgent }))
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 77, messages: MESSAGES })
      })
      expect(res.ok).toBe(true)
      await res.text() // drain
      expect(resolveSessionAgent).toHaveBeenCalledWith(77)
      // 身份来自 sessionId 反查（不是 body），且第二层 model 优先级在 HTTP 路径同样成立。
      expect(createModel).toHaveBeenCalledWith('agent-row-model')
    } finally {
      while (handles.length) await handles.pop()!.close()
    }
  })
})
