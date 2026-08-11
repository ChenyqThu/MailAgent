import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  Ban,
  CheckCircle2,
  CircleDot,
  Clock3,
  Focus,
  Inbox,
  List,
  Monitor,
  Plus,
  Sparkles,
  ShieldAlert,
  TriangleAlert,
  Trash2
} from 'lucide-react'

import type { Matter, MatterCreateInput, MatterUpdate } from '@shared/api/types/matter'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { filterView, MATTER_VIEWS, openAttentionFor } from '@shared/lib/matterDerive'
import type { MatterView } from '@shared/lib/matterDerive'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { MatterCreateDialog } from './MatterCreateDialog'
import { MatterDetail } from './MatterDetail'
import { MatterFocus } from './MatterFocus'
import { MatterList } from './MatterList'
import type { MatterDensity } from './MatterList'
import { useAttentionAction, useGlobalAttention, useMatterFlags, useMattersApi } from './hooks'
import { useMatterNavigation } from './navigation'

const VIEW_ICONS: Record<MatterView, React.ReactNode> = {
  focus: <Focus size={14} />,
  attention: <TriangleAlert size={14} />,
  review: <Sparkles size={14} />,
  active: <CircleDot size={14} />,
  waiting: <Clock3 size={14} />,
  blocked: <ShieldAlert size={14} />,
  planned: <Inbox size={14} />,
  monitoring: <Monitor size={14} />,
  all: <List size={14} />,
  completed: <CheckCircle2 size={14} />,
  archived: <Archive size={14} />,
  trash: <Trash2 size={14} />
}

