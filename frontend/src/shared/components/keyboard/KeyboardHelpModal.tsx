// Sprint 7 D2 — `?` keyboard shortcut help modal.
//
// Reads SHORTCUTS from `@shared/keymap` (single SSoT per DESIGN.md §9.5).
// Rendered via React Portal to document.body so it stays above the
// titlebar / AI panel / batch action bar.
//
// A11y: aria-modal=true, labelled by the heading. Esc closes; clicking
// the backdrop closes. Tab cycles within the modal via the same
// querySelectorAll focus-trap pattern as ResyncConfirmDialog.

import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Keyboard, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { SCOPE_ORDER, type ShortcutDef, type ShortcutScope, groupByScope } from '@shared/keymap'
import { closeKeyboardHelp, useKeyboardHelp } from '@shared/state/keyboard-help'

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

function ShortcutRow({ def }: { def: ShortcutDef }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <li className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-ink-3">
      <span className="text-aux text-ink-fg-1 flex items-center gap-2">
        {t(def.labelKey)}
        {!def.wired && (
          <span
            className={cn(
              'text-micro font-mono uppercase px-1.5 py-0.5 rounded',
              'text-warn bg-warn/10 border border-warn/30'
            )}
            title={t('shortcutHelp.soonHint')}
          >
            {t('shortcutHelp.soon')}
          </span>
        )}
      </span>
      <kbd
        className={cn(
          'text-meta font-mono tabular-nums px-2 py-0.5 rounded',
          'bg-ink-3 border border-ink-border text-ink-fg'
        )}
      >
        {def.display}
      </kbd>
    </li>
  )
}

function ScopeSection({
  scope,
  bindings
}: {
  scope: ShortcutScope
  bindings: ShortcutDef[]
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (bindings.length === 0) return null
  return (
    <section className="space-y-1">
      <h3
        className="text-micro font-mono uppercase text-ink-fg-2 px-2 pt-2"
        style={{ letterSpacing: '0.08em' }}
      >
        {t(`shortcutHelp.scope.${scope}`)}
      </h3>
      <ul className="space-y-px">
        {bindings.map((b) => (
          <ShortcutRow key={b.id} def={b} />
        ))}
      </ul>
    </section>
  )
}

export function KeyboardHelpModal(): React.ReactElement | null {
  const { t } = useTranslation()
  const open = useKeyboardHelp((s) => s.open)
  const dialogRef = useRef<HTMLDivElement>(null)
  // Sprint 8 §2.2 (Sprint 7 ship-review MEDIUM #2) — focus fallback target
  // so the React onKeyDown handler on the outer dialog stays alive even
  // when the modal has zero focusable descendants. `tabIndex={-1}` makes
  // the backdrop programmatically focusable without listing it in Tab order.
  const backdropRef = useRef<HTMLDivElement>(null)

  // Focus first focusable on open; fall back to the backdrop so onKeyDown
  // (which only fires from focused descendants) still routes Esc.
  useEffect(() => {
    if (!open) return
    const root = dialogRef.current
    const first = root?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
    if (first) {
      first.focus()
    } else {
      backdropRef.current?.focus()
    }
  }, [open])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeKeyboardHelp()
      return
    }
    if (e.key !== 'Tab') return
    const root = dialogRef.current
    if (!root) return
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => !(el as HTMLButtonElement).disabled && el.tabIndex !== -1
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (active === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }, [])

  if (!open) return null

  const grouped = groupByScope()

  return createPortal(
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbd-help-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 focus:outline-none"
      onClick={closeKeyboardHelp}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'w-[520px] max-h-[80vh] rounded-lg bg-ink-2 border border-ink-border',
          'shadow-[0_8px_24px_rgba(0,0,0,0.35)] flex flex-col'
        )}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-ink-border-soft">
          <h2
            id="kbd-help-title"
            className="text-lead text-ink-fg font-semibold flex items-center gap-2"
          >
            <Keyboard size={16} strokeWidth={1.75} className="text-coral" />
            {t('shortcutHelp.title')}
          </h2>
          <button
            type="button"
            onClick={closeKeyboardHelp}
            aria-label={t('shortcutHelp.close')}
            className={cn(
              'p-1.5 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3',
              'transition-colors duration-fast',
              'focus:outline-none focus:ring-2 focus:ring-coral/60'
            )}
          >
            <X size={14} strokeWidth={2} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-3 py-2 space-y-3">
          {SCOPE_ORDER.map((scope) => (
            <ScopeSection key={scope} scope={scope} bindings={grouped[scope]} />
          ))}
        </div>
        <footer className="px-4 py-2 border-t border-ink-border-soft text-meta text-ink-fg-3">
          {t('shortcutHelp.footer')}
        </footer>
      </div>
    </div>,
    document.body
  )
}
