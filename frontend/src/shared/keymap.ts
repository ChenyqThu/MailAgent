// Sprint 7 D2 — single SSoT for every keyboard shortcut surfaced in the UI.
//
// Per DESIGN.md §9.5 "The list lives in `src/keymap.ts` as the production
// SSoT. The shortcut-help modal (`?`) reads from it." Until Sprint 7 the
// shortcuts were registered per-component via `useShortcut(...)` but never
// catalogued anywhere — the help modal had nothing to render. This module
// owns the catalog.
//
// Registration stays the responsibility of the component that owns the
// behaviour (composer ⌘↩ needs the composer's send handler; ⌥B needs the
// AI panel's backend setter). What this module owns:
//   - the spec string ("alt+t", "cmd+enter", "?") — keep these in lockstep
//     with the call site, lint may grow to verify them
//   - i18n labels for the help modal
//   - the scope (when does this fire?) for grouping in the help modal
//   - whether the binding is "default" (shipping in V1) or "candidate"
//     (defined in design but not yet wired — kept in the catalog so the
//     help modal can show "coming soon" for unwired bindings)

export type ShortcutScope =
  /** Always active (navigation, command palette, help). */
  | 'global'
  /** Active when the inbox is mounted (J/K row navigation, R reply, etc). */
  | 'inbox'
  /** Active when AIChatPanel has focus (⌘↩ send, ⌘N new conv). */
  | 'chat'
  /** Active when the row has focus (X toggle select). */
  | 'row'
  /** Active when the calendar page is mounted (CalendarLayout's
   *  useCalendarShortcuts window listener; CalendarShortcutModal derives
   *  its rows from this scope). */
  | 'calendar'
  /** Active when the contacts page is mounted (useContactKeyboardNav's
   *  document listener — j/k + ↑/↓ list navigation). */
  | 'contacts'

export interface ShortcutDef {
  /** Stable id used by tests + telemetry. */
  id: string
  /** Spec string accepted by `useShortcut(spec, …)`. Macro keys ("?" / "/"
   *  / "[" / "]") must use the literal character. */
  spec: string
  /** Pretty form rendered in the help modal — the modifier glyphs
   *  (`⌘ ⌥ ⇧ ⌃ ↩ ⌫`) live here so the modal doesn't have to re-derive
   *  them from `spec`. */
  display: string
  scope: ShortcutScope
  /** i18n key for the row's human-readable label. Lives under
   *  `shortcutHelp.binding.<id>` in both locales. */
  labelKey: string
  /** Whether the binding has a real handler wired in V1. `false` keeps the
   *  binding visible in the help modal with a "soon" pill so users know
   *  what's coming. */
  wired: boolean
}

// ── 标签工作区的 spec 常量（task 08-27-l4-tab-workspace P2）─────────────────
//
// 这几条不是「一个 spec 一行 catalog」：⌘1-9 是九个 spec 合成一行，⌃⇥ / ⌃⇧⇥ 是一对。
// 常量导出后 GlobalShortcuts 直接消费同一份，catalog 的 `spec` 也由它们拼出来 ——
// 「spec 与调用点 lockstep」就不再靠人眼盯两处（改这里，两侧一起动）。
// 多 spec 合成一行时用**空格分隔**，与 calendar 的 `'g d'` / `'left right'` 同写法。

export const TAB_NEW_SPEC = 'cmd+t'
export const TAB_CLOSE_SPEC = 'cmd+w'
export const TAB_REOPEN_SPEC = 'shift+cmd+t'
export const TAB_CYCLE_NEXT_SPEC = 'ctrl+tab'
export const TAB_CYCLE_PREV_SPEC = 'ctrl+shift+tab'

// ── 导航壳（task 09-01-sidebar-fluid-optimization）─────────────────────────
// `[` 折叠 / 展开当前域的二级栏；`]` 展开并把焦点移到二级栏首个可聚焦项（三条恢复入口
// 之一）。抽屉态（远程 web <768）两键都作用于抽屉开合。plain key ⇒ useShortcut 的
// editable-target gating 自动生效：输入框 / contenteditable 里打 `[` 不触发。
export const NAV_TOGGLE_SPEC = '['
export const NAV_EXPAND_FOCUS_SPEC = ']'

