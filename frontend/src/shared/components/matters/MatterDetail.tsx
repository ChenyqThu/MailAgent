import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Clock,
  MessageSquare,
  MoreHorizontal,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Sparkles,
  X
} from 'lucide-react'

import {
  BUILTIN_MATTER_TYPES,
  MATTER_HEALTH_VALUES,
  MATTER_ITEM_KINDS,
  MATTER_PRIORITIES,
  MATTER_STATUSES
} from '@shared/api/types/matter'
import type {
  Matter,
  MatterAttentionSignal,
  MatterGoalCheck,
  MatterHealth,
  MatterItem,
  MatterItemCreateInput,
  MatterItemKind,
  MatterPatchInput,
  MatterPriority,
  MatterResourceListItem,
  MatterStatus,
  MatterTagDefinition
} from '@shared/api/types/matter'
import { preview } from '@shared/components/agents/schedule/occurrences'
import { sentenceText } from '@shared/components/agents/schedule/sentence'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Checkbox } from '@shared/components/ui/checkbox'
import { Input } from '@shared/components/ui/input'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/components/ui/select'
import { cn } from '@shared/lib/cn'
import { asWriteError, errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { useShortcut } from '@shared/hooks/useShortcut'
import { useActiveEmail } from '@shared/state/active-email'
import { openMatterChat, useAIChatPanel } from '@shared/state/ai-chat-panel'
import { toastError, toastInfo, toastSuccess } from '@shared/state/toast'

import { AddItemModal } from './AddItemModal'
import { MatterAgentConfigModal } from './MatterAgentConfigModal'
import { MatterContextTab } from './MatterContextTab'
import { ResourceDrawer } from './ResourceDrawer'
import { MatterRunsPane } from './MatterRunsPane'
import { MatterTagChip } from './MatterTagMarker'
import { MatterTagManagerModal } from './MatterTagManagerModal'
import { MatterTagPicker } from './MatterTagPicker'
import { MatterTimeline } from './MatterTimeline'
import { MatterUpdateReview, type ReviewAcceptPayload } from './MatterUpdateReview'
import { isMatterStaleError, useMatterMutation } from './matterMutation'
import { parseMatterSchedule } from './matterSchedule'
import {
  MATTER_DETAIL_TAB_ICONS,
  MATTER_HEALTH_ICONS,
  MATTER_HEALTH_TEXT_CLASS,
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
  useMatterRuns,
  useMatterUpdates,
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

const DETAIL_TYPE_UNSET = '__detail_type_unset__'
const DETAIL_TYPE_CUSTOM = '__detail_type_custom__'
const DATE_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function formatDateInputValue(timestamp: number | null): string {
  if (timestamp == null) return ''
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDateInputValue(value: string): number | null {
  if (!value) return null
  const match = DATE_INPUT_RE.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date.getTime()
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
  const { matterAgentEnabled } = useMatterFlags()
  const runsQuery = useMatterRuns(matterId, matterAgentEnabled)
  const updatesQuery = useMatterUpdates(matterId, 'pending', matterAgentEnabled)
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
    staleTime: 15_000
  })
  const matter = detail.data?.matter
  const chatOpen = Boolean(matter && assistantVisible && activeMatterChatId === matter.id)
  const items = detail.data?.items ?? []
  const timeline = detail.data?.timeline ?? []
  const resources = useQuery({
    queryKey: qk.matters.resources(matterId),
    queryFn: () => api.listResources(matterId, { includeUnavailable: true }),
    staleTime: 15_000
  })
  const stakeholders = useQuery({
    queryKey: qk.matters.stakeholders(matterId),
    queryFn: () => api.listStakeholders(matterId),
    staleTime: 15_000
  })
  const tagsQuery = useQuery<{ items: MatterTagDefinition[] }>({
    queryKey: MATTER_TAGS_QUERY_KEY,
    queryFn: () => listMatterTagsSafely(api),
    staleTime: 30_000
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
  const updates = updatesQuery.data?.items ?? []
  const detailAttention = matterAttentionQuery.data?.items ?? attentionSignals
  const profiles = profilesQuery.data ?? []
  const activeRun = runs.find(
    (run) => run.lifecycle_state === 'queued' || run.lifecycle_state === 'running'
  )
  const overlayRun = runs.find((run) => run.id === overlayRunId)
  const detailTabOptions = useMemo(
    () =>
      (
        [
          'state',
          'context',
          'timeline',
          ...(matterAgentEnabled ? (['runs'] as const) : [])
        ] as const
      ).map((value) => {
        const count =
          value === 'context'
            ? resourceItems.length + stakeholderItems.length
            : value === 'runs'
              ? runs.length
              : null
        // 设计 detail.jsx:578 `DETAIL_TABS` 每档带一个 icon（target/layers/history/activity），
        // 实现此前四个 tab 一个 icon 都没有。
        const TabIcon = MATTER_DETAIL_TAB_ICONS[value]
        return {
          value,
          ariaLabel: t(`matters.tabs.${value}`),
          label: (
            <span className="inline-flex items-center gap-1.5">
              <TabIcon size={13} />
              {t(`matters.tabs.${value}`)}
              {count !== null ? (
                <span
                  className={cn(
                    'min-w-5 rounded-[var(--r-pill)] border px-1.5 font-mono text-[11px] leading-4',
                    tab === value
                      ? 'border-ink-border bg-ink-fg/[0.08] text-ink-fg-1'
                      : 'border-ink-border-soft bg-ink-2/70 text-ink-fg-2'
                  )}
                >
                  {count}
                </span>
              ) : null}
              {/* 设计 detail.jsx:602 —— 有未确认的 AI 建议资料时，上下文 tab 挂一个 6px 红点。 */}
              {value === 'context' && hasSuggestedResources ? (
                <span
                  aria-label={t('matters.resource.suggested')}
                  className="size-1.5 rounded-full bg-ai"
                />
              ) : null}
            </span>
          )
        }
      }),
    [
      hasSuggestedResources,
      matterAgentEnabled,
      resourceItems.length,
      runs.length,
      stakeholderItems.length,
      t,
      tab
    ]
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

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.matters.list() }),
      queryClient.invalidateQueries({ queryKey: qk.matters.detail(matterId) }),
      queryClient.invalidateQueries({ queryKey: qk.matters.resources(matterId) }),
      queryClient.invalidateQueries({ queryKey: qk.matters.stakeholders(matterId) }),
      queryClient.invalidateQueries({ queryKey: MATTER_TAGS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: [...qk.matters.detail(matterId), 'runs'] }),
      queryClient.invalidateQueries({ queryKey: [...qk.matters.detail(matterId), 'updates'] })
    ])
  }

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
    onSuccess: async () => {
      await refresh()
      toastSuccess(t('matters.toast.saved'))
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
      await queryClient.invalidateQueries({ queryKey: qk.matters.list() })
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
    onSuccess: async () => {
      const next = updates.filter((item) => item.id !== reviewId)[0]
      setReviewError(null)
      await refresh()
      toastSuccess(t('matters.toast.saved'))
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
            ? t('matters.review.staleReload', {
                defaultValue: '提案已过期，已刷新事项数据。请重载后让 Agent 重新跑一轮。'
              })
            : t('matters.review.versionReload', {
                defaultValue: '事项已被更新，已刷新最新版本。请重载后重试。'
              })
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
   * 「立即跟进」与失效提案上的「重新跑一轮」发起的是同一次跟进，只差后者要顺手关掉审阅面
   * （否则用户盯着一张已经作废的提案等新结果）。共用一个函数，省得两处的 coalesced /
   * 失败提示各写一份、日后漂开。
   */
  const startFollowUpRun = (onStarted?: () => void): void => {
    startRun.mutate(
      { expectedVersion: matter.version },
      {
        onSuccess: (result) => {
          setOverlayRunId(result.run.id)
          onStarted?.()
          if (result.coalesced)
            toastInfo(t('matters.runs.coalesced', { defaultValue: '已有一轮跟进在进行' }))
        },
        onError: (error) =>
          toastError(
            t('matters.runs.startFailed', { defaultValue: '请刷新后重试' }),
            errorMessage(error)
          )
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
            <button
              type="button"
              onClick={onBack}
              className="mt-0.5 hidden rounded-[var(--r-ctl)] p-1.5 hover:bg-ink-3 max-[1180px]:block"
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
                {/* 设计 detail.jsx:162 —— 一个 flex spacer 把跟进 Agent 推到行尾。 */}
                <span className="flex-1" />
                {/* 🔴 pill 必须是**按钮**（设计 detail.jsx:163 `onClick={ctx.onOpenAgent}`）：
                    它此前是个纯 <span>，而唯一的跟进配置 UI 在 ≥1400px 才渲染的右栏里 ——
                    窗口小一点就完全没有入口（0812 dogfood「无法切换跟进的方式」）。 */}
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
                disabled={Boolean(activeRun) || startRun.isPending}
                onClick={() => startFollowUpRun()}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-aux disabled:opacity-50"
              >
                {activeRun || startRun.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Play size={13} />
                )}{' '}
                {activeRun
                  ? t('matters.runs.runningButton', { defaultValue: '运行中…' })
                  : t('matters.runs.runNow', { defaultValue: '立即跟进' })}
              </button>
            ) : null}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMoreOpen((value) => !value)}
                className="rounded-[var(--r-ctl)] p-2 hover:bg-ink-3"
              >
                <MoreHorizontal size={17} />
              </button>
              {moreOpen ? (
                <div className="absolute right-0 top-10 z-20 w-48 rounded-[var(--r-card)] border border-ink-border bg-ink-1 p-1 shadow-md">
                  {matter.archived_at === null && matter.deleted_at === null ? (
                    <MenuButton
                      icon={<Archive size={14} />}
                      label={t('matters.actions.archive')}
                      onClick={() => transition.mutate('archive')}
                    />
                  ) : null}
                  {matter.archived_at !== null && matter.deleted_at === null ? (
                    <MenuButton
                      icon={<RotateCcw size={14} />}
                      label={t('matters.actions.restoreArchive')}
                      onClick={() => transition.mutate('reopen')}
                    />
                  ) : null}
                  {matter.deleted_at === null ? (
                    <MenuButton
                      icon={<Trash2 size={14} />}
                      label={t('matters.actions.trash')}
                      danger
                      onClick={() => transition.mutate('trash')}
                    />
                  ) : (
                    <>
                      <MenuButton
                        icon={<RotateCcw size={14} />}
                        label={t('matters.actions.restore')}
                        onClick={() => transition.mutate('restore')}
                      />
                      <MenuButton
                        icon={<Trash2 size={14} />}
                        label={t('matters.actions.permanentDelete')}
                        danger
                        onClick={() => setDeleteOpen(true)}
                      />
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <div className="border-b border-ink-border px-5 py-2">
          <SegmentedControl<DetailTab>
            value={tab}
            onChange={setTab}
            options={detailTabOptions}
            ariaLabel={t('matters.tabs.label')}
            size="md"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin">
          {updates.length > 0 ? (
            <div className="mb-5 flex items-center gap-3 rounded-[var(--r-card)] border border-ai/25 bg-ai/[0.06] p-4">
              <span className="grid size-8 place-items-center rounded-lg bg-ai/12 text-ai">
                <Sparkles size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium">
                  {t('matters.review.attention', {
                    count: updates[0].change_count,
                    defaultValue: `跟进 Agent 提出了 ${updates[0].change_count} 项变化，等待你审阅`
                  })}
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
                {t('matters.runs.review', { defaultValue: '审阅' })}
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
          {tab === 'state' ? (
            <div className="space-y-5">
              <StateCard
                matter={matter}
                pendingCount={updates.length}
                onReview={() => setReviewId(updates[0]?.id ?? null)}
                saving={patch.isPending}
                onDescriptionSave={(description, onSaved) =>
                  patch.mutate({ description }, { onSuccess: onSaved })
                }
                onSummarySave={(current_summary, onSaved) =>
                  patch.mutate({ current_summary }, { onSuccess: onSaved })
                }
                onGoalChecksSave={(goal_checks, onSaved) =>
                  patch.mutate({ goal_checks }, { onSuccess: onSaved })
                }
              />
              <ItemGroups
                items={items}
                onToggle={(item) =>
                  updateItem.mutate({ item, status: item.status === 'done' ? 'open' : 'done' })
                }
                onAdd={(kind) => {
                  setAddKind(kind)
                  setAddOpen(true)
                }}
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

        {deleteOpen ? (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
            <section
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
      <button
        type="button"
        title={previousLabel}
        aria-label={previousLabel}
        disabled={!canPrevious}
        onClick={onPrevious}
        className="grid size-7 place-items-center transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:pointer-events-none disabled:opacity-40"
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
        className="grid size-7 place-items-center transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronDown size={14} />
      </button>
    </div>
  )
}

/**
 * 状态 chip（设计 detail.jsx:142 → `StatusChip` = 按 status tone 上色的 Pip + 每档一个 icon）。
 * 🔴 改动前是 shadcn Select，trigger 写死 coral ⇒ 8 档一个颜色、8 个 icon 全丢。
 */
function StatusMenu({
  value,
  onChange
}: {
  value: MatterStatus
  onChange(value: MatterStatus): void
}): React.ReactElement {
  const { t } = useTranslation()
  const Icon = MATTER_STATUS_ICONS[value]
  return (
    <Select value={value} onValueChange={(status) => onChange(status as MatterStatus)}>
      <SelectTrigger
        aria-label={t('matters.detail.status')}
        className={cn(
          'h-auto w-auto justify-start gap-1 whitespace-nowrap rounded-[var(--r-ctl)] px-2 py-1 text-meta',
          // 🔴 icon 与文字必须是 trigger 的**直接**子节点：base 上有 `[&>span]:line-clamp-1`
          // （0,2,0 特异性），包一层 span 会被它把 display 改成 -webkit-box，gap 直接失效。
          // 末位那个 svg 是 trigger 自带的 chevron，单独收小。
          '[&>svg:last-child]:size-3 [&>svg:last-child]:opacity-50',
          MATTER_TONE_CHIP_CLASS[MATTER_STATUS_TONES[value]]
        )}
      >
        <Icon size={11} className="shrink-0" />
        {t(`matters.status.${value}`)}
      </SelectTrigger>
      <SelectContent>
        {MATTER_STATUSES.map((status) => {
          const ItemIcon = MATTER_STATUS_ICONS[status]
          return (
            <SelectItem key={status} value={status}>
              <span className="inline-flex items-center gap-2">
                <ItemIcon
                  size={12}
                  className={MATTER_TONE_TEXT_CLASS[MATTER_STATUS_TONES[status]]}
                />
                {t(`matters.status.${status}`)}
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
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
 * 优先级（设计 detail.jsx:146-155 → 单个 mono 小标签按 tone 上色 + chevron，菜单每项前一个
 * 7px 彩色圆点）。🔴 改动前是 SegmentedControl，四档全平铺、占宽四倍、无颜色。
 * 档位文案仍是 P0…P3 —— 设计源 `PRIORITY[*].label` 本身就是这四个字面量，不发明中文档位名。
 */
function PriorityMenu({
  value,
  onChange
}: {
  value: MatterPriority
  onChange(value: MatterPriority): void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Select value={value} onValueChange={(priority) => onChange(priority as MatterPriority)}>
      <SelectTrigger
        aria-label={t('matters.detail.priority')}
        className={cn(
          'h-auto w-auto justify-start gap-1 rounded-[var(--r-ctl)] px-1.5 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.02em]',
          '[&>svg:last-child]:size-3 [&>svg:last-child]:opacity-50',
          MATTER_TONE_CHIP_CLASS[MATTER_PRIORITY_TONES[value]]
        )}
      >
        {value.toUpperCase()}
      </SelectTrigger>
      <SelectContent>
        {MATTER_PRIORITIES.map((priority) => (
          <SelectItem key={priority} value={priority}>
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  'size-[7px] shrink-0 rounded-full',
                  MATTER_TONE_DOT_CLASS[MATTER_PRIORITY_TONES[priority]]
                )}
              />
              <span className="font-mono">{priority.toUpperCase()}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  const skin = cn(
    'inline-flex items-center gap-1.5 rounded-[var(--r-pill)] px-2 py-1 text-meta',
    bound
      ? 'border border-ai/20 bg-ai/[0.08] text-ink-fg-1'
      : 'border border-dashed border-ink-border text-ink-fg-2'
  )
  if (!interactive) {
    return (
      <span className={skin}>
        <Sparkles size={11} className={bound ? 'text-ai' : undefined} />
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('matters.agentConfig.open')}
      className={cn(skin, 'transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.05]')}
    >
      <Sparkles size={11} className={bound ? 'text-ai' : undefined} />
      {label}
      <ChevronDown size={9} className="opacity-60" />
    </button>
  )
}

/** 相对时间（设计 `helpers.jsx::fmtAgo`）。走 Intl 而不是手写中文串 —— 组件里不硬编码文案。 */
function formatMatterAgo(at: number, now: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.round((at - now) / 60_000)
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return rtf.format(days, 'day')
  return rtf.format(Math.round(days / 30), 'month')
}

/**
 * 类型切换（设计 detail.jsx:111-122 → 元信息行里的**裸文本按钮** + 8px chevron，只在
 * hover/打开时才浮出一层 6% 底；负 margin 抵掉 padding，让它在文字流里不额外占宽）。
 * 🔴 改动前是常驻 pill 的 shadcn Select（`min-w-24` + 完整边框 + 输入框底），是这一行里
 * 视觉最重的元素，与刚改轻的 status/health/priority 三个 chip 不匹配。
 *
 * 「未指定类型」与「自定义类型」两个分支是实现侧比设计**多出来**的能力（设计只有 6 个
 * 固定值），保留 —— 这里只换触发器与菜单的形态。
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
  const [customOpen, setCustomOpen] = useState(false)
  const [customDraft, setCustomDraft] = useState('')
  const isBuiltin = value !== null && BUILTIN_MATTER_TYPES.some((type) => type === value)
  const selectValue = value === null ? DETAIL_TYPE_UNSET : isBuiltin ? value : value

  useEffect(() => {
    if (!customOpen) setCustomDraft(isBuiltin ? '' : (value ?? ''))
  }, [customOpen, isBuiltin, value])

  const saveCustom = (): void => {
    const next = customDraft.trim()
    if (!next) return
    onChange(next)
    setCustomOpen(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        value={selectValue}
        disabled={busy}
        onValueChange={(next) => {
          if (next === DETAIL_TYPE_CUSTOM) {
            setCustomOpen(true)
            return
          }
          setCustomOpen(false)
          onChange(next === DETAIL_TYPE_UNSET ? null : next)
        }}
      >
        <SelectTrigger
          aria-label={t('matters.detail.type')}
          className={cn(
            // 负 margin 抵消 padding：hover 底比文字大一圈，但按钮的外框仍与文字等宽，
            // 于是它在 `pub · 类型 · 创建于…` 这行里不会撑开额外的间距（设计 margin:'-2px -5px'）。
            'h-auto w-auto justify-start gap-[3px] whitespace-nowrap rounded-[var(--r-ctl)] border-0 -mx-[5px] -my-[2px] px-[5px] py-[2px]',
            // 字号与颜色**跟随同行元信息**（base 自带 text-aux + text-ink-fg 会让它比邻居大一号、
            // 深一档）。用 inherit 而不是写死 ink-fg-2：这一行的颜色改了它自动跟着改。
            'text-meta text-inherit',
            // `!` 压 SelectTrigger 自带的 authored `.input-surface`（见 matterVocab 里的说明：
            // 它写在 `@tailwind utilities` 之后且不在 layer 里，必胜 utilities）——
            // 设计要的是裸文本，只有 hover / 菜单打开时才浮出 6% 底。
            '!bg-transparent hover:!bg-ink-fg/[0.06] data-[state=open]:!bg-ink-fg/[0.06]',
            // 末位 svg = trigger 自带的 chevron，设计是 8px + 0.55 透明度。
            '[&>svg:last-child]:size-2 [&>svg:last-child]:opacity-[0.55]'
          )}
        >
          {/* 🔴 文本必须是 trigger 的**直接**子节点：base 上有 `[&>span]:line-clamp-1`
              （0,2,0 特异性），包一层 <SelectValue>（渲染成 span）会被它把 display 改成
              -webkit-box，gap-[3px] 直接失效。同 StatusMenu / HealthMenu 的做法。 */}
          {value ?? t('matters.detail.typeUnset')}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DETAIL_TYPE_UNSET}>{t('matters.detail.typeUnset')}</SelectItem>
          {value !== null && !isBuiltin ? <SelectItem value={value}>{value}</SelectItem> : null}
          {BUILTIN_MATTER_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {type}
            </SelectItem>
          ))}
          <SelectItem value={DETAIL_TYPE_CUSTOM}>{t('matters.detail.typeCustom')}</SelectItem>
        </SelectContent>
      </Select>
      {customOpen ? (
        <div className="flex items-center gap-1">
          <Input
            autoFocus
            value={customDraft}
            onChange={(event) => setCustomDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveCustom()
              if (event.key === 'Escape') setCustomOpen(false)
            }}
            placeholder={t('matters.detail.typeCustomPlaceholder')}
            aria-label={t('matters.detail.typeCustomPlaceholder')}
            className="h-7 w-36 px-2 text-meta"
          />
          <button
            type="button"
            disabled={!customDraft.trim() || busy}
            onClick={saveCustom}
            aria-label={t('matters.actions.save')}
            className="rounded-[var(--r-ctl)] p-1.5 text-ok transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
          >
            <Save size={13} />
          </button>
          <button
            type="button"
            onClick={() => setCustomOpen(false)}
            aria-label={t('matters.actions.cancel')}
            className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
          >
            <X size={13} />
          </button>
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
  const [editing, setEditing] = useState(false)
  const inputValue = formatDateInputValue(value)
  const label =
    value == null
      ? t('matters.detail.noDue')
      : t('matters.detail.due', { date: new Date(value).toLocaleDateString() })
  // 设计 detail.jsx:50 `DueButton`：未设置 = 虚线边框 + fg-3；已设置 = 按 due tone 上色的实线。
  const tone = matterDueTone(value, now)

  return (
    <span className="inline-flex items-center gap-1 text-meta text-ink-fg-2">
      {editing ? (
        <Input
          autoFocus
          type="date"
          value={inputValue}
          disabled={saving}
          onChange={(event) => {
            onChange(parseDateInputValue(event.target.value))
            setEditing(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false)
          }}
          onBlur={() => setEditing(false)}
          aria-label={label}
          className="h-7 w-[9.5rem] rounded-[var(--r-pill)] px-2 py-1 text-meta"
        />
      ) : (
        <button
          type="button"
          disabled={saving}
          onClick={() => setEditing(true)}
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
      )}
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

function StateCard({
  matter,
  pendingCount,
  onReview,
  saving,
  onDescriptionSave,
  onSummarySave,
  onGoalChecksSave
}: {
  matter: Matter
  pendingCount: number
  onReview(): void
  saving: boolean
  onDescriptionSave(description: string, onSaved: () => void): void
  onSummarySave(summary: string | null, onSaved: () => void): void
  onGoalChecksSave(goalChecks: MatterGoalCheck[], onSaved?: () => void): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [summaryEditing, setSummaryEditing] = useState(false)
  const [summaryDraft, setSummaryDraft] = useState(matter.current_summary ?? '')
  const [descriptionEditing, setDescriptionEditing] = useState(false)
  const [descriptionDraft, setDescriptionDraft] = useState(matter.description)
  const [addingGoalCheck, setAddingGoalCheck] = useState(false)
  const [goalCheckDraft, setGoalCheckDraft] = useState('')
  const goalChecks = matter.goal_checks ?? []
  const doneGoalChecks = goalChecks.filter((check) => check.done).length
  const summaryValue = matter.current_summary ?? ''
  const normalizedSummaryDraft = summaryDraft.trim() ? summaryDraft : null

  useEffect(() => {
    if (!summaryEditing) setSummaryDraft(matter.current_summary ?? '')
  }, [matter.current_summary, summaryEditing])
  useEffect(() => {
    if (!descriptionEditing) setDescriptionDraft(matter.description)
  }, [descriptionEditing, matter.description])

  const saveSummary = (): void => {
    onSummarySave(normalizedSummaryDraft, () => setSummaryEditing(false))
  }

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
    <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-1/75 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lead font-semibold">{t('matters.state.title')}</h2>
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
      </div>
      {summaryEditing ? (
        <div className="mt-3">
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
          <p className="mt-3 whitespace-pre-wrap text-body text-ink-fg-1">
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
      <div className="mt-4 rounded-[var(--r-ctl)] border border-dashed border-ink-border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-meta font-medium text-ink-fg-2">
            {t('matters.state.descriptionLabel')}
          </div>
          {!descriptionEditing ? (
            <button
              type="button"
              onClick={() => setDescriptionEditing(true)}
              className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
            >
              <Pencil size={12} />
              {t('matters.actions.edit')}
            </button>
          ) : null}
        </div>
        {descriptionEditing ? (
          <div className="mt-2">
            <textarea
              autoFocus
              rows={7}
              value={descriptionDraft}
              onChange={(event) => setDescriptionDraft(event.target.value)}
              placeholder={t('matters.state.descriptionPlaceholder')}
              aria-label={t('matters.state.descriptionLabel')}
              className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body text-ink-fg outline-none transition-colors duration-fast ease-standard placeholder:text-ink-fg-3 focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
            />
            <p className="mt-1 text-meta text-ink-fg-2">{t('matters.state.markdownHint')}</p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDescriptionDraft(matter.description)
                  setDescriptionEditing(false)
                }}
                className="rounded-[var(--r-ctl)] px-2.5 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
              >
                {t('matters.actions.cancel')}
              </button>
              <button
                type="button"
                disabled={saving || descriptionDraft === matter.description}
                onClick={() =>
                  onDescriptionSave(descriptionDraft, () => setDescriptionEditing(false))
                }
                className="rounded-[var(--r-ctl)] bg-coral/100 px-3 py-1.5 text-aux font-medium text-accent-fg transition-[background-color,transform] duration-fast ease-standard hover:bg-coral-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 active:scale-[0.96] disabled:opacity-50"
              >
                {t('matters.actions.save')}
              </button>
            </div>
          </div>
        ) : matter.description ? (
          <div className="mt-2 [&_.mail-body_p:last-child]:mb-0">
            <TranslatedBody text={matter.description} />
          </div>
        ) : (
          <p className="mt-2 text-body text-ink-fg-2">{t('matters.state.noDescription')}</p>
        )}
      </div>
      <div className="mt-4 rounded-[var(--r-ctl)] border border-dashed border-ink-border p-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-meta font-medium text-ink-fg-2">{t('matters.state.goalChecks')}</h3>
          <span className="rounded-[var(--r-pill)] bg-ink-3 px-2 py-1 font-mono text-[11px] leading-4 text-ink-fg-2">
            {t('matters.state.goalChecksCount', {
              done: doneGoalChecks,
              total: goalChecks.length
            })}
          </span>
        </div>
        {goalChecks.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {goalChecks.map((check, index) => (
              <li
                key={`${index}-${check.t}`}
                className="group/check flex items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 transition-colors duration-fast ease-standard hover:bg-ink-2 focus-within:bg-ink-2"
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <Checkbox
                    checked={check.done}
                    disabled={saving}
                    onCheckedChange={(done) => setGoalCheckDone(index, done)}
                  />
                  <span
                    className={cn(
                      'min-w-0 flex-1 break-words text-body',
                      check.done ? 'text-ink-fg-3 line-through' : 'text-ink-fg-1'
                    )}
                  >
                    {check.t}
                  </span>
                </label>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => removeGoalCheck(index)}
                  aria-label={t('matters.actions.trash')}
                  className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-3 opacity-0 transition-[color,background-color,opacity] duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-40 group-hover/check:opacity-100 group-focus-within/check:opacity-100"
                >
                  <Trash2 size={12} />
                </button>
              </li>
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
            <Check size={13} className="mt-0.5 shrink-0" />
            <span>{t('matters.state.goalChecksAllDone')}</span>
          </div>
        ) : null}
      </div>
      {pendingCount > 0 ? (
        <button
          type="button"
          onClick={onReview}
          className="mt-4 inline-flex items-center gap-1 rounded-lg bg-ai/10 px-3 py-2 text-aux text-ai"
        >
          <Sparkles size={12} />有 {pendingCount} 条新提案
        </button>
      ) : null}
    </section>
  )
}

function ItemGroups({
  items,
  onToggle,
  onAdd
}: {
  items: readonly MatterItem[]
  onToggle(item: MatterItem): void
  onAdd(kind: MatterItemKind): void
}): React.ReactElement {
  const { t } = useTranslation()
  const activeItems = items.filter((item) => item.deleted_at === null)
  const groups = MATTER_ITEM_KINDS.map((kind) => ({
    kind,
    items: activeItems.filter((item) => item.kind === kind)
  })).filter((group) => group.items.length > 0)
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
          onToggle={onToggle}
          onAdd={onAdd}
        />
      ))}
    </section>
  )
}

function ItemGroup({
  kind,
  items,
  onToggle,
  onAdd
}: {
  kind: MatterItemKind
  items: readonly MatterItem[]
  onToggle(item: MatterItem): void
  onAdd(kind: MatterItemKind): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  return (
    <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-1/65">
      <div className="flex items-center justify-between border-b border-ink-border px-4 py-3">
        <h3 className="text-body font-medium">
          {t(`matters.item.kinds.${kind}`)} <span className="text-ink-fg-2">{items.length}</span>
        </h3>
        <button
          type="button"
          onClick={() => onAdd(kind)}
          className="rounded-[var(--r-ctl)] p-1.5 hover:bg-ink-3"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="divide-y divide-ink-border">
        {items.map((item) => {
          const isExpanded = expanded.has(item.id)
          return (
            <div key={item.id} className="px-4 py-3">
              <div className="flex items-start gap-2.5">
                {item.kind === 'action' ? (
                  <button
                    type="button"
                    onClick={() => onToggle(item)}
                    className={cn(
                      'mt-0.5 grid h-4 w-4 place-items-center rounded border',
                      item.status === 'done'
                        ? 'border-ok bg-ok text-accent-fg'
                        : 'border-ink-border'
                    )}
                  >
                    {item.status === 'done' ? <Check size={11} /> : null}
                  </button>
                ) : null}
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      'text-body',
                      item.status === 'done' && 'text-ink-fg-2 line-through'
                    )}
                  >
                    {item.title}
                  </div>
                  {item.description ? (
                    <div className="mt-1 [&_.mail-body]:text-aux [&_.mail-body]:leading-relaxed [&_.mail-body_p]:mb-2 [&_.mail-body_p:last-child]:mb-0">
                      <TranslatedBody text={item.description} />
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
