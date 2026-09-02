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

  // 09-02 对话域拆分（owner 拍板推翻 08-27 的「不开对象标签」语义）：`chats` 升对象域后
  // 一个会话就是一个标签，⌘O = 进 AI Chat 域 + 开一个**新**会话标签。
  test('⌘O 进 AI Chat 域并开一个新会话标签；连按两次开两个', () => {
    press('o', { meta: true })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(navigate.mock.calls[0][0])).toContain('/sessions')
    expect(ids()).toHaveLength(3)
    const first = ids()[2]
    expect(useTabWorkspace.getState().active).toBe(first)

    press('o', { meta: true })
    expect(ids()).toHaveLength(4)
    // 🔴 去重键是 `kind:targetId` —— 临时 id 每次都新，两次按出来的是两个标签而不是
    // 「第二次只激活第一个」。发出第一条前它们都是负 id（不跨重启恢复）。
    expect(ids()[3]).not.toBe(first)
    for (const id of [ids()[2], ids()[3]]) {
      expect(id.startsWith('chat:-'), id).toBe(true)
    }
  })

  test('⌘G 去群聊域，不碰标签集', () => {
    press('g', { meta: true })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(navigate.mock.calls[0][0])).toContain('/groups')
    // 群聊是页面域（主标签承载），不该开对象标签。
    expect(ids()).toEqual([tabId('email', 1), tabId('email', 2)])
  })
})
