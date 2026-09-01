// @vitest-environment happy-dom
//
// 承接 AgentCardLatestReport.test（随 AgentsTab 退役）唯一那条断言：某个 agent 的
// 「最近一篇报告」必须走 **per-agent 查询**（agentId 过滤 + limit:1，report_date DESC），
// 不是从不带过滤的分页全量列表里挑 —— 低频报告 agent 的最新一篇掉出第一页时，
// 它的卡片会假装「还没有报告」（codex MEDIUM-2 的原始现场）。
//
// 消费侧的两态渲染（有最近一篇 → 渲染状态与标题行；没有 → 整段不渲染）已由
// tests/components/EventDetailDrawerProjection.test.tsx 的「上次跑的结果是可缺省块」钉住，
// 那里把本 hook 打了桩；这条补的是 hook 自己发出去的查询长什么样。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ report: { list: mockList } })
}))

import { useLatestReport } from '../../../src/shared/components/agents/hooks'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return createElement(QueryClientProvider, { client: qc }, children)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useLatestReport — per-agent 查询', () => {
  test('拿到最近一篇；查询参数是 { agentId, limit: 1 } 而不是无过滤全量列表', async () => {
    mockList.mockResolvedValue({ items: [{ id: 'r1', headline: '低频日报最新一份' }], total: 1 })
    const { result } = renderHook(() => useLatestReport('rare_digest'), { wrapper })

    await waitFor(() => expect(result.current).toMatchObject({ id: 'r1' }))
    expect(mockList).toHaveBeenCalledTimes(1)
    expect(mockList.mock.calls[0][0]).toEqual({ agentId: 'rare_digest', limit: 1 })
  })

  test('这个 agent 一篇都没有 → null（不是 undefined，也不借用别人的第一条）', async () => {
    mockList.mockResolvedValue({ items: [], total: 0 })
    const { result } = renderHook(() => useLatestReport('rare_digest'), { wrapper })

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))
    expect(result.current).toBeNull()
  })
})
