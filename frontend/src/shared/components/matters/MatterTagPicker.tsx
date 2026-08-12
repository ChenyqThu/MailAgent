import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Plus, Search, Settings2, Tag } from 'lucide-react'

import type { MatterTagDefinition } from '@shared/api/types/matter'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'
import { cn } from '@shared/lib/cn'

import { MatterTagMarker } from './MatterTagMarker'
import { mergeMatterTagDefinitions, normalizeMatterTagInput } from './matterTags'

interface MatterTagPickerProps {
  selectedTags: readonly string[]
  tagDefinitions: readonly MatterTagDefinition[]
  disabled?: boolean
  onChange(tags: string[]): void
  onManage(): void
}

export function MatterTagPicker({
  selectedTags,
  tagDefinitions,
  disabled = false,
  onChange,
  onManage
}: MatterTagPickerProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const normalizedSearch = normalizeMatterTagInput(search)
  const selectedSet = useMemo(() => new Set(selectedTags), [selectedTags])
  const availableTags = useMemo(
    () => mergeMatterTagDefinitions(tagDefinitions, selectedTags),
    [selectedTags, tagDefinitions]
  )
  const filteredTags = useMemo(() => {
    const query = normalizedSearch.toLocaleLowerCase()
    if (!query) return availableTags
    return availableTags.filter((tag) => tag.name.toLocaleLowerCase().includes(query))
  }, [availableTags, normalizedSearch])
  const exactMatch = normalizedSearch
    ? availableTags.some((tag) => tag.name === normalizedSearch)
    : true
  const canCreate = normalizedSearch.length > 0 && !exactMatch

  const setTagSelected = (tagName: string, selected: boolean): void => {
    if (selected) {
      if (selectedSet.has(tagName)) return
      onChange([...selectedTags, tagName])
    } else {
      onChange(selectedTags.filter((tag) => tag !== tagName))
    }
  }

  const createTag = (): void => {
    if (!canCreate) return
    onChange([...selectedTags, normalizedSearch])
    setSearch('')
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('matters.tags.pickerLabel')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[var(--r-pill)] border border-dashed',
            'border-ink-border px-2 py-1 text-meta text-ink-fg-2',
            'transition-[color,background-color,border-color,transform] duration-fast ease-standard',
            'hover:border-coral/40 hover:bg-ink-2 hover:text-ink-fg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
            'active:scale-[0.98] disabled:opacity-50'
          )}
        >
          <Tag size={12} />
          {t('matters.detail.addTag')}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="border-b border-ink-border-soft p-2">
          <label className="flex items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-2">
            <Search size={13} className="text-ink-fg-2" />
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canCreate) {
                  event.preventDefault()
                  createTag()
                }
              }}
              placeholder={t('matters.tags.search')}
              className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-ink-fg-3"
            />
          </label>
        </div>
        <div className="max-h-64 overflow-y-auto p-1 scrollbar-thin">
          {filteredTags.map((tag) => {
            const selected = selectedSet.has(tag.name)
            return (
              <button
                key={tag.name}
                type="button"
                disabled={disabled}
                onClick={() => setTagSelected(tag.name, !selected)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left',
                  'text-body transition-colors duration-fast ease-standard hover:bg-ink-3',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
                  selected && 'bg-coral/10'
                )}
              >
                <MatterTagMarker color={tag.color} shape={tag.shape} />
                <span className="min-w-0 flex-1 truncate text-ink-fg">{tag.name}</span>
                <span className="font-mono text-meta text-ink-fg-2">
                  {t('matters.tags.usageCount', { count: tag.usage_count })}
                </span>
                {selected ? <Check size={14} className="text-coral" /> : null}
              </button>
            )
          })}
          {filteredTags.length === 0 && !canCreate ? (
            <EmptyState title={t('matters.tags.empty')} className="px-3 py-5" />
          ) : null}
          {canCreate ? (
            <button
              type="button"
              disabled={disabled}
              onClick={createTag}
              className="flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left text-body text-coral transition-colors duration-fast ease-standard hover:bg-coral/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
            >
              <Plus size={14} />
              {t('matters.tags.create', { name: normalizedSearch })}
            </button>
          ) : null}
        </div>
        <div className="border-t border-ink-border-soft p-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onManage()
            }}
            className="flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left text-aux text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
          >
            <Settings2 size={14} />
            {t('matters.tags.manage')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
