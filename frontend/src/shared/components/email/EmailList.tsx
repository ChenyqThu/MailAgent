// 340px middle column · mockup-inbox.html line 566+. Layout:
//   - bg-ink-2 (one tier brighter than sidebar/titlebar bg-ink-1)
//   - Header: mailbox H1 (text-lead font-semibold) + selection/unread/total
//     counts strip + filter chips row with icons
//   - "N 封新邮件" CTA pill below header when poll surfaces new ids
//   - Virtualized rows via react-window v2 with per-row variable height

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { List, type RowComponentProps } from 'react-window'
import { ChevronDown, MailQuestion, Paperclip, Star } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useActiveEmail } from '@shared/state/active-email'
import { useMailbox } from '@shared/state/mailbox'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useEmailKeyboardNav } from '@shared/hooks/useEmailKeyboardNav'
import { useNewlyAddedIds } from '@shared/hooks/useNewlyAddedIds'
import type { EnrichedEmailMeta } from '@shared/api/types'

import { EmailRow } from './EmailRow'

type FilterId = 'unread' | 'flagged' | 'failed' | 'all'

interface RowProps {
  emails: ReadonlyArray<EnrichedEmailMeta>
  activeId: number | null
  newIds: ReadonlySet<number>
  onSelect(id: number): void
}

function VirtualRow({
  index,
  style,
  emails,
  activeId,
  newIds,
  onSelect
}: RowComponentProps<RowProps>): React.ReactElement {
  const email = emails[index]
  return (
    <div style={style}>
      <EmailRow
        email={email}
        selected={email.internal_id === activeId}
        isNew={newIds.has(email.internal_id)}
        onSelect={() => onSelect(email.internal_id)}
      />
    </div>
  )
}

function rowHeight(index: number, { emails }: RowProps): number {
  // py-3 (24) + sender (20) + subject (20) + chips (mt-2 = 26) = 90
  // + snippet (line-clamp-1 = 20 + mt-0.5 = 2) = 112
  const e = emails[index]
  return e?.snippet ? 112 : 90
}

function applyFilter(
  filter: FilterId,
  rows: ReadonlyArray<EnrichedEmailMeta>
): EnrichedEmailMeta[] {
  switch (filter) {
    case 'unread':
      return rows.filter((r) => !r.is_read)
    case 'flagged':
      return rows.filter((r) => r.is_flagged)
    case 'failed':
      return rows.filter((r) => r.sync_status === 'failed' || r.sync_status === 'dead_letter')
    case 'all':
    default:
      return rows.slice()
  }
}

interface FilterChipProps {
  active: boolean
  icon: React.ReactNode
  label: string
  count: number
  onClick(): void
}

function FilterChip({ active, icon, label, count, onClick }: FilterChipProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded border text-aux transition-colors duration-fast',
        active
          ? 'text-coral bg-coral/15 border-coral/30 hover:bg-coral/20'
          : 'text-ink-fg-1 border-transparent hover:text-ink-fg hover:bg-ink-3'
      )}
    >
      <span className="shrink-0 grid place-items-center w-3 h-3">{icon}</span>
      <span>{label}</span>
      <span
        className={cn(
          'text-meta font-mono tabular-nums ml-0.5',
          active ? 'text-coral' : 'text-ink-fg-3'
        )}
      >
        {count}
      </span>
    </button>
  )
}

