// Sprint 14 主菜 — Outlook-style 同线程邮件折叠.
//
// NOTES.md 2026-05-20 brief:
//   "EmailDetail 主面板下方追加一个折叠区, 把同 thread_id 的早期邮件
//    按 date_received DESC 排列, 默认折叠仅显示标题 + 发件人 + 日期,
//    点击展开嵌入 mini EmailBodyFrame. 最新邮件 (当前 active) 永远展开."
//
// Differences from the deleted ThreadSidebar (Sprint 3) — this is NOT
// a sidebar.  It sits inside the EmailDetail scroll column underneath
// AttachmentList, lists sibling messages other than the currently
// active one, and supports per-item expand-to-read in place.  The
// active email stays in the main panel above (no duplication).
//
// Data flow:
//   listByThread(threadId)         → EmailMeta[]
//   filter (m) => m.internal_id ≠ current
//   sort by date_received DESC
//   per item, on expand:
//     email.get(internal_id)       → EmailDetail (with attachments)
//     <EmailBodyFrame internalId=… attachments=…>

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { formatRelativeTime } from '@shared/format'
import { parseSender } from '@shared/lib/mail_parse'
import type { EmailMeta } from '@shared/api/types'

import { EmailBodyFrame } from './EmailBodyFrame'

interface Props {
  threadId: string | null
  /** Currently active email — filtered OUT of the bundle (it's shown in
   *  the main detail panel above). */
  currentInternalId: number
}

interface ItemProps {
  email: EmailMeta
  expanded: boolean
  onToggle(): void
}

function ThreadItem({ email, expanded, onToggle }: ItemProps): React.ReactElement {
  const mailApi = useMailApi()
  const parsed = parseSender(email.sender)
  const senderName = email.sender_name || parsed.name || email.sender
  const time = email.date_received ? formatRelativeTime(email.date_received) : ''

  // Only fetch the full record (body + attachments) once the user has
  // chosen to expand this item.  enabled=expanded keeps the IPC traffic
  // proportional to interest.
  const detailQ = useQuery({
    queryKey: ['email', email.internal_id],
    queryFn: () => mailApi.email.get(email.internal_id),
    enabled: expanded,
    staleTime: 30_000
  })

  return (
    <div
      className={cn('border-b border-ink-border-soft last:border-b-0', expanded && 'bg-ink-3/40')}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          'w-full text-left px-3 py-2 flex items-center gap-3',
          'hover:bg-ink-4/40 transition-colors duration-fast',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-coral/40'
        )}
      >
        <span className="shrink-0 text-ink-fg-2">
          {expanded ? (
            <ChevronDown size={12} strokeWidth={2} />
          ) : (
            <ChevronRight size={12} strokeWidth={2} />
          )}
        </span>
        <span
          className={cn(
            'shrink-0 text-aux truncate max-w-[180px]',
            email.is_read ? 'text-ink-fg-1' : 'text-ink-fg font-semibold'
          )}
        >
          {senderName}
        </span>
        <span className="text-ink-fg-3 shrink-0 text-meta">·</span>
        <span className="flex-1 text-aux text-ink-fg-1 truncate">
          {email.subject || '(no subject)'}
        </span>
        <span className="shrink-0 text-meta font-mono text-ink-fg-2 tabular-nums">{time}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-4 pt-1">
          {detailQ.isLoading && (
            <div className="text-aux text-ink-fg-2 animate-pulse py-2">Loading…</div>
          )}
          {detailQ.isError && (
            <div className="text-aux text-fail py-2">
              {detailQ.error instanceof Error ? detailQ.error.message : 'Body load failed.'}
            </div>
          )}
          {detailQ.data && (
            <EmailBodyFrame
              internalId={detailQ.data.internal_id}
              attachments={detailQ.data.attachments ?? []}
            />
          )}
        </div>
      )}
    </div>
  )
}

export function ThreadBundle({ threadId, currentInternalId }: Props): React.ReactElement | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()

  const q = useQuery({
    queryKey: ['email', 'thread', threadId],
    queryFn: () => mailApi.email.listByThread(threadId),
    enabled: typeof threadId === 'string' && threadId.length > 0,
    staleTime: 30_000
  })

  // Per-item expansion state.  Map { internal_id → bool }.
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})

  const siblings = useMemo(() => {
    const rows = q.data ?? []
    return rows
      .filter((m) => m.internal_id !== currentInternalId)
      .sort((a, b) => (b.date_received ?? '').localeCompare(a.date_received ?? ''))
  }, [q.data, currentInternalId])

  if (typeof threadId !== 'string' || threadId.length === 0) return null
  if (q.isLoading) {
    return (
      <section
        aria-label="thread-bundle"
        className="border border-ink-border-soft rounded-md bg-ink-3/40 px-3 py-2 text-aux text-ink-fg-2 animate-pulse"
      >
        {t('thread.loading')}
      </section>
    )
  }
  if (q.isError) {
    return (
      <section
        aria-label="thread-bundle"
        className="border border-fail/30 rounded-md bg-fail/10 px-3 py-2 text-aux text-fail"
      >
        {t('thread.loadFailed')}
      </section>
    )
  }
  if (siblings.length === 0) return null

  const allExpanded = siblings.every((s) => expanded[s.internal_id] === true)
  const toggleAll = (): void => {
    if (allExpanded) {
      setExpanded({})
    } else {
      const next: Record<number, boolean> = {}
      for (const s of siblings) next[s.internal_id] = true
      setExpanded(next)
    }
  }

  return (
    <section
      aria-label="thread-bundle"
      className="border border-ink-border-soft rounded-md bg-ink-2/40 overflow-hidden"
    >
      <header className="px-3 py-2 flex items-center gap-2 border-b border-ink-border-soft">
        <MessageSquare size={12} strokeWidth={2} className="text-ink-fg-2" />
        <span className="text-aux font-medium text-ink-fg-1">{t('thread.bundleTitle')}</span>
        <span className="text-meta font-mono text-ink-fg-3 tabular-nums">
          {t('thread.bundleSummary', { n: siblings.length })}
        </span>
        <button
          type="button"
          onClick={toggleAll}
          className={cn(
            'ml-auto text-meta text-ink-fg-2 px-2 py-0.5 rounded',
            'hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-coral/40'
          )}
        >
          {allExpanded ? t('thread.collapseAll') : t('thread.expandAll')}
        </button>
      </header>
      <div className="divide-y divide-ink-border-soft">
        {siblings.map((m) => (
          <ThreadItem
            key={m.internal_id}
            email={m}
            expanded={expanded[m.internal_id] === true}
            onToggle={() =>
              setExpanded((prev) => ({
                ...prev,
                [m.internal_id]: !(prev[m.internal_id] === true)
              }))
            }
          />
        ))}
      </div>
    </section>
  )
}
