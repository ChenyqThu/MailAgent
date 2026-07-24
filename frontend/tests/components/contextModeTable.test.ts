// trigger.kind → headless context_mode 的**镜像表一致性**测试。
//
// 这张表有三处实现，必须同批改（见 `src/shared/api/types/chat.ts` AgentRunSpec.trigger.kind
// 的注释）：
//   1. ai-gateway/agentRun.ts::deriveContextMode                     —— 运行时求值
//   2. components/agents/custom-agent/shared.tsx::deriveHeadlessMode —— UI 展示 / dormant 判定
//   3. src/api/routers/agent.py::_derive_rule_context_mode           —— Python，建规盖章
//
// 🔴 失配的后果不是"显示不好看"：规则的 context_mode 是 Python 在**创建时**盖的章，
// gateway 按自己那张表求值，双键 (context_mode, agent_id) 对不上 → owner 配的免卡规则
// **永不命中**，每个动作恒 HITL。
//
// 本文件锁前两处（同一语言，可直接互相断言）；第 3 处由 Python 侧
// `tests/api/test_agent_policy_peragent.py::test_peragent_create_schedule_agent_derives_cron_headless`
// 锁。两边 docstring 互相指向。
//
// 断言方式刻意选「两个实现对同一输入必须同答」而不是各写各的期望值 —— 后者两边一起写错
// 仍会全绿，前者不会。
import { describe, expect, test } from 'vitest'

import { deriveContextMode } from '../../src/ai-gateway/agentRun'
import { deriveHeadlessMode } from '@shared/components/agents/custom-agent/shared'
import type { AgentRunSpec } from '@shared/api/types'

function specOf(kind: string): AgentRunSpec {
  return {
    jobId: 1,
    agentId: 'a',
    trigger: { kind, firedAt: '2026-07-24T00:00:00Z' },
    prompt: { taskPrompt: 'x' }
  } as AgentRunSpec
}

/** 表的全部输入面：三个已知 kind + 未知/缺失。 */
const KNOWN_KINDS = ['cron', 'schedule', 'email_filter'] as const

describe('context_mode 镜像表 — 期望值', () => {
  test('cron | schedule → cron_headless（定时族，输入无攻击者可控内容）', () => {
    expect(deriveContextMode(specOf('cron'))).toBe('cron_headless')
    expect(deriveContextMode(specOf('schedule'))).toBe('cron_headless')
  })

  test('email_filter → untrusted_trigger（邮件正文是攻击者可控的）', () => {
    expect(deriveContextMode(specOf('email_filter'))).toBe('untrusted_trigger')
  })

  test('未知 / 缺失 kind → untrusted_trigger（fail-closed，最严）', () => {
    expect(deriveContextMode(specOf('weird'))).toBe('untrusted_trigger')
    expect(
      deriveContextMode({
        ...specOf('cron'),
        trigger: undefined as unknown as AgentRunSpec['trigger']
      })
    ).toBe('untrusted_trigger')
  })
})

describe('context_mode 镜像表 — 两处 TS 实现必须同答', () => {
  for (const kind of KNOWN_KINDS) {
    test(`kind='${kind}'：gateway 求值 === UI 展示`, () => {
      expect(deriveHeadlessMode(kind)).toBe(deriveContextMode(specOf(kind)))
    })
  }

  // 未知 kind 是两者**有意**分岔的唯一一处，写清楚免得后人"顺手统一"：
  // gateway 必须 fail-closed 给出一个真实模式（跑起来要有收窄），UI 侧返回 null 是为了
  // 渲染「未配置触发（规则将处于休眠）」而不是谎称该 agent 跑在某个模式下。
  test('未知 kind：gateway fail-closed 成 untrusted_trigger，UI 侧 null（有意分岔）', () => {
    expect(deriveContextMode(specOf('weird'))).toBe('untrusted_trigger')
    expect(deriveHeadlessMode('weird')).toBe(null)
    expect(deriveHeadlessMode(null)).toBe(null)
  })
})
