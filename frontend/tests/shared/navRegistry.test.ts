// nav registry 的跨通道派生闸（task 08-24-l4-nav-shell Step R）。
//
// registry 是一级入口的单源；这里钉住的是**从它派生出去的四个通道**，以及那些「换个地方
// 就会静默失效」的引用（i18n key / keymap binding id）：
//
//   · `mailagent://` deeplink：kind → path 的映射覆盖 DeeplinkTarget 的全部 kind
//   · 通知深链白名单：**只有现状三条**（这条闸的价值是防「顺手扩面」，不是防漏）
//   · 全局快捷键：⌘, / ⌘O 的组合键仍来自 keymap.ts，registry 只按 id 引用
//   · ⌘K jump / 侧栏：文案 key 在两个 locale 都存在（缺一边 = 那个语言渲染裸 key）
//
// 🔴 期望值是**手写**的（不是从 registry 反推），所以改 registry 而没想清楚的那一刻会红。
// 侧栏渲染面的投影闸在 tests/components/sidebar-contract.test.tsx。

import { describe, expect, test } from 'vitest'

import zhCN from '../../src/shared/i18n/locales/zh-CN/common.json'
import enUS from '../../src/shared/i18n/locales/en-US/common.json'
import { SHORTCUTS } from '../../src/shared/keymap'
import {
  NAV_DEEPLINK_PATH,
  NAV_DOMAINS,
  NAV_ENTRIES,
  NOTIFICATION_ROUTE_TARGETS,
  isNavEntryActive,
  navActiveDomain,
  navEntry,
  navPaletteEntries,
  navShortcutDisplay,
  navShortcutSpec,
  type NavDomain
} from '../../src/shared/navigation/registry'

function lookup(locale: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (node === null || typeof node !== 'object') return undefined
    return (node as Record<string, unknown>)[part]
  }, locale)
}

