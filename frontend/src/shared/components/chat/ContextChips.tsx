// Sprint 4 §6 — context chips header. Shows what's loaded into the current
// turn's prompt so the user has a one-glance answer to "what did the AI
// see?". Click to expand / toggle each scope (V1 just shows; toggle UI
// lands in Sprint 5 once we have per-scope `included: boolean` plumbing).

import { useTranslation } from 'react-i18next'
import { cn } from '@shared/lib/cn'

interface Props {
  hasEmailBody: boolean
  aiFieldsCount: number
  threadCount: number
}

export function ContextChips({
  hasEmailBody,
  aiFieldsCount,
  threadCount
}: Props): React.ReactElement {
  const { t } = useTranslation()

  const chips = [
    { key: 'email', label: t('chat.context.emailBody'), active: hasEmailBody },
    {
      key: 'ai',
      label: t('chat.context.aiFields', { n: aiFieldsCount }),
      active: aiFieldsCount > 0
    },
    { key: 'thread', label: t('chat.context.thread', { n: threadCount }), active: threadCount > 0 }
  ]

  return (
    <div className="px-3 py-2 flex items-center gap-1.5 flex-wrap border-b border-ink-border-soft">
      <span className="text-meta font-mono text-ink-fg-3 uppercase tracking-wider mr-1">
        {t('chat.context.title')}
      </span>
      {chips.every((c) => !c.active) ? (
        <span className="text-meta text-ink-fg-3">{t('chat.context.noContext')}</span>
      ) : (
        chips
          .filter((c) => c.active)
          .map((c) => (
            <span
              key={c.key}
              className={cn(
                'text-micro font-mono px-1.5 py-0.5 rounded uppercase tracking-wide',
                'text-ink-fg-1 bg-ink-4 border border-ink-border-soft'
              )}
            >
              {c.label}
            </span>
          ))
      )}
    </div>
  )
}
