// 通讯录列表列（设计 §2.1）：头部（标题+计数 · 视图分段 · 排序/分组菜单 · 密度
// 切换）→ 搜索 → 「全部」视图筛选 chips → BackfillBar → 虚拟滚动行（react-window
// v2，定高行 + O(1) 行高，§7.1 铁律）→ 多选底部条（无「合并」钮，随 WP3）。

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { List } from 'react-window'
import { ArrowUpDown, Rows2, Rows3, Search, UsersRound, X } from 'lucide-react'

import type { ContactBackfillProgress, ContactSort, ContactView } from '@shared/api/types/contact'
import { cn } from '@shared/lib/cn'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { SegmentedControl } from '@shared/components/ui/segmented'

import { BackfillBar } from './BackfillBar'
import { ContactVirtualRow, type ContactRowActions, type ContactRowsProps } from './ContactRow'
import {
  rowHeightFor,
  type ContactDensity,
  type ContactGroupBy,
  type ContactKindBucket,
  type ContactListRow
} from './contactListModel'

const KIND_BUCKETS: readonly ContactKindBucket[] = ['person', 'robot', 'list', 'hidden']
const SORTS: readonly ContactSort[] = ['density', 'recent', 'name']
const GROUP_BYS: readonly ContactGroupBy[] = ['none', 'company', 'dept', 'fn', 'level']

export interface ContactListPaneProps {
  view: ContactView
  onViewChange(view: ContactView): void
  q: string
  onQChange(q: string): void
  sort: ContactSort
  onSortChange(sort: ContactSort): void
  groupBy: ContactGroupBy
  onGroupByChange(groupBy: ContactGroupBy): void
  density: ContactDensity
  onDensityChange(density: ContactDensity): void
  kindFilter: ReadonlySet<ContactKindBucket>
  onKindFilterToggle(bucket: ContactKindBucket): void
  rows: ContactListRow[]
  /** 当前视图（含搜索）返回的联系人数 —— 头部计数。 */
  total: number
  loading: boolean
  progress: ContactBackfillProgress | undefined
  selectedId: number | null
  selectionMode: boolean
  checkedIds: ReadonlySet<number>
  onExitSelection(): void
  menuOpenId: number | null
  onMenuOpenChange(id: number | null): void
  onToggleGroup(groupKey: string): void
  actions: ContactRowActions
}

