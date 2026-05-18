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
  // ── Inbox ─────────────────────────────────────────────────────────────
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
    wired: true
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
    wired: false
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
    wired: true
  },
  // ── Chat ──────────────────────────────────────────────────────────────
  {
    id: 'openAiPanel',
    spec: 'alt+a',
    display: '⌥A',
    scope: 'chat',
    labelKey: 'shortcutHelp.binding.openAiPanel',
    wired: false
  },
  {
    id: 'switchBackend',
    spec: 'alt+b',
    display: '⌥B',
    scope: 'chat',
    labelKey: 'shortcutHelp.binding.switchBackend',
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
  {
    id: 'newChat',
    spec: 'cmd+n',
    display: '⌘N',
    scope: 'chat',
    labelKey: 'shortcutHelp.binding.newChat',
    wired: false
  },
  // ── Island (L2 Island Hybrid future) ─────────────────────────────────
  {
    id: 'toggleIsland',
    spec: 'alt+i',
    display: '⌥I',
    scope: 'global',
    labelKey: 'shortcutHelp.binding.toggleIsland',
    wired: false
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
