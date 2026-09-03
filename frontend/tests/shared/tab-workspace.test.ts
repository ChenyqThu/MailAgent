// @vitest-environment happy-dom
//
// 标签工作区 store（task 08-27-l4-tab-workspace P2 波1）。
//
// 这里钉的是后面三个 lane（标签条 UI / 单例投影 / 快捷键）都要靠的语义：去重键、
// LRU 淘汰的**两条豁免**（激活的 + 锁定的）、「全锁定就别开也别关」的整体回滚、
// 关掉激活标签后谁接管、上限 clamp 与「调低不追溯」、以及一份烂存档不能卡住工作区。
//
// happy-dom（本仓当前版本）不提供 localStorage —— store 里的 try/catch 会把持久化
// 静默降级成 no-op，那样持久化断言就全成了平凡绿。故在 import 之前先塞一份内存实现
// （抄 tests/shared/email-filter.test.ts 的先例）；happy-dom 下 window === globalThis，
// stubGlobal 同时补上 `window.localStorage`。

import { beforeEach, describe, expect, test, vi } from 'vitest'

import { NAV_DOMAINS, NAV_OBJECT_DOMAINS, type NavDomain } from '@shared/navigation/registry'

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

const {
  CLOSED_STACK_CAP,
  DEFAULT_MAIN_PAGE,
  MAIN_PAGES,
  MAIN_SLOT,
  MAX_TABS_DEFAULT,
  MAX_TABS_MAX,
  MAX_TABS_MIN,
  SEARCH_TAB_ID,
  SEARCH_TARGET_ID,
  TAB_KIND_DOMAIN,
  selectActiveTab,
  selectActiveTargetId,
  selectDockAnchorTab,
  tabId,
  useTabWorkspace
} = await import('@shared/state/tab-workspace')

const KEY = 'mailagent.tabs.v1'

function reset(): void {
  useTabWorkspace.setState({
    tabs: [],
    active: MAIN_SLOT,
    mainPage: DEFAULT_MAIN_PAGE,
    mainBreadcrumb: null,
    maxTabs: MAX_TABS_DEFAULT,
    closedStack: []
  })
  window.localStorage.clear()
}

beforeEach(reset)

const s = (): ReturnType<typeof useTabWorkspace.getState> => useTabWorkspace.getState()

/** 依次开 n 封邮件（id 1..n），返回它们的 tabId。stamp 单调，所以开的顺序 = LRU 顺序。 */
function openEmails(n: number): string[] {
  const ids: string[] = []
  for (let i = 1; i <= n; i++) {
    s().openTab('email', i, `邮件 ${i}`)
    ids.push(tabId('email', i))
  }
  return ids
}

function persisted(): Record<string, unknown> {
  const raw = window.localStorage.getItem(KEY)
  expect(raw, '没写 localStorage').toBeTruthy()
  return JSON.parse(raw as string) as Record<string, unknown>
}

/** 换一份存档重新加载模块 —— 「关掉 app 再开」的等价物。 */
async function reboot(raw: string | null): Promise<typeof import('@shared/state/tab-workspace')> {
  window.localStorage.clear()
  if (raw !== null) window.localStorage.setItem(KEY, raw)
  vi.resetModules()
  return await import('@shared/state/tab-workspace')
}

// ── 词表一致性闸（registry ↔ 本 store）──────────────────────────────────────
//
// 🔴 TAB_KIND_DOMAIN 是「内容种类 → 一级域」的手抄镜像：registry 的 NAV_OBJECT_DOMAINS
// 元素类型是 NavDomain 而非字面量元组，编译期比不了，只能在这里比。registry 加一个
// 对象域（比如「笔记」也要能多开）而 store 的 TabKind 没跟 → 这条红。
describe('词表 ↔ registry', () => {
  test('TAB_KIND_DOMAIN 的值集 ≡ NAV_OBJECT_DOMAINS', () => {
    expect([...Object.values(TAB_KIND_DOMAIN)].sort()).toEqual([...NAV_OBJECT_DOMAINS].sort())
  })

  test('MAIN_PAGES = 全部域 − 对象域（九种承载，一个不多一个不少）', () => {
    const all = Object.keys(NAV_DOMAINS) as NavDomain[]
    const expected = all.filter((d) => !NAV_OBJECT_DOMAINS.includes(d))
    expect([...MAIN_PAGES].sort()).toEqual([...expected].sort())
    // 09-03 资料库域进页面型承载（八 → 九）。
    expect(MAIN_PAGES).toHaveLength(9)
  })

  test('默认承载是 registry 里真实存在的域', () => {
    expect(Object.keys(NAV_DOMAINS)).toContain(DEFAULT_MAIN_PAGE)
  })
})

// ── 去重 ────────────────────────────────────────────────────────────────────

