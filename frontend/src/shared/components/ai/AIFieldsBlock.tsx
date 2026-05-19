// Sprint 12 — three-tier layout per mockup-inbox.html lines 2135-2203.
//
//   ┌─────────────────────────────────────────────────────────┐
//   │ aif-head    (icon · "AI Fields · N" · Reviewed · model) │
//   ├─────────────────────────────────────────────────────────┤
//   │ aif-summary (coral hero with the AI summary one-liner)  │
//   ├─────────────────────────────────────────────────────────┤
//   │ aif-signals (priority dot · action · due · sender)      │
//   ├─────────────────────────────────────────────────────────┤
//   │ aif-grid    (3-col 1-line cells — secondary classifiers)│
//   └─────────────────────────────────────────────────────────┘
//
// Data feed: AIFields.labels_raw is freeform JSON from the LLM run; we
// look up `summary`, `category`, `project`, `language`, `daily_digest_date`,
// `action_items`, `due_date`, `sla`, `model` keys when present and silently
// hide cells whose source is null. The CSS lives in mockup index.css
// (.ai-fields .aif-head / .aif-grid / .aif-cell / .aif-summary / .aif-signals).

import { Clock, Cpu, ExternalLink } from 'lucide-react'

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
}

function GridCell({ label, value }: CellSpec): React.ReactElement {
  // mockup L2178 — `aif-cell px-4 py-2.5`. Sprint 12 used px-3.5 which
  // pulled the label too close to the divider line; sprint 13 user
  // feedback flagged the inconsistency.
  return (
    <div className="aif-cell px-4 py-2.5">
      <div
        className="text-micro font-mono uppercase tracking-wider text-ink-fg-2"
        style={{ letterSpacing: '0.08em' }}
      >
        {label}
      </div>
      <div className="mt-0.5 text-aux text-ink-fg-1 truncate">{value}</div>
    </div>
  )
}

