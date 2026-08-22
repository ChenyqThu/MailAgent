// task 08-20-notification-center M3 C3 — `PersistTurnInput.detached`（「turn 落库时客户端已断开」）
// 的两层钉子：
//   ① makePersistOnFinish 的 isClientGone **必须是 getter**：断开发生在构造 onFinish 之后、
//      落库之前的任意时刻（drain 中途切走会话正是本功能要覆盖的场景），构造时求值恒得 false；
//   ② handleChat 的**两条** drain 都要把信号传下去 —— streamOptions 的那份（detached drain /
//      attached pipe）与 overflow-aware drain 自己 new 的那份（manual_chat + 自动压缩，两开关
//      均默认 on ⇒ 这是生产手动对话的主路径，漏传等于功能在主路径上恒 false）。
//
// 真 streamText（MockLanguageModelV3，不打 provider），harness 抄 detached_runs.test.ts。
// flag off（MAILAGENT_CHAT_DETACHED_RUNS=false）的语义由 detached_runs.test.ts 的 baseline
// 用例覆盖：断开即 abort ⇒ 压根不落库，谈不上 detached。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'
import { makePersistOnFinish, type PreparedChatRun } from '../../src/ai-gateway/chatRun'
import type { AiGatewayConfig, PersistTurnInput } from '../../src/ai-gateway/config'
import type { CompactCoordinator, CompactPersistence } from '../../src/ai-gateway/compact'
import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

// ── ① getter 时序（纯函数层） ────────────────────────────────────────────────

const asst: MailAgentUIMessage = {
  id: 'a1',
  role: 'assistant',
  parts: [{ type: 'text', text: '好了' }]
}

function makeRun(): PreparedChatRun {
  return {
    result: { usage: Promise.resolve(undefined) } as unknown as PreparedChatRun['result'],
    rawMessages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '去查一下' }] }],
    sessionId: 42,
    modelId: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    auditEntries: [],
    toolNames: []
  }
}

async function fire(onFinish: ReturnType<typeof makePersistOnFinish>): Promise<void> {
  await onFinish({ responseMessage: asst, isAborted: false } as unknown as Parameters<
    typeof onFinish
  >[0])
}

function recordingCfg(seen: PersistTurnInput[]): AiGatewayConfig {
  return {
    persistTurn: (t: PersistTurnInput) => {
      seen.push(t)
    }
  } as AiGatewayConfig
}

describe('makePersistOnFinish — isClientGone 是 getter，求值时刻 = 落库时刻', () => {
  test('构造之后才断开 → detached true（快照写法会在这里恒 false）', async () => {
    const seen: PersistTurnInput[] = []
    const cfg = recordingCfg(seen)
    let clientGone = false
    const onFinish = makePersistOnFinish(cfg, makeRun(), { isClientGone: () => clientGone })
    // 构造 onFinish 时客户端还在；drain 到一半用户关掉面板。
    clientGone = true
    await fire(onFinish)
    expect(seen).toHaveLength(1)
    expect(seen[0].detached).toBe(true)
  })

  test('落库时客户端仍在 → detached false', async () => {
    const seen: PersistTurnInput[] = []
    const cfg = recordingCfg(seen)
    await fire(makePersistOnFinish(cfg, makeRun(), { isClientGone: () => false }))
    expect(seen[0].detached).toBe(false)
  })

  test('不传 opts（approvalResume 的 server-side drain / agentRun 的 headless run）→ detached false', async () => {
    const seen: PersistTurnInput[] = []
    const cfg = recordingCfg(seen)
    await fire(makePersistOnFinish(cfg, makeRun()))
    expect(seen[0].detached).toBe(false)
  })
})

// ── ② handleChat 的两条 drain（真 gateway） ──────────────────────────────────

const handles: AiGatewayHandle[] = []
async function start(cfg: Parameters<typeof startAiGatewayServer>[0]): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

