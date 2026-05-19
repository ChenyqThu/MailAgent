// Sprint 13 round 7 user feedback: "AI Fields 的 review 没有按照 mockup
// 实现 + AI 字段需要做一下精炼和精简，避免太多字段".
//
// mockup-inbox.html L955-1021 ships a flat 11-cell grid (no hero summary
// strip, no signal row). Sprint 12 round-6 added both — visually busier
// but drifted from the mockup. This rewrite collapses the layout to a
// single 3-col grid, mirrors mockup's `bg-ink-2 header / bg-ink-3 cell
// over bg-ink-border gutters`, and trims the field set down to seven:
//
//   Priority (chip dot) · Action · Sender Priority (chip dot)
//   Category · Project · Urgency Reason
//   ┌────────────────────────────────────────────────────────┐
//   │ Summary (col-span-3, multi-line)                       │
//   └────────────────────────────────────────────────────────┘
//
// We drop Sentiment / Language / Has Action Items / Daily Digest. They
// were the lowest-signal cells (Sentiment is unused, Language already
// surfaces as the EN pip near the subject, Has Action Items duplicated
// Action, Daily Digest had its own link nobody clicked). They're still
// in the labels_json payload — re-introducing a cell is one entry in
// `extraCells` away.
//
// Data feed: AIFields.labels_raw is the freeform JSON dict written by
// the LLM run. Field-name discovery:
//   sqlite3 data/sync_store.db "SELECT DISTINCT json_each.key FROM
//   llm_processing, json_each(labels_json)"
// returns ai_summary / category / language / sender_priority /
// action_required / action_type / priority / urgency_reason /
// mail_actions / daily_digest_date / related_project / model /
// latency_ms / token counts.

import { Cpu } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { actionLabelChinese } from '@shared/lib/ai_labels'
import type { AIFields, AIPriority } from '@shared/api/types'

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

function pickString(raw: Record<string, unknown> | null, key: string): string | null {
  if (!raw) return null
  const v = raw[key]
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

interface CellSpec {
  label: string
  value: React.ReactNode
  colSpan?: 1 | 2 | 3
}

function GridCell({ label, value, colSpan }: CellSpec): React.ReactElement {
  return (
    <div
      className={cn(
        'aif-cell px-4 py-3 bg-ink-3',
        colSpan === 3 && 'col-span-3',
        colSpan === 2 && 'col-span-2'
      )}
    >
      <div
        className="text-micro font-mono uppercase tracking-wider text-ink-fg-2"
        style={{ letterSpacing: '0.08em' }}
      >
        {label}
      </div>
      <div className="mt-1 text-aux text-ink-fg-1 leading-snug">{value}</div>
    </div>
  )
}

export function AIFieldsBlock({ fields }: Props): React.ReactElement {
  const raw = fields.labels_raw
  const reviewed = fields.ai_review_status === 'reviewed'
  const pending = fields.ai_review_status === 'pending'

  const summary = pickString(raw, 'ai_summary') ?? pickString(raw, 'summary')
  const category = pickString(raw, 'category')
  const project = pickString(raw, 'related_project') ?? pickString(raw, 'project')
  const senderPriority = pickString(raw, 'sender_priority')
  const urgencyReason = pickString(raw, 'urgency_reason')
  const model = pickString(raw, 'model')
  const actionLabel = actionLabelChinese(fields.ai_action)

  // Build the cell list in mockup order. Cells whose source is null
  // collapse out, so a sparse labels_json doesn't leave blank squares.
  const cells: CellSpec[] = []

  if (fields.ai_priority) {
    cells.push({
      label: 'Priority',
      value: (
        <span
          className={cn(
            'inline-flex items-center gap-1.5 font-medium',
            PRIORITY_TONE[fields.ai_priority]
          )}
        >
          <span className={cn('w-1.5 h-1.5 rounded-full', PRIORITY_DOT[fields.ai_priority])} />
          {PRIORITY_LABEL[fields.ai_priority]}
        </span>
      )
    })
  }
  if (actionLabel) {
    cells.push({ label: 'Action', value: <span className="text-ink-fg">{actionLabel}</span> })
  }
  if (senderPriority) {
    cells.push({
      label: 'Sender Priority',
      value: (
        <span className="inline-flex items-center gap-1.5 text-impt">
          <span className="w-1.5 h-1.5 rounded-full bg-impt" />
          {senderPriority}
        </span>
      )
    })
  }
  if (category) cells.push({ label: 'Category', value: category })
  if (project) cells.push({ label: 'Project', value: project })
  if (urgencyReason) {
    cells.push({
      label: 'Urgency Reason',
      value: <span className="text-urg">{urgencyReason}</span>
    })
  }

  // Total non-empty count for the "AI Fields · N" header pill — counts
  // summary too even though it lives outside `cells` (col-span-3).
  const nonNullCount = cells.length + (summary ? 1 : 0)

  // Pad the visible 3-col row so cells before Summary don't dangle on
  // their own gutter row. Only fills the first row of non-summary cells.
  const padCount = cells.length % 3 === 0 ? 0 : 3 - (cells.length % 3)

  return (
    <section
      aria-label="ai-fields"
      className="ai-fields rounded-lg border border-ink-border overflow-hidden"
    >
      {/* Header — icon + "AI Fields · N" + reviewed chip + model name on
          right. Mockup L957-970: bg-ink-2 strip, mono label, ok-green
          Reviewed chip when ai_review_status === 'reviewed'.

          Note: header uses bg-ink-2 (slightly darker than the cell
          bg-ink-3) so the section header reads as a strip even when the
          parent surface is glass-3. */}
      <div className="px-4 py-2 bg-ink-2 border-b border-ink-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu size={12} strokeWidth={2} className="text-info" />
          <span
            className="text-meta font-mono uppercase tracking-wider text-ink-fg-1"
            style={{ letterSpacing: '0.06em' }}
          >
            AI Fields · {nonNullCount}
          </span>
          {(reviewed || pending) && (
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
        {model && <div className="text-meta font-mono text-ink-fg-1">{model}</div>}
      </div>

      {/* 3-col grid — mockup L971. `gap-px` over `bg-ink-border` gives
          us the hairline divider grid; cells override with `bg-ink-3`. */}
      {(cells.length > 0 || summary) && (
        <div className="grid grid-cols-3 gap-px bg-ink-border">
          {cells.map((cell, idx) => (
            <GridCell key={`${cell.label}-${idx}`} {...cell} />
          ))}
          {/* Filler cells to round out the row before summary. */}
          {padCount > 0 &&
            Array.from({ length: padCount }).map((_, i) => (
              <div key={`pad-${i}`} className="bg-ink-3" aria-hidden />
            ))}
          {summary && (
            <GridCell
              label="Summary"
              colSpan={3}
              value={<span className="text-ink-fg leading-snug">{summary}</span>}
            />
          )}
        </div>
      )}
    </section>
  )
}