export function AIFieldsBlock({ fields }: Props): React.ReactElement {
  const raw = fields.labels_raw
  const reviewed = fields.ai_review_status === 'reviewed'
  const pending = fields.ai_review_status === 'pending'

  // Sprint 13 round 6 — field names corrected against the real LLM output.
  // sqlite3 data/sync_store.db "SELECT DISTINCT json_each.key FROM
  // llm_processing, json_each(labels_json)" returns: ai_summary / key_points
  // / category / language / sender_priority / action_required / action_type
  // / priority / urgency_reason / mail_actions / daily_digest_date /
  // related_project / model / latency_ms / token counts.
  //
  // Previous code probed `summary` / `project` / `due_date` / `action_items`
  // — none of which exist. That's why "AI Summary 没用了" — we were reading
  // a key the agent never wrote.
  const summary = pickString(raw, 'ai_summary') ?? pickString(raw, 'summary')
  const category = pickString(raw, 'category')
  const project = pickString(raw, 'related_project') ?? pickString(raw, 'project')
  const language = pickString(raw, 'language')
  const dailyDigest = pickString(raw, 'daily_digest_date')
  const senderPriority = pickString(raw, 'sender_priority')
  const urgencyReason = pickString(raw, 'urgency_reason')
  const actionRequired =
    raw && typeof raw.action_required === 'boolean' ? raw.action_required : null
  const mailActions =
    raw && Array.isArray(raw.mail_actions) ? (raw.mail_actions as unknown[]) : null
  const model = pickString(raw, 'model')
  const actionLabel = actionLabelChinese(fields.ai_action)

  // Count of non-null fields (for the "AI Fields · N" header pill).
  const countables = [
    fields.ai_priority,
    fields.ai_action,
    fields.ai_review_status,
    fields.sentiment,
    fields.processing_status,
    summary,
    category,
    project,
    language,
    dailyDigest,
    senderPriority,
    urgencyReason
  ]
  const nonNullCount = countables.filter((v) => v !== null && v !== undefined).length

  const gridCells: CellSpec[] = []
  if (category) gridCells.push({ label: 'Category', value: category })
  if (project) gridCells.push({ label: 'Project', value: project })
  if (fields.sentiment) gridCells.push({ label: 'Sentiment', value: fields.sentiment })
  if (language) {
    gridCells.push({
      label: 'Language',
      value: <span className="font-mono">{language}</span>
    })
  }
  if (actionRequired !== null) {
    gridCells.push({
      label: 'Action Items',
      value: actionRequired ? (
        <span className="text-urg">
          是
          {mailActions && mailActions.length > 0 && (
            <span className="font-mono tabular-nums text-ink-fg-2"> · {mailActions.length}</span>
          )}
        </span>
      ) : (
        <span className="text-ink-fg-2">否</span>
      )
    })
  }
  if (dailyDigest) {
    gridCells.push({
      label: 'Daily Digest',
      value: (
        <span className="text-coral inline-flex items-center gap-1">
          <span className="font-mono">{dailyDigest}</span>
          <ExternalLink size={10} strokeWidth={2} />
        </span>
      )
    })
  }
  if (fields.processing_status && !category) {
    // Surface processing status when no other category-ish data exists.
    gridCells.push({ label: 'Processing', value: fields.processing_status })
  }

  return (
    <section
      aria-label="ai-fields"
      className="ai-fields rounded-lg border border-ink-border overflow-hidden"
    >
      {/* Header — icon + "AI Fields · N" + reviewed chip + model name (right) */}
      <div className="aif-head px-4 py-2 border-b border-ink-border flex items-center justify-between">
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
        {model && (
          // mockup L2146 — model name only, no ✦ icon, text-ink-fg-1
          // (brighter than ink-fg-2). Sprint 12 added a coral Sparkles
          // for visual symmetry with the head-left ✦, but the mockup is
          // explicit: right side is just the model id in mono so the
          // "AI Fields · N" caption stays the single brand mark.
          <div className="text-meta font-mono text-ink-fg-1">{model}</div>
        )}
      </div>

      {/* Summary — coral-tinted hero strip */}
      {summary && (
        <div
          className="aif-summary px-4 py-3 border-b border-ink-border"
          style={{ background: 'rgb(var(--c-accent) / 0.06)' }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="w-1 h-1 rounded-full bg-coral/100" />
            <span
              className="text-micro font-mono uppercase tracking-wider text-coral"
              style={{ letterSpacing: '0.08em' }}
            >
              Summary
            </span>
          </div>
          <div className="text-body text-ink-fg leading-snug">{summary}</div>
        </div>
      )}

      {/* Signal row — mockup L2159-2174. Four "action drivers" rendered
          with `·` separators: Priority · Action · Urgency reason · Sender.
          Each piece guarded so missing fields collapse cleanly (the
          common-case email may only have 1–2 of these). */}
      {(fields.ai_priority || actionLabel || urgencyReason || senderPriority) && (
        <div className="aif-signals px-4 py-2.5 border-b border-ink-border flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {fields.ai_priority && (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 text-aux font-medium',
                PRIORITY_TONE[fields.ai_priority]
              )}
            >
              <span className={cn('w-1.5 h-1.5 rounded-full', PRIORITY_DOT[fields.ai_priority])} />
              {PRIORITY_LABEL[fields.ai_priority]}
            </span>
          )}
          {fields.ai_priority && actionLabel && <span className="text-ink-fg-3">·</span>}
          {actionLabel && <span className="text-aux text-ink-fg">{actionLabel}</span>}
          {(fields.ai_priority || actionLabel) && urgencyReason && (
            <span className="text-ink-fg-3">·</span>
          )}
          {urgencyReason && (
            <span className="inline-flex items-center gap-1.5 text-aux text-urg font-mono">
              <Clock size={11} strokeWidth={2.25} />
              {urgencyReason}
            </span>
          )}
          {(fields.ai_priority || actionLabel || urgencyReason) && senderPriority && (
            <span className="text-ink-fg-3">·</span>
          )}
          {senderPriority && (
            <span className="inline-flex items-center gap-1.5 text-aux text-impt">
              <span className="w-1.5 h-1.5 rounded-full bg-impt" />
              {senderPriority}
            </span>
          )}
        </div>
      )}

      {/* Meta grid — 3-col secondary classifiers */}
      {gridCells.length > 0 && (
        <div className="aif-grid grid grid-cols-3 gap-px">
          {gridCells.map((cell, idx) => (
            <GridCell key={`${cell.label}-${idx}`} {...cell} />
          ))}
          {/* Fill blank cells so the grid renders cleanly even when count
              isn't a multiple of 3 — empty cells keep the divider grid intact. */}
          {gridCells.length % 3 !== 0 &&
            Array.from({ length: 3 - (gridCells.length % 3) }).map((_, i) => (
              <div key={`pad-${i}`} className="aif-cell px-4 py-2.5" aria-hidden />
            ))}
        </div>
      )}

      {/* Sprint 12 added a token-usage footer; mockup L2202 ends at the
          meta grid. Sprint 13 user-feedback: AIFieldsBlock should be
          mockup-faithful. Token cost data is still available in the
          /llm dashboard (LlmDashboardPage). */}
    </section>
  )
}
