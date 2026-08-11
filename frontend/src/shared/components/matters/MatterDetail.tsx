import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronRight,
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
  MatterActorKind,
  MatterEvent,
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
import { Checkbox } from '@shared/components/ui/checkbox'
import { Input } from '@shared/components/ui/input'
import { SegmentedControl } from '@shared/components/ui/segmented'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { cn } from '@shared/lib/cn'
import { asWriteError, errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { useMediaQuery } from '@shared/hooks/useMediaQuery'
import { useShortcut } from '@shared/hooks/useShortcut'
import { useActiveEmail } from '@shared/state/active-email'
import { openMatterChat, useAIChatPanel } from '@shared/state/ai-chat-panel'
import { toastError, toastInfo, toastSuccess } from '@shared/state/toast'

import { AddItemModal } from './AddItemModal'
import { MatterContextRail } from './MatterContextRail'
import { MatterContextTab } from './MatterContextTab'
import { ResourceDrawer } from './ResourceDrawer'
import { MatterRunsPane } from './MatterRunsPane'
import { MatterTagChip } from './MatterTagMarker'
import { MatterTagManagerModal } from './MatterTagManagerModal'
import { MatterTagPicker } from './MatterTagPicker'
import { MatterUpdateReview, type ReviewAcceptPayload } from './MatterUpdateReview'
import { parseMatterSchedule } from './matterSchedule'
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
type TimelineFilter = 'all' | MatterActorKind

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
  const showContextRail = useMediaQuery('(min-width: 1400px)')
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
        return {
          value,
          label: (
            <span className="inline-flex items-center gap-1.5">
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
            </span>
          )
        }
      }),
    [matterAgentEnabled, resourceItems.length, runs.length, stakeholderItems.length, t, tab]
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

  const patch = useMutation({
    mutationFn: (input: MatterPatchInput) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.patch(matterId, input, { expectedVersion: matter.version })
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const transition = useMutation({
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

  const addItem = useMutation({
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

  const updateItem = useMutation({
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

  const permanentDelete = useMutation({
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

  const toggleResourcePin = useMutation({
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

  const cancelRun = useMutation({
    mutationFn: (runId: number) => api.cancelRun(matterId, runId),
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })
  const reviewMutation = useMutation({
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
      const writeError = asWriteError(error)
      if (writeError.code === 'E_UPDATE_STALE' || writeError.code === 'E_VERSION_CONFLICT') {
        setReviewError(
          writeError.code === 'E_UPDATE_STALE'
            ? t('matters.review.staleReload', {
                defaultValue: '提案已过期，已刷新事项数据。请重载后让 Agent 重新跑一轮。'
              })
            : t('matters.review.versionReload', {
                defaultValue: '事项已被更新，已刷新最新版本。请重载后重试。'
              })
        )
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: qk.matters.detail(matterId) }),
          queryClient.invalidateQueries({ queryKey: [...qk.matters.detail(matterId), 'updates'] }),
          queryClient.invalidateQueries({
            queryKey: [...qk.matters.detail(matterId), 'update', reviewId]
          })
        ])
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
              <div className="flex flex-wrap items-center gap-2 text-meta text-ink-fg-2">
                <span className="font-mono">{matter.public_id}</span>
                <MatterTypeEditor
                  value={matter.matter_type}
                  busy={patch.isPending}
                  onChange={(matterType) => patch.mutate({ matter_type: matterType })}
                />
                <span>
                  {t('matters.detail.created', {
                    date: new Date(matter.created_at).toLocaleDateString()
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
                      className="h-8 min-w-0 flex-1 px-2 text-heading font-semibold"
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
                    <h1 className="min-w-0 text-heading font-semibold text-ink-fg">
                      {matter.title}
                    </h1>
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
                <Select
                  value={matter.health}
                  onValueChange={(health) => patch.mutate({ health: health as MatterHealth })}
                >
                  <SelectTrigger className="h-auto w-auto rounded-[var(--r-pill)] px-2 py-1 text-meta">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MATTER_HEALTH_VALUES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`matters.health.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <SegmentedControl<MatterPriority>
                  value={matter.priority}
                  onChange={(priority) => patch.mutate({ priority })}
                  options={MATTER_PRIORITIES.map((value) => ({
                    value,
                    label: value.toUpperCase()
                  }))}
                  ariaLabel={t('matters.detail.priority')}
                  className="font-mono uppercase"
                />
                <DueDateControl
                  value={matter.due_at}
                  saving={patch.isPending}
                  onChange={(due_at) => patch.mutate({ due_at })}
                />
                {/* 判定与右栏绑定卡同源：跟进 Agent 自 0811 起是内置的，profile 可为空，
                    `agent_enabled` 才是权威。此前这里额外要求 profile 非空，导致同一屏
                    右栏显示「内置 · 已启用」而头部显示「未绑定跟进 Agent」。 */}
                {matter.agent_enabled === true || matter.agent_enabled === 1 ? (
                  <span className="inline-flex items-center gap-1 rounded-[var(--r-pill)] border border-ai/25 bg-ai/10 px-2 py-1 text-meta text-ai">
                    <Sparkles size={12} />
                    {profiles.find((profile) => profile.id === matter.agent_profile_id)?.title ??
                      matter.agent_profile_id ??
                      t('matters.agentBinding.title')}{' '}
                    · {scheduleLabel ?? t('matters.runs.manual')}
                    {nextRun && nextRun.kind === 'run'
                      ? ` · ${t('matters.agentBinding.next')} ${new Date(nextRun.utcMs).toLocaleString()}`
                      : ''}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-[var(--r-pill)] border border-dashed border-ink-border px-2 py-1 text-meta text-ink-fg-2">
                    <Bot size={12} />
                    {t('matters.detail.agentUnbound')}
                  </span>
                )}
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
                onClick={() =>
                  startRun.mutate(
                    { expectedVersion: matter.version },
                    {
                      onSuccess: (result) => {
                        setOverlayRunId(result.run.id)
                        if (result.coalesced)
                          toastInfo(
                            t('matters.runs.coalesced', { defaultValue: '已有一轮跟进在进行' })
                          )
                      },
                      onError: (error) =>
                        toastError(
                          t('matters.runs.startFailed', { defaultValue: '请刷新后重试' }),
                          errorMessage(error)
                        )
                    }
                  )
                }
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
            <Timeline events={timeline} />
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
              <h2 className="text-title font-semibold text-fail">{t('matters.delete.title')}</h2>
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
      {/* P6-A — Matter Chat lives in AssistantChatModal, so the context rail keeps its slot. */}
      {showContextRail ? (
        <MatterContextRail
          matter={matter}
          runs={runs}
          matterAgentEnabled={matterAgentEnabled}
          onPatch={(input) => patch.mutate(input)}
          profiles={profiles}
          resources={resourceItems}
          stakeholders={stakeholderItems}
          onOpenResource={setDrawerItem}
          onTogglePin={(item) => toggleResourcePin.mutate(item)}
          onChanged={() => void refresh()}
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

function StatusMenu({
  value,
  onChange
}: {
  value: MatterStatus
  onChange(value: MatterStatus): void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Select value={value} onValueChange={(status) => onChange(status as MatterStatus)}>
      <SelectTrigger className="h-auto w-auto rounded-[var(--r-pill)] border-coral/30 bg-coral/10 px-2 py-1 text-meta text-coral">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MATTER_STATUSES.map((status) => (
          <SelectItem key={status} value={status}>
            {t(`matters.status.${status}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

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
          className="h-auto w-auto min-w-24 rounded-[var(--r-pill)] px-2 py-1 text-meta"
        >
          <SelectValue>{value ?? t('matters.detail.typeUnset')}</SelectValue>
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
  onChange
}: {
  value: number | null
  saving: boolean
  onChange(value: number | null): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const inputValue = formatDateInputValue(value)
  const label =
    value == null
      ? t('matters.detail.noDue')
      : t('matters.detail.due', { date: new Date(value).toLocaleDateString() })

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
          className="rounded-[var(--r-pill)] px-2 py-1 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
        >
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
        <h2 className="text-title font-semibold">{t('matters.state.title')}</h2>
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
      <section className="rounded-[var(--r-card)] border border-dashed border-ink-border p-6 text-center">
        <p className="text-body text-ink-fg-2">{t('matters.item.empty')}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
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
      </section>
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

function Timeline({ events }: { events: readonly MatterEvent[] }): React.ReactElement {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<TimelineFilter>('all')
  const options = useMemo(
    () => [
      { value: 'all' as const, label: t('matters.timeline.all') },
      { value: 'user' as const, label: t('matters.timeline.me') },
      { value: 'agent' as const, label: t('matters.timeline.agent') },
      { value: 'system' as const, label: t('matters.timeline.system') }
    ],
    [t]
  )
  const visible = filter === 'all' ? events : events.filter((event) => event.actor_kind === filter)
  return (
    <section>
      <SegmentedControl<TimelineFilter>
        value={filter}
        onChange={setFilter}
        options={options}
        ariaLabel={t('matters.timeline.filter')}
      />
      <div className="mt-4 space-y-3">
        {visible.map((event) => (
          <div
            key={event.id}
            className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-1/65 px-4 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-body font-medium">
                {t(`matters.events.${event.kind}`, { defaultValue: event.kind })}
              </span>
              <time className="text-meta text-ink-fg-2">
                {new Date(event.happened_at).toLocaleString()}
              </time>
            </div>
            <p className="mt-1 text-meta text-ink-fg-2">
              {/* actor/source 都 fallback 回原值：source 的值域会随触发方式增长
                  （定时/事件/条件…），漏一个也只是显示原始标识，不该是缺失占位符。 */}
              {t(`matters.eventActor.${event.actor_kind}`, { defaultValue: event.actor_kind })} ·{' '}
              {t(`matters.eventSource.${event.source}`, { defaultValue: event.source })}
            </p>
          </div>
        ))}
        {visible.length === 0 ? (
          <div className="rounded-[var(--r-card)] border border-dashed border-ink-border p-8 text-center text-body text-ink-fg-2">
            {t('matters.timeline.empty')}
          </div>
        ) : null}
      </div>
    </section>
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
