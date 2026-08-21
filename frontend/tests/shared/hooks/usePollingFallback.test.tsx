// @vitest-environment happy-dom
//
// perf-sse-realtime R3 — usePollingFallback 的 `connectedIntervalMs` 选项闸。
//
// 语义矩阵（改任何一格都该先改这里）:
//   connected + 无选项      → false（既有全部调用点行为不变 —— 这是本批的红线）
//   connected + 240s 选项   → 240_000（邮件主列表的保险轮询: 总线 lossy, 丢一条
//                              email.synced 不该让列表永久停在旧数据）
//   断线 + 选项             → 仍走 settings.pollIntervalSec fallback（选项只管 connected 态）
//   pollIntervalSec=0       → 恒 false（用户显式全静默, 保险轮询也尊重）
import { describe, expect, test, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

let pollIntervalSec = 30
const settingsGet = vi.fn(async () => ({ pollIntervalSec }))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ settings: { get: settingsGet } })
}))

const { usePollingFallback } = await import('@shared/hooks/usePollingFallback')
const { useEventsStatusStore } = await import('@shared/state/eventsStatus')

function setSseState(state: 'connected' | 'disconnected' | 'idle'): void {
  useEventsStatusStore.getState().setStatus({ state, lastError: null, lastEventTs: null, url: '' })
}

function renderPolling(options?: { connectedIntervalMs?: number }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => usePollingFallback(options), { wrapper })
}

beforeEach(() => {
  cleanup()
  pollIntervalSec = 30
  settingsGet.mockClear()
})

describe('usePollingFallback — connectedIntervalMs (R3)', () => {
  test('connected + 无选项 → false（既有调用点字节级不变）', async () => {
    setSseState('connected')
    const { result } = renderPolling()
    await waitFor(() => expect(settingsGet).toHaveBeenCalled())
    expect(result.current).toBe(false)
  })

  test('connected + 选项 → 用长间隔保险轮询', async () => {
    setSseState('connected')
    const { result } = renderPolling({ connectedIntervalMs: 240_000 })
    await waitFor(() => expect(result.current).toBe(240_000))
  })

  test('断线时选项不生效, 仍走 settings fallback', async () => {
    setSseState('disconnected')
    const { result } = renderPolling({ connectedIntervalMs: 240_000 })
    await waitFor(() => expect(result.current).toBe(30_000))
  })

  test('pollIntervalSec=0（用户显式全静默）连保险轮询也关', async () => {
    pollIntervalSec = 0
    setSseState('connected')
    const { result } = renderPolling({ connectedIntervalMs: 240_000 })
    await waitFor(() => expect(settingsGet).toHaveBeenCalled())
    // settings 落地后 interval===0 分支必须赢过 connectedIntervalMs。
    await waitFor(() => expect(result.current).toBe(false))
  })
})
