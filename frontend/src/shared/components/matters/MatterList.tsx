import { useEffect, useMemo, useRef, useState } from 'react'
import { List, useDynamicRowHeight } from 'react-window'
import type { ListImperativeAPI, RowComponentProps } from 'react-window'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Eye,
  Flag,
  Hourglass,
  Layers,
  ListChecks,
  Minus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react'

import type { TFunction } from 'i18next'

import { MATTER_TAG_DEFAULT_COLOR, MATTER_TAG_DEFAULT_SHAPE } from '@shared/api/types/matter'
import type { Matter, MatterTagDefinition } from '@shared/api/types/matter'
import type { MatterStakeholderSummary } from '@shared/api/types/matter'
import { RecipientAvatar } from '@shared/components/email/compose/recipient-avatar'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Popmenu } from '@shared/components/ui/Popmenu'
import type { PopmenuItem } from '@shared/components/ui/Popmenu'
import {
  formatMatterAgo,
  formatMatterDueRelative,
  nextAction,
  trashDaysRemaining
} from '@shared/lib/matterDerive'
import { openAttentionFor } from '@shared/lib/matterDerive'
import type {
  MatterAttentionIndex,
  MatterNextActionKind,
  MatterUpdateIndex
} from '@shared/lib/matterDerive'
import { cn } from '@shared/lib/cn'

import { ATTENTION_META, attentionTone } from './attentionMeta'
import { MatterPip } from './MatterPip'
import {
  activeMatterFilterCount,
  groupMatters,
  MATTER_DUE_BUCKET_ICONS,
  MATTER_DUE_BUCKET_TONES,
  MATTER_GROUP_MODES,
  MATTER_QUICK_FILTER_ICONS,
  MATTER_QUICK_FILTER_TONES,
  MATTER_QUICK_FILTERS,
  MATTER_SCOPE_ICONS,
  MATTER_SCOPES,
  MATTER_SORTS,
  MATTER_STATUS_GROUP_ICONS,
  MATTER_STATUS_GROUP_TONES,
  MATTER_STATUS_GROUPS
} from './matterListQuery'
import type {
  MatterGroup,
  MatterGroupMode,
  MatterGroupTone,
  MatterListQuery,
  MatterQuickFilter,
  MatterSortDir,
  MatterSortKey,
  MatterStatusGroup
} from './matterListQuery'
import { MatterListSkeleton, MATTER_ROW_HEIGHT_ESTIMATE } from './MatterSkeleton'
import { MatterTagMarker } from './MatterTagMarker'
import { useMatterWorkspace } from './matterWorkspaceStore'
import {
  MATTER_HEALTH_ICONS,
  MATTER_HEALTH_TEXT_CLASS,
  MATTER_PRIORITY_TONES,
  MATTER_STATUS_ICONS,
  MATTER_STATUS_TONES,
  MATTER_TONE_CHIP_CLASS,
  MATTER_TONE_DOT_CLASS,
  MATTER_TONE_TEXT_CLASS,
  matterDueTone
} from './matterVocab'
import type { MatterTone } from './matterVocab'

/** 设计 `list.jsx::ListPane` 用 ResizeObserver 在 360px 处切窄列变体（不是窗口断点：
 *  清单列本身可被用户拖宽拖窄，看窗口就会在拖到 300px 时仍按宽列排）。 */
const NARROW_LIST_WIDTH = 360
/** E10②（dogfood 轮 2）—— 在真正跌进 `NARROW_LIST_WIDTH` 的整段折叠之前，先单独让出
 *  事项编号（`MAT-xxxx`）这一项：它是行 1 里信息密度最低、最不影响一眼判断的一项，比一次性
 *  砍掉优先级/状态整段更省得体。同一个 ResizeObserver 出两档，不另起监听。 */
const ID_HIDE_WIDTH = 440
/** 设计 `list.jsx:170` `AvatarStack size={19} max={3}`。 */
const AVATAR_STACK_MAX = 3
/** 收件箱同款：筛选+分组+排序 20+ 行比基座默认的 288 高一截；Popmenu 仍按视口可用空间
 *  二次夹取，窗口矮时退化成面板内滚动（EmailListHeader 的先例注释同款理由）。 */
const FILTER_MENU_MAX_HEIGHT = 640
/** 虚拟列表量到真实可视高度之前的回落视口（px）。取一个接近常见窗口高度的数：0（库默认）
 *  会让首帧只渲染 overscan 那几行、量到之后再补齐，肉眼可见地「先出三行再长出来」。 */
const DEFAULT_LIST_VIEWPORT_HEIGHT = 720

/** V3-05 组头的语气色 —— `MatterTone` 五档 + 组头专属的第六档 accent（设计 H3§2 里
 *  「需要你推进」那一行）。neutral 走 `--ink-fg-2`，与设计 `GroupHead` 的 `c` 同口径。 */
const MATTER_GROUP_TONE_TEXT_CLASS: Record<MatterGroupTone, string> = {
  ...MATTER_TONE_TEXT_CLASS,
  accent: 'text-coral'
}

/** 设计 `list.jsx::nextAction` 每档配的 icon（listcheck / hourglass / ban / eye /
 *  checkcircle / helpcircle）。文案与 tone 由 `matterDerive.nextAction` 给。 */
const NEXT_ACTION_ICONS: Record<MatterNextActionKind, LucideIcon> = {
  action: ListChecks,
  waiting: Hourglass,
  blocker: Ban,
  monitoring: Eye,
  done: CheckCircle2,
  missing: CircleHelp
}

