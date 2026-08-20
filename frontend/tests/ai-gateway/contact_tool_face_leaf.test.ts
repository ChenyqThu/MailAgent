// WP7 —— 「通讯录 Agent 工具面清单」防说谎闸。
//
// 治理台抽屉的「它能做什么」tab 按 `@shared/lib/contactToolFace` 的分组表把工具列给
// owner 看。那张表是**说明书**，权威是 gateway 真实装配出来的 ToolSet。二者一漂开，界面
// 就开始撒谎，而且是最难发现的那种谎（既不报错也不空白，只是少说 / 多说一件事）。所以
// 这里驱动**真实**的 buildGatewayTools（主对话面）与 runHeadlessAgent（治理 run 面），
// 三向断言：
//   (a) 表里的每个名字都真的在主对话工具面里 —— 不许有幽灵条目；
//   (b) 主对话工具面里的每个 `contact_*` 名字都落在某个分组里 —— 不许有藏起来的能力；
//   (c) 真实 `contact_governance` run 里的 `contact_*` 面 == 表里 `governance:true` 的那批
//       —— 抽屉那句「标『写（轻）』的三件治理扫描一件都拿不到」有闸盯着。
//
// 🔴 抽取失败必须红：任一真实面算出来是空集（cfg 写坏 / 装配路径改名），必须 fail，不能
// 让下面的 forEach 因为空集而平凡通过。
//
// 非 `contact_*` 的工具**有意**不在本清单管辖内：治理 run 还带着邮件 / 检索 / 日历一大批
// 读工具，而这个 tab 讲的是「通讯录这件事被做成了哪几件工具」，不是那次 run 的全集。闸按
// `CONTACT_TOOL_NAME_PREFIX` 圈定比对面。

import { describe, expect, test } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { runHeadlessAgent } from '../../src/ai-gateway/agentRun'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { buildGatewayTools } from '../../src/ai-gateway/tools'
import type { MailAgentDomainClient } from '../../src/ai-gateway/python/domainClient'
import type { AgentRunSpec } from '../../src/shared/api/types'
import {
  CONTACT_TOOL_FACE_GROUPS,
  CONTACT_TOOL_FACE_TOOLS,
  CONTACT_TOOL_NAME_PREFIX
} from '../../src/shared/lib/contactToolFace'

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 }
}

/** 捕获真正递给 streamText 的工具名（= 模型实际看得见的能力面）。 */
function captureToolsModel(sink: string[][]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (opts) => {
      sink.push((opts.tools ?? []).map((t) => (t as { name: string }).name))
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: '1' },
            { type: 'text-delta' as const, id: '1', delta: 'ok' },
            { type: 'text-end' as const, id: '1' },
            { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE }
          ]
        })
      }
    }
  })
}

function minimalDomain(): MailAgentDomainClient {
  return {
    draftReply: async () => ({ internalId: 5, mailbox: '草稿箱', accountName: 'a', draftId: 'd1' }),
    policyEvaluate: async () => ({ decision: 'ask', rule_id: null })
  } as unknown as MailAgentDomainClient
}

/** 通讯录两个 flag 全开的生产形状装配（其余家族按 `ai_gateway_lifecycle.ts` 的生产默认）。 */
function buildFace(
  contextMode: 'manual_chat' | 'contact_governance',
  agentRunContext?: unknown
): string[] {
  const tools = buildGatewayTools(
    {
      domain: minimalDomain(),
      approvalGuard: new ApprovalGuard(),
      writeToolsEnabled: true,
      calendarToolsEnabled: true,
      contextMode,
      ...(agentRunContext !== undefined ? { agentRunContext } : {})
    } as Parameters<typeof buildGatewayTools>[0],
    []
  )
  return Object.keys(tools).sort()
}

/** 服务端组装出来的治理 run spec（逐键照 `src/contacts/governance.py::assemble_contact_governance_spec`：
 *  allowedTools 恒 []、两个 skill 族、无 grantWeb / grantExec）。 */
function makeGovernanceSpec(): AgentRunSpec {
  return {
    jobId: 9,
    runKind: 'contact_governance',
    agentId: 'contact_governance_agent',
    trigger: { kind: 'schedule', firedAt: '2026-08-19T02:00:00Z' },
    prompt: { taskPrompt: '跑一轮治理扫描' },
    model: 'claude-sonnet-4-6',
    toolPolicy: { allowedTools: [], skills: ['email', 'search'] } as AgentRunSpec['toolPolicy'],
    budget: { maxRunSeconds: 1800 },
    sessionTitle: '通讯录治理扫描'
  } as AgentRunSpec
}

