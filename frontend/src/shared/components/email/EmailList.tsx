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

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window'
import { ChevronRight, Filter, Folder, ListChecks, Mail } from 'lucide-react'

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
import { useThreadExpand } from '@shared/state/thread-expand'
import { useBatch } from '@shared/state/batch'
import { usePinned } from '@shared/state/pinned'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useEmailKeyboardNav } from '@shared/hooks/useEmailKeyboardNav'
import { useInboxActionShortcuts } from '@shared/hooks/useInboxActionShortcuts'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useNewlyAddedIds } from '@shared/hooks/useNewlyAddedIds'
import { usePinnedSync } from '@shared/hooks/usePinnedSync'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { actionLabelChinese } from '@shared/lib/ai_labels'
import { cn } from '@shared/lib/cn'
import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import type { AIPriority, EmailMeta, EnrichedEmailMeta, ListOpts } from '@shared/api/types'

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
      /** Sprint 14 round 11 — true when the active email is part of
       *  this row's thread bundle (head + every child).  Drives both
       *  the wrapper selected wash and the coral accent bar so the
       *  whole bundle reads as one selection unit. */
      bundleSelected: boolean
    }
  | { type: 'loader' }

interface RowProps {
  rows: ReadonlyArray<ListRow>
  activeId: number | null
  newIds: ReadonlySet<number>
  /** Sprint 19 — 懒取的正文 snippet (internal_id → 前 100 字)。listEnriched 不再
   *  读 body blob, 这里按可见行填充; VirtualRow 合并进 email.snippet 渲染预览。 */
  snippets: Record<number, string>
  onSelect(id: number): void
  onToggleGroup(key: GroupKey): void
  onToggleThread(threadId: string): void
  onExpandThread(threadId: string, headInternalId: number): void
}