export function ContactListPane(props: ContactListPaneProps): React.ReactElement {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)

  const sortGroupItems: PopmenuItem[] = [
    { kind: 'label', id: 'sort-label', label: t('contacts.sort.label') },
    ...SORTS.map(
      (sort): PopmenuItem => ({
        kind: 'radio',
        id: `sort-${sort}`,
        label: t(`contacts.sort.${sort}`),
        checked: props.sort === sort,
        onSelect: () => props.onSortChange(sort)
      })
    ),
    { kind: 'separator', id: 'sep-group' },
    { kind: 'label', id: 'group-label', label: t('contacts.groupBy.label') },
    ...GROUP_BYS.map(
      (groupBy): PopmenuItem => ({
        kind: 'radio',
        id: `group-${groupBy}`,
        label: t(`contacts.groupBy.${groupBy}`),
        checked: props.groupBy === groupBy,
        onSelect: () => props.onGroupByChange(groupBy)
      })
    )
  ]

  const filtersAllOff = props.view === 'all' && props.kindFilter.size === 0
  const searchEmpty = !props.loading && props.rows.length === 0 && props.q.trim() !== ''
  const libraryEmpty =
    !props.loading && props.rows.length === 0 && props.q.trim() === '' && !filtersAllOff

  const rowProps: ContactRowsProps = {
    rows: props.rows,
    density: props.density,
    selectedId: props.selectedId,
    selectionMode: props.selectionMode,
    checkedIds: props.checkedIds,
    menuOpenId: props.menuOpenId,
    onMenuOpenChange: props.onMenuOpenChange,
    onToggleGroup: props.onToggleGroup,
    ...props.actions
  }

  return (
    <section
      aria-label={t('contacts.nav.title')}
      className="flex h-full min-h-0 flex-col border-r border-ink-border"
    >
      {/* 头部 */}
      <div className="shrink-0 px-3 pb-2 pt-3">
        <div className="flex items-center gap-1.5">
          <h1 className="min-w-0 flex-1 truncate text-aux font-semibold text-ink-fg">
            {t('contacts.nav.title')}
            <span className="ml-1.5 font-mono text-micro font-normal tabular-nums text-ink-fg-3">
              {t('contacts.list.count', { count: props.total })}
            </span>
          </h1>
          <button
            type="button"
            aria-label={t('contacts.density.label')}
            title={
              props.density === 'compact'
                ? t('contacts.density.comfortable')
                : t('contacts.density.compact')
            }
            onClick={() =>
              props.onDensityChange(props.density === 'compact' ? 'comfortable' : 'compact')
            }
            className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg"
          >
            {props.density === 'compact' ? <Rows3 size={14} /> : <Rows2 size={14} />}
          </button>
          <div className="relative">
            <button
              ref={menuTriggerRef}
              type="button"
              aria-label={t('contacts.sort.label')}
              onClick={() => setMenuOpen((open) => !open)}
              className={cn(
                'rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg',
                menuOpen && 'bg-ink-3 text-ink-fg'
              )}
            >
              <ArrowUpDown size={14} />
            </button>
            <Popmenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              ariaLabel={t('contacts.sort.label')}
              items={sortGroupItems}
              triggerRef={menuTriggerRef}
              align="end"
              width={200}
            />
          </div>
        </div>

        <SegmentedControl
          className="mt-2"
          fluid
          ariaLabel={t('contacts.nav.title')}
          value={props.view}
          onChange={props.onViewChange}
          options={[
            { value: 'known', label: t('contacts.view.known') },
            { value: 'all', label: t('contacts.view.all') }
          ]}
        />

        <div className="relative mt-2">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-fg-3"
          />
          <input
            value={props.q}
            onChange={(event) => props.onQChange(event.target.value)}
            placeholder={t('contacts.search.placeholder')}
            className="h-8 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 pl-7 pr-7 text-body text-ink-fg outline-none placeholder:text-ink-fg-3 focus:border-coral/50"
          />
          {props.q !== '' ? (
            <button
              type="button"
              aria-label={t('contacts.search.clear')}
              onClick={() => props.onQChange('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[var(--r-ctl)] p-1 text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg-1"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>

        {props.view === 'all' ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {KIND_BUCKETS.map((bucket) => {
              const on = props.kindFilter.has(bucket)
              return (
                <button
                  key={bucket}
                  type="button"
                  aria-pressed={on}
                  onClick={() => props.onKindFilterToggle(bucket)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-micro leading-4 transition-colors',
                    on
                      ? 'border-coral/40 bg-coral/10 text-coral'
                      : 'border-ink-border text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg-1'
                  )}
                >
                  {t(`contacts.group.${bucket}`)}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      <BackfillBar progress={props.progress} />

      {/* 列表主体 */}
      <div className="min-h-0 flex-1">
        {filtersAllOff ? (
          <EmptyState
            fill
            icon={<UsersRound size={20} strokeWidth={1.5} />}
            title={t('contacts.empty.filters')}
            hint={t('contacts.empty.filtersHint')}
          />
        ) : searchEmpty ? (
          <EmptyState
            fill
            icon={<Search size={20} strokeWidth={1.5} />}
            title={t('contacts.empty.search', { q: props.q.trim() })}
            hint={t('contacts.empty.searchHint')}
            action={
              <button
                type="button"
                onClick={() => props.onQChange('')}
                className="rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1 text-meta text-ink-fg-1 hover:bg-ink-3"
              >
                {t('contacts.search.clear')}
              </button>
            }
          />
        ) : libraryEmpty ? (
          <EmptyState
            fill
            icon={<UsersRound size={20} strokeWidth={1.5} />}
            title={t('contacts.empty.library')}
            hint={t('contacts.empty.libraryHint')}
          />
        ) : (
          <List<ContactRowsProps>
            rowComponent={ContactVirtualRow}
            rowCount={props.rows.length}
            rowHeight={(index: number) => rowHeightFor(props.rows[index], props.density)}
            rowProps={rowProps}
            className="scrollbar-none"
            style={{ height: '100%' }}
          />
        )}
      </div>

      {/* 多选底部条（🔒「合并这两条」不渲染 —— 随 WP3 整块进场）。 */}
      {props.selectionMode ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-ink-border px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-1">
            {t('contacts.select.n', { n: props.checkedIds.size })}
          </span>
          <button
            type="button"
            onClick={props.onExitSelection}
            className="rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1 text-meta text-ink-fg-1 hover:bg-ink-3"
          >
            {t('contacts.select.exit')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
