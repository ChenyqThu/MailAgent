// 08-31 执行台账 — agent_run_step → UIMessage 合成器（runTranscript.ts）。
//
// 🔴 恒绿陷阱两处，写用例时必须避开：
//   ① 排序：fixture 的 seq 必须**乱序**给，否则去掉 sort 结果一样。
//   ② 空态：「只有 trig」的用例才测得到「trig 不进消息流」——有别的节点时返回值非空，
//      把 trig 也塞进消息流照样通过。

import { describe, expect, test } from 'vitest'

import type { AgentRunStep } from '@shared/api/types'
import { runStepsToUIMessages } from '../../../src/shared/components/agents/team/runTranscript'

function step(over: Partial<AgentRunStep> & Pick<AgentRunStep, 'seq' | 'kind'>): AgentRunStep {
  return over as AgentRunStep
}

/** 合成结果恒是 0 或 1 条 assistant 消息；取它的 parts。 */
function partsOf(steps: AgentRunStep[]): Array<Record<string, unknown>> {
  const messages = runStepsToUIMessages(steps)
  return (messages[0]?.parts ?? []) as unknown as Array<Record<string, unknown>>
}

describe('runStepsToUIMessages — 逐 kind 形状', () => {
  test('think → reasoning part（现成 collapsible 渲染）', () => {
    expect(partsOf([step({ seq: 1, kind: 'think', detail: '正文 184KB 塞不进去' })])).toEqual([
      { type: 'reasoning', text: '正文 184KB 塞不进去' }
    ])
  })

  test('out → text part', () => {
    expect(partsOf([step({ seq: 1, kind: 'out', detail: '写了 12 条进展' })])).toEqual([
      { type: 'text', text: '写了 12 条进展' }
    ])
  })

  test('tool 成功 → tool-<name> / output-available，payload.input 当请求参数', () => {
    const parts = partsOf([
      step({
        seq: 1,
        kind: 'tool',
        name: 'search_emails',
        payload: { input: { q: 'W35' }, output: '命中 4 封' },
        ok: true,
        ms: 820
      })
    ])
    expect(parts).toEqual([
      {
        type: 'tool-search_emails',
        toolCallId: 'run-step-1',
        input: { q: 'W35' },
        state: 'output-available',
        // 耗时并进结果块：ToolTraceCard 的行内秒表只跟 live part。
        output: { result: '命中 4 封', durationMs: 820 }
      }
    ])
  })

  test('tool 失败 → output-error（ToolTraceCard 据此标 ✗ + fail 色），detail 当 errorText', () => {
    const parts = partsOf([
      step({
        seq: 1,
        kind: 'tool',
        name: 'schema_check',
        detail: '缺列「负责人」→ 整批跳过',
        ok: false
      })
    ])
    expect(parts[0]).toMatchObject({
      type: 'tool-schema_check',
      state: 'output-error',
      errorText: '缺列「负责人」→ 整批跳过'
    })
    expect(parts[0]).not.toHaveProperty('output')
  })

  test('payload 没有 input/output 两键时整块当请求参数，detail 当结果', () => {
    const parts = partsOf([
      step({
        seq: 1,
        kind: 'tool',
        name: 'fetch_xlsx',
        payload: { file: 'W35.xlsx' },
        detail: 'ok'
      })
    ])
    expect(parts[0]).toMatchObject({ input: { file: 'W35.xlsx' }, output: 'ok' })
  })
})

describe('runStepsToUIMessages — trig 不进消息流', () => {
  test('只有 trig → 空数组（调用方据此走「没有输出」分支，不挂 AgentThread）', () => {
    expect(runStepsToUIMessages([step({ seq: 1, kind: 'trig', detail: '收信触发' })])).toEqual([])
  })

  test('trig 与别的节点混排时也不产生 part（气泡单源在 run 行）', () => {
    const parts = partsOf([
      step({ seq: 1, kind: 'trig', detail: '收信触发' }),
      step({ seq: 2, kind: 'out', detail: '完成' })
    ])
    expect(parts).toEqual([{ type: 'text', text: '完成' }])
  })

  test('零步骤 → 空数组', () => {
    expect(runStepsToUIMessages([])).toEqual([])
  })
})

describe('runStepsToUIMessages — 按 seq 排', () => {
  test('输入乱序（3,1,2）仍按 seq 升序合成', () => {
    const parts = partsOf([
      step({ seq: 3, kind: 'out', detail: 'C' }),
      step({ seq: 1, kind: 'think', detail: 'A' }),
      step({ seq: 2, kind: 'tool', name: 'x', detail: 'B' })
    ])
    expect(parts.map((p) => p.type)).toEqual(['reasoning', 'tool-x', 'text'])
  })
})

describe('runStepsToUIMessages — 不走 AI 的成员天然没有思考块', () => {
  test('项目周报形态（触发 > 工具 ×2 > 输出）合成后没有 reasoning part', () => {
    const parts = partsOf([
      step({ seq: 1, kind: 'trig', detail: '收到邮件《W35 项目周报》' }),
      step({ seq: 2, kind: 'tool', name: 'parse_xlsx', detail: '解析 38 行', ok: true }),
      step({ seq: 3, kind: 'tool', name: 'notion_upsert', detail: '写入 12 个项目', ok: true }),
      step({ seq: 4, kind: 'out', detail: '新建 3 · 更新 9' })
    ])
    expect(parts.map((p) => p.type)).toEqual(['tool-parse_xlsx', 'tool-notion_upsert', 'text'])
  })
})
