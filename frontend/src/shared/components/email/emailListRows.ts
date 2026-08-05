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
  type FilterAxes
} from '@shared/state/email-filter'
import type { GroupKey } from '@shared/state/group-collapse'
import { actionLabelChinese } from '@shared/lib/ai_labels'
import { priorityRank, type EmailSortDir, type EmailSortKey } from '@shared/lib/emailSort'
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
  | {
      isHead: true
      threadId: string
      childCount: number
      expanded: boolean
      /** 「虚拟线程头」的成员聚合 —— 有它 = 这一行代表**整条线程** (聚合显示旗标/
       *  置顶 + 点击走级联写)。
       *
       *  发件箱 sent-anchor 头 (见 ThreadGroup.sentAnchor) 恒 undefined = 纯单封
       *  语义。做成可选字段而不是「退化的聚合值」: 后者要靠每个消费点自己把
       *  memberIds=[自己] 再算回单封结果, 漏一处就把级联写喷到上下文邮件上。 */
      agg?: ThreadHeadAgg
    }
  /** childIndex = 在本线程子邮件里的序号, 仅用于展开入场动画的 stagger 延迟。 */
  | { isHead: false; threadId: string; childIndex: number }

export interface ThreadHeadAgg {
  /** 线程全部成员 internal_id (含最新一封, DESC 序) —— 聚合显示 + 级联写的乐观
   *  翻转集。展开时同一 id 会出现两行 (虚拟头 + 首个子行), 所以这里是**成员集**
   *  而不是「子行集」。 */
  memberIds: number[]
  /** 任一成员 is_flagged —— 虚拟头的旗标聚合显示 (折叠时代表整条线程)。 */
  aggFlagged: boolean
}

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

