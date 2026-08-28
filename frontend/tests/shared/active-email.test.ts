// active-email 状态测试。08-27 标签工作区（Lane W）起它是「激活邮件标签 targetId 的投影」：
// setActive 是唯一桥（默认 openTab / mode:'replace' 原位换目标），标签条侧的激活变化经
// 订阅反向投影（带 navTarget 豁免语义）。pickNext/pickPrev 仍是纯函数表格测试。
//
// The zustand store instance touches localStorage on construction, which we stub at
// module level so the test stays in the node-environment pool (no jsdom).

import { describe, expect, test, vi, beforeEach } from 'vitest'

// Stub localStorage BEFORE importing the store so the module-level hydrate
// doesn't blow up under the node pool.
const memoryStore: Record<string, string> = {}
const localStorageStub = {
  getItem: (k: string) => (k in memoryStore ? memoryStore[k] : null),
  setItem: (k: string, v: string) => {
    memoryStore[k] = v
  },
  removeItem: (k: string) => {
    delete memoryStore[k]
  },
  clear: () => {
    for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  }
}
vi.stubGlobal('localStorage', localStorageStub)
// tab-workspace 的持久化走 `window.localStorage`（`typeof window === 'undefined'` 短路）——
// node 池里补一个最小 window，冷启动恢复的用例才有存取面。
vi.stubGlobal('window', { localStorage: localStorageStub })

const mod = await import('../../src/shared/state/active-email')
const { pickNext, pickPrev, useActiveEmail } = mod
const { MAIN_SLOT, useTabWorkspace } = await import('../../src/shared/state/tab-workspace')

function resetTabs(): void {
  useTabWorkspace.setState({
    tabs: [],
    active: MAIN_SLOT,
    mainPage: 'today',
    mainBreadcrumb: null,
    maxTabs: 8,
    closedStack: []
  })
}

beforeEach(() => {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  resetTabs()
  useActiveEmail.setState({ activeInternalId: null, navTargetId: null, orderedIds: [] })
})

describe('pickNext', () => {
  test('empty list → null', () => {
    expect(pickNext([], null)).toBeNull()
    expect(pickNext([], 42)).toBeNull()
  })

  test('null current → first id (treat as "no prior selection")', () => {
    expect(pickNext([101, 102, 103], null)).toBe(101)
  })

  test('current not in list → first id (stale-id recovery)', () => {
    expect(pickNext([201, 202], 999)).toBe(201)
  })

  test('walks forward', () => {
    expect(pickNext([101, 102, 103], 101)).toBe(102)
    expect(pickNext([101, 102, 103], 102)).toBe(103)
  })

  test('tail stops at tail (DESIGN.md §9.5 — no wrap)', () => {
    expect(pickNext([101, 102, 103], 103)).toBe(103)
  })
})

describe('pickPrev', () => {
  test('empty list → null', () => {
    expect(pickPrev([], null)).toBeNull()
    expect(pickPrev([], 42)).toBeNull()
  })

  test('null current → first id', () => {
    expect(pickPrev([101, 102, 103], null)).toBe(101)
  })

  test('stale id → first id', () => {
    expect(pickPrev([201, 202], 999)).toBe(201)
  })

  test('walks backward', () => {
    expect(pickPrev([101, 102, 103], 103)).toBe(102)
    expect(pickPrev([101, 102, 103], 102)).toBe(101)
  })

  test('head stops at head (no wrap)', () => {
    expect(pickPrev([101, 102, 103], 101)).toBe(101)
  })
})

