// Sprint 12 — Inbox list pane per mockup-inbox.html lines 1430-2596.
// Sprint 12.5 adds:
//   • Focused / Other tab dual-bucket (focused = signal mail; other =
//     low-priority + auto-archive bucket).
//   • Filter popover with priority + category multi-select.
//   • Date group headers with click-to-collapse persistence.
//   • Pinned virtual group at the top (driven by usePinned localStorage).
//   • Infinite scroll — initial 100 rows, +100 each time the list nears
//     the end (react-window v2 onRowsRendered).
//   • Real batch mode (cb checkboxes via row + floating BatchActionBar).
//
// CSS classes (.inbox-tabs / .filter-pop / .group-header / .filter-option)
// live in index.css Sprint 12 block.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { List, type RowComponentProps } from 'react-window'
import { ChevronDown, Filter, ListChecks, Mail } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useActiveEmail } from '@shared/state/active-email'
import { useMailbox } from '@shared/state/mailbox'
import {
  ALL_CATEGORIES,
  ALL_PRIORITIES,
  useEmailFilter,
  type EmailCategory,
  type EmailFilter,
  type EmailView
} from '@shared/state/email-filter'
import { useGroupCollapse, type GroupKey } from '@shared/state/group-collapse'
import { useBatch } from '@shared/state/batch'
import { usePinned } from '@shared/state/pinned'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useEmailKeyboardNav } from '@shared/hooks/useEmailKeyboardNav'
import { useNewlyAddedIds } from '@shared/hooks/useNewlyAddedIds'
import { usePinnedSync } from '@shared/hooks/usePinnedSync'
import { cleanSnippet } from '@shared/lib/mail_parse'
import { actionLabelChinese } from '@shared/lib/ai_labels'
import type { AIPriority, EnrichedEmailMeta, ListOpts } from '@shared/api/types'

import { EmailRow } from './EmailRow'
import { BatchActionBar } from './BatchActionBar'

// ─── Row union ────────────────────────────────────────────────────────
//
// Sprint 14 round 9 — Outlook-style thread bundling.  Rows of type
// 'email' carry an optional `thread` block:
//   • isHead = true  → row is the most-recent message of a thread that
//     has ≥ 1 sibling; chevron prepended (rotates with expanded state),
//     clicking toggles the bundle.  childCount drives the "+N" hint.
//   • isHead = false → row is an older sibling.  Indented to the right.
// Rows without a `thread` block are solitary messages, rendered exactly
// like before round 9.
type ThreadRowInfo =
  | { isHead: true; threadId: string; childCount: number; expanded: boolean }
  | { isHead: false; threadId: string }

type ListRow =
  | { type: 'header'; key: GroupKey; label: string; count: number; collapsed: boolean }
  | {
      type: 'email'
      email: EnrichedEmailMeta
      groupKey: GroupKey
      thread?: ThreadRowInfo
    }
  | { type: 'loader' }

interface RowProps {
  rows: ReadonlyArray<ListRow>
  activeId: number | null
  newIds: ReadonlySet<number>
  onSelect(id: number): void
  onToggleGroup(key: GroupKey): void
  onToggleThread(threadId: string): void
}

