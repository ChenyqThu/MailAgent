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
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { useAIChatPanel, openMatterChat } from '@shared/state/ai-chat-panel'

vi.mock('@shared/components/layout/TitleBar', () => ({ TitleBar: () => <div /> }))
vi.mock('@shared/components/layout/Sidebar', () => ({ Sidebar: () => <div /> }))
vi.mock('@shared/components/layout/StatusBar', () => ({ StatusBar: () => <div /> }))
vi.mock('@shared/components/matters/MattersWorkspace', () => ({
  MattersWorkspace: () => <div data-testid="matters-workspace" />
}))
vi.mock('@shared/assistant/modal/AssistantChatModal', () => ({
  AssistantChatModal: () => <div data-testid="assistant-chat-modal" />
}))

const { MattersLayout } = await import('@shared/components/layout/MattersLayout')

beforeEach(() => {
  useAIChatPanel.setState({ visible: false, matterTarget: null, matterConversationEpoch: 0 })
})

afterEach(cleanup)

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
