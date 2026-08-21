import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Ban, Plus } from 'lucide-react'

import type { Matter, MatterCreateInput } from '@shared/api/types/matter'
import { useMediaQuery } from '@shared/hooks/useMediaQuery'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { openAttentionFor } from '@shared/lib/matterDerive'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { MatterCreateDialog } from './MatterCreateDialog'
import { MatterDetail } from './MatterDetail'
import { MatterFocus } from './MatterFocus'
import { MatterList } from './MatterList'
import {
  MatterBoardSkeleton,
  MatterDetailSkeleton,
  MattersWorkspaceSkeleton
} from './MatterSkeleton'
import { MatterTagManagerModal } from './MatterTagManagerModal'
import {
  matterLiveListOptions,
  useAttentionAction,
  useGlobalAttention,
  useMatterFlags,
  useMattersApi,
  usePendingMatterUpdates
} from './hooks'
import { refreshMatter } from './matterMutation'
import { readLastSelectedMatterId } from './matterLastSelected'
import { useMatterWorkspace } from './matterWorkspaceStore'
import {
  applyMatterListQuery,
  DEFAULT_MATTER_LIST_QUERY,
  groupMatters,
  MATTER_TAB_ICONS,
  MATTER_TABS,
  matterInScope,
  matterScopeParams,
  orderedMatterIds
} from './matterListQuery'
import { listMatterTagsSafely, MATTER_TAGS_QUERY_KEY } from './matterTags'
import { useMatterNavigation } from './navigation'

const MATTER_LIST_WIDTH_STORAGE_KEY = 'mailagent.matters.listWidth'
const MIN_MATTER_LIST_WIDTH = 280
// E10①（dogfood 轮 2）—— 拖拽上限从 480 提到 560：容器（窗口）宽度足够时，用户要能把清单
// 拖得比原来更宽，行 1 的编号/优先级/状态才有稳定余量、不用总卡在窄变体的挤压边缘。
// V3-10（880 断点）后 560 + 6px 分隔条 + 详情列 minmax(420) 下限 = 986 可能超过 881-985px
// 的窗口 —— 由下方 grid 的 `minmax(280px, var(--matter-list-width))` 弹性列兜住（空间不足时
// 清单列先让步收窄，详情列的 420 下限不破）。
const MAX_MATTER_LIST_WIDTH = 560
const MATTER_LIST_WIDTH_STEP = 16
// E10①—— 首次进入（还没有持久化宽度）时按窗口宽度给一个更宽的起点：镜像设计源码
// app.jsx `listWidthFor = width >= 1440 ? 380 : 336`。原来固定 320（低于 MatterList 自己
// 360px 的窄变体阈值）等于「刚打开就已经处在挤压状态」——这正是①要修的问题本体，不只是
// 抬高手动拖拽的天花板。用户一旦手动拖过，走持久化值，这个函数不再生效。
const WIDE_DESKTOP_BREAKPOINT = 1440
const DEFAULT_MATTER_LIST_WIDTH_WIDE = 380
const DEFAULT_MATTER_LIST_WIDTH_NARROW = 336
// V3-10 —— 「让位给详情」的断点按设计 H3§1 定 880（原 1180）。镜像下方 grid 的
// `max-[880px]:grid-cols-1` 断点（清单/详情单列折叠 = 同一时刻只露一个面）。用它判定
// 「清单与详情是否并排可见」，不是猜一个新数字：数字漂了两处会各说各话。
const WORKSPACE_STACKED_QUERY = '(max-width: 880px)'

function clampMatterListWidth(width: number): number {
  return Math.min(MAX_MATTER_LIST_WIDTH, Math.max(MIN_MATTER_LIST_WIDTH, width))
}

function defaultMatterListWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_MATTER_LIST_WIDTH_NARROW
  return window.innerWidth >= WIDE_DESKTOP_BREAKPOINT
    ? DEFAULT_MATTER_LIST_WIDTH_WIDE
    : DEFAULT_MATTER_LIST_WIDTH_NARROW
}

