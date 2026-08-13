import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  Ban,
  Calendar,
  CheckCircle2,
  Eye,
  Hourglass,
  Layers,
  Play,
  Plus,
  Settings,
  Sparkles,
  Target,
  TriangleAlert,
  Trash2
} from 'lucide-react'

import type {
  Matter,
  MatterCreateInput,
  MatterTagDefinition,
  MatterUpdate
} from '@shared/api/types/matter'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import {
  filterView,
  MATTER_VIEWS,
  matterTagView,
  openAttentionFor
} from '@shared/lib/matterDerive'
import type { MatterBuiltinView, MatterView } from '@shared/lib/matterDerive'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { MatterCreateDialog } from './MatterCreateDialog'
import { MatterDetail } from './MatterDetail'
import { MatterFocus } from './MatterFocus'
import { MatterList } from './MatterList'
import { MatterTagManagerModal } from './MatterTagManagerModal'
import { MatterTagMarker } from './MatterTagMarker'
import { useAttentionAction, useGlobalAttention, useMatterFlags, useMattersApi } from './hooks'
import { getOrderedVisibleMatters } from './matterListOrder'
import { listMatterTagsSafely, MATTER_TAGS_QUERY_KEY } from './matterTags'
import { useMatterNavigation } from './navigation'

const MATTER_LIST_WIDTH_STORAGE_KEY = 'mailagent.matters.listWidth'
const DEFAULT_MATTER_LIST_WIDTH = 320
const MIN_MATTER_LIST_WIDTH = 280
const MAX_MATTER_LIST_WIDTH = 480
const MATTER_LIST_WIDTH_STEP = 16

function clampMatterListWidth(width: number): number {
  return Math.min(MAX_MATTER_LIST_WIDTH, Math.max(MIN_MATTER_LIST_WIDTH, width))
}