describe('openTab —— 去重', () => {
  test('同一封邮件再点只激活，不重复开', () => {
    const first = s().openTab('email', 53675, '审批链卡在谁那里')
    expect(first).toEqual({ outcome: 'opened', id: 'email:53675', evicted: [] })

    s().openTab('email', 88, '另一封')
    expect(s().active).toBe('email:88')

    const again = s().openTab('email', 53675, '审批链卡在谁那里')
    expect(again).toEqual({ outcome: 'activated', id: 'email:53675' })
    expect(s().tabs).toHaveLength(2)
    expect(s().active).toBe('email:53675')
    // 重新激活要刷新 LRU 依据，否则「刚看过的」会被当成最久没看的淘汰掉。
    const [tab53675, tab88] = [s().tabs[0], s().tabs[1]]
    expect(tab53675.lastActiveAt).toBeGreaterThan(tab88.lastActiveAt)
  })

  test('去重键是 kind + targetId —— 邮件 7 与事项 7 是两个标签', () => {
    s().openTab('email', 7, '邮件七')
    s().openTab('matter', 7, '事项七')
    expect(s().tabs.map((t) => t.id)).toEqual(['email:7', 'matter:7'])
  })

  test('再次 open 时给了新标题就刷新；省略标题不清空已有的', () => {
    s().openTab('email', 7, '旧标题')
    s().openTab('email', 7, '新标题')
    expect(s().tabs[0].title).toBe('新标题')
    s().openTab('email', 7)
    expect(s().tabs[0].title).toBe('新标题')
  })
})

// ── LRU 淘汰 ────────────────────────────────────────────────────────────────

describe('openTab —— 满了之后的淘汰', () => {
  test('淘汰最久未激活的那个并把它报给调用方（驱逐静默，evicted 信息留给测试/轻提示）', () => {
    s().setMaxTabs(4)
    openEmails(4)
    const r = s().openTab('email', 5, '邮件 5')
    expect(r).toEqual({
      outcome: 'opened',
      id: 'email:5',
      evicted: [{ id: 'email:1', title: '邮件 1' }]
    })
    expect(s().tabs.map((t) => t.id)).toEqual(['email:2', 'email:3', 'email:4', 'email:5'])
    // 新标签在场且当场激活 —— 静默驱逐后这是用户能感知到「开成了」的唯一凭据
    expect(s().active).toBe('email:5')
  })

  test('激活的那个不参与淘汰 —— 哪怕它是最久没被激活的', () => {
    s().setMaxTabs(4)
    openEmails(4)
    // 「激活项同时是最老的」这个局面走公开 API 摆不出来（激活恒刷新 lastActiveAt），
    // 但它在真实使用里会出现：盯着一个标签看很久，其余标签在别处被程序化激活过。
    // 故直接 setState 摆局，专测淘汰这一条规则本身。
    useTabWorkspace.setState({
      tabs: s().tabs.map((t) => (t.id === 'email:1' ? { ...t, lastActiveAt: 1 } : t)),
      active: 'email:1'
    })
    const r = s().openTab('email', 5, '邮件 5')
    expect(r.outcome).toBe('opened')
    expect(s().tabs.map((t) => t.id)).toContain('email:1')
    // 被淘汰的是「非激活里最老的」= 邮件 2
    expect(r.outcome === 'opened' && r.evicted).toEqual([{ id: 'email:2', title: '邮件 2' }])
  })

  test('锁定的那个不参与淘汰（写回复中 / 抽屉聊过）', () => {
    s().setMaxTabs(4)
    openEmails(4)
    s().updateTab('email:1', { locked: true })
    const r = s().openTab('email', 5, '邮件 5')
    expect(r.outcome === 'opened' && r.evicted).toEqual([{ id: 'email:2', title: '邮件 2' }])
    expect(s().tabs.map((t) => t.id)).toEqual(['email:1', 'email:3', 'email:4', 'email:5'])
  })

  test('全锁定 → 不开新标签，也不关任何一个（整体回滚，不是关一半）', () => {
    s().setMaxTabs(4)
    openEmails(4)
    s().updateTab('email:1', { locked: true })
    s().updateTab('email:2', { locked: true })
    s().updateTab('email:3', { locked: true })
    // email:4 是激活项，本来就不在候选里
    const r = s().openTab('email', 5, '邮件 5')
    expect(r).toEqual({ outcome: 'rejected', reason: 'all-locked' })
    expect(s().tabs.map((t) => t.id)).toEqual(['email:1', 'email:2', 'email:3', 'email:4'])
    expect(s().active).toBe('email:4')
  })

  test('只有一个可淘汰但淘汰完仍然装不下 → 一个也不关', () => {
    // 上限 4、开着 5 个（先在 8 的上限下开满 5 个再调低），其中 3 个锁定 + 激活项 1 个，
    // 唯一候选被淘汰后长度仍是 4 ≥ 4 —— 此时必须整体放弃，不能「关了还开不了」。
    openEmails(5)
    s().updateTab('email:1', { locked: true })
    s().updateTab('email:2', { locked: true })
    s().updateTab('email:3', { locked: true })
    useTabWorkspace.setState({ active: 'email:5' })
    s().setMaxTabs(4)
    const r = s().openTab('email', 9, '邮件 9')
    expect(r).toEqual({ outcome: 'rejected', reason: 'all-locked' })
    expect(s().tabs).toHaveLength(5)
  })
})

// ── 关闭 ────────────────────────────────────────────────────────────────────

