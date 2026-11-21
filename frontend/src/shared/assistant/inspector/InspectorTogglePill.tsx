import { PanelRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { useSessionInspector } from './inspectorContext'

export interface InspectorTogglePillProps {
  /** Compact variant hides the localized text label for narrow headers (modal / 360px dock). */
  readonly compact?: boolean
  readonly className?: string
}

/**
 * Header trigger pill showing live item count across artifacts/sources/links/skills/connectors.
 * Stays hidden on blank sessions (`totalItems === 0 && !open`) to keep empty headers calm.
 */
export function InspectorTogglePill({
  compact = false,
  className
}: InspectorTogglePillProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const inspector = useSessionInspector()
  if (!inspector) return null

  const count = inspector.snapshot.totalItems
  if (count === 0 && !inspector.open) return null

  const label = t('chat.inspector.toggle')
  return (
    <button
      type="button"
      data-testid="inspector-toggle-pill"
      aria-label={`${label} (${count})`}
      aria-expanded={inspector.open}
      title={`${label} (⌘.)`}
      onClick={inspector.toggle}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 transition-colors duration-fast',
        inspector.open
          ? 'border-coral/40 bg-coral/10 text-ink-fg'
          : 'border-ink-border-soft bg-ink-2 text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg',
        className
      )}
    >
      <PanelRight size={13} strokeWidth={1.8} className="shrink-0 text-coral" aria-hidden />
      {!compact && <span className="text-aux">{label}</span>}
      {count > 0 && (
        <span className="rounded bg-ink-3 px-1 font-mono text-meta tabular-nums text-ink-fg-2">
          {count}
        </span>
      )}
    </button>
  )
}
