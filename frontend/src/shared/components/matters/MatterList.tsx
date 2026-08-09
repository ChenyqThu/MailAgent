import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Search, Trash2 } from 'lucide-react'

import type { Matter } from '@shared/api/types/matter'
import { compareMatterRank, nextAction, trashDaysRemaining } from '@shared/lib/matterDerive'
import type { MatterView } from '@shared/lib/matterDerive'
import { cn } from '@shared/lib/cn'

export type MatterDensity = 'compact' | 'comfortable'

interface MatterListProps {
  matters: readonly Matter[]
  view: MatterView
  selectedId: string | null
  density: MatterDensity
  search: string
  onSearchChange(value: string): void
  onSelect(matter: Matter): void
  onCreate(): void
}

export function MatterList({
  matters,
  view,
  selectedId,
  density,
  search,
  onSearchChange,
  onSelect,
  onCreate
}: MatterListProps): React.ReactElement {
  const { t } = useTranslation()
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return matters
      .filter((matter) => {
        if (!query) return true
        return [matter.title, matter.public_id, matter.description, matter.current_summary ?? '']
          .join('\n')
          .toLocaleLowerCase()
          .includes(query)
      })
      .sort(compareMatterRank)
  }, [matters, search])

  return (
    <section className="flex h-full min-w-0 flex-col border-r border-ink-border bg-ink-1/55">
      <div className="border-b border-ink-border p-3">
        <label className="flex items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-2">
          <Search size={14} className="text-ink-fg-2" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t('matters.list.search')}
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-ink-fg-2"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {visible.map((matter) => (
          <MatterRow
            key={matter.public_id}
            matter={matter}
            selected={selectedId === matter.public_id}
            density={density}
            onSelect={() => onSelect(matter)}
          />
        ))}
        {visible.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-body text-ink-fg-2">
              {view === 'trash'
                ? t('matters.empty.trash')
                : view === 'archived'
                  ? t('matters.empty.archived')
                  : t('matters.empty.default')}
            </p>
            {view !== 'trash' && view !== 'archived' ? (
              <button type="button" onClick={onCreate} className="mt-4 rounded-[var(--r-ctl)] bg-coral/100 px-3 py-2 text-body font-medium text-accent-fg">
                {t('matters.create.submit')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

interface MatterRowProps {
  matter: Matter
  selected: boolean
  density: MatterDensity
  onSelect(): void
}

function MatterRow({ matter, selected, density, onSelect }: MatterRowProps): React.ReactElement {
  const { t } = useTranslation()
  const days = trashDaysRemaining(matter)
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative w-full border-b border-ink-border px-4 text-left transition-colors duration-fast',
        density === 'comfortable' ? 'py-3.5' : 'py-2.5',
        // Theme v3 mapping: prototype tone colors map to repository semantic tokens;
        // selection keeps the canonical wash + left-bar signature instead of inline colors.
        selected ? 'row-selected acc-select' : 'hover:bg-ink-3'
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-1.5 h-2 w-2 shrink-0 rounded-full',
            matter.health === 'off_track'
              ? 'bg-fail'
              : matter.health === 'at_risk'
                ? 'bg-warn'
                : matter.health === 'on_track'
                  ? 'bg-ok'
                  : 'bg-ink-fg-2'
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-body font-medium text-ink-fg">{matter.title}</span>
            <span className="shrink-0 text-meta font-mono uppercase text-ink-fg-2">{matter.priority}</span>
          </span>
          <span className="mt-1 block truncate text-aux text-ink-fg-1">{nextAction(matter)}</span>
          {density === 'comfortable' && matter.tags.length > 0 ? (
            <span className="mt-2 flex flex-wrap gap-1">
              {matter.tags.map((tag) => (
                <span key={tag} className="rounded-[var(--r-pill)] bg-ink-3 px-1.5 py-0.5 text-meta text-ink-fg-2">
                  #{tag}
                </span>
              ))}
            </span>
          ) : null}
          <span className="mt-1.5 flex items-center gap-2 text-meta text-ink-fg-2">
            <span className="font-mono">{matter.public_id}</span>
            {matter.archived_at !== null && matter.deleted_at === null ? (
              <span className="inline-flex items-center gap-1"><Archive size={11} />{t('matters.list.archived')}</span>
            ) : null}
            {matter.deleted_at !== null ? (
              <span className="inline-flex items-center gap-1 text-fail"><Trash2 size={11} />{t('matters.list.trashDays', { count: days ?? 0 })}</span>
            ) : null}
          </span>
        </span>
      </div>
    </button>
  )
}