function VirtualRow({
  index,
  style,
  rows,
  activeId,
  newIds,
  onSelect,
  onToggleGroup,
  onToggleThread
}: RowComponentProps<RowProps>): React.ReactElement {
  const item = rows[index]
  if (!item) return <div style={style} />
  if (item.type === 'loader') {
    return (
      <div style={style} className="px-4 py-3 text-center text-meta font-mono text-ink-fg-3">
        — loading more…
      </div>
    )
  }
  if (item.type === 'header') {
    return (
      <div style={style}>
        <header
          className="group-header"
          role="button"
          tabIndex={0}
          aria-expanded={!item.collapsed}
          onClick={() => onToggleGroup(item.key)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onToggleGroup(item.key)
            }
          }}
          data-collapsed={item.collapsed ? 'true' : 'false'}
        >
          <svg className="group-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {item.key === 'pinned' && (
            <svg className="group-pin-glyph" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 4v6.59l3.71 3.71A1 1 0 0 1 19 16h-6v5l-1 1-1-1v-5H5a1 1 0 0 1-.71-1.71L8 10.59V4a1 1 0 0 1-1-1V2h10v1a1 1 0 0 1-1 1z" />
            </svg>
          )}
          <span>{item.label}</span>
          <span className="group-count">{item.count}</span>
        </header>
      </div>
    )
  }
  const t = item.thread
  if (t && t.isHead) {
    // Thread head — prepend a chevron button outside EmailRow; clicking
    // toggles the bundle without triggering row selection.
    return (
      <div style={style} className="flex items-stretch">
        <button
          type="button"
          aria-label="toggle-thread"
          aria-expanded={t.expanded}
          onClick={(e) => {
            e.stopPropagation()
            onToggleThread(t.threadId)
          }}
          className={cn(
            'w-5 shrink-0 flex items-center justify-center',
            'text-ink-fg-2 hover:text-ink-fg',
            'transition-colors duration-fast'
          )}
        >
          <ChevronDown
            size={12}
            strokeWidth={2}
            className={cn(
              'transition-transform duration-base ease-out',
              t.expanded ? 'rotate-0' : '-rotate-90'
            )}
          />
        </button>
        <div className="flex-1 min-w-0">
          <EmailRow
            email={item.email}
            selected={item.email.internal_id === activeId}
            isNew={newIds.has(item.email.internal_id)}
            onSelect={() => onSelect(item.email.internal_id)}
          />
        </div>
      </div>
    )
  }
  if (t && !t.isHead) {
    // Thread child — indent under the head, no chevron.  The vertical
    // hairline gives a subtle visual tether to the head row.
    return (
      <div style={style} className="flex items-stretch bg-ink-1/30">
        <div className="w-5 shrink-0 flex justify-center">
          <span className="w-px bg-ink-border-soft" />
        </div>
        <div className="flex-1 min-w-0">
          <EmailRow
            email={item.email}
            selected={item.email.internal_id === activeId}
            isNew={newIds.has(item.email.internal_id)}
            onSelect={() => onSelect(item.email.internal_id)}
          />
        </div>
      </div>
    )
  }
  // Solitary message — original full-width row.
  return (
    <div style={style}>
      <EmailRow
        email={item.email}
        selected={item.email.internal_id === activeId}
        isNew={newIds.has(item.email.internal_id)}
        onSelect={() => onSelect(item.email.internal_id)}
      />
    </div>
  )
}

function rowHeight(index: number, { rows }: RowProps): number {
  const r = rows[index]
  if (!r) return 28
  if (r.type === 'header') return 28
  if (r.type === 'loader') return 44
  const e = r.email
  const snippetReal = cleanSnippet(e.snippet)
  const hasSnippet = Boolean(snippetReal)
  const hasAiStrip = Boolean(
    e.ai_priority ||
    actionLabelChinese(e.ai_action) ||
    e.sync_status === 'failed' ||
    e.sync_status === 'dead_letter'
  )
  if (hasSnippet && hasAiStrip) return 100
  if (hasSnippet) return 84
  if (hasAiStrip) return 78
  return 60
}