export function MattersWorkspace(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMattersApi()
  const { mattersEnabled: enabled, matterAgentEnabled } = useMatterFlags()
  const queryClient = useQueryClient()
  const [view, setView] = useState<MatterView>('focus')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [density, setDensity] = useState<MatterDensity>('compact')
  const [createOpen, setCreateOpen] = useState(false)
  const [reviewTarget, setReviewTarget] = useState<{ matterId: string; updateId: number } | null>(null)
  // P3 — 事项对话 open state. Owned here (not in MatterDetail) so switching / clearing the selected
  // matter closes the panel, which also resets the panel's own per-session state (scope falls back
  // to 'matter' on every reopen — D8 deliberately does not persist it).
  const [chatOpen, setChatOpen] = useState(false)
  const navigationTarget = useMatterNavigation((state) => state.targetPublicId)
  const clearNavigationTarget = useMatterNavigation((state) => state.clear)

  /** Every selection change goes through here so the chat panel can never stay open over a
   *  DIFFERENT matter (it is anchored on the one it was opened for). */
  const selectMatter = useCallback((publicId: string | null): void => {
    setSelectedId(publicId)
    setChatOpen(false)
  }, [])

  const list = useQuery({
    queryKey: qk.matters.list(),
    queryFn: () => api.list({ limit: 100 }),
    enabled,
    staleTime: 30_000
  })
  const allMatters = list.data?.items ?? []
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
    queryFn: async (): Promise<Array<{ matterId: string; updates: MatterUpdate[] }>> => Promise.all(allMatters.filter((matter) => matter.archived_at == null && matter.deleted_at == null).map(async (matter) => {
      const summaries = await api.listUpdates(matter.public_id, 'pending')
      const updates = await Promise.all(summaries.items.map((update) => api.getUpdate(matter.public_id, update.id)))
      return { matterId: matter.public_id, updates }
    })),
    enabled: enabled && matterAgentEnabled && allMatters.length > 0,
    staleTime: 15_000
  })
  const updateIndex = useMemo(() => new Map((pendingUpdates.data ?? []).map((entry) => [entry.matterId, entry.updates] as const)), [pendingUpdates.data])
  const visible = useMemo(() => filterView(allMatters, view, attentionIndex, updateIndex), [allMatters, attentionIndex, updateIndex, view])
  const attentionAction = useAttentionAction()

  const handleAttentionAction = (matterId: string, signalId: number, action: 'resolved' | 'snoozed' | 'dismissed'): void => {
    attentionAction.mutate({ matterId, signalId, action }, {
      onSuccess: () => toastSuccess(t(`matters.attention.toast.${action}`)),
      onError: (error) => toastError(t('matters.attention.toast.failed'), errorMessage(error))
    })
  }

  useEffect(() => {
    if (selectedId && !visible.some((matter) => matter.public_id === selectedId))
      selectMatter(null)
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
      <header className="flex items-center justify-between gap-3 border-b border-ink-border bg-ink-1/65 px-4 py-3">
        <div>
          <h1 className="text-title font-semibold text-ink-fg">{t('matters.title')}</h1>
          <p className="text-meta text-ink-fg-2">{t('matters.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl<MatterDensity>
            value={density}
            onChange={setDensity}
            options={[
              { value: 'compact', label: t('matters.density.compact') },
              { value: 'comfortable', label: t('matters.density.comfortable') }
            ]}
            ariaLabel={t('matters.density.label')}
          />
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] bg-coral/100 px-3 py-2 text-body font-medium text-accent-fg"
          >
            <Plus size={15} />
            {t('matters.create.submit')}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 max-[900px]:flex-col">
        <aside className="w-44 shrink-0 border-r border-ink-border bg-ink-1/45 p-2 max-[900px]:w-full max-[900px]:overflow-x-auto max-[900px]:border-b max-[900px]:border-r-0">
          <nav className="space-y-1 max-[900px]:flex max-[900px]:min-w-max max-[900px]:space-x-1 max-[900px]:space-y-0">
            {MATTER_VIEWS.map((value) => {
              const count = value === 'focus' ? 0 : filterView(allMatters, value, attentionIndex, updateIndex).length
              const critical = value === 'attention' && attentionItems.some((signal) => signal.state === 'open' && signal.severity === 'critical')
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
                  (value === 'active' || value === 'all') && 'mt-2 border-t border-ink-border pt-3',
                  view === value
                    ? 'row-selected acc-select font-medium text-ink-fg'
                    : critical ? 'text-fail hover:bg-fail/10' : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
                )}
              >
                {VIEW_ICONS[value]}
                <span className="min-w-0 flex-1">{t(`matters.views.${value}`)}</span>
                {count > 0 ? <span className={cn('font-mono text-meta tabular-nums', critical && 'text-fail')}>{count}</span> : null}
              </button>
            )})}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
          {view === 'focus' ? (
            <MatterFocus matters={allMatters} signals={attentionItems} updates={updateIndex} onSelect={(matter) => { setView('all'); selectMatter(matter.public_id) }} onReview={(matter, updateId) => { setView('review'); selectMatter(matter.public_id); setReviewTarget({ matterId: matter.public_id, updateId }) }} onSignal={handleAttentionAction} onView={(next) => setView(next)} />
          ) : (
            <div className="grid h-full min-h-0 grid-cols-[minmax(280px,0.9fr)_minmax(420px,1.45fr)] max-[1180px]:grid-cols-1">
              <div className={cn('min-h-0', selected && 'max-[1180px]:hidden')}>
                <MatterList
                  matters={visible}
                  view={view}
                  selectedId={selectedId}
                  density={density}
                  attention={attentionIndex}
                  search={search}
                  onSearchChange={setSearch}
                  onSelect={(matter: Matter) => selectMatter(matter.public_id)}
                  onCreate={() => setCreateOpen(true)}
                />
              </div>
              <div className={cn('min-h-0', !selected && 'max-[1180px]:hidden')}>
                {selected ? (
                  <MatterDetail
                    matterId={selected.public_id}
                    onBack={() => selectMatter(null)}
                    onRemoved={() => selectMatter(null)}
                    chatOpen={chatOpen}
                    onToggleChat={() => setChatOpen((open) => !open)}
                    onCloseChat={() => setChatOpen(false)}
                    attentionSignals={openAttentionFor(selected, attentionIndex)}
                    onAttentionAction={handleAttentionAction}
                    initialReviewId={reviewTarget?.matterId === selected.public_id ? reviewTarget.updateId : null}
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
      />
    </div>
  )
}
