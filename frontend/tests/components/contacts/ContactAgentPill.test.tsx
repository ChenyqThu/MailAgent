// @vitest-environment happy-dom
//
// WP7 —— ✨Agent 胶囊的**两层行级门**（`AgentPendingBadge.tsx:70-79` 教科书）：
//   ① 渲染门：治理 agent 行未启用时胶囊一个字节都不进 DOM；
//   ② 查询门：同一个条件下待审数查询根本不发，避免无意义轮询。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const agentStatus = vi.fn()

vi.mock('@shared/api/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/api/contacts')>()
  return {
    ...actual,
    createContactsApi: () => ({ agentStatus })
  }
})

import i18n from '@shared/i18n'
import {
  ContactListPane,
  type ContactListPaneProps
} from '@shared/components/contacts/ContactListPane'
import type { ContactRowActions } from '@shared/components/contacts/ContactRow'
import { useContactAgentStatus } from '@shared/components/contacts/hooks'

await i18n.changeLanguage('zh-CN')

const actions: ContactRowActions = {
  onOpen: vi.fn(),
  onSetKind: vi.fn(),
  onToggleSelf: vi.fn(),
  onToggleHidden: vi.fn()
}

function renderPane(over: Partial<ContactListPaneProps>): void {
  const props: ContactListPaneProps = {
    view: 'known',
    onViewChange: vi.fn(),
    onSearchChange: vi.fn(),
    sort: 'density',
    onSortChange: vi.fn(),
    groupBy: 'none',
    onGroupByChange: vi.fn(),
    density: 'compact',
    onDensityChange: vi.fn(),
    kindFilter: new Set(['person']),
    onKindFilterToggle: vi.fn(),
    rows: [],
    total: 0,
    loading: false,
    onLoadMore: vi.fn(),
    hasMore: false,
    progress: undefined,
    selectedId: null,
    onToggleGroup: vi.fn(),
    actions,
    agentEnabled: true,
    pendingCount: 0,
    onOpenAgent: vi.fn(),
    ...over
  }
  render(<ContactListPane {...props} />)
}

function wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ContactListPane · ✨Agent 胶囊', () => {
  test('治理 flag 关 → 胶囊整个不进 DOM', () => {
    renderPane({ agentEnabled: false, pendingCount: 7 })
    expect(screen.queryByTitle('通讯录 Agent · 待审治理建议')).toBeNull()
    expect(screen.queryByText('Agent')).toBeNull()
  })

  test('flag 开 + 待审 0 → 胶囊在、徽标不在（原型只用 sugCount 门徽标，不门胶囊）', () => {
    renderPane({ pendingCount: 0 })
    expect(screen.getByTitle('通讯录 Agent · 待审治理建议')).toBeTruthy()
    expect(screen.queryByLabelText(/条待审建议$/)).toBeNull()
  })

  test('flag 开 + 待审 3 → 徽标显示 3，点击开抽屉', () => {
    const onOpenAgent = vi.fn()
    renderPane({ pendingCount: 3, onOpenAgent })
    const badge = screen.getByLabelText('3 条待审建议')
    expect(badge.textContent).toBe('3')
    screen.getByTitle('通讯录 Agent · 待审治理建议').click()
    expect(onOpenAgent).toHaveBeenCalledTimes(1)
  })
})

describe('useContactAgentStatus · 查询门', () => {
  test('enabled=false → 一次请求都不发（字节级不轮询）', async () => {
    const { result } = renderHook(() => useContactAgentStatus(false), { wrapper })
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(agentStatus).not.toHaveBeenCalled()
  })

  test('enabled=true → 拉一次待审数（证明上一条不是因为 hook 根本不工作）', async () => {
    agentStatus.mockResolvedValue({
      enabled: true,
      pending_count: 2,
      last_fire_day: '2026-08-19',
      last_scan_at: 1_755_000_000
    })
    const { result } = renderHook(() => useContactAgentStatus(true), { wrapper })
    await waitFor(() => expect(result.current.data?.pending_count).toBe(2))
    expect(agentStatus).toHaveBeenCalledTimes(1)
  })
})
