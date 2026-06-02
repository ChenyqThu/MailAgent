// Sprint 7 D2 — `?` keyboard shortcut help modal.
//
// Reads SHORTCUTS from `@shared/keymap` (single SSoT per DESIGN.md §9.5).
// Rendered via React Portal to document.body so it stays above the
// titlebar / AI panel / batch action bar.
//
// A11y: aria-modal=true, labelled by the heading. Esc closes; clicking
// the backdrop closes. Tab cycles within the modal via the same
// querySelectorAll focus-trap pattern as ResyncConfirmDialog.

import { useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Keyboard, X } from 'lucide-react'

import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { cn } from '@shared/lib/cn'
import { SCOPE_ORDER, type ShortcutDef, type ShortcutScope, groupByScope } from '@shared/keymap'
import { closeKeyboardHelp, useKeyboardHelp } from '@shared/state/keyboard-help'

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
        // Sprint 9 D4.2 (Sprint 7 review LOW #5) — tabIndex={0} so VoiceOver
        // can rotor-browse the scope headings + Tab focus lands on them.
        // Without this, NVDA/VoiceOver users can hear the heading via
        // navigation but can't anchor focus on it.
        tabIndex={0}
        className="text-micro font-mono uppercase text-ink-fg-2 px-2 pt-2 focus:outline-none focus:ring-1 focus:ring-coral/70 rounded"
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
  // GSAP scope = 外层 backdrop。它同时充当 focus fallback target（Sprint 8
  // §2.2）：当 modal 无 focusable 后代时，焦点落在这里以保活 onKeyDown。
  // useExitAnimation 推迟卸载到退场动画播完（backdrop 淡入 + 卡片位移缩放）。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '[data-anim-card]'
  })
  // Sprint 9 D4.1 — focus-trap hook centralises the querySelectorAll
  // boundary handling. dialogRef goes on the inner panel.
  const { dialogRef, handleTab } = useFocusTrap({ open, fallbackRef: scopeRef })

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeKeyboardHelp()
        return
      }
      handleTab(e)
    },
    [handleTab]
  )

  if (!shouldRender) return null

  const grouped = groupByScope()

  return createPortal(
    <div
      ref={scopeRef}
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
        data-anim-card
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