describe('closeTab', () => {
  test('关掉激活的 → 由「最近用过」的邻居接管（不是数组首尾）', () => {
    openEmails(4)
    s().activateTab('email:2') // 2 成为「上一次看的」
    s().activateTab('email:4')
    s().closeTab('email:4')
    // 剩 [1,2,3]：首是 1、末是 3，都不是答案 —— 只有按 lastActiveAt 取才会得到 2。
    expect(s().active).toBe('email:2')
    expect(s().tabs.map((t) => t.id)).toEqual(['email:1', 'email:2', 'email:3'])
  })

  test('接管者当场成为被看的那个，lastActiveAt 跟着刷新', () => {
    openEmails(3)
    s().activateTab('email:1')
    s().activateTab('email:3')
    const before = s().tabs.find((t) => t.id === 'email:1')?.lastActiveAt ?? 0
    s().closeTab('email:3')
    expect(s().tabs.find((t) => t.id === 'email:1')?.lastActiveAt).toBeGreaterThan(before)
  })

  test('关掉非激活的 → 激活项不动', () => {
    openEmails(3)
    s().closeTab('email:1')
    expect(s().active).toBe('email:3')
  })

  test('关掉最后一个 → 回主标签', () => {
    openEmails(1)
    s().closeTab('email:1')
    expect(s().tabs).toEqual([])
    expect(s().active).toBe(MAIN_SLOT)
  })

  test('关不存在的 id 是 no-op（连一次 set / 持久化都不做）', () => {
    openEmails(2)
    // 比对整个 state 的引用：zustand 每次 set 都换新对象，所以「引用没变」= 真的
    // 什么都没做（否则会白写一次 localStorage，并让所有订阅者重算）。
    const before = s()
    s().closeTab('email:999')
    expect(s()).toBe(before)
  })
})

// ── 激活 / 主标签 ───────────────────────────────────────────────────────────

describe('激活语义与主标签', () => {
  test('activateTab 刷新 lastActiveAt；不存在的 id no-op', () => {
    openEmails(2)
    const stampBefore = s().tabs[0].lastActiveAt
    s().activateTab('email:1')
    expect(s().active).toBe('email:1')
    expect(s().tabs[0].lastActiveAt).toBeGreaterThan(stampBefore)
    const before = s()
    s().activateTab('email:404')
    expect(s()).toBe(before)
    s().activateTab('email:1') // 已经是激活的，同样 no-op
    expect(s()).toBe(before)
  })

  test('activateMain 只换激活槽，标签一个不关', () => {
    openEmails(2)
    s().activateMain()
    expect(s().active).toBe(MAIN_SLOT)
    expect(s().tabs).toHaveLength(2)
  })

  test('setMainPage 隐含激活主标签，并清掉上一个承载的面包屑第二段', () => {
    openEmails(1)
    s().setMainPage('calendar')
    s().setMainBreadcrumb('2026 年 8 月')
    expect(s().active).toBe(MAIN_SLOT)
    s().setMainPage('contacts')
    expect(s().mainBreadcrumb).toBeNull()
  })

  test('再次点中同一个承载不算「切」，不擦掉它自己刚 set 的第二段', () => {
    s().setMainPage('contacts')
    s().setMainBreadcrumb('陈某某')
    s().setMainPage('contacts')
    expect(s().mainBreadcrumb).toBe('陈某某')
  })
})

// ── 上限 ────────────────────────────────────────────────────────────────────

describe('maxTabs', () => {
  test('clamp 到 4-12，非有限值忽略', () => {
    s().setMaxTabs(1)
    expect(s().maxTabs).toBe(MAX_TABS_MIN)
    s().setMaxTabs(99)
    expect(s().maxTabs).toBe(MAX_TABS_MAX)
    s().setMaxTabs(Number.NaN)
    expect(s().maxTabs).toBe(MAX_TABS_MAX)
  })

  test('调低上限不追溯淘汰；下一次 openTab 才按新上限收敛到位', () => {
    openEmails(6)
    s().setMaxTabs(4)
    expect(s().tabs).toHaveLength(6) // 拖个滑杆不当场关掉正在看的东西
    const r = s().openTab('email', 7, '邮件 7')
    expect(r.outcome === 'opened' && r.evicted.map((e) => e.id)).toEqual([
      'email:1',
      'email:2',
      'email:3'
    ])
    expect(s().tabs.map((t) => t.id)).toEqual(['email:4', 'email:5', 'email:6', 'email:7'])
  })
})

// ── 每标签独立的状态 ────────────────────────────────────────────────────────

