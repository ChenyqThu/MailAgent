// Sprint 3 §2.3 — collapsible thread sibling panel.
//
// Lives inside the EmailDetail scroll container, above the body, below the
// AI fields block. Why this placement: the email's own thread context is a
// reading aid for the *current* mail; putting it in the side panel column
// (Sprint 4 will host the AI Chat there) would force the user to look away
// from the prose they're trying to read. Sticking with the 820px-wide
// reading column keeps the eye on track.
//
// Empty-state contract:
//   thread_id === null  → render nothing (no empty box; sibling-less mail
//                         shouldn't carry extra visual chrome)
//   thread_id set, 1 hit → render with just the current message, "1 封" count
//                         (gives the user a fact: this email is the whole thread)
//   thread_id set, N hits → standard list
//
// Click semantics: clicking a non-current sibling switches the active email
// (useActiveEmail.setActive). The current email is rendered with the same
// visual weight but is `aria-current="true"` and ignores clicks.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useActiveEmail } from '@shared/state/active-email'
import { formatRelativeTime } from '@shared/format'
import { parseSender } from '@shared/lib/mail_parse'
import type { EmailMeta } from '@shared/api/types'

interface Props {
  threadId: string | null
  /** Currently active email — highlighted as `aria-current`. */
  currentInternalId: number
}

function SiblingRow({
  email,
  isCurrent,
  onSelect
}: {
  email: EmailMeta
  isCurrent: boolean
  onSelect(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const parsed = parseSender(email.sender)
  const senderName = email.sender_name || parsed.name || email.sender
  const time = email.date_received ? formatRelativeTime(email.date_received) : ''
  return (
    <button
      type="button"
      onClick={isCurrent ? undefined : onSelect}
      aria-current={isCurrent ? 'true' : undefined}
      disabled={isCurrent}
      className={cn(
        'w-full text-left px-3 py-2 rounded-md',
        'transition-colors duration-fast',
        'flex items-baseline gap-2',
        isCurrent
          ? 'bg-coral/10 border border-coral/30 cursor-default'
          : 'border border-transparent hover:bg-ink-4 cursor-pointer'
      )}
    >
      <span
        className={cn(
          'text-aux truncate flex-1',
          isCurrent ? 'text-ink-fg font-medium' : 'text-ink-fg-1',
          !email.is_read && !isCurrent && 'font-semibold text-ink-fg'
        )}
      >
        {senderName}
      </span>
      {isCurrent && (
        <span className="shrink-0 text-meta font-mono text-coral">{t('thread.current')}</span>
      )}
      <span className="shrink-0 text-meta font-mono text-ink-fg-2 tabular-nums">{time}</span>
    </button>
  )
}

export function ThreadSidebar({ threadId, currentInternalId }: Props): React.ReactElement | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const [expanded, setExpanded] = useState(true)

  const q = useQuery({
    queryKey: ['email', 'thread', threadId],
    queryFn: () => mailApi.email.listByThread(threadId),
    enabled: typeof threadId === 'string' && threadId.length > 0,
    staleTime: 30_000
  })

  // No thread_id at all → render nothing (intentional empty-state choice).
  if (typeof threadId !== 'string' || threadId.length === 0) return null
  if (q.isLoading) {
    return (
      <section
        aria-label="thread-sidebar"
        className="border border-ink-border-soft rounded-md bg-ink-4 px-3 py-2 text-aux text-ink-fg-2 animate-pulse"
      >
        {t('thread.title')}…
      </section>
    )
  }
  if (q.isError) {
    return (
      <section
        aria-label="thread-sidebar"
        className="border border-fail/30 rounded-md bg-fail/10 px-3 py-2 text-aux text-fail"
      >
        {t('thread.loadFailed')}
      </section>
    )
  }
  const siblings = q.data ?? []
  if (siblings.length === 0) return null
  const setActive = useActiveEmail.getState().setActive

  return (
    <section
      aria-label="thread-sidebar"
      className="border border-ink-border-soft rounded-md bg-ink-2/40"
    >
      <header
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((p) => !p)}
        onKeyDown={(evt) => {
          if (evt.key === 'Enter' || evt.key === ' ') {
            evt.preventDefault()
            setExpanded((p) => !p)
          }
        }}
        className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-ink-4/50 transition-colors duration-fast rounded-t-md"
      >
        {expanded ? (
          <ChevronDown size={13} strokeWidth={2} className="text-ink-fg-2" />
        ) : (
          <ChevronRight size={13} strokeWidth={2} className="text-ink-fg-2" />
        )}
        <MessageSquare size={13} strokeWidth={2} className="text-ink-fg-2" />
        <span className="text-aux font-medium text-ink-fg-1">{t('thread.title')}</span>
        <span className="text-meta font-mono text-ink-fg-3 tabular-nums">
          {t('thread.count', { n: siblings.length })}
        </span>
      </header>
      {expanded && (
        <div className="px-2 pb-2 space-y-px">
          {siblings.map((s) => (
            <SiblingRow
              key={s.internal_id}
              email={s}
              isCurrent={s.internal_id === currentInternalId}
              onSelect={() => setActive(s.internal_id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
