// @vitest-environment happy-dom
//
// email-filter store —— 2026-08 筛选菜单重做后的多轴形状 + 排序持久化。
//
// 这里钉的是**语义边界**，尤其是那条最容易被后续改动踩坏的：二值筛选轴
// 会话级不持久化（老单选 chip 也是），只有 tab / priorities / categories /
// 排序 才写 localStorage —— 「同步失败」这类诊断筛选一旦持久化，用户重启一次
// 就再也看不到新邮件，且完全不知道为什么。

import { beforeEach, describe, expect, test, vi } from 'vitest'

// happy-dom（本仓当前版本）不提供 localStorage —— store 里的 try/catch 会把它
// 静默降级成「不持久化」，那样持久化断言就全成了平凡绿。故在 import 之前先塞一份
// 内存实现（抄 tests/shared/auto-title-settings.test.ts 的先例）；happy-dom 下
// window === globalThis，stubGlobal 同时补上 `window.localStorage`。
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

const { ALL_CATEGORIES, ALL_PRIORITIES, NO_FILTER_AXES, axesOf, useEmailFilter } =
  await import('@shared/state/email-filter')

const KEY_SORT = 'mailagent.emailList.sort.v1'
const KEY_PRI = 'mailagent.emailList.priorities'

function reset(): void {
  useEmailFilter.setState({
    ...NO_FILTER_AXES,
    view: 'inbox',
    customMailbox: null,
    customMailboxPath: [],
    sortKey: 'date',
    sortDir: 'desc',
    selectedPriorities: new Set(ALL_PRIORITIES),
    selectedCategories: new Set(ALL_CATEGORIES)
  })
  window.localStorage.clear()
}

beforeEach(reset)

describe('二值筛选轴', () => {
  test('toggleBool 独立翻转，互不影响（旧单选 chip 表达不了「未读 且 有附件」）', () => {
    const s = useEmailFilter.getState()
    s.toggleBool('unread')
    s.toggleBool('hasAttach')
    const now = useEmailFilter.getState()
    expect(axesOf(now)).toEqual({
      unread: true,
      flagMark: null,
      toMe: false,
      hasAttach: true,
      failed: false
    })
    useEmailFilter.getState().toggleBool('unread')
    expect(useEmailFilter.getState().unread).toBe(false)
    expect(useEmailFilter.getState().hasAttach).toBe(true)
  })

  test('flagMark 是互斥单选，点已选中那档 = 取消', () => {
    const s = useEmailFilter.getState()
    s.toggleFlagMark('flagged')
    expect(useEmailFilter.getState().flagMark).toBe('flagged')
    useEmailFilter.getState().toggleFlagMark('done')
    expect(useEmailFilter.getState().flagMark).toBe('done')
    useEmailFilter.getState().toggleFlagMark('done')
    expect(useEmailFilter.getState().flagMark).toBeNull()
  })

  test('🔴 二值轴不写 localStorage（会话级）', () => {
    useEmailFilter.getState().toggleBool('failed')
    useEmailFilter.getState().toggleFlagMark('flagged')
    expect(window.localStorage.length).toBe(0)
  })

  test('切视图 / 切自定义文件夹归零二值轴（沿用老 chip 的「切视图即归零」）', () => {
    const s = useEmailFilter.getState()
    s.toggleBool('failed')
    s.toggleFlagMark('flagged')
    useEmailFilter.getState().setView('outbox')
    expect(axesOf(useEmailFilter.getState())).toEqual(NO_FILTER_AXES)
    expect(useEmailFilter.getState().customMailbox).toBeNull()

    useEmailFilter.getState().toggleBool('unread')
    useEmailFilter.getState().setCustomMailbox('ProjectX', ['A', 'ProjectX'])
    expect(axesOf(useEmailFilter.getState())).toEqual(NO_FILTER_AXES)
    expect(useEmailFilter.getState().customMailboxPath).toEqual(['A', 'ProjectX'])
  })
})

describe('hasActiveFilter', () => {
  test('任一轴收窄即为 true；多选全选不算收窄', () => {
    expect(useEmailFilter.getState().hasActiveFilter()).toBe(false)
    useEmailFilter.getState().toggleBool('toMe')
    expect(useEmailFilter.getState().hasActiveFilter()).toBe(true)
    useEmailFilter.getState().resetAll()
    expect(useEmailFilter.getState().hasActiveFilter()).toBe(false)
    useEmailFilter.getState().togglePriority('low')
    expect(useEmailFilter.getState().hasActiveFilter()).toBe(true)
  })

  test('🔴 换排序不算「筛选」—— 它没隐藏任何邮件，算进去会让激活点常亮', () => {
    useEmailFilter.getState().setSort('sender')
    useEmailFilter.getState().setSortDir('asc')
    expect(useEmailFilter.getState().hasActiveFilter()).toBe(false)
  })
})

describe('resetAll', () => {
  test('清空所有二值轴 + 多选恢复全选，但不动排序', () => {
    const s = useEmailFilter.getState()
    s.setSort('subject')
    s.toggleBool('unread')
    s.toggleFlagMark('done')
    s.togglePriority('critical')
    s.toggleCategory('🔔 系统通知')
    useEmailFilter.getState().resetAll()
    const now = useEmailFilter.getState()
    expect(axesOf(now)).toEqual(NO_FILTER_AXES)
    expect(now.allPrioritiesSelected()).toBe(true)
    expect(now.allCategoriesSelected()).toBe(true)
    expect(now.sortKey).toBe('subject')
  })
})

describe('排序持久化', () => {
  test('setSort / setSortDir 各自写下完整的 {sortKey,sortDir}', () => {
    useEmailFilter.getState().setSort('importance')
    expect(JSON.parse(window.localStorage.getItem(KEY_SORT)!)).toEqual({
      sortKey: 'importance',
      sortDir: 'desc'
    })
    useEmailFilter.getState().setSortDir('asc')
    expect(JSON.parse(window.localStorage.getItem(KEY_SORT)!)).toEqual({
      sortKey: 'importance',
      sortDir: 'asc'
    })
  })

  test('多选仍走各自的既有 key（形状没动）', () => {
    useEmailFilter.getState().togglePriority('low')
    const stored = JSON.parse(window.localStorage.getItem(KEY_PRI)!) as string[]
    expect(stored).not.toContain('low')
    expect(stored).toHaveLength(ALL_PRIORITIES.length - 1)
  })
})
