// @vitest-environment happy-dom
//
// 标签工作区的键盘命令层（task 08-27-l4-tab-workspace P2 · Lane K）。
//
// 这里钉的是「按键 → 状态变化」的语义，不是按键分发本身（那是 useShortcut 的
// 既有测试）：⌘W 在主标签上的沉默、⌃⇥ 的循环序（含回卷方向）、⌘1-9 用的是
// **数组序不是 LRU 序**、⌘⇧T 的三种结局各自出不出声。
//
// happy-dom（本仓当前版本）不提供 localStorage —— tab-workspace 的 try/catch 会把
// 持久化静默降级成 no-op。这里塞一份内存实现，理由与写法同 tests/shared/tab-workspace.test.ts。

import { beforeEach, describe, expect, test, vi } from 'vitest'

const memory: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (k in memory ? memory[k] : null),
  setItem: (k: string, v: string) => {
    memory[k] = v
  },
  removeItem: (k: string) => {
    delete memory[k]
  },
  clear: () => {
    for (const k of Object.keys(memory)) delete memory[k]
  },
  get length() {
    return Object.keys(memory).length
  }
})

const { DEFAULT_MAIN_PAGE, MAIN_SLOT, tabId, useTabWorkspace } =
  await import('@shared/state/tab-workspace')
const { closeActiveTab, cycleTab, jumpToSlot, reopenClosedTab } =
  await import('@shared/state/tab-commands')
const { __resetToastStore, useToastStore } = await import('@shared/state/toast')
const { SHORTCUTS, TAB_CLOSE_SPEC, TAB_CYCLE_NEXT_SPEC, TAB_CYCLE_PREV_SPEC, TAB_JUMP_SPECS } =
  await import('@shared/keymap')
const i18n = (await import('@shared/i18n')).default

// t() 要返回真实 zh-CN 资源，中文断言才成立（spec frontend/i18n.md）。
await i18n.changeLanguage('zh-CN')

function reset(): void {
  useTabWorkspace.setState({
    tabs: [],
    active: MAIN_SLOT,
    mainPage: DEFAULT_MAIN_PAGE,
    mainBreadcrumb: null,
    maxTabs: 4,
    closedStack: []
  })
  __resetToastStore()
}

/** 开 n 个邮件标签（targetId / 标题都用序号），返回它们的 id（数组序 = 标签条顺序）。 */
function openEmails(n: number): string[] {
  const store = useTabWorkspace.getState()
  const ids: string[] = []
  for (let i = 1; i <= n; i++) {
    store.openTab('email', i, `邮件${i}`)
    ids.push(tabId('email', i))
  }
  return ids
}

function activeSlot(): string {
  return useTabWorkspace.getState().active
}

function toastTitles(): string[] {
  return useToastStore.getState().items.map((t) => t.title)
}

beforeEach(reset)

describe('⌘W closeActiveTab', () => {
  test('关掉当前对象标签，接管的是最近用过的那个', () => {
    const [first, second] = openEmails(2)
    expect(activeSlot()).toBe(second)

    expect(closeActiveTab()).toBe(true)
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual([first])
    expect(activeSlot()).toBe(first)
  })

  test('主标签激活时什么也不关（主标签不可关）', () => {
    const ids = openEmails(2)
    useTabWorkspace.getState().activateMain()

    expect(closeActiveTab()).toBe(false)
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual(ids)
    expect(activeSlot()).toBe(MAIN_SLOT)
  })
})

describe('⌃⇥ cycleTab', () => {
  test('循环序 = 主标签 → 对象标签数组序 → 回主标签', () => {
    const [t1, t2, t3] = openEmails(3)
    expect(activeSlot()).toBe(t3)

    cycleTab(1)
    expect(activeSlot()).toBe(MAIN_SLOT) // 末尾回卷到主标签
    cycleTab(1)
    expect(activeSlot()).toBe(t1)
    cycleTab(1)
    expect(activeSlot()).toBe(t2)
  })

  test('⌃⇧⇥ 反向，且从主标签往前回卷到最后一个标签', () => {
    const [t1, t2, t3] = openEmails(3)
    useTabWorkspace.getState().activateTab(t2)

    cycleTab(-1)
    expect(activeSlot()).toBe(t1)
    cycleTab(-1)
    expect(activeSlot()).toBe(MAIN_SLOT)
    cycleTab(-1)
    expect(activeSlot()).toBe(t3)
  })

  test('循环用的是数组序，不是 LRU 序', () => {
    const [t1, t2, t3] = openEmails(3)
    // 把 t1 变成最近用过的那个：LRU 序此刻是 t1 > t3 > t2。
    useTabWorkspace.getState().activateTab(t1)

    cycleTab(1)
    expect(activeSlot()).toBe(t2) // 数组序里 t1 的下一个
    expect(activeSlot()).not.toBe(t3)
  })

  test('只有主标签一个槽位时是 no-op', () => {
    expect(cycleTab(1)).toBe(false)
    expect(activeSlot()).toBe(MAIN_SLOT)
  })
})