function applyChipFilter(
  filter: EmailFilter,
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

// Focused / Other split is purely priority-driven now — LLM CATEGORY_ENUM
// has no "low-signal" bucket, so we use `ai_priority === 'low'` as the
// authoritative signal. Rows without an LLM run (ai_priority === null) stay
// in Focused so newly-arrived mail never silently lands in Other.
function applyTab(
  tab: 'focused' | 'other',
  rows: ReadonlyArray<EnrichedEmailMeta>
): EnrichedEmailMeta[] {
  if (tab === 'other') return rows.filter((r) => r.ai_priority === 'low')
  return rows.filter((r) => r.ai_priority !== 'low')
}

/** Strict literal match against LLM CATEGORY_ENUM — `email.ai_category`
 *  is the verbatim emoji-prefixed Chinese label so `Set.has()` works. */
function categoryOf(e: EnrichedEmailMeta): EmailCategory | null {
  if (!e.ai_category) return null
  return e.ai_category as EmailCategory
}

function applyMultiFilter(
  rows: ReadonlyArray<EnrichedEmailMeta>,
  priorities: ReadonlySet<AIPriority>,
  categories: ReadonlySet<EmailCategory>
): EnrichedEmailMeta[] {
  const fullPri = priorities.size === ALL_PRIORITIES.length
  const fullCat = categories.size === ALL_CATEGORIES.length
  if (fullPri && fullCat) return rows.slice()
  return rows.filter((r) => {
    if (!fullPri) {
      if (r.ai_priority === null || !priorities.has(r.ai_priority)) return false
    }
    if (!fullCat) {
      // Unclassified rows (no LLM run yet) are kept regardless of category
      // selection — hiding them would make newly-arrived mail invisible
      // until the LLM catches up.
      const c = categoryOf(r)
      if (c !== null && !categories.has(c)) return false
    }
    return true
  })
}

// ─── Date-grouping ────────────────────────────────────────────────────
function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

// Sprint 14 round 9 — Outlook-style thread bundle.  Same-thread rows
// collapse into a single "head" plus N indented children.  The bundle
// is keyed by thread_id; emails without a thread_id (or whose thread
// only has one email in the current list) are treated as solitary.
interface ThreadGroup {
  threadId: string | null
  head: EnrichedEmailMeta
  children: EnrichedEmailMeta[]
}

function groupByThread(emails: ReadonlyArray<EnrichedEmailMeta>): ThreadGroup[] {
  const byTid = new Map<string, EnrichedEmailMeta[]>()
  const solo: ThreadGroup[] = []
  for (const e of emails) {
    if (e.thread_id) {
      const arr = byTid.get(e.thread_id) ?? []
      arr.push(e)
      byTid.set(e.thread_id, arr)
    } else {
      solo.push({ threadId: null, head: e, children: [] })
    }
  }
  const groups: ThreadGroup[] = []
  for (const [tid, arr] of byTid) {
    arr.sort((a, b) => (b.date_received ?? '').localeCompare(a.date_received ?? ''))
    if (arr.length === 1) {
      // Single-message thread is functionally solitary — no chevron.
      groups.push({ threadId: null, head: arr[0]!, children: [] })
    } else {
      groups.push({ threadId: tid, head: arr[0]!, children: arr.slice(1) })
    }
  }
  groups.push(...solo)
  // Stable ordering by head date_received DESC keeps day-bucketing
  // deterministic across re-renders.
  groups.sort((a, b) => (b.head.date_received ?? '').localeCompare(a.head.date_received ?? ''))
  return groups
}

function partitionByDate(
  groups: ReadonlyArray<ThreadGroup>,
  pinnedSet: ReadonlySet<number>
): Record<GroupKey, ThreadGroup[]> {
  const now = new Date()
  const today = startOfDay(now)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const dayMon = (today.getDay() + 6) % 7
  const weekStart = new Date(today)
  weekStart.setDate(today.getDate() - dayMon)
  const lastWeekStart = new Date(weekStart)
  lastWeekStart.setDate(weekStart.getDate() - 7)

  const buckets: Record<GroupKey, ThreadGroup[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    thisWeek: [],
    lastWeek: [],
    older: []
  }

  for (const g of groups) {
    if (pinnedSet.has(g.head.internal_id)) {
      buckets.pinned.push(g)
      continue
    }
    if (!g.head.date_received) {
      buckets.older.push(g)
      continue
    }
    const d = new Date(g.head.date_received)
    if (d >= today) buckets.today.push(g)
    else if (d >= yesterday) buckets.yesterday.push(g)
    else if (d >= weekStart) buckets.thisWeek.push(g)
    else if (d >= lastWeekStart) buckets.lastWeek.push(g)
    else buckets.older.push(g)
  }
  return buckets
}

function flattenGroups(
  buckets: Record<GroupKey, ThreadGroup[]>,
  labels: Record<GroupKey, string>,
  collapsedOf: (key: GroupKey) => boolean,
  threadCollapsed: ReadonlySet<string>,
  appendLoader: boolean
): ListRow[] {
  const order: GroupKey[] = ['pinned', 'today', 'yesterday', 'thisWeek', 'lastWeek', 'older']
  const out: ListRow[] = []
  for (const key of order) {
    const groupArr = buckets[key]
    if (groupArr.length === 0) continue
    const collapsed = collapsedOf(key)
    // Group count = total messages (head + children across all threads)
    // so the header shows the human-truthful number, not the bundle count.
    const total = groupArr.reduce((acc, g) => acc + 1 + g.children.length, 0)
    out.push({
      type: 'header',
      key,
      label: labels[key],
      count: total,
      collapsed
    })
    if (collapsed) continue
    for (const g of groupArr) {
      const isThreadHead = g.threadId !== null && g.children.length > 0
      const expanded = isThreadHead ? !threadCollapsed.has(g.threadId!) : false
      out.push({
        type: 'email',
        email: g.head,
        groupKey: key,
        thread: isThreadHead
          ? {
              isHead: true,
              threadId: g.threadId!,
              childCount: g.children.length,
              expanded
            }
          : undefined
      })
      if (isThreadHead && expanded) {
        for (const child of g.children) {
          out.push({
            type: 'email',
            email: child,
            groupKey: key,
            thread: { isHead: false, threadId: g.threadId! }
          })
        }
      }
    }
  }
  if (appendLoader) out.push({ type: 'loader' })
  return out
}

// ─── List query opts per Sidebar view ────────────────────────────────
function listOptsForView(view: EmailView, limit: number): ListOpts {
  if (view === 'inbox') return { mailbox: '收件箱', limit }
  if (view === 'outbox') return { mailbox: '发件箱', limit }
  if (view === 'flagged') return { isFlagged: true, limit }
  return { limit }
}

const PAGE_SIZE = 100
const MAX_PAGES = 30 // safety cap — 3000 rows is enough for visual scrolling

export function EmailList(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const activeMailbox = useMailbox((s) => s.active)
  const activeId = useActiveEmail((s) => s.activeInternalId)
  const setActive = useActiveEmail((s) => s.setActive)
  const filter = useEmailFilter((s) => s.filter)
  const setFilter = useEmailFilter((s) => s.setFilter)
  const view = useEmailFilter((s) => s.view)
  const tab = useEmailFilter((s) => s.tab)
  const setTab = useEmailFilter((s) => s.setTab)
  const selectedPriorities = useEmailFilter((s) => s.selectedPriorities)
  const selectedCategories = useEmailFilter((s) => s.selectedCategories)
  const togglePriority = useEmailFilter((s) => s.togglePriority)
  const toggleCategory = useEmailFilter((s) => s.toggleCategory)
  const setPriorities = useEmailFilter((s) => s.setPriorities)
  const setCategories = useEmailFilter((s) => s.setCategories)
  const allPrioritiesSelected = useEmailFilter((s) => s.allPrioritiesSelected)
  const allCategoriesSelected = useEmailFilter((s) => s.allCategoriesSelected)
  const resetAll = useEmailFilter((s) => s.resetAll)

  // Subscribe to the `collapsed` map itself (not the `isCollapsed` accessor
  // function — the function reference is stable across `toggle()` calls so
  // useMemo dependants would never re-flatten on a click).
  const collapsedMap = useGroupCollapse((s) => s.collapsed)
  const toggleGroup = useGroupCollapse((s) => s.toggle)
  const isCollapsed = useCallback(
    (k: GroupKey): boolean => collapsedMap[k] === true,
    [collapsedMap]
  )
  // Keep `usePinned` mirror in sync with the SQLite-backed pinned list.
  // Mount-side IPC poll (10s) + invalidation after togglePin — no
  // localStorage path; switching machines / windows reconciles.
  usePinnedSync()
  const pinnedList = usePinned((s) => s.pinned)
  const pinnedSet = useMemo(() => new Set<number>(pinnedList), [pinnedList])

  const batchMode = useBatch((s) => s.mode)
  const enterBatch = useBatch((s) => s.enter)
  const exitBatch = useBatch((s) => s.exit)

  const [filterOpen, setFilterOpen] = useState(false)
  const [pageCount, setPageCount] = useState(1)
  // React 19 "Adjusting state on prop change" pattern — paging resets on
  // view transition without scheduling an effect (see EmailDetail.tsx for
  // the same pattern).
  const [lastView, setLastView] = useState(view)
  if (lastView !== view) {
    setLastView(view)
    setPageCount(1)
  }
  // Sprint 12.6 user-feedback — outside-click previously checked the whole
  // header container, which meant clicking on the inbox tabs / batch button
  // inside the header kept the popover open. We now scope the "inside"
  // check to just the popover + its trigger button, so clicking anywhere
  // else (header whitespace, list rows, status bar, …) closes it.
  const filterTriggerRef = useRef<HTMLButtonElement>(null)
  const filterPopoverRef = useRef<HTMLDivElement>(null)

  // Outside-click + Esc → close filter popover
  useEffect(() => {
    if (!filterOpen) return
    function onClickAway(ev: MouseEvent): void {
      const target = ev.target as Node | null
      if (!target) return
      if (filterPopoverRef.current?.contains(target)) return
      if (filterTriggerRef.current?.contains(target)) return
      setFilterOpen(false)
    }
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') setFilterOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClickAway)
      document.removeEventListener('keydown', onKey)
    }
  }, [filterOpen])

  // Sprint 12.5 — pageCount drives the LIMIT clause; offset=0 because the
  // backend sorts by date_received DESC and we re-fetch the full window.
  // SQLite read is ~4ms per page so re-querying is cheaper than maintaining
  // a useInfiniteQuery cursor chain in the renderer.
  const fetchLimit = Math.min(pageCount * PAGE_SIZE, MAX_PAGES * PAGE_SIZE)
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['emails', view, activeMailbox, fetchLimit],
    queryFn: () => mailApi.email.listEnriched(listOptsForView(view, fetchLimit)),
    refetchInterval: 5000,
    refetchIntervalInBackground: false
  })

  const all = useMemo(() => data ?? [], [data])
  const tabFiltered = useMemo(() => applyTab(tab, all), [tab, all])
  const chipFiltered = useMemo(() => applyChipFilter(filter, tabFiltered), [filter, tabFiltered])
  const filtered = useMemo(
    () => applyMultiFilter(chipFiltered, selectedPriorities, selectedCategories),
    [chipFiltered, selectedPriorities, selectedCategories]
  )
  const orderedIds = useMemo(() => filtered.map((r) => r.internal_id), [filtered])

  // Limit useNewlyAddedIds to the first page so paginated reads don't make
  // the entire newly-loaded slab flash "NEW".
  const firstPageIds = useMemo(() => allIdsFirstPage(all), [all])
  const newIds = useNewlyAddedIds(firstPageIds)

  const firstId = orderedIds[0]
  if (
    firstId !== undefined &&
    (activeId === null || !orderedIds.includes(activeId)) &&
    activeId !== firstId
  ) {
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

  // Per-category live count (for the filter popover hint).
  const categoryCounts = useMemo(() => {
    const out: Record<EmailCategory, number> = {
      '💼 产品管理': 0,
      '🤝 会议通知': 0,
      '🛠️ 技术讨论': 0,
      '👥 团队协作': 0,
      '📊 项目管理': 0,
      '🔔 系统通知': 0,
      '🌐 外部沟通': 0
    }
    for (const e of all) {
      const c = categoryOf(e)
      if (c !== null) out[c] += 1
    }
    return out
  }, [all])
  const priorityCounts = useMemo(() => {
    const out: Record<AIPriority, number> = {
      critical: 0,
      urgent: 0,
      important: 0,
      normal: 0,
      low: 0
    }
    for (const e of all) if (e.ai_priority) out[e.ai_priority] += 1
    return out
  }, [all])

  const groupLabels: Record<GroupKey, string> = useMemo(
    () => ({
      pinned: t('emailList.group.pinned'),
      today: t('emailList.group.today'),
      yesterday: t('emailList.group.yesterday'),
      thisWeek: t('emailList.group.thisWeek'),
      lastWeek: t('emailList.group.lastWeek'),
      older: t('emailList.group.older')
    }),
    [t]
  )

  // Sprint 14 round 9 — thread bundling. Same thread_id rows roll up
  // under their newest message; the user toggles each bundle with the
  // prepended chevron.  Default = expanded (Outlook behaviour); only
  // explicit user clicks add an entry to `threadCollapsed`.
  const [threadCollapsed, setThreadCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleThread = useCallback((threadId: string) => {
    setThreadCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(threadId)) next.delete(threadId)
      else next.add(threadId)
      return next
    })
  }, [])

  const threadGroups = useMemo(() => groupByThread(filtered), [filtered])
  const buckets = useMemo(() => partitionByDate(threadGroups, pinnedSet), [threadGroups, pinnedSet])

  // Show the loader sentinel when we still have headroom (no end-of-data
  // signal from this query shape — we stop the loader if a fetch returned
  // less than the requested limit, meaning there are no more rows).
  const reachedEnd = all.length < fetchLimit
  const showLoader = !reachedEnd && pageCount < MAX_PAGES

  const rows = useMemo(
    () => flattenGroups(buckets, groupLabels, isCollapsed, threadCollapsed, showLoader),
    [buckets, groupLabels, isCollapsed, threadCollapsed, showLoader]
  )

  const priActive = !allPrioritiesSelected()
  const catActive = !allCategoriesSelected()
  const filterActive = filter !== 'all' || priActive || catActive

  const handleRowsRendered = useCallback(
    (range: { stopIndex: number }) => {
      // Load next page when we're within 8 rows of the rendered bottom.
      if (range.stopIndex >= rows.length - 8 && showLoader) {
        setPageCount((c) => Math.min(c + 1, MAX_PAGES))
      }
    },
    [rows.length, showLoader]
  )

  const visibleIds = useMemo(() => orderedIds, [orderedIds])

  return (
    <section
      aria-label="email-list"
      className="w-[340px] shrink-0 glass-2 border-r border-ink-border flex flex-col min-h-0"
    >
      {/* Header — Focused/Other tabs · batch + filter cluster · meta line */}
      <div className="relative px-3 pt-3 pb-2.5 border-b border-ink-border-soft">
        <div className="flex items-center justify-between gap-2">
          <div className="inbox-tabs" role="tablist" aria-label={t('list.tab.aria')}>
            <button
              type="button"
              className={tab === 'focused' ? 'inbox-tab is-active' : 'inbox-tab'}
              role="tab"
              aria-selected={tab === 'focused'}
              onClick={() => setTab('focused')}
            >
              {t('list.tab.focused')}
            </button>
            <button
              type="button"
              className={tab === 'other' ? 'inbox-tab is-active' : 'inbox-tab'}
              role="tab"
              aria-selected={tab === 'other'}
              onClick={() => setTab('other')}
            >
              {t('list.tab.other')}
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={
                batchMode === 'on'
                  ? 'w-7 h-7 rounded-md text-coral bg-coral/10 flex items-center justify-center transition-colors duration-fast'
                  : 'w-7 h-7 rounded-md text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 flex items-center justify-center transition-colors duration-fast'
              }
              title={batchMode === 'on' ? t('list.batch.exit') : t('list.batch.enter')}
              aria-label={batchMode === 'on' ? t('list.batch.exit') : t('list.batch.enter')}
              aria-pressed={batchMode === 'on'}
              onClick={() => (batchMode === 'on' ? exitBatch() : enterBatch())}
            >
              <ListChecks size={13} strokeWidth={2} />
            </button>
            <button
              ref={filterTriggerRef}
              type="button"
              className="filter-btn w-7 h-7 rounded-md text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 flex items-center justify-center transition-colors duration-fast"
              title={t('list.filter.button')}
              aria-label={t('list.filter.button')}
              aria-haspopup="true"
              aria-expanded={filterOpen}
              aria-controls="filter-pop"
              data-active={filterActive ? 'true' : 'false'}
              onClick={() => setFilterOpen((o) => !o)}
            >
              <Filter size={13} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-1.5 text-meta font-mono text-ink-fg-2">
          <span className="tabular-nums">
            {counts.unread} {t('list.meta.unread')}
          </span>
          <span className="text-ink-fg-3">·</span>
          <span className="tabular-nums">
            {t('list.meta.total')} {counts.all}
          </span>
          {filterActive && (
            <>
              <span className="text-ink-fg-3">·</span>
              <button
                type="button"
                className="text-coral hover:text-coral-hover transition-colors duration-fast"
                onClick={() => {
                  resetAll()
                  setFilter('all')
                }}
              >
                {t('list.filter.reset')}
              </button>
            </>
          )}
        </div>

        {filterOpen && (
          <div
            ref={filterPopoverRef}
            id="filter-pop"
            className="filter-pop"
            role="dialog"
            aria-label={t('list.filter.button')}
          >
            <FilterSection
              title={t('list.filter.status')}
              onSelectAll={() => setFilter('all')}
              onClear={() => setFilter('all')}
            >
              {(['all', 'unread', 'flagged', 'failed'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className="filter-option"
                  data-checked={filter === opt ? 'true' : 'false'}
                  onClick={() => setFilter(opt)}
                >
                  <span className="cb-mini" aria-hidden />
                  <span className="label">
                    {opt === 'all' ? t('list.filter.all') : t(`emailList.filter.${opt}`)}
                  </span>
                  <span className="count tabular-nums">
                    {opt === 'all' ? counts.all : counts[opt]}
                  </span>
                </button>
              ))}
            </FilterSection>

            <FilterSection
              title={t('list.filter.priority')}
              onSelectAll={() => setPriorities(new Set(ALL_PRIORITIES))}
              onClear={() => setPriorities(new Set())}
            >
              {ALL_PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="filter-option"
                  data-checked={selectedPriorities.has(p) ? 'true' : 'false'}
                  onClick={() => togglePriority(p)}
                >
                  <span className="cb-mini" aria-hidden />
                  <span className={`pri-dot ${priDotClass(p)}`} aria-hidden />
                  <span className="label">{capitalize(p)}</span>
                  <span className="count tabular-nums">{priorityCounts[p]}</span>
                </button>
              ))}
            </FilterSection>

            <FilterSection
              title={t('list.filter.category')}
              onSelectAll={() => setCategories(new Set(ALL_CATEGORIES))}
              onClear={() => setCategories(new Set())}
            >
              {ALL_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="filter-option"
                  data-checked={selectedCategories.has(c) ? 'true' : 'false'}
                  onClick={() => toggleCategory(c)}
                >
                  <span className="cb-mini" aria-hidden />
                  {/* LLM CATEGORY_ENUM is emoji-prefixed Chinese; we render
                      the verbatim string so the popover matches what the
                      backend stores. Future EN locale would translate the
                      tail of the string, not the leading emoji. */}
                  <span className="label">{c}</span>
                  <span className="count tabular-nums">{categoryCounts[c]}</span>
                </button>
              ))}
            </FilterSection>
          </div>
        )}
      </div>

      {/* Sprint 12.6 — removed the "N 封新邮件 · 点击查看" CTA pill. The
          list already auto-refreshes every 5s (refetchInterval), so newly
          arrived mail surfaces at the top without any click. The row-level
          NEW chip (driven by useNewlyAddedIds) still flashes for 2s as a
          visual "just-arrived" cue. */}

      <div className="flex-1 min-h-0">
        {isLoading && <div className="p-6 text-aux text-ink-fg-2 animate-pulse">Loading…</div>}
        {isError && (
          <div className="p-6 text-aux text-fail">
            {error instanceof Error ? error.message : String(error)}
          </div>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <div className="px-6 py-12 text-center text-aux text-ink-fg-2">
            <Mail size={20} strokeWidth={1.5} className="inline-block opacity-30 mb-2" />
            <div>{t('empty.state')}</div>
          </div>
        )}
        {!isLoading && !isError && rows.length > 0 && (
          <List<RowProps>
            rowComponent={VirtualRow}
            rowCount={rows.length}
            rowHeight={rowHeight}
            rowProps={{
              rows,
              activeId,
              newIds,
              onSelect: setActive,
              onToggleGroup: toggleGroup,
              onToggleThread: toggleThread
            }}
            onRowsRendered={handleRowsRendered}
            className="scrollbar-thin"
            style={{ height: '100%' }}
          />
        )}
      </div>

      <BatchActionBar visibleIds={visibleIds} />
    </section>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────
