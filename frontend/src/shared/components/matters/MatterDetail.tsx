import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Tag,
  Trash2
} from 'lucide-react'

import {
  MATTER_HEALTH_VALUES,
  MATTER_ITEM_KINDS,
  MATTER_STATUSES
} from '@shared/api/types/matter'
import type {
  Matter,
  MatterActorKind,
  MatterEvent,
  MatterHealth,
  MatterItem,
  MatterItemCreateInput,
  MatterItemKind,
  MatterStatus
} from '@shared/api/types/matter'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { AddItemModal } from './AddItemModal'
import { useMattersApi } from './hooks'

interface MatterDetailProps {
  matterId: string
  onBack(): void
  onRemoved(): void
}

type DetailTab = 'state' | 'timeline'
type TimelineFilter = 'all' | MatterActorKind

export function MatterDetail({ matterId, onBack, onRemoved }: MatterDetailProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<DetailTab>('state')
  const [addKind, setAddKind] = useState<MatterItemKind>('action')
  const [addOpen, setAddOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)

  const detail = useQuery({
    queryKey: qk.matters.detail(matterId),
    queryFn: () => api.get(matterId, ['items', 'timeline']),
    staleTime: 15_000
  })
  const matter = detail.data?.matter
  const items = detail.data?.items ?? []
  const timeline = detail.data?.timeline ?? []

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.matters.list() }),
      queryClient.invalidateQueries({ queryKey: qk.matters.detail(matterId) })
    ])
  }

  const patch = useMutation({
    mutationFn: (input: Parameters<typeof api.patch>[1]) => {
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

  if (detail.isLoading || !matter) {
    return <div className="grid h-full place-items-center text-body text-ink-fg-2">{t('common.loading')}</div>
  }

  const addTag = (): void => {
    const tag = tagDraft.trim().replace(/^#/, '')
    if (!tag || matter.tags.includes(tag)) return
    patch.mutate({ tags: [...matter.tags, tag] })
    setTagDraft('')
  }

  return (
    <article className="flex h-full min-w-0 flex-col bg-ink-0/35">
      <header className="border-b border-ink-border px-5 py-4">
        <div className="flex items-start gap-3">
          <button type="button" onClick={onBack} className="mt-0.5 hidden rounded-[var(--r-ctl)] p-1.5 hover:bg-ink-3 max-[1180px]:block">
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-meta text-ink-fg-2">
              <span className="font-mono">{matter.public_id}</span>
              {matter.matter_type ? <span>{matter.matter_type}</span> : null}
              <span>{t('matters.detail.created', { date: new Date(matter.created_at).toLocaleDateString() })}</span>
            </div>
            <h1 className="mt-1 text-heading font-semibold text-ink-fg">{matter.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <StatusMenu
                value={matter.status}
                onChange={(status) => patch.mutate({ status })}
              />
              <select
                value={matter.health}
                onChange={(event) => patch.mutate({ health: event.target.value as MatterHealth })}
                className="rounded-[var(--r-pill)] border border-ink-border bg-ink-2 px-2 py-1 text-meta"
              >
                {MATTER_HEALTH_VALUES.map((value) => (
                  <option key={value} value={value}>{t(`matters.health.${value}`)}</option>
                ))}
              </select>
              <span className="rounded-[var(--r-pill)] bg-ink-3 px-2 py-1 text-meta font-mono uppercase">{matter.priority}</span>
              <span className="text-meta text-ink-fg-2">
                {matter.due_at ? t('matters.detail.due', { date: new Date(matter.due_at).toLocaleDateString() }) : t('matters.detail.noDue')}
              </span>
              <span className="inline-flex items-center gap-1 rounded-[var(--r-pill)] border border-dashed border-ink-border px-2 py-1 text-meta text-ink-fg-2">
                <Bot size={12} />{t('matters.detail.agentUnbound')}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {matter.tags.map((tag) => (
                <button key={tag} type="button" onClick={() => patch.mutate({ tags: matter.tags.filter((value) => value !== tag) })} className="rounded-[var(--r-pill)] bg-ink-3 px-2 py-1 text-meta text-ink-fg-1 hover:text-fail">
                  #{tag}
                </button>
              ))}
              <label className="inline-flex items-center gap-1 rounded-[var(--r-pill)] border border-dashed border-ink-border px-2 py-1">
                <Tag size={12} className="text-ink-fg-2" />
                <input
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addTag()
                    }
                  }}
                  placeholder={t('matters.detail.addTag')}
                  className="w-24 bg-transparent text-meta outline-none"
                />
              </label>
            </div>
          </div>
          <div className="relative">
            <button type="button" onClick={() => setMoreOpen((value) => !value)} className="rounded-[var(--r-ctl)] p-2 hover:bg-ink-3">
              <MoreHorizontal size={17} />
            </button>
            {moreOpen ? (
              <div className="absolute right-0 top-10 z-20 w-48 rounded-[var(--r-card)] border border-ink-border bg-ink-1 p-1 shadow-md">
                {matter.archived_at === null && matter.deleted_at === null ? (
                  <MenuButton icon={<Archive size={14} />} label={t('matters.actions.archive')} onClick={() => transition.mutate('archive')} />
                ) : null}
                {matter.archived_at !== null && matter.deleted_at === null ? (
                  <MenuButton icon={<RotateCcw size={14} />} label={t('matters.actions.restoreArchive')} onClick={() => transition.mutate('reopen')} />
                ) : null}
                {matter.deleted_at === null ? (
                  <MenuButton icon={<Trash2 size={14} />} label={t('matters.actions.trash')} danger onClick={() => transition.mutate('trash')} />
                ) : (
                  <>
                    <MenuButton icon={<RotateCcw size={14} />} label={t('matters.actions.restore')} onClick={() => transition.mutate('restore')} />
                    <MenuButton icon={<Trash2 size={14} />} label={t('matters.actions.permanentDelete')} danger onClick={() => setDeleteOpen(true)} />
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="border-b border-ink-border px-5 pt-2">
        <div className="flex gap-5">
          {(['state', 'timeline'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn('border-b-2 px-1 py-2 text-body', tab === value ? 'border-coral text-ink-fg' : 'border-transparent text-ink-fg-2')}
            >
              {t(`matters.tabs.${value}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin">
        {tab === 'state' ? (
          <div className="space-y-5">
            <StateCard matter={matter} />
            <ItemGroups
              items={items}
              onToggle={(item) => updateItem.mutate({ item, status: item.status === 'done' ? 'open' : 'done' })}
              onAdd={(kind) => {
                setAddKind(kind)
                setAddOpen(true)
              }}
            />
          </div>
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

      {deleteOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" className="w-full max-w-md rounded-[var(--r-card)] border border-fail/30 bg-ink-1 p-5 shadow-md">
            <h2 className="text-title font-semibold text-fail">{t('matters.delete.title')}</h2>
            <p className="mt-2 text-body text-ink-fg-1">{t('matters.delete.hint', { id: matter.public_id })}</p>
            <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} className="mt-4 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 font-mono text-body" />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteOpen(false)} className="rounded-[var(--r-ctl)] px-3 py-2 text-body hover:bg-ink-3">{t('common.cancel')}</button>
              <button type="button" disabled={deleteConfirmation !== matter.public_id || permanentDelete.isPending} onClick={() => permanentDelete.mutate()} className="rounded-[var(--r-ctl)] bg-fail px-3 py-2 text-body font-medium text-accent-fg disabled:opacity-50">{t('matters.actions.permanentDelete')}</button>
            </div>
          </section>
        </div>
      ) : null}
    </article>
  )
}

function StatusMenu({ value, onChange }: { value: MatterStatus; onChange(value: MatterStatus): void }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <label className="relative inline-flex items-center">
      <select value={value} onChange={(event) => onChange(event.target.value as MatterStatus)} className="appearance-none rounded-[var(--r-pill)] border border-coral/30 bg-coral/10 py-1 pl-2 pr-7 text-meta text-coral">
        {MATTER_STATUSES.map((status) => <option key={status} value={status}>{t(`matters.status.${status}`)}</option>)}
      </select>
      <ChevronDown size={12} className="pointer-events-none absolute right-2" />
    </label>
  )
}

function StateCard({ matter }: { matter: Matter }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-1/75 p-4">
      <h2 className="text-title font-semibold">{t('matters.state.title')}</h2>
      <p className="mt-3 whitespace-pre-wrap text-body text-ink-fg-1">{matter.current_summary || t('matters.state.noSummary')}</p>
      <p className="mt-3 border-t border-ink-border pt-3 text-meta text-ink-fg-2">{t('matters.state.summaryGuard')}</p>
      <div className="mt-4 rounded-[var(--r-ctl)] border border-dashed border-ink-border p-3">
        <div className="text-meta font-medium text-ink-fg-2">{t('matters.state.descriptionLabel')}</div>
        <p className="mt-2 whitespace-pre-wrap text-body text-ink-fg-1">{matter.description || t('matters.state.noDescription')}</p>
      </div>
    </section>
  )
}

function ItemGroups({ items, onToggle, onAdd }: { items: readonly MatterItem[]; onToggle(item: MatterItem): void; onAdd(kind: MatterItemKind): void }): React.ReactElement {
  const { t } = useTranslation()
  const activeItems = items.filter((item) => item.deleted_at === null)
  const groups = MATTER_ITEM_KINDS.map((kind) => ({ kind, items: activeItems.filter((item) => item.kind === kind) })).filter((group) => group.items.length > 0)
  if (groups.length === 0) {
    const starterKinds: MatterItemKind[] = ['action', 'milestone', 'decision', 'blocker', 'question']
    return (
      <section className="rounded-[var(--r-card)] border border-dashed border-ink-border p-6 text-center">
        <p className="text-body text-ink-fg-2">{t('matters.item.empty')}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {starterKinds.map((kind) => <button key={kind} type="button" onClick={() => onAdd(kind)} className="rounded-[var(--r-ctl)] border border-ink-border px-3 py-2 text-body hover:bg-ink-3"><Plus size={13} className="mr-1 inline" />{t(`matters.item.kinds.${kind}`)}</button>)}
        </div>
      </section>
    )
  }
  return (
    <section className="space-y-4">
      {groups.map((group) => <ItemGroup key={group.kind} kind={group.kind} items={group.items} onToggle={onToggle} onAdd={onAdd} />)}
    </section>
  )
}

function ItemGroup({ kind, items, onToggle, onAdd }: { kind: MatterItemKind; items: readonly MatterItem[]; onToggle(item: MatterItem): void; onAdd(kind: MatterItemKind): void }): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  return (
    <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-1/65">
      <div className="flex items-center justify-between border-b border-ink-border px-4 py-3">
        <h3 className="text-body font-medium">{t(`matters.item.kinds.${kind}`)} <span className="text-ink-fg-2">{items.length}</span></h3>
        <button type="button" onClick={() => onAdd(kind)} className="rounded-[var(--r-ctl)] p-1.5 hover:bg-ink-3"><Plus size={14} /></button>
      </div>
      <div className="divide-y divide-ink-border">
        {items.map((item) => {
          const isExpanded = expanded.has(item.id)
          return (
            <div key={item.id} className="px-4 py-3">
              <div className="flex items-start gap-2.5">
                {item.kind === 'action' ? (
                  <button type="button" onClick={() => onToggle(item)} className={cn('mt-0.5 grid h-4 w-4 place-items-center rounded border', item.status === 'done' ? 'border-ok bg-ok text-accent-fg' : 'border-ink-border')}>
                    {item.status === 'done' ? <Check size={11} /> : null}
                  </button>
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className={cn('text-body', item.status === 'done' && 'text-ink-fg-2 line-through')}>{item.title}</div>
                  {item.description ? <p className="mt-1 text-aux text-ink-fg-2">{item.description}</p> : null}
                  {item.checklist.length > 0 ? (
                    <button type="button" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })} className="mt-2 inline-flex items-center gap-1 text-meta text-ink-fg-2 hover:text-ink-fg">
                      {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{t('matters.item.checklist', { count: item.checklist.length })}
                    </button>
                  ) : null}
                  {isExpanded ? <ul className="mt-2 space-y-1 pl-4 text-aux text-ink-fg-1">{item.checklist.map((entry) => <li key={entry.id} className={entry.done ? 'line-through text-ink-fg-2' : ''}>{entry.done ? '✓' : '○'} {entry.text}</li>)}</ul> : null}
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
  const options = useMemo(() => [
    { value: 'all' as const, label: t('matters.timeline.all') },
    { value: 'user' as const, label: t('matters.timeline.me') },
    { value: 'agent' as const, label: t('matters.timeline.agent') },
    { value: 'system' as const, label: t('matters.timeline.system') }
  ], [t])
  const visible = filter === 'all' ? events : events.filter((event) => event.actor_kind === filter)
  return (
    <section>
      <SegmentedControl<TimelineFilter> value={filter} onChange={setFilter} options={options} ariaLabel={t('matters.timeline.filter')} />
      <div className="mt-4 space-y-3">
        {visible.map((event) => <div key={event.id} className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-1/65 px-4 py-3"><div className="flex items-center justify-between gap-3"><span className="text-body font-medium">{t(`matters.events.${event.kind}`, { defaultValue: event.kind })}</span><time className="text-meta text-ink-fg-2">{new Date(event.happened_at).toLocaleString()}</time></div><p className="mt-1 text-meta text-ink-fg-2">{event.actor_kind} · {event.source}</p></div>)}
        {visible.length === 0 ? <div className="rounded-[var(--r-card)] border border-dashed border-ink-border p-8 text-center text-body text-ink-fg-2">{t('matters.timeline.empty')}</div> : null}
      </div>
    </section>
  )
}

function MenuButton({ icon, label, danger = false, onClick }: { icon: React.ReactNode; label: string; danger?: boolean; onClick(): void }): React.ReactElement {
  return <button type="button" onClick={onClick} className={cn('flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left text-body hover:bg-ink-3', danger && 'text-fail')}>{icon}{label}</button>
}
