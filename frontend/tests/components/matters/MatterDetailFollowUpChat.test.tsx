// @vitest-environment happy-dom
//
// 0813 dogfood #17b —— 详情头的「立即跟进」改成开一场对话（owner：「类似邮件详情页的创建事项，
// 直接进入 AI Chat 浮窗，输入指令直接进行对话，也好有个记录」）。
//
// 🔴 两条断言缺一不可：① 唤出 dock 时带**这件事**的身份（否则那场对话指着空气）；② 不再发起
// 无人值守 run（改造前它是唯一行为，回潮了这个 UX 就白改）。失效提案上的「重新跑一轮」仍走
// run —— 那颗按钮要的是一份新提案，见 MatterDetailRerun.test.tsx。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter } from '@shared/api/types/matter'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'

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
  useMatterPendingUpdates: () => ({ data: undefined, isLoading: false }),
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

beforeEach(() => {
  vi.clearAllMocks()
  useAIChatPanel.setState({ visible: false, matterTarget: null, pendingPrompt: null })
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
})

afterEach(cleanup)

describe('MatterDetail — 「立即跟进」走 AI 对话', () => {
  test('唤出带本事项身份的 dock + 递一条跟进指令，且不发起无人值守 run', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    render(
      <QueryClientProvider client={client}>
        <MatterDetail matterId="MAT-0042" onBack={vi.fn()} onRemoved={vi.fn()} />
      </QueryClientProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: /立即跟进/ }))

    const state = useAIChatPanel.getState()
    expect(state.visible).toBe(true)
    // ① 这场对话挂在这件事上（chip 的种子）。
    expect(state.matterTarget).toEqual({ id: 42, publicId: 'MAT-0042', title: 'Vendor launch' })
    // ② 指令是一条普通用户消息，且不等任何邮件 chip 就位（emailId=null）。
    expect(state.pendingPrompt?.emailId).toBeNull()
    expect(state.pendingPrompt?.text).toContain('MAT-0042')
    expect(state.pendingPrompt?.text).toContain('Vendor launch')
    // ③ 不再顺手起一轮 headless run。
    expect(startRunMutate).not.toHaveBeenCalled()
  })
})
