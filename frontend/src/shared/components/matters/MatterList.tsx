import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Search, Trash2 } from 'lucide-react'

import type { Matter } from '@shared/api/types/matter'
import type { MatterTagDefinition } from '@shared/api/types/matter'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { nextAction, trashDaysRemaining } from '@shared/lib/matterDerive'
import { openAttentionFor } from '@shared/lib/matterDerive'
import type { MatterAttentionIndex, MatterView } from '@shared/lib/matterDerive'
import { cn } from '@shared/lib/cn'

import { MatterTagChip } from './MatterTagMarker'
import { getOrderedVisibleMatters } from './matterListOrder'
import { matterTagMap, resolveMatterTag } from './matterTags'

interface MatterListProps {
  matters: readonly Matter[]
  view: MatterView
  selectedId: string | null
  attention?: MatterAttentionIndex
  search: string
  tagDefinitions?: readonly MatterTagDefinition[]
  onSearchChange(value: string): void
  onSelect(matter: Matter): void
  onCreate(): void
}

export function MatterList({
  matters,
  view,
  selectedId,
  attention,
  search,
  tagDefinitions = [],
  onSearchChange,
  onSelect,
  onCreate
}: MatterListProps): React.ReactElement {
  const { t } = useTranslation()
  const visible = useMemo(
    () => getOrderedVisibleMatters(matters, search, attention),
    [attention, matters, search]
  )
  const tagsByName = useMemo(() => matterTagMap(tagDefinitions), [tagDefinitions])

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
            signals={openAttentionFor(matter, attention)}
            tagsByName={tagsByName}
            onSelect={() => onSelect(matter)}
          />
        ))}
        {visible.length === 0 ? (
          <EmptyState
            title={view === 'trash'
              ? t('matters.empty.trash')
              : view === 'archived'
                ? t('matters.empty.archived')
                : t('matters.empty.default')}
            className="px-5 py-12"
            action={view !== 'trash' && view !== 'archived' ? (
              <button
                type="button"
                onClick={onCreate}
                className="rounded-[var(--r-ctl)] bg-coral/100 px-3 py-2 text-body font-medium text-accent-fg"
              >
                {t('matters.create.submit')}
              </button>
            ) : null}
          />
        ) : null}
      </div>
    </section>
  )
}

interface MatterRowProps {
  matter: Matter
  selected: boolean
  signals: ReturnType<typeof openAttentionFor>
  tagsByName: ReadonlyMap<string, MatterTagDefinition>
  onSelect(): void
}

function MatterRow({
  matter,
  selected,
  signals,
  tagsByName,
  onSelect
}: MatterRowProps): React.ReactElement {
  const { t } = useTranslation()
  const days = trashDaysRemaining(matter)
  const critical = signals.some((signal) => signal.severity === 'critical')
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative w-full border-b border-ink-border px-4 py-2.5 text-left transition-colors duration-fast',
        // Theme v3 mapping: prototype tone colors map to repository semantic tokens;
        // selection keeps the canonical wash + left-bar signature instead of inline colors.
        selected ? 'row-selected acc-select' : 'hover:bg-ink-3',
        !selected && critical && 'border-l-[3px] border-l-fail'
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
            <span className="shrink-0 text-meta font-mono uppercase text-ink-fg-2">
              {matter.priority}
            </span>
          </span>
          <span className="mt-1 block truncate text-aux text-ink-fg-1">{nextAction(matter)}</span>
          {matter.tags.length > 0 ? (
            <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
              {matter.tags.slice(0, 3).map((tag) => (
                <MatterTagChip
                  key={tag}
                  tag={resolveMatterTag(tagsByName, tag)}
                  className="max-w-[8.5rem] py-0.5"
                />
              ))}
              {matter.tags.length > 3 ? (
                <span className="rounded-[var(--r-pill)] border border-ink-border-soft bg-ink-2/65 px-2 py-0.5 font-mono text-meta text-ink-fg-2">
                  +{matter.tags.length - 3}
                </span>
              ) : null}
            </span>
          ) : null}
          <span className="mt-1.5 flex items-center gap-2 text-meta text-ink-fg-2">
            <span className="font-mono">{matter.public_id}</span>
            {matter.archived_at !== null && matter.deleted_at === null ? (
              <span className="inline-flex items-center gap-1">
                <Archive size={11} />
                {t('matters.list.archived')}
              </span>
            ) : null}
            {matter.deleted_at !== null ? (
              <span className="inline-flex items-center gap-1 text-fail">
                <Trash2 size={11} />
                {t('matters.list.trashDays', { count: days ?? 0 })}
              </span>
            ) : null}
          </span>
        </span>
      </div>
    </button>
  )
}