describe('useActiveEmail — setActive 转发标签 store（08-27 标签工作区）', () => {
  test('setActive(n) 落本地投影并开出邮件标签', () => {
    useActiveEmail.getState().setActive(53675, { title: '主题' })
    expect(useActiveEmail.getState().activeInternalId).toBe(53675)
    const ws = useTabWorkspace.getState()
    expect(ws.tabs.map((t) => t.id)).toEqual(['email:53675'])
    expect(ws.active).toBe('email:53675')
    expect(ws.tabs[0].title).toBe('主题')
  })

  test('同一封再点只激活，不重复开（kind+targetId 去重）', () => {
    useActiveEmail.getState().setActive(1)
    useActiveEmail.getState().setActive(2)
    useActiveEmail.getState().setActive(1)
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual(['email:1', 'email:2'])
    expect(useTabWorkspace.getState().active).toBe('email:1')
  })

  test("J/K（mode:'replace'）原位换目标，不涨标签数", () => {
    useActiveEmail.getState().setActive(1)
    useActiveEmail.getState().setActive(2, { mode: 'replace' })
    useActiveEmail.getState().setActive(3, { mode: 'replace' })
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual(['email:3'])
    expect(useActiveEmail.getState().activeInternalId).toBe(3)
    // replace 是「用户自己翻邮件」，不设 navTarget
    expect(useActiveEmail.getState().navTargetId).toBeNull()
  })

  test('setActive(null) 是视图局部取消选中：标签不动', () => {
    useActiveEmail.getState().setActive(7)
    useActiveEmail.getState().setActive(null)
    expect(useActiveEmail.getState().activeInternalId).toBeNull()
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual(['email:7'])
    expect(useTabWorkspace.getState().active).toBe('email:7')
  })

  test('navTarget 语义按调用透传（深链/搜索跳转豁免 active-reset）', () => {
    useActiveEmail.getState().setActive(9, { navTarget: true })
    expect(useActiveEmail.getState().navTargetId).toBe(9)
    useActiveEmail.getState().setActive(10)
    expect(useActiveEmail.getState().navTargetId).toBeNull()
  })
})

describe('useActiveEmail — 标签 store 侧激活的反向投影', () => {
  test('标签条激活另一封 → 投影更新且带 navTarget 豁免', () => {
    useActiveEmail.getState().setActive(1)
    useActiveEmail.getState().setActive(2)
    // 模拟标签条点击（Lane U 直接调 store action）
    useTabWorkspace.getState().activateTab('email:1')
    expect(useActiveEmail.getState().activeInternalId).toBe(1)
    expect(useActiveEmail.getState().navTargetId).toBe(1)
  })

  test('激活位切去主标签 → 邮件投影清空', () => {
    useActiveEmail.getState().setActive(1)
    useTabWorkspace.getState().activateMain()
    expect(useActiveEmail.getState().activeInternalId).toBeNull()
  })

  test('关掉激活标签 → 最近用过的邮件标签接管并投影', () => {
    useActiveEmail.getState().setActive(1)
    useActiveEmail.getState().setActive(2)
    useTabWorkspace.getState().closeTab('email:2')
    expect(useActiveEmail.getState().activeInternalId).toBe(1)
  })
})

describe('useActiveEmail — 冷启动恢复', () => {
  test('恢复的激活邮件标签成为初值，且同步进 navTargetId（豁免 active-reset）', async () => {
    memoryStore['mailagent.tabs.v1'] = JSON.stringify({
      v: 1,
      tabs: [
        {
          kind: 'email',
          targetId: 321,
          title: '恢复的邮件',
          lastActiveAt: 5,
          locked: false,
          drawerOpen: false,
          scrollTop: 0
        }
      ],
      active: 'email:321',
      mainPage: 'today',
      maxTabs: 8
    })
    vi.resetModules()
    const fresh = await import('../../src/shared/state/active-email')
    expect(fresh.useActiveEmail.getState().activeInternalId).toBe(321)
    expect(fresh.useActiveEmail.getState().navTargetId).toBe(321)
  })

  test('存档损坏（坏 JSON）→ 回退 null，不抛', async () => {
    memoryStore['mailagent.tabs.v1'] = '{broken'
    vi.resetModules()
    const fresh = await import('../../src/shared/state/active-email')
    expect(fresh.useActiveEmail.getState().activeInternalId).toBeNull()
  })
})