function readMatterListWidth(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_MATTER_LIST_WIDTH
    const raw = localStorage.getItem(MATTER_LIST_WIDTH_STORAGE_KEY)
    if (raw === null) return DEFAULT_MATTER_LIST_WIDTH
    const persisted = Number(raw)
    return Number.isFinite(persisted) ? clampMatterListWidth(persisted) : DEFAULT_MATTER_LIST_WIDTH
  } catch {
    return DEFAULT_MATTER_LIST_WIDTH
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

// 🔴 逐项对照设计原型 `list.jsx` 的 VIEWS 表（设计 §7.6「icon 全部对照原型替换」）。
// 右侧注释是原型里写的语义名 —— 改动前 12 项里有 7 项与它不符，其中 monitoring 用了
// Monitor（显示器）是望文生义，原型要的是 eye（盯着看）。
const VIEW_ICONS: Record<MatterBuiltinView, React.ReactNode> = {
  focus: <Target size={14} />, // target
  attention: <TriangleAlert size={14} />, // alert
  review: <Sparkles size={14} />, // sparkles
  active: <Play size={14} />, // play
  waiting: <Hourglass size={14} />, // hourglass
  blocked: <Ban size={14} />, // ban
  planned: <Calendar size={14} />, // calendar
  monitoring: <Eye size={14} />, // eye
  all: <Layers size={14} />, // layers
  completed: <CheckCircle2 size={14} />, // checkcircle
  archived: <Archive size={14} />, // archive
  trash: <Trash2 size={14} /> // trash
}

export function MattersWorkspace(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMattersApi()
  const { mattersEnabled: enabled, matterAgentEnabled } = useMatterFlags()
  const queryClient = useQueryClient()
  const [view, setView] = useState<MatterView>('focus')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [matterListWidth, setMatterListWidth] = useState(readMatterListWidth)
  const [createOpen, setCreateOpen] = useState(false)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [reviewTarget, setReviewTarget] = useState<{ matterId: string; updateId: number } | null>(
    null
  )
  const navigationTarget = useMatterNavigation((state) => state.targetPublicId)
  const clearNavigationTarget = useMatterNavigation((state) => state.clear)
  const workspaceGridRef = useRef<HTMLDivElement>(null)
  const resizeDragRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
    currentWidth: number
    previousCursor: string
    previousUserSelect: string
  } | null>(null)

  const selectMatter = useCallback((publicId: string | null): void => {
    setSelectedId(publicId)
  }, [])

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

  const list = useQuery({
    queryKey: qk.matters.list(),
    queryFn: () => api.list({ limit: 100 }),
    enabled,
    staleTime: 30_000
  })
  const tagsQuery = useQuery<{ items: MatterTagDefinition[] }>({
    queryKey: MATTER_TAGS_QUERY_KEY,
    queryFn: () => listMatterTagsSafely(api),
    enabled,
    staleTime: 30_000
  })
  const allMatters = list.data?.items ?? []
  const tagItems = tagsQuery.data?.items ?? []
  const attentionQuery = useGlobalAttention(enabled)
  const attentionItems = attentionQuery.data?.items ?? []
  const attentionIndex = useMemo(() => {
    const index = new Map<string, typeof attentionItems>()
    for (const signal of attentionItems) {
      const matterId = signal.matter?.public_id
      if (!matterId) continue
      index.set(matterId, [...(index.get(matterId) ?? []), signal])
    }
    return index
  }, [attentionItems])
  const pendingUpdates = useQuery({
    queryKey: [...qk.matters.all(), 'pending-updates'],
    queryFn: async (): Promise<Array<{ matterId: string; updates: MatterUpdate[] }>> =>
      Promise.all(
        allMatters
          .filter((matter) => matter.archived_at == null && matter.deleted_at == null)
          .map(async (matter) => {
            const summaries = await api.listUpdates(matter.public_id, 'pending')
            const updates = await Promise.all(
              summaries.items.map((update) => api.getUpdate(matter.public_id, update.id))
            )
            return { matterId: matter.public_id, updates }
          })
      ),
    enabled: enabled && matterAgentEnabled && allMatters.length > 0,
    staleTime: 15_000
  })
  const updateIndex = useMemo(
    () =>
      new Map((pendingUpdates.data ?? []).map((entry) => [entry.matterId, entry.updates] as const)),
    [pendingUpdates.data]
  )
  const visible = useMemo(
    () => filterView(allMatters, view, attentionIndex, updateIndex),
    [allMatters, attentionIndex, updateIndex, view]
  )
  const orderedVisible = useMemo(
    () => getOrderedVisibleMatters(visible, search, attentionIndex),
    [attentionIndex, search, visible]
  )
  const orderedVisibleIds = useMemo(
    () => orderedVisible.map((matter) => matter.public_id),
    [orderedVisible]
  )
  const tagViews = useMemo(
    () =>
      tagItems
        .map((tag) => ({
          tag,
          key: matterTagView(tag.name),
          count: filterView(allMatters, matterTagView(tag.name)).length
        }))
        .filter((entry) => entry.count > 0),
    [allMatters, tagItems]
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

  useEffect(() => {
    if (selectedId && !visible.some((matter) => matter.public_id === selectedId)) selectMatter(null)
  }, [selectMatter, selectedId, visible])

  useEffect(() => {
    if (!navigationTarget) return
    if (!allMatters.some((matter) => matter.public_id === navigationTarget)) return
    setView('all')
    selectMatter(navigationTarget)
    clearNavigationTarget()
  }, [allMatters, clearNavigationTarget, navigationTarget, selectMatter])

  const create = useMutation({
    mutationFn: (input: MatterCreateInput) => api.create(input),
    onSuccess: async (result) => {
      setCreateOpen(false)
      await queryClient.invalidateQueries({ queryKey: qk.matters.list() })
      selectMatter(result.matter?.public_id ?? null)
      setView('all')
    },
    onError: (error) => toastError(t('matters.toast.createFailed'), errorMessage(error))
  })

  if (!enabled) return null

  const selected = selectedId
    ? (allMatters.find((matter) => matter.public_id === selectedId) ?? null)
    : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 设计 §7.4：去掉「事项工作台」通栏页头，「+ 新建事项」下沉到状态栏顶部 ——
          一级导航已经告诉用户身在何处，通栏标题只是在重复它并吃掉一整条竖直空间。 */}
      <div className="flex min-h-0 flex-1 max-[900px]:flex-col">
        <aside className="flex w-44 shrink-0 flex-col border-r border-ink-border bg-ink-1/45 p-2 max-[900px]:block max-[900px]:w-full max-[900px]:overflow-x-auto max-[900px]:border-b max-[900px]:border-r-0">
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="mb-2 inline-flex w-full items-center justify-center gap-1.5 rounded-[var(--r-ctl)] bg-coral/100 px-3 py-2 text-body font-medium text-accent-fg max-[900px]:w-auto"
          >
            <Plus size={15} />
            {t('matters.create.submit')}
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-none max-[900px]:overflow-visible">
            <nav className="space-y-1 max-[900px]:flex max-[900px]:min-w-max max-[900px]:space-x-1 max-[900px]:space-y-0">
              {MATTER_VIEWS.map((value) => {
                const count =
                  value === 'focus'
                    ? 0
                    : filterView(allMatters, value, attentionIndex, updateIndex).length
                const critical =
                  value === 'attention' &&
                  attentionItems.some(
                    (signal) => signal.state === 'open' && signal.severity === 'critical'
                  )
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setView(value)
                      selectMatter(null)
                    }}
                    className={cn(
                      'relative flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left text-body max-[900px]:w-auto',
                      (value === 'active' || value === 'all') &&
                        'mt-2 border-t border-ink-border pt-3',
                      view === value
                        ? 'row-selected acc-select font-medium text-ink-fg'
                        : critical
                          ? 'text-fail hover:bg-fail/10'
                          : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
                    )}
                  >
                    {VIEW_ICONS[value]}
                    <span className="min-w-0 flex-1">{t(`matters.views.${value}`)}</span>
                    {count > 0 ? (
                      <span
                        className={cn('font-mono text-meta tabular-nums', critical && 'text-fail')}
                      >
                        {count}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </nav>

            {/* 设计 `list.jsx::ViewRail` 第三段：有**使用中**标签才出现。计数与清单同口径
                —— 用的是清单自己那支 `filterView`（live 且含该标签），不是 tags 端点的
                `usage_count`（那个把归档事项也算进去，会与点进去看到的行数对不上）。
                逐标签发请求是明令禁止的（列表性能铁律），这里全程零请求：`allMatters`
                与 tag 定义都是工作台已有的两支查询。 */}
            {tagViews.length > 0 ? (
              <div className="mt-2 border-t border-ink-border pt-2">
                <div className="flex items-center gap-1 px-2.5 pb-1 max-[900px]:hidden">
                  <span className="flex-1 font-mono text-micro uppercase tracking-[0.08em] text-ink-fg-3">
                    {t('matters.shell.tagsTitle')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setTagManagerOpen(true)}
                    aria-label={t('matters.tags.manage')}
                    title={t('matters.tags.manage')}
                    className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
                  >
                    <Settings size={13} />
                  </button>
                </div>
                <nav className="space-y-1 max-[900px]:flex max-[900px]:min-w-max max-[900px]:space-x-1 max-[900px]:space-y-0">
                  {tagViews.map(({ tag, key, count }) => (
                    <button
                      key={tag.name}
                      type="button"
                      onClick={() => {
                        setView(key)
                        selectMatter(null)
                      }}
                      className={cn(
                        'relative flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left text-body max-[900px]:w-auto',
                        view === key
                          ? 'row-selected acc-select font-medium text-ink-fg'
                          : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
                      )}
                    >
                      <MatterTagMarker color={tag.color} shape={tag.shape} className="h-3.5 w-3.5" />
                      <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                      <span className="font-mono text-meta tabular-nums">{count}</span>
                    </button>
                  ))}
                </nav>
              </div>
            ) : null}
          </div>

          {/* 设计 `list.jsx:117-121` 的底部注脚：1px 上边线 + mono 两行。<900px 转横向条时
              不渲染（两行说明塞进一条横带只会挤掉视图本身）。 */}
          <div className="-mx-2 mt-auto shrink-0 border-t border-ink-border-soft px-3 pt-2 font-mono text-micro leading-[1.7] text-ink-fg-3 max-[900px]:hidden">
            <div>{t('matters.shell.footnoteLocal')}</div>
            <div>{t('matters.shell.footnoteRemote')}</div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          {view === 'focus' ? (
            <MatterFocus
              matters={allMatters}
              signals={attentionItems}
              updates={updateIndex}
              onSelect={(matter) => {
                setView('all')
                selectMatter(matter.public_id)
              }}
              onReview={(matter, updateId) => {
                setView('review')
                selectMatter(matter.public_id)
                setReviewTarget({ matterId: matter.public_id, updateId })
              }}
              onSignal={handleAttentionAction}
              onView={(next) => setView(next)}
            />
          ) : (
            <div
              ref={workspaceGridRef}
              className="grid h-full min-h-0 grid-cols-[var(--matter-list-width)_6px_minmax(420px,1fr)] max-[1180px]:grid-cols-1"
              style={{ '--matter-list-width': `${matterListWidth}px` } as React.CSSProperties}
            >
              <div className={cn('min-h-0', selected && 'max-[1180px]:hidden')}>
                <MatterList
                  matters={visible}
                  view={view}
                  selectedId={selectedId}
                  attention={attentionIndex}
                  updates={updateIndex}
                  search={search}
                  tagDefinitions={tagItems}
                  onSearchChange={setSearch}
                  onSelect={(matter: Matter) => selectMatter(matter.public_id)}
                  onCreate={() => setCreateOpen(true)}
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
                className="group relative z-10 cursor-col-resize touch-none outline-none max-[1180px]:hidden"
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
                  workspaceGridRef.current?.style.setProperty(
                    '--matter-list-width',
                    `${nextWidth}px`
                  )
                }}
                onPointerUp={(event) =>
                  finishMatterListResize(event.currentTarget, event.pointerId)
                }
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
                  workspaceGridRef.current?.style.setProperty(
                    '--matter-list-width',
                    `${nextWidth}px`
                  )
                  setMatterListWidth(nextWidth)
                  writeMatterListWidth(nextWidth)
                }}
              >
                <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-ink-border transition-colors group-hover:bg-coral/70 group-focus-visible:bg-coral/70" />
              </div>
              <div className={cn('min-h-0', !selected && 'max-[1180px]:hidden')}>
                {selected ? (
                  <MatterDetail
                    matterId={selected.public_id}
                    onBack={() => selectMatter(null)}
                    onRemoved={() => selectMatter(null)}
                    navigationMatterIds={orderedVisibleIds}
                    onNavigateMatter={selectMatter}
                    attentionSignals={openAttentionFor(selected, attentionIndex)}
                    onAttentionAction={handleAttentionAction}
                    initialReviewId={
                      reviewTarget?.matterId === selected.public_id ? reviewTarget.updateId : null
                    }
                    onReviewOpened={() => setReviewTarget(null)}
                  />
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
      </div>

      <MatterCreateDialog
        open={createOpen}
        busy={create.isPending}
        onClose={() => setCreateOpen(false)}
        onCreate={(input) => create.mutate(input)}
        onUseExisting={(candidate) => {
          setCreateOpen(false)
          setView('all')
          selectMatter(candidate.matter.public_id)
        }}
      />

      {/* 左轨标签分组的齿轮（design `list.jsx:92`）开的就是详情页那一个标签管理弹窗 —— 同
          一份数据只有一个可写面。 */}
      <MatterTagManagerModal
        open={tagManagerOpen}
        tags={tagItems}
        onOpenChange={setTagManagerOpen}
      />
    </div>
  )
}
