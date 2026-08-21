// 0821 owner dogfood — ⌘J 由「只开」改成**开关**。
//
// 原行为：展开状态下再按 ⌘J 无反应，只能按 Esc 或点 FAB 才能收回 dock。
// 这里锁住 toggleChatModal 的两条支路，以及「开」那支必须保留的既有语义
// （clearMatterChat：⌘J 是通用唤出，不继承上一次的事项身份）。
//
// 同类先例：⌘K 命令面板早先也是只开不关（GlobalShortcuts 里那段注释）。

import { beforeEach, describe, expect, test } from 'vitest'

import { toggleChatModal, useAIChatPanel } from '@shared/state/ai-chat-panel'

beforeEach(() => {
  useAIChatPanel.setState({
    visible: false,
    matterTarget: null,
    matterConversationEpoch: 0,
    mode: 'floating'
  })
})

describe('toggleChatModal (⌘J)', () => {
  test('收起状态下 → 展开', () => {
    expect(useAIChatPanel.getState().visible).toBe(false)
    toggleChatModal()
    expect(useAIChatPanel.getState().visible).toBe(true)
  })

  test('展开状态下 → 收起（本次修的 bug：原先无反应）', () => {
    useAIChatPanel.setState({ visible: true })
    toggleChatModal()
    expect(useAIChatPanel.getState().visible).toBe(false)
  })

  test('连按两次回到起点', () => {
    toggleChatModal()
    toggleChatModal()
    expect(useAIChatPanel.getState().visible).toBe(false)
  })

  test('「开」那支仍然清掉事项身份（⌘J 是通用唤出）', () => {
    useAIChatPanel.setState({
      visible: false,
      matterTarget: { id: 7, publicId: 'mt_test', title: 'x' }
    })
    toggleChatModal()
    expect(useAIChatPanel.getState().visible).toBe(true)
    expect(useAIChatPanel.getState().matterTarget).toBeNull()
  })

  test('「关」那支不动缓存的 dock mode', () => {
    useAIChatPanel.setState({ visible: true, mode: 'sidebar' })
    toggleChatModal()
    expect(useAIChatPanel.getState().visible).toBe(false)
    expect(useAIChatPanel.getState().mode).toBe('sidebar')
  })
})