describe('⌘1-9 jumpToSlot', () => {
  test('⌘1 = 主标签，⌘2-9 = 对象标签的第 1-8 个（数组序）', () => {
    const [t1, t2] = openEmails(2)

    expect(jumpToSlot(1)).toBe(true)
    expect(activeSlot()).toBe(MAIN_SLOT)
    expect(jumpToSlot(2)).toBe(true)
    expect(activeSlot()).toBe(t1)
    expect(jumpToSlot(3)).toBe(true)
    expect(activeSlot()).toBe(t2)
  })

  test('位置上没有标签 → 不动', () => {
    const [t1] = openEmails(1)
    expect(jumpToSlot(9)).toBe(false)
    expect(activeSlot()).toBe(t1)
  })

  test('位置是屏幕上的第几个，不随 LRU 变', () => {
    const [t1, t2, t3] = openEmails(3)
    useTabWorkspace.getState().activateTab(t1)

    jumpToSlot(4)
    expect(activeSlot()).toBe(t3)
    jumpToSlot(3)
    expect(activeSlot()).toBe(t2)
  })
})

describe('⌘⇧T reopenClosedTab', () => {
  test('恢复刚关掉的那个，不出提示', () => {
    const [t1, t2] = openEmails(2)
    useTabWorkspace.getState().closeTab(t1)
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual([t2])

    expect(reopenClosedTab()).toBe(true)
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual([t2, t1])
    expect(activeSlot()).toBe(t1)
    expect(toastTitles()).toEqual([])
  })

  test('栈空 → 静默忽略（按了没东西可恢复不该弹提示）', () => {
    openEmails(1)
    expect(reopenClosedTab()).toBe(false)
    expect(toastTitles()).toEqual([])
  })

  test('恢复时挤掉了别人 → 提示说清关掉的是哪个', () => {
    // maxTabs=4：开满 → 关掉 t1（进最近关闭栈）→ 再开 t5 填回满员。
    const [t1, t2] = openEmails(4)
    useTabWorkspace.getState().closeTab(t1)
    useTabWorkspace.getState().openTab('email', 5, '邮件5')
    expect(useTabWorkspace.getState().tabs).toHaveLength(4)

    expect(reopenClosedTab()).toBe(true)
    // 淘汰的是最久未激活且非锁定的 t2。
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).not.toContain(t2)
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).toContain(t1)
    expect(toastTitles()).toHaveLength(1)
    expect(toastTitles()[0]).toContain('邮件2')
  })

  test('满了且全锁定 → 提示先关一个，条目留在栈里等下次', () => {
    const [t1] = openEmails(4)
    useTabWorkspace.getState().closeTab(t1)
    useTabWorkspace.getState().openTab('email', 5, '邮件5')
    for (const tab of useTabWorkspace.getState().tabs) {
      useTabWorkspace.getState().updateTab(tab.id, { locked: true })
    }

    expect(reopenClosedTab()).toBe(false)
    expect(useTabWorkspace.getState().tabs).toHaveLength(4)
    expect(toastTitles()[0]).toContain('标签已满')

    // 解锁一个（于是有了可淘汰的）再按一次仍然能恢复 —— 说明刚才那次没把栈顶吃掉。
    const victim = useTabWorkspace.getState().tabs[0]
    useTabWorkspace.getState().updateTab(victim.id, { locked: false })
    expect(reopenClosedTab()).toBe(true)
    const ids = useTabWorkspace.getState().tabs.map((t) => t.id)
    expect(ids).toContain(t1)
    expect(ids).not.toContain(victim.id)
  })
})

describe('keymap 目录', () => {
  const byId = (id: string): (typeof SHORTCUTS)[number] | undefined =>
    SHORTCUTS.find((s) => s.id === id)

  test('四条标签绑定都在 global 段且已接线', () => {
    for (const id of ['tabClose', 'tabReopen', 'tabCycle', 'tabJump']) {
      const def = byId(id)
      expect(def, id).toBeDefined()
      expect(def?.scope).toBe('global')
      expect(def?.wired).toBe(true)
    }
  })

  test('catalog 的 spec 由常量拼出，与注册点同源', () => {
    expect(byId('tabClose')?.spec).toBe(TAB_CLOSE_SPEC)
    expect(byId('tabCycle')?.spec).toBe(`${TAB_CYCLE_NEXT_SPEC} ${TAB_CYCLE_PREV_SPEC}`)
    expect(byId('tabJump')?.spec).toBe(TAB_JUMP_SPECS.join(' '))
    expect(TAB_JUMP_SPECS).toHaveLength(9)
  })

  test('新绑定的 label 在两侧 locale 都有真实文案', async () => {
    const ids = ['tabClose', 'tabReopen', 'tabCycle', 'tabJump', 'generalAgent']
    for (const locale of ['zh-CN', 'en-US'] as const) {
      await i18n.changeLanguage(locale)
      for (const id of ids) {
        const key = byId(id)?.labelKey ?? ''
        const label = i18n.t(key)
        expect(label, `${locale} ${id}`).not.toBe(key)
        expect(label.length, `${locale} ${id}`).toBeGreaterThan(0)
      }
    }
    await i18n.changeLanguage('zh-CN')
  })
})