function readMatterListWidth(): number {
  try {
    if (typeof localStorage === 'undefined') return defaultMatterListWidth()
    const raw = localStorage.getItem(MATTER_LIST_WIDTH_STORAGE_KEY)
    if (raw === null) return defaultMatterListWidth()
    const persisted = Number(raw)
    return Number.isFinite(persisted) ? clampMatterListWidth(persisted) : defaultMatterListWidth()
  } catch {
    return defaultMatterListWidth()
  }
}

function writeMatterListWidth(width: number): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(MATTER_LIST_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // localStorage unavailable — the resized width still works for this session.
  }
}

export function MattersWorkspace(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMattersApi()
  const { mattersEnabled: enabled, matterAgentEnabled, flagsPending } = useMatterFlags()
  const queryClient = useQueryClient()
  // V3-01 —— 左侧 176px 视图列删除，12 档 view 收敛成「事项 / 看板」两 tab + 查询模型
  // （matterListQuery.ts）。默认落看板（≙ 旧默认 view 'focus'）；有有效的「记住上次选中」
  // 记录时 V3-11 的冷启动 effect（见下方 `initialSelectionApplied`）会把它改成 'list'。
  //
  // task 08-20 P0-3 —— 这一组（tab / query / search / selectedId / 折叠组 / 冷启动标记）住在
  // **模块级 store**（matterWorkspaceStore.ts）：本组件随路由切换整树卸载，放 useState 就是
  // 「每次进事项页都先渲染一帧看板、等 `/matters` 回来再翻到清单」的抖动本体，搜索词与筛选
  // 也一并丢。视觉/几何类的本地状态（拖拽宽度、弹窗开关）仍留在组件里 —— 它们没有跨进入的
  // 连续性诉求。
  const tab = useMatterWorkspace((state) => state.tab)
  const setTab = useMatterWorkspace((state) => state.setTab)
  const query = useMatterWorkspace((state) => state.query)
  const setQuery = useMatterWorkspace((state) => state.setQuery)
  const selectedId = useMatterWorkspace((state) => state.selectedId)
  const search = useMatterWorkspace((state) => state.search)
  const setSearch = useMatterWorkspace((state) => state.setSearch)
  const selectMatter = useMatterWorkspace((state) => state.selectMatter)
  const revealMatter = useMatterWorkspace((state) => state.revealMatter)
  const jumpToQuickFilter = useMatterWorkspace((state) => state.applyQuickFilter)
  // V3-11 —— 冷启动的「记住上次选中 / 选第一条」只做一次：数据首次就绪后跑一遍下方 effect
  // 就把这个翻 true，之后 `visible`/`liveMatters` 再怎么变都不再重新挑选（否则用户手动选了
  // 别的事项后，任何一次列表刷新都会把选中悄悄冲回「第一条」）。住在 store 里 ⇒ 切走再回也
  // 不会重挑一次（那正是「回来时选中被冲掉」的老毛病）。
  const initialSelectionApplied = useMatterWorkspace((state) => state.initialSelectionApplied)
  const markInitialSelectionApplied = useMatterWorkspace(
    (state) => state.markInitialSelectionApplied
  )
  // 快捷筛选「有到期 / 逾期」的基准时刻，挂载时冻结（react-hooks/purity），与 MatterList 同模式。
  const [now] = useState(() => Date.now())
  const [matterListWidth, setMatterListWidth] = useState(readMatterListWidth)
  const [createOpen, setCreateOpen] = useState(false)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [reviewTarget, setReviewTarget] = useState<{ matterId: string; updateId: number } | null>(
    null
  )
  const navigationTarget = useMatterNavigation((state) => state.targetPublicId)
  const clearNavigationTarget = useMatterNavigation((state) => state.clear)
  // E10③—— 清单与详情并排可见（>880px）时详情页的上/下切换钮不再需要：用户可以直接点清单里
  // 的另一行。只在窄屏折叠成单列、详情独占视口时才露出（design detail.jsx:174 `narrow &&
  // <PrevNext.../>` 同一判据）。
  const stackedLayout = useMediaQuery(WORKSPACE_STACKED_QUERY)
  const workspaceGridRef = useRef<HTMLDivElement>(null)
  const resizeDragRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
    currentWidth: number
    previousCursor: string
    previousUserSelect: string
  } | null>(null)

  const finishMatterListResize = useCallback((target: HTMLDivElement, pointerId: number): void => {
    const drag = resizeDragRef.current
    if (!drag || drag.pointerId !== pointerId) return
    resizeDragRef.current = null
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    document.body.style.cursor = drag.previousCursor
    document.body.style.userSelect = drag.previousUserSelect
    setMatterListWidth(drag.currentWidth)
    writeMatterListWidth(drag.currentWidth)
  }, [])

  useEffect(
    () => () => {
      const drag = resizeDragRef.current
      if (!drag) return
      document.body.style.cursor = drag.previousCursor
      document.body.style.userSelect = drag.previousUserSelect
    },
    []
  )

  // 活跃行（deleted/archived 皆 NULL）—— 看板、open/done 两个 scope、提案扇出都吃这一份。
  // options 单源在 matterLiveListOptions（与启动预热共用, 防 key 漂移）; 缓存配方
  // 的理由见工厂头注。placeholderData 让筛选 scope 切换时旧行原地留着（data 不塌成
  // undefined → 列表不闪空态）。
  const liveList = useQuery({
    ...matterLiveListOptions(api),
    enabled,
    placeholderData: keepPreviousData
  })
  const liveMatters = useMemo(() => liveList.data?.items ?? [], [liveList.data])
  // V3-03 —— archived/trash 两个 scope 的行**必须**由服务端参数取回：服务端默认子句
  // `deleted_at IS NULL AND archived_at IS NULL`，那两类行从来不在活跃页里（这正是
  // 「已归档 / 回收站恒为空」既存 bug 的根因，接上参数即修）。
  const scopeOnServer = query.scope === 'archived' || query.scope === 'trash'
  const scopedList = useQuery({
    queryKey: qk.matters.list(query.scope),
    queryFn: () => api.list({ ...matterScopeParams(query.scope), limit: 100 }),
    enabled: enabled && scopeOnServer,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    placeholderData: keepPreviousData
  })
  const scopeRows = scopeOnServer ? (scopedList.data?.items ?? []) : liveMatters
  const scopeReady = scopeOnServer ? scopedList.isSuccess : liveList.isSuccess

  const attentionQuery = useGlobalAttention(enabled)
  const attentionItems = useMemo(
    () => attentionQuery.data?.items ?? [],
    [attentionQuery.data?.items]
  )
  const attentionIndex = useMemo(() => {
    const index = new Map<string, typeof attentionItems>()
    for (const signal of attentionItems) {
      const matterId = signal.matter?.public_id
      if (!matterId) continue
      index.set(matterId, [...(index.get(matterId) ?? []), signal])
    }
    return index
  }, [attentionItems])
  // 待审提案：**一个**请求覆盖全部活跃事项（服务端聚合端点 `GET /matters/updates`）。
  // 原来这里是 N+1 扇出（每条事项一次 listUpdates + 每条提案一次 getUpdate，上限 100+），
  // 把 6 个 loopback 连接槽占满、详情的前台请求全排它后面。「活跃」的判据同时也从这里的
  // 客户端过滤搬到了服务端（`deleted_at IS NULL AND archived_at IS NULL`，同一口径），
  // 顺带修掉「queryFn 闭包捕获 liveMatters 但 key 里没有它」的脱钩 —— queryFn 现在不依赖
  // 任何组件状态，key 与数据自然对齐。
  const pendingUpdates = usePendingMatterUpdates(enabled && matterAgentEnabled)
  const updateIndex = useMemo(
    () =>
      new Map(
        (pendingUpdates.data?.items ?? []).map(
          (entry) => [entry.matter_public_id, entry.updates] as const
        )
      ),
    [pendingUpdates.data]
  )
  // 标签定义只喂筛选菜单的「标签」二级面板（V3-04：标签作为**临时筛选条件**回归 ——
  // 轮 3 删的是「标签作为导航入口/view」，owner 拍板这是有意反转，不是回滚）。
  const tagsQuery = useQuery({
    queryKey: MATTER_TAGS_QUERY_KEY,
    queryFn: () => listMatterTagsSafely(api),
    // task 08-20 P0-3 —— 去掉 `tab === 'list'` 闸：它把标签请求推迟到「切到清单那一刻」，
    // 于是筛选菜单第一次打开时标签面板还是空的。这份缓存是全局共享的（MatterDetail 用同一个
    // key），5 分钟 staleTime + 低频写，早发一次的成本远小于晚到一层的抖动。
    enabled,
    // 标签定义是低频写（标签管理弹窗写完直接 invalidate MATTER_TAGS_QUERY_KEY）。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
  const tagDefinitions = tagsQuery.data?.items ?? []

  const queryContext = useMemo(
    () => ({ attention: attentionIndex, updates: updateIndex, now }),
    [attentionIndex, now, updateIndex]
  )
  // 清单渲染与详情上下条导航共用同一份可见集（单一调用点 —— 旧结构里工作台与 MatterList
  // 各算一遍 getOrderedVisibleMatters、注释里要求人肉同步，这里顺带把那个疣收掉）。
  const visible = useMemo(
    () => applyMatterListQuery(scopeRows, query, search, queryContext),
    [query, queryContext, scopeRows, search]
  )
  // V3-05 —— 详情页上/下条导航按**分组后的视觉顺序**走：分组会重排行的先后（标签维度还会让
  // 同一行出现在多个组里），仍按扁平序导航的话「下一条」会跳到屏幕上别处。两处都过
  // `groupMatters` 这一个函数，序不可能劈叉；`orderedMatterIds` 顺带把标签维度的重复 id 去掉
  // （MatterDetail 用 indexOf 定位当前条，重复 id 会让计数虚高、翻页原地打转）。
  const visibleIds = useMemo(
    () => orderedMatterIds(groupMatters(visible, query.group, now)),
    [now, query.group, visible]
  )

  // V3-07（缩减版，owner 拍板）—— 头部只显示「命中数 / 范围总数」，菜单内不做逐项计数。
  // archived/trash 的范围总数 = 服务端 meta.total（该 scope 请求 where 子句下的总行数，恒准）。
  // open/done 服务端表达不了（status 单值过滤装不下 IN/NOT IN {done,canceled}），只能在取回
  // 的活跃页上数 —— 仅当活跃行没被 limit=100 截断时这个数才是准的；截断时宁可不显示（null）
  // 也不显示一个错的数（owner 原话：错的数字比没有数字更糟）。
  const scopeTotal = useMemo((): number | null => {
    if (scopeOnServer) return scopedList.data?.total ?? null
    const liveTotal = liveList.data?.total ?? null
    if (liveTotal !== null && liveTotal > liveMatters.length) return null
    return liveMatters.filter((matter) => matterInScope(matter, query.scope)).length
  }, [liveList.data?.total, liveMatters, query.scope, scopeOnServer, scopedList.data?.total])

  // V3-01 —— 看板 tab 的 badge = 开放关注信号数 + 待审阅提案数（H3§1，--c-crit 语气）。
  const reviewPendingCount = useMemo(
    () =>
      [...updateIndex.values()].reduce(
        (count, items) => count + items.filter((item) => item.review_status === 'pending').length,
        0
      ),
    [updateIndex]
  )
  const boardBadge =
    attentionItems.filter((signal) => signal.state === 'open').length + reviewPendingCount

  // 行点击的回调要引用稳定：它进 MatterList 的 `rowProps`，每次 render 换一个新函数会让
  // react-window 把可见行全部重渲一遍（虚拟化省下来的那点开销正好还回去）。
  const handleSelectMatter = useCallback(
    (matter: Matter): void => selectMatter(matter.public_id),
    [selectMatter]
  )

  const attentionAction = useAttentionAction()

  const handleAttentionAction = (
    matterId: string,
    signalId: number,
    action: 'resolved' | 'snoozed' | 'dismissed'
  ): void => {
    attentionAction.mutate(
      { matterId, signalId, action },
      {
        onSuccess: () => toastSuccess(t(`matters.attention.toast.${action}`)),
        onError: (error) => toastError(t('matters.attention.toast.failed'), errorMessage(error))
      }
    )
  }

  // 「展示某个具体事项」（看板卡片 / 深链 / 新建落点）与「看板 tile 跳转」都是 store 里的
  // 组合 action（`revealMatter` / `applyQuickFilter`，见 matterWorkspaceStore.ts）：它们要
  // 一次改动 tab + 筛选 + 选中三项，拆成三次 setState 会多渲染两帧中间态。

  // V3-11 —— 冷启动「记住上次选中 / 选第一条」（设计 H3§1），只跑一次（见
  // `initialSelectionApplied` 声明处的理由）。
  //
  // 深链跳转（下面的 `navigationTarget` effect）优先级更高：命中时只把自己标记为「已处理」
  // 就直接让路，不跟它抢 `selectedId`/`tab` —— 两个 effect 都跑、谁的 setState 后执行谁赢，
  // 行为会随时序抖动，不如显式判断谁该让谁。
  //
  // 恢复的判据只认「当前 scope（冷启动 = 默认 open）的可见集」，直接用
  // `DEFAULT_MATTER_LIST_QUERY` 现算一遍（不读 `visible`/`query` 这两个可能已被用户改动的
  // 活变量）——owner 拍板：不为了凑一个恢复结果去偷偷切用户的 scope/筛选；存的那条如果已被
  // 归档/删除/推进到 done，就在这份候选集里缺席，自然退化成「无记录 → 选第一条」。
  //
  // 🔴 task 08-20：这一条用 `useLayoutEffect`。状态提升已经消掉了「每次进入都翻一遍」，剩下
  // 每个应用会话的**第一次**：数据落地那一帧 tab 还是 'board'，普通 effect 会让真看板先被画
  // 出来一帧再翻到清单。layout effect 在浏览器绘制前跑完，那一帧不会上屏。
  useLayoutEffect(() => {
    if (initialSelectionApplied || !liveList.isSuccess) return
    markInitialSelectionApplied()
    if (navigationTarget) return
    const candidates = applyMatterListQuery(
      liveMatters,
      DEFAULT_MATTER_LIST_QUERY,
      '',
      queryContext
    )
    const stored = readLastSelectedMatterId()
    if (stored && candidates.some((matter) => matter.public_id === stored)) {
      selectMatter(stored)
      setTab('list')
    } else if (candidates.length > 0) {
      selectMatter(candidates[0].public_id)
    }
  }, [
    initialSelectionApplied,
    liveList.isSuccess,
    liveMatters,
    markInitialSelectionApplied,
    navigationTarget,
    queryContext,
    selectMatter,
    setTab
  ])

  // 「选中项掉出可见集就丢选中」守卫（旧左轨语义的等价保留）。scope 数据未就绪（archived/
  // trash 切入的首次请求在途）时不判 —— 瞬时空集不该吞掉刚设好的选中。
  useEffect(() => {
    if (!selectedId || !scopeReady) return
    if (!visible.some((matter) => matter.public_id === selectedId)) selectMatter(null)
  }, [scopeReady, selectMatter, selectedId, visible])

  // 深链跳转（`useMatterNavigation`）：一次性目标，命中后立即清空——切到「事项」tab、展开该
  // 事项详情，并压过上面的冷启动初选（见上方注释）。
  useEffect(() => {
    if (!navigationTarget) return
    const target = liveMatters.find((matter) => matter.public_id === navigationTarget)
    if (!target) return
    revealMatter(target)
    clearNavigationTarget()
  }, [clearNavigationTarget, liveMatters, navigationTarget, revealMatter])

  const create = useMutation({
    mutationFn: (input: MatterCreateInput) => api.create(input),
    onSuccess: async (result) => {
      setCreateOpen(false)
      await refreshMatter(queryClient, result.matter?.public_id ?? null)
      if (result.matter) revealMatter(result.matter)
      // G-33 —— 设计 §2.23：创建后的这一句同时是「其余可以随后补齐」的教学位。
      // 🔴 不带撤销：后端确实给了「移入废纸篓」的 undo descriptor，但这里刚刚把用户**导航到
      // 了新建的事项详情**，撤销等于当场把他正看着的东西删掉；设计那张表也没给创建配撤销。
      toastSuccess(t('matters.toast.created'))
    },
    onError: (error) => toastError(t('matters.toast.createFailed'), errorMessage(error))
  })

  // task 08-20 P0-3 —— 总闸**未知**（`/chat/config` 还在飞）时出整页骨架，而不是白屏：
  // 事项页的 chunk 有 591KB，加上这一次请求，`return null` 那段白屏肉眼可见。
  // 🔴 确定「事项已禁用」时仍然 null —— 骨架的意思是「马上就有内容」，对一个关掉的模块永远
  // 等不到，那是欺骗（也是为什么判据取 `flagsPending` 而不是 `!enabled`）。
  if (!enabled) return flagsPending ? <MattersWorkspaceSkeleton tab={tab} /> : null

  const selected = selectedId
    ? (scopeRows.find((matter) => matter.public_id === selectedId) ?? null)
    : null
  // 首屏还没有任何行 = 冷启动，出骨架；有行（含 keepPreviousData 留下的上一批）就照常渲染。
  const rowsPending = scopeOnServer ? scopedList.isPending : liveList.isPending

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* V3-01/V3-02 —— 42px 模块 tab 栏（设计 `list.jsx::ModuleTabs`）：事项 / 看板 两 tab +
          右侧常驻「新建事项」主按钮。它是唯一常驻的创建入口（无 ⌘N、无第二条路径），
          从旧左轨顶部移到这里，不可省。 */}
      <div className="flex h-[42px] shrink-0 items-center gap-0.5 border-b border-ink-border bg-ink-1/45 pl-2 pr-3">
        <div
          role="tablist"
          aria-label={t('matters.nav')}
          className="flex h-full items-center gap-0.5"
        >
          {MATTER_TABS.map((value) => {
            const Icon = MATTER_TAB_ICONS[value]
            const active = tab === value
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(value)}
                className={cn(
                  'relative flex h-full items-center gap-1.5 px-3 text-body transition-colors duration-fast',
                  active ? 'font-medium text-ink-fg' : 'text-ink-fg-1 hover:text-ink-fg'
                )}
              >
                <Icon size={14} />
                {t(`matters.moduleTabs.${value}`)}
                {value === 'board' && boardBadge > 0 ? (
                  <span className="min-w-[15px] rounded-full bg-crit px-1 text-center font-mono text-[10.5px] font-semibold leading-[15px] text-white">
                    {boardBadge}
                  </span>
                ) : null}
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-t-sm bg-coral/100"
                  />
                ) : null}
              </button>
            )
          })}
        </div>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] bg-coral/100 px-3 py-1.5 text-body font-medium text-accent-fg"
        >
          <Plus size={15} />
          {t('matters.create.submit')}
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'board' && rowsPending && liveMatters.length === 0 ? (
          // 看板冷启动 —— 不出真看板：`matters=[]` 时四个 tile 全是 0、关注区还会显示一句
          // 「全部处理完了」，那是**误导性空态**（与清单的「暂无事项」同一类问题）。
          <MatterBoardSkeleton />
        ) : tab === 'board' ? (
          <MatterFocus
            matters={liveMatters}
            signals={attentionItems}
            updates={updateIndex}
            onSelect={revealMatter}
            onReview={(matter, updateId) => {
              revealMatter(matter)
              setReviewTarget({ matterId: matter.public_id, updateId })
            }}
            onSignal={handleAttentionAction}
            onJump={jumpToQuickFilter}
          />
        ) : (
          <div
            ref={workspaceGridRef}
            // V3-10 —— 单列折叠断点按设计定 880；清单列用 minmax(280, 拖拽宽) 弹性轨：881-985px
            // 的窗口里拖到 560 的清单先让步收窄，详情列 minmax(420,1fr) 的下限不破。
            className="grid h-full min-h-0 grid-cols-[minmax(280px,var(--matter-list-width))_6px_minmax(420px,1fr)] max-[880px]:grid-cols-1"
            style={{ '--matter-list-width': `${matterListWidth}px` } as React.CSSProperties}
          >
            <div className={cn('min-h-0', selected && 'max-[880px]:hidden')}>
              <MatterList
                matters={visible}
                query={query}
                onQueryChange={setQuery}
                scopeTotal={scopeTotal}
                tags={tagDefinitions}
                // V3-05 —— 清单的分组与工作台的筛选/排序/导航序必须同一个「此刻」：
                // MatterList 随 tab 切换卸载重挂，自持一份的话跨零点会与 visibleIds 劈叉。
                now={now}
                selectedId={selectedId}
                attention={attentionIndex}
                updates={updateIndex}
                search={search}
                loading={rowsPending}
                onSearchChange={setSearch}
                onSelect={handleSelectMatter}
                onCreate={() => setCreateOpen(true)}
                onManageTags={() => setTagManagerOpen(true)}
              />
            </div>
            <div
              role="separator"
              aria-label={t('matters.list.resize')}
              aria-orientation="vertical"
              aria-valuemin={MIN_MATTER_LIST_WIDTH}
              aria-valuemax={MAX_MATTER_LIST_WIDTH}
              aria-valuenow={matterListWidth}
              tabIndex={0}
              className="group relative z-10 cursor-col-resize touch-none outline-none max-[880px]:hidden"
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                resizeDragRef.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startWidth: matterListWidth,
                  currentWidth: matterListWidth,
                  previousCursor: document.body.style.cursor,
                  previousUserSelect: document.body.style.userSelect
                }
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
              }}
              onPointerMove={(event) => {
                const drag = resizeDragRef.current
                if (!drag || drag.pointerId !== event.pointerId) return
                const nextWidth = clampMatterListWidth(
                  drag.startWidth + event.clientX - drag.startX
                )
                drag.currentWidth = nextWidth
                workspaceGridRef.current?.style.setProperty('--matter-list-width', `${nextWidth}px`)
              }}
              onPointerUp={(event) => finishMatterListResize(event.currentTarget, event.pointerId)}
              onPointerCancel={(event) =>
                finishMatterListResize(event.currentTarget, event.pointerId)
              }
              onLostPointerCapture={(event) =>
                finishMatterListResize(event.currentTarget, event.pointerId)
              }
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const delta =
                  event.key === 'ArrowLeft' ? -MATTER_LIST_WIDTH_STEP : MATTER_LIST_WIDTH_STEP
                const nextWidth = clampMatterListWidth(matterListWidth + delta)
                workspaceGridRef.current?.style.setProperty('--matter-list-width', `${nextWidth}px`)
                setMatterListWidth(nextWidth)
                writeMatterListWidth(nextWidth)
              }}
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-ink-border transition-colors group-hover:bg-coral/70 group-focus-visible:bg-coral/70" />
            </div>
            <div className={cn('min-h-0', !selected && 'max-[880px]:hidden')}>
              {selected ? (
                <MatterDetail
                  matterId={selected.public_id}
                  onBack={() => selectMatter(null)}
                  onRemoved={() => selectMatter(null)}
                  navigationMatterIds={visibleIds}
                  // E10③—— 并排可见时不传 onNavigateMatter：MatterDetail 的
                  // `showNavigation` 判据里 `Boolean(onNavigateMatter)` 是硬门槛，undefined
                  // 就等于「没有导航能力」，上/下切换钮整体不渲染（MatterDetail 内部逻辑一字
                  // 不动，从调用方把控制权收掉）。
                  onNavigateMatter={stackedLayout ? selectMatter : undefined}
                  attentionSignals={openAttentionFor(selected, attentionIndex)}
                  onAttentionAction={handleAttentionAction}
                  initialReviewId={
                    reviewTarget?.matterId === selected.public_id ? reviewTarget.updateId : null
                  }
                  onReviewOpened={() => setReviewTarget(null)}
                />
              ) : rowsPending && scopeRows.length === 0 ? (
                // 冷启动还没有行 ⇒ 也还没有选中项，这时候的「未选中事项」是误导（用户什么都
                // 还没来得及点）。与清单列同步出骨架，等行到了冷启动初选会自己选中一条。
                <MatterDetailSkeleton />
              ) : (
                <div className="grid h-full place-items-center p-8 text-center text-body text-ink-fg-2">
                  <div>
                    <Ban size={28} className="mx-auto mb-3 opacity-60" />
                    {t('matters.detail.empty')}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <MatterCreateDialog
        open={createOpen}
        busy={create.isPending}
        onClose={() => setCreateOpen(false)}
        onCreate={(input) => create.mutate(input)}
        onUseExisting={(candidate) => {
          setCreateOpen(false)
          revealMatter(candidate.matter)
        }}
      />
      <MatterTagManagerModal
        open={tagManagerOpen}
        tags={tagDefinitions}
        onOpenChange={setTagManagerOpen}
      />
    </div>
  )
}
