// WP-15「context 环」取数（task 08-05）—— 落库的 `contextTokens` 必须是**末 step 的 inputTokens**。
//
// 这里钉的是一条会静默出错的语义：ai@7 的 `result.usage` 是**多 step 求和**
// （node_modules/ai/dist/index.d.ts: "When there are multiple steps, the usage is the sum of all
// step usages"）。用它当「上下文占用」在纯文本回合里看起来完全正确（1 个 step，两者相等），
// 一旦回合里跑了工具就开始虚报 —— 每多一个 step，同一段 prompt 就被再计一遍。所以下面这个
// 两 step 的用例是**唯一**能把两者区分开的形状：sum=350 而真实占用=250。
//
// 手法抄 length_finish_warning.test.ts：真 streamText 走 startAiGatewayServer + MockLanguageModelV3，
// 不打真 provider。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream, tool, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import { lastStepContextTokens } from '../../src/ai-gateway/chatRun'
import type { PersistTurnInput } from '../../src/ai-gateway/config'

const handles: AiGatewayHandle[] = []
async function start(cfg: Parameters<typeof startAiGatewayServer>[0]): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

/** LanguageModelV3 的 usage 形状（inputTokens 是 prompt **总**数，noCache/cacheRead 只是细分）。 */
function usage(inputTotal: number, outputTotal: number): Record<string, unknown> {
  return {
    inputTokens: { total: inputTotal, noCache: inputTotal, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTotal, text: outputTotal, reasoning: 0 }
  }
}

const CHAT_CFG = {
  port: 0,
  baseUrl: 'https://crs.example/api',
  apiKey: 'sk-test-key',
  model: 'claude-sonnet-4-6'
} as const

function userTurn(text: string): unknown {
  return [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }]
}

async function drain(res: Response): Promise<void> {
  const reader = res.body!.getReader()
  for (;;) {
    const { done } = await reader.read()
    if (done) break
  }
}

describe('lastStepContextTokens — 末 step 语义（纯函数）', () => {
  test('空 / 缺席 → null（= 前端不渲染，绝不当 0）', () => {
    expect(lastStepContextTokens(undefined)).toBeNull()
    expect(lastStepContextTokens(null)).toBeNull()
    expect(lastStepContextTokens([])).toBeNull()
  })

  test('单 step → 就是它自己', () => {
    expect(lastStepContextTokens([{ usage: { inputTokens: 91_234 } }])).toBe(91_234)
  })

  test('多 step → 取**最后**一个，不是求和、也不是首个', () => {
    const steps = [
      { usage: { inputTokens: 100 } },
      { usage: { inputTokens: 180 } },
      { usage: { inputTokens: 250 } }
    ]
    expect(lastStepContextTokens(steps)).toBe(250)
    // 求和（530）与首个（100）都是曾经踩过的写法 —— 明确断言它们**不是**返回值。
    expect(lastStepContextTokens(steps)).not.toBe(530)
    expect(lastStepContextTokens(steps)).not.toBe(100)
  })

  test('两段式回合（审批暂停 → resume）：resume run 的 steps 只含 resume 段，取它的末 step', () => {
    // 暂停那一段**根本不落库**（makePersistOnFinish 在 responseMessageAwaitsApproval 处早退），
    // resume 是另一次 streamText，`result.steps` 因此只有 resume 段的 step；而 resume 的 prompt
    // 已经带上原始历史 + 暂停的 tool call + 其执行结果 —— 末 step 就是那一刻的完整上下文。
    // 🔴 跨段求和会把同一段历史计两次，故这里**只**看当前 run 的数组。
    const pausedSegmentSteps = [{ usage: { inputTokens: 4_000 } }] // 落库时压根拿不到这一段
    const resumeRunSteps = [{ usage: { inputTokens: 4_600 } }, { usage: { inputTokens: 5_100 } }]
    expect(lastStepContextTokens(resumeRunSteps)).toBe(5_100)
    expect(lastStepContextTokens(pausedSegmentSteps)).toBe(4_000)
    // 两段相加（9_100 / 9_700）是错的形状 —— 顺手钉住，防有人"顺便修"成累加。
    expect(lastStepContextTokens(resumeRunSteps)).not.toBe(9_100)
  })

  test('末 step 没报 usage / 非有限数 → null（不回退到更早的 step —— 那是个更小的陈旧值）', () => {
    expect(lastStepContextTokens([{ usage: { inputTokens: 100 } }, {}])).toBeNull()
    expect(lastStepContextTokens([{ usage: { inputTokens: undefined } }])).toBeNull()
    expect(lastStepContextTokens([{ usage: { inputTokens: Number.NaN } }])).toBeNull()
    expect(lastStepContextTokens([{ usage: { inputTokens: -1 } }])).toBeNull()
  })
})

describe('落库的 contextTokens（真 streamText）', () => {
  test('工具循环回合：contextTokens = 末 step 的 inputTokens，而 usage.inputTokens 是求和', async () => {
    const persisted: PersistTurnInput[] = []
    let call = 0
    const h = await start({
      ...CHAT_CFG,
      createModel: () =>
        new MockLanguageModelV3({
          doStream: async () => {
            call++
            if (call === 1) {
              return {
                stream: simulateReadableStream({
                  chunks: [
                    { type: 'stream-start' as const, warnings: [] },
                    {
                      type: 'tool-call' as const,
                      toolCallId: 'tc1',
                      toolName: 'test_read',
                      input: '{}'
                    },
                    {
                      type: 'finish' as const,
                      finishReason: { unified: 'tool-calls' as const },
                      usage: usage(100, 10)
                    }
                  ]
                })
              }
            }
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start' as const, warnings: [] },
                  { type: 'text-start' as const, id: '1' },
                  { type: 'text-delta' as const, id: '1', delta: 'done' },
                  { type: 'text-end' as const, id: '1' },
                  {
                    type: 'finish' as const,
                    finishReason: { unified: 'stop' as const },
                    usage: usage(250, 20)
                  }
                ]
              })
            }
          }
        }),
      buildTools: (): ToolSet => ({
        test_read: tool({
          description: 'test-only read tool',
          inputSchema: z.object({}),
          execute: async () => ({ ok: true })
        })
      }),
      persistTurn: (turn) => {
        persisted.push(turn)
      }
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: userTurn('read it') })
    })
    await drain(res)
    await vi.waitFor(() => expect(persisted.length).toBe(1))
    expect(call).toBe(2) // 真的跑了两个 step，否则本用例区分不出两种语义
    expect(persisted[0].contextTokens).toBe(250)
    // 对照：既有的 usage 列仍是求和（语义不变，这正是不能复用它画环的原因）。
    expect(persisted[0].usage?.inputTokens).toBe(350)
  })

  test('单 step 纯文本回合：两者相等（不回归既有 usage 语义）', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start({
      ...CHAT_CFG,
      createModel: () =>
        new MockLanguageModelV3({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                { type: 'text-start' as const, id: '1' },
                { type: 'text-delta' as const, id: '1', delta: 'hi' },
                { type: 'text-end' as const, id: '1' },
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'stop' as const },
                  usage: usage(1_234, 5)
                }
              ]
            })
          })
        }),
      persistTurn: (turn) => {
        persisted.push(turn)
      }
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: userTurn('hi') })
    })
    await drain(res)
    await vi.waitFor(() => expect(persisted.length).toBe(1))
    expect(persisted[0].contextTokens).toBe(1_234)
    expect(persisted[0].usage?.inputTokens).toBe(1_234)
  })
})
