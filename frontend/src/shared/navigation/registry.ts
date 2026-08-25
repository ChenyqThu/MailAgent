// 一级导航入口的**单源**（task 08-24-l4-nav-shell Step R）。
//
// 在这之前，同一个入口散在五处互为手抄镜像：侧栏行（layout/Sidebar.tsx）、⌘K jump 段
// （command/CommandPalette.tsx）、通知深链白名单（notifications/navigation.ts）、
// `mailagent://` deeplink 的 kind→path switch（router-instance.tsx）、原生菜单/全局快捷键
// （keyboard/GlobalShortcuts.tsx + router-instance 的 useGeneralAgentMenu）。加一个入口要
// 记得改五处，漏一处不报错 —— 只是那个通道到不了。
//
// 本模块只描述「有哪些入口、它们长什么样、去哪里」；**怎么渲染**留在各通道（侧栏行的
// 徽标形状、palette 行的排版都是各自的表现层）。
//
// 🔴 叶子模块纪律：运行时只依赖 react + 图标出口 + keymap（keymap.ts 零 import）。类型可以
// 跨域引（`import type` 编译期擦除）。**不要**在这里 import store / hooks / api —— 门控求值
// 在 `useNavGates.ts`，那才是可以碰 hooks 的地方。
//
// 🔴 路径字面量只允许出现在本文件：`navigateToNavEntry` / `preloadNavEntry` 的 switch 是
// 「NavPath → TanStack 具体 navigate 选项」的唯一适配层（TanStack 的 `search` 形状按 `to`
// 变化，联合类型传不进去，所以必须逐个 case 落地）。switch 对 NavPath 全覆盖，加一个新
// 路径漏了 case 会在 typecheck 当场红。
//
// domain / rail / panel 三个维度（Step B 起全部被消费）：rail 是 56px 图标导轨格
// （格的脸 = NAV_DOMAINS 的域标签/域图标），panel 是域二级栏（DomainPanel）里本域
// 条目的序；`navActiveDomain` 由路由推导当前域。

// 🔴 有意是 `.ts` + `createElement` 而不是 `.tsx`：本模块是**数据**不是组件文件。写成 JSX
// 会被 react-refresh / react-display-name 判成「导出了组件的文件」，逼着把这些纯函数拆到
// 第二个文件去 —— 那正好把「入口的单源」又切成两半。
import { createElement, type ReactElement } from 'react'
// 只引类型：`import type` 编译期擦除，本模块运行时不依赖 router / store。
import type { useNavigate, useRouter } from '@tanstack/react-router'

import type { EmailView } from '@shared/state/email-filter'
import type { DeeplinkTarget } from '@shared/lib/deeplink_target'
import type { SettingsTab } from '@shared/lib/settingsTabs'
import { SHORTCUTS } from '@shared/keymap'
import {
  BotIcon,
  BriefcaseBusinessIcon,
  CalendarCheckIcon,
  ChartColumnIncreasingIcon,
  ChartLineIcon,
  ChartPieIcon,
  GripIcon,
  MAILBOX_ICON_COMPONENT,
  MailCheckIcon,
  SettingsIcon,
  SparklesIcon,
  SunIcon,
  UsersRoundIcon
} from '@shared/components/icons'

// ── 词表 ────────────────────────────────────────────────────────────────────

/** 域 = 方案 B 导轨的一格。 */
export type NavDomain =
  | 'today'
  | 'mail'
  | 'calendar'
  | 'matters'
  | 'contacts'
  | 'agents'
  | 'ops'
  | 'settings'

/** 可导航到的路由 path（TanStack 路由树里真实存在的那些）。 */
export type NavPath =
  | '/'
  | '/today'
  | '/matters'
  | '/sessions'
  | '/agents'
  | '/admin/llm'
  | '/admin/kanban'
  | '/admin/calendar'
  | '/contacts'
  | '/settings'

/** 门控名。求值在 `useNavGates.ts`（那里才碰 hooks）。 */
export type NavGate = 'always' | 'never' | 'matters' | 'contacts' | 'calendar'