interface MatterListProps {
  /** 已经过 `applyMatterListQuery` 的最终可见有序集 —— 由工作台单点计算（与详情上下条
   *  导航共用同一份），清单不再自己算第二遍。 */
  matters: readonly Matter[]
  query: MatterListQuery
  onQueryChange(query: MatterListQuery): void
  /** 当前范围分页截断前的总行数；null = 不可知（open/done 在活跃行超一页时算不准，
   *  宁缺毋错）。见 MattersWorkspace 的 scopeTotal 注释。 */
  scopeTotal: number | null
  /** 标签定义（筛选菜单「标签」二级面板的数据源）。 */
  tags: readonly MatterTagDefinition[]
  /**
   * 「此刻」的基准（到期分档 / 到期色 / 更新时间）。工作台传的是它**自己**那份冻结值 ——
   * 筛选、排序、上下条导航序都用同一份，分组才不会与它们错档。不传则退回本组件挂载时冻结的
   * 值（测试与独立渲染用；MatterList 会随路由切换卸载重挂，自持的话跨零点会与工作台劈叉）。
   */
  now?: number
  selectedId: string | null
  attention?: MatterAttentionIndex
  /** 待审阅徽标的口径 —— 复用工作台既有的 pendingUpdates 查询，清单不自己发请求。 */
  updates?: MatterUpdateIndex
  search: string
  /** 首屏还在拉数据（task 08-20 P0-2）。🔴 只有它 + 「一行都没有」才出骨架：工作台的列表
   *  查询带 `placeholderData: keepPreviousData`，切范围/改筛选时上一批行还在，那时候把列表换成
   *  骨架等于把已经能看的内容藏起来。**加载中永远不许出「暂无事项」空态** —— 那是误导。 */
  loading?: boolean
  onSearchChange(value: string): void
  onSelect(matter: Matter): void
  onCreate(): void
  onManageTags(): void
}

/** 虚拟列表的行模型 —— 组头与事项行都是「一行」，一起参与虚拟化（否则组头不进 List，
 *  分组维度下滚动位置会与内容错位）。 */
type MatterListRowItem =
  | { kind: 'head'; key: string; group: MatterGroup; collapsed: boolean }
  | { kind: 'matter'; key: string; matter: Matter }

