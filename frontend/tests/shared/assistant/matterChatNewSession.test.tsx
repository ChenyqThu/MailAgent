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
import { act, cleanup, render, waitFor } from '@testing-library/react'

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
const { MAIN_SLOT, useTabWorkspace } = await import('@shared/state/tab-workspace')

await i18n.changeLanguage('zh-CN')

function mount(): { rerender: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // 每次都造一棵新元素树：同一个元素对象复用会让 React 在根上 bailout，rerender 形同没发生。
  const tree = (): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <AssistantChatModal />
    </QueryClientProvider>
  )
  const view = render(tree())
  return { rerender: () => view.rerender(tree()) }
}

/** 这一帧的 chat 是「有内容的会话」还是「空的新对话」；`error` 模拟 selectSession 加载失败
 *  （真 hook 里失败时 messagesSessionId 不会翻到目标会话）。 */
function setChatState(over: {
  activeSessionId: number | null
  error?: { code: string; message: string } | null
}): void {
  const mutable = chat as unknown as {
    activeSessionId: number | null
    messagesSessionId: number | null
    messages: unknown[]
    error: unknown
  }
  mutable.activeSessionId = over.activeSessionId
  mutable.messagesSessionId = over.error ? null : over.activeSessionId
  mutable.messages = []
  mutable.error = over.error ?? null
}