/** 徽标的**数据来源**（数值由各通道自己取，registry 只说「这一行挂哪个计数」）。 */
export type NavBadgeKind =
  | 'inboxUnread'
  | 'draftsTotal'
  | 'flaggedTotal'
  | 'allTotal'
  | 'matterAttention'
  | 'agentUnread'

export interface NavBadgeSpec {
  readonly kind: NavBadgeKind
  /** 导轨格（56px rail）要不要显数字角标（Step B 起 rail 常驻，这一位从「收起态才
   *  显」改叙述为「rail 显不显」，值逐条沿用）。所有邮件是几千级大数字，角标失去
   *  信号价值还占位 —— 不显；没有 rail 落位的条目（草稿箱/已标旗）这一位不被读。 */
  readonly rail: boolean
}

/** keymap.ts 里的 binding id（组合键仍以 keymap 为准，registry 只引用它）。 */
export type NavShortcutId = 'settings' | 'generalAgent'

export type NavLabel = { readonly i18nKey: string } | { readonly literal: string }

/** 域的二级栏形态（0825 dogfood 轮 2/3 拍板：所有域共用同一套「rail 右侧第二列 +
 *  同一个折叠状态/开合按钮」的模型，差别只在第二列由谁提供）：
 *  - `'nav'`  = DomainPanel（232px 导航栏：邮件视图行/文件夹树/设置 tab 行…）；
 *  - `'page'` = 页面自带的列表列充当二级栏（事项/通讯录的 list——宽度按内容
 *    （336-380），收起走同一个 useNavCollapsed；「未来长出真导航菜单再把 list
 *    移出去」即把这里改回 'nav'）；
 *  - `'none'` = 无二级栏（日历），rail 开合按钮隐藏。 */
export type NavDomainSecond = 'nav' | 'page' | 'none'

/** 域元数据（方案 B 导轨格的脸）：格标签与格图标是**域**的身份，不是域内某条 entry 的
 *  身份 —— 邮件格画信封（域概念），面板里的收件箱行才画收件托盘（视图概念）。 */
export interface NavDomainMeta {
  readonly label: NavLabel
  /** 同 NavEntry.icon 的 D6 契约：只返回裸组件。 */
  readonly icon: () => ReactElement
  readonly second: NavDomainSecond
}

export interface NavMatch {
  /** pathname 全等即选中。 */
  readonly exact?: readonly string[]
  /** pathname 前缀命中即选中（子路由）。 */
  readonly prefix?: readonly string[]
}

export interface NavEntry {
  readonly id: string
  readonly domain: NavDomain
  /** 目标路由。`undefined` = 预留位（没有路由，gate 恒 `never`）。 */
  readonly to?: NavPath
  /** 邮件视图行专属（`/?view=`）。 */
  readonly view?: EmailView
  readonly label: NavLabel
  /** 🔴 只返回裸 `<XxxIcon />` —— 不传 size / trigger / active：size 由 §2.11 的收起态
   *  CSS 换（15→19），active 由行级 `AnimatedIconActiveProvider` 经 Context 下发，
   *  在这里传会把两者都盖掉。className（如 sessions 的 coral）不在此列，可以传。 */
  readonly icon: () => ReactElement
  readonly gate: NavGate
  /** 选中态判据。缺省 = `pathname === to`。 */
  readonly match?: NavMatch
  readonly badge?: NavBadgeSpec
  /** 域二级栏（DomainPanel）里的落位：序在**本域**内比较（Step B 起面板按域切换，
   *  跨域不同行没有相对序可言）。缺席 = 不在二级栏出现。
   *  `kbd` = 行尾显组合键（只有设置行这么做，⌘O 的会话行有意不显）。 */
  readonly panel?: {
    readonly order: number
    readonly kbd?: boolean
  }
  /** 方案 B 导轨格的落位（Step B 消费）。 */
  readonly rail?: { readonly order: number }
  /** ⌘K jump 段的落位 + 文案。缺席 = 不进 jump（邮件五视图由 palette 自己的
   *  mailbox 行覆盖，再进 jump 就是同一目标两行）。 */
  readonly palette?: {
    readonly order: number
    /** 缺省用 `label`；palette 里文案与侧栏不同的（「看板 Admin」→「打开通讯录」式）走这里。 */
    readonly labelI18nKey?: string
    readonly metaI18nKey: string
  }
  /** 通知深链白名单成员（后端 `payload_json.link.to` 允许出现的目标）。 */
  readonly notificationRoute?: boolean
  /** `mailagent://` deeplink 的 kind。 */
  readonly deeplinkKind?: DeeplinkTarget['kind']
  readonly shortcutId?: NavShortcutId
  /** hover 预载（大 chunk 的入口）。 */
  readonly preloadOnHover?: boolean
}

