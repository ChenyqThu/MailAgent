// @vitest-environment happy-dom
//
// 0812 收口 —— 失效提案上的「重新跑一轮」在 MatterDetail 里**真的接线了**。
//
// 🔴 为什么要单独一道闸：`MatterUpdateReview` 的 `onRerun` 是**可选** prop，父级不传时那颗
// 按钮压根不渲染（`MatterUpdateReviewStale.test.tsx` 的第三个用例正是在钉这个行为）。
// 于是「按钮做好了但没人接线」是一个测试全绿的失败态 —— 这里从 MatterDetail 这一侧钉住
// 「点它 = 真的发起一次跟进 run」+「run 起来了就关掉这张已作废的审阅面」。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter, MatterUpdate } from '@shared/api/types/matter'

const { mattersApi, startRunMutate } = vi.hoisted(() => ({
  mattersApi: {
    get: vi.fn(),
    list: vi.fn(),
    patch: vi.fn(),
    getUpdate: vi.fn(),
    listUpdates: vi.fn(async () => ({ items: [] })),
    listResources: vi.fn(async () => []),
    listStakeholders: vi.fn(async () => [])
  },
  startRunMutate: vi.fn()
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => mattersApi,
  useMatterChatApi: () => ({ contextSnapshot: vi.fn() }),
  useMattersEnabled: () => true,
  useMatterFlags: () => ({ mattersEnabled: true, matterAgentEnabled: true }),
  useMatterRuns: () => ({ data: undefined, isLoading: false }),
  useMatterUpdates: () => ({ data: undefined, isLoading: false }),
  useStartMatterRun: () => ({ mutate: startRunMutate, mutateAsync: vi.fn(), isPending: false }),
  useMatterAgentProfiles: () => ({ data: [], isLoading: false }),
  useMatterAttention: () => ({ data: undefined, isLoading: false }),
  useGlobalAttention: () => ({ data: undefined, isLoading: false }),
  useAttentionAction: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
}))
vi.mock('@shared/api/chat_api', () => ({
  createChatRuntime: vi.fn(),
  listSessionsForMatter: vi.fn(async () => [])
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    chat: { listAllSessions: vi.fn(async () => []), listMessages: vi.fn(async () => []) }
  })
}))
vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { MatterDetail } = await import('@shared/components/matters/MatterDetail')

await i18n.changeLanguage('zh-CN')

function matter(): Matter {
  return {
    id: 42,
    public_id: 'MAT-0042',
    title: 'Vendor launch',
    background: '',
    goal: '',
    matter_type: null,
    tags: [],
    status: 'active',
    health: 'on_track',
    priority: 'p1',
    owner_id: null,
    source: 'desktop_ui',
    due_at: null,
    waiting_context: null,
    next_attention_at: null,
    attention_reason: null,
    last_activity_at: null,
    latest_accepted_update_id: null,
    current_summary: null,
    summary_at: null,
    summary_by_kind: null,
    summary_by_id: null,
    version: 3,
    archived_at: null,
    archived_by_kind: null,
    archived_by_id: null,
    deleted_at: null,
    deleted_by_kind: null,
    deleted_by_id: null,
    purge_after: null,
    created_at: 1,
    updated_at: 1
  }
}

function staleUpdate(): MatterUpdate {
  return {
    id: 9,
    matter_id: 42,
    review_status: 'pending',
    summary: 'New',
    created_at: 2,
    change_count: 1,
    is_stale: true,
    agent_run_id: 7,
    confidence: 0.8,
    anchored_matter_version: 2,
    created_by_kind: 'agent',
    from_event_id: 1,
    to_event_id: 4,
    original_proposal: { open_questions: [] },
    reviewed_result: null,
    changes: [{ id: 'c1', kind: 'fact', text: 'Confirmed', sources: [] }],
    accepted_change_ids: null,
    citations: [],
    stale_at: 3,
    stale_reason: 'matter_version_advanced'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
  mattersApi.list.mockResolvedValue({ items: [matter()] })
  mattersApi.get.mockResolvedValue({ matter: matter(), items: [], timeline: [] })
  mattersApi.patch.mockResolvedValue({ matter: matter() })
  mattersApi.getUpdate.mockResolvedValue(staleUpdate())
})

afterEach(cleanup)

describe('MatterDetail — 失效提案的「重新跑一轮」', () => {
  test('点击后发起一次跟进 run，run 起来了就关掉审阅面', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    render(
      <QueryClientProvider client={client}>
        <MatterDetail
          matterId="MAT-0042"
          onBack={vi.fn()}
          onRemoved={vi.fn()}
          initialReviewId={9}
        />
      </QueryClientProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: '重新跑一轮' }))

    // ① 真的发起了一次 run，且带当前 matter 版本（与详情头「立即跟进」同一条路径）。
    expect(startRunMutate).toHaveBeenCalledTimes(1)
    expect(startRunMutate.mock.calls[0][0]).toEqual({ expectedVersion: 3 })

    // ② run 起来之后审阅面关掉 —— 否则用户会盯着一张已经作废的提案等新结果。
    const options = startRunMutate.mock.calls[0][1] as {
      onSuccess(result: { run: { id: number }; coalesced: boolean }): void
    }
    act(() => options.onSuccess({ run: { id: 77 }, coalesced: false }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '重新跑一轮' })).toBeNull())
  })
})
