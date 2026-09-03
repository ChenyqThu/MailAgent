// @vitest-environment happy-dom
//
// 0812 dogfood P0 —— 事项详情的「事项对话」点了没反应。
//
// 根因不在按钮：`openMatterChat()` 只写 zustand，而唯一消费 `matterTarget` 的
// AssistantChatModal 当时**只挂在 InboxLayout（`/`）**上；`/matters` 走 MattersLayout，
// 组件树里没有这个消费者 = 状态写下去那一屏没人读。本用例钉的是修复后的结构不变量：
//   ① /matters 这条路由自己有 dock 宿主，且 dock 在展开后真的挂上；
//   ② 宿主是 <main> 的**兄弟**（sidebar 模式靠这个 flex 位置挤压正文，不能挂进 main 里）；
//   ③ 从未展开过 → 不挂载（不下载 chunk、不建会话）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { useAIChatPanel, openMatterChat } from '@shared/state/ai-chat-panel'
import { MAIN_SLOT, useTabWorkspace } from '@shared/state/tab-workspace'

vi.mock('@shared/components/layout/TitleBar', () => ({ TitleBar: () => <div /> }))
vi.mock('@shared/components/layout/Sidebar', () => ({ Sidebar: () => <div /> }))
vi.mock('@shared/components/matters/MattersWorkspace', () => ({
  MattersWorkspace: () => <div data-testid="matters-workspace" />
}))
vi.mock('@shared/assistant/modal/AssistantChatModal', () => ({
  AssistantChatModal: () => <div data-testid="assistant-chat-modal" />
}))
vi.mock('@shared/assistant/modal/ChatFabAvatar', () => ({
  ChatFabAvatar: () => <div data-testid="chat-fab-avatar" />
}))

const { MattersLayout } = await import('@shared/components/layout/MattersLayout')
const { registerMatterIdentity, _resetMatterIdentityForTest } =
  await import('@shared/components/matters/matterTabIdentity')
const { resetMatterWorkspace } = await import('@shared/components/matters/matterWorkspaceStore')

beforeEach(() => {
  useAIChatPanel.setState({
    visible: false,
    matterTarget: null,
    matterConversationEpoch: 0,
    pendingTabSession: null
  })
  useTabWorkspace.setState({ tabs: [], active: MAIN_SLOT })
  _resetMatterIdentityForTest()
  resetMatterWorkspace()
})

afterEach(cleanup)

// 09-02 —— 事项页的对话入口与邮件页同一个右下角 FAB（头部「事项对话」按钮已删）。
describe('MattersLayout — 右下角 FAB', () => {
  test('没有激活的事项标签 → 不渲染 FAB', () => {
    render(<MattersLayout />)
    expect(screen.queryByTestId('chat-fab-avatar')).toBeNull()
  })

  test('激活的事项标签在场 → FAB 在；点击 = 带这件事的 chip 唤出 dock + 递标签的会话请求', () => {
    registerMatterIdentity(42, 'MAT-0042')
    // 开标签 → matterWorkspaceStore 把 selectedId 投影成 MAT-0042（详情在显示）
    useTabWorkspace.getState().openTab('matter', 42, 'Vendor launch')
    render(<MattersLayout />)

    fireEvent.click(screen.getByTestId('chat-fab-avatar'))

    const state = useAIChatPanel.getState()
    expect(state.visible).toBe(true)
    expect(state.matterTarget).toEqual({ id: 42, publicId: 'MAT-0042', title: 'Vendor launch' })
    // 这个标签还没绑会话 → 请求 null（= 开新会话，由 AssistantChatModal 消费）
    expect(state.pendingTabSession).toEqual({ sessionId: null, nonce: 1 })
    // dock 展开后 FAB 让位
    expect(screen.queryByTestId('chat-fab-avatar')).toBeNull()
  })
})

describe('MattersLayout — AI chat dock host', () => {
  test('从未展开过 → 不挂载 dock', () => {
    render(<MattersLayout />)
    expect(screen.queryByTestId('assistant-chat-modal')).toBeNull()
  })

  test('事项对话（openMatterChat）后 dock 真的挂上，且是 <main> 的兄弟', async () => {
    render(<MattersLayout />)
    openMatterChat({ id: 42, publicId: 'MAT-0042', title: 'Vendor launch' })

    const dock = await screen.findByTestId('assistant-chat-modal')
    await waitFor(() => expect(useAIChatPanel.getState().visible).toBe(true))
    expect(useAIChatPanel.getState().matterTarget?.publicId).toBe('MAT-0042')

    const main = screen.getByRole('main', { name: 'matters' })
    // dock 必须与 <main> 同父（master-detail 行内），不能被塞进 <main> 里。
    expect(main.contains(dock)).toBe(false)
    expect(main.parentElement?.contains(dock)).toBe(true)
  })
})
