// DESIGN.md §5.1 — list row. The mockup paste uses placeholder field names
// (`fromName`, `lang`, `shortTime`, `attachCount`, `aiPriority`, etc.) that
// don't exist on `EnrichedEmailMeta`; we adapt to the real shape and route
// missing values to the design's "absent" fallback (e.g. no AI labels →
// `<NoAILabels>` placeholder chips that keep the row height stable so the
// list doesn't wobble across rows with/without LLM coverage).
//
// AIBadge variant comes from DESIGN.md §5.2; lang pip is inline (one-off,
// not worth a component for V1).
//
// Selected state: 3px coral left border + ink-3 bg (mockup parity). Hover:
// ink-2 (slightly subtler than mockup's ink-3 so the selected state still
// reads on top).

import { Paperclip } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { mapActionLabel } from '@shared/lib/ai_labels'
import { parseSender, cleanSnippet } from '@shared/lib/mail_parse'
import { formatRelativeTime } from '@shared/format'
import type { EnrichedEmailMeta } from '@shared/api/types'

import { AIBadge } from '../ai/AIBadge'

interface Props {
  email: EnrichedEmailMeta
  selected: boolean
  /** Set when 5s polling notices this id appeared after the prior poll. Fades after 2s. */
  isNew?: boolean
  onSelect(): void
}

function formatShortTime(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return formatRelativeTime(iso)
  } catch {
    return ''
  }
}

export function EmailRow({ email, selected, isNew, onSelect }: Props): React.ReactElement {
  const unread = !email.is_read
  const failed = email.sync_status === 'failed' || email.sync_status === 'dead_letter'
  // `sender_name` is mostly empty in production; the real RFC string is in
  // `sender` ("Display Name" <addr@domain>). Mockup §5.1 renders both halves
  // separated by a middot.
  const parsed = parseSender(email.sender)
  const senderName = email.sender_name || parsed.name
  const senderAddr = parsed.email
  // body_markdown from markdownify of HTML emails often has leading table
  // separators + image refs. Strip them so the snippet line carries actual
  // prose like the mockup does.
  const snippet = cleanSnippet(email.snippet)

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault()
          onSelect()
        }
      }}
      data-internal-id={email.internal_id}
      className={cn(
        'group relative px-4 py-3 border-b border-ink-border-soft cursor-pointer',
        'transition-colors duration-fast',
        selected ? 'bg-ink-3' : 'hover:bg-ink-2'
      )}
    >
      {/* Selected: 3px coral left edge. Absolute so it doesn't shift the row. */}
      {selected && (
        <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-coral/100" aria-hidden />
      )}

      <div className="flex items-start gap-2.5">
        {/* Unread coral dot — 1.5px, top-aligned with first text line. */}
        <span
          className={cn(
            'mt-1.5 shrink-0 w-1.5 h-1.5',
            unread && 'rounded-full',
            unread && (failed ? 'bg-fail' : 'bg-coral/100')
          )}
          aria-hidden={!unread}
          title={unread ? 'Unread' : undefined}
        />

        <div className="min-w-0 flex-1">
          {/* Header row: sender (name · email mockup pattern) + lang pip +
              sync-failed pill + relative time. */}
          <div className="flex items-center gap-2 mb-0.5">
            <span
              className={cn(
                'text-aux truncate flex-1',
                unread ? 'text-ink-fg font-medium' : 'text-ink-fg-1'
              )}
            >
              {senderName && <span>{senderName}</span>}
              {senderName && senderAddr && <span className="text-ink-fg-3"> · </span>}
              {senderAddr ? (
                <span className={unread ? 'text-ink-fg-1' : 'text-ink-fg-2'}>{senderAddr}</span>
              ) : (
                !senderName && <span>{email.sender}</span>
              )}
            </span>

            {email.lang === 'en' && (
              <span
                className="text-micro font-mono uppercase text-info bg-info/10 border border-info/25 px-1 py-px rounded shrink-0"
                aria-label="English"
              >
                EN
              </span>
            )}

            {failed && (
              <span className="text-micro font-mono text-fail bg-fail/10 border border-fail/25 px-1.5 py-0.5 rounded shrink-0">
                SYNC FAILED
              </span>
            )}

            {isNew && (
              <span className="text-micro font-mono text-coral bg-coral/15 border border-coral/30 px-1.5 py-0.5 rounded shrink-0">
                NEW
              </span>
            )}

            <span className="text-meta font-mono text-ink-fg-2 shrink-0 tabular-nums">
              {formatShortTime(email.date_received)}
            </span>
          </div>

          {/* Subject. */}
          <div
            className={cn(
              'text-body truncate',
              unread ? 'text-ink-fg font-semibold' : 'text-ink-fg-1'
            )}
          >
            {email.subject || '(no subject)'}
          </div>

          {/* Snippet — markdownify residue (table separators, image refs)
              stripped via cleanSnippet so we display prose like the mockup. */}
          {snippet && <div className="text-aux text-ink-fg-2 line-clamp-1 mt-0.5">{snippet}</div>}

          {/* Chips row: AI priority + AI action + paperclip count. */}
          <div className="flex items-center gap-1.5 mt-2">
            {email.ai_priority && (
              <AIBadge priority={email.ai_priority} withDot>
                {email.ai_priority}
              </AIBadge>
            )}
            {email.ai_action && (
              <span
                title={email.ai_action}
                className="inline-flex items-center text-micro font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border border-ink-border text-ink-fg-1"
              >
                {mapActionLabel(email.ai_action)}
              </span>
            )}
            {email.attach_count > 0 && (
              <span className="ml-auto flex items-center gap-1 text-ink-fg-2">
                <Paperclip size={11} />
                <span className="text-meta font-mono tabular-nums">{email.attach_count}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}