describe('updateTab', () => {
  test('草稿 / 滚动位置 / 抽屉开合各自独立，切走再回来是原样', () => {
    openEmails(2)
    s().updateTab('email:1', { draft: { body: '写了一半' }, scrollTop: 420, drawerOpen: true })
    s().activateTab('email:2')
    s().activateTab('email:1')
    const tab = s().tabs.find((t) => t.id === 'email:1')
    expect(tab?.draft).toEqual({ body: '写了一半' })
    expect(tab?.scrollTop).toBe(420)
    expect(tab?.drawerOpen).toBe(true)
    expect(s().tabs.find((t) => t.id === 'email:2')?.drawerOpen).toBe(false)
  })

  test('不存在的 id 是 no-op（不新建、也不白写一次）', () => {
    openEmails(1)
    const before = s()
    s().updateTab('email:404', { title: '幽灵' })
    expect(s()).toBe(before)
  })

  test('09-02 chatSessionId（dock 会话绑定）随标签走，并持久化；写 undefined 即清掉', () => {
    openEmails(2)
    s().updateTab('email:1', { chatSessionId: 5 })
    expect(s().tabs.find((t) => t.id === 'email:1')?.chatSessionId).toBe(5)
    expect(s().tabs.find((t) => t.id === 'email:2')?.chatSessionId).toBeUndefined()
    const stored = persisted().tabs as Array<Record<string, unknown>>
    expect(stored.find((t) => t.targetId === 1)?.chatSessionId).toBe(5)
    s().updateTab('email:1', { chatSessionId: undefined })
    expect(s().tabs.find((t) => t.id === 'email:1')?.chatSessionId).toBeUndefined()
  })
})

// ── 搜索标签（「新标签页」单例，P2 补批 Lane S）─────────────────────────────
//
// 走通用语义（LRU 可淘汰 / ⌘W 可关 / closedStack 可找回 / 持久化恢复），只有两条
// 专属规则要钉：单例（targetId 恒 SEARCH_TARGET_ID，去重即单例）与「永不 locked」
// （updateTab 丢弃锁定写入 + 存档里的 locked 放平）。

