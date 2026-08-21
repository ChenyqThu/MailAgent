// @vitest-environment happy-dom
//
// backfill 进度条的「扫完就别再问了」闩（task 08-20-perf-contacts-render 第 4 项）。
//
// 端点两条 `COUNT(*) FROM email_metadata`，而 drained 之后进度条根本不显示
// （`BackfillBar:18`）—— 老形态每次进通讯录都要为这条看不见的条发一次请求。
// 闩是**会话级**的：drained 并不单调（新邮件进来 total 先涨），落 localStorage 会把这条
// 进度条永久藏掉，所以只在本进程内生效。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { backfillProgress } = vi.hoisted(() => ({ backfillProgress: vi.fn() }))

vi.mock('@shared/api/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/api/contacts')>()
  return { ...actual, createContactsApi: () => ({ backfillProgress }) }
})

import { resetBackfillDrainedLatch, useBackfillProgress } from '@shared/components/contacts/hooks'

function mount(): { unmount: () => void } {
  // 🔴 每次都换一个 QueryClient：要证明的是「请求没发出去」，不是「命中了上一次的缓存」。
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { unmount } = renderHook(() => useBackfillProgress(true), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  })
  return { unmount }
}

beforeEach(() => {
  resetBackfillDrainedLatch()
  backfillProgress.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('useBackfillProgress · drained 闩', () => {
  test('见过一次 drained 之后，重新进页面不再发请求', async () => {
    backfillProgress.mockResolvedValue({ scanned: 3000, total: 3000, drained: true })

    const first = mount()
    await waitFor(() => expect(backfillProgress).toHaveBeenCalledTimes(1))
    first.unmount()

    const second = mount()
    // 给它足够的时间把请求发出去（真发了这里就会变成 2）。
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(backfillProgress).toHaveBeenCalledTimes(1)
    second.unmount()
  })

  test('还没扫完时照常请求 —— 闩不是把这条查询焊死', async () => {
    backfillProgress.mockResolvedValue({ scanned: 120, total: 3000, drained: false })

    const first = mount()
    await waitFor(() => expect(backfillProgress).toHaveBeenCalledTimes(1))
    first.unmount()

    const second = mount()
    await waitFor(() => expect(backfillProgress).toHaveBeenCalledTimes(2))
    second.unmount()
  })
})
