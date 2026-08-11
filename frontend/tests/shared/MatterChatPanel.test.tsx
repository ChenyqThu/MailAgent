// @vitest-environment happy-dom
//
// Matters MVP P3 (lane ③) — MatterChatPanel chrome: the injected-context chips (counts read from
// the SAME bounded snapshot the model receives), the G5 scope switch (audit FIRST, flip second),
// and snapshot fail-soft.
//
// The AI SDK runtime is deliberately NOT mounted here: `resolveAiGatewayBaseUrl()` returns null in
// a test env (no ?aiGatewayPort, not the web build), which is the panel's honest
// gateway-unavailable branch. Everything asserted below lives outside the thread.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter } from '@shared/api/types/matter'
import type { MatterContextSnapshotPayload } from '@shared/api/matters'
import type { ChatSession } from '@shared/api/types'

const { chatApi, mattersApi, mailApi, toastError, listSessionsForMatter } = vi.hoisted(() => ({
  chatApi: {
    contextSnapshot: vi.fn(),
    recordChatScope: vi.fn(),
    applyUndo: vi.fn()
  },
  mattersApi: {
    discoverResourceSuggestions: vi.fn()
  },
  mailApi: {
    chat: {
      listAllSessions: vi.fn<() => Promise<ChatSession[]>>(async () => []),
      listMessages: vi.fn(async () => []),
      newSession: vi.fn()
    }
  },
  toastError: vi.fn(),
  // P4 lane ③：useMatterChatSession 的会话发现改走 serve-api 的 list-for-matter 端点
  // （不再 listAllSessions 拉 300 条客户端筛）——mock 到模块边界，别让测试打真网络。
  listSessionsForMatter: vi.fn<() => Promise<ChatSession[]>>(async () => [])
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => mattersApi,
  useMatterChatApi: () => chatApi,
  useMattersEnabled: () => true
}))
vi.mock('@shared/api/chat_api', () => ({
  createChatRuntime: vi.fn(),
  listSessionsForMatter
}))
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => mailApi }))
vi.mock('@shared/state/toast', () => ({
  toastError,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { MatterChatPanel } = await import('@shared/components/matters/MatterChatPanel')
const { MatterContextGapCard } = await import('@shared/components/matters/MatterContextGapCard')

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

function snapshotPayload(): MatterContextSnapshotPayload {
  return {
    matter: {
      id: 42,
      public_id: 'MAT-0042',
      title: 'Vendor launch',
      type: null,
      tags: [],
      status: 'active',
      health: 'on_track',
      priority: 'p1',
      due_at: null,
      waiting_context: null,
      description: '',
      current_summary: null,
      version: 3,
      summary_accepted_at: 1
    },
    items: [
      { kind: 'action', title: 'a' },
      { kind: 'action', title: 'b' }
    ],
    stakeholders: [{ id: 1, display_name: 'Ann' }],
    resources: [
      {
        id: 5,
        kind: 'email',
        provider: 'mailagent',
        external_key: 'email:1',
        title: 'Vendor email',
        canonical_url: null,
        revision: null,
        access_policy: 'allowed',
        metadata: {},
        excerpt: 'excerpt'
      }
    ],
    events: [{ kind: 'item_added', happened_at: 2, actor_kind: 'user', summary: 'item_added' }]
  }
}

function session(): ChatSession {
  return {
    id: 31,
    email_id: null,
    anchor_type: 'matter',
    anchor_id: 42,
    backend_kind: 'ai-sdk',
    backend_model: null,
    backend_agent_page_id: null,
    title: null,
    archived: false,
    created_at: 1,
    updated_at: 2,
    origin: 'interactive'
  }
}

function renderPanel(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return render(
    <QueryClientProvider client={client}>
      <MatterChatPanel
        matter={{ id: 42, publicId: 'MAT-0042', title: 'Vendor launch' }}
        conversationEpoch={1}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mailApi.chat.listAllSessions.mockResolvedValue([session()])
  listSessionsForMatter.mockResolvedValue([session()])
  mailApi.chat.listMessages.mockResolvedValue([])
  mailApi.chat.newSession.mockResolvedValue(session())
  chatApi.contextSnapshot.mockResolvedValue(snapshotPayload())
  chatApi.recordChatScope.mockResolvedValue({})
  mattersApi.discoverResourceSuggestions.mockResolvedValue({
    items: [],
    suppressed: [],
    local_candidate_count: 0,
    expanded: true
  })
})

afterEach(cleanup)

describe('MatterChatPanel — chrome', () => {
  test('renders the Matter Agent identity, shared matter chip, and snapshot-backed count', async () => {
    renderPanel()
    expect(screen.getByText('事项 Agent')).toBeTruthy()
    expect(screen.getByText('Vendor launch')).toBeTruthy()
    expect(screen.getByText('MAT-0042 Vendor launch')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('基于本事项的 6 条上下文回答')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '移除上下文' }))
    expect(screen.queryByText('MAT-0042 Vendor launch')).toBeNull()
    expect(screen.getByText('基于本事项的 0 条上下文回答')).toBeTruthy()
  })

  test('scope defaults to 全库 and says so', () => {
    renderPanel()
    expect(screen.getByText('已允许全库检索')).toBeTruthy()
  })
})

describe('MatterChatPanel — snapshot fail-soft', () => {
  test('a failing snapshot degrades the chips to placeholders and never blocks the panel', async () => {
    chatApi.contextSnapshot.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'E_HTTP_500' })
    )
    renderPanel()
    await waitFor(() => expect(screen.getByText('上下文计数暂时读不到，不影响对话。')).toBeTruthy())
    expect(screen.getByText('基于本事项的 0 条上下文回答')).toBeTruthy()
    expect(screen.getByTestId('matter-chat-panel')).toBeTruthy()
  })
})