// ── 条目 ────────────────────────────────────────────────────────────────────

/** 🔴 `as const` 是刻意的：`to` / `deeplinkKind` / `notificationRoute` 要保留字面量类型，
 *  下面几个派生（`NAV_DEEPLINK_PATH` / `NotificationRouteTarget` / `navEntry(id)`）才能给
 *  出 TanStack 认的窄类型，而不是退化成 string。 */
const ENTRIES = [
  // ── 今日（L4 批次 2 例外面）—— 跨 agent / 跨事项的待处理态聚合视图。
  // `NAV_DOMAINS.today.second = 'none'`（同日历）：这一域没有二级栏，页面自己占满。
  {
    id: 'today',
    domain: 'today',
    to: '/today',
    label: { i18nKey: 'nav.today' },
    icon: () => createElement(SunIcon),
    gate: 'always',
    match: { exact: ['/today'] },
    rail: { order: 0 },
    palette: { order: 5, metaI18nKey: 'palette.jump.todayMeta' }
  },

  // ── 邮件域 · MAILBOXES 段 ────────────────────────────────────────────────
  {
    id: 'mail.inbox',
    domain: 'mail',
    to: '/',
    view: 'inbox',
    label: { i18nKey: 'nav.inbox' },
    icon: () => createElement(MAILBOX_ICON_COMPONENT.inbox),
    gate: 'always',
    match: { exact: ['/'] },
    badge: { kind: 'inboxUnread', rail: true },
    panel: { order: 0 },
    rail: { order: 1 },
    deeplinkKind: 'email'
  },
  {
    id: 'mail.outbox',
    domain: 'mail',
    to: '/',
    view: 'outbox',
    label: { i18nKey: 'nav.outbox' },
    icon: () => createElement(MAILBOX_ICON_COMPONENT.outbox),
    gate: 'always',
    match: { exact: ['/'] },
    panel: { order: 1 }
  },
  {
    id: 'mail.drafts',
    domain: 'mail',
    to: '/',
    view: 'drafts',
    label: { i18nKey: 'nav.drafts' },
    icon: () => createElement(MAILBOX_ICON_COMPONENT.drafts),
    gate: 'always',
    match: { exact: ['/'] },
    badge: { kind: 'draftsTotal', rail: false },
    panel: { order: 2 }
  },
  {
    id: 'mail.flagged',
    domain: 'mail',
    to: '/',
    view: 'flagged',
    label: { i18nKey: 'nav.flagged' },
    icon: () => createElement(MAILBOX_ICON_COMPONENT.flagged),
    gate: 'always',
    match: { exact: ['/'] },
    badge: { kind: 'flaggedTotal', rail: false },
    panel: { order: 3 }
  },
  {
    id: 'mail.all',
    domain: 'mail',
    to: '/',
    view: 'all',
    label: { i18nKey: 'nav.allMail' },
    icon: () => createElement(MAILBOX_ICON_COMPONENT.all),
    gate: 'always',
    match: { exact: ['/'] },
    badge: { kind: 'allTotal', rail: false },
    panel: { order: 4 }
  },

  // ── AI AGENTS 段 ────────────────────────────────────────────────────────
  {
    id: 'matters',
    domain: 'matters',
    to: '/matters',
    label: { i18nKey: 'matters.nav' },
    icon: () => createElement(BriefcaseBusinessIcon),
    gate: 'matters',
    match: { exact: ['/matters'] },
    badge: { kind: 'matterAttention', rail: true },
    panel: { order: 0 },
    rail: { order: 3 },
    palette: { order: 30, metaI18nKey: 'palette.jump.mattersMeta' },
    preloadOnHover: true
  },
  {
    id: 'sessions',
    domain: 'agents',
    to: '/sessions',
    label: { i18nKey: 'nav.agentView' },
    // coral 是这一行的身份色（dogfood-2 拍板：不整行填充，只 icon 强调）。
    icon: () => createElement(SparklesIcon, { className: 'text-coral' }),
    gate: 'always',
    match: { exact: ['/sessions'] },
    panel: { order: 0 },
    palette: { order: 10, metaI18nKey: 'palette.jump.generalAgentMeta' },
    shortcutId: 'generalAgent'
  },
  {
    id: 'agents',
    domain: 'agents',
    to: '/agents',
    label: { i18nKey: 'chat.backend.customApi' },
    icon: () => createElement(GripIcon),
    gate: 'always',
    match: { exact: ['/agents'] },
    badge: { kind: 'agentUnread', rail: true },
    panel: { order: 1 },
    rail: { order: 5 },
    palette: { order: 40, metaI18nKey: 'palette.jump.customAiMeta' },
    notificationRoute: true
  },

  // ── VIEW 段 ─────────────────────────────────────────────────────────────
  {
    id: 'llm',
    domain: 'ops',
    to: '/admin/llm',
    // 专有名词，两个 locale 都是这一串 —— 不为它造 i18n 键。
    label: { literal: 'LLM Dashboard' },
    icon: () => createElement(ChartPieIcon),
    gate: 'always',
    match: { exact: ['/llm'], prefix: ['/admin/llm'] },
    panel: { order: 0 },
    palette: { order: 50, metaI18nKey: 'palette.jump.llmMeta' },
    deeplinkKind: 'llm'
  },
  {
    id: 'kanban',
    domain: 'ops',
    to: '/admin/kanban',
    label: { i18nKey: 'nav.adminKanban' },
    icon: () => createElement(ChartLineIcon),
    gate: 'always',
    match: { exact: ['/admin/kanban', '/admin'] },
    panel: { order: 1 },
    rail: { order: 10 },
    palette: {
      order: 20,
      labelI18nKey: 'palette.jump.admin',
      metaI18nKey: 'palette.jump.adminMeta'
    },
    notificationRoute: true,
    deeplinkKind: 'kanban'
  },
  {
    id: 'calendar',
    domain: 'calendar',
    to: '/admin/calendar',
    label: { i18nKey: 'nav.calendar' },
    icon: () => createElement(CalendarCheckIcon),
    // Windows 日历整体出范围（2026-08-13 拍板，平台判定不看 backend）。
    gate: 'calendar',
    match: { exact: ['/calendar'], prefix: ['/admin/calendar'] },
    panel: { order: 0 },
    rail: { order: 2 },
    palette: { order: 25, metaI18nKey: 'palette.jump.calendarMeta' },
    deeplinkKind: 'calendar'
  },
  {
    id: 'contacts',
    domain: 'contacts',
    to: '/contacts',
    label: { i18nKey: 'contacts.nav.title' },
    icon: () => createElement(UsersRoundIcon),
    gate: 'contacts',
    match: { exact: ['/contacts'] },
    panel: { order: 0 },
    rail: { order: 4 },
    palette: {
      order: 60,
      labelI18nKey: 'palette.jump.contacts',
      metaI18nKey: 'palette.jump.contactsMeta'
    },
    preloadOnHover: true
  },

  // ── 底栏 ────────────────────────────────────────────────────────────────
  {
    id: 'settings',
    domain: 'settings',
    to: '/settings',
    label: { i18nKey: 'nav.settings' },
    icon: () => createElement(SettingsIcon),
    gate: 'always',
    match: { exact: ['/settings'] },
    // 无 panel 落位：设置域的面板行是 12 个 tab 直达行（DomainPanel 直渲，同 agents
    // 的轻量 tab 行——词表单源 @shared/lib/settingsTabs），再放一行「设置」是重复。
    rail: { order: 11 },
    palette: { order: 70, metaI18nKey: 'palette.jump.settingsMeta' },
    notificationRoute: true,
    deeplinkKind: 'settings',
    shortcutId: 'settings'
  }
] as const satisfies readonly NavEntry[]

