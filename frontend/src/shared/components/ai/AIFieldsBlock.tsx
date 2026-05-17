// DESIGN.md §5 — detail-pane "AI FIELDS · 8" block. Three columns × eight
// rows (or grid-cols-3 with auto-flow). Each cell: tiny label above + value
// below. REVIEW-LOG H-14 set V1 = 8 fields; the V1.5 candidates (Action
// Items / Tags / Translated Body) stay out until they ship.
//
// Sentiment is intentionally rendered with a "—" placeholder when the LLM
// hasn't emitted it (production data: `labels_json.sentiment` doesn't
// exist). Better to keep the grid shape stable than collapse cells.

import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import type { AIFields } from '@shared/api/types'

import { AIBadge } from './AIBadge'

interface Props {
  fields: AIFields
}

function Cell({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div>
      <div className="text-micro font-mono uppercase tracking-widest text-ink-fg-3 mb-1">
        {label}
      </div>
      <div className="text-aux text-ink-fg">{children}</div>
    </div>
  )
}

function Placeholder(): React.ReactElement {
  return <span className="text-ink-fg-3">—</span>
}

function CheckCell({ value }: { value: boolean }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center text-meta font-mono uppercase tracking-wide',
        value ? 'text-ok' : 'text-ink-fg-3'
      )}
    >
      <span
        className={cn(
          'inline-block w-1.5 h-1.5 rounded-full mr-1.5',
          value ? 'bg-ok' : 'bg-ink-fg-3'
        )}
        aria-hidden
      />
      {value ? 'YES' : 'NO'}
    </span>
  )
}

function ReviewCell({ value }: { value: AIFields['ai_review_status'] }): React.ReactElement {
  if (value === null) return <Placeholder />
  return (
    <span
      className={cn(
        'inline-flex items-center text-meta font-mono uppercase tracking-wide',
        value === 'reviewed' ? 'text-ok' : 'text-warn'
      )}
    >
      {value}
    </span>
  )
}

export function AIFieldsBlock({ fields }: Props): React.ReactElement {
  const { t: _t } = useTranslation()
  void _t // reserved — i18n keys for cell labels land in Sprint 7 polish
  return (
    <section
      aria-label="ai-fields"
      className="rounded-lg border border-ink-border bg-ink-1 px-5 py-4"
    >
      <header className="flex items-center justify-between mb-4">
        <h3 className="text-micro font-mono uppercase tracking-widest text-ink-fg-2">
          AI Fields
          <span className="ml-2 text-ink-fg-3 tabular-nums">8</span>
        </h3>
      </header>

      <dl className="grid grid-cols-3 gap-x-6 gap-y-4">
        <Cell label="AI Action">
          {fields.ai_action ? (
            <span title={fields.ai_action} className="text-ink-fg">
              {fields.ai_action}
            </span>
          ) : (
            <Placeholder />
          )}
        </Cell>

        <Cell label="AI Priority">
          {fields.ai_priority ? (
            <AIBadge priority={fields.ai_priority} withDot>
              {fields.ai_priority}
            </AIBadge>
          ) : (
            <Placeholder />
          )}
        </Cell>

        <Cell label="Review">
          <ReviewCell value={fields.ai_review_status} />
        </Cell>

        <Cell label="Sentiment">
          {fields.sentiment ? (
            <span className="text-ink-fg">{fields.sentiment}</span>
          ) : (
            <Placeholder />
          )}
        </Cell>

        <Cell label="Status">
          {fields.processing_status ? (
            <span className="text-ink-fg">{fields.processing_status}</span>
          ) : (
            <Placeholder />
          )}
        </Cell>

        <Cell label="Read">
          <CheckCell value={fields.is_read} />
        </Cell>

        <Cell label="Flagged">
          <CheckCell value={fields.is_flagged} />
        </Cell>

        <Cell label="Mailbox">
          {fields.mailbox ? <span className="text-ink-fg">{fields.mailbox}</span> : <Placeholder />}
        </Cell>
      </dl>
    </section>
  )
}
