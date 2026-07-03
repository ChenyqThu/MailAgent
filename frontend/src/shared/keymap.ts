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
    // P3 — ⌘O opens the General Agent dialog: a context-free Custom AI
    // conversation not tied to any email (GlobalShortcuts useShortcut('cmd+o',
    // toggleGeneral)). Toggle semantics mirror ⌘K.
    id: 'generalAgent',
    spec: 'cmd+o',
    display: '⌘O',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.generalAgent',
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
    // 是 ⌘J (GlobalShortcuts useShortcut('cmd+j', openModal) → chat modal)。
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
  // ── Sprint 11 V1.4 — nav-shell + locale toggles ────────────────────
  {
    id: 'toggleNav',
    spec: 'alt+b',
    display: '⌥B',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.toggleNav',
    wired: true
  },
  {
    id: 'toggleLocale',
    spec: 'alt+g',
    display: '⌥G',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.toggleLocale',
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
    chat: []
  }
  for (const s of SHORTCUTS) out[s.scope].push(s)
  return out
}

/** Section ordering used by the help modal. */
export const SCOPE_ORDER: ReadonlyArray<ShortcutScope> = ['global', 'inbox', 'row', 'chat']
