// @vitest-environment happy-dom
//
// 0812 codex #5 —— 「事项对话」定位这件事最近一次会话时，**查询失败 ≠ 这件事没有历史**。
//
// `listSessionsForMatter` 曾把所有异常吞成 `[]`：serve-api 短暂不可达 / 鉴权失败 / 超时统统长得
// 像「还没有历史」，于是 dock 立刻 `chatNewSession()` —— 用户一发送就为同一件事**又建一条会话**、
// 原历史被割裂；反复抖动能攒出一串重复的事项会话。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { UseGeneralChatReturn } from '@shared/hooks/useGeneralChat'

const { chat, listSessionsForMatter, toastError, mailApi } = vi.hoisted(() => ({
  chat: {
    messages: [],
    error: null,
    activeSessionId: 5,
    messagesSessionId: 5,
    navEpoch: 0,
    sessions: [],
    clearError: vi.fn(),
    newSession: vi.fn(),
    selectSession: vi.fn(async () => {}),
    adoptSession: vi.fn(),
    deleteSession: vi.fn(),
    refreshSessions: vi.fn(async () => {}),
    reloadActiveSession: vi.fn(async () => {})
  } as unknown as UseGeneralChatReturn,
  listSessionsForMatter: vi.fn(),
  toastError: vi.fn(),
  mailApi: {
    chat: { listAllSessions: vi.fn(async () => []) }
  }
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@shared/hooks/useGeneralChat', () => ({ useGeneralChat: () => chat }))
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => mailApi }))
vi.mock('@shared/api/chat_api', () => ({ listSessionsForMatter }))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))
vi.mock('@shared/state/toast', () => ({
  toastError,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))
vi.mock('@shared/components/agents/AgentConversation', () => ({
  AgentConversation: () => <div data-testid="conversation" />
}))

const { AssistantChatModal } = await import('@shared/assistant/modal/AssistantChatModal')
const { useAIChatPanel, openMatterChat } = await import('@shared/state/ai-chat-panel')

await i18n.changeLanguage('zh-CN')

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AssistantChatModal />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useAIChatPanel.setState({ visible: false, matterTarget: null, matterConversationEpoch: 0 })
})

afterEach(cleanup)

describe('「事项对话」的会话定位', () => {
  test('真的没有历史 → 开一场新对话（既有行为）', async () => {
    listSessionsForMatter.mockResolvedValue([])
    mount()
    openMatterChat({ id: 42, publicId: 'MAT-0042', title: 'Vendor launch' })
    await waitFor(() => expect(chat.newSession).toHaveBeenCalled())
    expect(toastError).not.toHaveBeenCalled()
  })

  test('有历史 → 定位到最近一次（不新建）', async () => {
    listSessionsForMatter.mockResolvedValue([{ id: 909 }, { id: 808 }])
    mount()
    openMatterChat({ id: 42, publicId: 'MAT-0042', title: 'Vendor launch' })
    await waitFor(() => expect(chat.selectSession).toHaveBeenCalledWith(909))
    expect(chat.newSession).not.toHaveBeenCalled()
  })

  test('🔴 查询失败 → 保留当前会话并如实告知，**绝不**走「无历史 ⇒ 新建」分支', async () => {
    listSessionsForMatter.mockRejectedValue(new Error('serve-api unreachable'))
    mount()
    openMatterChat({ id: 42, publicId: 'MAT-0042', title: 'Vendor launch' })
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // 这一条是本用例的正主：失败时新建 = 同一件事攒出一串重复会话、历史被割裂。
    expect(chat.newSession).not.toHaveBeenCalled()
    expect(chat.selectSession).not.toHaveBeenCalled()
  })
})
