import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Ban } from 'lucide-react'

import type { Matter, MatterCreateInput } from '@shared/api/types/matter'
import { useMediaQuery } from '@shared/hooks/useMediaQuery'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { openAttentionFor } from '@shared/lib/matterDerive'
import { qk } from '@shared/lib/queryKeys'
import { selectActiveTargetId, useTabWorkspace } from '@shared/state/tab-workspace'
import { closeObjectTab } from '@shared/state/tab-workspace-bridge'
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
import { MatterViewNav } from './MatterViewNav'
import {
  matterLiveListOptions,
  useAttentionAction,
  useGlobalAttention,
  useMatterFlags,
  useMattersApi,
  usePendingMatterUpdates
} from './hooks'
import { refreshMatter } from './matterMutation'
import { matterNumericId, registerMatterIdentity } from './matterTabIdentity'
import { readLastSelectedMatterId } from './matterLastSelected'
import { useMatterWorkspace } from './matterWorkspaceStore'
import {
  applyMatterListQuery,
  DEFAULT_MATTER_LIST_QUERY,
  groupMatters,
  matterInScope,
  matterScopeParams,
  orderedMatterIds
} from './matterListQuery'
import { listMatterTagsSafely, MATTER_TAGS_QUERY_KEY } from './matterTags'
import { useMatterNavigation } from './navigation'

// V3-10 —— 「让位给详情」的断点按设计 H3§1 定 880（原 1180）。镜像下方 grid 的
// `max-[880px]:grid-cols-1` 断点（清单/详情单列折叠 = 同一时刻只露一个面）。用它判定
// 「清单与详情是否并排可见」，不是猜一个新数字：数字漂了两处会各说各话。
const WORKSPACE_STACKED_QUERY = '(max-width: 880px)'

