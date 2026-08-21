// @vitest-environment happy-dom

/**
 * 待审提案取数的行为闸（perf-matters-request-fanout）。
 *
 * 病根：工作台按事项扇出 `GET /{id}/updates`、再按提案扇出 `GET /{id}/updates/{uid}`
 * （N + P 个请求，上限 100+），详情页**另发**一次自己的 `/{id}/updates` —— 一次进入就能
 * 把 Chromium 对同一 host 的 6 个连接槽占满，详情的前台请求全排在后面。
 *
 * 🔴 判据是**打到网络上的请求**，不是「hook 返回了数据」：改回按事项扇出、或让详情页自己
 * 再查一次，返回值都还是对的，只有请求计数会红。所以这里 stub 全局 fetch 数 URL，而不是
 * mock 掉 api 层。
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

import type { MatterUpdate } from '../../../src/shared/api/types/matter'
import {
  useMatterPendingUpdates,
  usePendingMatterUpdates
} from '../../../src/shared/components/matters/hooks'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function update(id: number, summary: string): MatterUpdate {
  return {
    id,
    review_status: 'pending',
    summary,
    created_at: 1_700_000_000_000,
    change_count: 1,
    is_stale: false,
    agent_run_id: id,
    confidence: null,
    anchored_matter_version: 1,
    created_by_kind: 'agent',
    matter_id: id,
    from_event_id: null,
    to_event_id: null,
    original_proposal: {},
    reviewed_result: null,
    changes: [{ id: 'chg_01', kind: 'field' }],
    accepted_change_ids: null,
    citations: [],
    stale_at: null,
    stale_reason: null
  }
}

/** 打到网络上的 URL 清单（顺序保留，便于断言「一共只发了一个」）。 */
function stubFetch(): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      return new Response(
        JSON.stringify({
          status: 'success',
          schema_version: 1,
          data: {
            items: [
              { matter_public_id: 'MAT-0001', updates: [update(2, '甲-2'), update(1, '甲-1')] },
              { matter_public_id: 'MAT-0002', updates: [update(3, '乙-1')] }
            ]
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
  )
  return urls
}

function wrapper(): ({ children }: { children: React.ReactNode }) => React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }): React.ReactElement {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

describe('待审提案 —— 一个请求覆盖全部活跃事项', () => {
  test('工作台聚合与详情切片共用同一次请求', async () => {
    const urls = stubFetch()
    const { result } = renderHook(
      () => ({
        board: usePendingMatterUpdates(true),
        detail: useMatterPendingUpdates('MAT-0002', true)
      }),
      { wrapper: wrapper() }
    )

    await waitFor(() => expect(result.current.board.data).toBeDefined())
    await waitFor(() => expect(result.current.detail.data).toBeDefined())

    // 两个面 = 一次请求（同 query key ⇒ react-query 去重）。
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/matters/updates')
    expect(urls[0]).toContain('review_status=pending')
    // 逐事项的老路径一条都不许再上网。
    expect(urls.some((url) => /\/matters\/MAT-\d+\/updates/.test(url))).toBe(false)

    // 聚合：两条事项都在，提案是完整行（看板卡要读 changes）。
    expect(result.current.board.data?.items.map((entry) => entry.matter_public_id)).toEqual([
      'MAT-0001',
      'MAT-0002'
    ])
    expect(result.current.board.data?.items[0].updates[0].changes).toHaveLength(1)
    // 切片：只拿本事项那一段。
    expect(result.current.detail.data?.map((item) => item.summary)).toEqual(['乙-1'])
  })

  test('聚合里没有这条事项 → 空数组（不是 undefined，详情页据此判「没有待审提案」）', async () => {
    stubFetch()
    const { result } = renderHook(() => useMatterPendingUpdates('MAT-9999', true), {
      wrapper: wrapper()
    })

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data).toEqual([])
  })

  test('关掉事项 Agent 闸 → 一个请求都不发', async () => {
    const urls = stubFetch()
    renderHook(() => usePendingMatterUpdates(false), { wrapper: wrapper() })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(urls).toEqual([])
  })
})
