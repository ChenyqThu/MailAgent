// Sprint 13 round 8 user feedback: "AI Summary 和 Suggest Reply 是最
// 重要的". Round 7 collapsed everything into a flat 3-col grid — the
// two cells that read like *actions* (Summary + Reply Suggestion) lost
// their visual hierarchy.  Round 8 brings them back as hero strips at
// the top of the block:
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ Header (icon · "AI Fields · N" · Reviewed · model)              │
//   ├─────────────────────────────────────────────────────────────────┤
//   │ ✦ Summary                                                       │
//   │ AI summary, 2-3 lines, coral-tinted hero strip                  │
//   ├─────────────────────────────────────────────────────────────────┤
//   │ ✎ Reply Suggestion                                              │
//   │ Markdown draft, dashed accent border, copy-to-clipboard          │
//   ├─────────────────────────────────────────────────────────────────┤
//   │ Priority · Action · Sender · Category · Project · Urgency       │
//   │ (3-col grid, mockup divider style)                              │
//   └─────────────────────────────────────────────────────────────────┘
//
// Data feed:
//   ai_summary           — LLM labels_json key (was already wired)
//   reply_suggestion_md  — LLM labels_json key.  store.py used to pop
//                          this before saving the audit blob; round 8
//                          stopped stripping it so it survives into
//                          email.aiFields.labels_raw.
//
// Field-name discovery (kept from round 6 / 7 — labels_json key audit):
//   sqlite3 data/sync_store.db "SELECT DISTINCT json_each.key FROM
//   llm_processing, json_each(labels_json)"

import { useState } from 'react'
import { ClipboardCheck, Copy, Cpu, Sparkles, MessageSquare } from 'lucide-react'

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
  return (
    <div className="aif-cell px-4 py-3 bg-ink-3">
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

// Reply Suggestion content is markdown the LLM wrote (see
// llm_agent/processor.py:185 prompt — "`reply_suggestion_md` 仅在
// action_required=true 时填"). We render it preformatted so the user
// sees the source they can paste/edit, with a one-click copy button.
function ReplyDraftHero({ markdown }: { markdown: string }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard may be denied in sandbox; the textarea below stays
      // selectable so the user can ⌘C manually.
    }
  }
  return (
    <div
      className="aif-reply px-4 py-3 border-b border-ink-border"
      style={{
        background: 'rgb(var(--c-accent) / 0.04)',
        boxShadow: 'inset 0 0 0 1px rgb(var(--c-accent) / 0.12)'
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <MessageSquare size={11} strokeWidth={2.25} className="text-coral" />
        <span
          className="text-micro font-mono uppercase tracking-wider text-coral"
          style={{ letterSpacing: '0.08em' }}
        >
          Reply Suggestion
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy reply draft"
          className={cn(
            'ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded',
            'text-[10px] text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4',
            'transition-colors duration-fast'
          )}
        >
          {copied ? (
            <ClipboardCheck size={10} strokeWidth={2.25} />
          ) : (
            <Copy size={10} strokeWidth={2.25} />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className={cn(
          'text-aux text-ink-fg leading-snug font-sans whitespace-pre-wrap break-words',
          'max-h-[260px] overflow-y-auto scrollbar-thin m-0'
        )}
      >
        {markdown}
      </pre>
    </div>
  )
}

export function AIFieldsBlock({ fields }: Props): React.ReactElement {
  const raw = fields.labels_raw
  const reviewed = fields.ai_review_status === 'reviewed'
  const pending = fields.ai_review_status === 'pending'

  const summary = pickString(raw, 'ai_summary') ?? pickString(raw, 'summary')
  const replyMarkdown =
    pickString(raw, 'reply_suggestion_md') ?? pickString(raw, 'reply_suggestion')
  const category = pickString(raw, 'category')
  const project = pickString(raw, 'related_project') ?? pickString(raw, 'project')
  const senderPriority = pickString(raw, 'sender_priority')
  const urgencyReason = pickString(raw, 'urgency_reason')
  const model = pickString(raw, 'model')
  const actionLabel = actionLabelChinese(fields.ai_action)

  // Secondary classifiers — keep the grid mockup-faithful but trimmed
  // to the high-signal cells the user actually reads.
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

  // Total non-empty count surfaced in the header pill.
  const nonNullCount = cells.length + (summary ? 1 : 0) + (replyMarkdown ? 1 : 0)
  const padCount = cells.length % 3 === 0 ? 0 : 3 - (cells.length % 3)

  return (
    <section
      aria-label="ai-fields"
      className="ai-fields rounded-lg border border-ink-border overflow-hidden"
    >
      {/* Header — icon + "AI Fields · N" + reviewed chip + model name */}
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

      {/* Summary hero — coral-tinted strip.  This is the single sentence
          the user reads first to decide whether to open the body. */}
      {summary && (
        <div
          className="aif-summary px-4 py-3 border-b border-ink-border"
          style={{ background: 'rgb(var(--c-accent) / 0.06)' }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={11} strokeWidth={2.25} className="text-coral" />
            <span
              className="text-micro font-mono uppercase tracking-wider text-coral"
              style={{ letterSpacing: '0.08em' }}
            >
              Summary
            </span>
          </div>
          <div className="text-aux text-ink-fg leading-snug">{summary}</div>
        </div>
      )}

      {/* Reply Suggestion hero — accent-ringed draft card with copy. */}
      {replyMarkdown && <ReplyDraftHero markdown={replyMarkdown} />}

      {/* 3-col secondary grid — bg-ink-border gutter + bg-ink-3 cells. */}
      {cells.length > 0 && (
        <div className="grid grid-cols-3 gap-px bg-ink-border">
          {cells.map((cell, idx) => (
            <GridCell key={`${cell.label}-${idx}`} {...cell} />
          ))}
          {padCount > 0 &&
            Array.from({ length: padCount }).map((_, i) => (
              <div key={`pad-${i}`} className="bg-ink-3" aria-hidden />
            ))}
        </div>
      )}
    </section>
  )
}
