// 0903 dogfood 收尾 —— 「一轮结束了」这件事收敛到一个点上。
//
// 排队追问的 drain 原本挂在 makePersistOnFinish 的**末尾**：只有跑到收尾回调的那些终止会 drain。
// 实测（本文件第一组用例）上游报错其实是走到 onFinish 的，真正漏掉的是 abort 与 drain 自己抛的
// 那些路径 —— 那条路上排着的追问会无限期躺在队列里，直到用户下次手动发消息或重启 app。
// 触发点因此下沉到 ActiveRunRegistry.release()：chat 的三条排干路径、/decide resume、headless
// agent run、群调度器，全都在终止时经过那一行，而 stop() 有意不通知（那条路由 /run/stop 与
// interrupt 端点自己负责）。

import { afterEach, describe, expect, test } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig, PersistTurnInput } from '../../src/ai-gateway/config'
import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import { runQueuedInputDispatch } from '../../src/ai-gateway/queuedInputDispatch'

const handles: AiGatewayHandle[] = []
async function start(cfg: AiGatewayConfig): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

/** chunk 字面量推断出的 union 对不上 provider 的 `LanguageModelV3StreamPart`（该类型在本仓不可
 *  直接 import —— `@ai-sdk/provider` 只作为各 provider 的传递依赖存在），断言一次；形状由这些
 *  用例本身跑真 streamText 来保证。写法同 detached_persist_signal.test.ts。 */
type MockDoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']

function textModel(chunkDelayInMs = 1): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs,
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: '1' },
          { type: 'text-delta' as const, id: '1', delta: 'ok' },
          { type: 'text-end' as const, id: '1' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 7, text: 7, reasoning: 0 }
            }
          }
        ]
      })
    })) as unknown as MockDoStream
  })
}

/** 上游在建流阶段就炸（provider 429 / 网络断 的形状）。 */
function failingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (async () => {
      throw new Error('upstream exploded')
    }) as unknown as MockDoStream
  })
}

function baseCfg(opts: {
  model: MockLanguageModelV3
  persisted: PersistTurnInput[]
  registry: ActiveRunRegistry
}): AiGatewayConfig {
  return {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => opts.model,
    persistTurn: (turn) => {
      opts.persisted.push(turn)
    },
    detachedRunsEnabled: true,
    activeRuns: opts.registry
  } as AiGatewayConfig
}

function postChat(port: number, sessionId: number, signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      messages: [{ id: `u${sessionId}`, role: 'user', parts: [{ type: 'text', text: 'go' }] }]
    }),
    ...(signal ? { signal } : {})
  })
}

async function readAll(res: Response): Promise<void> {
  if (!res.body) return
  const reader = res.body.getReader()
  for (;;) {
    const { done } = await reader.read()
    if (done) break
  }
}

function runStop(port: number, sessionId: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/run/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  })
}