/** chunk 字面量推断出的 union 对不上 provider 的 `LanguageModelV3StreamPart`（该类型在本仓
 *  不可直接 import —— `@ai-sdk/provider` 只作为各 provider 的传递依赖存在），断言一次；形状
 *  由这些用例本身跑真 streamText 来保证。 */
type MockDoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']

function slowTextModel(parts: string[], chunkDelayInMs: number): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs,
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: '1' },
          ...parts.map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
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

/** 只有 `run()` 会被 overflow 恢复调到（本文件的用例不触发溢出）；在场与否决定 handleChat 走
 *  哪条 drain —— 这正是要钉的分叉。 */
function compactStubs(): {
  compactPersistence: CompactPersistence
  compactCoordinator: CompactCoordinator
} {
  return {
    compactPersistence: {
      listSessionMessages: () => [],
      getSessionModel: () => 'm',
      appendCompactMessage: () => {}
    },
    compactCoordinator: {
      run: async () => ({ status: 'completed' }),
      hasActive: () => false
    } as unknown as CompactCoordinator
  }
}

function baseCfg(persisted: PersistTurnInput[], model: MockLanguageModelV3): AiGatewayConfig {
  return {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => model,
    // detached = flag AND registry 在场（server.ts 的 `detached` 判定）—— 两者缺一都退回
    // legacy close→abort，那时 isClientGone 恒 false。
    detachedRunsEnabled: true,
    activeRuns: new ActiveRunRegistry(),
    persistTurn: (t) => {
      persisted.push(t)
    }
  }
}

function postChat(port: number, sessionId: number, signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] }]
    }),
    ...(signal ? { signal } : {})
  })
}

/** 读够 `frames` 帧后断开（模拟切走会话 / 关面板）。 */
async function readSomeThenAbort(
  res: Response,
  ac: AbortController,
  frames: number
): Promise<void> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let seen = 0
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      seen += parts.length
      if (seen >= frames) {
        ac.abort()
        return
      }
    }
  } catch {
    /* abort 表现为读错误 —— 预期内 */
  }
}

async function drain(res: Response): Promise<void> {
  const reader = res.body!.getReader()
  for (;;) {
    const { done } = await reader.read()
    if (done) break
  }
}

describe('handleChat → PersistTurnInput.detached', () => {
  test('detached drain：中途断开 → 落库的 turn 带 detached=true', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start(baseCfg(persisted, slowTextModel(['一', '二', '三', '四', '五'], 30)))
    const ac = new AbortController()
    const res = await postChat(h.port, 71, ac.signal)
    await readSomeThenAbort(res, ac, 2)

    await vi.waitFor(() => expect(persisted).toHaveLength(1), { timeout: 3000 })
    expect(persisted[0].detached).toBe(true)
  })

  test('detached drain：读完全程（客户端没走）→ detached=false', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start(baseCfg(persisted, slowTextModel(['一', '二'], 5)))
    await drain(await postChat(h.port, 72))

    await vi.waitFor(() => expect(persisted).toHaveLength(1), { timeout: 3000 })
    expect(persisted[0].detached).toBe(false)
  })

  test('overflow-aware drain（manual_chat + 自动压缩 = 生产主路径）：中途断开 → detached=true', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start({
      ...baseCfg(persisted, slowTextModel(['一', '二', '三', '四', '五'], 30)),
      ...compactStubs()
    })
    const ac = new AbortController()
    const res = await postChat(h.port, 73, ac.signal)
    await readSomeThenAbort(res, ac, 2)

    await vi.waitFor(() => expect(persisted).toHaveLength(1), { timeout: 3000 })
    expect(persisted[0].detached).toBe(true)
  })

  test('overflow-aware drain：读完全程 → detached=false', async () => {
    const persisted: PersistTurnInput[] = []
    const h = await start({
      ...baseCfg(persisted, slowTextModel(['一', '二'], 5)),
      ...compactStubs()
    })
    await drain(await postChat(h.port, 74))

    await vi.waitFor(() => expect(persisted).toHaveLength(1), { timeout: 3000 })
    expect(persisted[0].detached).toBe(false)
  })
})