beforeEach(() => {
  vi.clearAllMocks()
  setChatState({ activeSessionId: 5 })
  useAIChatPanel.setState({
    visible: false,
    matterTarget: null,
    matterConversationEpoch: 0,
    pendingTabSession: null
  })
  useTabWorkspace.setState({ tabs: [], active: MAIN_SLOT })
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

// 09-02 —— 对象标签 ↔ dock 会话绑定。FAB 点击时按激活标签的 `chatSessionId` 递一条一次性请求
// （requestTabSession），本组件消费：绑了 → selectSession；没绑 → newSession（已是空的新对话则不动）。
// 会话变化时把 activeSessionId 写回这场对话所属的对象标签（bindTabChatSession）。
describe('标签 ↔ dock 会话绑定（FAB 递来的请求）', () => {
  const MATTER = { id: 42, publicId: 'MAT-0042', title: 'Vendor launch' }
  const chatSessionOf = (id: string): number | undefined =>
    useTabWorkspace.getState().tabs.find((t) => t.id === id)?.chatSessionId

  test('绑定的会话 → selectSession 回到它，不开新；请求被消费掉', async () => {
    useAIChatPanel.getState().setVisible(true)
    mount()
    useAIChatPanel.getState().requestTabSession(7)
    await waitFor(() => expect(chat.selectSession).toHaveBeenCalledWith(7))
    expect(chat.newSession).not.toHaveBeenCalled()
    expect(useAIChatPanel.getState().pendingTabSession).toBeNull()
  })

  test('没绑（null）且当前有会话 → 恰开一场新对话', async () => {
    useAIChatPanel.getState().setVisible(true)
    mount()
    useAIChatPanel.getState().requestTabSession(null)
    await waitFor(() => expect(chat.newSession).toHaveBeenCalledTimes(1))
    expect(chat.selectSession).not.toHaveBeenCalled()
    expect(useAIChatPanel.getState().pendingTabSession).toBeNull()
  })

  test('没绑（null）但已经是空的新对话 → 原地不动', async () => {
    setChatState({ activeSessionId: null })
    useAIChatPanel.getState().setVisible(true)
    mount()
    useAIChatPanel.getState().requestTabSession(null)
    await waitFor(() => expect(useAIChatPanel.getState().pendingTabSession).toBeNull())
    expect(chat.newSession).not.toHaveBeenCalled()
  })

  test('🔴 事项标签的 FAB：同一次点击 openMatterChat + 绑定请求 → 回到绑定会话，事项 effect 让位不 newSession', async () => {
    mount()
    act(() => {
      openMatterChat(MATTER)
      useAIChatPanel.getState().requestTabSession(7)
    })
    await waitFor(() => expect(chat.selectSession).toHaveBeenCalledWith(7))
    // 没让位的话这里会先 newSession 把绑定的会话冲掉（bump navEpoch 重挂 runtime）。
    expect(chat.newSession).not.toHaveBeenCalled()
  })

  test('事项标签的 FAB、未绑定：openMatterChat + null 请求 → 恰一场新对话，不是两场', async () => {
    mount()
    act(() => {
      openMatterChat(MATTER)
      useAIChatPanel.getState().requestTabSession(null)
    })
    await waitFor(() => expect(chat.newSession).toHaveBeenCalledTimes(1))
    expect(chat.selectSession).not.toHaveBeenCalled()
  })

  test('会话变化 → 写回激活的对象标签；挂载那一帧不写（不清标签原有的绑定）', async () => {
    useTabWorkspace.getState().openTab('email', 1, 'A')
    useTabWorkspace.getState().updateTab('email:1', { chatSessionId: 3 })
    useAIChatPanel.getState().setVisible(true)
    const { rerender } = mount()
    // mock 的 chat 挂载时 activeSessionId=5 ≠ 标签绑的 3：挂载不是用户动作，绑定原样
    expect(chatSessionOf('email:1')).toBe(3)

    setChatState({ activeSessionId: 9 })
    rerender()
    await waitFor(() => expect(chatSessionOf('email:1')).toBe(9))

    setChatState({ activeSessionId: null })
    rerender()
    await waitFor(() => expect(chatSessionOf('email:1')).toBeUndefined())
  })

  /** A 开着 dock（A.drawerOpen=true），再开 B（继承 visible），激活位回到 A —— 切标签时 dock 保持开着。 */
  function openTwoTabsDockOpen(): void {
    useTabWorkspace.getState().openTab('email', 1, 'A')
    useAIChatPanel.getState().setVisible(true)
    useTabWorkspace.getState().openTab('email', 2, 'B')
    useTabWorkspace.getState().activateTab('email:1')
  }

  test('🔴 dock 开着切标签 A→B→A：B 没绑 → 新会话；回 A → 回 A 绑的会话；再去 B → 又是新会话', async () => {
    openTwoTabsDockOpen()
    useTabWorkspace.getState().updateTab('email:1', { chatSessionId: 5 })
    mount()
    expect(chat.newSession).not.toHaveBeenCalled()

    act(() => useTabWorkspace.getState().activateTab('email:2'))
    await waitFor(() => expect(chat.newSession).toHaveBeenCalledTimes(1))
    expect(chat.selectSession).not.toHaveBeenCalled()

    act(() => useTabWorkspace.getState().activateTab('email:1'))
    await waitFor(() => expect(chat.selectSession).toHaveBeenCalledWith(5))
    expect(chat.newSession).toHaveBeenCalledTimes(1)

    act(() => useTabWorkspace.getState().activateTab('email:2'))
    await waitFor(() => expect(chat.newSession).toHaveBeenCalledTimes(2))
    expect(useAIChatPanel.getState().pendingTabSession).toBeNull()
  })

  test('待发指令在飞时切标签不同步；落地后再按绑定处理', async () => {
    openTwoTabsDockOpen()
    useTabWorkspace.getState().updateTab('email:2', { chatSessionId: 8 })
    mount()
    // 「立即跟进」递的指令还没派发出去
    act(() => useAIChatPanel.getState().requestChatPrompt('跟进一下', null))
    act(() => useTabWorkspace.getState().activateTab('email:2'))
    await waitFor(() => expect(useTabWorkspace.getState().active).toBe('email:2'))
    expect(chat.selectSession).not.toHaveBeenCalled()
    expect(chat.newSession).not.toHaveBeenCalled()
    // 指令落地 → 这才按 B 的绑定同步
    const nonce = useAIChatPanel.getState().pendingPrompt?.nonce ?? 0
    act(() => useAIChatPanel.getState().consumeChatPrompt(nonce))
    await waitFor(() => expect(chat.selectSession).toHaveBeenCalledWith(8))
    expect(chat.newSession).not.toHaveBeenCalled()
  })

  test('🔴 绑定的会话已被删除（E_LOAD）→ 回落新会话、清掉死绑定，首发拿到新 id 再写回同一标签', async () => {
    useTabWorkspace.getState().openTab('email', 1, 'A')
    useTabWorkspace.getState().updateTab('email:1', { chatSessionId: 5 })
    useAIChatPanel.getState().setVisible(true)
    const { rerender } = mount()
    // 不是按绑定发起的选择所产生的 E_LOAD → 不归回落管
    setChatState({ activeSessionId: 5, error: { code: 'E_LOAD', message: 'x' } })
    rerender()
    expect(chat.newSession).not.toHaveBeenCalled()
    setChatState({ activeSessionId: 5 })
    rerender()

    act(() => useAIChatPanel.getState().requestTabSession(5))
    await waitFor(() => expect(chat.selectSession).toHaveBeenCalledWith(5))
    setChatState({ activeSessionId: 5, error: { code: 'E_LOAD', message: 'session not found' } })
    rerender()
    await waitFor(() => expect(chat.newSession).toHaveBeenCalledTimes(1))
    // 真 hook 里 newSession 把 activeSessionId 置 null → 死绑定被清掉
    setChatState({ activeSessionId: null })
    rerender()
    await waitFor(() => expect(chatSessionOf('email:1')).toBeUndefined())
    // 首发拿到新 id → 写回同一个标签
    setChatState({ activeSessionId: 11 })
    rerender()
    await waitFor(() => expect(chatSessionOf('email:1')).toBe(11))
  })
})
