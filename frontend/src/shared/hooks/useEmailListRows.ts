// P1-4 A-2 split (2026-07-10) — EmailList's data pipeline extracted verbatim
// from EmailList.tsx into this hook. Everything that turns store state + IPC
// queries into virtual-list row models lives here:
//   • 5 useQuery (main list / cross-mailbox / pinned-supplement / thread-batch
//     / thread-enriched) + usePollingFallback SSE fallback
//   • derivation chain: enrichedById → threadSupplement → filtered →
//     threadGroups → orderedIds → buckets → rows → rowHeights (+ counts)
//   • paging / silent prefetch (pageCount + lastView render-phase sentinel)
//   • scroll anchoring (listRef / scrollAnchorRef / isAnchoringRef +
//     the two useLayoutEffects) — kept in the same closure as
//     handleRowsRendered because isAnchoringRef is the anchoring↔paging
//     shared ref (B3)
//   • orderedIds side-effects: publishOrderedIds + active-id fallback
//     queueMicrotask (render-phase, intentional)
// EmailList.tsx stays the JSX shell: it calls this hook, mounts the keyboard
// hooks (useEmailKeyboardNav / useInboxActionShortcuts) and assembles
// Header / List / BatchActionBar. The return contract below is the minimal
// set the JSX actually consumes — do not widen it speculatively.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import type { ListImperativeAPI } from 'react-window'

import { INBOX_LABEL, SENT_LABEL, mailboxForView } from '@shared/lib/mailboxSemantics'
import { useActiveEmail } from '@shared/state/active-email'
import { useMailbox } from '@shared/state/mailbox'
import { useEmailFilter, type EmailCategory, type EmailView } from '@shared/state/email-filter'
import { useGroupCollapse, type GroupKey } from '@shared/state/group-collapse'
import { useThreadExpand } from '@shared/state/thread-expand'
import { useBatch } from '@shared/state/batch'
import { usePinned } from '@shared/state/pinned'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useNewlyAddedIds } from '@shared/hooks/useNewlyAddedIds'
import { usePinnedSync } from '@shared/hooks/usePinnedSync'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { gsap, DUR } from '@shared/lib/gsap'
import type { AIPriority, EmailMeta, EnrichedEmailMeta, ListOpts } from '@shared/api/types'
import { qk } from '@shared/lib/queryKeys'
import {
  applyChipFilter,
  applyMultiFilter,
  applyTab,
  categoryOf,
  computeRowHeight,
  flattenGroups,
  groupBySentAnchor,
  groupByThread,
  partitionByDate,
  rowTopOfId,
  type ListRow
} from '@shared/components/email/emailListRows'