export function computeRowHeight(r: ListRow | undefined, newIds: ReadonlySet<number>): number {
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

// ─── 收起位移过渡的几何差分（方案 A，2026-08） ─────────────────────────
//
// 线程收起 = 直接从 rows 数组里摘掉子行，react-window 立刻把下方每一行的
// `transform: translateY(...)` 改小，视觉上整块瞬移。这里算出「每一行跳了多少」，
// 由 useThreadCollapseShift 用一次性 tween 把这段位移补回去。
//
// 🔴 刻意**不**引入幽灵行：行高前缀和同时是手风琴锚定 (rowTopOfId) 与 ⌘K 跳转
// 定位的几何依据，多留一行会把这两条链一起算歪。位移只写在已挂载行的
// **独立 translate 属性**上，rows / rowHeights 真源一个字节不动。

/** VirtualRow 外层 div 的行身份标记 —— 位移 tween 靠它在 DOM 里找回对应的行。
 *  两侧（渲染 / 查询）都从这里取，别在任一侧手写字面量。 */
export const ROW_KEY_ATTR = 'data-row-key'
export const ROW_KEY_SELECTOR = `[${ROW_KEY_ATTR}]`

/**
 * 行的稳定身份键 —— 在收起前后两份 rows 数组之间匹配「同一行」。
 *
 * 🔴 必须带角色位：线程虚拟头展开时同一 internal_id 会出现**两行**（虚拟头 +
 * 首个子行，见 flattenGroups 尾部），只用 internal_id 会把它俩混成一条，差分算出
 * 来的位移就会张冠李戴。
 */
export function rowIdentityKey(r: ListRow): string {
  if (r.type === 'header') return `h:${r.key}`
  if (r.type === 'loader') return 'loader'
  const role = r.thread === undefined ? 's' : r.thread.isHead ? 'H' : 'C'
  return `e:${r.groupKey}:${r.email.internal_id}:${role}`
}

/** VirtualRow 外层 div 的身份属性（JSX 侧展开用，属性名单源）。 */
export function rowKeyAttrs(r: ListRow): Record<string, string> {
  return { [ROW_KEY_ATTR]: rowIdentityKey(r) }
}

/** 收起位移差分的一侧快照：rows / heights 同序，scrollTop 是该时刻滚动容器的值。 */
export interface RowGeometrySnapshot {
  rows: ReadonlyArray<ListRow>
  heights: ReadonlyArray<number>
  scrollTop: number
}

/**
 * 收起过渡的退场集：before 里存在、after 里消失的**线程子行**（role C）身份键。
 * useThreadCollapseShift 据此决定哪些 capture 时克隆的节点要作为「幽灵」播退场
 * （fade + 上浮，thread-child-in 入场的镜像）。
 *
 * 🔴 只认子行：线程头 / 单封 / header 行的增删来自数据刷新（SSE / 分页 / 过滤），
 * 不是收起语义，给它们播退场会把「一封邮件被移出列表」演成「它被收进了某条线程」。
 */
export function collectRemovedChildKeys(
  before: ReadonlyArray<ListRow>,
  after: ReadonlyArray<ListRow>
): Set<string> {
  const afterKeys = new Set(after.map(rowIdentityKey))
  const out = new Set<string>()
  for (const r of before) {
    if (r.type !== 'email' || r.thread === undefined || r.thread.isHead) continue
    const key = rowIdentityKey(r)
    if (!afterKeys.has(key)) out.add(key)
  }
  return out
}

/**
 * 线程收起的 FLIP 差分：对收起后**仍在 rows 里**的每一行算「旧视觉位置 − 新视觉
 * 位置」（px）。正值 = 该行往上跳了，动画从 +dy 滑回 0。
 *
 * 视觉位置 = 内容坐标（rowHeights 前缀和，与 react-window 的 scrollOffset 同源）
 * − scrollTop。🔴 减 scrollTop 不是多此一举：列表接近底部收起时总高度变矮，浏览器
 * 会把 scrollTop clamp 回新的最大值，那一下 clamp 让**全部**行（含收起点上方的）
 * 视觉上整体下移。用视觉差而非纯内容差，这一跳会被同一个 tween 顺带吸收；同时也
 * 让「收起点上方的行不动」在无 clamp 时自然成立（前后 top 相等 → dy=0 → 被滤掉）。
 *
 * 收起时被摘掉的子行不出现在 after 里，自然不参与（不做退场，见 index.css 注释）。
 */
export function computeCollapseShifts(
  before: RowGeometrySnapshot,
  after: RowGeometrySnapshot,
  minDelta = 0.5
): Map<string, number> {
  const beforeTops = new Map<string, number>()
  let top = 0
  for (let i = 0; i < before.rows.length; i++) {
    beforeTops.set(rowIdentityKey(before.rows[i]!), top)
    top += before.heights[i] ?? 0
  }
  const out = new Map<string, number>()
  top = 0
  for (let i = 0; i < after.rows.length; i++) {
    const key = rowIdentityKey(after.rows[i]!)
    const oldTop = beforeTops.get(key)
    if (oldTop !== undefined) {
      const dy = oldTop - before.scrollTop - (top - after.scrollTop)
      if (Math.abs(dy) >= minDelta) out.set(key, dy)
    }
    top += after.heights[i] ?? 0
  }
  return out
}

/** 旗标三态判定 —— 与 EmailRow / useInboxActionShortcuts 同款推导（'已完成' 优先，
 *  一封「已完成」邮件的 is_flagged 已被写回 false，但历史行可能两者都为真）。 */
export function isDone(e: EnrichedEmailMeta): boolean {
  return e.processing_status === '已完成'
}
export function isFlaggedOnly(e: EnrichedEmailMeta): boolean {
  return e.is_flagged === true && !isDone(e)
}

/**
 * 「收件人是我」判据 —— `to_addr` 是原始收件人头（逗号分隔、可能带显示名），
 * 归一化 = 小写 + 剥 `mailto:` 后做子串包含（与 EventDetailDrawer 的 organizer
 * 比对同款）。刻意**不**写地址解析器：显示名里恰好含有自己邮箱地址的情况不存在，
 * 而一个半吊子的 `<...>` 解析器遇到 `"Doe, John" <me@x>` 这类带逗号的显示名会
 * 切错，反而漏掉真正的命中。
 *
 * 🔴 只看 To，不看 Cc（owner 拍板）——「抄送给我」和「发给我」是两件事。
 */
export function recipientIsMe(
  toAddr: string | null | undefined,
  userEmail: string | null
): boolean {
  if (!toAddr || !userEmail) return false
  const me = userEmail
    .toLowerCase()
    .replace(/^mailto:/, '')
    .trim()
  if (me === '') return false
  return toAddr.toLowerCase().replaceAll('mailto:', '').includes(me)
}

/**
 * 五条二值筛选轴的 AND 组合（取代 Sprint 10 的单选 chip）。全 false → 原样拷贝。
 *
 * `userEmail === null`（settings 还没到 / 没配 USER_EMAIL）时 `toMe` 轴**惰性**：
 * 判据本身取不到，宁可不过滤也不要返回空列表 —— 后者看起来就是「筛选坏了」。
 * 菜单里那一行也会 disabled，所以正常情况下走不到这个分支。
 */
export function applyAxisFilters(
  axes: FilterAxes,
  rows: ReadonlyArray<EnrichedEmailMeta>,
  userEmail: string | null
): EnrichedEmailMeta[] {
  const toMeActive = axes.toMe && userEmail !== null
  if (!axes.unread && axes.flagMark === null && !toMeActive && !axes.hasAttach && !axes.failed) {
    return rows.slice()
  }
  return rows.filter((r) => {
    if (axes.unread && r.is_read) return false
    if (axes.flagMark === 'flagged' && !isFlaggedOnly(r)) return false
    if (axes.flagMark === 'done' && !isDone(r)) return false
    if (toMeActive && !recipientIsMe(r.to_addr, userEmail)) return false
    if (axes.hasAttach && (r.attach_count ?? 0) <= 0) return false
    if (axes.failed && r.sync_status !== 'failed' && r.sync_status !== 'dead_letter') return false
    return true
  })
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
 *  is the verbatim emoji-prefixed Chinese label so `Set.has()` works.
 *
 *  issue #63: the backend no longer clears out-of-enum categories (users can
 *  define their own via the AI preprocessing prompt), so `ai_category` may be
 *  an arbitrary string. The cast stays unchecked — nothing here validates it,
 *  and the default (all-selected) filter path below short-circuits before any
 *  `Set.has()`. Custom values are only hidden when the user *partially*
 *  selects categories; an "other" bucket in the filter popover is batch 2. */
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
  /** 发件箱锚点分组 (groupBySentAnchor 产出)：head 是**我发出的那封**，children 是它
   *  之前的上下文（严格早于 head，head 不在其中）。
   *
   *  🔴 线程「虚拟头」语义**不适用**于它：那套语义的前提是「head ∈ 线程成员且是最新
   *  一封」，所以折叠行能代表整条线程（聚合旗标/置顶 + 级联写）。发件箱的语义是
   *  「我发了什么 + 当时的上下文」，head 是锚点不是聚合体 —— 套上去会让展开时发件重复
   *  出现，且点旗标会级联改掉一堆我没在看的上下文邮件。见 flattenGroups。 */
  sentAnchor?: boolean
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
            anchorDate: sent.date_received ?? null,
            // 标记来源 —— flattenGroups 据此**不**给它虚拟头语义 (见 ThreadGroup.sentAnchor)。
            sentAnchor: true
          }
    )
  }
  // 发件箱：anchor = 发件时间（head 即发件，无 supplement bump 问题）。
  groups.sort((a, b) => (b.anchorDate ?? '').localeCompare(a.anchorDate ?? ''))
  return groups
}