describe('一轮结束 → 排队追问收尾的唯一触发点', () => {
  test.each([
    { lane: '正常收尾', model: textModel, reachesOnFinish: true },
    { lane: '上游报错', model: failingModel, reachesOnFinish: true }
  ])(
    '$lane：release 通知恰好一次（persistTurn 是否跑到 = $reachesOnFinish）',
    async ({ model, reachesOnFinish }) => {
      const settled: number[] = []
      const persisted: PersistTurnInput[] = []
      const registry = new ActiveRunRegistry({ onSessionIdle: (id) => settled.push(id) })
      const handle = await start(baseCfg({ model: model(), persisted, registry }))

      await readAll(await postChat(handle.port, 1))
      await new Promise((r) => setTimeout(r, 80))

      expect(settled).toEqual([1])
      expect(registry.hasActive(1)).toBe(false)
      // 上游报错也走到了 onFinish —— 这就是为什么「run 出错没人 drain」的原判定是错的，
      // 真正漏掉的是下面那条 abort 路径。
      expect(persisted).toHaveLength(reachesOnFinish ? 1 : 0)
    }
  )

  test('被 /run/stop 停掉的那一轮：release 不再通知（队列语义归 stop 端点）', async () => {
    const settled: number[] = []
    const persisted: PersistTurnInput[] = []
    const registry = new ActiveRunRegistry({ onSessionIdle: (id) => settled.push(id) })
    const handle = await start(baseCfg({ model: textModel(40), persisted, registry }))

    const res = await postChat(handle.port, 2)
    await new Promise((r) => setTimeout(r, 20))
    expect((await (await runStop(handle.port, 2)).json()).stopped).toBe(true)
    await readAll(res)
    await new Promise((r) => setTimeout(r, 80))

    // stop() 自己摘掉了表项，被停那一轮随后的 release 是 no-op → 一次都不通知。
    expect(settled).toEqual([])
    expect(persisted).toHaveLength(0)
    expect(registry.hasActive(2)).toBe(false)
  })

  test('循环闸：restored 不进 dispatchable —— 每行最多自动派发一次', async () => {
    const posts: unknown[] = []
    const rows = [
      { id: 1, content: '已经自动试过一次的追问', status: 'restored' },
      { id: 2, content: '还排着队的', status: 'queued' }
    ]

    await runQueuedInputDispatch(
      {
        hasActiveRun: () => false,
        compactActive: () => false,
        // 与 chat_db 的 listDispatchableQueuedInput 同判据：只认 'queued'。
        listDispatchable: () =>
          rows
            .filter((row) => row.status === 'queued')
            .map((row) => ({ id: row.id, content: row.content })),
        claim: (ids) => ids,
        revert: () => undefined,
        listSessionUIMessages: () => [],
        getSessionModel: () => null,
        postChat: async (body) => {
          posts.push(body)
          return { ok: true, drain: async () => undefined }
        },
        broadcast: () => undefined,
        now: () => 0,
        sleep: async () => undefined
      },
      1
    )

    const sent = posts.flatMap(
      (body) =>
        (
          body as {
            messages: Array<{ parts?: Array<{ type: string; text?: string }> }>
          }
        ).messages.at(-1)?.parts?.[0]?.text ?? ''
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('还排着队的')
    expect(sent[0]).not.toContain('已经自动试过一次的追问')
  })
})

describe('ActiveRunRegistry.onSessionIdle 的通知契约', () => {
  test('release 返回是否真的结束了这一轮；陈旧 release 既不通知也不返回真', () => {
    const settled: number[] = []
    const registry = new ActiveRunRegistry({ onSessionIdle: (id) => settled.push(id) })
    const token = registry.register(7, new AbortController())!

    expect(registry.release(7, 'someone-elses-run')).toBe(false)
    expect(settled).toEqual([])

    expect(registry.release(7, token.runId)).toBe(true)
    expect(settled).toEqual([7])

    // 同一个 runId 再放一次：表项已经没了 → 不重复通知。
    expect(registry.release(7, token.runId)).toBe(false)
    expect(settled).toEqual([7])
  })

  test('stop() 不通知 —— 那条路的队列语义由 stop / interrupt 端点自己负责', () => {
    const settled: number[] = []
    const registry = new ActiveRunRegistry({ onSessionIdle: (id) => settled.push(id) })
    const token = registry.register(8, new AbortController())!

    expect(registry.stop(8).stopped).toBe(true)
    expect(settled).toEqual([])
    // 被停那一轮的 finally 随后调 release：表项已被 stop 摘掉 → 依然不通知。
    expect(registry.release(8, token.runId)).toBe(false)
    expect(settled).toEqual([])
  })

  test('通知里抛异常绝不能把租约释放变成异常（会话被锁死比漏一次 drain 更糟）', () => {
    const registry = new ActiveRunRegistry({
      onSessionIdle: () => {
        throw new Error('handler exploded')
      }
    })
    const token = registry.register(9, new AbortController())!

    expect(registry.release(9, token.runId)).toBe(true)
    expect(registry.hasActive(9)).toBe(false)
  })
})
