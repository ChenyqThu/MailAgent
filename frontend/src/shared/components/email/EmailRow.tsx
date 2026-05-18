// DESIGN.md §5.1 + mockup-inbox.html row pattern (line 603+). Header line
// is "Display Name · addr@domain" (parsed from RFC 822), the language pip
// uses .lang-pip CSS class (mockup convention), priority chip uses
// `text-X bg-X/15 border-X/30` triplet matching DESIGN.md §2.3, action
// chip is an English short code so DESIGN.md §14 #2 / §16.6 isn't
// violated by Chinese at text-micro.
//
// Sprint 2 sticks with the unread coral dot on the left; the batch
// checkbox (cb / cb-on) arrives with Sprint 5's BatchActionBar.

import { Paperclip, Star } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { mapActionLabel } from '@shared/lib/ai_labels'
import { parseSender, cleanSnippet } from '@shared/lib/mail_parse'
import { formatRelativeTime } from '@shared/format'
import type { EnrichedEmailMeta, AIPriority } from '@shared/api/types'

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

// DESIGN.md §2.3 — chip variant per priority. Title-case label per mockup
// (Critical / Urgent / Important / Normal / Low) at text-micro mono.
const PRIORITY_LABEL: Record<AIPriority, string> = {
  critical: 'Critical',
  urgent: 'Urgent',
  important: 'Important',
  normal: 'Normal',
  low: 'Low'
}
const PRIORITY_CHIP: Record<AIPriority, string> = {
  critical: 'text-crit bg-crit/15 border-crit/30',
  urgent: 'text-urg bg-urg/15 border-urg/30',
  important: 'text-impt bg-impt/15 border-impt/30',
  normal: 'text-norm bg-norm/15 border-norm/30',
  low: 'text-low bg-low/15 border-low/30'
}

export function EmailRow({ email, selected, isNew, onSelect }: Props): React.ReactElement {
  const unread = !email.is_read
  const failed = email.sync_status === 'failed' || email.sync_status === 'dead_letter'
  const parsed = parseSender(email.sender)
  const senderName = email.sender_name || parsed.name
  const senderAddr = parsed.email
  const snippet = cleanSnippet(email.snippet)
  const actionLabel = mapActionLabel(email.ai_action)

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
        'row px-4 py-3 border-b border-ink-border-soft cursor-pointer',
        'transition-colors duration-fast',
        selected ? 'row-selected bg-ink-4' : 'hover:bg-ink-3'
      )}
    >
      <div className="flex items-start gap-2.5">
        {/* Unread coral dot — 1.5px, top-aligned with first text line. Hidden
            on read rows but the slot stays (shrink-0 mt-1.5 w-1.5 h-1.5) so
            row content alignment doesn't shift. */}
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
          {/* Header row: sender (name + addr) + lang pip + flagged star +
              sync-failed pill + NEW pill + time. */}
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
                !senderName && <span className="text-ink-fg-2">{email.sender}</span>
              )}
            </span>

            {email.is_flagged && (
              <Star
                size={11}
                strokeWidth={1.5}
                className="text-urg shrink-0 fill-current"
                aria-label="Flagged"
              />
            )}

            {email.lang === 'en' && (
              <span className="lang-pip shrink-0" aria-label="English">
                EN
              </span>
            )}

            {failed && (
              <span className="text-micro font-mono uppercase tracking-wide text-fail bg-fail/10 border border-fail/25 px-1.5 py-0.5 rounded shrink-0">
                SYNC FAILED
              </span>
            )}

            {isNew && (
              <span className="text-micro font-mono uppercase tracking-wide text-coral bg-coral/15 border border-coral/30 px-1.5 py-0.5 rounded shrink-0">
                NEW
              </span>
            )}

            <span className="text-meta font-mono text-ink-fg-2 shrink-0 tabular-nums">
              {formatShortTime(email.date_received)}
            </span>
          </div>

          {/* Subject */}
          <div
            className={cn(
              'text-body truncate',
              unread ? 'text-ink-fg font-semibold' : 'text-ink-fg-1'
            )}
          >
            {email.subject || '(no subject)'}
          </div>

          {/* Snippet — Sprint 10 visual review M-4: dropped one tier to
              text-ink-fg-3 + text-meta so the line carries less visual
              weight; subject stays the dominant cue and the row feels
              less stuffed at 340px column width. */}
          {snippet && <div className="text-meta text-ink-fg-3 line-clamp-1 mt-0.5">{snippet}</div>}

          {/* Chip row — tightened mt + chip padding for less vertical noise. */}
          <div className="flex items-center gap-1 mt-1.5">
            {email.ai_priority && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-micro font-mono uppercase tracking-wide',
                  'px-1 py-0.5 rounded border',
                  PRIORITY_CHIP[email.ai_priority]
                )}
              >
                <span
                  className={cn(
                    'w-1 h-1 rounded-full',
                    email.ai_priority === 'critical' && 'bg-crit',
                    email.ai_priority === 'urgent' && 'bg-urg',
                    email.ai_priority === 'important' && 'bg-impt',
                    email.ai_priority === 'normal' && 'bg-norm',
                    email.ai_priority === 'low' && 'bg-low'
                  )}
                  aria-hidden
                />
                {PRIORITY_LABEL[email.ai_priority]}
              </span>
            )}
            {actionLabel && (
              <span
                title={email.ai_action ?? undefined}
                className="inline-flex items-center text-micro font-mono uppercase tracking-wide px-1 py-0.5 rounded border border-ink-border text-ink-fg-1 bg-ink-3"
              >
                {actionLabel}
              </span>
            )}
            {email.attach_count > 0 && (
              <span className="ml-auto flex items-center gap-1 text-ink-fg-2">
                <Paperclip size={11} strokeWidth={2} />
                <span className="text-meta font-mono tabular-nums">{email.attach_count}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}
