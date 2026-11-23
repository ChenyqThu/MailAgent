import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  ArrowLeft,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'

import type { ReportAgentConfig } from '@shared/api/types'
import { MATTER_TAG_DEFAULT_COLOR, MATTER_TAG_DEFAULT_SHAPE } from '@shared/api/types/matter'
import type {
  MatterAttentionSignal,
  MatterItemDispatch,
  MatterItemKind,
  MatterResourceListItem,
  MatterTagDefinition,
  MatterUpdateSummary
} from '@shared/api/types/matter'
import { preview } from '@shared/components/agents/schedule/occurrences'
import { sentenceText } from '@shared/components/agents/schedule/sentence'
import { Input } from '@shared/components/ui/input'
import { useEnterAnimation } from '@shared/hooks/useEnterAnimation'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { useShortcut } from '@shared/hooks/useShortcut'
import { cn } from '@shared/lib/cn'
import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import { errorMessage } from '@shared/lib/ipcErrors'
import { formatMatterAgo } from '@shared/lib/matterDerive'
import { qk } from '@shared/lib/queryKeys'
import { useActiveEmail } from '@shared/state/active-email'
import { startMatterChatWithPrompt } from '@shared/state/ai-chat-panel'
import {
  getObjectTabScroll,
  saveObjectTabScroll,
  setObjectTabTitle
} from '@shared/state/tab-workspace-bridge'
import { toastError, toastInfo } from '@shared/state/toast'

import { AddItemModal } from './AddItemModal'
import { AttnBand } from './attention'
import {
  useMatterAgentProfiles,
  useMatterAttention,
  useMatterFlags,
  useMatterItemDispatches,
  useMatterPendingUpdates,
  useMatterRuns,
  useMattersApi,
  useStartMatterRun
} from './hooks'
import { MatterAgentConfigModal } from './MatterAgentConfigModal'
import { MatterContextTab } from './MatterContextTab'
import { MatterProgressLane } from './MatterProgressLane'
import { MatterRunsPane } from './MatterRunsPane'
import { MatterDetailSkeleton } from './MatterSkeleton'
import { MatterTagManagerModal } from './MatterTagManagerModal'
import { MatterTagChip } from './MatterTagMarker'
import { MatterTagPicker } from './MatterTagPicker'
import { MatterUpdateReview } from './MatterUpdateReview'
import { parseMatterSchedule } from './matterSchedule'
import { matterNumericId, registerMatterIdentity } from './matterTabIdentity'
import {
  listMatterTagsSafely,
  MATTER_TAGS_QUERY_KEY,
  matterTagMap,
  mergeMatterTagDefinitions,
  resolveMatterTag
} from './matterTags'
import { MATTER_DETAIL_TAB_ICONS } from './matterVocab'
import { resolveMatterCitationTarget } from './navigation'
import { ResourceDrawer } from './ResourceDrawer'
import { RunOverlay } from './RunOverlay'
import { useMatterUndoToast } from './useMatterUndoToast'
import {
  AgentPill,
  DueDateControl,
  HealthMenu,
  MatterLifecycleBanner,
  MatterPrevNext,
  MatterTypeEditor,
  MatterWaitingBar,
  MenuButton,
  PriorityMenu,
  StatusMenu
} from './detail/MatterDetailControls'
import { GoalCard } from './detail/MatterGoalCard'
import { ItemGroups } from './detail/MatterItemGroups'
import { StateCard } from './detail/MatterStateCard'
import { useMatterDetailMutations } from './detail/useMatterDetailMutations'

/** 模块级常量 = 引用稳定：`?? []` 每次 render 新建数组，会让下游 memo 全部失效。 */
const EMPTY_DISPATCHES: readonly MatterItemDispatch[] = []
const EMPTY_AGENT_PROFILES: readonly ReportAgentConfig[] = []

interface MatterDetailProps {
  matterId: string
  onBack(): void
  onRemoved(): void
  attentionSignals?: readonly MatterAttentionSignal[]
  onAttentionAction?(
    matterId: string,
    signalId: number,
    action: 'resolved' | 'snoozed' | 'dismissed'
  ): void
  initialReviewId?: number | null
  onReviewOpened?(): void
  navigationMatterIds?: readonly string[]
  onNavigateMatter?(matterId: string): void
}

type DetailTab = 'state' | 'context' | 'timeline' | 'runs'

/** tab 条滑动 indicator 的测量（8px 内缩复刻原每按钮下划线的 `inset-x-2`，见渲染处注释）。
 *  `list.clientLeft` 扣掉容器边框 —— indicator 是 absolute(left:0) 挂在 border-box 内，
 *  rect 差值的参照系却是 border-box 外缘，不扣会整体右偏（同 EmailListHeader 的先例）。 */
function measureTabIndicator(
  list: HTMLElement,
  activeEl: HTMLElement
): { left: number; width: number } {
  const listRect = list.getBoundingClientRect()
  const activeRect = activeEl.getBoundingClientRect()
  const INSET = 8
  return {
    left: activeRect.left - listRect.left - list.clientLeft + INSET,
    width: Math.max(0, activeRect.width - INSET * 2)
  }
}