describe('搜索标签', () => {
  test('单例：开两次只有一个，第二次是 activated（去重键 = search:0）', () => {
    const first = s().openTab('search', SEARCH_TARGET_ID, '新标签页')
    expect(first).toEqual({ outcome: 'opened', id: SEARCH_TAB_ID, evicted: [] })
    s().openTab('email', 1, '邮件 1')
    const again = s().openTab('search', SEARCH_TARGET_ID, '新标签页')
    expect(again).toEqual({ outcome: 'activated', id: SEARCH_TAB_ID })
    expect(s().tabs.filter((t) => t.kind === 'search')).toHaveLength(1)
    expect(s().active).toBe(SEARCH_TAB_ID)
  })

  test('参与 LRU 淘汰（永不锁定 ⇒ 恒是候选）', () => {
    s().setMaxTabs(4)
    s().openTab('search', SEARCH_TARGET_ID, '新标签页')
    openEmails(3) // 满 4，搜索标签是最久未激活的
    const r = s().openTab('email', 9, '邮件 9')
    expect(r.outcome === 'opened' && r.evicted).toEqual([{ id: SEARCH_TAB_ID, title: '新标签页' }])
  })

  test('updateTab 丢弃 locked 写入，其余字段照常', () => {
    s().openTab('search', SEARCH_TARGET_ID, '新标签页')
    s().updateTab(SEARCH_TAB_ID, { locked: true, scrollTop: 120 })
    const tab = s().tabs.find((t) => t.id === SEARCH_TAB_ID)
    expect(tab?.locked).toBe(false)
    expect(tab?.scrollTop).toBe(120)
  })

  test('关掉进最近关闭栈，⌘⇧T 找得回', () => {
    s().openTab('search', SEARCH_TARGET_ID, '新标签页')
    s().closeTab(SEARCH_TAB_ID)
    expect(s().closedStack).toEqual([
      { kind: 'search', targetId: SEARCH_TARGET_ID, title: '新标签页' }
    ])
    expect(s().reopenLastClosed()?.outcome).toBe('opened')
    expect(s().active).toBe(SEARCH_TAB_ID)
  })

  test('持久化恢复：搜索标签回来、激活槽保住，存档里的 locked 放平', async () => {
    const fresh = await reboot(
      JSON.stringify({
        v: 1,
        active: SEARCH_TAB_ID,
        mainPage: 'today',
        maxTabs: 8,
        tabs: [
          { kind: 'email', targetId: 1, title: '邮件 1' },
          { kind: 'search', targetId: SEARCH_TARGET_ID, title: '新标签页', locked: true }
        ]
      })
    )
    const state = fresh.useTabWorkspace.getState()
    expect(state.tabs.map((t) => t.id)).toEqual(['email:1', SEARCH_TAB_ID])
    expect(state.active).toBe(SEARCH_TAB_ID)
    expect(state.tabs[1].locked).toBe(false)
  })

  test('存档被手改出第二个搜索标签（targetId ≠ 0）→ 丢弃，单例判据不破', async () => {
    const fresh = await reboot(
      JSON.stringify({
        v: 1,
        active: 'main',
        tabs: [
          { kind: 'search', targetId: SEARCH_TARGET_ID, title: '新标签页' },
          { kind: 'search', targetId: 5, title: '第二个搜索标签' }
        ]
      })
    )
    expect(fresh.useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual([SEARCH_TAB_ID])
  })
})

// ── 原位换目标（J/K 导航、归档后续选）────────────────────────────────────────

describe('replaceActiveTab', () => {
  test('当前是对象标签 → 原位变身，不新增也不减少标签', () => {
    openEmails(2)
    const r = s().replaceActiveTab('email', 77, '第七十七封')
    expect(r).toEqual({ outcome: 'replaced', id: 'email:77', previousId: 'email:2' })
    expect(s().tabs.map((t) => t.id)).toEqual(['email:1', 'email:77'])
    expect(s().active).toBe('email:77')
    expect(s().tabs[1].title).toBe('第七十七封')
  })

  test('连按十次 J 只占一个标签位（这条是这个 action 存在的理由）', () => {
    openEmails(1)
    for (let i = 10; i < 20; i++) s().replaceActiveTab('email', i, `邮件 ${i}`)
    expect(s().tabs).toHaveLength(1)
    expect(s().active).toBe('email:19')
  })

  test('变身会重置草稿 / 滚动位置 / 抽屉 —— 新目标没写过任何东西', () => {
    openEmails(1)
    s().updateTab('email:1', { draft: { body: '半截' }, scrollTop: 500, drawerOpen: true })
    s().replaceActiveTab('email', 2, '邮件 2')
    const tab = s().tabs[0]
    expect(tab.id).toBe('email:2')
    expect(tab.draft).toBeUndefined()
    expect(tab.scrollTop).toBe(0)
    expect(tab.drawerOpen).toBe(false)
    expect(tab.locked).toBe(false)
  })

  test('🔴 当前标签锁定 → 不原位变身，改开新标签（不吞掉没完成的工作）', () => {
    openEmails(1)
    s().updateTab('email:1', { locked: true, draft: { body: '写到一半的回复' } })
    const r = s().replaceActiveTab('email', 2, '邮件 2')
    expect(r.outcome).toBe('opened')
    expect(s().tabs.map((t) => t.id)).toEqual(['email:1', 'email:2'])
    expect(s().tabs[0].draft).toEqual({ body: '写到一半的回复' })
  })

  test('目标已经开在别的标签里 → 只激活它，当前标签原样保留', () => {
    openEmails(3)
    s().activateTab('email:3')
    const r = s().replaceActiveTab('email', 1, '邮件 1')
    expect(r).toEqual({ outcome: 'activated', id: 'email:1' })
    expect(s().tabs.map((t) => t.id)).toEqual(['email:1', 'email:2', 'email:3'])
    expect(s().active).toBe('email:1')
  })

  test('当前是主标签 → 退回 openTab 语义（开一个新的）', () => {
    s().setMainPage('today')
    const r = s().replaceActiveTab('matter', 5, '事项五')
    expect(r).toEqual({ outcome: 'opened', id: 'matter:5', evicted: [] })
    expect(s().tabs.map((t) => t.id)).toEqual(['matter:5'])
  })

  test('两条常走的分支都不会让调用方出 toast（判据只认 opened 带 evicted / rejected）', () => {
    openEmails(2)
    const morph = s().replaceActiveTab('email', 77, '第七十七封')
    const already = s().replaceActiveTab('email', 1, '邮件 1')
    for (const r of [morph, already]) {
      expect(r.outcome === 'opened' && r.evicted.length > 0).toBe(false)
      expect(r.outcome).not.toBe('rejected')
    }
  })

  test('变身掉的旧目标不进最近关闭栈（翻邮件不该灌满 ⌘⇧T 队列）', () => {
    openEmails(1)
    s().replaceActiveTab('email', 2, '邮件 2')
    expect(s().closedStack).toEqual([])
  })
})

// ── 最近关闭栈 / ⌘⇧T ────────────────────────────────────────────────────────

describe('reopenLastClosed', () => {
  test('LIFO：先关的后回来', () => {
    openEmails(3)
    s().closeTab('email:1')
    s().closeTab('email:2')
    expect(s().reopenLastClosed()?.outcome).toBe('opened')
    expect(s().active).toBe('email:2')
    expect(s().reopenLastClosed()?.outcome).toBe('opened')
    expect(s().active).toBe('email:1')
    expect(s().reopenLastClosed()).toBeNull()
  })

  test('恢复的标签带回标题快照', () => {
    openEmails(1)
    s().closeTab('email:1')
    s().reopenLastClosed()
    expect(s().tabs[0].title).toBe('邮件 1')
  })

  test('被 LRU 挤掉的也进栈 —— 用户没主动关它，得能捞回来', () => {
    s().setMaxTabs(4)
    openEmails(4)
    s().openTab('email', 5, '邮件 5') // 挤掉 email:1
    expect(s().closedStack).toEqual([{ kind: 'email', targetId: 1, title: '邮件 1' }])
    s().reopenLastClosed()
    expect(s().tabs.map((t) => t.id)).toContain('email:1')
  })

  test('栈深上限 10，更早的丢弃', () => {
    openEmails(12)
    for (let i = 1; i <= 12; i++) s().closeTab(`email:${i}`)
    expect(s().closedStack).toHaveLength(CLOSED_STACK_CAP)
    expect(s().closedStack[0].targetId).toBe(12 - CLOSED_STACK_CAP + 1)
    expect(s().closedStack[CLOSED_STACK_CAP - 1].targetId).toBe(12)
  })

  test('同一个对象在栈里只留一条（关两次不该按两下 ⌘⇧T）', () => {
    openEmails(2)
    s().closeTab('email:1')
    s().openTab('email', 1, '邮件 1')
    s().closeTab('email:1')
    expect(s().closedStack.filter((e) => e.targetId === 1)).toHaveLength(1)
  })

  test('恢复走去重：目标已经被重新打开过 → 只激活，条目照样出栈', () => {
    openEmails(2)
    s().closeTab('email:1')
    s().openTab('email', 1, '重新点开的') // 用户自己又点开了
    expect(s().reopenLastClosed()).toEqual({ outcome: 'activated', id: 'email:1' })
    expect(s().tabs).toHaveLength(2)
    expect(s().closedStack).toEqual([])
  })

  test('满且全锁定 → 开不成，条目留在栈里等下次', () => {
    s().setMaxTabs(4)
    openEmails(5) // 第 5 个挤掉 email:1，它进栈
    s().updateTab('email:2', { locked: true })
    s().updateTab('email:3', { locked: true })
    s().updateTab('email:4', { locked: true })
    const r = s().reopenLastClosed()
    expect(r).toEqual({ outcome: 'rejected', reason: 'all-locked' })
    expect(s().closedStack).toHaveLength(1)
  })

  test('恢复时顺带挤掉了别的标签 → 出栈的是恢复的那条，不是刚被挤掉的新栈顶', () => {
    s().setMaxTabs(4)
    openEmails(5) // 邮件 5 挤掉邮件 1 → 栈 [1]
    s().closeTab('email:2') // 栈 [1,2]
    s().openTab('email', 6, '邮件 6') // 补满到 4 个：[3,4,5,6]
    s().reopenLastClosed() // 恢复邮件 2，过程中挤掉最旧的邮件 3 → 栈顶变成 3
    const targets = s().closedStack.map((e) => e.targetId)
    expect(targets).toContain(1)
    expect(targets).toContain(3)
    expect(targets).not.toContain(2) // 弹的是「恢复的那条」而不是新栈顶
  })

  test('栈不持久化：重启后从空开始', async () => {
    openEmails(2)
    s().closeTab('email:1')
    expect(persisted()).not.toHaveProperty('closedStack')
    const fresh = await reboot(window.localStorage.getItem(KEY))
    expect(fresh.useTabWorkspace.getState().closedStack).toEqual([])
  })
})

// ── 选择器 ──────────────────────────────────────────────────────────────────

describe('选择器', () => {
  test('selectActiveTab —— 主标签激活时是 null', () => {
    openEmails(1)
    expect(selectActiveTab(s())?.id).toBe('email:1')
    s().activateMain()
    expect(selectActiveTab(s())).toBeNull()
  })

  test('selectActiveTargetId 按 kind 分流（激活的是另一类时给 null）', () => {
    s().openTab('matter', 12, '事项十二')
    expect(selectActiveTargetId(s(), 'matter')).toBe(12)
    expect(selectActiveTargetId(s(), 'email')).toBeNull()
  })

  test('09-02 selectDockAnchorTab —— 邮件 / 事项标签给标签本体；主标签 / 搜索标签 null', () => {
    expect(selectDockAnchorTab(s())).toBeNull()
    s().openTab('email', 1, '邮件一')
    expect(selectDockAnchorTab(s())?.id).toBe('email:1')
    s().openTab('matter', 12, '事项十二')
    expect(selectDockAnchorTab(s())?.id).toBe('matter:12')
    s().openTab('search', SEARCH_TARGET_ID, '搜索')
    expect(selectDockAnchorTab(s())).toBeNull()
    s().activateMain()
    expect(selectDockAnchorTab(s())).toBeNull()
  })
})

// ── 持久化 ──────────────────────────────────────────────────────────────────

describe('持久化', () => {
  test('关掉 app 再开：标签集、激活项、承载页、上限都回来', async () => {
    s().setMaxTabs(6)
    openEmails(2)
    s().updateTab('email:1', { draft: { body: '半截草稿' }, scrollTop: 88, locked: true })
    s().setMainPage('reports')
    s().activateTab('email:1')

    const fresh = await reboot(window.localStorage.getItem(KEY))
    const state = fresh.useTabWorkspace.getState()
    expect(state.tabs.map((t) => t.id)).toEqual(['email:1', 'email:2'])
    expect(state.active).toBe('email:1')
    expect(state.mainPage).toBe('reports')
    expect(state.maxTabs).toBe(6)
    const restored = state.tabs[0]
    expect(restored.draft).toEqual({ body: '半截草稿' })
    expect(restored.scrollTop).toBe(88)
    expect(restored.locked).toBe(true)
  })

  test('面包屑第二段不进存档（承载页挂载时自己会 set）', () => {
    s().setMainPage('ops')
    s().setMainBreadcrumb('同步看板')
    expect(persisted()).not.toHaveProperty('mainBreadcrumb')
  })

  test('坏 JSON → 回默认，不卡住工作区', async () => {
    const fresh = await reboot('{ 这不是 json')
    const state = fresh.useTabWorkspace.getState()
    expect(state.tabs).toEqual([])
    expect(state.active).toBe(MAIN_SLOT)
    expect(state.mainPage).toBe(DEFAULT_MAIN_PAGE)
    expect(state.maxTabs).toBe(MAX_TABS_DEFAULT)
  })

  test('形状版本对不上 → 整份丢弃（旧形状不做迁移）', async () => {
    const fresh = await reboot(
      JSON.stringify({ v: 0, tabs: [{ kind: 'email', targetId: 1 }], active: 'email:1' })
    )
    expect(fresh.useTabWorkspace.getState().tabs).toEqual([])
  })

  test('逐条校验：坏条目丢掉、重复条目去重、缺字段补默认', async () => {
    const fresh = await reboot(
      JSON.stringify({
        v: 1,
        maxTabs: 8,
        mainPage: 'today',
        active: 'main',
        tabs: [
          { kind: 'email', targetId: 1, title: '好的', lastActiveAt: 5, drawerOpen: true },
          { kind: 'email', targetId: 1, title: '重复的' },
          { kind: 'note', targetId: 2, title: '不认识的 kind' },
          { kind: 'email', targetId: 'abc', title: 'targetId 不是数' },
          null,
          { kind: 'matter', targetId: 3 }
        ]
      })
    )
    const tabs = fresh.useTabWorkspace.getState().tabs
    expect(tabs.map((t) => t.id)).toEqual(['email:1', 'matter:3'])
    expect(tabs[0].drawerOpen).toBe(true)
    expect(tabs[1]).toMatchObject({ title: '', locked: false, drawerOpen: false, scrollTop: 0 })
  })

  test('09-02 存档里的 chatSessionId：正整数保留，其余（负数 / 0 / 非数）丢弃', async () => {
    const fresh = await reboot(
      JSON.stringify({
        v: 1,
        maxTabs: 8,
        mainPage: 'today',
        active: 'main',
        tabs: [
          { kind: 'email', targetId: 1, chatSessionId: 5 },
          { kind: 'email', targetId: 2, chatSessionId: -3 },
          { kind: 'matter', targetId: 3, chatSessionId: 0 },
          { kind: 'matter', targetId: 4, chatSessionId: 'x' }
        ]
      })
    )
    const byId = new Map(fresh.useTabWorkspace.getState().tabs.map((t) => [t.id, t]))
    expect(byId.get('email:1')?.chatSessionId).toBe(5)
    expect(byId.get('email:2')?.chatSessionId).toBeUndefined()
    expect(byId.get('matter:3')?.chatSessionId).toBeUndefined()
    expect(byId.get('matter:4')?.chatSessionId).toBeUndefined()
  })

  test('存档里的 active 指向一个不存在的标签 → 回主标签', async () => {
    const fresh = await reboot(
      JSON.stringify({ v: 1, tabs: [{ kind: 'email', targetId: 1 }], active: 'email:999' })
    )
    expect(fresh.useTabWorkspace.getState().active).toBe(MAIN_SLOT)
  })

  test('存档里的 mainPage / maxTabs 离谱 → 各自回默认与 clamp', async () => {
    const fresh = await reboot(
      JSON.stringify({ v: 1, tabs: [], active: 'main', mainPage: 'mail', maxTabs: 999 })
    )
    // 'mail' 是对象域不是页面承载 —— 不能落进主标签槽
    expect(fresh.useTabWorkspace.getState().mainPage).toBe(DEFAULT_MAIN_PAGE)
    expect(fresh.useTabWorkspace.getState().maxTabs).toBe(MAX_TABS_MAX)
  })

  test('存档里塞了几十个标签 → 截到硬上限，保留最近用过的', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      kind: 'email',
      targetId: i + 1,
      title: `邮件 ${i + 1}`,
      lastActiveAt: i + 1
    }))
    const fresh = await reboot(JSON.stringify({ v: 1, tabs: many, active: 'main' }))
    const tabs = fresh.useTabWorkspace.getState().tabs
    expect(tabs).toHaveLength(MAX_TABS_MAX)
    expect(tabs[0].id).toBe(`email:${30 - MAX_TABS_MAX + 1}`)
    expect(tabs[MAX_TABS_MAX - 1].id).toBe('email:30')
  })
})