export function MatterList({
  matters,
  query,
  onQueryChange,
  scopeTotal,
  tags,
  now: nowProp,
  selectedId,
  attention,
  updates,
  search,
  loading = false,
  onSearchChange,
  onSelect,
  onCreate,
  onManageTags
}: MatterListProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const paneRef = useRef<HTMLElement>(null)
  const filterTriggerRef = useRef<HTMLButtonElement>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [narrow, setNarrow] = useState(false)
  // E10②：与 `narrow` 同一个 ResizeObserver 出两档（宽 → 隐编号 → 整段折叠），不另起监听。
  const [hideId, setHideId] = useState(false)
  // 到期色 / 更新时间的基准时刻在挂载时冻结（react-hooks/purity：render 期间不许调
  // Date.now()）。与 MatterDetail / MatterFocus 同一模式；工作台传下来时以它为准（见 props）。
  const [mountedNow] = useState(() => Date.now())
  const now = nowProp ?? mountedNow
  // V3-05 —— 折叠态按组 key 存（key 自带维度前缀，见 matterListQuery::MatterGroup）。
  // task 08-20：搬进工作台 store —— 本组件随 tab 切换卸载重挂，自持一份等于「去看板转一圈
  // 回来，手动折叠的组全展开了」。
  const collapsed = useMatterWorkspace((state) => state.collapsedGroups)
  const toggleGroup = useMatterWorkspace((state) => state.toggleGroup)
  const clearCollapsedGroups = useMatterWorkspace((state) => state.clearCollapsedGroups)
  const expandGroups = useMatterWorkspace((state) => state.expandGroups)
  const locale = i18n.language || 'zh-CN'
  const scopeLabel = t(`matters.scope.${query.scope}`)
  const activeN = activeMatterFilterCount(query)

  useEffect(() => {
    const pane = paneRef.current
    if (!pane || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const width = entry.contentRect.width
      setNarrow(width < NARROW_LIST_WIDTH)
      setHideId(width < ID_HIDE_WIDTH)
    })
    observer.observe(pane)
    return () => observer.disconnect()
  }, [])

  // V3-05 —— 分组是 `matterListQuery` 的单源函数算的（工作台的上/下条导航序吃的是同一个
  // 函数的产物，见 MattersWorkspace::visibleIds），这里不现算第二套。
  const groups = useMemo(() => groupMatters(matters, query.group, now), [matters, now, query.group])
  const groupsRef = useRef(groups)
  useEffect(() => {
    groupsRef.current = groups
  }, [groups])

  // 维度切换 = 组的命名空间整个换了，旧折叠态不再有意义（H3§2「组切换时重置」）。
  // 🔴 判据是「维度真的变了」而不是「本 effect 跑了一次」：折叠态提升进 store 之后，挂载时
  // 无脑清一次等于「去看板转一圈回来，手动折叠的组全展开了」—— 正是本批要修的那类丢失。
  const previousGroupRef = useRef(query.group)
  useEffect(() => {
    if (previousGroupRef.current === query.group) return
    previousGroupRef.current = query.group
    clearCollapsedGroups()
  }, [clearCollapsedGroups, query.group])

  // 🔴 选中项落进折叠组时自动展开该组（reveal-on-navigate）：详情页的上/下条导航按分组后的
  // 视觉序走，不展开的话「下一条」会选中一个屏幕上根本看不见的行。只在**选中项变化**时触发
  // （依赖只有 selectedId，组数据从 ref 取）—— 挂在 groups 上会让任何一次列表刷新都撤销用户
  // 刚做的手动折叠。折叠本身永远不动选中（本模块「掉出可见集才丢选中」的守卫读的是查询结果，
  // 与折叠态无关，见 MattersWorkspace 的 effect）。
  useEffect(() => {
    if (!selectedId) return
    expandGroups(
      groupsRef.current
        .filter((group) => group.matters.some((matter) => matter.public_id === selectedId))
        .map((group) => group.key)
    )
  }, [expandGroups, selectedId])

  // ── 虚拟化（task 08-20 P1-5）───────────────────────────────────────────────
  // 组头与事项行摊平成**一维行序列**再交给 react-window：组头留在 List 外面（比如做成
  // sticky 的兄弟节点）会让滚动坐标与内容对不上。分组头因此**不再 sticky** —— 虚拟行是
  // 绝对定位的兄弟节点，`position: sticky` 只在自己那一行的盒子里生效，加了也没有效果
  // （owner dogfood 清单里记了这条视觉退让；要找回来得另做「浮在 List 之上的一层组头」）。
  const rows = useMemo((): MatterListRowItem[] => {
    const flat: MatterListRowItem[] = []
    for (const group of groups) {
      const groupCollapsed = collapsed.has(group.key)
      if (group.kind !== 'all') {
        flat.push({ kind: 'head', key: `head/${group.key}`, group, collapsed: groupCollapsed })
      }
      if (groupCollapsed) continue
      for (const matter of group.matters) {
        // 🔴 key 带组前缀：标签维度下同一事项会出现在多个组里（H3§2），只用 public_id 会撞。
        flat.push({ kind: 'matter', key: `${group.key}/${matter.public_id}`, matter })
      }
    }
    return flat
  }, [collapsed, groups])

  // 行高**不预算**：清单行是 2–4 行的可变高度（narrow 变体 / 有没有第三行），任何一份手抄
  // 的几何表都会随样式漂掉。react-window v2 的 `useDynamicRowHeight` 用 ResizeObserver 量
  // 真实行高，`MATTER_ROW_HEIGHT_ESTIMATE` 只是「还没量到的行」的估值（滚动条长度 + 首帧
  // 窗口大小）。key = 行序列签名：行集一变，index→高度 的对应关系就失效，整份缓存作废重量。
  const rowsSignature = useMemo(() => rows.map((row) => row.key).join('|'), [rows])
  const rowHeight = useDynamicRowHeight({
    defaultRowHeight: MATTER_ROW_HEIGHT_ESTIMATE,
    key: rowsSignature
  })
  const listRef = useRef<ListImperativeAPI | null>(null)
  // 选中项换了就把它滚进视口：虚拟化之后视口外的行**根本不在 DOM 里**，详情页 j/k 上下条
  // 导航若不带滚动，用户会看到清单原地不动、详情却换了一条。每个选中值只滚一次
  // （`scrolledSelectionRef`），列表刷新不会把用户滚回去；找不到那一行（比如它所在的组还没
  // 被上面的 reveal-on-navigate 展开）就先不滚，等 rows 变了这个 effect 再试一次。
  const scrolledSelectionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedId) {
      scrolledSelectionRef.current = null
      return
    }
    if (scrolledSelectionRef.current === selectedId) return
    const index = rows.findIndex(
      (row) => row.kind === 'matter' && row.matter.public_id === selectedId
    )
    if (index < 0) return
    scrolledSelectionRef.current = selectedId
    listRef.current?.scrollToRow({ index, align: 'auto' })
  }, [rows, selectedId])

  const rowProps = useMemo(
    (): MatterVirtualRowProps => ({
      rows,
      tags,
      selectedId,
      attention,
      updates,
      narrow,
      hideId,
      now,
      locale,
      onSelect,
      onToggleGroup: toggleGroup
    }),
    [attention, hideId, locale, narrow, now, onSelect, rows, selectedId, tags, toggleGroup, updates]
  )

  const patch = (partial: Partial<MatterListQuery>): void => onQueryChange({ ...query, ...partial })
  const toggleQuick = (key: MatterQuickFilter): void =>
    patch({
      quick: query.quick.includes(key)
        ? query.quick.filter((value) => value !== key)
        : [...query.quick, key]
    })
  const toggleStatusGroup = (group: MatterStatusGroup): void =>
    patch({
      statusGroups: query.statusGroups.includes(group)
        ? query.statusGroups.filter((value) => value !== group)
        : [...query.statusGroups, group]
    })
  const togglePriority = (priority: Matter['priority']): void =>
    patch({
      priorities: query.priorities.includes(priority)
        ? query.priorities.filter((value) => value !== priority)
        : [...query.priorities, priority]
    })
  const toggleTag = (name: string): void =>
    patch({
      tags: query.tags.includes(name)
        ? query.tags.filter((value) => value !== name)
        : [...query.tags, name]
    })
  const clearFilters = (): void => patch({ quick: [], statusGroups: [], priorities: [], tags: [] })

  // 有事项在用的标签才进面板（设计 `liveTags = tags.filter(t => t.n > 0)`）；已被勾选的
  // 保底保留 —— 否则最后一个使用者被移除后 chip 无处可解除。
  const liveTags = tags.filter((tag) => tag.usage_count > 0 || query.tags.includes(tag.name))
  const ScopeIcon = MATTER_SCOPE_ICONS[query.scope]

  // ⚠️ V3-06 —— item 树**必须每次 render 重建**，绝不 useMemo：Popmenu 的子面板按 id 路径
  // 沿「当前 items」重解析（Popmenu.tsx:120-128 修过的真 bug —— memo 出陈旧快照会让已打开
  // 的子面板吃不到新的 checked 态，「点了没反应，关掉重开才对」）。
  const menuItems: PopmenuItem[] = [
    { kind: 'label', id: 'filter-head', label: t('matters.filter.filterBy') },
    ...MATTER_QUICK_FILTERS.map((key): PopmenuItem => {
      const Icon = MATTER_QUICK_FILTER_ICONS[key]
      return {
        kind: 'checkbox',
        id: `quick-${key}`,
        label: t(`matters.quick.${key}`),
        icon: <Icon size={13} />,
        checked: query.quick.includes(key),
        onToggle: () => toggleQuick(key)
      }
    }),
    {
      kind: 'submenu',
      id: 'status',
      icon: <Layers size={13} />,
      label: t('matters.filter.status'),
      items: [
        { kind: 'label', id: 'status-head', label: t('matters.filter.statusSection') },
        ...MATTER_STATUS_GROUPS.map(
          (group): PopmenuItem => ({
            kind: 'checkbox',
            id: `status-${group}`,
            label: t(`matters.statusGroup.${group}`),
            checked: query.statusGroups.includes(group),
            onToggle: () => toggleStatusGroup(group)
          })
        )
      ]
    },
    {
      kind: 'submenu',
      id: 'priority',
      icon: <Flag size={13} />,
      label: t('matters.filter.priority'),
      items: [
        { kind: 'label', id: 'priority-head', label: t('matters.filter.prioritySection') },
        ...(['p0', 'p1', 'p2', 'p3'] as const).map(
          (priority): PopmenuItem => ({
            kind: 'checkbox',
            id: `priority-${priority}`,
            label: priority.toUpperCase(),
            dotClassName: MATTER_TONE_DOT_CLASS[MATTER_PRIORITY_TONES[priority]],
            checked: query.priorities.includes(priority),
            onToggle: () => togglePriority(priority)
          })
        )
      ]
    },
    // V3-04 —— 标签作为**临时筛选条件**回归（轮 3 删的是「标签作为导航入口」；owner 拍板
    // 有意反转）。没有在用标签时整个面板不出现，避免一个恒空的二级面板。
    ...(liveTags.length > 0
      ? [
          {
            kind: 'submenu',
            id: 'tags',
            icon: <Tag size={13} />,
            label: t('matters.filter.tags'),
            items: [
              { kind: 'label', id: 'tag-head', label: t('matters.filter.tagSection') },
              ...liveTags.map(
                (tag): PopmenuItem => ({
                  kind: 'checkbox',
                  id: `tag-${tag.name}`,
                  label: tag.name,
                  icon: <MatterTagMarker color={tag.color} shape={tag.shape} size="sm" />,
                  checked: query.tags.includes(tag.name),
                  onToggle: () => toggleTag(tag.name)
                })
              ),
              { kind: 'separator', id: 'tag-sep' },
              {
                kind: 'action',
                id: 'tag-manage',
                label: t('matters.filter.manageTags'),
                onSelect: onManageTags
              }
            ]
          } satisfies PopmenuItem
        ]
      : []),
    {
      kind: 'submenu',
      id: 'scope',
      icon: <ScopeIcon size={13} />,
      label: t('matters.filter.scopeSubmenu', { scope: scopeLabel }),
      items: [
        { kind: 'label', id: 'scope-head', label: t('matters.filter.scopeSection') },
        ...MATTER_SCOPES.map((scope): PopmenuItem => {
          const Icon = MATTER_SCOPE_ICONS[scope]
          return {
            kind: 'radio',
            id: `scope-${scope}`,
            label: t(`matters.scope.${scope}`),
            icon: <Icon size={13} />,
            checked: query.scope === scope,
            onSelect: () => patch({ scope })
          }
        })
      ]
    },
    { kind: 'separator', id: 'sep-group' },
    { kind: 'label', id: 'group-head', label: t('matters.filter.groupBy') },
    ...MATTER_GROUP_MODES.map(
      (mode: MatterGroupMode): PopmenuItem => ({
        kind: 'radio',
        id: `group-${mode}`,
        label: t(`matters.group.${mode}`),
        checked: query.group === mode,
        onSelect: () => patch({ group: mode })
      })
    ),
    { kind: 'separator', id: 'sep-sort' },
    { kind: 'label', id: 'sort-head', label: t('matters.filter.sortBy') },
    ...MATTER_SORTS.map(
      (sort: MatterSortKey): PopmenuItem => ({
        kind: 'radio',
        id: `sort-${sort}`,
        label:
          sort === 'rank'
            ? `${t(`matters.sort.${sort}`)}${t('matters.filter.defaultSuffix')}`
            : t(`matters.sort.${sort}`),
        checked: query.sort === sort,
        onSelect: () => patch({ sort })
      })
    ),
    { kind: 'separator', id: 'sep-dir' },
    { kind: 'label', id: 'dir-head', label: t('matters.filter.direction') },
    ...(['default', 'reverse'] as const).map(
      (dir: MatterSortDir): PopmenuItem => ({
        kind: 'radio',
        id: `dir-${dir}`,
        label: t(`matters.dir.${dir}`),
        checked: query.dir === dir,
        onSelect: () => patch({ dir })
      })
    ),
    ...(activeN > 0
      ? ([
          { kind: 'separator', id: 'sep-clear' },
          {
            kind: 'action',
            id: 'clear-all',
            label: t('matters.filter.clearAll'),
            tone: 'accent',
            onSelect: clearFilters
          }
        ] as PopmenuItem[])
      : [])
  ]

  // V3-09 —— 第二行：可删 chip（范围非默认时也出一个）+ 右侧 mono「分组 X · 排序 Y」摘要。
  const showChips =
    activeN > 0 ||
    query.scope !== 'all' ||
    query.group !== 'status' ||
    query.sort !== 'rank' ||
    query.dir !== 'default'
  const summary = [
    t('matters.filter.summaryGroup', { group: t(`matters.group.${query.group}`) }),
    t('matters.filter.summarySort', { sort: t(`matters.sort.${query.sort}`) }),
    ...(query.dir === 'reverse' ? [t('matters.dir.reverse')] : [])
  ].join(' · ')

  const searchActive = search.trim().length > 0
  const EmptyIcon = searchActive ? Search : activeN > 0 ? SlidersHorizontal : ScopeIcon

  return (
    <section
      ref={paneRef}
      // E19（dogfood 轮 2 #19）—— 不在这里再画一条分界线：MattersWorkspace 的可拖拽
      // 分隔条（`role="separator"`）已经在列表/详情之间画了唯一一条竖线；这里再加
      // `border-r` 会与分隔条的线并排出现，变成肉眼可见的双线。
      className="flex h-full min-w-0 flex-col bg-ink-1/55"
    >
      {/* Popmenu 定位锚：面板 absolute 于本容器（收件箱 EmailListHeader 同款挂法）。 */}
      <div className="relative border-b border-ink-border p-3">
        <div className="flex items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-2">
            <Search size={14} className="text-ink-fg-2" />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              // 设计 H3§3 —— placeholder 跟随当前范围名，而不是一句放之四海的通用提示。
              placeholder={t('matters.list.searchInView', { view: scopeLabel })}
              className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-ink-fg-2"
            />
          </label>
          {/* V3-07（缩减版）—— 命中数 / 范围总数。范围总数不可知（open/done 超一页）时只显
              示命中数：错的数字比没有数字更糟（owner 拍板）。 */}
          <span className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-3">
            {scopeTotal !== null && scopeTotal !== matters.length
              ? `${matters.length} / ${scopeTotal}`
              : `${matters.length}`}
          </span>
          <button
            ref={filterTriggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            aria-controls="matter-filter-pop"
            onClick={() => setFilterOpen((open) => !open)}
            className="flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2 py-1.5 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
          >
            <SlidersHorizontal size={12} />
            {t('matters.filter.trigger')}
            {activeN > 0 ? (
              <span className="rounded-full bg-coral/100 px-1.5 font-mono text-[10px] font-semibold leading-4 text-accent-fg">
                {activeN}
              </span>
            ) : null}
          </button>
        </div>
        {showChips ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {query.scope !== 'all' ? (
              <FilterChip
                label={scopeLabel}
                tone="warn"
                title={t('matters.filter.removeChip')}
                onRemove={() => patch({ scope: 'all' })}
              />
            ) : null}
            {query.quick.map((key) => (
              <FilterChip
                key={`quick-${key}`}
                label={t(`matters.quick.${key}`)}
                tone={MATTER_QUICK_FILTER_TONES[key]}
                title={t('matters.filter.removeChip')}
                onRemove={() => toggleQuick(key)}
              />
            ))}
            {query.statusGroups.map((group) => (
              <FilterChip
                key={`status-${group}`}
                label={t(`matters.statusGroup.${group}`)}
                title={t('matters.filter.removeChip')}
                onRemove={() => toggleStatusGroup(group)}
              />
            ))}
            {query.priorities.map((priority) => (
              <FilterChip
                key={`priority-${priority}`}
                label={priority.toUpperCase()}
                title={t('matters.filter.removeChip')}
                onRemove={() => togglePriority(priority)}
              />
            ))}
            {query.tags.map((name) => (
              <FilterChip
                key={`tag-${name}`}
                label={`#${name}`}
                title={t('matters.filter.removeChip')}
                onRemove={() => toggleTag(name)}
              />
            ))}
            <span className="flex-1" />
            <span className="shrink-0 whitespace-nowrap font-mono text-[10.5px] text-ink-fg-3">
              {summary}
            </span>
            {activeN > 1 ? (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex shrink-0 items-center gap-0.5 text-meta text-ink-fg-2 transition-colors duration-fast hover:text-ink-fg"
              >
                <X size={11} />
                {t('matters.filter.clear')}
              </button>
            ) : null}
          </div>
        ) : null}
        <Popmenu
          id="matter-filter-pop"
          open={filterOpen}
          onClose={() => setFilterOpen(false)}
          items={menuItems}
          title={t('matters.filter.title')}
          ariaLabel={t('matters.filter.title')}
          triggerRef={filterTriggerRef}
          anchorClassName="right-2 top-[calc(100%+0.375rem)]"
          maxHeight={FILTER_MENU_MAX_HEIGHT}
        />
      </div>
      <div className="min-h-0 flex-1">
        {/* V3-05 行内分组 —— 空组不渲染（groupMatters 已过滤），`none` 维度只出一个无头的组；
            组头与事项行一起进虚拟列表（见上方 rows 的注释）。 */}
        {matters.length > 0 ? (
          <List<MatterVirtualRowProps>
            listRef={listRef}
            rowComponent={MatterVirtualRow}
            rowCount={rows.length}
            rowHeight={rowHeight}
            rowProps={rowProps}
            // 量到真实高度之前的回落视口（happy-dom 无 ResizeObserver，测试也吃这个值）：
            // 取一个接近常见窗口的数，首帧就渲染「一屏左右」的行，而不是先出 3 行再补齐。
            defaultHeight={DEFAULT_LIST_VIEWPORT_HEIGHT}
            className="scrollbar-thin"
            style={{ height: '100%' }}
          />
        ) : loading ? (
          // 🔴 加载中出骨架，**绝不**出「暂无事项」空态：那句话会被读成「你没有事项」。
          <MatterListSkeleton />
        ) : (
          <EmptyState
            icon={<EmptyIcon size={22} />}
            title={
              searchActive
                ? t('matters.empty.search', { query: search.trim() })
                : activeN > 0
                  ? t('matters.empty.filtered')
                  : query.scope === 'trash'
                    ? t('matters.empty.trash')
                    : query.scope === 'archived'
                      ? t('matters.empty.archived')
                      : t('matters.empty.default', { view: scopeLabel })
            }
            hint={
              searchActive
                ? t('matters.empty.hintSearch')
                : activeN > 0
                  ? t('matters.empty.hintFiltered')
                  : query.scope === 'trash'
                    ? t('matters.empty.hintTrash')
                    : query.scope === 'archived'
                      ? t('matters.empty.hintArchived')
                      : t('matters.empty.hintDefault')
            }
            className="px-5 py-12"
            action={
              !searchActive && activeN > 0 ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body text-ink-fg-1 hover:bg-ink-3"
                >
                  {t('matters.empty.clearFilters')}
                </button>
              ) : query.scope !== 'trash' && query.scope !== 'archived' ? (
                <button
                  type="button"
                  onClick={onCreate}
                  className="rounded-[var(--r-ctl)] bg-coral/100 px-3 py-2 text-body font-medium text-accent-fg"
                >
                  {t('matters.create.submit')}
                </button>
              ) : null
            }
          />
        )}
      </div>
    </section>
  )
}