async function realGovernanceFace(): Promise<string[]> {
  const seenTools: string[][] = []
  const cfg: AiGatewayConfig = {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => captureToolsModel(seenTools),
    buildTools: (_collector, _am, mode, agentRunContext) => {
      const tools = buildGatewayTools(
        {
          domain: minimalDomain(),
          approvalGuard: new ApprovalGuard(),
          writeToolsEnabled: true,
          calendarToolsEnabled: true,
          contextMode: mode,
          agentRunContext
        } as Parameters<typeof buildGatewayTools>[0],
        []
      )
      return tools
    },
    persistTurn: () => {}
  } as unknown as AiGatewayConfig

  await runHeadlessAgent(
    cfg,
    { jobId: 9, spec: makeGovernanceSpec(), sessionId: null },
    new AbortController().signal
  )
  expect(seenTools.length, 'streamText 一次都没被调到 —— 闸失效了，不是"工具面为空"').toBe(1)
  return [...(seenTools[0] as string[])].sort()
}

const contactsOnly = (names: readonly string[]): string[] =>
  names.filter((name) => name.startsWith(CONTACT_TOOL_NAME_PREFIX)).sort()

describe('contactToolFace 叶子 ↔ 真实工具面（防说谎闸）', () => {
  test('两个真实面都非空 —— 抽取失败必须红，不许平凡通过', async () => {
    const manual = contactsOnly(buildFace('manual_chat'))
    expect(
      manual.length,
      '主对话的 contact_* 面是空集 —— 装配路径断了，下面的比对会平凡通过'
    ).toBeGreaterThan(0)

    const governance = contactsOnly(await realGovernanceFace())
    expect(
      governance.length,
      '治理 run 的 contact_* 面是空集 —— 这不是一次真正的治理 run（连提案通道都没有）'
    ).toBeGreaterThan(0)
    expect(governance, '治理扫描唯一的产出通道不在面里').toContain('contact_propose_update')
  })

  test('(a) 清单里的每个工具都真的在主对话工具面里 —— 不许有幽灵条目', () => {
    const manual = new Set(buildFace('manual_chat'))
    const ghosts = CONTACT_TOOL_FACE_TOOLS.filter((name) => !manual.has(name))
    expect(
      ghosts,
      '这些工具名列在 contactToolFace.ts 里，但 gateway 根本不注册它们 —— ' +
        '界面在向 owner 承诺不存在的能力。删掉它们，或者去查为什么没被注册。'
    ).toEqual([])
  })

  test('(b) 主对话面里的每个 contact_* 工具都落在某个分组里 —— 不许有藏起来的能力', () => {
    const listed = new Set(CONTACT_TOOL_FACE_TOOLS)
    const hidden = contactsOnly(buildFace('manual_chat')).filter((name) => !listed.has(name))
    expect(
      hidden,
      'gateway 真的注册了这些通讯录工具，但治理台一个字都没提 —— 界面少说了能力。' +
        '把它们补进 contactToolFace.ts 的某个分组（并补上 contacts.agent.desc.<name> 两个 locale）。'
    ).toEqual([])
  })

  test('(c) 治理 run 真实拿得到的 contact_* == 叶子标了 governance 的那批', async () => {
    const claimed = CONTACT_TOOL_FACE_GROUPS.filter((group) => group.governance)
      .flatMap((group) => group.tools)
      .sort()
    expect(claimed, '叶子里一个分组都没标 governance —— 下面的比对会平凡通过').not.toEqual([])

    expect(
      contactsOnly(await realGovernanceFace()),
      '治理扫描真实拿得到的通讯录工具，与叶子里标着 `governance: true` 的那批对不上。' +
        '对不上就意味着抽屉那句「治理扫描一件写工具都拿不到」是假的：要么它其实拿得到写工具' +
        '（安全回归，去看 policy.ts 的 contact_governance 行），要么某件读/提案工具其实进不去' +
        '（界面在承诺一件扫描用不上的能力）。'
    ).toEqual(claimed)
  })

  test('分组表自身自洽：权限档唯一、无重复工具名、写档不进治理场地', () => {
    const permissions = CONTACT_TOOL_FACE_GROUPS.map((group) => group.permission)
    expect(new Set(permissions).size, '权限档撞名 → i18n 会取到同一条文案').toBe(permissions.length)
    expect(
      new Set(CONTACT_TOOL_FACE_TOOLS).size,
      '同一个工具名出现在两个分组里 → 界面会列两遍'
    ).toBe(CONTACT_TOOL_FACE_TOOLS.length)
    expect(
      CONTACT_TOOL_FACE_GROUPS.filter((group) => !group.governance).map((group) => group.permission)
    ).toEqual(['write'])
  })
})