/** 域元数据 —— 导轨格的标签与图标（键域 = NavDomain 全集，少一个域编不过）。
 *  邮件/日历/事项/通讯录/Agents 的格图标是**域**的脸；单入口域（日历/事项/通讯录）
 *  沿用该入口的既有图标身份，不为导轨另造第二个 glyph。 */
export const NAV_DOMAINS: Record<NavDomain, NavDomainMeta> = {
  today: { label: { i18nKey: 'nav.today' }, icon: () => createElement(SunIcon), second: 'none' },
  mail: {
    label: { i18nKey: 'nav.domain.mail' },
    icon: () => createElement(MailCheckIcon),
    second: 'nav'
  },
  calendar: {
    label: { i18nKey: 'nav.calendar' },
    icon: () => createElement(CalendarCheckIcon),
    second: 'none'
  },
  matters: {
    label: { i18nKey: 'matters.nav' },
    icon: () => createElement(BriefcaseBusinessIcon),
    second: 'page'
  },
  contacts: {
    label: { i18nKey: 'contacts.nav.title' },
    icon: () => createElement(UsersRoundIcon),
    second: 'page'
  },
  // 专有名词，两个 locale 都是 "Agents"（同 LLM Dashboard 先例，不造 i18n 键）。
  agents: { label: { literal: 'Agents' }, icon: () => createElement(BotIcon), second: 'nav' },
  ops: {
    label: { i18nKey: 'nav.domain.ops' },
    icon: () => createElement(ChartColumnIncreasingIcon),
    second: 'nav'
  },
  settings: {
    label: { i18nKey: 'nav.settings' },
    icon: () => createElement(SettingsIcon),
    second: 'nav'
  }
}

