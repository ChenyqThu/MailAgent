// P1-4 A-1 split (2026-07-10) — pure row-model helpers extracted verbatim from
// EmailList.tsx: filter / tab / grouping / date-bucketing / flatten / row-height
// functions plus the ListRow / ThreadGroup types they operate on. These are
// module-level pure functions with zero React-state dependencies; EmailList.tsx
// imports them and stays the stateful container. Behavior is unchanged —
// implementations and comments are moved byte-for-byte.

import {
  ALL_CATEGORIES,
  ALL_PRIORITIES,
  type EmailCategory,
  type EmailFilter
} from '@shared/state/email-filter'
import type { GroupKey } from '@shared/state/group-collapse'
import { actionLabelChinese } from '@shared/lib/ai_labels'
import type { AIPriority, EnrichedEmailMeta } from '@shared/api/types'

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
export type ThreadRowInfo =
  | { isHead: true; threadId: string; childCount: number; expanded: boolean }
  | { isHead: false; threadId: string }

export type ListRow =
  | { type: 'header'; key: GroupKey; label: string; count: number; collapsed: boolean }
  | {
      type: 'email'
      email: EnrichedEmailMeta
      groupKey: GroupKey
      thread?: ThreadRowInfo
      /** 主题 v3 (2026-07-12) — true only for the row activeId actually
       *  hits (head or child), driving the selected wash pill.  Sole
       *  exception: a COLLAPSED thread head is selected when activeId is
       *  one of its hidden children (the head stands in for the bundle).
       *  Historical name kept — pre-v3 it lit the whole bundle. */
      bundleSelected: boolean
    }
  | { type: 'loader' }

export function computeRowHeight(
  r: ListRow | undefined,
  newIds: ReadonlySet<number>
): number {
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
  const hasSnippet = Boolean(e.snippet && e.snippet.length > 0)
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
export function rowTopOfId(
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

export function applyChipFilter(
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
export function applyTab(
  tab: 'focused' | 'other',
  rows: ReadonlyArray<EnrichedEmailMeta>
): EnrichedEmailMeta[] {
  if (tab === 'other') return rows.filter((r) => r.ai_priority === 'low')
  return rows.filter((r) => r.ai_priority !== 'low')
}

/** Strict literal match against LLM CATEGORY_ENUM — `email.ai_category`
 *  is the verbatim emoji-prefixed Chinese label so `Set.has()` works. */
export function categoryOf(e: EnrichedEmailMeta): EmailCategory | null {
  if (!e.ai_category) return null
  return e.ai_category as EmailCategory
}

export function applyMultiFilter(
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
export function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

// Sprint 14 round 9 — Outlook-style thread bundle.  Same-thread rows
// collapse into a single "head" plus N indented children.  The bundle
// is keyed by thread_id; emails without a thread_id (or whose thread
// only has one email in the current list) are treated as solitary.
export interface ThreadGroup {
  threadId: string | null
  head: EnrichedEmailMeta
  children: EnrichedEmailMeta[]
  /** #10 dogfood: 排序/分桶用的锚点日期 = 可见集合（listEnriched 结果，不含 supplement）
   *  里最新邮件的 date_received。发件箱视图 (groupBySentAnchor) 直接用 head.date_received。
   *  避免 supplement 里的已发回复（今日时间戳）把旧线程推入「今天」分组。 */
  anchorDate: string | null
}

export function groupByThread(
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
  // #10 dogfood: 每个线程里「可见集合」（listEnriched 结果）中最新邮件的日期，
  // 用于 anchorDate。supplement 中的已发回复（今日时间戳）不计入，避免将旧线程
  // 误推进「今天」分组。
  const visibleAnchorByTid = new Map<string, string>()
  for (const e of emails) {
    if (seen.has(e.internal_id)) continue
    seen.add(e.internal_id)
    if (e.thread_id) {
      const arr = byTid.get(e.thread_id) ?? []
      arr.push(e)
      byTid.set(e.thread_id, arr)
      // Track newest visible date per thread
      const prev = visibleAnchorByTid.get(e.thread_id)
      if (!prev || (e.date_received ?? '') > prev) {
        visibleAnchorByTid.set(e.thread_id, e.date_received ?? '')
      }
    } else {
      solo.push({ threadId: null, head: e, children: [], anchorDate: e.date_received ?? null })
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
    // anchorDate from visible emails only; fallback to absolute head if missing
    // (shouldn't happen: every byTid thread was seeded from the visible set).
    const anchorDate = visibleAnchorByTid.get(tid) ?? arr[0]?.date_received ?? null
    if (arr.length === 1) {
      // Single-message thread is functionally solitary — no chevron.
      groups.push({ threadId: null, head: arr[0]!, children: [], anchorDate })
    } else {
      groups.push({ threadId: tid, head: arr[0]!, children: arr.slice(1), anchorDate })
    }
  }
  groups.push(...solo)
  // Stable ordering by anchorDate (newest visible email) DESC — supplement
  // messages (e.g. sent replies) do not bump threads in sort or bucket order.
  groups.sort((a, b) => (b.anchorDate ?? '').localeCompare(a.anchorDate ?? ''))
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
export function groupBySentAnchor(
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
      groups.push({
        threadId: null,
        head: sent,
        children: [],
        anchorDate: sent.date_received ?? null
      })
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
        ? { threadId: null, head: sent, children: [], anchorDate: sent.date_received ?? null }
        : {
            threadId: sent.thread_id ?? null,
            head: sent,
            children,
            anchorDate: sent.date_received ?? null
          }
    )
  }
  // 发件箱：anchor = 发件时间（head 即发件，无 supplement bump 问题）。
  groups.sort((a, b) => (b.anchorDate ?? '').localeCompare(a.anchorDate ?? ''))
  return groups
}

export function partitionByDate(
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
    // #10 dogfood: 用 anchorDate（可见集合里最新邮件的日期）分桶，而非 head.date_received。
    // head 可能是 supplement 里的已发回复（今日），anchorDate 则是收件邮件日期（真实分桶依据）。
    const bucketDate = g.anchorDate ?? g.head.date_received
    if (!bucketDate) {
      buckets.older.push(g)
      continue
    }
    const d = new Date(bucketDate)
    if (d >= today) buckets.today.push(g)
    else if (d >= yesterday) buckets.yesterday.push(g)
    else if (d >= weekStart) buckets.thisWeek.push(g)
    else if (d >= lastWeekStart) buckets.lastWeek.push(g)
    else buckets.older.push(g)
  }
  return buckets
}

export function flattenGroups(
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
      // bundleSelected — 主题 v3 tweak (2026-07-12 owner 实机 review): 只高亮
      // activeId 命中的那一行, 不再整个 bundle 连坐。唯一例外: 线程**折叠**且
      // activeId 是折叠里的 child 时, head 行代表整个 bundle 高亮 (否则选中态
      // 在列表里不可见)。展开态下 head/child 各自严格按 internal_id 匹配。
      const bundleSelected =
        activeId !== null &&
        (g.head.internal_id === activeId ||
          (!expanded && g.children.some((c) => c.internal_id === activeId)))
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
            bundleSelected: child.internal_id === activeId,
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