/** ⌘1-9 位置直达：**⌘1 = 主标签**，⌘2-9 = 对象标签按标签条顺序的第 1-8 个。
 *  数组序 = 位置序，GlobalShortcuts 按下标注册。 */
export const TAB_JUMP_SPECS: ReadonlyArray<string> = [
  'cmd+1',
  'cmd+2',
  'cmd+3',
  'cmd+4',
  'cmd+5',
  'cmd+6',
  'cmd+7',
  'cmd+8',
  'cmd+9'
]

/** Ordered by DESIGN.md §9.5 — keep in sync. Scope ordering used by the
 *  help modal to group rows under section headers. */
export const SHORTCUTS: ReadonlyArray<ShortcutDef> = [
  // ── Global ────────────────────────────────────────────────────────────
  {
    id: 'commandPalette',
    spec: 'cmd+k',
    display: '⌘K',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.commandPalette',
    wired: true
  },
  {
    id: 'settings',
    spec: 'cmd+,',
    display: '⌘,',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.settings',
    wired: true
  },
  {
    id: 'shortcutHelp',
    spec: '?',
    display: '?',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.shortcutHelp',
    wired: true
  },
  {
    // ⌘N 写新邮件 — global scope (任意页面可开居中模态, 与全局侧边栏「写邮件」
    // 按钮一致)。editable 上下文 (chat / 主题输入框) 由 useShortcut 默认 short-circuit,
    // 打字不误触。(原 chat scope 的 newChat 也曾占 ⌘N 但从未接线, 已移除避免重复。)
    id: 'composeNew',
    spec: 'cmd+n',
    display: '⌘N',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.composeNew',
    wired: true
  },
  {
    // ⌘O — 切到对话页（/sessions）**并新建一个会话**（08-27 标签工作区批：原语义
    // 只是导航过去，接着上一次的会话）。目标 entry 在 registry（`shortcutId` 引用
    // 本条），新建会话由 GlobalShortcuts 经 ai-chat-panel 的一次性请求投给
    // AgentViewLayout。🔴 它**不开对象标签** —— 对话是主标签的八种承载之一。
    id: 'generalAgent',
    spec: 'cmd+o',
    display: '⌘O',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.generalAgent',
    wired: true
  },
  // ── 标签工作区（08-27 P2）— 注册在 GlobalShortcuts，spec 取上面的常量 ──────
  {
    // ⌘T — 打开「新标签页」（kind='search' 搜索单例，/search 路由）。已开着则只激活
    // （store 去重语义）。标签条行尾的「+」钮是同一个动作的鼠标入口。
    id: 'tabNew',
    spec: TAB_NEW_SPEC,
    display: '⌘T',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.tabNew',
    wired: true
  },
  {
    // 🔴 主标签激活时 ⌘W **消费掉但不做事**：macOS windowMenu 的 close role 也绑
    // ⌘W，不消费就变成「按一下关掉整个窗口」。同一条 preventDefault 覆盖菜单
    // 加速键的先例见 useCalendarShortcuts 的 ⌘R（viewMenu reload role）。
    id: 'tabClose',
    spec: TAB_CLOSE_SPEC,
    display: '⌘W',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.tabClose',
    wired: true
  },
  {
    id: 'tabReopen',
    spec: TAB_REOPEN_SPEC,
    display: '⇧⌘T',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.tabReopen',
    wired: true
  },
  {
    // 一行两个 spec：⌃⇥ 往后 / ⌃⇧⇥ 往前。循环序 = 主标签 → 对象标签数组序 → 回主标签。
    id: 'tabCycle',
    spec: `${TAB_CYCLE_NEXT_SPEC} ${TAB_CYCLE_PREV_SPEC}`,
    display: '⌃⇥ / ⌃⇧⇥',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.tabCycle',
    wired: true
  },
  {
    id: 'tabJump',
    spec: TAB_JUMP_SPECS.join(' '),
    display: '⌘1-9',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.tabJump',
    wired: true
  },
  // ── Inbox ─────────────────────────────────────────────────────────────
  // `wired` flags track "has a real handler producing the documented behavior
  // today", NOT design intent. Wired: J / K row nav (useEmailKeyboardNav) +
  // S / U / E flag/read/archive on the active email (useInboxActionShortcuts,
  // mirrors EmailRow's click handlers). Still unwired (keep "soon" pill): R / F
  // reply/forward (need the compose panel), ⌘⌫ delete (one-key delete is a
  // mis-delete risk), X batch-select — spec'd in DESIGN §9.5, no handler yet.
  {
    id: 'nextEmail',
    spec: 'j',
    display: 'J',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.nextEmail',
    wired: true
  },
  {
    id: 'prevEmail',
    spec: 'k',
    display: 'K',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.prevEmail',
    wired: true
  },
  {
    id: 'reply',
    spec: 'r',
    display: 'R',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.reply',
    wired: false
  },
  {
    id: 'forward',
    spec: 'f',
    display: 'F',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.forward',
    wired: false
  },
  {
    id: 'toggleRead',
    spec: 'u',
    display: 'U',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.toggleRead',
    wired: true
  },
  {
    id: 'toggleFlag',
    spec: 's',
    display: 'S',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.toggleFlag',
    wired: true
  },
  {
    id: 'archive',
    spec: 'e',
    display: 'E',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.archive',
    wired: true
  },
  {
    id: 'delete',
    spec: 'cmd+backspace',
    display: '⌘⌫',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.delete',
    wired: false
  },
  {
    id: 'translate',
    spec: 'alt+t',
    display: '⌥T',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.translate',
    wired: true
  },
  // 2026-08 筛选菜单重做 — 三条最常用筛选轴的直达键 (EmailListHeader 注册)。
  // 菜单关着也生效; 都是 ⌘-modified 故在输入框里也不被 short-circuit 掉,
  // 与 ⌘K 同一档 macOS 惯例。裸 ⌘O 已被 generalAgent（对话页 + 新建会话）占用,
  // 这三条都带第二个修饰键, 不同 chord 不冲突。
  {
    id: 'filterUnread',
    spec: 'shift+cmd+o',
    display: '⇧⌘O',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.filterUnread',
    wired: true
  },
  {
    id: 'filterFlagged',
    spec: 'alt+cmd+o',
    display: '⌥⌘O',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.filterFlagged',
    wired: true
  },
  {
    id: 'filterHasAttach',
    spec: 'shift+cmd+a',
    display: '⇧⌘A',
    scope: 'inbox',
    labelKey: 'shortcutHelp.binding.filterHasAttach',
    wired: true
  },
  // ── Row ───────────────────────────────────────────────────────────────
  {
    id: 'toggleBatchSelect',
    spec: 'x',
    display: 'X',
    scope: 'row',
    labelKey: 'shortcutHelp.binding.toggleBatchSelect',
    wired: false
  },
  // ── Chat ──────────────────────────────────────────────────────────────
  {
    // S3 W2 — legacy 侧边面板的 ⌘L toggle 随 legacy runtime 退役；真实绑定
    // 是 ⌘J (GlobalShortcuts useShortcut('cmd+j', toggleModal) → chat dock)。
    // 0821 owner dogfood：⌘J 由「只开」改为**开关**，文案随之改成「开关侧边 AI 对话」。
    // id 保持 openAiPanel（外部引用 / 测试的稳定标识），改的是行为与 label。
    id: 'openAiPanel',
    spec: 'cmd+j',
    display: '⌘J',
    scope: 'chat',
    labelKey: 'shortcutHelp.binding.openAiPanel',
    wired: true
  },
  {
    id: 'sendChat',
    spec: 'cmd+enter',
    display: '⌘↩',
    scope: 'chat',
    labelKey: 'shortcutHelp.binding.sendChat',
    wired: true
  },
  // ── Island (L2 Island Hybrid future) ─────────────────────────────────
  {
    id: 'toggleIsland',
    spec: 'alt+i',
    display: '⌥I',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.toggleIsland',
    wired: false
  },
  // ── Sprint 11 V1.4 — locale toggle ─────────────────────────────────
  // （同批的 `toggleNav`(⌥B) 已在 08-27 二级栏定宽时退役；09-01 侧栏批折叠回来后
  //   换了绑定，见上面的 navToggle `[` / navExpandFocus `]`，⌥B 不再复活。）
  {
    id: 'toggleLocale',
    spec: 'alt+g',
    display: '⌥G',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.toggleLocale',
    wired: true
  },
  // ── 导航壳（09-01 侧栏批）——注册在 GlobalShortcuts ─────────────────────
  {
    id: 'navToggle',
    spec: NAV_TOGGLE_SPEC,
    display: '[',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.navToggle',
    wired: true
  },
  {
    id: 'navExpandFocus',
    spec: NAV_EXPAND_FOCUS_SPEC,
    display: ']',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.navExpandFocus',
    wired: true
  },
  // ── Calendar (阶段2·2.7, ux-benchmark §五-5 统一登记) ─────────────────
  // Registration lives in `useCalendarShortcuts` (its own window listener
  // with G-prefix two-key sequences + editable-target guard), NOT
  // `useShortcut`; sequence specs use space-separated notation ("g d").
  // Display 空格分段被 CalendarShortcutModal 渲染成多枚 kbd ("G D" → G·D).
  {
    id: 'calViewDay',
    spec: 'g d',
    display: 'G D',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calViewDay',
    wired: true
  },
  {
    id: 'calViewWeek',
    spec: 'g w',
    display: 'G W',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calViewWeek',
    wired: true
  },
  {
    id: 'calViewMonth',
    spec: 'g m',
    display: 'G M',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calViewMonth',
    wired: true
  },
  {
    id: 'calViewAgenda',
    spec: 'g a',
    display: 'G A',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calViewAgenda',
    wired: true
  },
  {
    id: 'calViewRecurring',
    spec: 'g r',
    display: 'G R',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calViewRecurring',
    wired: true
  },
  {
    id: 'calPrevNext',
    spec: 'left right',
    display: '← →',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calPrevNext',
    wired: true
  },
  {
    id: 'calToday',
    spec: 't',
    display: 'T',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calToday',
    wired: true
  },
  {
    id: 'calSync',
    spec: 'cmd+r',
    display: '⌘R',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calSync',
    wired: true
  },
  {
    id: 'calNewEvent',
    spec: 'n',
    display: 'N',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calNewEvent',
    wired: true
  },
  {
    id: 'calNextEvent',
    spec: 'j',
    display: 'J',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calNextEvent',
    wired: true
  },
  {
    id: 'calPrevEvent',
    spec: 'k',
    display: 'K',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calPrevEvent',
    wired: true
  },
  {
    id: 'calOpenSelected',
    spec: 'enter',
    display: '↩',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calOpenSelected',
    wired: true
  },
  {
    id: 'calClose',
    spec: 'esc',
    display: 'Esc',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calClose',
    wired: true
  },
  {
    id: 'calHelp',
    spec: '?',
    display: '?',
    scope: 'calendar',
    labelKey: 'shortcutHelp.binding.calHelp',
    wired: true
  },

  // ── Contacts（通讯录 WP2）— registration lives in useContactKeyboardNav ──
  {
    id: 'contactsNavDown',
    spec: 'j',
    display: 'J / ↓',
    scope: 'contacts',
    labelKey: 'shortcutHelp.binding.contactsNavDown',
    wired: true
  },
  {
    id: 'contactsNavUp',
    spec: 'k',
    display: 'K / ↑',
    scope: 'contacts',
    labelKey: 'shortcutHelp.binding.contactsNavUp',
    wired: true
  }
] as const

/** Lookup by id — handy for tests / future "rebind" UI. */
export function getShortcutById(id: string): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id)
}

/** Group helper for the help modal — preserves catalog ordering inside
 *  each scope. */
export function groupByScope(): Record<ShortcutScope, ShortcutDef[]> {
  const out: Record<ShortcutScope, ShortcutDef[]> = {
    global: [],
    inbox: [],
    row: [],
    chat: [],
    calendar: [],
    contacts: []
  }
  for (const s of SHORTCUTS) out[s.scope].push(s)
  return out
}

/** Section ordering used by the help modal. */
export const SCOPE_ORDER: ReadonlyArray<ShortcutScope> = [
  'global',
  'inbox',
  'row',
  'chat',
  'calendar',
  'contacts'
]
