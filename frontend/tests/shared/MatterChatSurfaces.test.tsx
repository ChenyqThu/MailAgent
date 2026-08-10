// @vitest-environment happy-dom
//
// Matters MVP P3 (lane ③) — the two surface-level invariants:
//   · MatterDetail: the chat panel TAKES the ContextRail's slot (design 附录 C 「!chatOpen 才渲染
//     rail」) — they are never both on screen, and closing the chat brings the rail back;
//   · MattersWorkspace with the flag off: nothing renders and nothing is requested.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter } from '@shared/api/types/matter'

const { mattersApi, chatApi, mailApi, mattersEnabled } = vi.hoisted(() => ({
  mattersApi: {
    get: vi.fn(),
    list: vi.fn(),
    listResources: vi.fn(async () => []),
    listStakeholders: vi.fn(async () => [])
  },
  chatApi: {
    contextSnapshot: vi.fn(async () => {
      throw new Error('not needed')
    }),
    recordChatScope: vi.fn(),
    applyUndo: vi.fn()
  },
  mailApi: {
    chat: {
      listAllSessions: vi.fn(async () => []),
      listMessages: vi.fn(async () => []),
      newSession: vi.fn()
    }
  },
  mattersEnabled: { value: true }
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => mattersApi,
  useMatterChatApi: () => chatApi,
  useMattersEnabled: () => mattersEnabled.value
}))
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => mailApi }))
vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { MatterDetail } = await import('@shared/components/matters/MatterDetail')
const { MattersWorkspace } = await import('@shared/components/matters/MattersWorkspace')

await i18n.changeLanguage('zh-CN')

function matter(): Matter {
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
    updated_at: 1
  }
}

/** The rail's breakpoint (`min-width: 1400px`) must match so the rail is even a candidate. */
function stubWideViewport(): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('1400'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

function renderDetail(chatOpen: boolean): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return render(
    <QueryClientProvider client={client}>
      <MatterDetail
        matterId="MAT-0042"
        onBack={vi.fn()}
        onRemoved={vi.fn()}
        chatOpen={chatOpen}
        onToggleChat={vi.fn()}
        onCloseChat={vi.fn()}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mattersEnabled.value = true
  mattersApi.get.mockResolvedValue({ matter: matter(), items: [], timeline: [] })
  mattersApi.listResources.mockResolvedValue([])
  mattersApi.listStakeholders.mockResolvedValue([])
  stubWideViewport()
})

afterEach(cleanup)

describe('MatterDetail — chat panel vs ContextRail', () => {
  test('closed: the rail renders and the chat panel does not', async () => {
    renderDetail(false)
    await waitFor(() => expect(screen.getByText('Vendor launch')).toBeTruthy())
    expect(screen.getByText('还没有关联资料。解除关联不会删除原始邮件或文档。')).toBeTruthy()
    expect(screen.queryByTestId('matter-chat-panel')).toBeNull()
    // the entry point is there either way
    expect(screen.getByText('事项对话')).toBeTruthy()
  })

  test('open: the chat panel takes the rail slot — the rail is gone', async () => {
    renderDetail(true)
    await waitFor(() => expect(screen.getByTestId('matter-chat-panel')).toBeTruthy())
    expect(screen.queryByText('还没有关联资料。解除关联不会删除原始邮件或文档。')).toBeNull()
  })
})

describe('MattersWorkspace — flag off', () => {
  test('renders nothing and issues no matters request', () => {
    mattersEnabled.value = false
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    const { container } = render(
      <QueryClientProvider client={client}>
        <MattersWorkspace />
      </QueryClientProvider>
    )
    expect(container.firstChild).toBeNull()
    expect(mattersApi.list).not.toHaveBeenCalled()
    expect(chatApi.contextSnapshot).not.toHaveBeenCalled()
  })
})