export function MatterDetail({
  matterId,
  onBack,
  onRemoved,
  attentionSignals = [],
  onAttentionAction = () => undefined,
  initialReviewId = null,
  onReviewOpened,
  navigationMatterIds = [],
  onNavigateMatter
}: MatterDetailProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const api = useMattersApi()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const setActiveEmail = useActiveEmail((state) => state.setActive)
  const [tab, setTab] = useState<DetailTab>('state')
  const [addKind, setAddKind] = useState<MatterItemKind>('action')
  const [addOpen, setAddOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<MatterResourceListItem | null>(null)
  const [reviewId, setReviewId] = useState<number | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  // Agent 芯片「下次运行」的基准时刻挂载时冻结（react-hooks/purity：render 期间不许
  // 调 Date.now()）。与 MatterFocus / MatterAgentCard 同一模式。
  const [now] = useState(() => Date.now())
  const [overlayRunId, setOverlayRunId] = useState<number | null>(null)
  const [agentConfigOpen, setAgentConfigOpen] = useState(false)
  // D7 —— tab 面板的进场（见下方渲染处的说明）。`deps:[tab]` 让每次切 tab 重跑一次。
  const tabPanelAnim = useEnterAnimation<HTMLDivElement>({
    from: { autoAlpha: 0, y: 4 },
    duration: DUR.fast,
    deps: [tab]
  })
  // G-32 —— 头部「更多」下拉按菜单档 popIn（从触发按钮那侧长出来），永久删除确认按模态档
  // fadeIn + popIn。两者的内容都只依赖 `matter`（关闭期间不会塌），故进退场都做。
  const moreMenuAnim = useExitAnimation<HTMLDivElement>(moreOpen, {
    backdrop: false,
    from: { autoAlpha: 0, y: -6, scale: 0.97, transformOrigin: 'top right' },
    enterDuration: DUR.fast
  })
  const deleteDialogAnim = useExitAnimation<HTMLDivElement>(deleteOpen, {
    card: '[data-anim-card]'
  })
  // D14（0813 dogfood）—— 「更多」菜单点外部/按 Esc 收起。此前只有再点一次触发器能关：
  // 点正文、切 tab、滚动都留着它挂在右上角。形态照 `EffortPicker` 的先例（同样是
  // `useExitAnimation` 驱动的自绘菜单）：mousedown 判包含 + keydown 判 Escape，
  // 都挂 document 且只在打开期间挂。
  const moreAnchorRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!moreOpen) return undefined
    const onPointer = (event: MouseEvent): void => {
      const anchor = moreAnchorRef.current
      if (anchor && !anchor.contains(event.target as Node)) setMoreOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])
  const { matterAgentEnabled } = useMatterFlags()
  const runsQuery = useMatterRuns(matterId, matterAgentEnabled)
  // 本事项的待审提案 = 工作台那份跨事项聚合缓存的切片，**不是**第二个请求
  // （同 query key ⇒ react-query 只发一次；原来这里另发一次 `/{id}/updates`）。
  const updatesQuery = useMatterPendingUpdates(matterId, matterAgentEnabled)
  const startRun = useStartMatterRun(matterId)
  const profilesQuery = useMatterAgentProfiles(matterAgentEnabled)
  // L4 批次 3 —— 本事项名下的全部行动项派发（一次请求，行内按 item_id 切片）。
  // 逐行各拉一次 = 一屏行动项就是一屏请求。
  const dispatchesQuery = useMatterItemDispatches(matterId, matterAgentEnabled)
  const matterAttentionQuery = useMatterAttention(matterId)
  const navigationIndex = useMemo(
    () => navigationMatterIds.indexOf(matterId),
    [matterId, navigationMatterIds]
  )
  const navigationTotal = navigationMatterIds.length
  const showNavigation = Boolean(onNavigateMatter) && navigationIndex >= 0 && navigationTotal > 0
  const canNavigatePrevious = showNavigation && navigationIndex > 0
  const canNavigateNext = showNavigation && navigationIndex < navigationTotal - 1
  const navigateByOffset = useCallback(
    (offset: -1 | 1): boolean => {
      if (!onNavigateMatter) return false
      const nextMatterId = navigationMatterIds[navigationIndex + offset]
      if (!nextMatterId) return false
      onNavigateMatter(nextMatterId)
      return true
    },
    [navigationIndex, navigationMatterIds, onNavigateMatter]
  )
  const handlePreviousMatter = useCallback(() => {
    navigateByOffset(-1)
  }, [navigateByOffset])
  const handleNextMatter = useCallback(() => {
    navigateByOffset(1)
  }, [navigateByOffset])
  const handlePreviousMatterShortcut = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!navigateByOffset(-1)) return false
      event.preventDefault()
      return true
    },
    [navigateByOffset]
  )
  const handleNextMatterShortcut = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!navigateByOffset(1)) return false
      event.preventDefault()
      return true
    },
    [navigateByOffset]
  )

  useShortcut('k', handlePreviousMatterShortcut, { enabled: canNavigatePrevious })
  useShortcut('j', handleNextMatterShortcut, { enabled: canNavigateNext })

  const detail = useQuery({
    queryKey: qk.matters.detail(matterId),
    queryFn: () => api.get(matterId, ['items', 'progress', 'timeline']),
    // 缓存配方同 useEmailListRows（速赢包 §2）: 详情三件套的实时性靠写侧
    // refreshMatter（invalidate detail 前缀）与 `matter.changed` SSE, 不靠 15s staleTime
    // —— 后者只会让「切走再回 / 在两条事项间来回点」每次都重拉。
    //
    // task 08-20 P0-2 —— `placeholderData: (prev) => prev`: 换选中事项时 key 变，data 会塌成
    // undefined、整个详情面缩成一行「加载中」（跳转体验最差的一处）。留住上一条的内容，等新
    // 数据到达再整体换掉。🔴 占位期间 `matter` 是**上一条**的（public_id / version 都是旧的），
    // 所以下方渲染整棵树 `pointer-events-none`：否则一次点击会带着新 `matterId` + 旧
    // `expectedVersion` 发出去（乐观锁必然打回，还会顺手刷一遍缓存）。
    placeholderData: (previous) => previous,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
  const matter = detail.data?.matter
  const items = detail.data?.items ?? []
  // curated 进展（task 08-25）与全量事件是**两份**数据：前者是「事情的发展脉络」，
  // 后者是操作日志。同一次 detail 请求取回，不各发一次。
  const progress = detail.data?.progress ?? []
  const timeline = detail.data?.timeline ?? []
  // 这两条与 detail 同步换：只给 detail 加占位的话，切换瞬间会出现「标题还是上一条、上下文
  // 却空了」的混搭态（比整体停一拍更容易被读成数据丢了）。
  const resources = useQuery({
    queryKey: qk.matters.resources(matterId),
    queryFn: () => api.listResources(matterId, { includeUnavailable: true }),
    placeholderData: (previous) => previous,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
  const stakeholders = useQuery({
    queryKey: qk.matters.stakeholders(matterId),
    queryFn: () => api.listStakeholders(matterId),
    placeholderData: (previous) => previous,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
  const tagsQuery = useQuery<{ items: MatterTagDefinition[] }>({
    queryKey: MATTER_TAGS_QUERY_KEY,
    queryFn: () => listMatterTagsSafely(api),
    // 与 MattersWorkspace 的同一份标签缓存（同 key）——两处参数保持一致。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
  const resourceItems = resources.data ?? []
  const hasSuggestedResources = resourceItems.some((item) => item.link.confirmed_at === null)
  const stakeholderItems = stakeholders.data ?? []
  const tagItems = useMemo(
    () => mergeMatterTagDefinitions(tagsQuery.data?.items ?? [], matter?.tags ?? []),
    [matter?.tags, tagsQuery.data?.items]
  )
  const tagsByName = useMemo(() => matterTagMap(tagItems), [tagItems])
  const runs = runsQuery.data?.items ?? []
  // 🔴 归档 / 回收站里的事项**不在**聚合端点的口径里（它只查活跃事项），但归档前留下的
  // 待审提案还挂在那儿，而清账入口只有详情页这一个（同 D11「agent flag 关掉仍可清账」）。
  // 所以非活跃事项退回逐事项取一次；活跃事项（进入事项页的常规路径）这条查询恒 disabled，
  // 一个请求都不多发。
  const matterIsLive = matter ? matter.archived_at == null && matter.deleted_at == null : true
  const inactiveUpdates = useQuery({
    queryKey: [...qk.matters.detail(matterId), 'updates', 'pending'],
    queryFn: () => api.listUpdates(matterId, 'pending'),
    enabled: matterAgentEnabled && !matterIsLive,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
  const updates: MatterUpdateSummary[] = matterIsLive
    ? (updatesQuery.data ?? [])
    : (inactiveUpdates.data?.items ?? [])
  const detailAttention = matterAttentionQuery.data?.items ?? attentionSignals
  const profiles = profilesQuery.data ?? []
  const activeRun = runs.find(
    (run) => run.lifecycle_state === 'queued' || run.lifecycle_state === 'running'
  )
  const overlayRun = runs.find((run) => run.id === overlayRunId)
  const detailTabs = useMemo(
    () =>
      (
        [
          'state',
          'context',
          'timeline',
          ...(matterAgentEnabled ? (['runs'] as const) : [])
        ] as const
      ).map((value) => ({
        value,
        count:
          value === 'context'
            ? resourceItems.length + stakeholderItems.length
            : value === 'runs'
              ? runs.length
              : null,
        // 设计 detail.jsx:653 —— 有未确认的 AI 建议资料时，上下文 tab 挂一个 6px `--c-ai` 圆点。
        dot: value === 'context' && hasSuggestedResources
      })),
    [
      hasSuggestedResources,
      matterAgentEnabled,
      resourceItems.length,
      runs.length,
      stakeholderItems.length
    ]
  )
  // 轮 5 dogfood 反馈② —— tab 条选中态改测量式滑动 indicator（同 EmailListHeader
  // `.inbox-tab-indicator` 的 GSAP x/width 滑动技法，motion-gsap.md「已落地」清单已登记
  // 这套手法）：共享的一条 `<span>` 量出目标 tab 的位置再 tween 过去，取代此前每个按钮
  // 各自渲染一条静态下划线（切换时旧的直接消失、新的直接出现，结构上不可能有平移）。
  // `fresh` 判据抄同一处的注释：不能用 ref 标志，React StrictMode 的模拟卸载会跑
  // useGSAP cleanup（revert 掉 gsap.set 写的 inline transform）但保留 ref 值。
  // 依赖含 detailTabs（计数 / AI 圆点出现会改变按钮宽度）与 i18n.language（译文换行宽）。
  const tabListRef = useRef<HTMLDivElement | null>(null)
  const tabIndicatorRef = useRef<HTMLSpanElement | null>(null)
  // ResizeObserver 回调只在 mount 时订阅一次（`deps:[]`），闭包会拿到订阅那一刻的 `tab`；
  // 之后每次 tab 切换都把最新值写进这个 ref，回调读 ref 而不是闭包变量（同 EmailListHeader
  // 的 `valueRef` 先例）。
  const tabRef = useRef(tab)
  const reduceTabMotion = useReducedMotion()
  useGSAP(
    () => {
      tabRef.current = tab
      const list = tabListRef.current
      const indicator = tabIndicatorRef.current
      if (!list || !indicator) return
      const activeEl = list.querySelector<HTMLElement>(`[data-tab="${tab}"]`)
      if (!activeEl) return
      const { left, width } = measureTabIndicator(list, activeEl)
      const fresh = !indicator.style.transform
      if (fresh || reduceTabMotion) {
        gsap.set(indicator, { x: left, width, autoAlpha: 1 })
        return
      }
      gsap.to(indicator, { x: left, width, autoAlpha: 1, duration: DUR.fast, overwrite: 'auto' })
    },
    { dependencies: [tab, detailTabs, reduceTabMotion, i18n.language], scope: tabListRef }
  )
  // 窗口尺寸变化会移动/改变按钮宽度（fluid 布局），需重量指示器。happy-dom 无
  // ResizeObserver → guarded，测试只断言 DOM 存在，不断言几何。
  useEffect(() => {
    const list = tabListRef.current
    if (!list || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => {
      const indicator = tabIndicatorRef.current
      const activeEl = list.querySelector<HTMLElement>(`[data-tab="${tabRef.current}"]`)
      if (!indicator || !activeEl) return
      const { left, width } = measureTabIndicator(list, activeEl)
      gsap.set(indicator, { x: left, width, autoAlpha: 1 })
    })
    ro.observe(list)
    return () => ro.disconnect()
  }, [])

  // ── 08-27 标签工作区（Lane W）────────────────────────────────────────────
  // 🔴 placeholder 期间 detail.data 是**上一条**的（上方 query 头注释），一律以
  // public_id === matterId 收窄后再碰标签面。
  const loadedMatter =
    detail.data?.matter && detail.data.matter.public_id === matterId ? detail.data.matter : null
  // 身份注册（数值 id ↔ public_id）+ 标签标题回填（bridge 同值不写）。
  useEffect(() => {
    if (!loadedMatter) return
    registerMatterIdentity(loadedMatter.id, loadedMatter.public_id)
    if (loadedMatter.title) setObjectTabTitle('matter', loadedMatter.id, loadedMatter.title)
  }, [loadedMatter])
  // 每标签滚动位置：onScroll 只写 ref，切走（matterId 变化 / 卸载）时落一次快照；
  // 切回在详情数据就绪后恢复一次。
  const bodyScrollRef = useRef<HTMLDivElement | null>(null)
  const lastScrollTopRef = useRef(0)
  useEffect(() => {
    const id = matterId
    return () => {
      const numericId = matterNumericId(id)
      if (numericId !== null) saveObjectTabScroll('matter', numericId, lastScrollTopRef.current)
    }
  }, [matterId])
  const scrollRestoredForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!loadedMatter || scrollRestoredForRef.current === matterId) return
    scrollRestoredForRef.current = matterId
    lastScrollTopRef.current = 0
    const stored = getObjectTabScroll('matter', loadedMatter.id)
    const el = bodyScrollRef.current
    if (el && stored > 0) {
      // 命令式恢复滚动位置；规则误判容器不可变。
      el.scrollTop = stored
      lastScrollTopRef.current = el.scrollTop
    }
  }, [loadedMatter, matterId])
  // 切标签/换事项时正文一次淡入（EmailDetail B2 的 fromTo 先例：终点显式 =1，快速连切
  // 打断也收敛到不透明；reduced-motion 短路）。
  useGSAP(
    () => {
      if (reduceTabMotion) return
      const el = bodyScrollRef.current
      if (!el) return
      gsap.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.fast, overwrite: 'auto' })
    },
    { dependencies: [matterId, reduceTabMotion], scope: bodyScrollRef }
  )
  const selectedUpdate = useQuery({
    queryKey: [...qk.matters.detail(matterId), 'update', reviewId],
    queryFn: () => api.getUpdate(matterId, reviewId as number),
    enabled: reviewId != null
  })

  useEffect(() => setReviewError(null), [reviewId])
  useEffect(() => {
    if (initialReviewId == null) return
    setReviewId(initialReviewId)
    onReviewOpened?.()
  }, [initialReviewId, onReviewOpened])
  useEffect(() => {
    if (!titleEditing) setTitleDraft(matter?.title ?? '')
  }, [matter?.title, titleEditing])

  const pushUndoToast = useMatterUndoToast()

  const {
    refresh,
    patch,
    patchAgentConfig,
    transition,
    addItem,
    updateItem,
    setItemProfile,
    renameItem,
    removeItem,
    permanentDelete,
    toggleResourcePin,
    cancelRun,
    reviewMutation
  } = useMatterDetailMutations({
    matterId,
    matter,
    updates,
    reviewId,
    deleteConfirmation,
    setAddOpen,
    setDeleteOpen,
    setReviewId,
    setReviewError,
    onRemoved,
    pushUndoToast
  })

  // task 08-20 P0-2 —— 第一次进来（没有上一条可留）出骨架，不再是一行「加载中」文字。
  // 有 `placeholderData` 之后这条分支只覆盖「首次加载 / 拿不到数据」两种情况。
  if (!matter) return <MatterDetailSkeleton />

  /**
   * 0813 dogfood #17b —— 详情头的「立即跟进」改成**开一场对话**（owner：「类似邮件详情页的
   * 创建事项，直接进入 AI Chat 浮窗，输入指令直接进行对话，也好有个记录」）。
   *
   * 唤出 dock 时带上这件事的身份 chip，并把一条跟进指令作为普通用户消息递进去 —— 与邮件工具栏
   * 「AI 调研创建」同一条注入面，不新造第五条路径。
   *
   * 🔴 与它相邻的 `startFollowUpRun`（无人值守 headless run）**有意留着**：定时触发走它，失效
   * 提案上的「重新跑一轮」也走它 —— 那颗按钮要的正是一份**新提案**，换成对话就把审阅闭环断了。
   */
  const startFollowUpChat = (): void => {
    startMatterChatWithPrompt(
      { id: matter.id, publicId: matter.public_id, title: matter.title },
      t('matters.runs.runNowPrompt', { title: matter.title, publicId: matter.public_id })
    )
  }

  /**
   * 失效提案上的「重新跑一轮」发起一次无人值守跟进 run，并顺手关掉审阅面（否则用户盯着一张
   * 已经作废的提案等新结果）。
   */
  const startFollowUpRun = (onStarted?: () => void): void => {
    startRun.mutate(
      { expectedVersion: matter.version },
      {
        onSuccess: (result) => {
          setOverlayRunId(result.run.id)
          onStarted?.()
          if (result.coalesced) toastInfo(t('matters.runs.coalesced'))
        },
        onError: (error) => toastError(t('matters.runs.startFailed'), errorMessage(error))
      }
    )
  }

  const saveTitle = (): void => {
    const title = titleDraft.trim()
    if (!title || title === matter.title) {
      setTitleDraft(matter.title)
      setTitleEditing(false)
      return
    }
    patch.mutate({ title }, { onSuccess: () => setTitleEditing(false) })
  }

  const openReviewSource = (resourceId: number): void => {
    const item = resourceItems.find((candidate) => candidate.resource.id === resourceId)
    if (!item) return
    const target = resolveMatterCitationTarget(item)
    setReviewId(null)
    if (target.kind === 'email') {
      // navTarget：跨域跳转目标可能不在收件箱列表里，不豁免会被 active-reset 抢走
      //（08-27 标签工作区起被抢 = 刚开出来的邮件标签被 replace 成第一封）。
      setActiveEmail(target.emailId, { navTarget: true })
      void navigate({ to: '/' })
      return
    }
    setDrawerItem(target.item)
  }
  const schedule = parseMatterSchedule(matter.schedule_json)
  const scheduleLabel = schedule ? sentenceText(t, i18n.language || 'zh-CN', schedule.rule) : null
  const nextRun = schedule
    ? preview(schedule.rule, schedule.timezone, schedule.anchor, now, 1).find(
        (entry) => entry.kind === 'run'
      )
    : null
  // 跟进 Agent 自 0811 起是内置的，profile 可为空 ⇒ `agent_enabled` 才是绑定与否的权威。
  const agentBound = matter.agent_enabled === true || matter.agent_enabled === 1
  const agentPillLabel = agentBound
    ? `${
        profiles.find((profile) => profile.id === matter.agent_profile_id)?.title ??
        matter.agent_profile_id ??
        t('matters.agentBinding.title')
      } · ${scheduleLabel ?? t('matters.runs.manual')}${
        nextRun && nextRun.kind === 'run'
          ? ` · ${t('matters.agentBinding.next')} ${new Date(nextRun.utcMs).toLocaleString()}`
          : ''
      }`
    : t('matters.detail.agentUnbound')

  return (
    // `relative` is the containing block for the narrow-layout chat overlay below.
    <div
      className={cn(
        'relative flex h-full min-w-0 bg-ink-0/35 transition-opacity duration-fast',
        // 占位期（显示的还是上一条事项）：压暗一档表示「在换了」，并**冻结交互** ——
        // 此刻 `matterId` 已是新的、`matter.version` 还是旧的，任何一次写都会带着这对
        // 不匹配的组合发出去。等新数据到达自然解冻（一般一两百毫秒）。
        detail.isPlaceholderData && 'pointer-events-none opacity-60'
      )}
      aria-busy={detail.isPlaceholderData || undefined}
    >
      <article className="flex h-full min-w-0 flex-1 flex-col">
        <header className="border-b border-ink-border px-5 py-4">
          <div className="flex items-start gap-3">
            {/* G-03：窄布局（≤880px 单列，V3-10 起断点跟随 MattersWorkspace 的
                `WORKSPACE_STACKED_QUERY`，两处必须同数）下清单列被藏起，这个箭头是回列表的
                唯一出口 —— 所以它必须有名字（图标按钮无 aria-label 对读屏 = 一个叫 "button"
                的东西）。 */}
            <button
              type="button"
              onClick={onBack}
              aria-label={t('matters.shell.backToList')}
              title={t('matters.shell.backToList')}
              className="mt-0.5 hidden rounded-[var(--r-ctl)] p-1.5 text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg max-[880px]:block"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0 flex-1">
              {/* 设计 detail.jsx:110/123 的元信息行：`pub · 类型 · 创建于 <相对时间>`，
                  分隔点是内容不是间距。创建时间设计写的是 fmtAgo（相对），不是绝对日期。 */}
              <div className="flex flex-wrap items-center gap-1.5 text-meta text-ink-fg-2">
                <span className="font-mono">{matter.public_id}</span>
                <span aria-hidden className="text-ink-fg-3">
                  ·
                </span>
                <MatterTypeEditor
                  value={matter.matter_type}
                  busy={patch.isPending}
                  onChange={(matterType) => patch.mutate({ matter_type: matterType })}
                />
                <span aria-hidden className="text-ink-fg-3">
                  ·
                </span>
                <span title={new Date(matter.created_at).toLocaleString()}>
                  {t('matters.detail.created', {
                    date: formatMatterAgo(matter.created_at, now, i18n.language || 'zh-CN')
                  })}
                </span>
              </div>
              <div className="group/title mt-1 flex min-h-8 items-center gap-1.5">
                {titleEditing ? (
                  <>
                    <Input
                      autoFocus
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') saveTitle()
                        if (event.key === 'Escape') {
                          setTitleDraft(matter.title)
                          setTitleEditing(false)
                        }
                      }}
                      aria-label={t('matters.detail.title')}
                      className="h-8 min-w-0 flex-1 px-2 text-subj font-semibold"
                    />
                    <button
                      type="button"
                      disabled={!titleDraft.trim() || patch.isPending}
                      onClick={saveTitle}
                      aria-label={t('matters.actions.save')}
                      className="rounded-[var(--r-ctl)] p-1.5 text-ok transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
                    >
                      <Save size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTitleDraft(matter.title)
                        setTitleEditing(false)
                      }}
                      aria-label={t('matters.actions.cancel')}
                      className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
                    >
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <h1 className="min-w-0 text-subj font-semibold text-ink-fg">{matter.title}</h1>
                    <button
                      type="button"
                      onClick={() => setTitleEditing(true)}
                      aria-label={t('matters.detail.editTitle')}
                      className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 opacity-0 transition-[color,background-color,opacity,transform] duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 active:scale-[0.96] group-hover/title:opacity-100"
                    >
                      <Pencil size={13} />
                    </button>
                  </>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <StatusMenu value={matter.status} onChange={(status) => patch.mutate({ status })} />
                <HealthMenu value={matter.health} onChange={(health) => patch.mutate({ health })} />
                <PriorityMenu
                  value={matter.priority}
                  onChange={(priority) => patch.mutate({ priority })}
                />
                <DueDateControl
                  value={matter.due_at}
                  now={now}
                  saving={patch.isPending}
                  onChange={(due_at) => patch.mutate({ due_at })}
                />
                {/* G-08 等待条（设计 detail.jsx:205-209）：waiting_context / 等待中干系人
                    非空时的 warn 色一行，点击就地编辑或清除（DIRECT_PATCH_FIELDS 通道）。 */}
                <MatterWaitingBar
                  waitingContext={matter.waiting_context}
                  stakeholders={stakeholderItems}
                  saving={patch.isPending}
                  onSave={(waiting_context) => patch.mutate({ waiting_context })}
                />
              </div>
              {/* 轮 3 #8 —— 跟进 pill **完全独立成行、自然左对齐**：轮 2 曾按设计
                  detail.jsx:210 把它塞进上面那行右对齐（`ml-auto`），owner 打回
                  「表现太奇怪了」——pill 的标签长（profile · 排程 · 下次运行），在
                  flex-wrap 行里右浮会随换行跳位。设计源没有第二种版式，按 owner
                  裁决独立成行（adjudication > 设计稿）。 */}
              {/* 🔴 pill 必须是**按钮**（设计 detail.jsx:163 `onClick={ctx.onOpenAgent}`）：
                  它此前是个纯 <span>，而唯一的跟进配置 UI 在 ≥1400px 才渲染的右栏里 ——
                  窗口小一点就完全没有入口（0812 dogfood「无法切换跟进的方式」）。 */}
              <div className="mt-2 flex items-center">
                <AgentPill
                  bound={agentBound}
                  interactive={matterAgentEnabled}
                  label={agentPillLabel}
                  onOpen={() => setAgentConfigOpen(true)}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {matter.tags.map((tag) => (
                  <MatterTagChip
                    key={tag}
                    tag={resolveMatterTag(tagsByName, tag)}
                    disabled={patch.isPending}
                    onRemove={() =>
                      patch.mutate({ tags: matter.tags.filter((value) => value !== tag) })
                    }
                    removeLabel={t('matters.actions.removeTag', { tag })}
                  />
                ))}
                <MatterTagPicker
                  selectedTags={matter.tags}
                  tagDefinitions={tagItems}
                  disabled={patch.isPending}
                  onChange={(tags) => patch.mutate({ tags })}
                  // 轮 3 #2 —— 设计的创建流带 StylePicker：名字进 matter.tags；选了非默认
                  // 样式才 upsert 定义行（`upsert_tag_style` 服务端就是 upsert，行不存在会建；
                  // 默认样式跳过写 = 与旧「加名字即隐式建标签」路径逐字节同）。样式写失败
                  // 不拦标签本身 —— 标签已在，样式仍可去管理器里补。
                  onCreate={(name, color, shape) => {
                    patch.mutate({ tags: [...matter.tags, name] })
                    if (color !== MATTER_TAG_DEFAULT_COLOR || shape !== MATTER_TAG_DEFAULT_SHAPE) {
                      api
                        .setTagStyle(
                          name,
                          { color, shape },
                          { reason: 'user_updated_matter_tag_style' }
                        )
                        .then(() =>
                          queryClient.invalidateQueries({ queryKey: MATTER_TAGS_QUERY_KEY })
                        )
                        .catch((error: unknown) =>
                          toastError(t('matters.toast.saveFailed'), errorMessage(error))
                        )
                    }
                  }}
                  onManage={() => setTagManagerOpen(true)}
                />
              </div>
            </div>
            {showNavigation ? (
              <MatterPrevNext
                current={navigationIndex + 1}
                total={navigationTotal}
                previousLabel={t('matters.detail.previousMatter')}
                nextLabel={t('matters.detail.nextMatter')}
                canPrevious={canNavigatePrevious}
                canNext={canNavigateNext}
                onPrevious={handlePreviousMatter}
                onNext={handleNextMatter}
              />
            ) : null}
            {matterAgentEnabled ? (
              <button
                type="button"
                onClick={startFollowUpChat}
                title={t('matters.runs.runNowChatHint')}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-aux hover:bg-ink-3"
              >
                <Play size={13} /> {t('matters.runs.runNow')}
              </button>
            ) : null}
            <div ref={moreAnchorRef} className="relative">
              <button
                type="button"
                onClick={() => setMoreOpen((value) => !value)}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                aria-label={t('matters.detail.more')}
                title={t('matters.detail.more')}
                className="rounded-[var(--r-ctl)] p-2 hover:bg-ink-3"
              >
                <MoreHorizontal size={17} />
              </button>
              {moreMenuAnim.shouldRender ? (
                /* D14 —— 选中任一项也收起菜单（设计 detail.jsx:13 `onClose(); fn();`）。
                   点外部收起挂在上面那个 effect 上。 */
                <div
                  ref={moreMenuAnim.scopeRef}
                  role="menu"
                  aria-label={t('matters.detail.more')}
                  className="absolute right-0 top-10 z-20 w-48 rounded-[var(--r-card)] border border-ink-border bg-ink-1 p-1 shadow-md"
                >
                  {matter.archived_at === null && matter.deleted_at === null ? (
                    <MenuButton
                      icon={<Archive size={14} />}
                      label={t('matters.actions.archive')}
                      onClick={() => {
                        setMoreOpen(false)
                        transition.mutate('archive')
                      }}
                    />
                  ) : null}
                  {matter.archived_at !== null && matter.deleted_at === null ? (
                    <MenuButton
                      icon={<RotateCcw size={14} />}
                      label={t('matters.actions.restoreArchive')}
                      onClick={() => {
                        setMoreOpen(false)
                        transition.mutate('reopen')
                      }}
                    />
                  ) : null}
                  {matter.deleted_at === null ? (
                    <MenuButton
                      icon={<Trash2 size={14} />}
                      label={t('matters.actions.trash')}
                      danger
                      onClick={() => {
                        setMoreOpen(false)
                        transition.mutate('trash')
                      }}
                    />
                  ) : (
                    <>
                      <MenuButton
                        icon={<RotateCcw size={14} />}
                        label={t('matters.actions.restore')}
                        onClick={() => {
                          setMoreOpen(false)
                          transition.mutate('restore')
                        }}
                      />
                      <MenuButton
                        icon={<Trash2 size={14} />}
                        label={t('matters.actions.permanentDelete')}
                        danger
                        onClick={() => {
                          setMoreOpen(false)
                          setDeleteOpen(true)
                        }}
                      />
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {/* 设计 detail.jsx:641-657 —— 40px 高的下划线 tab 条（选中 = accent 前景 + 600 字重
            + 底部 2px accent 下划线），不是 SegmentedControl 的胶囊轨。设计本身没画滑块，
            下划线改共享 indicator 平移 + 按下轻缩，按 DESIGN.md §9.3 与本仓已有的
            role=tab 同类控件（`ui/segmented.tsx` 的 `.seg button`，同样是 tablist 里的
            测量式滑动 indicator + `active:scale-[0.96]`）推导（轮 5 dogfood 反馈②）。 */}
        <div
          ref={tabListRef}
          role="tablist"
          aria-label={t('matters.tabs.label')}
          className="relative flex h-10 shrink-0 items-center gap-0.5 border-b border-ink-border px-4"
        >
          <span
            ref={tabIndicatorRef}
            aria-hidden
            className="invisible absolute -bottom-px left-0 h-0.5 rounded-full bg-coral/100"
          />
          {detailTabs.map(({ value, count, dot }) => {
            const TabIcon = MATTER_DETAIL_TAB_ICONS[value]
            const active = tab === value
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={active}
                data-tab={value}
                onClick={() => setTab(value)}
                className={cn(
                  'relative inline-flex h-full items-center gap-1.5 px-3 text-body transition-colors duration-fast ease-standard',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
                  'active:scale-[0.96]',
                  active ? 'font-semibold text-coral' : 'text-ink-fg-2 hover:text-ink-fg'
                )}
              >
                <TabIcon size={13} />
                {t(`matters.tabs.${value}`)}
                {count !== null ? (
                  <span className="font-mono text-micro tabular-nums text-ink-fg-3">{count}</span>
                ) : null}
                {dot ? (
                  <span
                    aria-label={t('matters.resource.suggested')}
                    className="size-1.5 rounded-full bg-ai"
                  />
                ) : null}
              </button>
            )
          })}
        </div>

        <div
          ref={bodyScrollRef}
          className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin"
          // 每标签滚动位置的采样面（只写 ref，切走时才落标签快照）。
          onScroll={(e) => {
            lastScrollTopRef.current = e.currentTarget.scrollTop
          }}
        >
          {/* 设计 detail.jsx:230-244 —— 归档 / 回收站的状态条，带就地出口。原先「恢复」与
              「取消归档」只藏在「更多」菜单里，翻到一个已删除的事项时正文毫无提示。 */}
          <MatterLifecycleBanner
            matter={matter}
            busy={transition.isPending}
            now={now}
            locale={i18n.language || 'zh-CN'}
            onRestore={() => transition.mutate(matter.deleted_at !== null ? 'restore' : 'reopen')}
          />
          {updates.length > 0 ? (
            <div className="mb-5 flex items-center gap-3 rounded-[var(--r-card)] border border-ai/25 bg-ai/[0.06] p-4">
              <span className="grid size-8 place-items-center rounded-lg bg-ai/12 text-ai">
                <Sparkles size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium">
                  {t('matters.review.attention', { count: updates[0].change_count })}
                </p>
                <p className="mt-1 text-meta text-ink-fg-2">
                  {new Date(updates[0].created_at).toLocaleString()} · #
                  {updates[0].agent_run_id ?? '—'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReviewId(updates[0].id)}
                className="rounded-lg bg-ai px-3 py-2 text-aux text-white"
              >
                {t('matters.runs.review')}
              </button>
            </div>
          ) : null}
          <div className="mb-5">
            <AttnBand
              matter={matter}
              signals={detailAttention}
              hasProposal={updates.length > 0}
              onAction={onAttentionAction}
            />
          </div>
          {/* D7（0813 dogfood）—— tab 切换过渡。此前是硬替换：点一下整块内容当场换人，
              读起来像跳帧。用 `useEnterAnimation`（进场半条，退场没有意义 —— 旧 tab 的数据
              随 `tab` 一起消失，接退场要把四份数据全保活）+ `key={tab}` 保证每次切换都重新
              挂载、动效从头播。位移只有 4px、只动 transform/opacity，不碰高度（§1 红线）；
              reduced-motion 由 hook 内部短路。 */}
          <div key={tab} ref={tabPanelAnim}>
            {tab === 'state' ? (
              <div className="space-y-5">
                {/* 设计 detail.jsx:663-667 —— 「背景与目标」独立成卡、排在「当前状态」之前
                  （补充规格 §5.1）。这两张卡此前挤在同一张 StateCard 里，且顺序相反。 */}
                <GoalCard
                  matter={matter}
                  saving={patch.isPending}
                  onProseSave={(prose, onSaved) => patch.mutate(prose, { onSuccess: onSaved })}
                  onGoalChecksSave={(goal_checks, onSaved) =>
                    patch.mutate({ goal_checks }, { onSuccess: onSaved })
                  }
                />
                <StateCard
                  matter={matter}
                  pendingCount={updates.length}
                  onReview={() => setReviewId(updates[0]?.id ?? null)}
                  saving={patch.isPending}
                  now={now}
                  locale={i18n.language || 'zh-CN'}
                  onSummarySave={(current_summary, onSaved) =>
                    patch.mutate({ current_summary }, { onSuccess: onSaved })
                  }
                  // G-10 —— 「重新生成摘要」实质 = 触发一次跟进 run；flag 关时只留新鲜度指示。
                  onRegenerate={matterAgentEnabled ? () => startFollowUpRun() : undefined}
                  regenerating={Boolean(activeRun) || startRun.isPending}
                />
                <ItemGroups
                  items={items}
                  stakeholders={stakeholderItems}
                  resources={resourceItems}
                  now={now}
                  locale={i18n.language || 'zh-CN'}
                  matterId={matterId}
                  // 执行契约整块挂事项 Agent 闸：派发就是跑一轮 headless run，
                  // agent 关着的时候画一个派发入口 = 派出去永远不动。
                  dispatchEnabled={matterAgentEnabled}
                  dispatches={dispatchesQuery.data ?? EMPTY_DISPATCHES}
                  agentProfiles={profilesQuery.data ?? EMPTY_AGENT_PROFILES}
                  onSetItemProfile={(item, profile) => setItemProfile.mutate({ item, profile })}
                  onReviewUpdate={setReviewId}
                  busy={renameItem.isPending || removeItem.isPending || updateItem.isPending}
                  onToggle={(item) =>
                    updateItem.mutate({ item, status: item.status === 'done' ? 'open' : 'done' })
                  }
                  onAdd={(kind) => {
                    setAddKind(kind)
                    setAddOpen(true)
                  }}
                  onRename={(item, title) => renameItem.mutate({ item, title })}
                  onDelete={(item) => removeItem.mutate(item)}
                  onOpenResource={setDrawerItem}
                />
              </div>
            ) : tab === 'context' ? (
              <MatterContextTab
                matter={matter}
                items={items}
                resources={resourceItems}
                stakeholders={stakeholderItems}
                onOpenResource={setDrawerItem}
                onTogglePin={(item) => toggleResourcePin.mutate(item)}
                onChanged={() => void refresh()}
              />
            ) : tab === 'runs' ? (
              <MatterRunsPane
                runs={runs}
                updates={updates}
                onReview={setReviewId}
                onCancel={(runId) => cancelRun.mutate(runId)}
              />
            ) : (
              <MatterProgressLane
                matterId={matterId}
                matterVersion={matter.version}
                entries={progress}
                events={timeline}
                locale={i18n.language || 'zh-CN'}
              />
            )}
          </div>
        </div>

        <AddItemModal
          key={`${addKind}-${addOpen ? 'open' : 'closed'}`}
          open={addOpen}
          initialKind={addKind}
          busy={addItem.isPending}
          onClose={() => setAddOpen(false)}
          onAdd={(input) => addItem.mutate(input)}
        />

        <MatterTagManagerModal
          open={tagManagerOpen}
          tags={tagItems}
          onOpenChange={setTagManagerOpen}
        />

        {deleteDialogAnim.shouldRender ? (
          <div
            ref={deleteDialogAnim.scopeRef}
            className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          >
            <section
              data-anim-card
              role="dialog"
              aria-modal="true"
              className="w-full max-w-md rounded-[var(--r-card)] border border-fail/30 bg-ink-1 p-5 shadow-md"
            >
              <h2 className="text-lead font-semibold text-fail">{t('matters.delete.title')}</h2>
              <p className="mt-2 text-body text-ink-fg-1">
                {t('matters.delete.hint', { id: matter.public_id })}
              </p>
              <input
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                className="mt-4 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 font-mono text-body"
              />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteOpen(false)}
                  className="rounded-[var(--r-ctl)] px-3 py-2 text-body hover:bg-ink-3"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={deleteConfirmation !== matter.public_id || permanentDelete.isPending}
                  onClick={() => permanentDelete.mutate()}
                  className="rounded-[var(--r-ctl)] bg-fail px-3 py-2 text-body font-medium text-accent-fg disabled:opacity-50"
                >
                  {t('matters.actions.permanentDelete')}
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </article>
      {/* 右侧上下文抽屉已移除（0812 dogfood D-D：与「上下文」tab 重复，且它 ≥1400px 才
          渲染，把跟进配置藏在窗口宽度后面）。它独有的三样东西各自迁走：绑定卡 →
          MatterAgentConfigModal；资料置顶钮 / 置顶分区 / 按 kind 取图标 → MatterContextTab。 */}
      {agentConfigOpen ? (
        <MatterAgentConfigModal
          matter={matter}
          runs={runs}
          profiles={profiles}
          onPatch={(input, expectedVersion) =>
            patchAgentConfig.mutateAsync({ input, expectedVersion })
          }
          onClose={() => setAgentConfigOpen(false)}
        />
      ) : null}
      <ResourceDrawer
        open={drawerItem !== null}
        matterId={matterId}
        matterVersion={matter.version}
        item={drawerItem}
        onClose={() => setDrawerItem(null)}
        onChanged={() => void refresh()}
      />
      {overlayRun ? (
        <RunOverlay
          run={overlayRun}
          update={updates.find((item) => item.agent_run_id === overlayRun.id)}
          onReview={setReviewId}
          onClose={() => setOverlayRunId(null)}
        />
      ) : null}
      {selectedUpdate.data ? (
        <MatterUpdateReview
          matter={matter}
          update={selectedUpdate.data}
          busy={reviewMutation.isPending}
          error={reviewError}
          onClose={() => setReviewId(null)}
          onAccept={(payload) => reviewMutation.mutate({ kind: 'accept', payload })}
          onReject={(payload) => reviewMutation.mutate({ kind: 'reject', payload })}
          onOpenResource={openReviewSource}
          // 提案失效后的出口：直接再跑一轮并关掉这张已作废的审阅面（原来只能先「拒绝」，
          // 再自己回详情头点「立即跟进」）。
          onRerun={() => startFollowUpRun(() => setReviewId(null))}
          rerunBusy={startRun.isPending}
        />
      ) : null}
    </div>
  )
}
