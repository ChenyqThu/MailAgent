// 0812 dogfood Lane C — 「跟进 Agent 工具面清单」防说谎闸。
//
// 配置弹窗按 `@shared/lib/matterToolFace` 的分组表把工具列给 owner 看。那张表是**说明书**，
// 权威是 gateway 真实装配出来的 ToolSet。二者一漂开，界面就开始撒谎，而且是最难发现的那种谎
// （既不报错也不空白，只是少说/多说一件事）。所以这里驱动**真实**的 runHeadlessAgent +
// buildGatewayTools（照 agent_run.test.ts 的 EXPECTED_MATTER_FACE 构造方式），双向断言：
//   (a) 表里的每个名字都真的在工具面里 —— 不许有幽灵条目；
//   (b) 工具面里的每个名字都落在某个分组里 —— 不许有藏起来的能力。
//
// 🔴 抽取失败必须红：若真实工具面算出来是空集（cfg 写坏 / 装配路径改名），必须 fail，
// 不能让 (a)(b) 两个 forEach 因为空集而平凡通过。
//
// 两类**有意排除**，在下面各自的断言处写清了理由：
//   · connector 动态工具（`mcp__*`）—— 运行时按已连接 connector 注册、名字来自远端 manifest，
//     结构上进不了静态清单；界面按「已连接哪几家」动态渲染。闸按前缀排除，另有一条专门的
//     测试证明它确实被这条规则接住（而不是"恰好没出现"）。
//   · web 两件 —— 在表里，但归在唯一 `configurable` 的一组（三档由 owner 配）。