function VirtualRow({
  index,
  style,
  rows,
  // activeId is folded into `item.bundleSelected` at flatten time so the
  // row component itself only needs the rest.  The prop stays in
  // RowProps so the List parent re-renders rows when active changes.
  newIds,
  snippets,
  onSelect,
  onToggleGroup,
  onToggleThread,
  onExpandThread
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
  // Sprint 17 — thread chevron 从外层 div 移到 EmailRow grid 第一格 (.email-row
  // > .thread-chevron-cell). flag / done / selected wash + 未读 dot 现在共享同
  // 一个 article 容器, 染色和定位能 cover chevron 区域. data-thread='head|child|
  // none' 在 EmailRow article 上, CSS 据此渲染竖向 tether 线 (child).
  const t = item.thread
  const isHead = t?.isHead === true
  const isChild = t !== undefined && !t.isHead
  const threadChevron = t
    ? {
        isHead,
        isChild,
        // 仅 head 行有 expanded 字段; child 不渲染 chevron 所以 false 即可
        expanded: t.isHead ? t.expanded : false,
        // chevron = 切换 (手风琴): 展开态点击 → 仅折叠 (头不动, 无需滚动锚定);
        // 折叠态点击 → 展开本线程 + 选中母邮件 (onExpandThread 内部做滚动锚定).
        onToggle: isHead
          ? () => {
              if (t.expanded) {
                onToggleThread(t.threadId)
              } else {
                onExpandThread(t.threadId, item.email.internal_id)
                onSelect(item.email.internal_id)
              }
            }
          : undefined
      }
    : undefined
  // 点击母邮件行体 = 加载详情 + 强制展开本线程 (手风琴: 折叠其它已展开线程).
  // 行体点击只会展开, 不会折叠已展开的本线程 (收起须点 chevron). 子邮件 / 单封仅选中.
  const handleSelect =
    isHead && t
      ? () => {
          onSelect(item.email.internal_id)
          onExpandThread(t.threadId, item.email.internal_id)
        }
      : () => onSelect(item.email.internal_id)
  // Sprint 19 — 合并懒取的 snippet。仅当原 email 无 snippet 且 map 有值时新建对象,
  // 否则复用原引用 (EmailRow memo 按字段比较, snippet 变化才重渲该行)。
  const liveSnippet = snippets[item.email.internal_id]
  const emailForRow =
    liveSnippet && !item.email.snippet ? { ...item.email, snippet: liveSnippet } : item.email
  return (
    <div style={style}>
      <EmailRow
        email={emailForRow}
        selected={item.bundleSelected}
        isNew={newIds.has(item.email.internal_id)}
        noAvatar={isChild}
        threadChevron={threadChevron}
        onSelect={handleSelect}
      />
    </div>
  )
}

function computeRowHeight(r: ListRow | undefined, newIds: ReadonlySet<number>): number {
  if (!r) return 28
  if (r.type === 'header') return 28
  if (r.type === 'loader') return 44
  // Sprint 14 round 16 — thread children no longer forced into a
  // compact 60px row; they pick their height from the same snippet +
  // AI strip rules as heads / solitary rows.  Visible-set children
  // (listEnriched) carry full enriched fields and get the long layout;
  // supplement-only children (listByThread, no snippet / AI) fall
  // through to the 60px no-snippet branch naturally.
  const e = r.email
  // Sprint 19 — 行高用 has_body (listEnriched 立即返回) 而非 snippet 文本。
  // snippet 改为可见行懒取 (email:listSnippets); 若按文本算高, snippet 异步到达
  // 会让行高跳变。has_body 立即预留预览行空间, 文本填入不改高度。
  const hasSnippet = e.has_body
  // `isNew` flips ai-strip on (renders "NEW" chip in EmailRow). Must mirror
  // EmailRow.tsx aiStripVisible exactly — otherwise the slot under-counts and
  // the chip clips into the next row's separator.
  const hasAiStrip = Boolean(
    e.ai_priority ||
    actionLabelChinese(e.ai_action) ||
    e.sync_status === 'failed' ||
    e.sync_status === 'dead_letter' ||
    newIds.has(e.internal_id)
  )
  if (hasSnippet && hasAiStrip) return 100
  if (hasSnippet) return 84
  if (hasAiStrip) return 78
  return 60
}

// 累加 rows 高度求某封邮件 (按 internal_id) 行的顶部像素偏移; 找不到返回 null。
// 用于手风琴折叠重排后的滚动锚定 (几何法, 不依赖 DOM —— 行可能已被虚拟化移出)。
function rowTopOfId(
  rowsArr: ReadonlyArray<ListRow>,
  heights: ReadonlyArray<number>,
  internalId: number
): number | null {
  let top = 0
  for (let i = 0; i < rowsArr.length; i++) {
    const r = rowsArr[i]!
    if (r.type === 'email' && r.email.internal_id === internalId) return top
    top += heights[i] ?? 0
  }
  return null
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

function groupByThread(
  emails: ReadonlyArray<EnrichedEmailMeta>,
  // Sprint 14 round 11 — listByThread supplement keyed by thread_id.
  // Each entry is the FULL thread fetched cross-mailbox so the bundle
  // contains every message, not just the ones that survived the
  // current mailbox / chip / category filter.  Missing tid → fall back
  // to whatever the visible `emails` list contained.
  threadSupplement: ReadonlyMap<string, ReadonlyArray<EnrichedEmailMeta>>
): ThreadGroup[] {
  const byTid = new Map<string, EnrichedEmailMeta[]>()
  const solo: ThreadGroup[] = []
  // De-dupe by internal_id while partitioning so an email cannot
  // surface twice.  User feedback: "同一封邮件不应该出现两次, 如果被
  // 折叠到线程里, 就不应该出现在主线程里".
  const seen = new Set<number>()
  for (const e of emails) {
    if (seen.has(e.internal_id)) continue
    seen.add(e.internal_id)
    if (e.thread_id) {
      const arr = byTid.get(e.thread_id) ?? []
      arr.push(e)
      byTid.set(e.thread_id, arr)
    } else {
      solo.push({ threadId: null, head: e, children: [] })
    }
  }
  // Merge supplement messages for every visible thread.  Skip ids we
  // already collected from the visible list so the same email can't
  // appear twice across visible-set + supplement.
  for (const [tid, arr] of byTid) {
    const supplement = threadSupplement.get(tid)
    if (!supplement) continue
    for (const s of supplement) {
      if (seen.has(s.internal_id)) continue
      seen.add(s.internal_id)
      arr.push(s)
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

// 发件箱专用分组 (区别于 groupByThread 的"线程最新邮件作 head")。
// 用户语义: 发件箱关心"我发了什么 + 当时的上下文", 不是"线程到哪了"。
//   - 每封我发出的邮件 = 母邮件 (head)
//   - 同线程中【早于】该发件的邮件 = 子邮件 (children, 折叠), 即我回复前的上下文
//   - 无线程 / 无更早邮件 = 独立发件 (无 chevron)
//   - 排序 + 日期分桶都按 head(发件)时间 (partitionByDate 用 head.date)
// 多次回复同一线程时, 每封发件各自成行; 其它发件锚点不会被当作子邮件
// (anchorIds 排除), 避免同一封发件既当母又当子重复出现。
function groupBySentAnchor(
  sentEmails: ReadonlyArray<EnrichedEmailMeta>,
  threadSupplement: ReadonlyMap<string, ReadonlyArray<EnrichedEmailMeta>>
): ThreadGroup[] {
  const anchorIds = new Set(sentEmails.map((e) => e.internal_id))
  const groups: ThreadGroup[] = []
  const seen = new Set<number>()
  for (const sent of sentEmails) {
    if (seen.has(sent.internal_id)) continue
    seen.add(sent.internal_id)
    const full = sent.thread_id ? threadSupplement.get(sent.thread_id) : undefined
    if (!full || full.length <= 1) {
      groups.push({ threadId: null, head: sent, children: [] })
      continue
    }
    const sentDate = sent.date_received ?? ''
    const children = full
      .filter(
        (e) =>
          e.internal_id !== sent.internal_id &&
          !anchorIds.has(e.internal_id) &&
          (e.date_received ?? '') < sentDate
      )
      .sort((a, b) => (b.date_received ?? '').localeCompare(a.date_received ?? ''))
    groups.push(
      children.length === 0
        ? { threadId: null, head: sent, children: [] }
        : { threadId: sent.thread_id ?? null, head: sent, children }
    )
  }
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

  // Sprint 14 round 11 — thread-level pinning. User feedback: "固定也
  // 是整个线程固定". If ANY message inside the bundle is pinned, the
  // whole thread surfaces in the pinned bucket.  Date bucketing only
  // considers the head's date (the freshest message), per "时间分组
  // 不考虑折叠内的邮件,只考虑线程最新邮件".
  const isThreadPinned = (g: ThreadGroup): boolean => {
    if (pinnedSet.has(g.head.internal_id)) return true
    for (const c of g.children) {
      if (pinnedSet.has(c.internal_id)) return true
    }
    return false
  }

  for (const g of groups) {
    if (isThreadPinned(g)) {
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
  // 线程是否展开 — 视图感知 (收件箱默认展开, 发件箱默认折叠), 由调用方决定默认。
  isThreadExpanded: (threadId: string) => boolean,
  activeId: number | null,
  appendLoader: boolean
): ListRow[] {
  const order: GroupKey[] = ['pinned', 'today', 'yesterday', 'thisWeek', 'lastWeek', 'older']
  const out: ListRow[] = []
  for (const key of order) {
    const groupArr = buckets[key]
    if (groupArr.length === 0) continue
    const collapsed = collapsedOf(key)
    // Sprint 14 round 11 — count = visible thread heads (a.k.a. bundles
    // shown in this group), NOT total messages.  User feedback: "时间
    // 分组不考虑折叠内的邮件,只考虑线程最新邮件 (也就是折叠的母邮件)".
    out.push({
      type: 'header',
      key,
      label: labels[key],
      count: groupArr.length,
      collapsed
    })
    if (collapsed) continue
    for (const g of groupArr) {
      const isThreadHead = g.threadId !== null && g.children.length > 0
      const expanded = isThreadHead ? isThreadExpanded(g.threadId!) : false
      // bundleSelected — does activeId belong anywhere in this thread?
      // For solitary rows we still set it from the head id so the same
      // wrapper chrome (wash + accent bar) covers solitary selections.
      const bundleSelected =
        activeId !== null &&
        (g.head.internal_id === activeId || g.children.some((c) => c.internal_id === activeId))
      out.push({
        type: 'email',
        email: g.head,
        groupKey: key,
        bundleSelected,
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
            bundleSelected,
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
// customMailbox 非空 (多文件夹同步 P3 — 选中某自定义文件夹) 时优先, 列表只拉该
// mailbox (= display_name), 跳过内建 view 语义。
function listOptsForView(view: EmailView, limit: number, customMailbox: string | null): ListOpts {
  if (customMailbox) return { mailbox: customMailbox, limit }
  if (view === 'inbox') return { mailbox: '收件箱', limit }
  if (view === 'outbox') return { mailbox: '发件箱', limit }
  if (view === 'flagged') return { isFlagged: true, limit }
  return { limit }
}

// 标旗视图传给 groupByThread 的空线程补充集 (模块级稳定引用, 不破 useMemo)。
// 见 threadGroups useMemo 注释: 标旗邮件离散于各线程, 线程补充会引入 bare 的
// 非标旗邮件抢占 head, 导致非置顶标旗邮件矮行 + 丢 AI strip。
const EMPTY_THREAD_SUPPLEMENT: ReadonlyMap<string, ReadonlyArray<EnrichedEmailMeta>> = new Map()

const PAGE_SIZE = 100
const MAX_PAGES = 30 // safety cap — 3000 rows is enough for visual scrolling
// 首屏 100 行渲染落一帧后, 静默拉到 8 页 (800 行). 旧 100 行借 keepPreviousData
// 保留, 新 800 行到达后无缝替换, 用户感知不到这次升级. react-window 已虚拟化
// DOM, 800 行数据驻留内存仅 ~0.6MB(单行 ~500-800B, 不含正文), 上限 3000≈2MB,
// 内存非瓶颈; 偏大默认让"感觉加载够"。需要再调就改这个常量。
const INITIAL_PREFETCH_PAGES = 8
const INITIAL_PREFETCH_DELAY_MS = 300

export function EmailList(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const activeMailbox = useMailbox((s) => s.active)
  const activeId = useActiveEmail((s) => s.activeInternalId)
  const setActive = useActiveEmail((s) => s.setActive)
  const navTargetId = useActiveEmail((s) => s.navTargetId)
  const clearNavTarget = useActiveEmail((s) => s.clearNavTarget)
  const publishOrderedIds = useActiveEmail((s) => s.setOrderedIds)
  const filter = useEmailFilter((s) => s.filter)
  const setFilter = useEmailFilter((s) => s.setFilter)
  const view = useEmailFilter((s) => s.view)
  // 多文件夹同步 (P3) — 当前自定义文件夹 (mailbox=display_name); 非空时列表只拉它。
  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const customMailboxPath = useEmailFilter((s) => s.customMailboxPath)
  const tab = useEmailFilter((s) => s.tab)
  const setTab = useEmailFilter((s) => s.setTab)

  // §8 滑动 indicator — Focused/Other 激活态的胶囊背景移到一个绝对定位元素,
  // 随 tab 变化 tween x/width (DUR.fast)。首次挂载 (含切回 inbox) gsap.set 直接
  // 定位无动画, 之后才滑。reduced-motion 短路。useGSAP({scope}) 自动 cleanup。
  const tabListRef = useRef<HTMLDivElement | null>(null)
  const tabIndicatorRef = useRef<HTMLSpanElement | null>(null)
  const tabMountedRef = useRef(false)
  const reduceMotion = useReducedMotion()
  useGSAP(
    () => {
      const list = tabListRef.current
      const indicator = tabIndicatorRef.current
      // 非 inbox 视图 tablist 卸载 → 下次切回需重新 gsap.set 无动画定位。
      if (!list || !indicator) {
        tabMountedRef.current = false
        return
      }
      const activeEl = list.querySelector<HTMLElement>('.inbox-tab.is-active')
      if (!activeEl) return
      const listRect = list.getBoundingClientRect()
      const activeRect = activeEl.getBoundingClientRect()
      const left = activeRect.left - listRect.left
      const width = activeRect.width
      if (!tabMountedRef.current || reduceMotion) {
        gsap.set(indicator, { x: left, width, autoAlpha: 1 })
        tabMountedRef.current = true
        return
      }
      gsap.to(indicator, { x: left, width, duration: DUR.fast, overwrite: 'auto' })
    },
    { dependencies: [tab, view, reduceMotion], scope: tabListRef }
  )
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
  const selectedIds = useBatch((s) => s.selectedIds)

  const [filterOpen, setFilterOpen] = useState(false)
  const [pageCount, setPageCount] = useState(1)
  // Sprint 19 — 懒取的正文 snippet (internal_id → 前 100 字)。listEnriched 不再
  // 读 body blob (~1.5s @800 行 阻塞主进程), 改对可见行调 email:listSnippets。
  // snippet 按 internal_id 不可变, map 跨 view/mailbox 累积无需重置; snippetReqRef
  // 去重已请求过的 id (含失败/空), 避免重复 IPC。
  const [snippetMap, setSnippetMap] = useState<Record<number, string>>({})
  const snippetReqRef = useRef<Set<number>>(new Set())
  // React 19 "Adjusting state on prop change" pattern — paging resets on
  // view transition without scheduling an effect (see EmailDetail.tsx for
  // the same pattern).
  // view + customMailbox 合成 key — 多文件夹同步 (P3) 切自定义文件夹时 view 仍为
  // inbox, 故把 customMailbox 也并入重置键, 切文件夹同样重置分页。
  const viewKey = customMailbox ? `custom:${customMailbox}` : view
  const [lastView, setLastView] = useState(viewKey)
  if (lastView !== viewKey) {
    setLastView(viewKey)
    setPageCount(1)
  }
  // 首屏 100 行落幕后静默升到 500: useQuery 已经拿着 limit=100 的结果在渲染,
  // 这里把 pageCount 升到 5, queryKey 变 → React Query 后台拉 limit=500;
  // keepPreviousData 让旧 100 行原地保留直到新 500 行就位, 无 spinner / 无抖动.
  // mailbox / view 切换重置 pageCount=1 之后, 这条 effect 会再次跑一次.
  useEffect(() => {
    if (pageCount >= INITIAL_PREFETCH_PAGES) return
    const t = window.setTimeout(() => {
      setPageCount((c) => Math.max(c, INITIAL_PREFETCH_PAGES))
    }, INITIAL_PREFETCH_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [view, activeMailbox, customMailbox, pageCount])
  // Sprint 12.6 user-feedback — outside-click previously checked the whole
  // header container, which meant clicking on the inbox tabs / batch button
  // inside the header kept the popover open. We now scope the "inside"
  // check to just the popover + its trigger button, so clicking anywhere
  // else (header whitespace, list rows, status bar, …) closes it.
  const filterTriggerRef = useRef<HTMLButtonElement>(null)
  // Filter popover 出入场：无 backdrop，从右上微展开（CSS `.filter-pop` 锚定
  // top:100%+4px / right:8px，即从触发按钮下方右上角展开），退场反向后延迟卸载。
  // scopeRef 挂在 `.filter-pop` 上，兼作 outside-click 命中判定的容器 ref。
  const { shouldRender: filterShouldRender, scopeRef: filterPopoverRef } =
    useExitAnimation<HTMLDivElement>(filterOpen, {
      backdrop: false,
      from: { autoAlpha: 0, y: -6, scale: 0.97, transformOrigin: 'top right' },
      enterDuration: DUR.fast
    })

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
  // Sprint 16 — 主推送从 SSE 来 (useEventBridge invalidate ['emails']);
  // pollingInterval 仅作为 SSE 断线 fallback. SSE connected 时 fallback=false.
  const pollingInterval = usePollingFallback()
  // `placeholderData: keepPreviousData` — limit 升级 / view 切换时保留上一次
  // 结果, `<List>` 不会因为 data=undefined 暂态卸载, 滚动位置稳定. 配合下方
  // 70% 阈值预加载, 用户感知不到分页边界. (react-best-practices · Client
  // Data Fetching)
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['emails', view, customMailbox, activeMailbox, fetchLimit],
    queryFn: () => mailApi.email.listEnriched(listOptsForView(view, fetchLimit, customMailbox)),
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false,
    // 切到 设置/日历 再切回邮箱不重拉: 路由是独立顶级 route, EmailList 切走即
    // 卸载, 默认全局 staleTime=30s 会让切回(>30s)重新拉取+闪 loading。邮件写
    // 操作已由 SSE(useEventBridge) invalidate ['emails'] 实时失效, 故这里可放心
    // 拉长缓存: 5min 内切回直接命中缓存(无网络/无 loading), gcTime 15min 防过早回收。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    placeholderData: keepPreviousData
  })

  // Sprint 14 round 22 — cross-mailbox enrichment source.  Thread
  // bundles can pull in emails from the OTHER mailbox via listByThread
  // supplement; those rows arrive as bare EmailMeta (no snippet / AI
  // fields).  We fetch the other side's listEnriched in parallel so
  // when supplement merge looks up the row, it finds the enriched
  // version.  User: "email list 里对我发出的邮件,只有发件人/标题行,
  // 没有正文摘要行和 AI 行".
  // 多文件夹同步 (P3) — 自定义文件夹无收件箱/发件箱跨线程补充语义, 不拉 cross。
  const crossMailbox = customMailbox
    ? null
    : view === 'inbox'
      ? '发件箱'
      : view === 'outbox'
        ? '收件箱'
        : null
  const crossQ = useQuery({
    queryKey: ['emails', 'cross', crossMailbox, fetchLimit],
    queryFn: () =>
      crossMailbox
        ? mailApi.email.listEnriched({ mailbox: crossMailbox, limit: fetchLimit })
        : Promise.resolve([]),
    enabled: crossMailbox !== null,
    // Sprint 16 — 同 EmailList 主查询, SSE 驱动 invalidate; polling 作 fallback
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData
  })

  const all = useMemo(() => data ?? [], [data])
  const crossAll = useMemo(() => crossQ.data ?? [], [crossQ.data])

  // Pinned supplement — 用户固定的邮件不管多久前一定要出现在 pinned 桶里.
  // listEnriched({mailbox, limit}) 只 cover 最新 fetchLimit 封, 老 pinned 会被
  // 截掉. 这里按 internal_id 直接拉 pinned 邮件的 enriched 数据 (跨 mailbox),
  // 后面 union 进 filtered 时 bypass 所有 view/tab/filter — pinned 语义就是
  // 无视过滤强制显示.
  const pinnedSupplementQ = useQuery({
    queryKey: ['emails', 'pinned-supplement', pinnedList],
    queryFn: () =>
      mailApi.email.listEnriched({
        internalIds: [...pinnedList],
        limit: pinnedList.length
      }),
    enabled: pinnedList.length > 0,
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData
  })
  const pinnedSupp = useMemo(() => pinnedSupplementQ.data ?? [], [pinnedSupplementQ.data])
  // 多文件夹同步 (P3) — 自定义文件夹视图下「固定/置顶」区只显示该文件夹的置顶邮件
  // (而非全部 mailbox 的置顶)。pinnedSupp 按 internal_id 跨 mailbox 拉全部置顶,
  // customMailbox 非空时收窄到 mailbox === customMailbox; 收窄后为空 → union 不进任何
  // 行 → partitionByDate 的 pinned 桶为空 → flattenGroups 跳过该桶 (含标题), 整区隐藏。
  // 内建 view (收件箱/全部/已标旗) customMailbox 为空 → 行为不变 (全局置顶)。
  const pinnedSuppScoped = useMemo(
    () => (customMailbox ? pinnedSupp.filter((e) => e.mailbox === customMailbox) : pinnedSupp),
    [customMailbox, pinnedSupp]
  )

  // Focused/Other tab 是收件箱分流概念 (按 AI 优先级把进站邮件拆 重点/其他)。
  // 对「已标旗 / 发件箱 / 全部」这些跨邮箱视图无意义 — 标旗视图本应显示我标的
  // 全部邮件, 套 focused tab 会把 ai_priority='low' 的标旗邮件藏进 Other, 导致
  // 列表 < sidebar badge (badge 是纯 SQL is_flagged=1 计数)。故仅收件箱视图应用
  // tab 过滤; 其余视图直接用 all (tab bar 在下方 header 也只对收件箱渲染)。
  // 多文件夹同步 (P3) — 自定义文件夹无 Focused/Other 分流 (header 也不渲染 tab),
  // 故 customMailbox 激活时不套 tab 过滤 (否则 low 优先级邮件被藏进 Other)。
  const tabFiltered = useMemo(
    () => (view === 'inbox' && !customMailbox ? applyTab(tab, all) : all),
    [view, tab, all, customMailbox]
  )
  const chipFiltered = useMemo(() => applyChipFilter(filter, tabFiltered), [filter, tabFiltered])
  const filteredBase = useMemo(
    () => applyMultiFilter(chipFiltered, selectedPriorities, selectedCategories),
    [chipFiltered, selectedPriorities, selectedCategories]
  )
  // Union pinned 邮件进 filtered. dedupe by internal_id, pinned 永远进结果集
  // 但仍走 partitionByDate → pinned 桶路由, 所以 UI 体验不变, 只是不会被丢掉.
  // 发件箱例外: pinnedSupp 是跨邮箱置顶 (主要是收件箱置顶), 不该拉进发件箱视图。
  // 发件箱只锚在我发出的邮件上, 置顶的发件邮件本就在 all 里 (会被 partitionByDate
  // 路由到 pinned 桶), 故 outbox 直接用 filteredBase, 不 union 收件箱置顶。
  const filtered = useMemo(() => {
    if (view === 'outbox' || pinnedSuppScoped.length === 0) return filteredBase
    const ids = new Set(filteredBase.map((e) => e.internal_id))
    const out = filteredBase.slice()
    for (const p of pinnedSuppScoped) {
      if (!ids.has(p.internal_id)) out.push(p)
    }
    return out
  }, [view, filteredBase, pinnedSuppScoped])

  // Limit useNewlyAddedIds to the first page so paginated reads don't make
  // the entire newly-loaded slab flash "NEW".
  const firstPageIds = useMemo(() => allIdsFirstPage(all), [all])
  const newIds = useNewlyAddedIds(firstPageIds)

  // `orderedIds` (a.k.a. selectable ids in the list) is computed AFTER
  // threadGroups below so cross-mailbox thread heads / supplement
  // children also count as selectable.  Without this, the auto-reset
  // effect kicked the active id back to the first visible inbox email
  // every time the user clicked a thread head whose freshest message
  // was an outbox reply ("有的是我最新回的邮件...这种现在好像点击不了").

  // counts 跟当前 tab (Focused/Other) 联动. 之前用 `all` 全集导致 meta line
  // 显示 "5 封未读" 但点 unread filter 过滤出空——5 封 unread 都是 ai_priority
  // ='low' 落在 Other tab, 在 Focused tab 被 applyTab 提前过滤掉了. 现在数字
  // 严格跟 filter 看到的视图一致.
  const counts = useMemo(() => {
    let unread = 0
    let flagged = 0
    let failed = 0
    for (const r of tabFiltered) {
      if (!r.is_read) unread++
      if (r.is_flagged) flagged++
      if (r.sync_status === 'failed' || r.sync_status === 'dead_letter') failed++
    }
    return { all: tabFiltered.length, unread, flagged, failed }
  }, [tabFiltered])

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
    for (const e of tabFiltered) {
      const c = categoryOf(e)
      if (c !== null) out[c] += 1
    }
    return out
  }, [tabFiltered])
  const priorityCounts = useMemo(() => {
    const out: Record<AIPriority, number> = {
      critical: 0,
      urgent: 0,
      important: 0,
      normal: 0,
      low: 0
    }
    for (const e of tabFiltered) if (e.ai_priority) out[e.ai_priority] += 1
    return out
  }, [tabFiltered])

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

  // Sprint 18 — 线程「手风琴」展开. 同一时刻至多 1 条线程展开 (单个 expandedKey,
  // 默认 null = 全折叠): 点击母邮件行体 / chevron 展开某条, 其它自动折叠. 收件箱 /
  // 发件箱用 `outbox:` 前缀分命名空间, 对同一 thread_id 互不污染. store 用
  // module-level zustand 跨 re-render / route 切换 / SSE invalidate 保活
  // (旧版 useState 会被这些重渲重置, "老是忽然自己展开了"). 详见 thread-expand.ts.
  const expandedKey = useThreadExpand((s) => s.expandedKey)
  const expandThread = useThreadExpand((s) => s.expand)
  const toggleThread = useThreadExpand((s) => s.toggle)
  const keyFor = useCallback(
    (threadId: string): string => (view === 'outbox' ? `outbox:${threadId}` : threadId),
    [view]
  )
  const isThreadExpanded = useCallback(
    (threadId: string): boolean => expandedKey === keyFor(threadId),
    [expandedKey, keyFor]
  )
  // 滚动锚定用 (handler / effect 闭包 rows+rowHeights, 故定义在它们算好之后, 见下方)。
  const listRef = useRef<ListImperativeAPI | null>(null)
  const scrollAnchorRef = useRef<{ id: number; viewportOffset: number } | null>(null)
  // B3 — 手风琴滚动锚定平滑化期间临时屏蔽分页. gsap scrollTo tween 会逐帧派发
  // scroll 事件联动 handleRowsRendered 的分页判断, 若不屏蔽, 平滑滚动经过靠底部
  // 的行会误触发预取. tween 开始置 true, onComplete 置 false。
  const isAnchoringRef = useRef(false)

  // Sprint 14 round 11 — cross-mailbox thread completion.  listEnriched
  // is mailbox-scoped, so a thread that spans inbox + outbox shows up
  // truncated in the list.  For each visible thread_id we hit
  // listByThread (which queries SQLite without a mailbox filter), then
  // hand the supplement to groupByThread which merges by internal_id.
  const uniqueThreadIds = useMemo(() => {
    const set = new Set<string>()
    for (const e of all) if (e.thread_id) set.add(e.thread_id)
    // pinned 邮件的线程也要列入, 否则 listByThread 拿不到整个 thread, pinned 桶
    // 里只能看到孤立一封, 兄弟邮件全 miss.
    for (const e of pinnedSupp) if (e.thread_id) set.add(e.thread_id)
    return Array.from(set)
  }, [all, pinnedSupp])

  // Sprint 19 — 跨邮箱线程补全批量化. 之前每条可见线程各发一次 listByThread
  // (useQueries 扇出: 800 行 → 几百次 IPC + SQLite 查询串在主进程上执行, 列表
  // 滚动/搜索跳转卡顿的主因). 现在合并成单次 listByThreads 批量查询 (1 IPC +
  // 1 SQL `WHERE thread_id IN (...)`)。queryKey 用排序后的 id 串, 集合相同即
  // 命中缓存 (顺序无关); keepPreviousData 让 id 集合变化 (加载更多 / 新邮件到达)
  // 期间旧补全 map 原地保留, 不闪空 (否则跨邮箱线程会瞬间塌成孤立一封)。
  const threadKey = useMemo(() => [...uniqueThreadIds].sort(), [uniqueThreadIds])
  const threadBatchQ = useQuery({
    queryKey: ['emails', 'thread-batch', threadKey],
    queryFn: () => mailApi.email.listByThreads(threadKey),
    enabled: threadKey.length > 0,
    staleTime: 60_000,
    placeholderData: keepPreviousData
  })
  const threadBatch = threadBatchQ.data

  // Sprint 14 round 21 — supplement merge respects enriched data.
  // listByThread returns the bare EmailMeta shape (no snippet / AI
  // fields).  If the same internal_id already lives in `all` (the
  // mailbox-scoped listEnriched result), we use that fuller record —
  // otherwise we fall back to `enrichDefaults`.  Without this, an
  // inbox-resident email that happens to be the thread's freshest but
  // is filtered out by the focused/other tab (e.g. priority=low) ends
  // up surfacing as the thread head via supplement *without* its
  // snippet / ai_priority / ai_action, even though those fields are
  // sitting right there in `all`.  User: "53876 这封邮件,为啥
  // emaillist 没有显示正文摘要和 AI 优先级/建议字段啊".
  const enrichedById = useMemo(() => {
    const m = new Map<number, EnrichedEmailMeta>()
    // Cross-mailbox rows first; same-mailbox `all` overwrites if a
    // collision (theoretically impossible since SQLite mailbox is a
    // column, but the merge order makes intent explicit).
    for (const e of crossAll) m.set(e.internal_id, e)
    // pinned supplement 次之, all 仍优先 (它是当前 view 的最新结果, refetch
    // 频率最高). pinned 同时也在 all 里时, all 的版本胜出.
    for (const e of pinnedSupp) m.set(e.internal_id, e)
    for (const e of all) m.set(e.internal_id, e)
    return m
  }, [all, crossAll, pinnedSupp])
  // 批量旗标 toggle 方向: 选中邮件全部已加旗标 → 点按钮取消, 否则加旗标 (enrichedById
  // 覆盖 all+cross+pinned; 选中邮件不在其中的边缘 case → undefined → 视为未全 flagged → 加旗标)。
  const selectedAllFlagged = useMemo(
    () =>
      selectedIds.length > 0 &&
      selectedIds.every((id) => enrichedById.get(id)?.is_flagged === true),
    [selectedIds, enrichedById]
  )
  const threadSupplement = useMemo(() => {
    const m = new Map<string, EnrichedEmailMeta[]>()
    if (!threadBatch) return m
    for (const tid of uniqueThreadIds) {
      const data = threadBatch[tid]
      if (!data) continue
      m.set(
        tid,
        data.map((meta) => enrichedById.get(meta.internal_id) ?? enrichDefaults(meta))
      )
    }
    return m
  }, [uniqueThreadIds, threadBatch, enrichedById])

  // 发件箱用 groupBySentAnchor (发件作母邮件 + 之前线程作子邮件); 其余视图
  // 用 groupByThread (线程最新邮件作 head)。
  const threadGroups = useMemo(
    () =>
      view === 'outbox'
        ? groupBySentAnchor(filtered, threadSupplement)
        : // 标旗视图: 标旗邮件离散分布在各线程, threadSupplement 补进来的非标旗
          // 邮件既不在 all (仅标旗) 也无 cross 源 (crossMailbox=null) → enrichDefaults
          // 兜底成 bare (has_body=false / ai_priority=null), 一旦它是线程最新邮件就
          // 被 groupByThread 选成 head → "非置顶标旗邮件矮行 + 无 AI strip"。标旗
          // 视图语义=只看我标的邮件, 故线程只在标旗邮件之间聚合 (head 必为标旗邮件,
          // enriched 完整), 不 merge 跨邮件补充。
          groupByThread(filtered, view === 'flagged' ? EMPTY_THREAD_SUPPLEMENT : threadSupplement),
    [view, filtered, threadSupplement]
  )

  // Selectable ids = every email rendered in the list (heads + visible
  // children).  Used by keyboard nav and the active-reset effect so a
  // cross-mailbox supplement head can become active without being
  // immediately yanked back.
  const orderedIds = useMemo(() => {
    const ids: number[] = []
    for (const g of threadGroups) {
      ids.push(g.head.internal_id)
      for (const c of g.children) ids.push(c.internal_id)
    }
    return ids
  }, [threadGroups])

  // 搜索跳转目标一旦真正出现在列表里, 就解除豁免(此后手动切邮箱恢复正常 reset)。
  if (navTargetId !== null && orderedIds.includes(navTargetId)) {
    queueMicrotask(() => clearNavTarget())
  }
  const firstId = orderedIds[0]
  if (
    firstId !== undefined &&
    // 豁免显式搜索跳转目标: 它可能不在当前(陈旧/未分页到的)列表里, 但 EmailDetail
    // 能按 id 独立加载, 别把 active 抢回成列表第一封。
    activeId !== navTargetId &&
    (activeId === null || !orderedIds.includes(activeId)) &&
    activeId !== firstId
  ) {
    queueMicrotask(() => setActive(firstId))
  }

  // Publish the live order so EmailDetail can wire the toolbar prev/next
  // buttons to the same pickNext/pickPrev navigation as J/K (single source).
  useEffect(() => {
    publishOrderedIds(orderedIds)
  }, [orderedIds, publishOrderedIds])

  useEmailKeyboardNav(orderedIds)
  useInboxActionShortcuts()
  const buckets = useMemo(() => partitionByDate(threadGroups, pinnedSet), [threadGroups, pinnedSet])

  // Show the loader sentinel when we still have headroom (no end-of-data
  // signal from this query shape — we stop the loader if a fetch returned
  // less than the requested limit, meaning there are no more rows).
  const reachedEnd = all.length < fetchLimit
  const showLoader = !reachedEnd && pageCount < MAX_PAGES

  const rows = useMemo(
    () => flattenGroups(buckets, groupLabels, isCollapsed, isThreadExpanded, activeId, showLoader),
    [buckets, groupLabels, isCollapsed, isThreadExpanded, activeId, showLoader]
  )
  // react-window v2 在 rows 引用变化时 (切 filter / tab / view / 收到新邮件)
  // 会对所有 row 调一遍 rowHeight 算 total height. 之前 rowHeight 函数内联
  // cleanSnippet (11 段正则) + AI strip check, 500 行级别累积 ≥ 200ms 触发
  // macOS wait cursor. 这里一把 useMemo 算好高度数组, rowHeight 改成 O(1)
  // 查表; deps 含 newIds 因为 "NEW" chip 会影响 ai-strip 显示.
  const rowHeights = useMemo(() => {
    const arr = new Array<number>(rows.length)
    for (let i = 0; i < rows.length; i++) {
      arr[i] = computeRowHeight(rows[i], newIds)
    }
    return arr
  }, [rows, newIds])
  const getRowHeight = useCallback((index: number): number => rowHeights[index] ?? 28, [rowHeights])

  // 滚动锚定: 展开 B 时手风琴折叠上方长线程 A → B 及下方行整体上移, 但 react-window
  // 的 scrollTop 不变 → B 被挤出视口, 需手动往上滚才能看到. captureScrollAnchor 在
  // 展开前记下 B 母邮件行在视口的相对偏移, 下面 layout effect 在重排后用几何法
  // (rowHeights 前缀和, 不读 DOM —— 行可能已被虚拟化移出) 把 scrollTop 调回, 让 B
  // 视觉上不动. 闭包 rows/rowHeights 故定义在此处。
  const captureScrollAnchor = useCallback(
    (internalId: number): void => {
      const el = listRef.current?.element
      if (!el) return
      const top = rowTopOfId(rows, rowHeights, internalId)
      if (top === null) return
      scrollAnchorRef.current = { id: internalId, viewportOffset: top - el.scrollTop }
    },
    [rows, rowHeights]
  )
  const handleToggleThread = useCallback(
    (threadId: string): void => toggleThread(keyFor(threadId)),
    [keyFor, toggleThread]
  )
  const handleExpandThread = useCallback(
    (threadId: string, headInternalId: number): void => {
      const key = keyFor(threadId)
      // 已展开 → 布局不变, 不锚定 (避免残留 stale anchor 在下次 poll 误滚)。
      if (expandedKey === key) return
      captureScrollAnchor(headInternalId)
      expandThread(key)
    },
    [keyFor, expandedKey, captureScrollAnchor, expandThread]
  )
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current
    if (!anchor) return
    scrollAnchorRef.current = null
    const el = listRef.current?.element
    if (!el) return
    const newTop = rowTopOfId(rows, rowHeights, anchor.id)
    if (newTop === null) return
    const target = Math.max(0, newTop - anchor.viewportOffset)
    if (Math.abs(target - el.scrollTop) <= 0.5) return
    // reduced-motion: 退回硬跳 (与原行为一致). 命令式 effect 内读 matchMedia,
    // 不用 useReducedMotion hook (这里不在组件顶层语义里, 且 effect 一次性触发)。
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    if (reduce) {
      // react-window 滚动容器的命令式回滚 (imperative scroll); 规则误判 listRef 不可变。
      // eslint-disable-next-line react-hooks/immutability
      el.scrollTop = target
      return
    }
    // 平滑锚定: ScrollToPlugin (已在 @shared/lib/gsap 注册) + standard 曲线 + DUR.base。
    // tween 期间屏蔽分页 (见 handleRowsRendered)。
    isAnchoringRef.current = true
    gsap.to(el, {
      scrollTo: { y: target },
      duration: DUR.base,
      ease: 'standard',
      overwrite: 'auto',
      onComplete: () => {
        isAnchoringRef.current = false
      }
    })
  }, [rows, rowHeights])

  const priActive = !allPrioritiesSelected()
  const catActive = !allCategoriesSelected()
  const filterActive = filter !== 'all' || priActive || catActive

  // Sprint 19 — 对【已滚动到的】has_body 行按需取 snippet (email:listSnippets)。
  // stopIndex 随滚动增长 → 分批懒取经过的行; 首屏 ~15 行 12ms, 永不一次拉 800 行
  // 的 body blob。snippetReqRef 去重, 无 body 的行跳过 (子邮件 / 纯元数据)。
  const fetchSnippetsUpTo = useCallback(
    (stopIndex: number): void => {
      const limit = Math.min(stopIndex + 12, rows.length)
      const need: number[] = []
      for (let i = 0; i < limit; i++) {
        const r = rows[i]
        if (r?.type !== 'email' || !r.email.has_body) continue
        const id = r.email.internal_id
        if (snippetReqRef.current.has(id)) continue
        snippetReqRef.current.add(id)
        need.push(id)
      }
      if (need.length === 0) return
      void mailApi.email
        .listSnippets(need)
        .then((m) => {
          if (m && Object.keys(m).length > 0) setSnippetMap((prev) => ({ ...prev, ...m }))
        })
        .catch(() => {
          // 取 snippet 失败不致命 (列表已渲染, 仅缺预览行文本); 解除请求标记以便重试。
          for (const id of need) snippetReqRef.current.delete(id)
        })
    },
    [rows, mailApi]
  )

  // 首屏 snippet — onRowsRendered 在挂载时也会触发, 但加一道兜底确保第一屏总有
  // 预览 (rows 变化即尝试, snippetReqRef 去重故重复调用廉价)。
  useEffect(() => {
    if (rows.length > 0) fetchSnippetsUpTo(20)
  }, [rows, fetchSnippetsUpTo])

  const handleRowsRendered = useCallback(
    (range: { stopIndex: number }) => {
      // 懒取经过的行的 snippet (与分页无关, !showLoader 时也要取)。
      fetchSnippetsUpTo(range.stopIndex)
      // 滚到 ~70% 或距底 8 行 (取更早) 就预取下一页. 配合上面 keepPreviousData,
      // limit 升级期间旧 rows 保留挂载, 新结果到达后 React Query 原地替换, 用户
      // 不会看到 spinner / 列表抖动 / 回顶部.
      if (!showLoader) return
      // B3 — 平滑滚动锚定 tween 期间逐帧派发 scroll 事件, 不让经过靠底行误触发分页。
      if (isAnchoringRef.current) return
      const triggerAt = Math.min(Math.floor(rows.length * 0.7), rows.length - 8)
      if (range.stopIndex >= triggerAt) {
        setPageCount((c) => Math.min(c + 1, MAX_PAGES))
      }
    },
    [rows.length, showLoader, fetchSnippetsUpTo]
  )

  const visibleIds = useMemo(() => orderedIds, [orderedIds])

  return (
    <section
      aria-label="email-list"
      // EMAIL-02 响应式：<lg 列表占满 master-detail 容器（详情走 absolute 覆盖）；
      // ≥lg 恢复 340 固定列 + shrink-0（桌面三栏零回归）。
      className="w-full lg:w-[340px] lg:shrink-0 glass-2 border-r border-ink-border flex flex-col min-h-0"
    >
      {/* Header — Focused/Other tabs · batch + filter cluster · meta line */}
      <div className="relative px-3 pt-3 pb-2.5 border-b border-ink-border-soft">
        <div className="flex items-center justify-between gap-2">
          {customMailbox ? (
            // 多文件夹同步 (P3) — 选中自定义文件夹时左侧显层级面包屑 (界面④)。
            // 末段 = 当前文件夹 (高亮), 前缀段为父路径 (弱化), 中间用 chevron 分隔。
            <div
              className="flex items-center gap-1 min-w-0"
              aria-label={t('list.folderCrumb.aria')}
            >
              <Folder size={14} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
              {(customMailboxPath.length > 0 ? customMailboxPath : [customMailbox]).map(
                (seg, i, arr) => {
                  const isLast = i === arr.length - 1
                  return (
                    <Fragment key={`${seg}-${i}`}>
                      {i > 0 ? (
                        <ChevronRight
                          size={12}
                          strokeWidth={2}
                          className="shrink-0 text-ink-fg-3"
                        />
                      ) : null}
                      <span
                        className={cn(
                          'truncate text-aux',
                          isLast ? 'font-semibold text-ink-fg' : 'text-ink-fg-2'
                        )}
                      >
                        {seg}
                      </span>
                    </Fragment>
                  )
                }
              )}
            </div>
          ) : view === 'inbox' ? (
            <div
              ref={tabListRef}
              className="inbox-tabs"
              role="tablist"
              aria-label={t('list.tab.aria')}
            >
              {/* §8 滑动 indicator — 胶囊背景跟随激活 tab 滑动 (JS 测量 + GSAP x/width)。 */}
              <span ref={tabIndicatorRef} className="inbox-tab-indicator" aria-hidden="true" />
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
          ) : (
            // 非收件箱视图无 focused/other 分流, 用视图标题占左侧 (保 justify-between
            // 布局: 右侧 batch/filter 簇仍靠右), 同时告诉用户当前在哪个视图。
            <div className="text-aux font-semibold text-ink-fg truncate">
              {view === 'outbox'
                ? t('nav.outbox')
                : view === 'flagged'
                  ? t('nav.flagged')
                  : t('nav.allMail')}
            </div>
          )}
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

        {filterShouldRender && (
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
        {isLoading && (
          <div className="p-6 text-aux text-ink-fg-2 animate-pulse motion-reduce:animate-none">
            Loading…
          </div>
        )}
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
            listRef={listRef}
            rowComponent={VirtualRow}
            rowCount={rows.length}
            rowHeight={getRowHeight}
            rowProps={{
              rows,
              activeId,
              newIds,
              snippets: snippetMap,
              onSelect: setActive,
              onToggleGroup: toggleGroup,
              onToggleThread: handleToggleThread,
              onExpandThread: handleExpandThread
            }}
            onRowsRendered={handleRowsRendered}
            className="scrollbar-thin"
            style={{ height: '100%' }}
          />
        )}
      </div>

      <BatchActionBar visibleIds={visibleIds} selectedAllFlagged={selectedAllFlagged} />
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

// Sprint 14 round 11 — listByThread returns the bare EmailMeta shape
// (no snippet / ai_* fields).  Thread children are rendered with the
// same EmailRow component used by the head, so we widen each row to
// EnrichedEmailMeta with safe defaults.  The empty AI fields make the
// child rows render the simpler 60-78px layout (no ai-strip / snippet)
// which reads well under the head.
function enrichDefaults(m: EmailMeta): EnrichedEmailMeta {
  return {
    ...m,
    snippet: null,
    // listByThread 补全的子邮件不带 body 信息 → has_body=false (保持原 60-78px
    // 紧凑行高, 不为它们懒取 snippet, 与改造前行为一致)。
    has_body: false,
    lang: 'unknown',
    ai_priority: null,
    ai_action: null,
    ai_category: null,
    attach_count: 0,
    is_important: false,
    // Sprint 16 — thread child defaults to no done state (parent is the head row;
    // children rarely have processing_status visible in the bundled view anyway).
    processing_status: null
  }
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
