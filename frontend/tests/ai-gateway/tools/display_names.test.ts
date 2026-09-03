// 工具 description 的中文名注入闸（buildGatewayTools 末尾的唯一 choke point）。
//
// 三件事：
//   (a) 装配出来的每个工具，只要有中文名，description 就以「中文名」开头、后面原样接着原
//       英文 description（模型看到的那一份）；
//   (b) 「注册工具中缺中文名」的名单为空 —— 新工具族落地时忘了补 i18n + 叶子表要红，否则
//       用户说中文时模型接不上那件工具，而且不报错、不空白，是最难发现的那种漏；
//   (c) 表里没有的名字（MCP connector 的 `mcp__*` 动态工具）description 原样不动。
//
// 🔴 抽取失败必须红：装配面算出来是空集（flag 列表漏了 / 装配路径改名）必须 fail，不能让
//    「缺名名单为空」因为「一个工具都没看到」而平凡通过。

import { describe, expect, test } from 'vitest'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import { applyToolDisplayNames } from '../../../src/ai-gateway/tools/display_names'
import { createMatterReadTools } from '../../../src/ai-gateway/tools/matters'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { TOOL_DISPLAY_NAMES_ZH } from '../../../src/shared/assistant/toolDisplayNames'
import { fakeGroupHooks, mockDomain, okEnvelope } from './_helpers'

/** FULL 装配面（每个 flag 全开）—— 与 policy.test / skill_gating.test 的 buildAllTools 同一份
 *  flag 清单（🔴 新增 tool-gating flag 时三处一起改，否则新工具族不在这道闸的视野里）。 */
function buildAllTools(): ToolSet {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    // 🔴 显式 manual_chat：缺省是 fail-closed 的 'untrusted_trigger'，会把 capability_change /
    // exec / outbound 三类连同 manual-only 的群工具全过滤掉 —— 那样这道闸只能看见三分之二的
    // 工具面，缺名的那批正好躲在被过滤掉的那部分里。
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

/** 跟进 run / 行动项 dispatch run 的装配面：`matter_update_propose` 与 `matter_item_report`
 *  只在这两处注册（需要服务端装配的锚），manual 全开集里永远看不到它们。 */
function buildAnchoredTools(): ToolSet[] {
  const common = {
    domain: mockDomain(() => okEnvelope([])),
    approvalGuard: new ApprovalGuard(),
    contextMode: 'matter_followup' as const
  }
  return [
    buildGatewayTools({
      ...common,
      agentRunContext: {
        agentId: 'matter:MAT-000042',
        allowedTools: [],
        skills: [],
        matterRun: { matterId: 42, publicId: 'MAT-000042', runId: 7 }
      }
    }),
    buildGatewayTools({
      ...common,
      agentRunContext: {
        agentId: 'matter_item:MAT-000042:9',
        allowedTools: [],
        skills: [],
        matterItemRun: { matterId: 42, publicId: 'MAT-000042', itemId: 9, dispatchId: 3 }
      }
    })
  ]
}

describe('tool description — 中文显示名注入', () => {
  test('canary — FULL 装配面真的是全的（每个会被 mode 过滤掉的类都有代表在场）', () => {
    const names = new Set(Object.keys(buildAllTools()))
    expect(names.size).toBeGreaterThan(90)
    // 少一个 flag / 走错 contextMode 时装配面会缩水成 read+domain_write 的三分之二，光看
    // 数量看不出来 —— 这里按类各钉一个代表：capability_change / exec / outbound / manual-only。
    for (const sentinel of [
      'email_get',
      'internal_agent_update',
      'run_command',
      'web_search',
      'notion_agent_chat',
      'submit_feedback',
      'group_create',
      'suggest_followups'
    ]) {
      expect(names.has(sentinel), `FULL 装配面缺 ${sentinel}`).toBe(true)
    }
  })

  test('注册工具中缺中文名的名单为空', () => {
    const names = new Set<string>()
    for (const set of [buildAllTools(), ...buildAnchoredTools()]) {
      for (const name of Object.keys(set)) names.add(name)
    }
    const missing = [...names].filter((name) => !(name in TOOL_DISPLAY_NAMES_ZH))
    expect(
      missing,
      '这些工具的 description 里没有中文名，用户说中文时模型接不上。补两个 locale 的 ' +
        'chat.toolTitle + TOOL_DISPLAY_NAMES_ZH：\n  ' +
        missing.join('\n  ')
    ).toEqual([])
  })

  test('每个工具的 description 以「中文名」开头，后面接原英文 description', () => {
    for (const [name, t] of Object.entries(buildAllTools())) {
      const zh = TOOL_DISPLAY_NAMES_ZH[name]
      if (!zh) continue
      const desc = String(t.description ?? '')
      expect(desc.startsWith(`「${zh}」`), `${name}: ${desc.slice(0, 40)}`).toBe(true)
      expect(desc.slice(zh.length + 2).length, `${name} 的英文 description 没了`).toBeGreaterThan(
        10
      )
    }
  })

  test('注入形状按名字取值 —— matter_find 拿到的是「检索事项」+ 原文', () => {
    const original = String(
      createMatterReadTools(mockDomain(() => okEnvelope([]))).matter_find.description
    )
    expect(buildAllTools().matter_find.description).toBe(`「检索事项」${original}`)
    expect(original.startsWith('「')).toBe(false)
  })
})

describe('applyToolDisplayNames — 表外的工具原样不动', () => {
  const fake = (description: string) => tool({ description, inputSchema: z.object({}) })

  test('有名字的加前缀，没名字的（mcp__* 动态工具）不动', () => {
    const out = applyToolDisplayNames({
      email_get: fake('Read one email.'),
      mcp__notion__notion_search: fake('Search a Notion workspace.')
    })
    expect(out.email_get.description).toBe('「读取邮件」Read one email.')
    expect(out.mcp__notion__notion_search.description).toBe('Search a Notion workspace.')
  })

  test('输入 ToolSet 不被改写（同一个 tool 对象仍是原 description）', () => {
    const input = { email_get: fake('Read one email.') }
    applyToolDisplayNames(input)
    expect(input.email_get.description).toBe('Read one email.')
  })
})
