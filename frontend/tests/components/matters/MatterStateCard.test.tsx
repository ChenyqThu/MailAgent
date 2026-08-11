// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Matter } from '@shared/api/types/matter'
import i18n from '@shared/i18n'

const { mattersApi, matterAgentEnabled } = vi.hoisted(() => ({
  mattersApi: {
    get: vi.fn(),
    patch: vi.fn(),
    listUpdates: vi.fn(async () => ({ items: [] })),
    getUpdate: vi.fn(),
    listResources: vi.fn(async () => []),
    listStakeholders: vi.fn(async () => [])
  },
  matterAgentEnabled: { value: false }
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => mattersApi,
  useMatterFlags: () => ({
    mattersEnabled: true,
    matterAgentEnabled: matterAgentEnabled.value
  }),
  useMatterRuns: () => ({ data: undefined, isLoading: false }),
  useMatterUpdates: () => ({ data: undefined, isLoading: false }),
  useStartMatterRun: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useMatterAgentProfiles: () => ({ data: [], isLoading: false }),
  useMatterAttention: () => ({ data: undefined, isLoading: false })
}))
vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { MatterDetail } = await import('@shared/components/matters/MatterDetail')

await i18n.changeLanguage('zh-CN')

beforeEach(() => {
  vi.clearAllMocks()
  matterAgentEnabled.value = false
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: !query.includes('1400'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    }))
  })
  mattersApi.patch.mockResolvedValue({ matter: matter() })
  mattersApi.listResources.mockResolvedValue([])
  mattersApi.listStakeholders.mockResolvedValue([])
})

afterEach(cleanup)

describe('MatterDetail state card', () => {
  test('shows summary provenance and patches direct summary edits', async () => {
    renderDetail({
      current_summary: '等待客户签署合同',
      summary_at: new Date(2026, 7, 9, 10, 30).getTime(),
      summary_by_kind: 'agent'
    })

    expect(await screen.findByText('等待客户签署合同')).toBeTruthy()
    expect(screen.getByText(/更新于/)).toBeTruthy()
    expect(screen.getByText('由跟进 Agent 更新')).toBeTruthy()
    expect(screen.getByText(/跟进 Agent 只能提出更新提案/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '当前状态 编辑' }))
    fireEvent.change(screen.getByRole('textbox', { name: '当前状态' }), {
      target: { value: '已签署，等待归档' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { current_summary: '已签署，等待归档' },
        { expectedVersion: 3 }
      )
    )
  })

  test('patches completion criteria add, toggle, and delete without changing status', async () => {
    renderDetail({
      goal_checks: [
        { t: '合同签署', done: false },
        { t: '开票完成', done: true }
      ]
    })

    expect(await screen.findByText('完成标志')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: '合同签署' }))
    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        {
          goal_checks: [
            { t: '合同签署', done: true },
            { t: '开票完成', done: true }
          ]
        },
        { expectedVersion: 3 }
      )
    )
    expect(mattersApi.patch).not.toHaveBeenCalledWith(
      'MAT-0042',
      expect.objectContaining({ status: 'done' }),
      expect.anything()
    )

    fireEvent.click(screen.getAllByRole('button', { name: '移到回收站' })[0])
    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { goal_checks: [{ t: '开票完成', done: true }] },
        { expectedVersion: 3 }
      )
    )
  })

  test('adds a completion criterion from the empty state and only prompts when all are done', async () => {
    renderDetail({ goal_checks: [] })

    await screen.findByText('0/0')
    fireEvent.click(screen.getByRole('button', { name: /加一条可判定的完成标志/ }))
    fireEvent.change(screen.getByPlaceholderText('例：合同双方已签署'), {
      target: { value: '客户书面确认上线' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { goal_checks: [{ t: '客户书面确认上线', done: false }] },
        { expectedVersion: 3 }
      )
    )

    cleanup()
    renderDetail({ goal_checks: [{ t: '客户书面确认上线', done: true }] })
    expect(await screen.findByText('完成标志已全部满足，可以把这件事推进到「已完成」')).toBeTruthy()
  })

  test('patches due_at from a date input and can clear it', async () => {
    renderDetail({ due_at: null })

    fireEvent.click(await screen.findByRole('button', { name: '未设截止时间' }))
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement
    fireEvent.change(dateInput, { target: { value: '2026-08-31' } })

    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { due_at: new Date(2026, 7, 31).getTime() },
        { expectedVersion: 3 }
      )
    )

    cleanup()
    mattersApi.patch.mockClear()
    renderDetail({ due_at: new Date(2026, 7, 31).getTime() })

    await screen.findByRole('button', { name: /^截止/ })
    fireEvent.click(screen.getByRole('button', { name: '未设截止时间' }))

    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { due_at: null },
        { expectedVersion: 3 }
      )
    )
  })
})

function renderDetail(overrides: Partial<Matter> = {}): ReturnType<typeof render> {
  mattersApi.get.mockResolvedValue({
    matter: matter(overrides),
    items: [],
    timeline: []
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return render(
    <QueryClientProvider client={client}>
      <MatterDetail matterId="MAT-0042" onBack={vi.fn()} onRemoved={vi.fn()} />
    </QueryClientProvider>
  )
}

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: 42,
    public_id: 'MAT-0042',
    title: 'Vendor launch',
    description: '',
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
    updated_at: 1,
    ...overrides
  }
}