// ─── 排序（非日期键） ────────────────────────────────────────────────
//
// SQL 已经按排序键取回了「正确的那 N 封」，但 groupByThread / groupBySentAnchor
// 会把行重新捆成线程并按 anchorDate DESC 排 —— 那是日期排序的语义。非日期排序下
// 必须按**线程头**的排序键重排组，否则用户选了「按发件人」看到的仍是日期序。

function threadPinned(g: ThreadGroup, pinnedSet: ReadonlySet<number>): boolean {
  if (pinnedSet.has(g.head.internal_id)) return true
  for (const c of g.children) {
    if (pinnedSet.has(c.internal_id)) return true
  }
  return false
}

/** 排序用的发件人显示值 —— 与 SQL 的 `COALESCE(NULLIF(sender_name,''), sender)` 同义。 */
function senderSortValue(e: EnrichedEmailMeta): string {
  const name = e.sender_name ?? ''
  return (name !== '' ? name : (e.sender ?? '')).toLowerCase()
}

/**
 * 按线程头的排序键给组排序（`'date'` 不走这里 —— 它的组序已由 groupByThread 的
 * anchorDate DESC 定义，重排会把 supplement 不 bump 线程的语义弄丢）。
 *
 * 未分类优先级恒沉底（与两侧 SQL 的 null-guard 首列同语义）；末位比较键恒为
 * internal_id，保证同值行有稳定序。
 */
export function sortThreadGroups(
  groups: ReadonlyArray<ThreadGroup>,
  sortKey: Exclude<EmailSortKey, 'date'>,
  sortDir: EmailSortDir
): ThreadGroup[] {
  const sign = sortDir === 'asc' ? 1 : -1
  const out = groups.slice()
  out.sort((a, b) => {
    if (sortKey === 'importance') {
      const ra = priorityRank(a.head.ai_priority)
      const rb = priorityRank(b.head.ai_priority)
      // 未分类恒最末，与方向无关。
      if ((ra === 0) !== (rb === 0)) return ra === 0 ? 1 : -1
      if (ra !== rb) return (ra - rb) * sign
    } else {
      const va =
        sortKey === 'sender' ? senderSortValue(a.head) : (a.head.subject ?? '').toLowerCase()
      const vb =
        sortKey === 'sender' ? senderSortValue(b.head) : (b.head.subject ?? '').toLowerCase()
      const cmp = va.localeCompare(vb)
      if (cmp !== 0) return cmp * sign
    }
    return (a.head.internal_id - b.head.internal_id) * sign
  })
  return out
}

