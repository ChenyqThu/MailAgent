// 通讯录列表的行模型（虚拟滚动契约：rows + O(1) 行高，参照 useEmailListRows）。
// 分组在前端做（后端一条聚合 SQL 已给齐行字段，设计 §7 性能铁律）。
//
// 规则（设计 §2.1）：
// - 「往来的人」：不分组（默认）或按 公司/部门/职能/职级 分组 —— 组按组内人数降序，
//   `未分组` 恒末尾；组头可折叠。
// - 「全部」：kind 分组折叠段（人 / 机器人·noreply / 群发列表 / 已隐藏，默认只展开
//   「人」）+ 顶部筛选 chips；开启属性分组后取代 kind 分组，chips 仍生效。
// - 「我」（task 08-14 WP-3 引入，WP-6 B 收窄）：单独成一组恒置顶，**只在「全部」
//   视图**（「往来的人」里自己不是往来对象，后端已排除）。任何分组档都先摘出去，
//   剩下的走上面的原有逻辑 —— 没有 self 行时输出与该改动前逐字相同。

import type { ContactRowDto, ContactSort, ContactView } from '@shared/api/types/contact'

export type ContactGroupBy = 'none' | 'company' | 'dept' | 'fn' | 'level' | 'manager'
export type ContactDensity = 'compact' | 'comfortable'
export type ContactKindBucket = 'person' | 'robot' | 'list' | 'hidden'

// 三个显示档位的**运行时**清单。菜单渲染（`ContactListPane`）与持久化时的野值校验
// （`contactListPrefs`）读同一份 —— 同一组字面量抄成两处，加一档就会漏一处
// （新档位存进 localStorage 后被校验判成野值、每次回来都被打回默认）。
export const CONTACT_SORTS: readonly ContactSort[] = ['density', 'recent', 'name']
export const CONTACT_GROUP_BYS: readonly ContactGroupBy[] = [
  'none',
  'company',
  'dept',
  'fn',
  'level',
  'manager'
]
export const CONTACT_DENSITIES: readonly ContactDensity[] = ['compact', 'comfortable']

export const CONTACT_ROW_HEIGHT_COMPACT = 52
export const CONTACT_ROW_HEIGHT_COMFORTABLE = 68
export const CONTACT_GROUP_HEADER_HEIGHT = 34

export type ContactListRow =
  | {
      type: 'header'
      key: string
      label: string
      count: number
      collapsed: boolean
    }
  | { type: 'contact'; key: string; item: ContactRowDto }

export function kindBucketOf(item: ContactRowDto): ContactKindBucket {
  if (item.hidden_at != null) return 'hidden'
  if (item.kind === 'robot') return 'robot'
  if (item.kind === 'list') return 'list'
  return 'person'
}

/** 置顶「我」组的组 key（不与 `kind:` / `org:` 等前缀撞车）。 */
export const SELF_GROUP_KEY = 'self'

/** kind 分组段的默认折叠态：打开「全部」通常是找回被判错的地址，噪音段先折起。 */
function defaultCollapsed(groupKey: string): boolean {
  return groupKey === 'kind:robot' || groupKey === 'kind:list' || groupKey === 'kind:hidden'
}

export function isGroupCollapsed(
  collapsed: Readonly<Record<string, boolean>>,
  groupKey: string
): boolean {
  return collapsed[groupKey] ?? defaultCollapsed(groupKey)
}

interface BuildOptions {
  items: readonly ContactRowDto[]
  view: ContactView
  groupBy: ContactGroupBy
  /** 「全部」视图的筛选 chips（人/机器人/群发列表/已隐藏）。 */
  kindFilter: ReadonlySet<ContactKindBucket>
  collapsed: Readonly<Record<string, boolean>>
  /** i18n 标签解析（组件侧闭包 t；模型层不 import i18n）。
   *  `ungrouped` 由调用方按 groupBy 分支注入（manager 档 = 「未设上级」
   *  `contacts.group.noManager`，其余 = `contacts.groupBy.ungrouped`）。 */
  labels: {
    kindGroup: (bucket: ContactKindBucket) => string
    fn: (value: string) => string
    level: (value: string) => string
    /** 置顶的「我」组标签（`contacts.group.self`）。 */
    self: string
    /** 按汇报线的组 label（`contacts.group.reportsOf` 插值行上的
     *  manager_display_name；无名上级照原型 `m.name || m.id` 用 id 兜底）。 */
    manager: (item: ContactRowDto) => string
    ungrouped: string
  }
}