// ── retargetTab（dogfood 波3 —— draft replace 换锚）─────────────────────────

describe('retargetTab —— replace 换锚', () => {
  test('换锚是身份延续：字段与标签条位置全保留，只换 id / targetId，并持久化', () => {
    openEmails(3)
    s().updateTab('email:2', {
      title: '周报草稿',
      locked: true,
      draft: { kind: 'compose', dirty: true },
      scrollTop: 120
    })
    s().retargetTab('email', 2, 200)
    const tabs = s().tabs
    // 位置保留（不是关一个开一个挪到尾部）
    expect(tabs.map((t) => t.id)).toEqual(['email:1', 'email:200', 'email:3'])
    expect(tabs[1]).toMatchObject({
      kind: 'email',
      targetId: 200,
      title: '周报草稿',
      locked: true,
      scrollTop: 120
    })
    expect(tabs[1].draft).toEqual({ kind: 'compose', dirty: true })
    // 换的是后台标签 → 激活槽不动
    expect(s().active).toBe('email:3')
    const savedTabs = persisted().tabs as Array<{ targetId: number }>
    expect(savedTabs.map((t) => t.targetId)).toEqual([1, 200, 3])
  })

  test('激活槽指向被换锚的标签 → 跟到新 id（激活态连续）', () => {
    openEmails(2)
    expect(s().active).toBe('email:2')
    s().retargetTab('email', 2, 200)
    expect(s().active).toBe('email:200')
  })

  test('新 targetId 已有同类标签 → 合并：保留源标签现场，重复者移除且不进最近关闭栈', () => {
    openEmails(2) // email:1, email:2
    s().openTab('email', 200, '镜像行提前开着')
    s().updateTab('email:2', { title: '源标签的现场', scrollTop: 66 })
    const stackBefore = s().closedStack
    s().activateTab('email:200')
    s().retargetTab('email', 2, 200)
    const tabs = s().tabs
    // 源标签（原位置 index 1）继承身份，重复者（原 index 2）消失
    expect(tabs.map((t) => t.id)).toEqual(['email:1', 'email:200'])
    expect(tabs[1].title).toBe('源标签的现场')
    expect(tabs[1].scrollTop).toBe(66)
    // 激活槽原指重复者 → 改指合并后的标签
    expect(s().active).toBe('email:200')
    // 合并不是用户关闭 —— ⌘⇧T 捞回一个重复标签毫无意义
    expect(s().closedStack).toEqual(stackBefore)
  })

  test('no-op：源标签不存在 / 新旧同值 / 搜索单例不许换锚', () => {
    openEmails(1)
    s().openTab('search', SEARCH_TARGET_ID)
    const before = s().tabs
    s().retargetTab('email', 999, 1000)
    s().retargetTab('email', 1, 1)
    s().retargetTab('search', SEARCH_TARGET_ID, 5)
    expect(s().tabs).toBe(before)
    expect(s().tabs.some((t) => t.id === SEARCH_TAB_ID)).toBe(true)
  })
})