import { describe, expect, test, afterEach } from 'vitest'
import { simulateReadableStream, tool, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import { runHeadlessAgent } from '../../src/ai-gateway/agentRun'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { buildGatewayTools } from '../../src/ai-gateway/tools'
import {
  registerRuntimeToolClass,
  resetRuntimeToolClasses
} from '../../src/ai-gateway/tools/policy'
import type { MailAgentDomainClient } from '../../src/ai-gateway/python/domainClient'
import type { AgentRunSpec } from '../../src/shared/api/types'
import {
  isMatterToolGroupAvailable,
  MATTER_TOOL_FACE_DYNAMIC_PREFIX,
  MATTER_TOOL_FACE_GROUPS,
  MATTER_TOOL_FACE_STATIC_TOOLS
} from '../../src/shared/lib/matterToolFace'

afterEach(() => resetRuntimeToolClasses())

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

/** 服务端组装出来的跟进 run spec（形状逐键抄 run_spec.py：allowedTools 恒 []、三个 skill 族、
 *  grantWeb='open'）。 */
function makeMatterSpec(over?: Partial<AgentRunSpec>): AgentRunSpec {
  return {
    jobId: 7,
    runKind: 'matter_followup',
    matter: { id: 42, publicId: 'MAT-000042', title: 'Atlas rollout', runId: 7 },
    agentId: 'matter:MAT-000042',
    trigger: { kind: 'manual', firedAt: '2026-08-12T09:00:00Z' },
    prompt: { taskPrompt: '跟进一下' },
    model: 'claude-sonnet-4-6',
    toolPolicy: {
      allowedTools: [],
      skills: ['email', 'search', 'report'],
      grantWeb: 'open'
    } as AgentRunSpec['toolPolicy'],
    budget: { maxRunSeconds: 1800 },
    sessionTitle: '跟进 · Atlas rollout',
    ...over
  } as AgentRunSpec
}

/**
 * 生产形状的 cfg —— 🔴 每个工具家族的 flag 都按 `ai_gateway_lifecycle.ts` 的**生产默认值**打开
 * （SESSION/CONFIG/WEB/EXEC/SKILL_INSTALL/SKILL_SELF_MOUNT/CALENDAR/MATTERS/... 全是
 * `envBool(..., true)`）。这一点很要紧：agent_run.test.ts 的 EXPECTED_MATTER_FACE 用的是一份
 * **窄** cfg（没开 session/config/self-mount），那份名单少了 chat_session_* / agent_profile_* /
 * discover_skills —— 拿它当"工具面全集"去核对界面清单会漏说 6 件能力。这里要的是 owner 那台机器
 * 上真实的全集，所以 flag 全开。
 *
 * `advertisedSkills` 默认不传（= null → 全局 skill 门 fail-open），因为它是**业务态**（用户在
 * Settings 关某个 skill）而不是跟进 run 的能力边界；per-agent MOUNT 门（spec.skills）照常生效。
 * 🔴 0812 Lane D 起可显式传入 —— 界面要按它把「已关掉的 skill」标出来，故新增一条闸驱动这条
 * 分支（默认不传的调用点语义**一字未改**：`undefined` 才省略这个键）。
 */
function productionShapedCfg(
  seenTools: string[][],
  dynamicTools?: ToolSet,
  advertisedSkills?: readonly string[]
): AiGatewayConfig {
  const guard = new ApprovalGuard()
  return {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => captureToolsModel(seenTools),
    buildTools: (collector, _am, mode, agentRunContext) =>
      buildGatewayTools(
        {
          domain: minimalDomain(),
          approvalGuard: guard,
          writeToolsEnabled: true,
          sendToolEnabled: true,
          sendSigningSecret: 'secret',
          planToolsEnabled: true,
          sessionToolsEnabled: true,
          sessionProvenanceEnabled: true,
          configToolsEnabled: true,
          skillGatingEnabled: true,
          skillInstallToolsEnabled: true,
          skillCreatorToolsEnabled: true,
          execToolsEnabled: true,
          webToolsEnabled: true,
          calendarToolsEnabled: true,
          customAgentToolsEnabled: true,
          customAgentCallEnabled: true,
          notionAgentToolsEnabled: true,
          matterToolsEnabled: true,
          matterAgentEnabled: true,
          contextMode: mode,
          agentRunContext,
          ...(dynamicTools ? { dynamicTools } : {}),
          ...(advertisedSkills !== undefined ? { advertisedSkills } : {})
        },
        collector
      ),
    persistTurn: () => {}
  }
}

async function realMatterToolFace(
  dynamicTools?: ToolSet,
  advertisedSkills?: readonly string[]
): Promise<string[]> {
  const seenTools: string[][] = []
  await runHeadlessAgent(
    productionShapedCfg(seenTools, dynamicTools, advertisedSkills),
    { jobId: 7, spec: makeMatterSpec(), sessionId: null },
    new AbortController().signal
  )
  expect(seenTools.length, 'streamText 一次都没被调到 —— 闸失效了，不是"工具面为空"').toBe(1)
  return [...seenTools[0]].sort()
}

describe('matterToolFace 叶子 ↔ 真实跟进 run 工具面（防说谎闸）', () => {
  test('真实工具面非空 —— 抽取失败必须红，不许平凡通过', async () => {
    const real = await realMatterToolFace()
    // 下限取一个明显低于真实值（当前 30 件）的数：这条断言防的是"装配路径改名 → 空集 →
    // 下面两个 forEach 零轮循环 → 全绿"，不是精确 pin（精确 pin 归 agent_run.test.ts）。
    expect(real.length, '真实工具面是空集 —— 装配路径断了，(a)(b) 会平凡通过').toBeGreaterThan(10)
    expect(real, '连事项自己的提案通道都不在，说明这不是一次真正的跟进 run').toContain(
      'matter_update_propose'
    )
  })

  test('(a) 清单里的每个工具都真的在工具面里 —— 不许有幽灵条目', async () => {
    const real = new Set(await realMatterToolFace())
    const ghosts = MATTER_TOOL_FACE_STATIC_TOOLS.filter((name) => !real.has(name))
    expect(
      ghosts,
      '这些工具名列在 matterToolFace.ts 里，但跟进 run 根本拿不到 —— ' +
        '界面在向 owner 承诺不存在的能力。删掉它们，或者去查为什么它没被注册。'
    ).toEqual([])
  })

  test('(b) 工具面里的每个工具都落在某个分组里 —— 不许有藏起来的能力', async () => {
    const listed = new Set(MATTER_TOOL_FACE_STATIC_TOOLS)
    const hidden = (await realMatterToolFace()).filter(
      (name) =>
        // connector 动态工具**有意**不在静态清单里：名字来自远端 manifest（`mcp__<家>__<工具>`），
        // 随「连了哪几家」变化，写死在叶子里必然过时。界面按已连接行动态渲染这一组。
        !name.startsWith(MATTER_TOOL_FACE_DYNAMIC_PREFIX) && !listed.has(name)
    )
    expect(
      hidden,
      '跟进 run 真实拿得到这些工具，但配置面一个字都没提 —— 界面少说了能力。' +
        '把它们补进 matterToolFace.ts 的某个分组（并补上对应 locale）。'
    ).toEqual([])
  })

  test('分组表自身自洽：id 唯一、无重复工具名、只有 web 一组可改', () => {
    const ids = MATTER_TOOL_FACE_GROUPS.map((g) => g.id)
    expect(new Set(ids).size, '分组 id 撞名 → i18n 会取到同一条文案').toBe(ids.length)
    expect(
      new Set(MATTER_TOOL_FACE_STATIC_TOOLS).size,
      '同一个工具名出现在两个分组里 → 界面会列两遍'
    ).toBe(MATTER_TOOL_FACE_STATIC_TOOLS.length)
    expect(
      MATTER_TOOL_FACE_GROUPS.filter((g) => g.tier === 'configurable').map((g) => g.id)
    ).toEqual(['web'])
  })

  test('🔴 关掉一个 skill：真实工具面里消失的那批 == 叶子里标了该 skill 的那批', async () => {
    // 上面 (a)(b) 两条盯的是「清单内容」；它们看不见的是「清单会不会跟着 Settings 的 skill
    // 开关变」—— 因为它们跑在 advertisedSkills=null 的 fail-open 位上。owner 关掉 email 这
    // 一族后，跟进 run 真的一件都拿不到，而面板此前照旧把它们列成「可用」。这条闸就是那句
    // 「面板会跟着技能开关变」的**唯一**保证：标错归属 / 漏标 / 多标，三种都红。
    const skillGroups = MATTER_TOOL_FACE_GROUPS.filter((g) => g.skill !== undefined)
    const skills = [...new Set(skillGroups.map((g) => g.skill as string))].sort()
    expect(skills, '叶子里一个 skill 归属都没标 —— 下面的循环会零轮平凡通过').not.toEqual([])

    const baseline = await realMatterToolFace(undefined, skills)
    // 全开 == fail-open 面：跟进 spec 只挂 email/search/report（run_spec.MATTER_FOLLOWUP_SKILLS），
    // 所以叶子标过的 skill 集合**就是全部**。将来 spec 多挂一族而叶子没跟上，这里先红。
    expect(
      baseline,
      '把叶子里标过的 skill 全部 advertised 之后，工具面仍与 fail-open 位不同 —— ' +
        '说明还有别的 skill 家族进了跟进 run，但叶子一个字没标（那一族被关掉时界面会继续撒谎）。'
    ).toEqual(await realMatterToolFace())

    for (const skill of skills) {
      const survivors = new Set(
        await realMatterToolFace(
          undefined,
          skills.filter((name) => name !== skill)
        )
      )
      const removed = baseline.filter((name) => !survivors.has(name)).sort()
      const claimed = skillGroups
        .filter((g) => g.skill === skill)
        .flatMap((g) => g.tools)
        .sort()
      expect(claimed, `叶子里没有任何分组标着 skill='${skill}'`).not.toEqual([])
      expect(
        removed,
        `关掉 skill='${skill}' 后真实工具面少掉的工具，与叶子里标着该 skill 的分组对不上。` +
          '对不上就意味着面板的置灰范围是错的：要么把还能用的工具标成了「已关闭」，' +
          '要么把真的拿不到的工具继续列成「可用」。改 GATEWAY_SKILL_TOOLS 时同步改叶子的 skill 字段。'
      ).toEqual(claimed)
    }
  })

  test('advertisedSkills 未知（null）→ 一律判可用，与 gateway 的 fail-open 同侧', () => {
    const gated = MATTER_TOOL_FACE_GROUPS.find((g) => g.skill !== undefined)
    const core = MATTER_TOOL_FACE_GROUPS.find((g) => g.skill === undefined)
    expect(gated && core, '叶子里应当同时存在受门控的组与 core 组').toBeTruthy()
    if (!gated || !core) return
    // 「还没取到」被显示成「已关闭」= 把不知道说成关了，是另一个方向的谎。
    expect(isMatterToolGroupAvailable(gated, null)).toBe(true)
    expect(isMatterToolGroupAvailable(gated, undefined)).toBe(true)
    // []（Python 明确说"一个都没开"）与"缺这一个"才是不可用。
    expect(isMatterToolGroupAvailable(gated, [])).toBe(false)
    expect(isMatterToolGroupAvailable(gated, [gated.skill as string])).toBe(true)
    // core 组不受任何 skill 开关影响。
    expect(isMatterToolGroupAvailable(core, [])).toBe(true)
  })

  test('connector 动态工具走前缀规则被接住（而不是"恰好没出现"）', async () => {
    // 照 createConnectorTools 的方式注册运行时 class：read 的会进面（grantConnectors 读天花板），
    // 名字带 mcp__ 前缀 → (b) 的前缀规则应当接住它，不该被判成"藏起来的能力"。
    resetRuntimeToolClasses()
    registerRuntimeToolClass('mcp__notion__notion_fetch', 'read')
    const donor = tool({ description: 'd', inputSchema: z.object({}), execute: async () => ({}) })
    const real = await realMatterToolFace({ mcp__notion__notion_fetch: donor })
    expect(real, 'connector 只读工具本就该进跟进 run 的面').toContain('mcp__notion__notion_fetch')
    const listed = new Set(MATTER_TOOL_FACE_STATIC_TOOLS)
    const hidden = real.filter(
      (name) => !name.startsWith(MATTER_TOOL_FACE_DYNAMIC_PREFIX) && !listed.has(name)
    )
    expect(hidden, 'connector 工具应被前缀规则排除，其余仍不许有漏网').toEqual([])
  })
})