/** 虚拟行的 props 面（`rowProps`；react-window 会在其中任一值变化时重渲染可见行）。 */
interface MatterVirtualRowProps {
  rows: readonly MatterListRowItem[]
  tags: readonly MatterTagDefinition[]
  selectedId: string | null
  attention?: MatterAttentionIndex
  updates?: MatterUpdateIndex
  narrow: boolean
  hideId: boolean
  now: number
  locale: string
  onSelect(matter: Matter): void
  onToggleGroup(key: string): void
}

/**
 * react-window 行渲染器：`style`（绝对定位 + translateY）必须原样落到最外层元素上。
 *
 * 🔴 **不写 height**：`useDynamicRowHeight` 档下 List 有意不下发高度，行由内容自然撑开、
 * 再被 ResizeObserver 量回去；这里自己补一个高度就等于把估值焊死，量出来的永远是估值。
 */
function MatterVirtualRow({
  index,
  style,
  rows,
  tags,
  selectedId,
  attention,
  updates,
  narrow,
  hideId,
  now,
  locale,
  onSelect,
  onToggleGroup
}: RowComponentProps<MatterVirtualRowProps>): React.ReactElement {
  const row = rows[index]
  if (!row) return <div style={style} />
  if (row.kind === 'head') {
    const group = row.group
    return (
      <div style={style}>
        <MatterGroupHead
          group={group}
          tag={
            group.kind === 'tag'
              ? tags.find((definition) => definition.name === group.tagName)
              : undefined
          }
          collapsed={row.collapsed}
          onToggle={() => onToggleGroup(group.key)}
        />
      </div>
    )
  }
  const matter = row.matter
  return (
    <div style={style}>
      <MatterRow
        matter={matter}
        selected={selectedId === matter.public_id}
        signals={openAttentionFor(matter, attention)}
        pendingCount={
          updates?.get(matter.public_id)?.filter((update) => update.review_status === 'pending')
            .length ?? 0
        }
        narrow={narrow}
        hideId={hideId}
        now={now}
        locale={locale}
        onSelect={() => onSelect(matter)}
      />
    </div>
  )
}

