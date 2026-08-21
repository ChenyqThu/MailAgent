// 通讯录列表列（设计 §2.1 / 原型 `clist.jsx::ListPane`）。
//
// 头部三行，逐行照原型：
//   ① [users icon] 通讯录 [计数] ————— [视图分段]
//   ② [搜索 flex-1] [分组] [排序] [密度]        ← 三个工具钮各自独立，各开各的菜单
//   ③ 「全部」视图的 kind 筛选 chips
// 之后：BackfillBar（通栏）→ 虚拟滚动行（react-window v2，定高 O(1)，§7.1 铁律）
// → 多选底部条。
//
// 🔴 面：列间竖线由 `ContactsWorkspace` 的拖拽分隔条唯一负责，本组件**不画
// `border-r`**（会与分隔条并排成双线，matters E19 同款缺陷）。
// 🔴 图标：`sortdesc` 在原型的 ICON_PATHS 里没有 path、渲染成空按钮，故排序钮
// 沿用 lucide `ArrowUpDown`；密度钮按原型用 `Layers` / `ListChecks`。

import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { List } from 'react-window'
import {
  ArrowUpDown,
  Briefcase,
  Building2,
  Folder,
  Layers,
  ListChecks,
  Search,
  Sparkles,
  Users,
  UsersRound,
  X,
  type LucideIcon
} from 'lucide-react'

import type { ContactBackfillProgress, ContactSort, ContactView } from '@shared/api/types/contact'
import { cn } from '@shared/lib/cn'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { toastInfo } from '@shared/state/toast'

import { BackfillBar } from './BackfillBar'
import { ContactListSkeleton } from './ContactSkeleton'
import { ContactVirtualRow, type ContactRowActions, type ContactRowsProps } from './ContactRow'
import {
  rowHeightFor,
  shouldFetchNextContactPage,
  type ContactDensity,
  type ContactGroupBy,
  type ContactKindBucket,
  type ContactListRow
} from './contactListModel'

const KIND_BUCKETS: readonly ContactKindBucket[] = ['person', 'robot', 'list', 'hidden']
const SORTS: readonly ContactSort[] = ['density', 'recent', 'name']
const GROUP_BYS: readonly ContactGroupBy[] = ['none', 'company', 'dept', 'fn', 'level', 'manager']

/** 分组钮的图标随当前分组变化（原型 `GROUP_BY[group].icon`；manager 档 =
 *  原型 'users'，其 path 即 lucide `Users` 双人形）。 */
const GROUP_ICONS: Record<ContactGroupBy, LucideIcon> = {
  none: ListChecks,
  company: Building2,
  dept: Folder,
  fn: Briefcase,
  level: Layers,
  manager: Users
}

const TOOL_BUTTON_CLASS =
  'grid size-[26px] shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.08] hover:text-ink-fg'

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
  /** 当前视图（含搜索与 chips 过滤）实际列出的联系人数 —— 头部计数。 */
  total: number
  loading: boolean
  /** 滚到接近底部时续拉下一页（keyset 分页）。 */
  onLoadMore(): void
  /** 还有没有下一页 —— 没有就不必挂滚动回调。 */
  hasMore: boolean
  progress: ContactBackfillProgress | undefined
  selectedId: number | null
  selectionMode: boolean
  checkedIds: ReadonlySet<number>
  onExitSelection(): void
  /** WP3 入口 ②：多选恰 2 条 →「合并这两条」直入合并预览（dialog 挂在 Workspace）。 */
  onMergePair(pair: [number, number]): void
  menuOpenId: number | null
  onMenuOpenChange(id: number | null): void
  onToggleGroup(groupKey: string): void
  actions: ContactRowActions
  /** WP7 治理台入口。🔴 `MAILAGENT_CONTACT_AGENT_ENABLED` 关着时**整个胶囊不进 DOM**
   *  （上游那条 status 查询也不发 —— 两层门，`AgentPendingBadge` 先例）。 */
  agentEnabled: boolean
  /** 待审建议数；`0` 只去掉徽标，胶囊照常在（原型 `sugCount>0 &&` 只门徽标）。 */
  pendingCount: number
  onOpenAgent(): void
}

