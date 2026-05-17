// DESIGN.md §3.3 / §5 — 340px list column. Three jobs:
//   1. Render the email rows (react-window v2 virtualization for 100-row windows).
//   2. Top filter strip — "全部 / 未读 / 已标 / 失败" chips (DESIGN.md §3 left rail).
//   3. 5s polling (TanStack Query refetchInterval) with NEW-badge diff —
//      `new ids` are highlighted for 2 seconds after the poll surfaces them.
//
// The list does NOT own the active selection; it reads `useActiveEmail` and
// auto-selects the first row when stale state lands on an id no longer in
// the freshly-loaded list (the same recovery logic pickNext/pickPrev encode).

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { List, type RowComponentProps } from 'react-window'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { useActiveEmail } from '@shared/state/active-email'
import { useMailbox } from '@shared/state/mailbox'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useEmailKeyboardNav } from '@shared/hooks/useEmailKeyboardNav'
import { useNewlyAddedIds } from '@shared/hooks/useNewlyAddedIds'
import type { EnrichedEmailMeta } from '@shared/api/types'

import { EmailRow } from './EmailRow'

type FilterId = 'all' | 'unread' | 'flagged' | 'failed'

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
  // py-3 (24) + sender line (20) + subject line (20) + chips line (mt-2 + 18 = 26).
  // Snippet line: line-clamp-1 (20) + mt-0.5 (2).
  const e = emails[index]
  return e?.snippet ? 112 : 90
}

const FILTER_LABELS: Record<FilterId, string> = {
  all: 'All',
  unread: 'Unread',
  flagged: 'Flagged',
  failed: 'Failed'
}

function applyFilter(
  filter: FilterId,
  rows: ReadonlyArray<EnrichedEmailMeta>
): EnrichedEmailMeta[] {
  switch (filter) {
    case 'all':
      return rows.slice()
    case 'unread':
      return rows.filter((r) => !r.is_read)
    case 'flagged':
      return rows.filter((r) => r.is_flagged)
    case 'failed':
      return rows.filter((r) => r.sync_status === 'failed' || r.sync_status === 'dead_letter')
  }
}

export function EmailList(): React.ReactElement {
  const { t } = useTranslation()
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

  // NEW-badge tracking lives in a dedicated hook so the effect-body setState
  // (intentional here — fade is a discrete UX event, not derived state) is
  // isolated to one file with the rationale.
  const allIds = useMemo(() => all.map((r) => r.internal_id), [all])
  const newIds = useNewlyAddedIds(allIds)

  // Stale-id recovery: when mailbox changes the persisted activeId may no
  // longer exist in the freshly-loaded list. Fall to the first visible row
  // so EmailDetail always has a target.
  useEffect(() => {
    if (orderedIds.length === 0) return
    if (activeId === null || !orderedIds.includes(activeId)) {
      setActive(orderedIds[0])
    }
  }, [orderedIds, activeId, setActive])

  // J/K navigation reads the live ordered ids.
  useEmailKeyboardNav(orderedIds)

  const counts: Record<FilterId, number> = useMemo(
    () => ({
      all: all.length,
      unread: all.filter((r) => !r.is_read).length,
      flagged: all.filter((r) => r.is_flagged).length,
      failed: all.filter((r) => r.sync_status === 'failed' || r.sync_status === 'dead_letter')
        .length
    }),
    [all]
  )

  return (
    <section
      aria-label="email-list"
      className="w-[340px] shrink-0 border-r border-ink-border bg-ink-1 flex flex-col min-h-0"
    >
      {/* Column header: mailbox name + count strip + filter chips */}
      <header className="px-4 pt-4 pb-2 border-b border-ink-border-soft">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lead font-semibold text-ink-fg truncate">{mailbox}</h2>
          <span className="text-meta font-mono text-ink-fg-3 tabular-nums">
            {filtered.length}/{all.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-3" role="tablist" aria-label="filter">
          {(['all', 'unread', 'flagged', 'failed'] as FilterId[]).map((id) => {
            const active = id === filter
            return (
              <button
                key={id}
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(id)}
                className={cn(
                  'text-micro font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border',
                  'transition-colors duration-fast',
                  active
                    ? 'text-coral bg-coral/15 border-coral/30'
                    : 'text-ink-fg-2 border-ink-border hover:bg-ink-2'
                )}
              >
                {FILTER_LABELS[id]}
                <span className="ml-1 text-ink-fg-3 tabular-nums">{counts[id]}</span>
              </button>
            )
          })}
        </div>
      </header>

      {/* Body: react-window list or empty/error state */}
      <div className="flex-1 min-h-0">
        {isLoading && (
          <div className="p-6 text-aux text-ink-fg-2">
            <span className="animate-pulse">Loading…</span>
          </div>
        )}
        {isError && (
          <div className="p-6 text-aux text-fail">
            {error instanceof Error ? error.message : String(error)}
          </div>
        )}
        {!isLoading && !isError && filtered.length === 0 && (
          <div className="p-6 text-aux text-ink-fg-2">{t('empty.state')}</div>
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
            style={{ height: '100%' }}
          />
        )}
      </div>
    </section>
  )
}