/** V3-09 可删条件 chip（设计 `list.jsx::chip`：tone 色 11% 底 + 30% 边，无 tone 走 accent）。 */
function FilterChip({
  label,
  tone,
  title,
  onRemove
}: {
  label: string
  tone?: MatterTone
  title: string
  onRemove(): void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onRemove}
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border py-0.5 pl-2 pr-1.5 text-micro',
        tone ? MATTER_TONE_CHIP_CLASS[tone] : 'border-coral/30 bg-coral/10 text-coral'
      )}
    >
      {label}
      <X size={10} />
    </button>
  )
}

/**
 * V3-05 行内分组头（设计 `list.jsx::GroupHead`）：29px 粘性条 —— chevron + 维度符号 +
 * 组名 + 计数，点击整条折叠。
 *
 * 密度：清单默认 336px 宽（已是 `narrow` 变体、行本身就三行），故组头**只有一层**内边距、
 * 不叠 padding，且不吃行的水平内边距（`px-3` vs 行的 `px-4`，chevron 恰好挂在标题左侧）。
 *
 * 遮挡：原本是粘性条（`sticky top-0`），要挡住从下面滚过去的行，所以**不叠一层不透明底**
 * （清单面本身是 `bg-ink-1/55` 的玻璃，压一块实心 ink-1 会变成突兀的色块 —— EmailDetail 的
 * sticky 标题栏踩过并记了这一条），改成「比面板密一档的同色 + backdrop 磨砂」：设计
 * `GroupHead` 的 `backdropFilter: saturate` 同一路子。
 *
 * 🔴 task 08-20 起清单虚拟化，行是绝对定位的兄弟节点 ⇒ `sticky` 在这里不可能生效（粘的
 * 参照系变成了它自己那一行的盒子），故把 `sticky top-0 z-10` 摘掉，不留一个骗人的类名。
 * 磨砂底保留：它现在的作用是把组头与行区分开，不再是遮挡。
 */