function attributeGroupOf(
  item: ContactRowDto,
  groupBy: ContactGroupBy,
  labels: BuildOptions['labels']
): { key: string; label: string } | null {
  switch (groupBy) {
    case 'company':
      return item.organization
        ? { key: `org:${item.organization}`, label: item.organization }
        : null
    case 'dept': {
      // 部门是**路径**（`EBG / ENBU / 产品部`）→ 一级分组只看第一段，否则每条支线各成一组、
      // 组多到没法扫。老数据没有 ` / ` 时第一段 = 整串，与改造前逐字一致（自然兼容）。
      // 第一段为空（`  / ENBU` 这种脏值）视同未分组 —— 画一个空标题的组更糟。
      const top = (item.department ?? '').split('/')[0]?.trim() ?? ''
      return top === '' ? null : { key: `dept:${top}`, label: top }
    }
    case 'fn':
      return item.function ? { key: `fn:${item.function}`, label: labels.fn(item.function) } : null
    case 'level':
      return item.seniority
        ? { key: `level:${item.seniority}`, label: labels.level(item.seniority) }
        : null
    case 'manager':
      // 按汇报线（WP5）：组 key = 上级 id；未设上级走 ungrouped 通道（恒末尾，
      // label 由调用方特判成「未设上级」）。
      return item.manager_contact_id != null
        ? { key: `mgr:${item.manager_contact_id}`, label: labels.manager(item) }
        : null
    default:
      return null
  }
}

function groupedRows(
  items: readonly ContactRowDto[],
  groupBy: ContactGroupBy,
  collapsed: Readonly<Record<string, boolean>>,
  labels: BuildOptions['labels']
): ContactListRow[] {
  const groups = new Map<string, { label: string; members: ContactRowDto[] }>()
  const ungrouped: ContactRowDto[] = []
  for (const item of items) {
    const group = attributeGroupOf(item, groupBy, labels)
    if (group === null) {
      ungrouped.push(item)
      continue
    }
    const bucket = groups.get(group.key) ?? { label: group.label, members: [] }
    bucket.members.push(item)
    groups.set(group.key, bucket)
  }
  // dept 档：一级组里混着多条支线（`EBG / ENBU / 产品部` 与 `EBG / 财务`），组内先按
  // department 完整路径排，同支线的人才会挨在一起。同路径的相对次序 = 入参次序（当前 sort），
  // 靠 Array#sort 的稳定性保住 —— 不必也不该在 comparator 里再比一次。
  // 🔴 只在 dept 档生效：其余分组档的组内次序（= 当前 sort）一动不动。
  if (groupBy === 'dept') {
    for (const bucket of groups.values()) {
      bucket.members.sort((a, b) => (a.department ?? '').localeCompare(b.department ?? '', 'zh'))
    }
  }
  // 组内人数降序；`未分组` 恒末尾。
  const ordered = [...groups.entries()].sort((a, b) => b[1].members.length - a[1].members.length)
  const rows: ContactListRow[] = []
  const push = (key: string, label: string, members: ContactRowDto[]): void => {
    const isCollapsed = isGroupCollapsed(collapsed, key)
    rows.push({ type: 'header', key, label, count: members.length, collapsed: isCollapsed })
    if (!isCollapsed) {
      for (const item of members) rows.push({ type: 'contact', key: `c:${item.id}`, item })
    }
  }
  for (const [key, bucket] of ordered) push(key, bucket.label, bucket.members)
  if (ungrouped.length > 0) push('ungrouped', labels.ungrouped, ungrouped)
  return rows
}