function allIdsFirstPage(all: ReadonlyArray<EnrichedEmailMeta>): number[] {
  // Slice the first PAGE_SIZE ids so paginated load-more doesn't flicker
  // every later row as "newly arrived" (useNewlyAddedIds diffs the array
  // by membership; appended ids would all read as new).
  return all.slice(0, PAGE_SIZE).map((r) => r.internal_id)
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Priority dot uses the same Tailwind tokens as the EmailRow .pdot states.
// No raw hex — DESIGN.md §14 #1 routes every chip colour through the
// `--c-{crit,urg,impt,norm,low}` variables exposed in index.css.
const PRIORITY_DOT_CLASS: Record<AIPriority, string> = {
  critical: 'bg-crit',
  urgent: 'bg-urg',
  important: 'bg-impt',
  normal: 'bg-norm',
  low: 'bg-low'
}
function priDotClass(p: AIPriority): string {
  return PRIORITY_DOT_CLASS[p]
}

function FilterSection({
  title,
  onSelectAll,
  onClear,
  children
}: {
  title: string
  onSelectAll: () => void
  onClear: () => void
  children: React.ReactNode
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="filter-section">
      <div className="filter-section-head">
        <span>{title}</span>
        <span className="links">
          <button type="button" onClick={onSelectAll}>
            {t('list.filter.selectAll')}
          </button>
          <button type="button" onClick={onClear}>
            {t('list.filter.clearLink')}
          </button>
        </span>
      </div>
      {children}
    </div>
  )
}
