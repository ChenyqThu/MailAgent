// @vitest-environment happy-dom
//
// 0813 dogfood 轮 3 #5 —— 「事项对话」**每次默认开一场新对话**（历史仍在标题下拉的会话列表里，
// 一条不删）。改造前它去 serve-api 的 list-for-matter 找这件事最近一次会话并选中。
//
// 🔴 三条断言各钉一件事：
//   ① 不再查历史（那条异步会话发现整条退役）；
//   ② 当前对话已经有内容 / 已有会话 id → 开新的；
//   ③ 当前**已经是一场空的新对话**时**不再** newSession —— 这不是省一次调用：父组件的 effect
//      跑在 ChatPromptDispatcher（子）之后，「立即跟进」的指令在这一帧已经 append 出去了，此时
//      bump navEpoch 会重挂 runtime，把刚发出的那轮连流一起冲掉（轮 3 #6 的病根就是这个形状的
//      竞态，只不过原来是异步 selectSession 干的）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { UseGeneralChatReturn } from '@shared/hooks/useGeneralChat'

const { chat, listSessionsForMatter, mailApi } = vi.hoisted(() => ({
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
  mailApi: {
    chat: { listAllSessions: vi.fn(async () => []) }
  }
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@shared/hooks/useGeneralChat', () => ({ useGeneralChat: () => chat }))
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => mailApi }))
vi.mock('@shared/api/chat_api', () => ({ listSessionsForMatter }))
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

/** 这一帧的 chat 是「有内容的会话」还是「空的新对话」。 */
function setChatState(over: { activeSessionId: number | null }): void {
  const mutable = chat as unknown as { activeSessionId: number | null; messages: unknown[] }
  mutable.activeSessionId = over.activeSessionId
  mutable.messages = []
}

beforeEach(() => {
  vi.clearAllMocks()
  setChatState({ activeSessionId: 5 })
  useAIChatPanel.setState({ visible: false, matterTarget: null, matterConversationEpoch: 0 })
})

afterEach(cleanup)

describe('「事项对话」的会话归宿', () => {
  test('默认开一场新对话，且**不**去查这件事的历史会话', async () => {
    mount()
    openMatterChat({ id: 42, publicId: 'MAT-0042', title: 'Vendor launch' })
    await waitFor(() => expect(chat.newSession).toHaveBeenCalled())
    expect(listSessionsForMatter).not.toHaveBeenCalled()
    expect(chat.selectSession).not.toHaveBeenCalled()
  })

  test('再点一次（epoch 自增）→ 再开一场，不复用上一场', async () => {
    mount()
    openMatterChat({ id: 42, publicId: 'MAT-0042', title: 'Vendor launch' })
    await waitFor(() => expect(chat.newSession).toHaveBeenCalledTimes(1))
    openMatterChat({ id: 42, publicId: 'MAT-0042', title: 'Vendor launch' })
    await waitFor(() => expect(chat.newSession).toHaveBeenCalledTimes(2))
  })

  test('🔴 已经是一场空的新对话 → 不再 newSession（否则会冲掉同一次点击刚发出的指令）', async () => {
    setChatState({ activeSessionId: null })
    mount()
    openMatterChat({ id: 42, publicId: 'MAT-0042', title: 'Vendor launch' })
    await waitFor(() => expect(useAIChatPanel.getState().matterTarget).not.toBeNull())
    expect(chat.newSession).not.toHaveBeenCalled()
    expect(chat.selectSession).not.toHaveBeenCalled()
  })
})