describe('nav registry — 条目自身的不变量', () => {
  test('id 唯一', () => {
    const ids = NAV_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('同一域内 panel.order 不重复（重复 = 顺序变成数组序的巧合）', () => {
    const seen = new Set<string>()
    for (const entry of NAV_ENTRIES) {
      if (!entry.panel) continue
      const key = `${entry.domain}#${entry.panel.order}`
      expect(seen.has(key), `重复的 panel 落位: ${key}`).toBe(false)
      seen.add(key)
    }
  })

  test('palette.order 不重复', () => {
    const orders = NAV_ENTRIES.filter((e) => e.palette).map((e) => e.palette?.order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  test('rail.order 不重复（导轨格序同理 —— 重复就退化成数组序的巧合）', () => {
    const orders = NAV_ENTRIES.filter((e) => e.rail).map((e) => e.rail?.order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  test('有目标的一级入口都进了 ⌘K jump（邮件五视图除外）', () => {
    // prd v2 R2「⌘K jump 全量覆盖」是方案 B 少了一级横向直达后的补偿路径。下面那条
    // 手写清单只钉现有八条的**顺序** —— 新加一条入口忘了给 palette 落位，它不会红
    // （实测：往 registry 塞一条只有 panel 的条目，侧栏闸红三条、jump 闸全绿）。所以
    // 这里从「有没有落位」这一侧再钉一次：漏跟的通道会点名是哪条 entry。
    const missing = NAV_ENTRIES.filter(
      (e) =>
        e.gate !== 'never' && e.to !== undefined && e.view === undefined && e.palette === undefined
    ).map((e) => e.id)
    expect(missing, `这些入口没进 ⌘K jump: ${missing.join(', ')}`).toEqual([])
  })

  test('⌘K jump 静态段 = 全部一级入口（邮件五视图除外，它们由 mailbox 行覆盖）', () => {
    // 手写期望（顺序 = 面板里自上而下）。渲染侧由 CommandPaletteContacts 的
    //「打开通讯录」用例钉住（投影出来的行真能点、真会跳）。
    expect(navPaletteEntries(NAV_ENTRIES).map((e) => e.id)).toEqual([
      'today',
      'sessions',
      'kanban',
      'calendar',
      'matters',
      'agents',
      'reports',
      'llm',
      'contacts',
      'settings'
    ])
    // 邮件视图有意不进 jump：⌘K 里已有按邮箱名过滤的 mailbox 行。
    expect(NAV_ENTRIES.filter((e) => e.view !== undefined && e.palette !== undefined)).toEqual([])
  })

  test('能渲染的条目都有目标（只有 gate:never 的预留位可以没有 to）', () => {
    for (const entry of NAV_ENTRIES) {
      if (entry.gate === 'never') continue
      expect(entry.to, `${entry.id} 没有 to`).toBeTruthy()
    }
  })

  // 08-27 批：邮件域的 MAILBOXES 行搬到列表头的文件夹下拉（FolderMenu / EmailListHeader），
  // 那两处按 `NAV_ENTRIES` 投影 —— 它们不是组件树里能拿到 `useVisibleNavEntries()` 的位置
  // （EmailListHeader 的投影是模块级常量）。等价的前提就是这一条：邮件五视图全都恒在。
  // 🔴 给其中任何一条加门控（如把草稿箱挂到 DRAFTS_SYNC_ENABLED），这条会红 —— 那时要把
  // 两处投影改成吃门控过滤后的集合，否则下拉会渲染出该隐藏的行。
  test('邮件五视图恒 gate:always（列表头下拉按未过滤的 NAV_ENTRIES 投影）', () => {
    const mail = NAV_ENTRIES.filter((e) => e.domain === 'mail')
    expect(mail.length).toBe(5)
    expect(mail.filter((e) => e.gate !== 'always')).toEqual([])
  })
})

describe('nav registry — deeplink 通道', () => {
  test('kind → path 映射 = 现状五条', () => {
    expect(NAV_DEEPLINK_PATH).toEqual({
      email: '/',
      calendar: '/admin/calendar',
      kanban: '/admin/kanban',
      llm: '/admin/llm',
      settings: '/settings'
    })
  })

  test('映射值与标了 deeplinkKind 的条目逐条对上', () => {
    for (const entry of NAV_ENTRIES) {
      if (entry.deeplinkKind === undefined) continue
      expect(NAV_DEEPLINK_PATH[entry.deeplinkKind]).toBe(entry.to)
    }
  })
})

describe('nav registry — 通知深链白名单', () => {
  test('只有现状三条（加档要先确认真有信源会发它）', () => {
    expect([...NOTIFICATION_ROUTE_TARGETS].sort()).toEqual([
      '/admin/kanban',
      '/agents',
      '/settings'
    ])
  })

  test('白名单成员 = 标了 notificationRoute 的条目', () => {
    const marked = NAV_ENTRIES.filter((e) => e.notificationRoute === true).map((e) => e.to)
    expect([...NOTIFICATION_ROUTE_TARGETS].sort()).toEqual(marked.sort())
  })
})

describe('nav registry — 全局快捷键', () => {
  test('⌘, → 设置 · ⌘O → 通用 agent 视图（组合键权威仍是 keymap.ts）', () => {
    expect(navShortcutSpec(navEntry('settings'))).toBe('cmd+,')
    expect(navShortcutDisplay(navEntry('settings'))).toBe('⌘,')
    expect(navShortcutSpec(navEntry('sessions'))).toBe('cmd+o')
  })

  test('每个 shortcutId 在 keymap 里都存在（改了 id 不会静默变成永不命中的空 spec）', () => {
    for (const entry of NAV_ENTRIES) {
      if (entry.shortcutId === undefined) continue
      const def = SHORTCUTS.find((s) => s.id === entry.shortcutId)
      expect(def, `keymap 缺 binding: ${entry.shortcutId}`).toBeTruthy()
      expect(navShortcutSpec(entry)).toBe(def?.spec)
    }
  })
})

describe('nav registry — i18n key 在两个 locale 都在', () => {
  const locales: [string, Record<string, unknown>][] = [
    ['zh-CN', zhCN as Record<string, unknown>],
    ['en-US', enUS as Record<string, unknown>]
  ]

  test('侧栏 / jump 会渲染的条目，label 与 meta 文案都能解出来', () => {
    for (const entry of NAV_ENTRIES) {
      // gate:'never' 的预留位不渲染，locale 里可以没有它的文案（现无此类条目）。
      if (entry.gate === 'never') continue
      for (const [name, locale] of locales) {
        if ('i18nKey' in entry.label) {
          expect(
            lookup(locale, entry.label.i18nKey),
            `${name} 缺 ${entry.label.i18nKey}`
          ).toBeTruthy()
        }
        const paletteKeys = [entry.palette?.labelI18nKey, entry.palette?.metaI18nKey]
        for (const key of paletteKeys) {
          if (key === undefined) continue
          expect(lookup(locale, key), `${name} 缺 ${key}`).toBeTruthy()
        }
      }
    }
  })

  test('域标签（导轨格 / 面板头）在两个 locale 都在', () => {
    for (const [, meta] of Object.entries(NAV_DOMAINS)) {
      if (!('i18nKey' in meta.label)) continue
      for (const [name, locale] of locales) {
        expect(lookup(locale, meta.label.i18nKey), `${name} 缺 ${meta.label.i18nKey}`).toBeTruthy()
      }
    }
  })
})

describe('nav registry — 域推导（导轨选中格 = 面板域）', () => {
  test('每条路由归它该归的域；/sessions 归 chats 域（08-27 批从 agents 拆出）', () => {
    const cases: ReadonlyArray<[string, NavDomain]> = [
      ['/', 'mail'],
      ['/today', 'today'],
      ['/sessions', 'chats'],
      ['/agents', 'agents'],
      ['/matters', 'matters'],
      ['/contacts', 'contacts'],
      ['/admin/calendar', 'calendar'],
      ['/admin/llm', 'ops'],
      ['/admin/kanban', 'ops'],
      ['/admin', 'ops'],
      ['/settings', 'settings']
    ]
    for (const [pathname, domain] of cases) {
      expect(navActiveDomain(NAV_ENTRIES, pathname), pathname).toBe(domain)
    }
  })

  test('过渡期 /agents 按 ?tab= 细分：reports 归报告域，其余归团队（agents）域', () => {
    expect(navActiveDomain(NAV_ENTRIES, '/agents', 'reports')).toBe('reports')
    expect(navActiveDomain(NAV_ENTRIES, '/agents', 'agents')).toBe('agents')
    expect(navActiveDomain(NAV_ENTRIES, '/agents', 'chats')).toBe('agents')
    // 无 searchTab（validateSearch 之外的调用面）回落缺省归属域。
    expect(navActiveDomain(NAV_ENTRIES, '/agents')).toBe('agents')
  })
})

describe('nav registry — 选中态判据', () => {
  test('子路由走前缀、老路径走 exact、别的条目不误命中', () => {
    const llm = navEntry('llm')
    const kanban = navEntry('kanban')
    const calendar = navEntry('calendar')
    const matters = navEntry('matters')
    expect(isNavEntryActive(llm, '/admin/llm')).toBe(true)
    expect(isNavEntryActive(llm, '/admin/llm/detail')).toBe(true)
    expect(isNavEntryActive(llm, '/llm')).toBe(true)
    expect(isNavEntryActive(llm, '/admin/kanban')).toBe(false)
    // `/admin` 会 redirect 到看板，选中态提前跟上（现状转录）。
    expect(isNavEntryActive(kanban, '/admin')).toBe(true)
    expect(isNavEntryActive(calendar, '/admin/calendar')).toBe(true)
    expect(isNavEntryActive(matters, '/matters')).toBe(true)
    expect(isNavEntryActive(matters, '/contacts')).toBe(false)
  })
})