export function MattersWorkspace(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMattersApi()
  const { mattersEnabled: enabled, matterAgentEnabled, flagsPending } = useMatterFlags()
  const queryClient = useQueryClient()
  // V3-01 —— 左侧 176px 视图列删除，12 档 view 收敛成「事项 / 今日看板」两个视图 + 查询模型
  // （matterListQuery.ts）。默认落今日看板（≙ 旧默认 view 'focus'）；有有效的「记住上次选中」
  // 记录时 V3-11 的冷启动 effect（见下方 `initialSelectionApplied`）会把它改成 'list'。
  // 08-27 波 2 —— 两个视图的切换入口在二级栏顶部的折叠组（MatterViewNav），不再是通栏 tab 栏。
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

  // 08-27 标签工作区（Lane W）—— 事项双身份索引的注册边缘：列表行带 id + public_id 两个键。
  useEffect(() => {
    for (const matter of liveMatters) registerMatterIdentity(matter.id, matter.public_id)
    for (const matter of scopeRows) registerMatterIdentity(matter.id, matter.public_id)
  }, [liveMatters, scopeRows])

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
    // 点行 = 开标签（去重激活在 store），标题随行数据带上（免得新标签空标题等详情回填）。
    // 🔴 顺带切到清单视图：08-27 波 2 起清单列在看板视图下也在场，不切的话点了行主区还是
    // 看板 —— 看着像「点了没反应」。store 的标签订阅腿在这条路径上帮不上忙（它的判据是
    // 「投影值与当前选中不同」，而这里已经先把选中设好了）。
    (matter: Matter): void => {
      selectMatter(matter.public_id, { title: matter.title })
      setTab('list')
    },
    [selectMatter, setTab]
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
    // 08-27 标签工作区：先注册身份索引（本 layout effect 跑在上面的注册 effect **之前**，
    // 不内联注册的话冷启动初选的标签转发会因索引未命中而落空）。
    for (const matter of liveMatters) registerMatterIdentity(matter.id, matter.public_id)
    // ⓪ 恢复的激活事项标签优先（PRD：冷启动初选不得覆盖恢复的激活标签）。标签指向的
    // 事项不在活跃集（已归档/已删）时退化走原有三路分叉。
    const restoredTarget = selectActiveTargetId(useTabWorkspace.getState(), 'matter')
    if (restoredTarget !== null) {
      const restored = liveMatters.find((matter) => matter.id === restoredTarget)
      if (restored) {
        selectMatter(restored.public_id, { title: restored.title })
        setTab('list')
        return
      }
    }
    const candidates = applyMatterListQuery(
      liveMatters,
      DEFAULT_MATTER_LIST_QUERY,
      '',
      queryContext
    )
    const stored = readLastSelectedMatterId()
    if (stored && candidates.some((matter) => matter.public_id === stored)) {
      // 冷启动初选走 replace：激活位已有事项标签就原位换目标，没有就退化成 openTab。
      selectMatter(stored, { mode: 'replace' })
      setTab('list')
    } else if (candidates.length > 0) {
      selectMatter(candidates[0].public_id, {
        mode: 'replace',
        title: candidates[0].title
      })
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

  // 08-27 波 2 —— 单列折叠（≤880）下谁让位：主区有内容（看板 / 选中的事项）时露主区，
  // 否则露清单列。原判据只有 `selected`，那是「看板是通栏」时代的形状。
  const contentPaneVisible = tab === 'board' || Boolean(selected)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        // V3-10 —— 单列折叠断点按设计定 880；清单列定宽 336px（task 08-27 P1 Lane C 续改：
        // 拖拽调宽体系退役，左列总宽 392 = 导轨 56 + 二级栏 336，切域时左列边界不动）。
        // 08-27 波 2 —— 看板视图也走这套 grid：清单列是事项域的二级栏，不随视图消失
        // （原来 tab='board' 是通栏，左列边界会当场塌回 56）。
        className="grid min-h-0 flex-1 max-[880px]:grid-cols-1 grid-cols-[336px_minmax(420px,1fr)]"
      >
        <div
          className={cn(
            // 🔴 列容器不铺底色：菜单与清单各自铺 `bg-ink-1/55`（MatterList 的 section 自带
            // 一层），这里再铺一层同色会在清单区叠成两层、与菜单区分出一道色差。
            'flex min-h-0 flex-col border-r border-ink-border',
            contentPaneVisible && 'max-[880px]:hidden'
          )}
        >
          <MatterViewNav
            tab={tab}
            boardBadge={boardBadge}
            onSelectTab={setTab}
            onCreate={() => setCreateOpen(true)}
          />
          <div className="min-h-0 flex-1">
            <MatterList
              matters={visible}
              query={query}
              onQueryChange={setQuery}
              scopeTotal={scopeTotal}
              tags={tagDefinitions}
              // V3-05 —— 清单的分组与工作台的筛选/排序/导航序必须同一个「此刻」：
              // MatterList 随路由切换卸载重挂，自持一份的话跨零点会与 visibleIds 劈叉。
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
        </div>
        <div className={cn('min-h-0', !contentPaneVisible && 'max-[880px]:hidden')}>
          {tab === 'board' ? (
            rowsPending && liveMatters.length === 0 ? (
              // 看板冷启动 —— 不出真看板：`matters=[]` 时四个 tile 全是 0、关注区还会显示一句
              // 「全部处理完了」，那是**误导性空态**（与清单的「暂无事项」同一类问题）。
              <MatterBoardSkeleton />
            ) : (
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
            )
          ) : selected ? (
            <MatterDetail
              matterId={selected.public_id}
              onBack={() => selectMatter(null)}
              onRemoved={() => {
                // 对象已被删除/归档：先清本地选中（后继标签接管时会重设），再收掉它的
                // 标签 —— 反过来的话 closeTab 的后继同步刚设好的选中会被 null 冲掉。
                const removedId = matterNumericId(selected.public_id)
                selectMatter(null)
                if (removedId !== null) closeObjectTab('matter', removedId)
              }}
              navigationMatterIds={visibleIds}
              // E10③—— 并排可见时不传 onNavigateMatter：MatterDetail 的
              // `showNavigation` 判据里 `Boolean(onNavigateMatter)` 是硬门槛，undefined
              // 就等于「没有导航能力」，上/下切换钮整体不渲染（MatterDetail 内部逻辑一字
              // 不动，从调用方把控制权收掉）。
              onNavigateMatter={
                // 详情上/下条 = J/K 同语义：原位换目标（replace），不涨标签数。
                stackedLayout
                  ? (matterId) => selectMatter(matterId, { mode: 'replace' })
                  : undefined
              }
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