type NavEntries = typeof ENTRIES
export type NavEntryId = NavEntries[number]['id']

/** 全部入口（含 gate 恒 false 的预留位）。渲染面一律用 `useVisibleNavEntries()`。 */
export const NAV_ENTRIES: readonly NavEntry[] = ENTRIES

/** 按 id 取条目 —— 返回**字面量类型**的那一条（`.to` 是具体 path，不是联合）。 */
export function navEntry<K extends NavEntryId>(id: K): Extract<NavEntries[number], { id: K }> {
  const found = ENTRIES.find((e) => e.id === id)
  // ENTRIES 的 id 与 NavEntryId 同源，find 必命中；类型系统跨不过 find 的窄化。
  return found as Extract<NavEntries[number], { id: K }>
}

// ── 派生 ①：通知深链白名单 ──────────────────────────────────────────────────

/** 允许出现在通知 `link.to` 里的路由目标。**只有真会发通知的那几条**标了
 *  `notificationRoute`，加信源时给那条 entry 加标记，不在消费端补白名单。 */
export type NotificationRouteTarget = Extract<NavEntries[number], { notificationRoute: true }>['to']

export const NOTIFICATION_ROUTE_TARGETS: readonly NotificationRouteTarget[] = NAV_ENTRIES.filter(
  (e) => e.notificationRoute === true
).map((e) => e.to) as readonly NotificationRouteTarget[]

// ── 派生 ②：deeplink kind → path ────────────────────────────────────────────

type DeeplinkEntry<K extends DeeplinkTarget['kind']> = Extract<
  NavEntries[number],
  { deeplinkKind: K }
>