export function EmailList(): React.ReactElement {
  const mailApi = useMailApi()
  const mailbox = useMailbox((s) => s.active)
  const activeId = useActiveEmail((s) => s.activeInternalId)
  const setActive = useActiveEmail((s) => s.setActive)
  const [filter, setFilter] = useState<FilterId>('all')

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['emails', mailbox],
    queryFn: () => mailApi.email.listEnriched({ mailbox, limit: 100 }),
    refetchInterval: 5000,
    refetchIntervalInBackground: false
  })

  const all = useMemo(() => data ?? [], [data])
  const filtered = useMemo(() => applyFilter(filter, all), [filter, all])
  const orderedIds = useMemo(() => filtered.map((r) => r.internal_id), [filtered])

  const allIds = useMemo(() => all.map((r) => r.internal_id), [all])
  const newIds = useNewlyAddedIds(allIds)

  // Stale-id recovery (mailbox switch).
  const firstId = orderedIds[0]
  if (
    firstId !== undefined &&
    (activeId === null || !orderedIds.includes(activeId)) &&
    activeId !== firstId
  ) {
    // queueMicrotask defers the setActive past current render so we don't
    // trigger the "setState in render" warning.
    queueMicrotask(() => setActive(firstId))
  }

  useEmailKeyboardNav(orderedIds)

  const counts = useMemo(() => {
    let unread = 0
    let flagged = 0
    let failed = 0
    for (const r of all) {
      if (!r.is_read) unread++
      if (r.is_flagged) flagged++
      if (r.sync_status === 'failed' || r.sync_status === 'dead_letter') failed++
    }
    return { all: all.length, unread, flagged, failed }
  }, [all])

  const newCount = newIds.size

  return (
    <section
      aria-label="email-list"
      className="w-[340px] shrink-0 bg-ink-2 border-r border-ink-border flex flex-col min-h-0"
    >
      {/* Header */}
      <header className="px-4 pt-3 pb-2.5 border-b border-ink-border-soft">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lead font-semibold text-ink-fg tracking-tight">{mailbox}</h1>
          <span className="text-meta font-mono text-ink-fg-2 tabular-nums">
            {counts.unread} unread · {counts.all} total
          </span>
        </div>
        <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
          <FilterChip
            active={filter === 'unread'}
            icon={<span className="w-1.5 h-1.5 rounded-full bg-coral/100" />}
            label="Unread"
            count={counts.unread}
            onClick={() => setFilter(filter === 'unread' ? 'all' : 'unread')}
          />
          <FilterChip
            active={filter === 'flagged'}
            icon={<Star size={11} strokeWidth={2} className="text-current" />}
            label="Flagged"
            count={counts.flagged}
            onClick={() => setFilter(filter === 'flagged' ? 'all' : 'flagged')}
          />
          <FilterChip
            active={filter === 'failed'}
            icon={<MailQuestion size={11} strokeWidth={2} className="text-current" />}
            label="Failed"
            count={counts.failed}
            onClick={() => setFilter(filter === 'failed' ? 'all' : 'failed')}
          />

          <button
            type="button"
            disabled
            title="Sort (Sprint 3)"
            className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-aux text-ink-fg-1 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Latest
            <ChevronDown size={10} strokeWidth={2.5} />
          </button>
        </div>
      </header>

      {/* "N 封新邮件" CTA pill — shows when poll surfaces new ids */}
      {newCount > 0 && (
        <button
          type="button"
          className="mx-3 mt-2 px-3 py-2 rounded-md bg-ink-3 border border-ink-border hover:border-coral/40 text-ink-fg text-aux font-medium flex items-center justify-center gap-2 transition-colors duration-fast"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-coral/100 dot-pulse" />
          {newCount} 封新邮件 · 点击查看
        </button>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0">
        {isLoading && <div className="p-6 text-aux text-ink-fg-2 animate-pulse">Loading…</div>}
        {isError && (
          <div className="p-6 text-aux text-fail">
            {error instanceof Error ? error.message : String(error)}
          </div>
        )}
        {!isLoading && !isError && filtered.length === 0 && (
          <div className="px-6 py-12 text-center text-aux text-ink-fg-2">
            <Paperclip size={20} strokeWidth={1.5} className="inline-block opacity-30 mb-2" />
            <div>没有可显示的内容</div>
          </div>
        )}
        {!isLoading && !isError && filtered.length > 0 && (
          <List<RowProps>
            rowComponent={VirtualRow}
            rowCount={filtered.length}
            rowHeight={rowHeight}
            rowProps={{
              emails: filtered,
              activeId,
              newIds,
              onSelect: setActive
            }}
            className="scrollbar-thin"
            style={{ height: '100%' }}
          />
        )}
      </div>
    </section>
  )
}
