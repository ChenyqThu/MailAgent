// Sprint 4 H-1 (REVIEW-LOG carry-forward) — single-bus keyboard shortcut hub.
//
// Sprint 3 shipped `useGlobalShortcuts` that installed one document.keydown
// listener PER call site. That worked for the two shortcuts then on the
// table (⌘K + ⌥T), but Sprint 4 adds ⌘L / ⌘↩ / ⌥A / ⌥B / ⌘N for the AI
// chat panel — at that point each listener was re-walking the same event
// only to early-return, and "which one wins ⌘↩ when both composer and
// search box are alive" was an ordering coincidence rather than a contract.
//
// This module is the contract:
//   - one shared document.keydown listener, installed lazily on first
//     `useShortcut(...)` mount, torn down when the last hook unmounts.
//   - LIFO precedence — latest registered handler fires first. A focused
//     composer's ⌘↩ pre-empts a global "send AI message".
//   - explicit consume: handler returns `true` (or calls preventDefault) to
//     stop later (i.e. earlier-registered) handlers from also firing.
//   - editable-target gating defaults to safe: plain-key + alt-only
//     shortcuts skip when the target is <input>/<textarea>/contenteditable;
//     `⌘`-modified shortcuts auto-pass (macOS convention — ⌘K should still
//     open search even when typing in a filter input).
//   - `cmd+k` is strict macOS metaKey; `ctrl+k` is the cross-platform alias
//     that also matches metaKey (so the V2 Web build on Windows users gets
//     the same physical bindings).
//   - macOS dead-key alt glyphs (⌥T → "†", ⌥K → "˚", …) normalize back to
//     the base letter so `alt+t` matches both shapes — Sprint 3 already had
//     this quirk hard-coded; here it's centralized.

import { useEffect } from 'react'

// ── spec parsing ─────────────────────────────────────────────────────────

type ModMode = 'cmd-only' | 'mod' | 'no-mod'

interface ParsedSpec {
  key: string // lowercased + alt-glyph-normalized
  mode: ModMode
  alt: boolean
  shift: boolean
}

function parse(spec: string): ParsedSpec {
  const out: ParsedSpec = { key: '', mode: 'no-mod', alt: false, shift: false }
  for (const raw of spec.toLowerCase().split('+')) {
    const tok = raw.trim()
    if (tok === '') continue
    if (tok === 'cmd' || tok === 'meta' || tok === '⌘') out.mode = 'cmd-only'
    else if (tok === 'ctrl' || tok === 'mod') {
      // ctrl is a cross-platform mod alias; do NOT downgrade an existing
      // explicit cmd-only declaration.
      if (out.mode === 'no-mod') out.mode = 'mod'
    } else if (tok === 'alt' || tok === 'opt' || tok === 'option' || tok === '⌥') out.alt = true
    else if (tok === 'shift' || tok === '⇧') out.shift = true
    else out.key = tok
  }
  return out
}

// macOS keyboard layouts emit a dead-key glyph for ⌥+letter. We map the
// 26-letter subset that any future shortcut in DESIGN §9.5 / §6 / §7 might
// actually use back to the base letter. Anything not here falls through to
// the raw `evt.key` (which still works for letter-less keys like Enter).
const MAC_ALT_GLYPH_TO_LETTER: Readonly<Record<string, string>> = {
  å: 'a',
  '∫': 'b',
  ç: 'c',
  '∂': 'd',
  '´': 'e',
  ƒ: 'f',
  '©': 'g',
  '˙': 'h',
  ˆ: 'i',
  '∆': 'j',
  '˚': 'k',
  '¬': 'l',
  µ: 'm',
  '˜': 'n',
  ø: 'o',
  π: 'p',
  œ: 'q',
  '®': 'r',
  ß: 's',
  '†': 't',
  '¨': 'u',
  '√': 'v',
  '∑': 'w',
  '≈': 'x',
  '¥': 'y',
  Ω: 'z'
}

