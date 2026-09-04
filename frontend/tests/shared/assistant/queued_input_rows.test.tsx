// @vitest-environment happy-dom
//
// task 09-03 dogfood —— `useQueuedInputRows` 的派生判据：哪种排队行算「这个会话上有一轮派发 run
// 正在起」。面板拿它补 `/run/active` 探针的盲区（探针在 active:false 之后停轮询，而 dispatcher 的
// run 要 2~8 秒后才 register），所以判据必须是 `claimed` 而且只有 `claimed` —— 放宽到别的状态会
// 让一条还躺在队列里、用户随时可以改可以撤的追问把面板锁进排队模式。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { QueuedInput } from '@shared/api/types'

const { stableMailApi } = vi.hoisted(() => ({
  stableMailApi: {
    chat: {
      onQueuedInputChanged: vi.fn(() => () => {}),
      onTurnPersisted: vi.fn(() => () => {})
    }
  }
}))

vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => stableMailApi }))

const { useQueuedInputRows } = await import('@shared/assistant/runtime/useQueuedInputRows')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function row(over: Partial<QueuedInput>): QueuedInput {
  return {
    id: 1,
    sessionId: 10,
    runId: null,
    mode: 'follow_up',
    content: '追问',
    status: 'queued',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over
  }
}

function mountHook(
  items: QueuedInput[]
): ReturnType<
  typeof renderHook<
    { rows: QueuedInput[]; dispatchInFlight: boolean; dispatchStartedAt: number | null },
    unknown
  >
> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ items }) }))
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(
    () =>
      useQueuedInputRows({ enabled: true, gatewayBaseUrl: 'http://127.0.0.1:1', sessionId: 10 }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      )
    }
  )
}

describe('useQueuedInputRows —— 派发在途的判据', () => {
  test.each([
    { status: 'queued' as const, inFlight: false },
    { status: 'restored' as const, inFlight: false },
    { status: 'claimed' as const, inFlight: true }
  ])('$status 行 → dispatchInFlight=$inFlight', async ({ status, inFlight }) => {
    const { result } = mountHook([row({ status })])

    // 先等真行落地，再断言派生值 —— 否则断言会跑在 query 解析之前，恰好等于「什么都没有」的
    // 初始态而恒绿（本条控制断言曾因此对变异毫无反应）。
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(result.current.dispatchInFlight).toBe(inFlight)
  })

  test('多条 claimed 时起点取最早那条的 claim 时刻', async () => {
    const { result } = mountHook([
      row({ id: 2, status: 'claimed', updatedAt: 1_700_000_020_000 }),
      row({ id: 3, status: 'claimed', updatedAt: 1_700_000_010_000 }),
      row({ id: 4, status: 'queued', updatedAt: 1_700_000_005_000 })
    ])

    await waitFor(() => expect(result.current.rows).toHaveLength(3))
    expect(result.current.dispatchStartedAt).toBe(1_700_000_010_000)
  })

  test('没有 claimed 行 → 没有起点', async () => {
    const { result } = mountHook([row({ status: 'sent' }), row({ id: 5, status: 'canceled' })])

    await waitFor(() => expect(result.current.rows).toHaveLength(2))
    expect(result.current.dispatchStartedAt).toBeNull()
    expect(result.current.dispatchInFlight).toBe(false)
  })
})
