import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, Plus, Search, Settings2 } from 'lucide-react'

import {
  MATTER_TAG_COLORS,
  MATTER_TAG_DEFAULT_COLOR,
  MATTER_TAG_DEFAULT_SHAPE,
  MATTER_TAG_SHAPES
} from '@shared/api/types/matter'
import type { MatterTagColor, MatterTagDefinition, MatterTagShape } from '@shared/api/types/matter'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'
import { cn } from '@shared/lib/cn'

import { MatterTagMarker } from './MatterTagMarker'
import { mergeMatterTagDefinitions, normalizeMatterTagInput } from './matterTags'

interface MatterTagPickerProps {
  selectedTags: readonly string[]
  tagDefinitions: readonly MatterTagDefinition[]
  disabled?: boolean
  onChange(tags: string[]): void
  /** 新建标签（轮 3 #2）：设计的创建流带 StylePicker，样式与名字一起交出去 ——
   *  调用方负责「加进 matter.tags + 非默认样式时 upsert 定义行」。 */
  onCreate(name: string, color: MatterTagColor, shape: MatterTagShape): void
  onManage(): void
}

/**
 * 标签下拉（轮 3 #2 —— 照设计 matter-agent.jsx:97-198 `TagPicker` 逐属性落）。
 *
 * 触发器 = `+ 标签` 虚线小 chip（设计 :129-135：plus 9px + 「标签」，11px 字，打开态
 * 转 accent）；面板 = 256px：内嵌深一档底（`--ink-3`）的搜索盒 → 标签行
 * （标记 · 名字 · **紧跟名字的 accent 勾（选中态）** · spacer · mono 计数）→
 * 命中不了时的「创建标签」区（含收合式 StylePicker：形状 5 档 × 颜色 6 档）→
 * 「管理全部标签…」页脚。行**没有**选中底色 —— 设计里选中只由勾表达。
 */
