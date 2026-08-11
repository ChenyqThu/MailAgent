// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { Matter } from '@shared/api/types/matter'
import { __resetShortcutBus } from '@shared/hooks/useShortcut'
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
  mattersApi.get.mockImplementation(async (matterId: string) => ({
    matter: matter(matterId),
    items: [],
    timeline: []
  }))
  mattersApi.patch.mockResolvedValue({ matter: matter('MAT-0042') })
  mattersApi.listResources.mockResolvedValue([])
  mattersApi.listStakeholders.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  __resetShortcutBus()
})

describe('MatterDetail prev/next navigation', () => {
  test('renders current position and navigates by buttons and J/K', async () => {
    const navigate = vi.fn()
    renderDetail('MAT-0042', navigate)

    expect(await screen.findByText('Matter MAT-0042')).toBeTruthy()
    expect(screen.getByText('2 / 3')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '上一条 (K)' }))
    expect(navigate).toHaveBeenLastCalledWith('MAT-0001')

    fireEvent.keyDown(document, { key: 'j' })
    expect(navigate).toHaveBeenLastCalledWith('MAT-0099')

    fireEvent.keyDown(document, { key: 'K' })
    expect(navigate).toHaveBeenLastCalledWith('MAT-0001')
  })

  test('disables edges and skips shortcuts while editing text', async () => {
    const navigate = vi.fn()
    renderDetail('MAT-0001', navigate)

    expect(await screen.findByText('Matter MAT-0001')).toBeTruthy()
    expect((screen.getByRole('button', { name: '上一条 (K)' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    fireEvent.keyDown(document, { key: 'k' })
    expect(navigate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '编辑事项标题' }))
    const titleInput = screen.getByRole('textbox', { name: '事项标题' })
    fireEvent.keyDown(titleInput, { key: 'j' })
    expect(navigate).not.toHaveBeenCalled()
  })
})

function renderDetail(matterId: string, onNavigateMatter: (matterId: string) => void): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <MatterDetail
        matterId={matterId}
        onBack={vi.fn()}
        onRemoved={vi.fn()}
        navigationMatterIds={['MAT-0001', 'MAT-0042', 'MAT-0099']}
        onNavigateMatter={onNavigateMatter}
      />
    </QueryClientProvider>
  )
}

function matter(publicId: string): Matter {
  return {
    id: Number(publicId.replace(/\D/g, '')),
    public_id: publicId,
    title: `Matter ${publicId}`,
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
    updated_at: 1
  }
}