// ─── List query opts per Sidebar view ────────────────────────────────
// customMailbox 非空 (多文件夹同步 P3 — 选中某自定义文件夹) 时优先, 列表只拉该
// mailbox (= display_name), 跳过内建 view 语义。
function listOptsForView(view: EmailView, limit: number, customMailbox: string | null): ListOpts {
  if (customMailbox) return { mailbox: customMailbox, limit }
  const mailbox = mailboxForView(view)
  if (mailbox) return { mailbox, limit }
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

export interface UseEmailListRowsReturn {
  /** Flattened virtual-list rows (group headers / emails / loader sentinel). */
  rows: ListRow[]
  /** O(1) pre-budgeted row-height lookup for react-window (§7.1 铁律). */
  getRowHeight: (index: number) => number
  /** Selectable ids in render order — keyboard nav + BatchActionBar. */
  orderedIds: number[]
  activeId: number | null
  newIds: ReadonlySet<number>
  counts: { all: number; unread: number; flagged: number; failed: number }
  categoryCounts: Record<EmailCategory, number>
  priorityCounts: Record<AIPriority, number>
  selectedAllFlagged: boolean
  isLoading: boolean
  isError: boolean
  error: Error | null
  listRef: RefObject<ListImperativeAPI | null>
  handleRowsRendered: (range: { stopIndex: number }) => void
  handleToggleThread: (threadId: string) => void
  handleExpandThread: (threadId: string, headInternalId: number) => void
}

export function useEmailListRows(): UseEmailListRowsReturn {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const activeMailbox = useMailbox((s) => s.active)
  const activeId = useActiveEmail((s) => s.activeInternalId)
  const setActive = useActiveEmail((s) => s.setActive)
  const navTargetId = useActiveEmail((s) => s.navTargetId)
  const clearNavTarget = useActiveEmail((s) => s.clearNavTarget)
  const publishOrderedIds = useActiveEmail((s) => s.setOrderedIds)
  const filter = useEmailFilter((s) => s.filter)
  const view = useEmailFilter((s) => s.view)
  // 多文件夹同步 (P3) — 当前自定义文件夹 (mailbox=display_name); 非空时列表只拉它。
  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const tab = useEmailFilter((s) => s.tab)
  const selectedPriorities = useEmailFilter((s) => s.selectedPriorities)
  const selectedCategories = useEmailFilter((s) => s.selectedCategories)

  // Subscribe to the `collapsed` map itself (not the `isCollapsed` accessor
  // function — the function reference is stable across `toggle()` calls so
  // useMemo dependants would never re-flatten on a click).
  const collapsedMap = useGroupCollapse((s) => s.collapsed)
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

  const selectedIds = useBatch((s) => s.selectedIds)

  const [pageCount, setPageCount] = useState(1)
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
    queryKey: qk.emails.list(view, customMailbox, activeMailbox, fetchLimit),
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
      ? SENT_LABEL
      : view === 'outbox'
        ? INBOX_LABEL
        : null
  const crossQ = useQuery({
    queryKey: qk.emails.cross(crossMailbox, fetchLimit),
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
    queryKey: qk.emails.pinnedSupplement(pinnedList),
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
    if (view === 'outbox' || view === 'drafts' || pinnedSuppScoped.length === 0) return filteredBase
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
  // Scope the "newly added" baseline to the current view + account (issue #33
  // Bug A): switching inbox → outbox / drafts or accounts re-baselines instead
  // of diffing the previous view's ids against the new first page and flashing
  // the whole screen NEW. `viewKey` already folds view + custom folder.
  const newlyAddedKey = `${viewKey}:${activeMailbox ?? ''}`
  const newIds = useNewlyAddedIds(firstPageIds, newlyAddedKey)

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
    (threadId: string): string =>
      view === 'outbox' || view === 'drafts' ? `${view}:${threadId}` : threadId,
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
    queryKey: qk.emails.threadBatch(threadKey),
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
  // Sprint 20 — 线程子邮件 enriched 补全。listByThreads 返回 bare EmailMeta
  // (无 ai_* / snippet)。大线程里老的、或被分页 / focused·other tab
  // 过滤出当前 listEnriched(all) 的成员, enrichedById 命中不到 → 落 enrichDefaults
  // 空壳 → 列表只剩发件人+标题两行, 即便 SQLite 里 body / AI 齐备 (金样本: 收件箱
  // 1000000760, synced + md1749 + 🟡重要, 属 15 封大线程却只显两行)。这里对所有
  // 线程成员 id 批量 listEnriched(by internalIds, 跨 mailbox) 补真实字段:
  // enrichedById (当前 view 最新) 优先, 此补全 query 补差, enrichDefaults 仅真取不到兜底。
  const threadMemberIds = useMemo(() => {
    if (!threadBatch) return [] as number[]
    const set = new Set<number>()
    for (const tid of uniqueThreadIds) {
      const arr = threadBatch[tid]
      if (arr) for (const meta of arr) set.add(meta.internal_id)
    }
    return Array.from(set).sort((a, b) => a - b)
  }, [threadBatch, uniqueThreadIds])
  const threadEnrichedQ = useQuery({
    queryKey: qk.emails.threadEnriched(threadMemberIds),
    queryFn: () =>
      mailApi.email.listEnriched({
        internalIds: threadMemberIds,
        limit: threadMemberIds.length
      }),
    enabled: threadMemberIds.length > 0,
    staleTime: 60_000,
    placeholderData: keepPreviousData
  })
  const threadEnrichedById = useMemo(() => {
    const m = new Map<number, EnrichedEmailMeta>()
    for (const e of threadEnrichedQ.data ?? []) m.set(e.internal_id, e)
    return m
  }, [threadEnrichedQ.data])
  const threadSupplement = useMemo(() => {
    const m = new Map<string, EnrichedEmailMeta[]>()
    if (!threadBatch) return m
    for (const tid of uniqueThreadIds) {
      const data = threadBatch[tid]
      if (!data) continue
      m.set(
        tid,
        data.map(
          (meta) =>
            enrichedById.get(meta.internal_id) ??
            threadEnrichedById.get(meta.internal_id) ??
            enrichDefaults(meta)
        )
      )
    }
    return m
  }, [uniqueThreadIds, threadBatch, enrichedById, threadEnrichedById])

  // 发件箱用 groupBySentAnchor (发件作母邮件 + 之前线程作子邮件); 其余视图
  // 用 groupByThread (线程最新邮件作 head)。
  const threadGroups = useMemo(
    () =>
      view === 'outbox'
        ? groupBySentAnchor(filtered, threadSupplement)
        : // 标旗视图: 标旗邮件离散分布在各线程, threadSupplement 补进来的非标旗
          // 邮件既不在 all (仅标旗) 也无 cross 源 (crossMailbox=null) → enrichDefaults
          // 兜底成 bare (snippet/ai fields 为空), 一旦它是线程最新邮件就
          // 被 groupByThread 选成 head → "非置顶标旗邮件矮行 + 无 AI strip"。标旗
          // 视图语义=只看我标的邮件, 故线程只在标旗邮件之间聚合 (head 必为标旗邮件,
          // enriched 完整), 不 merge 跨邮件补充。草稿视图同理: 每条草稿独立成行
          // (无 cross 源), 不引入线程补充的 bare 邮件。
          groupByThread(
            filtered,
            view === 'flagged' || view === 'drafts' ? EMPTY_THREAD_SUPPLEMENT : threadSupplement
          ),
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

  // #2/codex review MEDIUM: navTargetId 的「解除豁免」移到下方滚动 effect (仅定位成功后
  // 才清), 避免折叠日期组/线程里的目标(在 orderedIds 里但未渲染成 row)被提前清掉 → 滚不到。
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
  // 查表; deps 含 newIds ("NEW" chip 影响 ai-strip)。
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

  // #2 搜索跳转列表联动: 命令面板选搜索结果 → setActive(id,{navTarget:true}) 设 activeId
  // + navTargetId。正文(EmailDetail)按 id 独立加载已能跳, 但列表此前从不滚动定位到该行
  // (只靠 bundleSelected 高亮, 在视口外看不见)。这里用 useLayoutEffect (与上面手风琴锚定
  // 同相位, 在 render-body 的 clearNavTarget 微任务之前同步跑 → navTargetId 此刻仍在,
  // 避开竞态) 把目标行平滑滚入视口 (几何法 rowTopOfId, 不读 DOM)。目标尚未分页到 rows
  // 时 rowTopOfId=null 不滚 + navTargetId 不清 → 列表续拉(escalate 到 800)后 rows 变化
  // 重跑本 effect, 命中即滚 ("加载后跳转")。已在视口内则不滚 (smart align 免多余跳动)。
  // 超出 800 行的极旧邮件不会自动载入 (需 by-id union 补拉, 属边缘场景, 暂留 TODO)。
  useLayoutEffect(() => {
    if (navTargetId === null) return
    const el = listRef.current?.element
    if (!el) return
    const top = rowTopOfId(rows, rowHeights, navTargetId)
    // 目标行尚未渲染(未分页到 / 折叠组或线程里) → 不清 navTargetId, 等 rows 变化重跑本
    // effect(续拉/展开后仍可定位); 仅定位成功才解除豁免。codex review MEDIUM。
    if (top === null) return
    // C5(搜索跳转选中): 不在此处 clearNavTarget。上面的 active-reset 仅在 activeId === navTargetId
    // 时豁免不抢选中; 若在目标行尚未在视口/列表稳定前就清掉 navTargetId, 一次 (navigate 引发的)
    // 重渲会因 orderedIds 还没含目标而把 activeId reset 成 firstId → 跳转目标的高亮被抢走。把
    // clearNavTarget 延后到滚动定型之后 (已在视口 / reduced-motion 则立即), 让选中存活。
    const viewTop = el.scrollTop
    const viewBottom = viewTop + el.clientHeight
    if (top >= viewTop && top <= viewBottom - 40) {
      clearNavTarget()
      return
    }
    const target = Math.max(0, top - el.clientHeight / 2)
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    if (reduce) {
      // 命令式回滚到目标; 规则误判 listRef.element 不可变。
      // eslint-disable-next-line react-hooks/immutability
      el.scrollTop = target
      clearNavTarget()
      return
    }
    isAnchoringRef.current = true
    gsap.to(el, {
      scrollTo: { y: target },
      duration: DUR.base,
      ease: 'standard',
      overwrite: 'auto',
      onComplete: () => {
        isAnchoringRef.current = false
        clearNavTarget()
      }
    })
  }, [navTargetId, rows, rowHeights, clearNavTarget])

  const handleRowsRendered = useCallback(
    (range: { stopIndex: number }) => {
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
    [rows.length, showLoader]
  )

  return {
    rows,
    getRowHeight,
    orderedIds,
    activeId,
    newIds,
    counts,
    categoryCounts,
    priorityCounts,
    selectedAllFlagged,
    isLoading,
    isError,
    error,
    listRef,
    handleRowsRendered,
    handleToggleThread,
    handleExpandThread
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────
function allIdsFirstPage(all: ReadonlyArray<EnrichedEmailMeta>): number[] {
  // Slice the first PAGE_SIZE ids so paginated load-more doesn't flicker
  // every later row as "newly arrived" (useNewlyAddedIds diffs the array
  // by membership; appended ids would all read as new).
  return all.slice(0, PAGE_SIZE).map((r) => r.internal_id)
}

// Sprint 14 round 11 — listByThread returns EmailMeta without AI fields.
// Thread children are rendered with the
// same EmailRow component used by the head, so we widen each row to
// EnrichedEmailMeta with safe defaults.  The empty AI fields make the
// child rows render the simpler layout unless their metadata snippet is present.
function enrichDefaults(m: EmailMeta): EnrichedEmailMeta {
  return {
    ...m,
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