export function MatterTagPicker({
  selectedTags,
  tagDefinitions,
  disabled = false,
  onChange,
  onCreate,
  onManage
}: MatterTagPickerProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [color, setColor] = useState<MatterTagColor>(MATTER_TAG_DEFAULT_COLOR)
  const [shape, setShape] = useState<MatterTagShape>(MATTER_TAG_DEFAULT_SHAPE)
  const [styleOpen, setStyleOpen] = useState(false)
  // 每次打开重置搜索与样式草稿（设计 :117 打开即清 q；样式回默认档）。
  useEffect(() => {
    if (!open) return
    setSearch('')
    setColor(MATTER_TAG_DEFAULT_COLOR)
    setShape(MATTER_TAG_DEFAULT_SHAPE)
    setStyleOpen(false)
  }, [open])
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
    onCreate(normalizedSearch, color, shape)
    setSearch('')
    setStyleOpen(false)
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
            'inline-flex items-center gap-[3px] rounded-[var(--r-ctl)] border border-dashed px-[7px] py-1 text-micro leading-none',
            'transition-[color,border-color] duration-fast ease-standard',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50',
            open
              ? 'border-coral/50 text-coral'
              : 'border-ink-border text-ink-fg-3 hover:border-coral/40 hover:text-ink-fg-1'
          )}
        >
          <Plus size={9} strokeWidth={2.5} />
          {t('matters.tags.pickerLabel')}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 rounded-[var(--r-pop)] p-1.5" align="start">
        <label
          className={cn(
            'mb-1 flex items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border bg-ink-3 px-2 py-[5px]'
          )}
        >
          <Search size={11} className="shrink-0 text-ink-fg-3" />
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
            className="min-w-0 flex-1 bg-transparent text-meta text-ink-fg outline-none placeholder:text-ink-fg-3"
          />
        </label>
        <div className="max-h-48 overflow-y-auto scrollbar-thin">
          {filteredTags.map((tag) => {
            const selected = selectedSet.has(tag.name)
            return (
              <button
                key={tag.name}
                type="button"
                disabled={disabled}
                onClick={() => setTagSelected(tag.name, !selected)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-meta text-ink-fg',
                  'transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.05]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70'
                )}
              >
                <MatterTagMarker color={tag.color} shape={tag.shape} />
                {/* 设计 :162-165：勾紧跟名字（选中只由勾表达，无选中底色），计数钉行尾。 */}
                <span className="min-w-0 truncate">{tag.name}</span>
                {selected ? (
                  <Check size={12} strokeWidth={3} className="shrink-0 text-coral" />
                ) : null}
                <span aria-hidden className="flex-1" />
                <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
                  {tag.usage_count}
                </span>
              </button>
            )
          })}
          {filteredTags.length === 0 && !canCreate ? (
            <p className="px-2 py-2.5 text-center text-micro text-ink-fg-3">
              {t('matters.tags.emptyCreateHint')}
            </p>
          ) : null}
        </div>
        {canCreate ? (
          <div className="mt-1 border-t border-ink-border-soft pt-1">
            <button
              type="button"
              disabled={disabled}
              onClick={createTag}
              className={cn(
                'flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-meta text-ink-fg',
                'transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.05]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70'
              )}
            >
              <MatterTagMarker color={color} shape={shape} />
              <span className="min-w-0 truncate">
                {t('matters.tags.create', { name: normalizedSearch })}
              </span>
            </button>
            {/* StylePicker（设计 :58-95）：收起只有一枚预览标记，展开出形状 / 颜色两行。 */}
            <div
              className={cn(
                'rounded-[var(--r-ctl)] border transition-colors duration-fast ease-standard',
                styleOpen ? 'border-ink-border bg-ink-fg/[0.03]' : 'border-transparent'
              )}
            >
              <button
                type="button"
                onClick={() => setStyleOpen((current) => !current)}
                aria-expanded={styleOpen}
                className="flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-micro text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
              >
                <MatterTagMarker color={color} shape={shape} />
                <span className="flex-1">{t('matters.tags.styleToggle')}</span>
                {styleOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              </button>
              {styleOpen ? (
                <div className="flex flex-col gap-1.5 px-2 pb-2">
                  <div className="flex items-center gap-1">
                    <span className="w-7 shrink-0 text-micro text-ink-fg-3">
                      {t('matters.tags.shape')}
                    </span>
                    {MATTER_TAG_SHAPES.map((candidate) => (
                      <button
                        key={candidate}
                        type="button"
                        title={t(`matters.tags.shapes.${candidate}`)}
                        aria-label={t(`matters.tags.shapes.${candidate}`)}
                        aria-pressed={shape === candidate}
                        onClick={() => setShape(candidate)}
                        className={cn(
                          'grid size-[22px] place-items-center rounded-[var(--r-ctl)] border transition-colors duration-fast ease-standard',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
                          shape === candidate
                            ? 'border-ink-border bg-ink-fg/[0.09]'
                            : 'border-transparent hover:bg-ink-fg/[0.05]'
                        )}
                      >
                        <MatterTagMarker color={color} shape={candidate} />
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="w-7 shrink-0 text-micro text-ink-fg-3">
                      {t('matters.tags.color')}
                    </span>
                    {MATTER_TAG_COLORS.map((candidate) => (
                      <button
                        key={candidate}
                        type="button"
                        title={t(`matters.tags.colors.${candidate}`)}
                        aria-label={t(`matters.tags.colors.${candidate}`)}
                        aria-pressed={color === candidate}
                        onClick={() => setColor(candidate)}
                        className={cn(
                          'grid size-[22px] place-items-center rounded-[var(--r-ctl)] border transition-colors duration-fast ease-standard',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
                          color === candidate
                            ? 'border-ink-border bg-ink-fg/[0.09]'
                            : 'border-transparent hover:bg-ink-fg/[0.05]'
                        )}
                      >
                        <span
                          aria-hidden
                          className="size-[11px] rounded-full"
                          style={{ backgroundColor: `rgb(var(${candidate}))` }}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="mt-1 border-t border-ink-border-soft pt-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onManage()
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-meta text-ink-fg-2',
              'transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.05] hover:text-ink-fg',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70'
            )}
          >
            <Settings2 size={11} className="shrink-0" />
            {t('matters.tags.manage')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