function MatterGroupHead({
  group,
  tag,
  collapsed,
  onToggle
}: {
  group: MatterGroup
  tag?: MatterTagDefinition
  collapsed: boolean
  onToggle(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const Chevron = collapsed ? ChevronRight : ChevronDown
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={t('matters.groupHead.toggle')}
      className="flex h-[29px] w-full items-center gap-1.5 border-b border-ink-border bg-ink-1/80 px-3 text-left backdrop-blur-xl backdrop-saturate-150 transition-colors duration-fast hover:bg-ink-3/70"
    >
      <Chevron size={11} className="shrink-0 text-ink-fg-3" />
      {group.kind === 'tag' ? (
        <MatterTagMarker
          color={tag?.color ?? MATTER_TAG_DEFAULT_COLOR}
          shape={tag?.shape ?? MATTER_TAG_DEFAULT_SHAPE}
          size="sm"
        />
      ) : (
        <MatterGroupIcon group={group} />
      )}
      <span className="truncate text-[11.5px] font-semibold tracking-[0.01em] text-ink-fg-1">
        {matterGroupLabel(group, t)}
      </span>
      <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
        {group.matters.length}
      </span>
      <span className="flex-1" />
      {collapsed ? (
        <span className="shrink-0 text-micro text-ink-fg-3">
          {t('matters.groupHead.collapsed')}
        </span>
      ) : null}
    </button>
  )
}

/** 组头的维度符号（标签维度用 `MatterTagMarker`，不走这里）。 */
function MatterGroupIcon({ group }: { group: MatterGroup }): React.ReactElement | null {
  if (group.kind === 'status') {
    const Icon = MATTER_STATUS_GROUP_ICONS[group.statusGroup]
    const tone = MATTER_STATUS_GROUP_TONES[group.statusGroup]
    return <Icon size={11.5} className={cn('shrink-0', MATTER_GROUP_TONE_TEXT_CLASS[tone])} />
  }
  if (group.kind === 'due') {
    const Icon = MATTER_DUE_BUCKET_ICONS[group.bucket]
    const tone = MATTER_DUE_BUCKET_TONES[group.bucket]
    return <Icon size={11.5} className={cn('shrink-0', MATTER_GROUP_TONE_TEXT_CLASS[tone])} />
  }
  if (group.kind === 'priority') {
    return (
      <Flag
        size={11.5}
        className={cn('shrink-0', MATTER_TONE_TEXT_CLASS[MATTER_PRIORITY_TONES[group.priority]])}
      />
    )
  }
  if (group.kind === 'untagged') {
    return <Minus size={11.5} className="shrink-0 text-ink-fg-3" />
  }
  return null
}

/** 组名（i18n；优先级组直接用 P0–P3 这个既有的短标签，不另起一套文案）。 */
function matterGroupLabel(group: MatterGroup, t: TFunction): string {
  switch (group.kind) {
    case 'status':
      return t(`matters.statusGroup.${group.statusGroup}`)
    case 'due':
      return t(`matters.groupHead.due.${group.bucket}`)
    case 'priority':
      return group.priority.toUpperCase()
    case 'tag':
      return `#${group.tagName}`
    case 'untagged':
      return t('matters.groupHead.untagged')
    case 'all':
      return ''
  }
}

interface MatterRowProps {
  matter: Matter
  selected: boolean
  signals: ReturnType<typeof openAttentionFor>
  pendingCount: number
  narrow: boolean
  /** E10②—— 比 `narrow` 早一档触发：只让出事项编号，优先级/状态/健康度仍留在行 1。 */
  hideId: boolean
  now: number
  locale: string
  onSelect(): void
}

/**
 * 清单行（设计 `list.jsx::MatterRow`）：三行结构 —— 行 1 标题与身份 + 右端状态、
 * 行 2 下一步 / 到期 / 更新时间 / 头像组、行 3 事项类型与关注信号。
 *
 * E16（dogfood 轮 2 #16，owner 拍板偏离设计稿）—— 行 3 右下角原是最多 3 个标签 chip
 * + `+N` 溢出徽标：标签名长度不可控，行窄时一样会挤爆。改成显示单一的事项类型
 * （`matter.matter_type`，本就是个短字符串，天然没有这个溢出面）；标签仍在详情页 /
 * 筛选菜单可见，只是清单行不再是它的展示面。
 *
 * R3-#7（dogfood 轮 3 #7）—— 行 3 左右对调：类型（`matter.matter_type`）恒在，挪到左端
 * 撑住这一行；关注信号（`signals`）不是每个事项都有，挪到右端——没有异常状态时右侧空着，
 * 不会像原先「左边空着」那样显得突兀。只动布局位置，不改数据来源与显示判据。
 *
 * E12（dogfood 轮 2 #12，改判前一版）—— 选中态左条改回**通高**（`top-0 bottom-0`，与
 * `EmailRow.is-selected::before` 同一套「通高直角条」几何，ARCHITECTURE §7.3）、常态临界
 * 信号左条维持**胶囊**（`top-2 bottom-2` + 圆角，design `list.jsx::MatterRow` 的
 * `top:8/bottom:8/borderRadius:2` 原样映射）。🔴 覆盖前一批 G-04 的「维持仓库药丸签名，不照抄
 * 设计」这条裁决：`row-selected acc-select` 是**导航面**（sidebar/settings-rail/会话行）专属的
 * 胶囊签名；DESIGN.md §18.1 C4 + 2026-07-12 owner 二次 dogfood 已把 EmailRow 的选中签名改回
 * 「整行 wash + 通高左条」，本行是与 EmailRow 同构的编辑区列表行（`border-b` 逐行分割线、非导航
 * 卡片），沿用 C4 而不是 C5 才是与仓库现状一致——上一版的比对对象本身已经过期。整行 wash 走
 * `--sel-wash`（`AgentThreadList` 同款 `[background-image:var(--sel-wash)]` 写法，非虚拟化列表
 * 不用担心 EmailRow 那套 divider-in-background-image 的合并问题，`border-b` 是独立层）。
 */
function MatterRow({
  matter,
  selected,
  signals,
  pendingCount,
  narrow,
  hideId,
  now,
  locale,
  onSelect
}: MatterRowProps): React.ReactElement {
  const { t } = useTranslation()
  const trashDays = trashDaysRemaining(matter, now)
  const critical = signals.some((signal) => signal.severity === 'critical')
  const action = nextAction(matter)
  const ActionIcon = NEXT_ACTION_ICONS[action.kind]
  const HealthIcon = MATTER_HEALTH_ICONS[matter.health]
  const StatusIcon = MATTER_STATUS_ICONS[matter.status]
  const dueTone = matterDueTone(matter.due_at, now)
  const people = matter.stakeholder_summary ?? []

  const statusChip = (
    <MatterPip tone={MATTER_STATUS_TONES[matter.status]} icon={StatusIcon}>
      {t(`matters.status.${matter.status}`)}
    </MatterPip>
  )
  const priorityTag = (
    <span
      className={cn(
        // E10①（dogfood 轮 2）—— 补 whitespace-nowrap：这颗 chip 是 shrink-0，挤压的行里
        // 浏览器不会缩小它，但没有 nowrap 时文字本身会在 chip 内部折成两行（不是"消失"而是
        // "长高"），看起来就是 owner 说的「优先级 chip 换行错乱」。
        'shrink-0 whitespace-nowrap rounded-[var(--r-ctl)] border px-1.5 py-px font-mono text-[10.5px] font-semibold uppercase tracking-[0.02em]',
        MATTER_TONE_CHIP_CLASS[MATTER_PRIORITY_TONES[matter.priority]]
      )}
    >
      {matter.priority.toUpperCase()}
    </span>
  )
  const updatedAgo = (
    <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
      {formatMatterAgo(matter.updated_at, now, locale)}
    </span>
  )
  const avatars = <MatterAvatarStack people={people} total={matter.stakeholder_count ?? 0} />

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative block w-full border-b border-ink-border px-4 py-2.5 text-left transition-colors duration-fast',
        // E12 —— 选中态整行 wash（AgentThreadList 同款 `--sel-wash` 写法）；未选中保留 hover。
        selected ? '[background-image:var(--sel-wash)]' : 'hover:bg-ink-3'
      )}
    >
      {selected ? (
        // 通高直角条（同 EmailRow.is-selected::before 的几何：top-0/bottom-0，方角）。
        <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-coral/100" />
      ) : critical ? (
        // 胶囊左条（设计 `list.jsx::MatterRow` 的 `top:8/bottom:8/borderRadius:2`）。
        <span aria-hidden className="absolute left-0 top-2 bottom-2 w-[3px] rounded-sm bg-fail" />
      ) : null}
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-body font-medium text-ink-fg">{matter.title}</span>
        {/* E10②—— 编号先让位（`hideId`），优先级 chip 撑到真正的窄变体（`narrow`）才让位。 */}
        {!hideId ? (
          <span className="shrink-0 font-mono text-micro tracking-[0.02em] text-ink-fg-3">
            {matter.public_id}
          </span>
        ) : null}
        {!narrow ? priorityTag : null}
        {/* 设计 ui.jsx:29 `HealthChip bare` —— 只留 icon，同色无底无边。 */}
        <span
          title={t(`matters.health.${matter.health}`)}
          className={cn('inline-flex shrink-0', MATTER_HEALTH_TEXT_CLASS[matter.health])}
        >
          <HealthIcon size={12} strokeWidth={2.4} />
        </span>
        {pendingCount > 0 ? (
          <MatterPip tone="info" icon={Sparkles}>
            {t('matters.views.review')}
          </MatterPip>
        ) : null}
        {matter.archived_at !== null && matter.deleted_at === null ? (
          <MatterPip tone="neutral" icon={Archive}>
            {t('matters.list.archived')}
          </MatterPip>
        ) : null}
        {matter.deleted_at !== null ? (
          <MatterPip tone="critical" icon={Trash2}>
            {t('matters.list.trashDays', { count: trashDays ?? 0 })}
          </MatterPip>
        ) : null}
        <span className="flex-1" />
        {!narrow ? statusChip : null}
      </span>

      <span className="mt-1.5 flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'inline-flex min-w-0 flex-1 items-center gap-1.5 text-meta',
            action.tone === 'neutral' ? 'text-ink-fg-1' : MATTER_TONE_TEXT_CLASS[action.tone]
          )}
        >
          <ActionIcon size={12} className="shrink-0" />
          <span className="truncate">
            {action.title !== null
              ? t(`matters.nextAction.${action.kind}`, { title: action.title })
              : t(`matters.nextAction.${action.kind}`)}
          </span>
        </span>
        {matter.due_at !== null && dueTone !== null ? (
          <span
            title={new Date(matter.due_at).toLocaleDateString()}
            className={cn(
              'shrink-0 text-micro tabular-nums',
              dueTone === 'neutral' ? 'text-ink-fg-3' : MATTER_TONE_TEXT_CLASS[dueTone]
            )}
          >
            {t('matters.list.dueRelative', {
              value: formatMatterDueRelative(matter.due_at, now, locale)
            })}
          </span>
        ) : null}
        {!narrow ? (
          <>
            {updatedAgo}
            {avatars}
          </>
        ) : null}
      </span>

      {narrow ? (
        <span className="mt-1.5 flex min-w-0 items-center gap-2">
          {statusChip}
          {priorityTag}
          <span className="flex-1" />
          {updatedAgo}
          {avatars}
        </span>
      ) : null}

      {signals.length > 0 || matter.matter_type !== null ? (
        <span className={cn('mt-1.5 flex min-w-0 items-center gap-2', narrow && 'flex-wrap')}>
          {/* E16 —— 单一事项类型徽标取代原来的标签 chip 列表（本就不设上限的用户内容 =
              最容易在窄行溢出的一项，owner 拍板换成天然定长的类型）。
              R3-#7 —— 类型恒在，靠左撑住这一行；无异常状态时右侧留空即可。 */}
          {matter.matter_type !== null ? (
            <span className="max-w-[8.5rem] shrink-0 truncate rounded-full border border-ink-border-soft bg-ink-2/65 px-2 py-0.5 font-mono text-meta text-ink-fg-2">
              {matter.matter_type}
            </span>
          ) : null}
          <span className="flex-1" />
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {signals.map((signal) => {
              const SignalIcon = ATTENTION_META[signal.kind].icon
              return (
                <MatterPip key={signal.id} tone={attentionTone(signal)} icon={SignalIcon}>
                  {t(`matters.attention.kind.${signal.kind}`)}
                </MatterPip>
              )
            })}
          </span>
        </span>
      ) : null}
    </button>
  )
}

/** 设计 `ui.jsx::AvatarStack`：重叠头像 + 超出档的 `+N`。头像复用仓库既有的 `.avatar`
 *  调色板（`RecipientAvatar`）—— 同一个人在邮件列表与事项清单里必须是同一种颜色。 */
function MatterAvatarStack({
  people,
  total
}: {
  people: readonly MatterStakeholderSummary[]
  total: number
}): React.ReactElement | null {
  if (people.length === 0) return null
  const shown = people.slice(0, AVATAR_STACK_MAX)
  const rest = total - shown.length
  return (
    <span className="inline-flex shrink-0 items-center">
      {shown.map((person, index) => (
        <span
          key={person.email_normalized ?? person.display_name ?? index}
          title={person.display_name ?? person.email_normalized ?? undefined}
          className={cn('flex rounded-full ring-[1.5px] ring-ink-1', index > 0 && '-ml-1.5')}
        >
          <RecipientAvatar
            name={person.display_name ?? ''}
            email={person.email_normalized ?? ''}
            size={19}
          />
        </span>
      ))}
      {rest > 0 ? <span className="ml-1 text-micro text-ink-fg-3">+{rest}</span> : null}
    </span>
  )
}
