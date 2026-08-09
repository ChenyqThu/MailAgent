import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarClock } from 'lucide-react'

import type { Matter } from '@shared/api/types/matter'

interface MatterFocusProps {
  matters: readonly Matter[]
  onSelect(matter: Matter): void
}

export function MatterFocus({ matters, onSelect }: MatterFocusProps): React.ReactElement {
  const { t } = useTranslation()
  const [now] = useState(() => Date.now())
  const soon = now + 7 * 24 * 60 * 60 * 1000
  const dueSoon = matters
    .filter((matter) => matter.due_at !== null && matter.due_at >= now && matter.due_at <= soon)
    .sort((left, right) => (left.due_at ?? soon) - (right.due_at ?? soon))

  return (
    <section className="h-full overflow-y-auto p-5 scrollbar-thin">
      <header className="mb-5">
        <h1 className="text-heading font-semibold text-ink-fg">{t('matters.focus.title')}</h1>
        <p className="mt-1 text-body text-ink-fg-2">{t('matters.focus.count', { count: matters.length })}</p>
      </header>
      {dueSoon.length > 0 ? (
        <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-1/80">
          <div className="flex items-center gap-2 border-b border-ink-border px-4 py-3 text-body font-medium">
            <CalendarClock size={16} className="text-warn" />
            {t('matters.focus.dueSoon')}
          </div>
          <div className="divide-y divide-ink-border">
            {dueSoon.map((matter) => (
              <button
                key={matter.public_id}
                type="button"
                onClick={() => onSelect(matter)}
                className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-ink-3"
              >
                <span className="min-w-0">
                  <span className="block truncate text-body text-ink-fg">{matter.title}</span>
                  <span className="text-meta font-mono text-ink-fg-2">{matter.public_id}</span>
                </span>
                <time className="shrink-0 text-meta text-warn">
                  {matter.due_at ? new Date(matter.due_at).toLocaleDateString() : ''}
                </time>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-[var(--r-card)] border border-dashed border-ink-border p-8 text-center text-body text-ink-fg-2">
          {t('matters.focus.empty')}
        </div>
      )}
    </section>
  )
}