// ── reorderTab（P5 拖拽排序）────────────────────────────────────────────────
//
// 数组序 = 标签条顺序 = ⌘1-9/⌃⇥ 的槽位序（tab-commands 的 slotOrder 直接
// `tabs.map(id)`，数组序对了它就对）。重排不是激活：lastActiveAt / active 都不动，
// 否则拖一下标签会改写 LRU 淘汰顺位。

describe('reorderTab —— 拖拽排序', () => {
  test('移到目标 index，其余标签相对序不变；激活槽不动，并持久化', () => {
    openEmails(3) // [1,2,3]，active = email:3
    s().reorderTab('email:1', 2)
    expect(s().tabs.map((t) => t.id)).toEqual(['email:2', 'email:3', 'email:1'])
    expect(s().active).toBe('email:3')
    const savedTabs = persisted().tabs as Array<{ targetId: number }>
    expect(savedTabs.map((t) => t.targetId)).toEqual([2, 3, 1])
  })

  test('不刷新 lastActiveAt（重排不是激活，LRU 淘汰顺位不变）', () => {
    openEmails(3)
    const before = s().tabs.find((t) => t.id === 'email:1')?.lastActiveAt
    s().reorderTab('email:1', 2)
    expect(s().tabs.find((t) => t.id === 'email:1')?.lastActiveAt).toBe(before)
    // 挪到末位的 email:1 仍是最久未激活的 —— 满员时先淘汰的还是它
    s().setMaxTabs(4)
    s().openTab('email', 4, '邮件 4')
    const result = s().openTab('email', 5, '邮件 5')
    expect(result.outcome === 'opened' && result.evicted[0]?.id).toBe('email:1')
  })

  test('越界 index clamp 到首/末位', () => {
    openEmails(3)
    s().reorderTab('email:3', -5)
    expect(s().tabs.map((t) => t.id)).toEqual(['email:3', 'email:1', 'email:2'])
    s().reorderTab('email:3', 99)
    expect(s().tabs.map((t) => t.id)).toEqual(['email:1', 'email:2', 'email:3'])
  })

  test('no-op：同位 / 未知 id / 非有限 index —— 不动状态也不写盘', () => {
    openEmails(3)
    const before = s().tabs
    window.localStorage.clear()
    s().reorderTab('email:2', 1) // 已在 index 1
    s().reorderTab('email:999', 0)
    s().reorderTab('email:1', Number.NaN)
    expect(s().tabs).toBe(before)
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  test('只有一个标签：任何 index 都 clamp 回 0 ⇒ 恒 no-op（length-1 边界）', () => {
    openEmails(1)
    const before = s().tabs
    window.localStorage.clear()
    s().reorderTab('email:1', 0)
    s().reorderTab('email:1', 3) // clamp 到 length-1 = 0，与原位相同
    expect(s().tabs).toBe(before)
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  test('关掉 app 再开：重排后的顺序按存档恢复', async () => {
    openEmails(3)
    s().reorderTab('email:3', 0)
    const fresh = await reboot(window.localStorage.getItem(KEY))
    expect(fresh.useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual([
      'email:3',
      'email:1',
      'email:2'
    ])
  })
})