/** `mailagent://<kind>` 的落点。键域 = `DeeplinkTarget['kind']` 全集 —— 少一个 kind 这里
 *  的映射类型就编不过（此前的形态是 renderer switch 里静默 drop 掉那条 deeplink）。 */
export const NAV_DEEPLINK_PATH: {
  readonly [K in DeeplinkTarget['kind']]: DeeplinkEntry<K>['to']
} = Object.fromEntries(
  NAV_ENTRIES.filter((e) => e.deeplinkKind !== undefined).map((e) => [e.deeplinkKind, e.to])
) as { readonly [K in DeeplinkTarget['kind']]: DeeplinkEntry<K>['to'] }

// ── 派生 ③：快捷键组合（组合键权威仍是 keymap.ts） ──────────────────────────

/** entry 绑定的组合键。keymap 里没有那条 id 时返回 ''（`useShortcut('')` 永不命中，
 *  不会误绑别的键）；一致性由 `navRegistry.test` 钉死。 */
export function navShortcutSpec(entry: NavEntry): string {
  if (entry.shortcutId === undefined) return ''
  return SHORTCUTS.find((s) => s.id === entry.shortcutId)?.spec ?? ''
}

/** 组合键的展示形（`⌘,`）—— 侧栏行尾那颗 kbd 读它，不自己拼 glyph。 */
export function navShortcutDisplay(entry: NavEntry): string {
  if (entry.shortcutId === undefined) return ''
  return SHORTCUTS.find((s) => s.id === entry.shortcutId)?.display ?? ''
}

// ── 通用工具 ────────────────────────────────────────────────────────────────

export type NavTranslate = (key: string, options?: Record<string, unknown>) => string

export function navLabel(entry: NavEntry, t: NavTranslate): string {
  return 'i18nKey' in entry.label ? t(entry.label.i18nKey) : entry.label.literal
}

/** palette 行的标题（有 `labelI18nKey` 覆盖就用它，否则同侧栏 label）。 */
export function navPaletteLabel(entry: NavEntry, t: NavTranslate): string {
  const key = entry.palette?.labelI18nKey
  return key !== undefined ? t(key) : navLabel(entry, t)
}

/** 选中态判据（pathname 维度）。邮件五视图还要叠 `?view=` 与自定义文件夹互斥，
 *  那一层留在侧栏 —— 它是列表状态不是路由状态。 */
export function isNavEntryActive(entry: NavEntry, pathname: string): boolean {
  const match = entry.match
  if (match === undefined) return entry.to !== undefined && pathname === entry.to
  if (match.exact?.includes(pathname) === true) return true
  return match.prefix?.some((p) => pathname.startsWith(p)) === true
}

/** 域标签（导轨格 / 域面板头共用）。 */
export function navDomainLabel(domain: NavDomain, t: NavTranslate): string {
  const label = NAV_DOMAINS[domain].label
  return 'i18nKey' in label ? t(label.i18nKey) : label.literal
}

/** 导轨格投影（已按 rail.order 排序）。传入的 entries 应是门控过滤后的。 */
export function navRailEntries(entries: readonly NavEntry[]): readonly NavEntry[] {
  return entries
    .filter((e) => e.rail !== undefined)
    .sort((a, b) => (a.rail?.order ?? 0) - (b.rail?.order ?? 0))
}

/** 某个域的二级栏条目（已按 panel.order 排序）。传入的 entries 应是门控过滤后的。 */
export function navDomainPanelEntries(
  entries: readonly NavEntry[],
  domain: NavDomain
): readonly NavEntry[] {
  return entries
    .filter((e) => e.domain === domain && e.panel !== undefined)
    .sort((a, b) => (a.panel?.order ?? 0) - (b.panel?.order ?? 0))
}

/** 域的二级栏形态（声明在 NAV_DOMAINS.second，语义见 NavDomainSecond）。 */
export function navDomainSecond(domain: NavDomain): NavDomainSecond {
  return NAV_DOMAINS[domain].second
}

