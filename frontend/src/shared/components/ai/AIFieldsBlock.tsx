// mockup-inbox.html line 956+ pattern. The 3-col grid uses `gap-px` on a
// `bg-ink-border` parent — children with `bg-ink-3` then read as cells
// separated by 1px hairlines. Header strip has model + cost meta on the
// right. REVIEW-LOG H-14: V1 ships 8 cells, not 11.
//
// Cells:
//   AI Priority   AI Action     Review Status
//   Sentiment     Processing    Read
//   Flagged       Mailbox       Notion

import { Cpu, ExternalLink, Sparkles } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import type { AIFields, AIPriority } from '@shared/api/types'
import { actionLabelChinese } from '@shared/lib/ai_labels'

interface Props {
  fields: AIFields
}

const PRIORITY_TONE: Record<AIPriority, string> = {
  critical: 'text-crit',
  urgent: 'text-urg',
  important: 'text-impt',
  normal: 'text-norm',
  low: 'text-low'
}
const PRIORITY_DOT: Record<AIPriority, string> = {
  critical: 'bg-crit',
  urgent: 'bg-urg',
  important: 'bg-impt',
  normal: 'bg-norm',
  low: 'bg-low'
}
const PRIORITY_LABEL: Record<AIPriority, string> = {
  critical: 'Critical',
  urgent: 'Urgent',
  important: 'Important',
  normal: 'Normal',
  low: 'Low'
}

function Cell({
  label,
  children,
  span
}: {
  label: string
  children: React.ReactNode
  span?: 1 | 2
}): React.ReactElement {
  return (
    <div className={cn('px-3 py-2 bg-ink-3', span === 2 && 'col-span-2')}>
      <div
        className="text-micro font-mono uppercase text-ink-fg-2"
        style={{ letterSpacing: '0.08em' }}
      >
        {label}
      </div>
      <div className="mt-1 text-aux">{children}</div>
    </div>
  )
}

function Placeholder(): React.ReactElement {
  return <span className="text-ink-fg-3">—</span>
}

function YesNo({
  value,
  yesTone = 'text-ok'
}: {
  value: boolean
  yesTone?: string
}): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-aux font-medium',
        value ? yesTone : 'text-ink-fg-3'
      )}
    >
      <span
        className={cn(
          'inline-block w-1.5 h-1.5 rounded-full',
          value ? yesTone.replace('text-', 'bg-') : 'bg-ink-fg-3'
        )}
      />
      {value ? 'Yes' : 'No'}
    </span>
  )
}

export function AIFieldsBlock({ fields }: Props): React.ReactElement {
  const reviewed = fields.ai_review_status === 'reviewed'
  return (
    <section aria-label="ai-fields" className="rounded-lg border border-ink-border overflow-hidden">
      {/* Header strip */}
      <div className="px-3 py-1.5 bg-ink-2 border-b border-ink-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu size={12} strokeWidth={2} className="text-info" />
          <span
            className="text-meta font-mono uppercase text-ink-fg-1"
            style={{ letterSpacing: '0.06em' }}
          >
            AI Fields · 8
          </span>
          {fields.ai_review_status && (
            <span
              className={cn(
                'text-micro font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border',
                reviewed ? 'text-ok bg-ok/12 border-ok/30' : 'text-warn bg-warn/12 border-warn/30'
              )}
            >
              {reviewed ? 'Reviewed' : 'Pending'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-meta font-mono text-ink-fg-2">
          <Sparkles size={11} strokeWidth={2} className="text-ai" />
          <span>{fields.labels_raw?.model ? String(fields.labels_raw.model) : 'no run'}</span>
        </div>
      </div>

      {/* Grid · gap-px on bg-ink-border creates 1px hairlines between cells */}
      <div className="grid grid-cols-3 gap-px bg-ink-border">
        <Cell label="AI Priority">
          {fields.ai_priority ? (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 font-medium',
                PRIORITY_TONE[fields.ai_priority]
              )}
            >
              <span className={cn('w-1.5 h-1.5 rounded-full', PRIORITY_DOT[fields.ai_priority])} />
              {PRIORITY_LABEL[fields.ai_priority]}
            </span>
          ) : (
            <Placeholder />
          )}
        </Cell>

        <Cell label="AI Action">
          {actionLabelChinese(fields.ai_action) ? (
            <span className="text-ink-fg">{actionLabelChinese(fields.ai_action)}</span>
          ) : (
            <Placeholder />
          )}
        </Cell>

        <Cell label="Review Status">
          {fields.ai_review_status ? (
            <span className={cn('font-medium', reviewed ? 'text-ok' : 'text-warn')}>
              {reviewed ? 'Reviewed' : 'Pending'}
            </span>
          ) : (
            <Placeholder />
          )}
        </Cell>

        <Cell label="Sentiment">
          {fields.sentiment ? (
            <span className="text-ink-fg">{fields.sentiment}</span>
          ) : (
            <Placeholder />
          )}
        </Cell>

        <Cell label="Processing Status">
          {fields.processing_status ? (
            <span className="text-ink-fg">{fields.processing_status}</span>
          ) : (
            <Placeholder />
          )}
        </Cell>

        <Cell label="Mailbox">
          {fields.mailbox ? (
            <span className="inline-flex items-center gap-1.5 text-ink-fg">
              <span className="w-1.5 h-1.5 rounded-full bg-coral/100" />
              {fields.mailbox}
            </span>
          ) : (
            <Placeholder />
          )}
        </Cell>

        <Cell label="Is Read">
          <YesNo value={fields.is_read} />
        </Cell>

        <Cell label="Is Flagged">
          <YesNo value={fields.is_flagged} yesTone="text-urg" />
        </Cell>
      </div>

      {/* Footer link — if labels_raw has cost info, surface it as mockup line 962-970 does */}
      {fields.labels_raw && (
        <div className="px-3 py-1.5 bg-ink-2 border-t border-ink-border flex items-center justify-between text-meta font-mono text-ink-fg-2">
          <div className="flex items-center gap-3">
            {typeof fields.labels_raw.input_tokens === 'number' && (
              <span>
                in{' '}
                <span className="text-ink-fg-1 tabular-nums">{fields.labels_raw.input_tokens}</span>
              </span>
            )}
            {typeof fields.labels_raw.output_tokens === 'number' && (
              <span>
                out{' '}
                <span className="text-ink-fg-1 tabular-nums">
                  {fields.labels_raw.output_tokens}
                </span>
              </span>
            )}
            {typeof fields.labels_raw.latency_ms === 'number' && (
              <span>{fields.labels_raw.latency_ms}ms</span>
            )}
          </div>
          {typeof fields.labels_raw.daily_digest_date === 'string' && (
            <a
              href="#"
              className="text-coral hover:text-coral-hover inline-flex items-center gap-1"
            >
              digest {fields.labels_raw.daily_digest_date}
              <ExternalLink size={10} strokeWidth={2} />
            </a>
          )}
        </div>
      )}
    </section>
  )
}