export function buildContactRows(options: BuildOptions): ContactListRow[] {
  const { items, view, groupBy, kindFilter, collapsed, labels } = options
  // 「全部」视图的 chips 先过滤（「我」也照 chips 走：它落在 person / hidden 桶里，
  // 关掉那个 chip 就该一起消失）。
  const base = view === 'known' ? items : items.filter((item) => kindFilter.has(kindBucketOf(item)))
  // 置顶「我」组只在「全部」视图（WP-6 B）：「往来的人」里自己不是往来对象，后端
  // 已把 is_self 排除；这里不摘组 ⇒ known 分支输出与 WP-3 之前逐字相同。
  const selfItems = view === 'all' ? base.filter((item) => item.is_self) : []
  const rest = selfItems.length > 0 ? base.filter((item) => !item.is_self) : base
  const pinned: ContactListRow[] = []
  if (selfItems.length > 0) {
    const isCollapsed = isGroupCollapsed(collapsed, SELF_GROUP_KEY)
    pinned.push({
      type: 'header',
      key: SELF_GROUP_KEY,
      label: labels.self,
      count: selfItems.length,
      collapsed: isCollapsed
    })
    if (!isCollapsed) {
      for (const item of selfItems) pinned.push({ type: 'contact', key: `c:${item.id}`, item })
    }
  }
  if (view === 'known') {
    if (groupBy === 'none') {
      const flat: ContactListRow[] = rest.map((item) => ({
        type: 'contact',
        key: `c:${item.id}`,
        item
      }))
      return [...pinned, ...flat]
    }
    return [...pinned, ...groupedRows(rest, groupBy, collapsed, labels)]
  }
  const filtered = rest
  if (groupBy !== 'none') return [...pinned, ...groupedRows(filtered, groupBy, collapsed, labels)]
  const buckets: ContactKindBucket[] = ['person', 'robot', 'list', 'hidden']
  const rows: ContactListRow[] = [...pinned]
  for (const bucket of buckets) {
    if (!kindFilter.has(bucket)) continue
    const members = filtered.filter((item) => kindBucketOf(item) === bucket)
    if (members.length === 0) continue
    const key = `kind:${bucket}`
    const isCollapsed = isGroupCollapsed(collapsed, key)
    rows.push({
      type: 'header',
      key,
      label: labels.kindGroup(bucket),
      count: members.length,
      collapsed: isCollapsed
    })
    if (!isCollapsed) {
      for (const item of members) rows.push({ type: 'contact', key: `c:${item.id}`, item })
    }
  }
  return rows
}

/** 联系人行在某个密度档下的高度。骨架屏要按可视高度算行数，手头没有 `row` 却仍需要这个
 *  数 —— 🔴 那种场景**不能**用下面的 `rowHeightFor(undefined, density)`：`undefined` 分支是
 *  「行还没取到」的兜底，恒回 compact，会把 comfortable 档的骨架画成 52 高然后跳版。 */
export function contactRowHeight(density: ContactDensity): number {
  return density === 'comfortable' ? CONTACT_ROW_HEIGHT_COMFORTABLE : CONTACT_ROW_HEIGHT_COMPACT
}

export function rowHeightFor(row: ContactListRow | undefined, density: ContactDensity): number {
  if (!row) return CONTACT_ROW_HEIGHT_COMPACT
  if (row.type === 'header') return CONTACT_GROUP_HEADER_HEIGHT
  return contactRowHeight(density)
}

/** 键盘 j/k 走的有序 id（跳过组头与折叠段）。 */
export function orderedContactIds(rows: readonly ContactListRow[]): number[] {
  const ids: number[] = []
  for (const row of rows) if (row.type === 'contact') ids.push(row.item.id)
  return ids
}

/** keyset 续拉的触发判据：渲染到 ~70% 或距底 8 行（取更早的那个）就该取下一页。
 *  阈值照 `useEmailListRows.handleRowsRendered`，两处列表同一手感。
 *
 *  🔴 单拎成纯函数是为了能测：挂在 react-window 的 `onRowsRendered` 上就只能靠真实布局
 *  测量触发，而 happy-dom 里行高恒 0 —— 那种测法要么恒绿要么恒红，两样都不说明问题。 */
export function shouldFetchNextContactPage(stopIndex: number, rowCount: number): boolean {
  if (rowCount <= 0) return false
  return stopIndex >= Math.min(Math.floor(rowCount * 0.7), rowCount - 8)
}
