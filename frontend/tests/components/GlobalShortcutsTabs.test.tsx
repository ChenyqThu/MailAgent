// @vitest-environment happy-dom
//
// 标签工作区快捷键的**接线闸**（task 08-27-l4-tab-workspace P2 · Lane K）。
//
// 语义本身在 tests/shared/tabShortcuts.test.ts；这里只钉「按下去真的到得了」——
// spec 字符串写错、忘了注册、⌘1-9 只注册了第一个，都属于「命令层全绿但功能不存在」
// 的静默失效，只有从 document 上真发一次 keydown 才抓得到。
//
// 🔴 ⌘W 那条还多钉一件事：主标签激活时也必须 preventDefault —— macOS windowMenu 的
// close role 同样绑 ⌘W，不消费就是「想关标签，结果关了整个窗口」。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { GlobalShortcuts } from '@shared/components/keyboard/GlobalShortcuts'
import { __resetShortcutBus } from '@shared/hooks/useShortcut'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'
import {
  DEFAULT_MAIN_PAGE,
  MAIN_SLOT,
  SEARCH_TAB_ID,
  tabId,
  useTabWorkspace
} from '@shared/state/tab-workspace'
import { __resetToastStore } from '@shared/state/toast'

function press(
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}
): KeyboardEvent {
  const evt = new KeyboardEvent('keydown', {
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    bubbles: true,
    cancelable: true
  })
  document.dispatchEvent(evt)
  return evt
}

function ids(): string[] {
  return useTabWorkspace.getState().tabs.map((t) => t.id)
}

beforeEach(() => {
  __resetShortcutBus()
  __resetToastStore()
  navigate.mockClear()
  useTabWorkspace.setState({
    tabs: [],
    active: MAIN_SLOT,
    mainPage: DEFAULT_MAIN_PAGE,
    mainBreadcrumb: null,
    maxTabs: 8,
    closedStack: []
  })
  useAIChatPanel.setState({ pendingNewAgentSession: 0 })
  const store = useTabWorkspace.getState()
  store.openTab('email', 1, '邮件1')
  store.openTab('email', 2, '邮件2')
  render(<GlobalShortcuts />)
})

afterEach(() => {
  cleanup()
  __resetShortcutBus()
})

describe('GlobalShortcuts — 标签快捷键接线', () => {
  test('⌘W 关掉当前标签', () => {
    expect(useTabWorkspace.getState().active).toBe(tabId('email', 2))
    const evt = press('w', { meta: true })
    expect(ids()).toEqual([tabId('email', 1)])
    expect(evt.defaultPrevented).toBe(true)
  })

  test('⌘W 在主标签上不关任何东西，但仍然被消费（否则窗口会被关掉）', () => {
    useTabWorkspace.getState().activateMain()
    const evt = press('w', { meta: true })
    expect(ids()).toHaveLength(2)
    expect(evt.defaultPrevented).toBe(true)
  })

  test('⌘T 打开「新标签页」搜索单例；再按只激活不重复开', () => {
    const evt = press('t', { meta: true })
    expect(evt.defaultPrevented).toBe(true)
    expect(ids()).toContain(SEARCH_TAB_ID)
    expect(useTabWorkspace.getState().active).toBe(SEARCH_TAB_ID)
    // 切走再按 —— 去重只激活（⌘⇧T 的 shift 不落到这条：spec 修饰键精确匹配）。
    useTabWorkspace.getState().activateMain()
    press('t', { meta: true })
    expect(ids().filter((id) => id === SEARCH_TAB_ID)).toHaveLength(1)
    expect(useTabWorkspace.getState().active).toBe(SEARCH_TAB_ID)
  })

  test('⌘⇧T 恢复刚关掉的标签', () => {
    press('w', { meta: true })
    expect(ids()).toEqual([tabId('email', 1)])
    press('t', { meta: true, shift: true })
    expect(ids()).toEqual([tabId('email', 1), tabId('email', 2)])
    expect(useTabWorkspace.getState().active).toBe(tabId('email', 2))
  })

  test('⌃⇥ 往后循环、⌃⇧⇥ 往前，⌘⇥ 不算（那是系统的 App 切换）', () => {
    press('Tab', { ctrl: true })
    expect(useTabWorkspace.getState().active).toBe(MAIN_SLOT)
    press('Tab', { ctrl: true, shift: true })
    expect(useTabWorkspace.getState().active).toBe(tabId('email', 2))

    const meta = press('Tab', { meta: true })
    expect(useTabWorkspace.getState().active).toBe(tabId('email', 2))
    expect(meta.defaultPrevented).toBe(false)
  })

  test('⌘1 回主标签，⌘2 / ⌘3 按数组序直达（九条全注册）', () => {
    press('1', { meta: true })
    expect(useTabWorkspace.getState().active).toBe(MAIN_SLOT)
    press('2', { meta: true })
    expect(useTabWorkspace.getState().active).toBe(tabId('email', 1))
    press('3', { meta: true })
    expect(useTabWorkspace.getState().active).toBe(tabId('email', 2))
    // 位置为空 —— 不动，但仍消费掉（⌘9 在只开两个标签时该是「无事发生」）。
    const evt = press('9', { meta: true })
    expect(useTabWorkspace.getState().active).toBe(tabId('email', 2))
    expect(evt.defaultPrevented).toBe(true)
  })

  test('⌘O 导航到对话页并排一次「新建会话」，不开对象标签', () => {
    press('o', { meta: true })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(navigate.mock.calls[0][0])).toContain('/sessions')
    expect(useAIChatPanel.getState().pendingNewAgentSession).toBe(1)
    expect(ids()).toHaveLength(2)
    // 连按两次是两次新建（nonce 自增，不被「已经排着队」吞掉）。
    press('o', { meta: true })
    expect(useAIChatPanel.getState().pendingNewAgentSession).toBe(2)
  })
})