export function ContactListPane(props: ContactListPaneProps): React.ReactElement {
  const { t } = useTranslation()
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const sortTriggerRef = useRef<HTMLButtonElement>(null)
  const groupTriggerRef = useRef<HTMLButtonElement>(null)

  const { hasMore, onLoadMore, rows } = props
  // 续拉阈值走 `shouldFetchNextContactPage`（纯函数，见那里的注释）。react-query 的
  // infinite query 对重复 fetchNextPage 幂等（in-flight 时是 no-op），这里只再挡一道 hasMore。
  const handleRowsRendered = useCallback(
    (range: { stopIndex: number }): void => {
      if (!hasMore) return
      if (shouldFetchNextContactPage(range.stopIndex, rows.length)) onLoadMore()
    },
    [hasMore, onLoadMore, rows.length]
  )

  // manager 档的菜单 label 是特例映射（裁决 7：不动 §5 key 表，
  // `contacts.group.byManager` 已在两 locale），其余保持 groupBy 模板。
  const groupByLabel = (groupBy: ContactGroupBy): string =>
    groupBy === 'manager' ? t('contacts.group.byManager') : t(`contacts.groupBy.${groupBy}`)

  const sortItems: PopmenuItem[] = [
    { kind: 'label', id: 'sort-label', label: t('contacts.sort.label') },
    ...SORTS.map(
      (sort): PopmenuItem => ({
        kind: 'radio',
        id: `sort-${sort}`,
        label: t(`contacts.sort.${sort}`),
        checked: props.sort === sort,
        onSelect: () => props.onSortChange(sort)
      })
    )
  ]
  const groupItems: PopmenuItem[] = [
    { kind: 'label', id: 'group-label', label: t('contacts.groupBy.label') },
    ...GROUP_BYS.map(
      (groupBy): PopmenuItem => ({
        kind: 'radio',
        id: `group-${groupBy}`,
        label: groupByLabel(groupBy),
        checked: props.groupBy === groupBy,
        onSelect: () => props.onGroupByChange(groupBy)
      })
    )
  ]

  const filtersAllOff = props.view === 'all' && props.kindFilter.size === 0
  const searchEmpty = !props.loading && props.rows.length === 0 && props.q.trim() !== ''
  const libraryEmpty =
    !props.loading && props.rows.length === 0 && props.q.trim() === '' && !filtersAllOff

  const GroupIcon = GROUP_ICONS[props.groupBy]
  const DensityIcon = props.density === 'compact' ? Layers : ListChecks

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
      className="flex h-full min-h-0 flex-col bg-ink-1/55"
    >
      {/* 头部 */}
      <div className="shrink-0 border-b border-ink-border px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-2">
          <UsersRound size={15} aria-hidden className="shrink-0 text-coral" />
          <h1 className="shrink-0 whitespace-nowrap text-aux font-semibold tracking-[-0.01em] text-ink-fg">
            {t('contacts.nav.title')}
          </h1>
          <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
            {t('contacts.list.count', { count: props.total })}
          </span>
          <span className="flex-1" />
          {props.agentEnabled ? (
            <button
              type="button"
              onClick={props.onOpenAgent}
              title={t('contacts.agent.pillTitle')}
              className="relative inline-flex shrink-0 items-center gap-[5px] rounded-full border border-ai/25 bg-ai/[0.09] px-2 py-[3px] text-micro text-ai transition-colors duration-fast ease-standard hover:bg-ai/[0.16]"
            >
              <Sparkles size={11} aria-hidden />
              {t('contacts.agent.pill')}
              {props.pendingCount > 0 ? (
                <span
                  aria-label={t('contacts.agent.pendingBadge', { count: props.pendingCount })}
                  className="rounded-full bg-ai px-1 font-mono text-micro font-semibold tabular-nums text-white"
                >
                  {props.pendingCount}
                </span>
              ) : null}
            </button>
          ) : null}
          <SegmentedControl
            ariaLabel={t('contacts.nav.title')}
            value={props.view}
            onChange={props.onViewChange}
            options={[
              { value: 'known', label: t('contacts.view.known') },
              { value: 'all', label: t('contacts.view.all') }
            ]}
          />
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <label className="flex h-7 min-w-0 flex-1 items-center gap-[7px] rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5">
            <Search size={13} aria-hidden className="shrink-0 text-ink-fg-3" />
            <input
              value={props.q}
              onChange={(event) => props.onQChange(event.target.value)}
              placeholder={t('contacts.search.placeholder')}
              aria-label={t('contacts.search.placeholder')}
              className="min-w-0 flex-1 bg-transparent text-body text-ink-fg outline-none placeholder:text-ink-fg-3"
            />
            {props.q !== '' ? (
              <button
                type="button"
                aria-label={t('contacts.search.clear')}
                onClick={() => props.onQChange('')}
                className="grid size-5 shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.08] hover:text-ink-fg-1"
              >
                <X size={11} />
              </button>
            ) : null}
          </label>

          <div className="relative">
            <button
              ref={groupTriggerRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={groupMenuOpen}
              aria-label={t('contacts.groupBy.label')}
              title={`${t('contacts.groupBy.label')}：${groupByLabel(props.groupBy)}`}
              onClick={() => setGroupMenuOpen((open) => !open)}
              className={cn(
                TOOL_BUTTON_CLASS,
                (groupMenuOpen || props.groupBy !== 'none') && 'bg-ink-fg/[0.08] text-ink-fg'
              )}
            >
              <GroupIcon size={14} />
            </button>
            <Popmenu
              open={groupMenuOpen}
              onClose={() => setGroupMenuOpen(false)}
              ariaLabel={t('contacts.groupBy.label')}
              items={groupItems}
              triggerRef={groupTriggerRef}
              align="end"
              width={200}
            />
          </div>

          <div className="relative">
            <button
              ref={sortTriggerRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={sortMenuOpen}
              aria-label={t('contacts.sort.label')}
              title={`${t('contacts.sort.label')}：${t(`contacts.sort.${props.sort}`)}`}
              onClick={() => setSortMenuOpen((open) => !open)}
              className={cn(TOOL_BUTTON_CLASS, sortMenuOpen && 'bg-ink-fg/[0.08] text-ink-fg')}
            >
              <ArrowUpDown size={14} />
            </button>
            <Popmenu
              open={sortMenuOpen}
              onClose={() => setSortMenuOpen(false)}
              ariaLabel={t('contacts.sort.label')}
              items={sortItems}
              triggerRef={sortTriggerRef}
              align="end"
              width={200}
            />
          </div>

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
            className={cn(
              TOOL_BUTTON_CLASS,
              props.density === 'comfortable' && 'bg-ink-fg/[0.08] text-ink-fg'
            )}
          >
            <DensityIcon size={14} />
          </button>
        </div>

        {props.view === 'all' ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {KIND_BUCKETS.map((bucket) => {
              const on = props.kindFilter.has(bucket)
              return (
                <button
                  key={bucket}
                  type="button"
                  aria-pressed={on}
                  onClick={() => props.onKindFilterToggle(bucket)}
                  className={cn(
                    'rounded-full border px-[9px] py-[3px] text-meta leading-4 transition-colors duration-fast ease-standard',
                    on
                      ? 'border-coral/30 bg-coral/10 text-coral'
                      : 'border-ink-border text-ink-fg-2 hover:bg-ink-fg/[0.06] hover:text-ink-fg-1'
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
                className="rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1 text-meta text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3"
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
        ) : props.loading && props.rows.length === 0 ? (
          // 冷启动骨架。🔴 只在**没有任何行**时出：`useContactList` 带
          // `placeholderData:(prev)=>prev`，切视图 / 改搜索时上一份数据还在，那时候把列表
          // 换成骨架等于把已经能看的内容藏起来（比留旧数据更糟）。
          <ContactListSkeleton density={props.density} />
        ) : (
          <List<ContactRowsProps>
            rowComponent={ContactVirtualRow}
            rowCount={props.rows.length}
            rowHeight={(index: number) => rowHeightFor(props.rows[index], props.density)}
            rowProps={rowProps}
            onRowsRendered={handleRowsRendered}
            className="scrollbar-none"
            style={{ height: '100%' }}
          />
        )}
      </div>

      {/* 多选底部条（WP3：「合并这两条」恒渲染、仅恰 2 条可用；点不可用位给提示）。 */}
      {props.selectionMode ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-ink-border bg-ink-2 px-3 py-2">
          <ListChecks size={13} aria-hidden className="shrink-0 text-ink-fg-2" />
          <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-1">
            {t('contacts.select.n', { n: props.checkedIds.size })}
          </span>
          <button
            type="button"
            onClick={props.onExitSelection}
            className="shrink-0 rounded-[var(--r-ctl)] px-2.5 py-1 text-meta text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.06]"
          >
            {t('contacts.select.exit')}
          </button>
          <button
            type="button"
            aria-disabled={props.checkedIds.size !== 2}
            title={props.checkedIds.size !== 2 ? t('contacts.select.mergeHint') : undefined}
            onClick={() => {
              const ids = [...props.checkedIds]
              if (ids.length !== 2) {
                toastInfo(t('contacts.select.mergeHint'))
                return
              }
              props.onMergePair([ids[0]!, ids[1]!])
            }}
            className={cn(
              'shrink-0 rounded-[var(--r-ctl)] border px-2.5 py-1 text-meta font-medium transition-colors duration-fast ease-standard',
              props.checkedIds.size === 2
                ? 'border-coral/30 bg-coral/10 text-coral hover:bg-coral/[0.17]'
                : 'border-ink-border text-ink-fg-3 opacity-70 hover:bg-ink-3'
            )}
          >
            {t('contacts.select.merge')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
