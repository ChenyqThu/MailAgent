import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  CircleCheckBig,
  Clock,
  FileCheck,
  Hourglass,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Target,
  Trash2,
  Sparkles,
  TriangleAlert,
  X
} from 'lucide-react'

import {
  BUILTIN_MATTER_TYPES,
  MATTER_HEALTH_VALUES,
  MATTER_ITEM_KINDS,
  MATTER_PRIORITIES,
  MATTER_STATUSES,
  MATTER_TAG_DEFAULT_COLOR,
  MATTER_TAG_DEFAULT_SHAPE
} from '@shared/api/types/matter'
import type {
  Matter,
  MatterAttentionSignal,
  MatterGoalCheck,
  MatterHealth,
  MatterItem,
  MatterItemCreateInput,
  MatterItemKind,
  MatterItemStatus,
  MatterPatchInput,
  MatterPriority,
  MatterResourceListItem,
  MatterStakeholder,
  MatterStatus,
  MatterTagDefinition,
  MatterUpdateSummary
} from '@shared/api/types/matter'
import { preview } from '@shared/components/agents/schedule/occurrences'
import { sentenceText } from '@shared/components/agents/schedule/sentence'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Input } from '@shared/components/ui/input'
import { Popmenu } from '@shared/components/ui/Popmenu'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/components/ui/select'
import { useEnterAnimation } from '@shared/hooks/useEnterAnimation'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { cn } from '@shared/lib/cn'
import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import {
  formatMatterAgo,
  formatMatterDueRelative,
  trashDaysRemaining
} from '@shared/lib/matterDerive'
import { asWriteError, errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { useShortcut } from '@shared/hooks/useShortcut'
import { useActiveEmail } from '@shared/state/active-email'
import {
  openMatterChat,
  startMatterChatWithPrompt,
  useAIChatPanel
} from '@shared/state/ai-chat-panel'
import { toastError, toastInfo, toastSuccess } from '@shared/state/toast'

import { AddItemModal } from './AddItemModal'
import { MatterAgentConfigModal } from './MatterAgentConfigModal'
import { MatterCheckRow, MatterCheckToggle } from './MatterCheckRow'
import { MatterContextTab } from './MatterContextTab'
import { MatterDatePicker } from './MatterDatePicker'
import { ResourceDrawer } from './ResourceDrawer'
import { MatterRunsPane } from './MatterRunsPane'
import { MatterTagChip } from './MatterTagMarker'
import { MatterTagManagerModal } from './MatterTagManagerModal'
import { MatterTagPicker } from './MatterTagPicker'
import { MatterTimeline } from './MatterTimeline'
import { MatterUpdateReview, type ReviewAcceptPayload } from './MatterUpdateReview'
import { isMatterStaleError, refreshMatter, useMatterMutation } from './matterMutation'
import { useMatterUndoToast } from './useMatterUndoToast'
import { parseMatterSchedule } from './matterSchedule'
import {
  MATTER_DETAIL_TAB_ICONS,
  MATTER_HEALTH_ICONS,
  MATTER_HEALTH_TEXT_CLASS,
  MATTER_ITEM_KIND_ICONS,
  MATTER_ITEM_KIND_TEXT_CLASS,
  MATTER_ITEM_STATUS_TONES,
  MATTER_PRIORITY_TONES,
  MATTER_STATUS_ICONS,
  MATTER_STATUS_TONES,
  MATTER_TONE_CHIP_CLASS,
  MATTER_TONE_DOT_CLASS,
  MATTER_TONE_OUTLINE_CLASS,
  MATTER_TONE_TEXT_CLASS,
  matterDueTone
} from './matterVocab'
import { resolveMatterCitationTarget } from './navigation'
import { RunOverlay } from './RunOverlay'
import { AttnBand } from './attention'
import {
  listMatterTagsSafely,
  MATTER_TAGS_QUERY_KEY,
  matterTagMap,
  mergeMatterTagDefinitions,
  resolveMatterTag
} from './matterTags'
import {
  useMatterAgentProfiles,
  useMatterAttention,
  useMatterFlags,
  useMatterPendingUpdates,
  useMatterRuns,
  useMattersApi,
  useStartMatterRun
} from './hooks'

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
  const assistantVisible = useAIChatPanel((state) => state.visible)
  const activeMatterChatId = useAIChatPanel((state) => state.matterTarget?.id ?? null)
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
    queryFn: () => api.get(matterId, ['items', 'timeline']),
    // 缓存配方同 useEmailListRows（速赢包 §2）: 详情三件套的实时性靠写侧
    // refreshMatter（invalidate detail 前缀）与 `matter.changed` SSE, 不靠 15s staleTime
    // —— 后者只会让「切走再回 / 在两条事项间来回点」每次都重拉。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
  const matter = detail.data?.matter
  const chatOpen = Boolean(matter && assistantVisible && activeMatterChatId === matter.id)
  const items = detail.data?.items ?? []
  const timeline = detail.data?.timeline ?? []
  const resources = useQuery({
    queryKey: qk.matters.resources(matterId),
    queryFn: () => api.listResources(matterId, { includeUnavailable: true }),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
  const stakeholders = useQuery({
    queryKey: qk.matters.stakeholders(matterId),
    queryFn: () => api.listStakeholders(matterId),
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

  // 🔴 清单单源在 `matterMutation.refreshMatter` —— 这里曾经手抄过一份七行的失效清单，
  // 漏了焦点页跨事项的 `pending-updates` 聚合键（0818「接受的提案还留在待审阅里」的病根）。
  // resources / stakeholders / runs / updates 都挂在 `detail(id)` 前缀下，前缀一失效就连带刷新。
  const refresh = (): Promise<void> => refreshMatter(queryClient, matterId)

  const patch = useMatterMutation({
    matterId,
    mutationFn: (input: MatterPatchInput) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.patch(matterId, input, { expectedVersion: matter.version })
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  /**
   * 跟进规则模态专用：`expectedVersion` 由模态给（它打开时冻结的那一版），不取这里的
   * 「当前最新」。🔴 上面那个 `patch` 在**发起时**读 `matter.version`，对于「挂载时初始化
   * 草稿、之后才提交」的模态等于把乐观锁架空：期间别处改了排程，保存会带着新版本号把它
   * 静默覆盖。失败也不弹 toast —— 错误要留在模态里，草稿才不会丢。
   */
  const patchAgentConfig = useMatterMutation({
    matterId,
    mutationFn: ({
      input,
      expectedVersion
    }: {
      input: MatterPatchInput
      expectedVersion: number
    }) => api.patch(matterId, input, { expectedVersion }),
    onSuccess: () => void refresh()
  })

  const transition = useMatterMutation({
    matterId,
    mutationFn: async (operation: 'archive' | 'reopen' | 'trash' | 'restore') => {
      if (!matter) throw new Error('Matter is not loaded')
      return api[operation](matterId, { expectedVersion: matter.version })
    },
    // G-33 —— 四个生命周期动作各自报自己的后果（设计 §2.23），不再统一「事项已更新」。
    // 四者在服务端都有反向操作（`_timestamp_transition` 恒返回 undo descriptor），故都带撤销。
    onSuccess: async (result, operation) => {
      await refresh()
      pushUndoToast(t(`matters.toast.transition.${operation}`), result, matterId)
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const addItem = useMatterMutation({
    matterId,
    mutationFn: (input: MatterItemCreateInput) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.createItem(matterId, input, { expectedVersion: matter.version })
    },
    onSuccess: async () => {
      setAddOpen(false)
      await refresh()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const updateItem = useMatterMutation({
    matterId,
    mutationFn: ({ item, status }: { item: MatterItem; status: 'done' | 'open' }) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.patchItem(
        matterId,
        item.id,
        { status, completed_at: status === 'done' ? Date.now() : null },
        { expectedVersion: matter.version }
      )
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  // G-11 —— 行内改标题 / 删除条目。与勾选完成同一条用户直接操作路径（patchItem/deleteItem +
  // 乐观锁），不是 Agent 提案；删除是软删（后端留 restoreItem 反向通道），不弹二次确认。
  const renameItem = useMatterMutation({
    matterId,
    mutationFn: ({ item, title }: { item: MatterItem; title: string }) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.patchItem(matterId, item.id, { title }, { expectedVersion: matter.version })
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const removeItem = useMatterMutation({
    matterId,
    mutationFn: (item: MatterItem) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.deleteItem(matterId, item.id, { expectedVersion: matter.version })
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const permanentDelete = useMatterMutation({
    matterId,
    mutationFn: async () => {
      if (!matter) throw new Error('Matter is not loaded')
      return api.permanentDelete(matterId, deleteConfirmation, {
        expectedVersion: matter.version,
        reason: 'user_confirmed_permanent_delete'
      })
    },
    onSuccess: async () => {
      // 走 refreshMatter 而不是只刷 list：永久删除会 CASCADE 掉这个事项的 pending 提案，
      // 焦点页那份跨事项聚合不失效就会留下指向已消失事项的幽灵条目。
      await refresh()
      setDeleteOpen(false)
      onRemoved()
    },
    onError: (error) => toastError(t('matters.toast.deleteFailed'), errorMessage(error))
  })

  const toggleResourcePin = useMatterMutation({
    matterId,
    mutationFn: (item: MatterResourceListItem) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.patchResource(
        matterId,
        item.resource.id,
        { pinned: !item.link.pinned },
        { expectedVersion: matter.version }
      )
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const cancelRun = useMatterMutation({
    matterId,
    mutationFn: (runId: number) => api.cancelRun(matterId, runId),
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })
  const reviewMutation = useMatterMutation({
    matterId,
    mutationFn: ({
      kind,
      payload
    }: { kind: 'accept'; payload: ReviewAcceptPayload } | { kind: 'reject'; payload: string }) => {
      if (!matter || reviewId == null) return Promise.reject(new Error('Review is not loaded'))
      return kind === 'accept'
        ? api.acceptUpdate(
            matterId,
            reviewId,
            {
              selected_change_ids: payload.selectedIds,
              edited_changes: payload.editedChanges,
              edited_summary: payload.editedSummary
            },
            { expectedVersion: matter.version }
          )
        : api.rejectUpdate(matterId, reviewId, payload, { expectedVersion: matter.version })
    },
    // G-33 —— 接受/拒绝各报各的后果（设计 §2.23）。
    // 🔴 **两者都不带撤销**：`accept_update` / `reject_update` 在服务端不产出 undo descriptor
    // （service.py 那两个方法没有 `_undo_descriptor` 调用），也没有等价的反向端点 —— 接受会
    // 把 N 项变化落进正式状态并写多条事件，"反过来"不是一次调用能表达的。这里如实只报结果，
    // 不做假撤销按钮。
    onSuccess: async (_result, variables) => {
      const next = updates.filter((item) => item.id !== reviewId)[0]
      setReviewError(null)
      await refresh()
      toastSuccess(
        variables.kind === 'accept'
          ? t('matters.toast.reviewAccepted', {
              count: variables.payload.selectedIds.length
            })
          : t('matters.toast.reviewRejected')
      )
      setReviewId(next?.id ?? null)
    },
    onError: (error) => {
      // 🔴 这里**只剩文案**：重新拉取由 `useMatterMutation` 统一做掉了（原来这一处是全仓
      // 唯一写对了的，另外四处漏了 —— 那正是 0812「完全无法操作」的成因）。别在这里再抄
      // 一遍 invalidate，两套刷新会漂开。
      const writeError = asWriteError(error)
      if (isMatterStaleError(error)) {
        setReviewError(
          writeError.code === 'E_UPDATE_STALE'
            ? t('matters.review.staleReload')
            : t('matters.review.versionReload')
        )
        return
      }
      toastError(t('matters.toast.saveFailed'), errorMessage(error))
    }
  })

  if (detail.isLoading || !matter) {
    return (
      <div className="grid h-full place-items-center text-body text-ink-fg-2">
        {t('common.loading')}
      </div>
    )
  }

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
      setActiveEmail(target.emailId)
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
    <div className="relative flex h-full min-w-0 bg-ink-0/35">
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
            {/* P3 — 事项对话 entry. Sits left of the 「更多」 menu (the design's 「立即跟进」
                neighbour is P4 and is deliberately not rendered yet: 界面跟 Phase 走). */}
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
            <button
              type="button"
              onClick={() =>
                openMatterChat({ id: matter.id, publicId: matter.public_id, title: matter.title })
              }
              aria-pressed={chatOpen}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] px-2.5 py-1.5 text-aux transition-colors duration-fast',
                chatOpen
                  ? 'bg-coral/12 text-coral'
                  : 'border border-ink-border text-ink-fg-1 hover:bg-ink-3'
              )}
            >
              <MessageSquare size={13} />
              {t('matters.chat.open')}
            </button>
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

        <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin">
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
              <MatterTimeline events={timeline} />
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

interface MatterPrevNextProps {
  current: number
  total: number
  previousLabel: string
  nextLabel: string
  canPrevious: boolean
  canNext: boolean
  onPrevious(): void
  onNext(): void
}

function MatterPrevNext({
  current,
  total,
  previousLabel,
  nextLabel,
  canPrevious,
  canNext,
  onPrevious,
  onNext
}: MatterPrevNextProps): React.ReactElement {
  return (
    <div className="inline-flex shrink-0 items-center overflow-hidden rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 text-ink-fg-1">
      {/* E10④（dogfood 轮 2）—— 高度改 `h-8`（32px）对齐相邻的「事项对话」/「立即跟进」按钮
          （两者 `py-1.5` + `text-aux` 20px 行高 = 32px）：这三颗按钮共处 header 的
          `items-start` 一行，原来的 `size-7`（28px）比邻居矮 4px，顶边对齐、底边错位。 */}
      <button
        type="button"
        title={previousLabel}
        aria-label={previousLabel}
        disabled={!canPrevious}
        onClick={onPrevious}
        className="grid h-8 w-7 place-items-center transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronUp size={14} />
      </button>
      <span className="w-16 text-center font-mono text-meta tabular-nums text-ink-fg-2">
        {current} / {total}
      </span>
      <button
        type="button"
        title={nextLabel}
        aria-label={nextLabel}
        disabled={!canNext}
        onClick={onNext}
        className="grid h-8 w-7 place-items-center transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronDown size={14} />
      </button>
    </div>
  )
}

/**
 * 状态选择面（轮 3 #2 —— 第三次返工，这次照设计**逐属性**落）。
 *
 * 触发器 = 裸 `StatusChip`（设计 detail.jsx:190-192：Pip + 每档一个 icon，无下拉箭头）。
 * 点它打开的**不是下拉**，是设计 create.jsx:108-131 的 `StatusMenu` **模态**：380px 宽、
 * ModalHead（target icon 井 + 「更改业务状态」+ 副题「状态变更会写入时间线…」）+ 八档
 * 状态行（icon 按 tone 上色 size 14 · 13px 标签 · 选中 = `--ink-3` 底 + accent 勾）。
 *
 * 🔴 前两轮失败的根因正是这里：只把 trigger 修成了 Pip，打开的面板仍是 shadcn Select
 * 的库存样式（勾在左、pl-7、glass-pop）—— 与设计的选择面一个属性都对不上。
 */
function StatusMenu({
  value,
  onChange
}: {
  value: MatterStatus
  onChange(value: MatterStatus): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const Icon = MATTER_STATUS_ICONS[value]
  // 设计 Modal = fadeIn 遮罩 + popIn 卡片（ui.jsx:204-222）；走仓库统一 `useExitAnimation`
  // 通道（同 AddItemModal / 永久删除确认），不自造 keyframes。
  const modalAnim = useExitAnimation<HTMLDivElement>(open, { card: '[data-anim-card]' })
  // 设计 Modal 支持 Esc 关闭（ui.jsx:206-210）；只在打开期间挂 document。
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return (): void => document.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('matters.detail.status')}
        title={t('matters.detail.status')}
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--r-ctl)] border px-[7px] py-[3px] text-meta leading-none',
          'transition-opacity duration-fast ease-standard hover:opacity-80',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
          MATTER_TONE_CHIP_CLASS[MATTER_STATUS_TONES[value]]
        )}
      >
        <Icon size={11} className="shrink-0" />
        {t(`matters.status.${value}`)}
      </button>
      {modalAnim.shouldRender ? (
        <div
          ref={modalAnim.scopeRef}
          role="presentation"
          onClick={(event) => {
            // 设计的遮罩点击即关（ui.jsx:211）；只认遮罩本体，卡片内点击不冒到这里关掉。
            if (event.target === event.currentTarget) setOpen(false)
          }}
          className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4"
        >
          <section
            data-anim-card
            role="dialog"
            aria-modal="true"
            aria-label={t('matters.detail.statusModalTitle')}
            className="w-full max-w-[380px] rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-md"
          >
            <header className="flex items-start gap-3 border-b border-ink-border-soft px-[18px] pb-3.5 pt-4">
              <span className="grid size-7 shrink-0 place-items-center rounded-[var(--r-ctl)] bg-coral/12 text-coral">
                <Target size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-lead font-semibold tracking-[-0.01em] text-ink-fg">
                  {t('matters.detail.statusModalTitle')}
                </h2>
                <p className="mt-0.5 text-meta text-ink-fg-2">
                  {t('matters.detail.statusModalSub')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('common.cancel')}
                className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg"
              >
                <X size={15} />
              </button>
            </header>
            <div
              role="listbox"
              aria-label={t('matters.detail.status')}
              className="flex flex-col gap-0.5 p-3"
            >
              {MATTER_STATUSES.map((status) => {
                const ItemIcon = MATTER_STATUS_ICONS[status]
                const selected = status === value
                return (
                  <button
                    key={status}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setOpen(false)
                      if (status !== value) onChange(status)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-[var(--r-ctl)] px-3 py-2 text-left transition-colors duration-fast ease-standard',
                      selected ? 'bg-ink-3' : 'hover:bg-ink-fg/[0.04]'
                    )}
                  >
                    <ItemIcon
                      size={14}
                      className={cn(
                        'shrink-0',
                        MATTER_TONE_TEXT_CLASS[MATTER_STATUS_TONES[status]]
                      )}
                    />
                    <span className="min-w-0 flex-1 text-body text-ink-fg">
                      {t(`matters.status.${status}`)}
                    </span>
                    {selected ? <Check size={13} className="shrink-0 text-coral" /> : null}
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

/**
 * 健康度（设计 detail.jsx:145 → `HealthChip` = **裸文本无边框无底**，icon 与文字同色）。
 * 保留可改（设计原型这里是只读展示，实现侧的可改是净增能力），但去掉 pill 边框与 chevron。
 */
function HealthMenu({
  value,
  onChange
}: {
  value: MatterHealth
  onChange(value: MatterHealth): void
}): React.ReactElement {
  const { t } = useTranslation()
  const Icon = MATTER_HEALTH_ICONS[value]
  return (
    <Select value={value} onValueChange={(health) => onChange(health as MatterHealth)}>
      <SelectTrigger
        aria-label={t('matters.detail.health')}
        className={cn(
          // `!bg-transparent` 压 SelectTrigger 自带的 authored `.input-surface`（见 matterVocab
          // 的说明）—— 设计要的是**裸文本**，有输入框底就不是裸的了。
          'h-auto w-auto justify-start gap-1 whitespace-nowrap rounded-[var(--r-ctl)] border-0 !bg-transparent px-1.5 py-1 text-meta',
          // 末位 svg = trigger 自带的 chevron，设计里健康度没有它（裸文本 + icon）。
          '[&>svg:last-child]:hidden hover:!bg-ink-fg/[0.05]',
          MATTER_HEALTH_TEXT_CLASS[value]
        )}
      >
        <Icon size={11} strokeWidth={2.4} className="shrink-0" />
        {t(`matters.health.${value}`)}
      </SelectTrigger>
      <SelectContent>
        {MATTER_HEALTH_VALUES.map((health) => {
          const ItemIcon = MATTER_HEALTH_ICONS[health]
          return (
            <SelectItem key={health} value={health}>
              <span className="inline-flex items-center gap-2">
                <ItemIcon
                  size={12}
                  strokeWidth={2.4}
                  className={MATTER_HEALTH_TEXT_CLASS[health]}
                />
                {t(`matters.health.${health}`)}
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

/**
 * 优先级选择面（轮 3 #2）。触发器 = `PriorityTag` mono 小标签 + **标签外** 8px chevron
 * （设计 detail.jsx:194-203，轮 2 已对齐）；打开的面板照设计 `PickMenu`
 * （detail.jsx:120-145）：窄面板 · 行 = 7px tone 圆点 + 标签(flex-1) + 行尾 accent 勾，
 * 选中底 `--ink-fg/0.06`、hover `--ink-fg/0.04`。
 *
 * 🔴 前两轮只修了 trigger，面板仍是 shadcn SelectContent 库存样式（勾在左、pl-7、
 * text-aux）—— 这轮把面板换成仓库统一弹层基座 `Popmenu` 的逃生舱（同 MatterDatePicker
 * 先例），定位 / outside-click / Esc / 退场动效与全 app 一致，行按设计逐属性画。
 */
function PriorityMenu({
  value,
  onChange
}: {
  value: MatterPriority
  onChange(value: MatterPriority): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('matters.detail.priority')}
        title={t('matters.detail.priority')}
        className={cn(
          'inline-flex items-center gap-[3px] rounded-[var(--r-ctl)]',
          'transition-opacity duration-fast ease-standard hover:opacity-80',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70'
        )}
      >
        <span
          className={cn(
            'rounded-[var(--r-ctl)] border px-[5px] py-[2px] font-mono text-[10.5px] font-semibold uppercase leading-none tracking-[0.02em]',
            MATTER_TONE_CHIP_CLASS[MATTER_PRIORITY_TONES[value]]
          )}
        >
          {value.toUpperCase()}
        </span>
        <ChevronDown size={8} className="shrink-0 text-ink-fg-3" />
      </button>
      <Popmenu
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel={t('matters.detail.priority')}
        triggerRef={triggerRef}
        align="start"
        width={124}
      >
        <div role="listbox" aria-label={t('matters.detail.priority')}>
          {MATTER_PRIORITIES.map((priority) => {
            const selected = priority === value
            return (
              <button
                key={priority}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setOpen(false)
                  if (priority !== value) onChange(priority)
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-meta text-ink-fg transition-colors duration-fast ease-standard',
                  selected ? 'bg-ink-fg/[0.06]' : 'hover:bg-ink-fg/[0.04]'
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-[7px] shrink-0 rounded-full',
                    MATTER_TONE_DOT_CLASS[MATTER_PRIORITY_TONES[priority]]
                  )}
                />
                <span className="min-w-0 flex-1 font-mono">{priority.toUpperCase()}</span>
                {selected ? <Check size={11} className="shrink-0 text-coral" /> : null}
              </button>
            )
          })}
        </div>
      </Popmenu>
    </span>
  )
}

/** 详情头右端的跟进 Agent 入口（设计 detail.jsx:163-174）。 */
function AgentPill({
  bound,
  interactive,
  label,
  onOpen
}: {
  bound: boolean
  interactive: boolean
  label: string
  onOpen(): void
}): React.ReactElement {
  const { t } = useTranslation()
  // D9 —— 未绑定态照设计 detail.jsx:211-216 也是 **AI 色系**（虚线 `--c-ai/0.45` 边 +
  // `--c-ai/0.06` 底 + ai 前景），不是灰色。「还没设置自动跟进」是个邀请，灰掉它等于
  // 把这个入口藏起来；sparkles 两态恒 ai 色同理。
  const skin = cn(
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-meta',
    bound
      ? 'border-ai/20 bg-ai/[0.08] text-ink-fg-1'
      : 'border-dashed border-ai/45 bg-ai/[0.06] text-ai'
  )
  if (!interactive) {
    return (
      <span className={skin}>
        <Sparkles size={11} className="shrink-0 text-ai" />
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('matters.agentConfig.open')}
      className={cn(
        skin,
        'transition-colors duration-fast ease-standard',
        bound ? 'hover:bg-ai/[0.14]' : 'hover:bg-ai/[0.12]'
      )}
    >
      <Sparkles size={11} className="shrink-0 text-ai" />
      {label}
      <ChevronDown size={9} className="shrink-0 opacity-60" />
    </button>
  )
}

/**
 * 类型切换（设计 detail.jsx:158-170 的触发器 + 71-118 的 `TypeMenu`）。
 *
 * 触发器 = 元信息行里的**裸文本按钮** + 8px chevron，只在 hover/打开时才浮出一层 6% 底；
 * 负 margin 抵掉 padding，让它在文字流里不额外占宽。
 *
 * 🔴 D4 —— 菜单改成设计的**搜索即筛选、没命中就现场新建**：改动前是 shadcn Select 的死列表
 * 加一个「自定义…」项，选中它会在**元信息行里**长出一个输入框 + 两个按钮（把 `pub · 类型 ·
 * 创建于…` 这行撑变形），且要先滚到列表底部才找得到。Radix Select 的 listbox 里塞不了搜索框，
 * 所以这里自绘 —— 收起行为（点外部 / Esc）与「更多」菜单同一条实现。
 *
 * 设计里还有「每个类型后面的事项计数」与「删除未被使用的自定义类型」：本仓没有类型注册表，
 * 计数与删除都无处可取，**不造** —— 类型就是 `matter.matter_type` 上的自由字符串。
 */
function MatterTypeEditor({
  value,
  busy,
  onChange
}: {
  value: string | null
  busy: boolean
  onChange(value: string | null): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const anchorRef = useRef<HTMLDivElement>(null)
  const menuAnim = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: -4, scale: 0.98, transformOrigin: 'top left' },
    enterDuration: DUR.fast
  })

  // 打开时清空上一次的搜索词（关闭期间不清 —— 退场还在播，清了会当场换内容）。
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onPointer = (event: MouseEvent): void => {
      const anchor = anchorRef.current
      if (anchor && !anchor.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const keyword = query.trim()
  // 候选 = 预置 6 项 + 当前这条自定义值（它不在预置里时也要能被看见/选中）。
  const allTypes = useMemo(() => {
    const list: string[] = [...BUILTIN_MATTER_TYPES]
    if (value !== null && !list.includes(value)) list.unshift(value)
    return list
  }, [value])
  const matches = keyword
    ? allTypes.filter((type) => type.toLowerCase().includes(keyword.toLowerCase()))
    : allTypes
  const exact = allTypes.some((type) => type === keyword)

  const pick = (next: string | null): void => {
    setOpen(false)
    if (next !== value) onChange(next)
  }

  const row = (
    key: string,
    label: string,
    selected: boolean,
    onSelect: () => void
  ): React.ReactElement => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-meta transition-colors duration-fast ease-standard',
        selected ? 'bg-coral/10 text-ink-fg' : 'text-ink-fg-1 hover:bg-ink-fg/[0.05]'
      )}
    >
      {/* 设计 detail.jsx:83-85：勾**紧跟**标签（label 不吃 flex），行尾 spacer ——
          不是「勾钉在最右」。 */}
      <span className="min-w-0 truncate">{label}</span>
      {selected ? <Check size={12} className="shrink-0 text-coral" /> : null}
      <span aria-hidden className="flex-1" />
    </button>
  )

  return (
    <div ref={anchorRef} className="relative inline-flex">
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('matters.detail.type')}
        title={t('matters.detail.type')}
        className={cn(
          // 负 margin 抵消 padding：hover 底比文字大一圈，但按钮的外框仍与文字等宽，
          // 于是它在 `pub · 类型 · 创建于…` 这行里不会撑开额外的间距（设计 margin:'-2px -5px'）。
          'inline-flex items-center gap-[3px] whitespace-nowrap rounded-[var(--r-ctl)] -mx-[5px] -my-[2px] px-[5px] py-[2px]',
          // 字号与颜色**跟随同行元信息**：用 inherit 而不是写死 ink-fg-2，这一行的颜色改了
          // 它自动跟着改。
          'text-meta text-inherit transition-colors duration-fast ease-standard',
          'hover:bg-ink-fg/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50',
          open && 'bg-ink-fg/[0.06]'
        )}
      >
        {value ?? t('matters.detail.typeUnset')}
        <ChevronDown size={8} className="shrink-0 opacity-[0.55]" />
      </button>
      {menuAnim.shouldRender ? (
        <div
          ref={menuAnim.scopeRef}
          role="listbox"
          aria-label={t('matters.detail.type')}
          className="absolute left-0 top-[calc(100%+5px)] z-30 max-h-80 w-52 overflow-y-auto rounded-[var(--r-pop)] border border-ink-border bg-ink-1 p-1.5 shadow-md scrollbar-thin"
        >
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter 且当前搜索词不是既有类型 → 就地新建（设计 detail.jsx:96）。
              if (event.key === 'Enter' && keyword && !exact) pick(keyword)
            }}
            placeholder={t('matters.detail.typeSearchPlaceholder')}
            aria-label={t('matters.detail.typeSearchPlaceholder')}
            className="mb-1 h-7 w-full px-2 text-meta"
          />
          {!keyword
            ? row('__unset', t('matters.detail.typeUnset'), value === null, () => pick(null))
            : null}
          {matches.map((type) => row(type, type, value === type, () => pick(type)))}
          {keyword && !exact
            ? row('__create', t('matters.detail.typeCreate', { name: keyword }), false, () =>
                pick(keyword)
              )
            : null}
        </div>
      ) : null}
    </div>
  )
}

function DueDateControl({
  value,
  saving,
  now,
  onChange
}: {
  value: number | null
  saving: boolean
  now: number
  onChange(value: number | null): void
}): React.ReactElement {
  const { t } = useTranslation()
  // 0813 dogfood #21：原来点开是个裸 `<input type="date">`，现在换成日历 popover
  // （`MatterDatePicker`，默认落当月 + 标记今天 + 今天/本周/下周/本月快捷键）。
  // 写入语义一字未变 —— 仍是**本地零点的 epoch 毫秒**（服务端 `_require_epoch_ms` 硬闸）。
  const [pickerOpen, setPickerOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const label =
    value == null
      ? t('matters.detail.noDue')
      : t('matters.detail.due', { date: new Date(value).toLocaleDateString() })
  // 设计 detail.jsx:50 `DueButton`：未设置 = 虚线边框 + fg-3；已设置 = 按 due tone 上色的实线。
  const tone = matterDueTone(value, now)

  return (
    <span className="relative inline-flex items-center gap-1 text-meta text-ink-fg-2">
      <button
        ref={triggerRef}
        type="button"
        disabled={saving}
        onClick={() => setPickerOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        className={cn(
          'inline-flex items-center gap-1 rounded-[var(--r-ctl)] border px-2 py-1 transition-colors duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50',
          tone === null
            ? 'border-dashed border-ink-border text-ink-fg-3 hover:text-ink-fg'
            : MATTER_TONE_OUTLINE_CLASS[tone]
        )}
      >
        <Clock size={11} />
        {label}
      </button>
      <MatterDatePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        value={value}
        now={now}
        triggerRef={triggerRef}
        ariaLabel={t('matters.datePicker.label')}
        onSelect={(next) => {
          onChange(next)
          setPickerOpen(false)
        }}
      />
      {value != null ? (
        <button
          type="button"
          disabled={saving}
          onClick={() => onChange(null)}
          aria-label={t('matters.detail.noDue')}
          className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
        >
          <X size={12} />
        </button>
      ) : null}
    </span>
  )
}

/**
 * 「当前状态 · 已接受」卡（设计 detail.jsx:339-362）。
 *
 * 🔴 只管**已接受的摘要**：背景与目标、完成标志已拆到 `GoalCard` 并排在它之前
 * （G-06 / 补充规格 §5.1）。别再往这里加目标相关的东西 —— 两者的写入语义不同，
 * 摘要走「Agent 提案 → 你接受」，目标是用户自己写的（HANDOFF §3 硬约束①）。
 */
/**
 * 分节标签（设计 `ui.jsx` 的 `RailLabel`）—— D8：状态 tab 的三类分节此前是**卡片内部的一行
 * 粗标题**，既没有 icon，也没有把「这是一节」的边界画出来。设计里每一节都是
 * `[icon] LABEL ————————————— [right]`：标签在卡**外面**，一条发丝线把这一行填满。
 *
 * 🔴 不用仓库的 `SectionHeader`，也不上 `font-mono`：CI lint 规则 `no-cjk-in-mono-size`
 * 禁 CJK 走等宽（中文在 mono 下字距会散）。同 `MatterTimeline` 的处理。
 */
function MatterSectionLabel({
  icon,
  children,
  right
}: {
  icon?: React.ReactNode
  children: React.ReactNode
  right?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="mb-2 flex items-center gap-2 px-0.5">
      {icon}
      <h2 className="shrink-0 text-meta font-semibold uppercase tracking-[0.08em] text-ink-fg-2">
        {children}
      </h2>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-ink-border-soft" />
      {right}
    </div>
  )
}

function StateCard({
  matter,
  pendingCount,
  onReview,
  saving,
  now,
  locale,
  onSummarySave,
  onRegenerate,
  regenerating = false
}: {
  matter: Matter
  pendingCount: number
  onReview(): void
  saving: boolean
  now: number
  locale: string
  onSummarySave(summary: string | null, onSaved: () => void): void
  /** G-10 —— 「重新生成摘要」= 触发一次跟进 run；agent flag 关时不传，只留新鲜度指示。 */
  onRegenerate?: () => void
  regenerating?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const [summaryEditing, setSummaryEditing] = useState(false)
  const [summaryDraft, setSummaryDraft] = useState(matter.current_summary ?? '')
  const summaryValue = matter.current_summary ?? ''
  const normalizedSummaryDraft = summaryDraft.trim() ? summaryDraft : null
  // G-10 新鲜度（设计 detail.jsx:340-350）：>14 天 warn「已 N 天未更新」，否则「{ago}由你接受」
  // （直接编辑走的也是隐藏 accepted Manual Update 路径，「由你接受」对两种来源都成立）。
  const staleDays =
    matter.summary_at != null ? Math.floor((now - matter.summary_at) / 86_400_000) : null
  const stale = staleDays !== null && staleDays > 14

  useEffect(() => {
    if (!summaryEditing) setSummaryDraft(matter.current_summary ?? '')
  }, [matter.current_summary, summaryEditing])

  const saveSummary = (): void => {
    onSummarySave(normalizedSummaryDraft, () => setSummaryEditing(false))
  }

  return (
    <section>
      {/* D8 —— 分节标签移出卡片、带 icon（设计 detail.jsx:350 `<RailLabel icon="filecheck">`）。
          微调项：视觉标题带「· 已接受」后缀，但 `matters.state.title` 键保持原值 ——
          它参与下面编辑按钮的 aria-label 组合（MatterStateCard.test 断言），后缀只进视觉层。 */}
      <MatterSectionLabel
        icon={<FileCheck size={12} className="shrink-0 text-ink-fg-2" />}
        right={
          <span className="flex shrink-0 items-center gap-1.5">
            {staleDays !== null ? (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-micro',
                  stale ? 'text-warn' : 'text-ink-fg-3'
                )}
              >
                {stale ? <TriangleAlert size={11} /> : <CheckCircle2 size={11} />}
                {stale
                  ? t('matters.state.freshnessStale', { count: staleDays })
                  : t('matters.state.freshnessFresh', {
                      time: formatMatterAgo(matter.summary_at as number, now, locale)
                    })}
              </span>
            ) : null}
            {onRegenerate ? (
              <button
                type="button"
                disabled={regenerating}
                onClick={onRegenerate}
                title={t('matters.state.regenerate')}
                aria-label={t('matters.state.regenerate')}
                className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
              >
                <RefreshCw size={12} className={regenerating ? 'animate-spin' : undefined} />
              </button>
            ) : null}
            {!summaryEditing ? (
              <button
                type="button"
                onClick={() => setSummaryEditing(true)}
                aria-label={`${t('matters.state.title')} ${t('matters.actions.edit')}`}
                className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
              >
                <Pencil size={12} />
              </button>
            ) : null}
          </span>
        }
      >
        {t('matters.state.title')}
        <span aria-hidden className="font-normal normal-case tracking-normal text-ink-fg-3">
          {' '}
          · {t('matters.state.titleAccepted')}
        </span>
      </MatterSectionLabel>
      <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-1/75 p-4">
        {summaryEditing ? (
          <div>
            <textarea
              autoFocus
              rows={5}
              value={summaryDraft}
              onChange={(event) => setSummaryDraft(event.target.value)}
              placeholder={t('matters.state.summaryPlaceholder')}
              aria-label={t('matters.state.title')}
              className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body text-ink-fg outline-none transition-colors duration-fast ease-standard placeholder:text-ink-fg-3 focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setSummaryDraft(summaryValue)
                  setSummaryEditing(false)
                }}
                className="rounded-[var(--r-ctl)] px-2.5 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
              >
                {t('matters.actions.cancel')}
              </button>
              <button
                type="button"
                disabled={saving || normalizedSummaryDraft === (matter.current_summary ?? null)}
                onClick={saveSummary}
                className="rounded-[var(--r-ctl)] bg-coral/100 px-3 py-1.5 text-aux font-medium text-accent-fg transition-[background-color,transform] duration-fast ease-standard hover:bg-coral-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 active:scale-[0.96] disabled:opacity-50"
              >
                {t('matters.actions.save')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="whitespace-pre-wrap text-body text-ink-fg-1">
              {matter.current_summary || t('matters.state.noSummary')}
            </p>
            {matter.current_summary && (matter.summary_at != null || matter.summary_by_kind) ? (
              <p className="mt-2 flex flex-wrap items-center gap-2 text-meta text-ink-fg-2">
                {matter.summary_at != null ? (
                  <span>
                    {t('matters.state.summaryUpdatedAt', {
                      time: new Date(matter.summary_at).toLocaleString()
                    })}
                  </span>
                ) : null}
                {matter.summary_by_kind ? (
                  <span>{t(`matters.state.summaryBy.${matter.summary_by_kind}`)}</span>
                ) : null}
              </p>
            ) : null}
          </>
        )}
        <p className="mt-3 border-t border-ink-border pt-3 text-meta text-ink-fg-2">
          {t('matters.state.summaryGuard')}
        </p>
        {pendingCount > 0 ? (
          <button
            type="button"
            onClick={onReview}
            className="mt-4 inline-flex items-center gap-1 rounded-lg bg-ai/10 px-3 py-2 text-aux text-ai"
          >
            <Sparkles size={12} />
            {t('matters.state.pendingProposals', { count: pendingCount })}
          </button>
        ) : null}
      </div>
    </section>
  )
}

/**
 * 「背景与目标」卡（设计 matter-agent.jsx:266-332 `GoalCard`）：上半是用户自己写的
 * 背景与目标两段，下半是同一张卡里的「完成标志」分区（底色略深 + 上分隔线）。
 *
 * 🔴 **不做**「让 Agent 改写」按钮：设计稿底部那条 ghost 按钮与 HANDOFF §3 硬约束①
 * 「这两段是用户写的，Agent 永远不能直写」直接冲突。
 *
 * 存储：2026-08-19（v61）owner 推翻「合存单字段 + `## 背景` / `## 目标` 小标题分段」的
 * 方案，改成 `matter.background` / `matter.goal` 两个独立字段 —— 目的就是**没有解析这回事**。
 * 🔴 不要再往这里加分段正则：一处正则就是五处（读态 / 编辑态 / 保存 / 导出 / Agent 写）
 * 都得同意，任何一处不同意就是静默串段。
 */
function GoalCard({
  matter,
  saving,
  onProseSave,
  onGoalChecksSave
}: {
  matter: Matter
  saving: boolean
  onProseSave(prose: { background: string; goal: string }, onSaved: () => void): void
  onGoalChecksSave(goalChecks: MatterGoalCheck[], onSaved?: () => void): void
}): React.ReactElement {
  const { t } = useTranslation()
  const fieldId = useId()
  const [proseEditing, setProseEditing] = useState(false)
  const [proseDraft, setProseDraft] = useState(() => ({
    background: matter.background,
    goal: matter.goal
  }))
  const [addingGoalCheck, setAddingGoalCheck] = useState(false)
  const [goalCheckDraft, setGoalCheckDraft] = useState('')
  const goalChecks = matter.goal_checks ?? []
  const doneGoalChecks = goalChecks.filter((check) => check.done).length
  const proseDirty = proseDraft.background !== matter.background || proseDraft.goal !== matter.goal

  useEffect(() => {
    if (!proseEditing) setProseDraft({ background: matter.background, goal: matter.goal })
  }, [proseEditing, matter.background, matter.goal])

  const saveGoalCheck = (): void => {
    const text = goalCheckDraft.trim()
    if (!text) {
      setGoalCheckDraft('')
      setAddingGoalCheck(false)
      return
    }
    onGoalChecksSave([...goalChecks, { t: text, done: false }], () => {
      setGoalCheckDraft('')
      setAddingGoalCheck(false)
    })
  }

  const setGoalCheckDone = (index: number, done: boolean): void => {
    onGoalChecksSave(
      goalChecks.map((check, candidateIndex) =>
        candidateIndex === index ? { ...check, done } : check
      )
    )
  }

  const removeGoalCheck = (index: number): void => {
    onGoalChecksSave(goalChecks.filter((_, candidateIndex) => candidateIndex !== index))
  }

  return (
    <section>
      {/* D8 —— 设计 matter-agent.jsx:277 `<RailLabel icon="target">背景与目标</RailLabel>`。 */}
      <MatterSectionLabel
        icon={<Target size={12} className="shrink-0 text-ink-fg-2" />}
        right={
          !proseEditing ? (
            <button
              type="button"
              onClick={() => setProseEditing(true)}
              className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
            >
              <Pencil size={12} />
              {t('matters.actions.edit')}
            </button>
          ) : null
        }
      >
        {t('matters.state.descriptionLabel')}
      </MatterSectionLabel>
      <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1/75">
        {proseEditing ? (
          <div className="space-y-4 p-4">
            <div>
              <label
                htmlFor={`${fieldId}-background`}
                className="mb-1 block text-meta font-medium text-ink-fg-3"
              >
                {t('matters.state.backgroundLabel')}
              </label>
              <textarea
                autoFocus
                id={`${fieldId}-background`}
                rows={4}
                value={proseDraft.background}
                onChange={(event) =>
                  setProseDraft((draft) => ({ ...draft, background: event.target.value }))
                }
                placeholder={t('matters.state.backgroundPlaceholder')}
                className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body text-ink-fg outline-none transition-colors duration-fast ease-standard placeholder:text-ink-fg-3 focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldId}-goal`}
                className="mb-1 block text-meta font-medium text-ink-fg-3"
              >
                {t('matters.state.goalLabel')}
              </label>
              <textarea
                id={`${fieldId}-goal`}
                rows={3}
                value={proseDraft.goal}
                onChange={(event) =>
                  setProseDraft((draft) => ({ ...draft, goal: event.target.value }))
                }
                placeholder={t('matters.state.goalPlaceholder')}
                className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body text-ink-fg outline-none transition-colors duration-fast ease-standard placeholder:text-ink-fg-3 focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
              />
            </div>
            <p className="text-meta text-ink-fg-2">{t('matters.state.markdownHint')}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setProseDraft({ background: matter.background, goal: matter.goal })
                  setProseEditing(false)
                }}
                className="rounded-[var(--r-ctl)] px-2.5 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
              >
                {t('matters.actions.cancel')}
              </button>
              <button
                type="button"
                disabled={saving || !proseDirty}
                onClick={() => onProseSave(proseDraft, () => setProseEditing(false))}
                className="rounded-[var(--r-ctl)] bg-coral/100 px-3 py-1.5 text-aux font-medium text-accent-fg transition-[background-color,transform] duration-fast ease-standard hover:bg-coral-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 active:scale-[0.96] disabled:opacity-50"
              >
                {t('matters.actions.save')}
              </button>
            </div>
          </div>
        ) : matter.background || matter.goal ? (
          <>
            {matter.background ? (
              <div className="p-4">
                <h3 className="mb-1 text-meta font-medium text-ink-fg-3">
                  {t('matters.state.backgroundLabel')}
                </h3>
                <div className="[&_.mail-body_p:last-child]:mb-0">
                  <TranslatedBody text={matter.background} />
                </div>
              </div>
            ) : null}
            {matter.goal ? (
              <div
                className={cn('p-4', matter.background ? 'border-t border-ink-border-soft' : null)}
              >
                <h3 className="mb-1 text-meta font-medium text-ink-fg-3">
                  {t('matters.state.goalLabel')}
                </h3>
                <div className="[&_.mail-body_p:last-child]:mb-0">
                  <TranslatedBody text={matter.goal} />
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="p-4 text-body text-ink-fg-2">{t('matters.state.noDescription')}</p>
        )}
        {/* 设计 matter-agent.jsx:290 —— 完成标志是同一张卡的下半分区（`fg/0.022` 底 +
          上分隔线），不是卡里再套一个虚线框。 */}
        <div className="border-t border-ink-border-soft bg-ink-fg/[0.02] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-meta font-medium text-ink-fg-2">{t('matters.state.goalChecks')}</h3>
            {/* 0818 mockup 的 `Progress`：细条 + 「已完成 x / y」。原先是一颗 `x/y` 药丸
              —— 同一个事实，条形更快读出「还差多少」。数字用 tabular-nums 免得跳字宽。 */}
            <div className="flex items-center gap-2.5">
              <span className="h-1 w-24 overflow-hidden rounded-full bg-ink-3">
                <span
                  className="block h-full rounded-full bg-ok transition-[width] duration-base ease-standard"
                  style={{
                    width: `${goalChecks.length === 0 ? 0 : Math.round((doneGoalChecks / goalChecks.length) * 100)}%`
                  }}
                />
              </span>
              <span className="shrink-0 text-meta tabular-nums text-ink-fg-2">
                {t('matters.state.goalChecksCount', {
                  done: doneGoalChecks,
                  total: goalChecks.length
                })}
              </span>
            </div>
          </div>
          {goalChecks.length > 0 ? (
            <ul className="mt-2 space-y-0.5">
              {goalChecks.map((check, index) => (
                <MatterCheckRow
                  key={`${index}-${check.t}`}
                  done={check.done}
                  text={check.t}
                  disabled={saving}
                  onToggle={() => setGoalCheckDone(index, !check.done)}
                  action={
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => removeGoalCheck(index)}
                      aria-label={t('matters.actions.trash')}
                      className="shrink-0 rounded-[var(--r-ctl)] p-1.5 text-ink-fg-3 opacity-0 transition-[color,background-color,opacity] duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-40 group-hover/check:opacity-100 group-focus-within/check:opacity-100"
                    >
                      <Trash2 size={12} />
                    </button>
                  }
                />
              ))}
            </ul>
          ) : null}
          {addingGoalCheck ? (
            <div className="mt-3 flex items-center gap-2">
              <Input
                autoFocus
                value={goalCheckDraft}
                disabled={saving}
                onChange={(event) => setGoalCheckDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') saveGoalCheck()
                  if (event.key === 'Escape') {
                    setGoalCheckDraft('')
                    setAddingGoalCheck(false)
                  }
                }}
                placeholder={t('matters.state.goalCheckPlaceholder')}
                aria-label={t('matters.state.goalChecks')}
                className="h-8 flex-1 px-2 text-body"
              />
              <button
                type="button"
                disabled={saving || !goalCheckDraft.trim()}
                onClick={saveGoalCheck}
                aria-label={t('matters.actions.save')}
                className="rounded-[var(--r-ctl)] p-1.5 text-ok transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setGoalCheckDraft('')
                  setAddingGoalCheck(false)
                }}
                aria-label={t('matters.actions.cancel')}
                className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={saving}
              onClick={() => setAddingGoalCheck(true)}
              className={cn(
                'mt-3 rounded-[var(--r-ctl)] border border-dashed border-ink-border px-3 py-2 text-left text-aux text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-2 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50',
                goalChecks.length === 0 ? 'w-full' : 'inline-flex'
              )}
            >
              {t('matters.state.goalCheckAdd')}
            </button>
          )}
          {goalChecks.length > 0 && doneGoalChecks === goalChecks.length ? (
            <div className="mt-3 flex items-start gap-2 rounded-[var(--r-ctl)] border border-ok/25 bg-ok/10 px-3 py-2 text-aux text-ok">
              <CircleCheckBig size={13} className="mt-0.5 shrink-0" />
              <span>{t('matters.state.goalChecksAllDone')}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

/**
 * 归档 / 回收站状态条（设计 detail.jsx:230-244）。删除态用 crit 色调并写明保留期与
 * 「关联的邮件与外部文档不受影响」；归档态是中性条 + 「归档不改变业务状态」。
 * 两个动作与「更多」菜单里的同名项**共用同一个 mutation**，不另起一条写路径。
 */
function MatterLifecycleBanner({
  matter,
  busy,
  now,
  locale,
  onRestore
}: {
  matter: Matter
  busy: boolean
  now: number
  locale: string
  onRestore(): void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const trashed = matter.deleted_at !== null
  if (!trashed && matter.archived_at === null) return null
  const BannerIcon = trashed ? Trash2 : Archive
  return (
    <div
      className={cn(
        'mb-5 flex items-center gap-3 rounded-[var(--r-card)] border px-4 py-3',
        trashed ? 'border-crit/25 bg-crit/[0.07]' : 'border-ink-border bg-ink-fg/[0.04]'
      )}
    >
      <BannerIcon size={14} className={cn('shrink-0', trashed ? 'text-crit' : 'text-ink-fg-2')} />
      <p className="min-w-0 flex-1 text-body text-ink-fg-1">
        {trashed
          ? t('matters.detail.trashedBanner', { count: trashDaysRemaining(matter, now) ?? 0 })
          : t('matters.detail.archivedBanner', {
              time: formatMatterAgo(matter.archived_at as number, now, locale)
            })}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={onRestore}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
      >
        <RotateCcw size={13} />
        {t(trashed ? 'matters.actions.restore' : 'matters.actions.restoreArchive')}
      </button>
    </div>
  )
}

interface ItemRowCallbacks {
  onToggle(item: MatterItem): void
  onRename(item: MatterItem, title: string): void
  onDelete(item: MatterItem): void
  onOpenResource(item: MatterResourceListItem): void
}

function ItemGroups({
  items,
  stakeholders,
  resources,
  now,
  locale,
  busy,
  onToggle,
  onAdd,
  onRename,
  onDelete,
  onOpenResource
}: {
  items: readonly MatterItem[]
  stakeholders: readonly MatterStakeholder[]
  resources: readonly MatterResourceListItem[]
  now: number
  locale: string
  busy: boolean
  onAdd(kind: MatterItemKind): void
} & ItemRowCallbacks): React.ReactElement {
  const { t } = useTranslation()
  const activeItems = items.filter((item) => item.deleted_at === null)
  const groups = MATTER_ITEM_KINDS.map((kind) => ({
    kind,
    items: activeItems.filter((item) => item.kind === kind)
  })).filter((group) => group.items.length > 0)
  const stakeholdersById = useMemo(
    () => new Map(stakeholders.map((stakeholder) => [stakeholder.id, stakeholder])),
    [stakeholders]
  )
  const resourcesById = useMemo(
    () => new Map(resources.map((item) => [item.resource.id, item])),
    [resources]
  )
  if (groups.length === 0) {
    const starterKinds: MatterItemKind[] = [
      'action',
      'milestone',
      'decision',
      'blocker',
      'question'
    ]
    return (
      <EmptyState
        title={t('matters.item.empty')}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {starterKinds.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => onAdd(kind)}
                className="rounded-[var(--r-ctl)] border border-ink-border px-3 py-2 text-body hover:bg-ink-3"
              >
                <Plus size={13} className="mr-1 inline" />
                {t(`matters.item.kinds.${kind}`)}
              </button>
            ))}
          </div>
        }
      />
    )
  }
  return (
    <section className="space-y-4">
      {groups.map((group) => (
        <ItemGroup
          key={group.kind}
          kind={group.kind}
          items={group.items}
          stakeholdersById={stakeholdersById}
          resourcesById={resourcesById}
          now={now}
          locale={locale}
          busy={busy}
          onToggle={onToggle}
          onAdd={onAdd}
          onRename={onRename}
          onDelete={onDelete}
          onOpenResource={onOpenResource}
        />
      ))}
    </section>
  )
}

function ItemGroup({
  kind,
  items,
  stakeholdersById,
  resourcesById,
  now,
  locale,
  busy,
  onToggle,
  onAdd,
  onRename,
  onDelete,
  onOpenResource
}: {
  kind: MatterItemKind
  items: readonly MatterItem[]
  stakeholdersById: ReadonlyMap<number, MatterStakeholder>
  resourcesById: ReadonlyMap<number, MatterResourceListItem>
  now: number
  locale: string
  busy: boolean
  onAdd(kind: MatterItemKind): void
} & ItemRowCallbacks): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [titleDraft, setTitleDraft] = useState('')

  const startEdit = (item: MatterItem): void => {
    setEditingId(item.id)
    setTitleDraft(item.title)
  }
  const saveEdit = (item: MatterItem): void => {
    const title = titleDraft.trim()
    setEditingId(null)
    if (!title || title === item.title) return
    onRename(item, title)
  }

  const KindIcon = MATTER_ITEM_KIND_ICONS[kind]
  // 设计 detail.jsx:322/328 —— 标签后缀是「· N 项未完成」，不是总数；note / decision
  // 这两类没有「完成」语义（设计明确排除），只出类型名。
  const openCount = items.filter(
    (item) => item.status !== 'done' && item.status !== 'canceled'
  ).length
  const showOpenCount = openCount > 0 && kind !== 'note' && kind !== 'decision'

  return (
    <section>
      {/* D8 —— 分节标签移出卡片、带本类型的 icon（设计 detail.jsx:325-330）。 */}
      <MatterSectionLabel
        icon={<KindIcon size={12} className={cn('shrink-0', MATTER_ITEM_KIND_TEXT_CLASS[kind])} />}
        right={
          <button
            type="button"
            onClick={() => onAdd(kind)}
            aria-label={t('matters.item.addKind', { kind: t(`matters.item.kinds.${kind}`) })}
            title={t('matters.item.addKind', { kind: t(`matters.item.kinds.${kind}`) })}
            className="shrink-0 rounded-[var(--r-ctl)] p-1 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
          >
            <Plus size={13} />
          </button>
        }
      >
        {t(`matters.item.kinds.${kind}`)}
        {showOpenCount ? (
          <span className="font-normal normal-case tracking-normal text-ink-fg-3">
            {' '}
            · {t('matters.item.openCount', { count: openCount })}
          </span>
        ) : null}
      </MatterSectionLabel>
      {/* 边框改 `ink-border-soft`（设计 detail.jsx:331）；行的几何不动 —— D8 只收分节。 */}
      <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1/65">
        <div className="divide-y divide-ink-border-soft">
          {items.map((item) => {
            const isExpanded = expanded.has(item.id)
            const done = item.status === 'done'
            const editing = editingId === item.id
            // G-11 meta 行的数据面：状态 Pip（action 未完成）· 等 {人} · 到期 · 完成时间 ·
            // 来源链接。设计里的 `已阻塞 {时长}`（it.since）与 owner 头像是 mock-only 字段，
            // 数据里没有，不渲染。
            const waitingOn =
              item.waiting_on_stakeholder_id != null
                ? stakeholdersById.get(item.waiting_on_stakeholder_id)
                : undefined
            const sourceResource =
              item.source_resource_id != null
                ? resourcesById.get(item.source_resource_id)
                : undefined
            const dueTone = matterDueTone(item.due_at, now)
            const showStatusPip =
              item.kind === 'action' &&
              item.status !== null &&
              item.status !== 'done' &&
              item.status !== 'canceled'
            const hasMeta =
              showStatusPip ||
              waitingOn !== undefined ||
              (item.due_at != null && !done) ||
              (done && item.completed_at != null) ||
              sourceResource !== undefined
            return (
              <div key={item.id} className="group/item px-4 py-3">
                <div className="flex items-start gap-2.5">
                  {/* 勾选外观与「完成标志」同一个单源（`MatterCheckRow.tsx`）。这里只有图标
                    可点：整行做成 button 会把下面的改标题 / 删除 / 来源 / 展开清单四个钮
                    嵌进去（非法）。 */}
                  {item.kind === 'action' ? (
                    <MatterCheckToggle
                      done={done}
                      label={item.title}
                      className="mt-0.5"
                      onToggle={() => onToggle(item)}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    {editing ? (
                      <div className="flex items-center gap-1.5">
                        <Input
                          autoFocus
                          value={titleDraft}
                          onChange={(event) => setTitleDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') saveEdit(item)
                            if (event.key === 'Escape') setEditingId(null)
                          }}
                          aria-label={t('matters.item.editTitle')}
                          className="h-7 min-w-0 flex-1 px-2 text-body"
                        />
                        <button
                          type="button"
                          disabled={!titleDraft.trim() || busy}
                          onClick={() => saveEdit(item)}
                          aria-label={t('matters.actions.save')}
                          className="rounded-[var(--r-ctl)] p-1.5 text-ok transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
                        >
                          <Save size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          aria-label={t('matters.actions.cancel')}
                          className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-start gap-1.5">
                        <div
                          className={cn(
                            'min-w-0 flex-1 text-body',
                            done && 'text-ink-fg-2 line-through'
                          )}
                        >
                          {item.title}
                        </div>
                        {/* hover 出 ✎/🗑（设计 detail.jsx:296-298 的 rowact 形态）。 */}
                        <span className="inline-flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-focus-within/item:opacity-100 group-hover/item:opacity-100">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => startEdit(item)}
                            aria-label={t('matters.item.editTitle')}
                            className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-40"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onDelete(item)}
                            aria-label={t('matters.item.deleteItem')}
                            className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-40"
                          >
                            <Trash2 size={12} />
                          </button>
                        </span>
                      </div>
                    )}
                    {item.description ? (
                      <div className="mt-1 [&_.mail-body]:text-aux [&_.mail-body]:leading-relaxed [&_.mail-body_p]:mb-2 [&_.mail-body_p:last-child]:mb-0">
                        <TranslatedBody text={item.description} />
                      </div>
                    ) : null}
                    {hasMeta ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        {showStatusPip ? (
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full border px-1.5 py-0.5 text-micro',
                              MATTER_TONE_CHIP_CLASS[
                                MATTER_ITEM_STATUS_TONES[item.status as MatterItemStatus]
                              ]
                            )}
                          >
                            {t(`matters.item.status.${item.status}`)}
                          </span>
                        ) : null}
                        {waitingOn ? (
                          <span className="inline-flex items-center gap-1 text-micro text-warn">
                            <Hourglass size={10} />
                            {t('matters.item.waitingOn', {
                              name: waitingOn.display_name ?? waitingOn.email_normalized ?? '—'
                            })}
                          </span>
                        ) : null}
                        {item.due_at != null && !done ? (
                          <span
                            className={cn(
                              'text-micro',
                              dueTone === null || dueTone === 'neutral'
                                ? 'text-ink-fg-3'
                                : MATTER_TONE_TEXT_CLASS[dueTone]
                            )}
                          >
                            {t('matters.item.dueRelative', {
                              time: formatMatterDueRelative(item.due_at, now, locale)
                            })}
                          </span>
                        ) : null}
                        {done && item.completed_at != null ? (
                          <span className="text-micro text-ink-fg-3">
                            {t('matters.item.completedAt', {
                              time: formatMatterAgo(item.completed_at, now, locale)
                            })}
                          </span>
                        ) : null}
                        {sourceResource ? (
                          <button
                            type="button"
                            onClick={() => onOpenResource(sourceResource)}
                            className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] text-micro text-ink-fg-3 transition-colors duration-fast ease-standard hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
                          >
                            <Link2 size={10} />
                            {t('matters.item.source')}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {item.checklist.length > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current)
                            if (next.has(item.id)) next.delete(item.id)
                            else next.add(item.id)
                            return next
                          })
                        }
                        className="mt-2 inline-flex items-center gap-1 text-meta text-ink-fg-2 hover:text-ink-fg"
                      >
                        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        {t('matters.item.checklist', { count: item.checklist.length })}
                      </button>
                    ) : null}
                    {isExpanded ? (
                      <ul className="mt-2 space-y-1 pl-4 text-aux text-ink-fg-1">
                        {item.checklist.map((entry) => (
                          <li
                            key={entry.id}
                            className={entry.done ? 'line-through text-ink-fg-2' : ''}
                          >
                            {entry.done ? '✓' : '○'} {entry.text}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

/**
 * `waiting_context` 是无 schema 的 JSON 对象（wire 契约 `Record<string, unknown> | null`；
 * 提案通道与测试里的既有形状是 `{who: …}` 一类的 ad-hoc dict）→ 展示时投影成一行文本：
 * 取原始值键的 `k: v`（约定键 `note` 直接出值，是本组件自己写入的形状），投不出来就整段
 * JSON 兜底 —— 宁可难看也不隐藏「它在等」这个事实。
 */
function waitingContextText(value: Record<string, unknown> | null): string | null {
  if (value === null) return null
  const parts: string[] = []
  for (const [key, raw] of Object.entries(value)) {
    if (raw == null) continue
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      parts.push(key === 'note' ? String(raw) : `${key}: ${String(raw)}`)
    }
  }
  if (parts.length > 0) return parts.join(' · ')
  return Object.keys(value).length > 0 ? JSON.stringify(value) : null
}

/**
 * G-08 等待条（设计 detail.jsx:205-209 的 `m.waiting` 行，按真实数据微调）：真实数据是
 * 无 schema 的 `waiting_context` dict + `stakeholder.is_waiting_on`，不是设计的结构化
 * `{who,what,since}` —— 显示投影文本 + 等待中干系人名；「等了多久」没有起始时间戳可依据，
 * 不渲染。点击就地编辑（保存为 `{note: 文本}`）/ 清除（DIRECT_PATCH_FIELDS 既有通道）。
 */
function MatterWaitingBar({
  waitingContext,
  stakeholders,
  saving,
  onSave
}: {
  waitingContext: Record<string, unknown> | null
  stakeholders: readonly MatterStakeholder[]
  saving: boolean
  onSave(waitingContext: Record<string, unknown> | null): void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const waitingNames = stakeholders
    .filter((stakeholder) => stakeholder.is_waiting_on && stakeholder.deleted_at === null)
    .map((stakeholder) => stakeholder.display_name ?? stakeholder.email_normalized ?? '—')
  const contextText = waitingContextText(waitingContext)
  if (!editing && contextText === null && waitingNames.length === 0) return null

  const label =
    contextText !== null && waitingNames.length > 0
      ? t('matters.detail.waitingBoth', { names: waitingNames.join('、'), context: contextText })
      : contextText !== null
        ? t('matters.detail.waitingContext', { context: contextText })
        : t('matters.detail.waitingNames', { names: waitingNames.join('、') })

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <Hourglass size={11} className="shrink-0 text-warn" />
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onSave(draft.trim() ? { note: draft.trim() } : null)
              setEditing(false)
            }
            if (event.key === 'Escape') setEditing(false)
          }}
          placeholder={t('matters.detail.waitingPlaceholder')}
          aria-label={t('matters.detail.waitingEdit')}
          className="h-7 w-52 px-2 text-meta"
        />
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            onSave(draft.trim() ? { note: draft.trim() } : null)
            setEditing(false)
          }}
          aria-label={t('matters.actions.save')}
          className="rounded-[var(--r-ctl)] p-1 text-ok transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
        >
          <Save size={12} />
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          aria-label={t('matters.actions.cancel')}
          className="rounded-[var(--r-ctl)] p-1 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
        >
          <X size={12} />
        </button>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setDraft(contextText ?? '')
          setEditing(true)
        }}
        title={t('matters.detail.waitingEdit')}
        className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1 py-0.5 text-meta text-warn transition-colors duration-fast ease-standard hover:bg-warn/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
      >
        <Hourglass size={11} className="shrink-0" />
        <span className="max-w-72 truncate">{label}</span>
      </button>
      {waitingContext !== null ? (
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(null)}
          aria-label={t('matters.detail.waitingClear')}
          className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
        >
          <X size={11} />
        </button>
      ) : null}
    </span>
  )
}

function MenuButton({
  icon,
  label,
  danger = false,
  onClick
}: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  onClick(): void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left text-body hover:bg-ink-3',
        danger && 'text-fail'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
