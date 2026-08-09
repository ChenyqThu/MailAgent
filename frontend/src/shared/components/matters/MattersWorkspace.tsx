import { useEffect, useMemo, useState } from 'react'
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
  ShieldAlert,
  Trash2
} from 'lucide-react'

import type { Matter, MatterCreateInput } from '@shared/api/types/matter'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { filterView, MATTER_VIEWS } from '@shared/lib/matterDerive'
import type { MatterView } from '@shared/lib/matterDerive'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'

import { MatterCreateDialog } from './MatterCreateDialog'
import { MatterDetail } from './MatterDetail'
import { MatterFocus } from './MatterFocus'
import { MatterList } from './MatterList'
import type { MatterDensity } from './MatterList'
import { useMattersApi, useMattersEnabled } from './hooks'

const VIEW_ICONS: Record<MatterView, React.ReactNode> = {
  focus: <Focus size={14} />,
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
  const enabled = useMattersEnabled()
  const queryClient = useQueryClient()
  const [view, setView] = useState<MatterView>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [density, setDensity] = useState<MatterDensity>('compact')
  const [createOpen, setCreateOpen] = useState(false)

  const list = useQuery({
    queryKey: qk.matters.list(),
    queryFn: () => api.list({ limit: 100 }),
    enabled,
    staleTime: 30_000
  })
  const allMatters = list.data?.items ?? []
  const visible = useMemo(() => filterView(allMatters, view), [allMatters, view])

  useEffect(() => {
    if (selectedId && !visible.some((matter) => matter.public_id === selectedId)) setSelectedId(null)
  }, [selectedId, visible])

  const create = useMutation({
    mutationFn: (input: MatterCreateInput) => api.create(input),
    onSuccess: async (result) => {
      setCreateOpen(false)
      await queryClient.invalidateQueries({ queryKey: qk.matters.list() })
      setSelectedId(result.matter?.public_id ?? null)
      setView('all')
    },
    onError: (error) => toastError(t('matters.toast.createFailed'), errorMessage(error))
  })

  if (!enabled) return null

  const selected = selectedId ? allMatters.find((matter) => matter.public_id === selectedId) ?? null : null

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
          <button type="button" onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] bg-coral/100 px-3 py-2 text-body font-medium text-accent-fg">
            <Plus size={15} />{t('matters.create.submit')}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 max-[900px]:flex-col">
        <aside className="w-44 shrink-0 border-r border-ink-border bg-ink-1/45 p-2 max-[900px]:w-full max-[900px]:overflow-x-auto max-[900px]:border-b max-[900px]:border-r-0">
          <nav className="space-y-1 max-[900px]:flex max-[900px]:min-w-max max-[900px]:space-x-1 max-[900px]:space-y-0">
            {MATTER_VIEWS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setView(value)
                  setSelectedId(null)
                }}
                className={cn(
                  'relative flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left text-body max-[900px]:w-auto',
                  view === value ? 'row-selected acc-select font-medium text-ink-fg' : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
                )}
              >
                {VIEW_ICONS[value]}
                {t(`matters.views.${value}`)}
              </button>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
          {view === 'focus' ? (
            <MatterFocus matters={visible} onSelect={(matter) => setSelectedId(matter.public_id)} />
          ) : (
            <div className="grid h-full min-h-0 grid-cols-[minmax(280px,0.9fr)_minmax(420px,1.45fr)] max-[1180px]:grid-cols-1">
              <div className={cn('min-h-0', selected && 'max-[1180px]:hidden')}>
                <MatterList
                  matters={visible}
                  view={view}
                  selectedId={selectedId}
                  density={density}
                  search={search}
                  onSearchChange={setSearch}
                  onSelect={(matter: Matter) => setSelectedId(matter.public_id)}
                  onCreate={() => setCreateOpen(true)}
                />
              </div>
              <div className={cn('min-h-0', !selected && 'max-[1180px]:hidden')}>
                {selected ? (
                  <MatterDetail matterId={selected.public_id} onBack={() => setSelectedId(null)} onRemoved={() => setSelectedId(null)} />
                ) : (
                  <div className="grid h-full place-items-center p-8 text-center text-body text-ink-fg-2">
                    <div><Ban size={28} className="mx-auto mb-3 opacity-60" />{t('matters.detail.empty')}</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <MatterCreateDialog open={createOpen} busy={create.isPending} onClose={() => setCreateOpen(false)} onCreate={(input) => create.mutate(input)} />
    </div>
  )
}