function normalizeKey(evtKey: string, isAlt: boolean): string {
  if (isAlt && MAC_ALT_GLYPH_TO_LETTER[evtKey]) return MAC_ALT_GLYPH_TO_LETTER[evtKey]
  return evtKey.toLowerCase()
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

function matches(evt: KeyboardEvent, spec: ParsedSpec): boolean {
  if (normalizeKey(evt.key, evt.altKey) !== spec.key) return false

  switch (spec.mode) {
    case 'cmd-only':
      // Strict macOS ⌘: evt.metaKey ONLY. cmd+ctrl combos are rejected so
      // that "⌘K" doesn't accidentally fire on "^K" (Emacs erase-line).
      if (!evt.metaKey || evt.ctrlKey) return false
      break
    case 'mod':
      // Cross-platform alias — either modifier counts.
      if (!evt.metaKey && !evt.ctrlKey) return false
      break
    case 'no-mod':
      // Plain key — both modifiers must be absent (alt is checked below).
      if (evt.metaKey || evt.ctrlKey) return false
      break
  }
  if (Boolean(spec.alt) !== evt.altKey) return false
  if (Boolean(spec.shift) !== evt.shiftKey) return false
  return true
}

// ── module-level bus ─────────────────────────────────────────────────────

export type ShortcutHandler = (evt: KeyboardEvent) => boolean | void

interface Registration {
  parsed: ParsedSpec
  handler: ShortcutHandler
  allowInEditable: boolean
}

const subs: Registration[] = []
let installed = false

function onKeyDown(evt: KeyboardEvent): void {
  // Walk LIFO so the most-recently-mounted handler wins. A focused composer
  // mounted after the global search hook will see ⌘↩ first.
  for (let i = subs.length - 1; i >= 0; i--) {
    const sub = subs[i]
    if (!matches(evt, sub.parsed)) continue

    // Editable-target gating. ⌘-modified shortcuts auto-pass (macOS UX) —
    // typing in a filter input shouldn't break ⌘K. Plain and alt-only
    // shortcuts skip editable targets unless the caller opts in via
    // `allowInEditable: true` (the composer pattern).
    if (!sub.allowInEditable && sub.parsed.mode === 'no-mod' && isEditableTarget(evt.target))
      continue

    const consumed = sub.handler(evt)
    if (consumed === true || evt.defaultPrevented) return
  }
}

function ensureInstalled(): void {
  if (installed) return
  document.addEventListener('keydown', onKeyDown)
  installed = true
}

function uninstallIfEmpty(): void {
  if (subs.length === 0 && installed) {
    document.removeEventListener('keydown', onKeyDown)
    installed = false
  }
}

// ── public hook ──────────────────────────────────────────────────────────

export interface ShortcutOptions {
  /** Default `true`. Toggle off to temporarily suspend a binding. */
  enabled?: boolean
  /** Default `false`. Plain / alt-only shortcuts skip editable targets; set
   * `true` for composer ⌘↩ kind of in-input bindings. */
  allowInEditable?: boolean
}

/**
 * Register a global keyboard shortcut.
 *
 * @example
 *   useShortcut('cmd+k', () => navigate({ to: '/search' }))
 *   useShortcut('alt+t', toggleTranslation)
 *   useShortcut('cmd+enter', sendMessage, { allowInEditable: true })
 *
 * Modifier tokens accepted in `spec`:
 *   `cmd` / `meta` / `⌘`  → strict metaKey
 *   `ctrl` / `mod`         → cross-platform (metaKey OR ctrlKey)
 *   `alt` / `opt` / `option` / `⌥`
 *   `shift` / `⇧`
 *
 * The key part is case-insensitive ('Enter' / 'enter', 'T' / 't').
 */
export function useShortcut(
  spec: string,
  handler: ShortcutHandler,
  opts: ShortcutOptions = {}
): void {
  const { enabled = true, allowInEditable = false } = opts
  useEffect(() => {
    if (!enabled) return
    ensureInstalled()
    const reg: Registration = {
      parsed: parse(spec),
      handler,
      allowInEditable
    }
    subs.push(reg)
    return () => {
      const idx = subs.indexOf(reg)
      if (idx >= 0) subs.splice(idx, 1)
      uninstallIfEmpty()
    }
  }, [spec, handler, allowInEditable, enabled])
}

// ── test-only escape hatch ───────────────────────────────────────────────

/**
 * Wipe the singleton bus + uninstall the document listener. Test setup
 * code should call this in `beforeEach` to avoid spec carry-over between
 * tests. Do NOT call from production code.
 */
export function __resetShortcutBus(): void {
  subs.length = 0
  if (installed) {
    document.removeEventListener('keydown', onKeyDown)
    installed = false
  }
}