/**
 * 非日期排序下的分桶：只留「已固定」+ 一个平铺桶（无分组标题）。传入顺序即展示
 * 顺序（调用方已用 sortThreadGroups 排好）。
 */
export function partitionFlat(
  groups: ReadonlyArray<ThreadGroup>,
  pinnedSet: ReadonlySet<number>
): Record<GroupKey, ThreadGroup[]> {
  const buckets: Record<GroupKey, ThreadGroup[]> = {
    pinned: [],
    flat: [],
    today: [],
    yesterday: [],
    thisWeek: [],
    lastWeek: [],
    older: []
  }
  for (const g of groups) {
    if (threadPinned(g, pinnedSet)) buckets.pinned.push(g)
    else buckets.flat.push(g)
  }
  return buckets
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
    flat: [],
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
  const isThreadPinned = (g: ThreadGroup): boolean => threadPinned(g, pinnedSet)

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
  const order: GroupKey[] = [
    'pinned',
    'flat',
    'today',
    'yesterday',
    'thisWeek',
    'lastWeek',
    'older'
  ]
  const out: ListRow[] = []
  for (const key of order) {
    const groupArr = buckets[key]
    if (groupArr.length === 0) continue
    // 'flat'（非日期排序的平铺桶）不出标题也不可折叠 —— 它不是一个「分组」，
    // 是「剩下的全部」。给它一个「全部 · N」标题只会白占一行且无处可点。
    const collapsed = key === 'flat' ? false : collapsedOf(key)
    if (key !== 'flat') {
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
    }
    if (collapsed) continue
    for (const g of groupArr) {
      const isThreadHead = g.threadId !== null && g.children.length > 0
      const expanded = isThreadHead ? isThreadExpanded(g.threadId!) : false
      // 线程虚拟头 (Outlook 语义, 2026-08 owner 拍板): 折叠行不再「就是最新那封」,
      // 而是代表整条线程 —— 它显示最新一封的内容, 但旗标/置顶按**成员聚合**显示,
      // 点击走级联语义 (EmailRow.threadHead)。展开时最新一封也作为子行出现 (见下),
      // 所以同一 internal_id 会出现两行: 虚拟头 + 首个子行。
      // 🔴 发件箱的 sent-anchor 分组不吃这套 (见 ThreadGroup.sentAnchor): 它的 head
      // 是「我发的那封」锚点、不在 children 里, 仍是纯单封语义的可折叠行。
      const virtualHead = isThreadHead && g.sentAnchor !== true
      const members = virtualHead ? [g.head, ...g.children] : g.children
      // bundleSelected — 主题 v3 tweak (2026-07-12 owner 实机 review): 只高亮
      // activeId 命中的那一行, 不再整个 bundle 连坐。唯一例外: 线程**折叠**且
      // activeId 是折叠里的成员时, head 行代表整个 bundle 高亮 (否则选中态
      // 在列表里不可见)。展开态下虚拟头**不**高亮 (由那封自己的子行承担, 否则
      // 同一封会亮两行); sent-anchor / 单封则仍按 internal_id 严格匹配。
      const bundleSelected = virtualHead
        ? !expanded &&
          activeId !== null &&
          (g.head.internal_id === activeId || g.children.some((c) => c.internal_id === activeId))
        : activeId !== null &&
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
              expanded,
              // agg 只给虚拟头 —— sent-anchor 头留 undefined, 消费侧 (EmailRow)
              // 据此走纯单封语义, 结构上不可能把级联写喷到上下文邮件上。
              ...(virtualHead
                ? {
                    agg: {
                      memberIds: members.map((m) => m.internal_id),
                      aggFlagged: members.some((m) => m.is_flagged === true)
                    }
                  }
                : {})
            }
          : undefined
      })
      if (isThreadHead && expanded) {
        // 🔴 虚拟头展开的子行 = 线程**全部**成员 (含最新一封, DESC 序最新在最上) ——
        // 虚拟头是「这条线程」而不是「这封邮件」, 所以最新一封必须能作为一封
        // 独立邮件被点开/操作, 否则展开后它只以聚合形态存在, 单封语义没有落点。
        // sent-anchor 仍只展开上下文 (head 是锚点, 本来就单独占一行)。
        members.forEach((child, childIndex) => {
          out.push({
            type: 'email',
            email: child,
            bundleSelected: child.internal_id === activeId,
            groupKey: key,
            // childIndex 只用于展开时的入场 stagger 延迟 (VirtualRow → CSS 变量)。
            thread: { isHead: false, threadId: g.threadId!, childIndex }
          })
        })
      }
    }
  }
  if (appendLoader) out.push({ type: 'loader' })
  return out
}