describe('MatterChatPanel — G5 scope switch', () => {
  test('switching to 本事项 creates a session, audits first, then flips locally', async () => {
    renderPanel()
    await waitFor(() => expect(listSessionsForMatter).toHaveBeenCalled())
    fireEvent.click(screen.getByText('本事项'))
    await waitFor(() =>
      expect(chatApi.recordChatScope).toHaveBeenCalledWith('MAT-0042', 'matter', 31)
    )
    expect(mailApi.chat.newSession.mock.invocationCallOrder[0]).toBeLessThan(
      chatApi.recordChatScope.mock.invocationCallOrder[0]
    )
    await waitFor(() => expect(screen.getByText('检索范围限于本事项')).toBeTruthy())
  })

  test('a failed audit keeps the current global scope', async () => {
    chatApi.recordChatScope.mockRejectedValue(new Error('offline'))
    renderPanel()
    await waitFor(() => expect(listSessionsForMatter).toHaveBeenCalled())
    fireEvent.click(screen.getByText('本事项'))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByText('已允许全库检索')).toBeTruthy()
  })

  test('switching back to 全库 records the symmetric restore event', async () => {
    renderPanel()
    await waitFor(() => expect(listSessionsForMatter).toHaveBeenCalled())
    fireEvent.click(screen.getByText('本事项'))
    await waitFor(() => expect(screen.getByText('检索范围限于本事项')).toBeTruthy())
    fireEvent.click(screen.getByText('全库'))
    await waitFor(() =>
      expect(chatApi.recordChatScope).toHaveBeenLastCalledWith('MAT-0042', 'global', 31)
    )
  })
})

describe('MatterContextGapCard — explicit P6 discovery action', () => {
  test('renders the warn card and its explicit authorization action', () => {
    const onExpand = vi.fn()
    render(<MatterContextGapCard onExpand={onExpand} />)
    expect(screen.getByText('上下文缺口 · 需要你授权扩大检索')).toBeTruthy()
    fireEvent.click(screen.getByText('授权扩检索'))
    expect(onExpand).toHaveBeenCalledTimes(1)
  })

  test('discovers only after a click and presents suppressed rejection-memory matches', async () => {
    const payload = snapshotPayload()
    payload.resources = []
    chatApi.contextSnapshot.mockResolvedValue(payload)
    mattersApi.discoverResourceSuggestions.mockResolvedValue({
      items: [{}, {}],
      suppressed: [{ external_key: 'email:9', reason: 'rejected_same_evidence' }],
      local_candidate_count: 1,
      expanded: true
    })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId('matter-context-gap')).toBeTruthy())
    expect(mattersApi.discoverResourceSuggestions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('授权扩检索'))
    await waitFor(() => expect(mattersApi.discoverResourceSuggestions).toHaveBeenCalledWith(
      'MAT-0042',
      { query: 'Vendor launch', expandReason: 'context_gap', limit: 10 }
    ))
    expect(await screen.findByText('已加入 2 条建议态资源 · 1 条此前已标记不相关，已跳过')).toBeTruthy()
  })
})

describe('selectMatterSessions — which session the panel reuses', () => {
  test('newest interactive session for THIS matter; never a headless agent run', async () => {
    const { selectMatterSessions } = await import('@shared/components/matters/useMatterChatSession')
    const rows = [
      { ...session(), id: 1, updated_at: 10 },
      { ...session(), id: 2, updated_at: 30 },
      // an agent-origin run on the same matter — D3: never adopt it as the user's conversation.
      { ...session(), id: 3, updated_at: 99, origin: 'agent' },
      // another matter
      { ...session(), id: 4, updated_at: 50, anchor_id: 43 },
      // an email-anchored session
      { ...session(), id: 5, updated_at: 60, anchor_type: 'email', anchor_id: null, email_id: 7 }
    ]
    expect(selectMatterSessions(rows, 42).map((row) => row.id)).toEqual([2, 1])
  })
})
