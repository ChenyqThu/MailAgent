// @vitest-environment happy-dom
//
// 09-02 —— 右下角 FAB 的两件新事（邮件页 / 事项页共用同一个组件）：
//   ① 锚对象 = 激活的邮件 / 事项标签，且其详情在显示；事项标签点击时顺带 seed 事项 chip
//     （openMatterChat），邮件标签走通用唤出（邮件 chip 由 AgentConversation 自己 seed）；
//   ② 对象标签 ↔ dock 会话绑定：点击按标签的 `chatSessionId` 递请求 —— 绑了回它的会话，
//     没绑开新会话；两个标签交替各回各的，不串。
// 头像本体 / hover 纪律在 chat_fab_avatar.test.tsx，这里 stub 掉。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { useActiveEmail } from '@shared/state/active-email'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'
import { MAIN_SLOT, useTabWorkspace } from '@shared/state/tab-workspace'
import {
  _resetMatterIdentityForTest,
  registerMatterIdentity
} from '@shared/components/matters/matterTabIdentity'
import {
  resetMatterWorkspace,
  useMatterWorkspace
} from '@shared/components/matters/matterWorkspaceStore'

vi.mock('@shared/assistant/modal/ChatFabAvatar', () => ({
  ChatFabAvatar: () => <div data-testid="chat-fab-avatar" />
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const { ChatModalFab } = await import('@shared/assistant/modal/ChatModalFab')

function pending(): { sessionId: number | null; nonce: number } | null {
  return useAIChatPanel.getState().pendingTabSession
}

function clickFab(): void {
  fireEvent.click(screen.getByRole('button', { name: 'chat.fab.label' }))
}

/** 收起 dock（FAB 回来）并切到另一个标签 —— store 写在 act 里，FAB 才会在下一次点击前重渲染。 */
function hideDockAndActivate(tabId: string): void {
  act(() => {
    useAIChatPanel.setState({ visible: false })
    useTabWorkspace.getState().activateTab(tabId)
  })
}

beforeEach(() => {
  useAIChatPanel.setState({
    visible: false,
    matterTarget: null,
    matterConversationEpoch: 0,
    pendingTabSession: null
  })
  useTabWorkspace.setState({ tabs: [], active: MAIN_SLOT })
  useActiveEmail.setState({ activeInternalId: null, navTargetId: null })
  _resetMatterIdentityForTest()
  resetMatterWorkspace()
})

afterEach(cleanup)

describe('ChatModalFab — 锚对象', () => {
  test('邮件标签：通用唤出（不带事项种子）+ 未绑定 → 请求 null', () => {
    useTabWorkspace.getState().openTab('email', 1, 'A')
    render(<ChatModalFab />)
    clickFab()
    const state = useAIChatPanel.getState()
    expect(state.visible).toBe(true)
    expect(state.matterTarget).toBeNull()
    expect(pending()).toEqual({ sessionId: null, nonce: 1 })
  })

  test('事项标签：带这件事的种子唤出（与「立即跟进」同一 seed）', () => {
    registerMatterIdentity(7, 'MAT-0007')
    useTabWorkspace.getState().openTab('matter', 7, 'Vendor launch')
    render(<ChatModalFab />)
    clickFab()
    const state = useAIChatPanel.getState()
    expect(state.matterTarget).toEqual({ id: 7, publicId: 'MAT-0007', title: 'Vendor launch' })
    expect(state.matterConversationEpoch).toBe(1)
    expect(pending()).toEqual({ sessionId: null, nonce: 1 })
  })

  test('事项标签在但详情没在显示（selectedId 已清）→ 不渲染', () => {
    registerMatterIdentity(7, 'MAT-0007')
    useTabWorkspace.getState().openTab('matter', 7, 'Vendor launch')
    useMatterWorkspace.setState({ selectedId: null })
    render(<ChatModalFab />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('ChatModalFab — 标签 ↔ 会话绑定', () => {
  test('🔴 两个标签交替：各回各的会话，不串', () => {
    useTabWorkspace.getState().openTab('email', 1, 'A')
    useTabWorkspace.getState().updateTab('email:1', { chatSessionId: 5 })
    registerMatterIdentity(7, 'MAT-0007')
    useTabWorkspace.getState().openTab('matter', 7, 'B')
    useTabWorkspace.getState().updateTab('matter:7', { chatSessionId: 9 })

    // 激活位在事项标签上 → 回它绑的 9
    render(<ChatModalFab />)
    clickFab()
    expect(pending()?.sessionId).toBe(9)
    expect(useAIChatPanel.getState().matterTarget?.publicId).toBe('MAT-0007')

    // 收起 dock、切回邮件标签 → 回它绑的 5（通用唤出，事项种子清掉）
    hideDockAndActivate('email:1')
    clickFab()
    expect(pending()?.sessionId).toBe(5)
    expect(useAIChatPanel.getState().matterTarget).toBeNull()

    // 再回事项标签 → 仍是 9
    hideDockAndActivate('matter:7')
    clickFab()
    expect(pending()?.sessionId).toBe(9)
  })

  test('同一标签连点两次各算一次（nonce 递增，请求不被去重吞掉）', () => {
    useTabWorkspace.getState().openTab('email', 1, 'A')
    render(<ChatModalFab />)
    clickFab()
    expect(pending()?.nonce).toBe(1)
    hideDockAndActivate('email:1')
    clickFab()
    expect(pending()?.nonce).toBe(2)
  })
})