/** 当前路由归属的域（导轨选中格 + 面板显示哪个域）。判据 = 门控过滤后**任一**条目
 *  的选中态命中（`/sessions` 因此归 agents 域，虽然它没有导轨格）。无命中（理论上
 *  只有 popout 之类的非路由场景）→ null，调用方自己给缺省。 */
export function navActiveDomain(entries: readonly NavEntry[], pathname: string): NavDomain | null {
  return entries.find((e) => isNavEntryActive(e, pathname))?.domain ?? null
}

/** ⌘K jump 段的条目（已按 order 排序）。 */
export function navPaletteEntries(entries: readonly NavEntry[]): readonly NavEntry[] {
  return entries
    .filter((e) => e.palette !== undefined)
    .sort((a, b) => (a.palette?.order ?? 0) - (b.palette?.order ?? 0))
}

// ── 导航动作适配 ────────────────────────────────────────────────────────────

type NavigateFn = ReturnType<typeof useNavigate>
type RouterLike = Pick<ReturnType<typeof useRouter>, 'preloadRoute'>

/** entry → TanStack navigate。**唯一**把 NavPath 落成具体 `{to, search}` 的地方
 *  （search 形状随 to 变，联合类型传不进 navigate）。default 分支的 `never` 断言
 *  = 加了新 NavPath 忘了接线时 typecheck 当场红。 */
export function navigateToNavEntry(navigate: NavigateFn, entry: NavEntry): void {
  switch (entry.to) {
    case undefined:
      return // 预留位：没有目标，点了什么也不做。
    case '/':
      void navigate({ to: '/', search: { view: entry.view ?? 'inbox' } })
      return
    case '/today':
      void navigate({ to: '/today' })
      return
    case '/matters':
      void navigate({ to: '/matters' })
      return
    case '/sessions':
      void navigate({ to: '/sessions' })
      return
    case '/agents':
      void navigate({ to: '/agents', search: { tab: 'agents' } })
      return
    case '/admin/llm':
      void navigate({ to: '/admin/llm' })
      return
    case '/admin/kanban':
      void navigate({ to: '/admin/kanban' })
      return
    case '/admin/calendar':
      void navigate({ to: '/admin/calendar', search: { view: 'week' } })
      return
    case '/contacts':
      void navigate({ to: '/contacts' })
      return
    case '/settings':
      void navigate({ to: '/settings', search: { tab: 'general' } })
      return
    default: {
      const exhaustive: never = entry.to
      return exhaustive
    }
  }
}

/** Custom AI 区（`/agents`）的 tab 直达。DomainPanel 的「报告 / Chats」轻量子入口
 *  （它们不是一级入口，不占 NavEntry —— 与文件夹树同类）走这里拿落点；path 字面量
 *  按本文件头的纪律只允许出现在 registry。`agents` entry 自身的 tab=agents 落点仍在
 *  `navigateToNavEntry` 的 '/agents' case。 */
export type AgentsSubTab = 'reports' | 'chats'

export function navigateToAgentsTab(navigate: NavigateFn, tab: AgentsSubTab): void {
  void navigate({ to: '/agents', search: { tab } })
}

/** 设置域面板 tab 行的落点（同上：path 字面量不出 registry）。tab 词表单源
 *  `@shared/lib/settingsTabs`（`import type` 编译期擦除，叶子纪律不破）。 */
export function navigateToSettingsTab(navigate: NavigateFn, tab: SettingsTab): void {
  void navigate({ to: '/settings', search: { tab } })
}

/** hover 意图预载（`preloadOnHover` 的两个大 chunk 入口）。幂等 + 失败静默 ——
 *  预载不该产生可见错误。非预载入口调用即 no-op。 */
export function preloadNavEntry(router: RouterLike, entry: NavEntry): void {
  if (entry.preloadOnHover !== true) return
  switch (entry.to) {
    case '/matters':
      void router.preloadRoute({ to: '/matters' }).catch(() => {})
      return
    case '/contacts':
      void router.preloadRoute({ to: '/contacts' }).catch(() => {})
      return
    default:
      return
  }
}
