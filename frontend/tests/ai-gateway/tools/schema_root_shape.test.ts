// task 09-02 — 每个 gateway 工具的入参 JSON Schema 根节点必须是一个 object。
//
// 起因：DeepSeek（以及任何走 OpenAI 兼容严格校验的上游）会**整请求**拒绝一份根节点没有
// `type` 的工具 schema —— `schema must be a JSON Schema of type "object", got type: null`。
// 于是一个工具的 schema 形状不对，整个 chat 就报「响应出错」，与那个工具用没用上无关。
//
// 触发条件是纯结构性的：zod 的 `z.discriminatedUnion(...)` / `z.union(...)` 作为**根**时，
// `z.toJSONSchema` 产出 `{$schema, oneOf:[...]}` —— 没有 `type`。ai@7 的
// `asSchema(tool.inputSchema).jsonSchema` 就是 provider 拿到的那份 JSON Schema（本闸走的正是
// 这一条），所以这里断言的形状与上游真正收到的逐字相同。同样的写法**嵌在字段里**是合法的
// （那时它不是根节点），故本闸只看根。
//
// 🔴 覆盖面 = 静态装配的全量工具：manual 全开一份 + 三种 run-context-only 的装配（它们的工具
// 结构上只在自己的 venue 里注册）。运行时发现的 MCP connector 工具（`mcp__*`）不在此列 —— 它们
// 的 schema 来自外部 manifest，不是本仓的源码。

import { describe, expect, test } from 'vitest'

import { asSchema, type Tool, type ToolSet } from 'ai'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { fakeGroupHooks, mockDomain, okEnvelope } from './_helpers'

/** manual chat 里每个 flag 都打开的一份（policy.test.ts 的 buildAllTools 同款入参；
 *  🔴 新增一个工具门控 flag 时这里也要跟上，否则新工具不在本闸的视野里）。 */
function buildAllTools(): ToolSet {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    contextMode: 'manual_chat',
    writeToolsEnabled: true,
    approvalGuard: new ApprovalGuard(),
    sendToolEnabled: true,
    sendSigningSecret: 'secret',
    skillGatingEnabled: true,
    sessionToolsEnabled: true,
    configToolsEnabled: true,
    webToolsEnabled: true,
    execToolsEnabled: true,
    skillInstallToolsEnabled: true,
    customAgentToolsEnabled: true,
    internalAgentToolsEnabled: true,
    skillCreatorToolsEnabled: true,
    customAgentCallEnabled: true,
    parentSessionId: 1,
    findSessionByParentToolCall: () => null,
    createAgentCallSession: () => 2,
    setAgentSessionJobId: () => undefined,
    calendarToolsEnabled: true,
    notionAgentToolsEnabled: true,
    submitFeedback: async () => ({ submissionBlockId: 'blk-test' }),
    groupTools: { enabled: true, isGroupSession: false, hooks: fakeGroupHooks(), sessionId: 1 }
  })
}

/** 事项跟进 run 专有的 `matter_update_propose`（需要服务端装配的 Matter+run 锚点）。 */
function buildMatterRunTools(): ToolSet {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    approvalGuard: new ApprovalGuard(),
    contextMode: 'matter_followup',
    agentRunContext: {
      agentId: 'matter:MAT-000042',
      allowedTools: [],
      skills: [],
      matterRun: { matterId: 42, publicId: 'MAT-000042', runId: 7 }
    }
  })
}

/** 行动项 dispatch run 专有的 `matter_item_report`（同上，换一个锚点）。 */
function buildItemRunTools(): ToolSet {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    approvalGuard: new ApprovalGuard(),
    contextMode: 'matter_followup',
    agentRunContext: {
      agentId: 'matter_item:MAT-000042:9',
      allowedTools: [],
      skills: [],
      matterItemRun: { matterId: 42, publicId: 'MAT-000042', itemId: 9, dispatchId: 3 }
    }
  })
}

/** headless + 会话溯源 grant 才注册的 `agent_catalog_*`。 */
function buildCatalogTools(): ToolSet {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    approvalGuard: new ApprovalGuard(),
    contextMode: 'cron_headless',
    sessionToolsEnabled: true,
    sessionProvenanceEnabled: true,
    agentRunContext: { agentId: 'a', allowedTools: ['chat_session_list'], skills: [] }
  })
}

/** 名字 → 工具（同名以先出现的为准；四份装配之间本就不该有形状不同的同名工具）。 */
function everyRegisteredTool(): Map<string, Tool> {
  const all = new Map<string, Tool>()
  for (const set of [
    buildAllTools(),
    buildMatterRunTools(),
    buildItemRunTools(),
    buildCatalogTools()
  ]) {
    for (const [name, tool] of Object.entries(set)) {
      if (!all.has(name)) all.set(name, tool)
    }
  }
  return all
}

/** 根节点上出现即致命的组合子 —— 它们都会把根的 `type` 挤掉。 */
const ROOT_COMBINATORS = ['anyOf', 'oneOf', 'allOf', 'not'] as const

describe("every gateway tool's input JSON Schema is rooted at an object", () => {
  test('the assembly is the real thing (sanity: not an empty ToolSet)', () => {
    expect(everyRegisteredTool().size).toBeGreaterThan(80)
  })

  test('🔴 root type === "object" and no root-level anyOf/oneOf/allOf/not', () => {
    const offenders: { tool: string; type: unknown; combinators: string[] }[] = []
    for (const [name, tool] of everyRegisteredTool()) {
      // provider 拿到的就是这一份（ai@7 → @ai-sdk/provider-utils → zod 的 toJSONSchema）。
      const jsonSchema = asSchema(tool.inputSchema).jsonSchema as Record<string, unknown>
      const combinators = ROOT_COMBINATORS.filter((key) => key in jsonSchema)
      if (jsonSchema.type !== 'object' || combinators.length > 0) {
        offenders.push({ tool: name, type: jsonSchema.type ?? null, combinators })
      }
    }
    // 空数组比较：红的时候直接把工具名 + 实际根形状印出来。
    expect(offenders).toEqual([])
  })
})
