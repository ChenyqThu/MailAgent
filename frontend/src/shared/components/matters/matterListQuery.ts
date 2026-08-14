import {
  Archive,
  Ban,
  BarChart3,
  Briefcase,
  Calendar,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Eye,
  Flag,
  Hourglass,
  Minus,
  Play,
  Sparkles,
  Trash2,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'

import type {
  Matter,
  MatterListOptions,
  MatterPriority,
  MatterStatus
} from '@shared/api/types/matter'
import {
  compareMatterRank,
  isMatterDueSoon,
  matterDueDayDiff,
  nextAction,
  openAttentionFor
} from '@shared/lib/matterDerive'
import type { MatterAttentionIndex, MatterUpdateIndex } from '@shared/lib/matterDerive'

import type { MatterTone } from './matterVocab'

/**
 * 事项清单的查询模型（设计 v3 `list.jsx` 的 `MATTER_SCOPES` / `QUICK` / `GROUP_MODES` /
 * `SORTS` / `Q0` / `applyList` 在本仓的对应物）。V3-01/03/04/06/13 共用的单源：
 * tab / scope / 快捷条件 / 多选筛选 / 分组 / 排序 全部从这里取，别在组件里再抄一份。
 *
 * 🔴 能力边界（为什么筛选/排序是客户端的，什么时候该搬去服务端）：
 * - 列表是**服务端游标分页**的（`GET /matters`，`limit` 硬上限 100，前端只取一页）。
 *   scope 里的 archived/trash 行不在默认结果集里（服务端默认子句
 *   `deleted_at IS NULL AND archived_at IS NULL`），**必须**用 `view` 参数取回 ——
 *   见 `matterScopeParams`。这正是修「已归档/回收站恒为空」既存 bug 的落点。
 * - open/done 的差别是 status 集合（NOT IN / IN {done,canceled}），而服务端 `status`
 *   是**单值**过滤，表达不了双值集合 ⇒ 只能在取回的活跃行上客户端分割。
 * - 快捷条件 / 状态组 / 优先级 / 标签多选（类别间 AND、标签间 OR）服务端一概没有
 *   对应参数；排序四档里只有「最近更新」有服务端等价物（`sort=updated_at`），
 *   关注度 / 到期 / 优先级都是客户端派生序。
 * ⇒ 以上全部在**当前一页（≤100 行）**上运算。事项量超过一页时，筛掉的行可能根本
 * 没被取回来 —— 这是已知的能力边界，不是 bug。服务端将来长出多值 status / 分面
 * 计数 / 派生排序参数时，这个文件的谓词应该整体搬成请求参数（保持形状不变即可）。
 */

// ── tab / scope / 快捷条件 词表 ─────────────────────────────────────────────

export const MATTER_TABS = ['list', 'board'] as const
export type MatterTab = (typeof MATTER_TABS)[number]

/** 设计 `list.jsx::MATTER_SCOPES`：把「已完成 / 已归档 / 回收站」从左轨视图降级为范围。 */
export const MATTER_SCOPES = ['open', 'done', 'archived', 'trash'] as const
export type MatterScope = (typeof MATTER_SCOPES)[number]

/** 设计 `list.jsx::QUICK`：可叠加的临时筛选，不是导航入口。 */
export const MATTER_QUICK_FILTERS = ['attn', 'waiting', 'due', 'p01', 'proposal', 'nonext'] as const
export type MatterQuickFilter = (typeof MATTER_QUICK_FILTERS)[number]

/** 设计 `list.jsx::STATUS_GROUPS` 的六个语义组（状态二级面板按组多选，不是按 8 档原始状态）。 */
export const MATTER_STATUS_GROUPS = [
  'needyou',
  'waiting',
  'blocked',
  'monitoring',
  'planned',
  'closed'
] as const
export type MatterStatusGroup = (typeof MATTER_STATUS_GROUPS)[number]

export const MATTER_STATUS_GROUP_MEMBERS: Record<MatterStatusGroup, readonly MatterStatus[]> = {
  needyou: ['inbox', 'active'],
  waiting: ['waiting'],
  blocked: ['blocked'],
  monitoring: ['monitoring'],
  planned: ['planned'],
  closed: ['done', 'canceled']
}

export const MATTER_GROUP_MODES = ['status', 'due', 'priority', 'tag', 'none'] as const
export type MatterGroupMode = (typeof MATTER_GROUP_MODES)[number]

/** 设计 `list.jsx::groupsFor` 的到期档（over / now / week / later / none 的等价物，
 *  `now` 改叫 `soon` —— 这里的语义是「今天 / 明天」，`now` 会和「此刻」混淆）。 */
export const MATTER_DUE_BUCKETS = ['overdue', 'soon', 'week', 'later', 'none'] as const
export type MatterDueBucket = (typeof MATTER_DUE_BUCKETS)[number]

/** 优先级全档（设计 `groupsFor('priority')` 的 `['p0','p1','p2','p3']`）。设计还给了「未设
 *  优先级」一档，本仓 `Matter.priority` 是**非空**的 `MatterPriority` —— 那一档在类型层就
 *  取不到值，故不造一个恒空的组。 */
export const MATTER_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const

export const MATTER_SORTS = ['rank', 'updated', 'due', 'priority'] as const
export type MatterSortKey = (typeof MATTER_SORTS)[number]
export type MatterSortDir = 'default' | 'reverse'

/** 设计 `list.jsx::Q0`。分组/排序即使还没有渲染消费者也进模型 —— chips 行的 mono 摘要
 *  （V3-09）与筛选菜单（V3-06）都要读写它们。 */
export interface MatterListQuery {
  scope: MatterScope
  quick: readonly MatterQuickFilter[]
  statusGroups: readonly MatterStatusGroup[]
  priorities: readonly MatterPriority[]
  tags: readonly string[]
  group: MatterGroupMode
  sort: MatterSortKey
  dir: MatterSortDir
}

export const DEFAULT_MATTER_LIST_QUERY: MatterListQuery = {
  scope: 'open',
  quick: [],
  statusGroups: [],
  priorities: [],
  tags: [],
  group: 'status',
  sort: 'rank',
  dir: 'default'
}

// ── 图标表（闸：tests/components/matters/matterDesignIcons.test.ts）──────────

/** 设计 `list.jsx::ModuleTabs` 的两个 tab。 */
export const MATTER_TAB_ICONS: Record<MatterTab, LucideIcon> = {
  list: Briefcase, // briefcase
  board: BarChart3 // barchart
}

/** 设计 `list.jsx::MATTER_SCOPES[*].icon`。 */
export const MATTER_SCOPE_ICONS: Record<MatterScope, LucideIcon> = {
  open: Briefcase, // briefcase
  done: CheckCircle2, // checkcircle
  archived: Archive, // archive
  trash: Trash2 // trash
}

/** 设计 `list.jsx::QUICK[*].icon`。 */
export const MATTER_QUICK_FILTER_ICONS: Record<MatterQuickFilter, LucideIcon> = {
  attn: TriangleAlert, // alert
  waiting: Hourglass, // hourglass
  due: Clock3, // clock
  p01: Flag, // flag
  proposal: Sparkles, // sparkles
  nonext: CircleHelp // helpcircle
}

/** 设计 `list.jsx::QUICK[*].tone`（chips 行与菜单行共用）。 */
export const MATTER_QUICK_FILTER_TONES: Record<MatterQuickFilter, MatterTone> = {
  attn: 'critical',
  waiting: 'warn',
  due: 'warn',
  p01: 'critical',
  proposal: 'info',
  nonext: 'warn'
}

/** 设计 `list.jsx::STATUS_GROUPS[*].icon`（组头图标，与 8 档原始状态的 `MATTER_STATUS_ICONS`
 *  是两张表：这里是六个**语义组**）。 */
export const MATTER_STATUS_GROUP_ICONS: Record<MatterStatusGroup, LucideIcon> = {
  needyou: Play, // play
  waiting: Hourglass, // hourglass
  blocked: Ban, // ban
  monitoring: Eye, // eye
  planned: Calendar, // calendar
  closed: CheckCircle2 // checkcircle
}

/** 组头的语气色。`accent` 是 `MatterTone` 之外的第六档（设计 H3§2 表里「需要你推进」那一行
 *  写的就是 accent），只在组头用得到，故不去污染共用的 `MatterTone` 值域。 */
export type MatterGroupTone = MatterTone | 'accent'

/** 设计 `list.jsx::STATUS_GROUPS[*].tone` / H3§2 的「语气色」列。 */
export const MATTER_STATUS_GROUP_TONES: Record<MatterStatusGroup, MatterGroupTone> = {
  needyou: 'accent',
  waiting: 'warn',
  blocked: 'critical',
  monitoring: 'info',
  planned: 'info',
  closed: 'neutral'
}

/** 设计 `list.jsx::groupsFor` 到期档的 icon（alert / clock / calendar / calendar / minus）。 */
export const MATTER_DUE_BUCKET_ICONS: Record<MatterDueBucket, LucideIcon> = {
  overdue: TriangleAlert, // alert
  soon: Clock3, // clock
  week: Calendar, // calendar
  later: Calendar, // calendar
  none: Minus // minus
}

export const MATTER_DUE_BUCKET_TONES: Record<MatterDueBucket, MatterGroupTone> = {
  overdue: 'critical',
  soon: 'warn',
  week: 'info',
  later: 'neutral',
  none: 'neutral'
}

// ── scope：服务端参数映射 + 客户端谓词 ──────────────────────────────────────

/**
 * scope → `GET /matters` 请求参数（V3-03 的核心：archived/trash **必须**来自服务端）。
 *
 * 服务端语义（`src/matters/repository.py::list_matters:230-240`，已读实现核对）：
 * - 无参数（open/done 共用）→ `deleted_at IS NULL AND archived_at IS NULL`（活跃行）；
 * - `view='archived'` → `deleted_at IS NULL AND archived_at IS NOT NULL`；
 * - `view='trash'` → `deleted_at IS NOT NULL`（**不再**排除 archived —— 回收站压过归档）；
 * - `archived`/`deleted` 两个布尔参数与 `view` 是同一组子句的两种拼法（`deleted=true` ≙
 *   `view='trash'`、`archived=true` ≙ `view='archived'`；`false` 与缺省同义），这里
 *   统一走 `view` 一个口，避免两种拼法混用。
 * open/done 之间的 status 分割只能客户端做（见文件头「能力边界」）。
 */
export function matterScopeParams(scope: MatterScope): Pick<MatterListOptions, 'view'> {
  if (scope === 'archived') return { view: 'archived' }
  if (scope === 'trash') return { view: 'trash' }
  return {}
}

/** scope 归属判定的可用最小字段（`MatterDuplicateCandidate.matter` 这类投影没有
 *  archived/deleted 列 —— 缺键按 null 即「活跃」处理）。 */
export interface MatterScopeFields {
  status: MatterStatus
  archived_at?: number | null
  deleted_at?: number | null
}

/** 一行属于哪个 scope（与上面服务端子句同一优先序：trash > archived > done > open）。 */
export function matterScopeOf(matter: MatterScopeFields): MatterScope {
  if ((matter.deleted_at ?? null) !== null) return 'trash'
  if ((matter.archived_at ?? null) !== null) return 'archived'
  if (matter.status === 'done' || matter.status === 'canceled') return 'done'
  return 'open'
}

export function matterInScope(matter: MatterScopeFields, scope: MatterScope): boolean {
  return matterScopeOf(matter) === scope
}

// ── 快捷条件谓词 ───────────────────────────────────────────────────────────

export interface MatterQueryContext {
  attention?: MatterAttentionIndex
  updates?: MatterUpdateIndex
  now: number
}

export function matterQuickFilterTest(
  matter: Matter,
  key: MatterQuickFilter,
  context: MatterQueryContext
): boolean {
  switch (key) {
    case 'attn':
      return openAttentionFor(matter, context.attention).length > 0
    case 'waiting':
      // 设计 `QUICK.waiting` 判 `m.status==='waiting' || items 里有 waiting 条目`；
      // 清单行没有 items，条目那一半吃服务端 `next_action` 投影（nextAction 的既有回退链）。
      return matter.status === 'waiting' || nextAction(matter).kind === 'waiting'
    case 'due':
      // V3-15 —— 单源判据在 `matterDerive.ts::isMatterDueSoon`（7 天内到期含逾期），看板
      // tile 计数与「临近到期」列表走同一个函数，不在这里另算一份窗口。
      return isMatterDueSoon(matter, context.now)
    case 'p01':
      return matter.priority === 'p0' || matter.priority === 'p1'
    case 'proposal':
      return (context.updates?.get(matter.public_id) ?? []).some(
        (update) => update.review_status === 'pending'
      )
    case 'nonext':
      // 🔴 按 kind 判、不按 icon/文案（matterDerive.ts:106 红旗：健康率曾靠字符串匹配
      // 「缺少下一步」，文案一改指标静默失效）。
      return nextAction(matter).kind === 'missing'
  }
}

// ── 排序与应用 ─────────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<MatterPriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

function sortComparator(
  query: MatterListQuery,
  context: MatterQueryContext
): (left: Matter, right: Matter) => number {
  // 「关注度」是唯一有既有单源的序（compareMatterRank）；其余三档按设计 `SORTS` 的
  // metric 客户端派生 —— 服务端 sort 只有 updated_at|created_at 两档（见文件头）。
  const base = (left: Matter, right: Matter): number => {
    switch (query.sort) {
      case 'rank':
        return compareMatterRank(left, right, context.attention)
      case 'updated':
        return right.updated_at - left.updated_at
      case 'due': {
        const l = left.due_at ?? Number.MAX_SAFE_INTEGER
        const r = right.due_at ?? Number.MAX_SAFE_INTEGER
        return l - r || right.updated_at - left.updated_at
      }
      case 'priority':
        return (
          PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
          right.updated_at - left.updated_at
        )
    }
  }
  // 设计 `applyList`：reverse 翻转整个比较器（sign * metric 差）。
  return query.dir === 'reverse' ? (left, right) => -base(left, right) : base
}

function matchesSearch(matter: Matter, query: string): boolean {
  return [
    matter.title,
    matter.public_id,
    matter.description,
    matter.current_summary ?? '',
    ...matter.tags
  ]
    .join('\n')
    .toLocaleLowerCase()
    .includes(query)
}

export function activeMatterFilterCount(query: MatterListQuery): number {
  return query.quick.length + query.statusGroups.length + query.priorities.length + query.tags.length
}

/**
 * 列表可见集合（设计 `list.jsx::applyList`）—— 清单渲染与详情页上下条导航共用同一份，
 * 保证顺序一致。多条件之间 AND；同类多选（状态组 / 优先级 / 标签）内部 OR。
 *
 * scope 谓词对服务端已圈定的 archived/trash 行集是幂等复核；对 open/done 是真正的
 * 客户端分割（服务端表达不了，见文件头「能力边界」）。
 */
export function applyMatterListQuery(
  matters: readonly Matter[],
  query: MatterListQuery,
  search: string,
  context: MatterQueryContext
): Matter[] {
  let rows = matters.filter((matter) => matterInScope(matter, query.scope))
  for (const key of query.quick) {
    rows = rows.filter((matter) => matterQuickFilterTest(matter, key, context))
  }
  if (query.statusGroups.length > 0) {
    rows = rows.filter((matter) =>
      query.statusGroups.some((group) => MATTER_STATUS_GROUP_MEMBERS[group].includes(matter.status))
    )
  }
  if (query.priorities.length > 0) {
    rows = rows.filter((matter) => query.priorities.includes(matter.priority))
  }
  if (query.tags.length > 0) {
    rows = rows.filter((matter) => query.tags.some((tag) => matter.tags.includes(tag)))
  }
  const normalized = search.trim().toLocaleLowerCase()
  if (normalized) rows = rows.filter((matter) => matchesSearch(matter, normalized))
  return [...rows].sort(sortComparator(query, context))
}

// ── 行内分组（设计 `list.jsx::groupsFor`，规格 H3§2）──────────────────────────

/** 「本周内」的上界（设计 `groupsFor('due')` 的 `d <= 7`）。与快捷条件吃的
 *  `matterDerive.MATTER_DUE_SOON_WINDOW_DAYS` 数值相同但语义不同（那个是**含逾期**的筛选
 *  窗口，这个是分档上界），故不共用一个常量：改其中一个不该悄悄改另一个。 */
const GROUP_DUE_WEEK_DAYS = 7

/** 设计 `groupsFor('due')::bucket`：无 dueAt → none；<0 逾期；≤1 今天/明天；≤7 本周内；其余更晚。 */
export function matterDueBucket(matter: Matter, now: number): MatterDueBucket {
  if (matter.due_at == null) return 'none'
  const days = matterDueDayDiff(matter.due_at, now)
  if (days < 0) return 'overdue'
  if (days <= 1) return 'soon'
  if (days <= GROUP_DUE_WEEK_DAYS) return 'week'
  return 'later'
}

/**
 * 一个分组。`key` 同时是 React key 与折叠态的键，各维度带前缀命名空间 —— 标签名可以叫
 * 「waiting」，不带前缀就会和语义状态组的 key 撞。
 */
export type MatterGroup =
  | { key: 'all'; kind: 'all'; matters: readonly Matter[] }
  | { key: string; kind: 'status'; statusGroup: MatterStatusGroup; matters: readonly Matter[] }
  | { key: string; kind: 'due'; bucket: MatterDueBucket; matters: readonly Matter[] }
  | { key: string; kind: 'priority'; priority: MatterPriority; matters: readonly Matter[] }
  | { key: string; kind: 'tag'; tagName: string; matters: readonly Matter[] }
  | { key: 'untagged'; kind: 'untagged'; matters: readonly Matter[] }

/**
 * 行内分组（设计 `list.jsx::groupsFor`）—— 输入必须是 `applyMatterListQuery` 的产物：
 * 组内顺序原样沿用传入的序，分组只重排「哪些行挨在一起」。**空组不产出**（H3§2）。
 *
 * 🔴 标签维度下同一事项会出现在**多个组**里（H3§2 明写「一个事项可出现在多组」），
 * 于是「组数之和 ≠ 命中数」、且 `public_id` 在整个视觉序里会重复 —— 渲染侧的 React key
 * 必须带组前缀，导航序必须去重（`orderedMatterIds`）。
 *
 * 不吃 `MatterTagDefinition`：分组只需要事项自己带的标签名，定义表（颜色/形状）是渲染侧
 * 的事。少一个入参 = 清单与详情导航两处调用不可能因为标签定义加载时机不同而算出两种序。
 */
export function groupMatters(
  matters: readonly Matter[],
  mode: MatterGroupMode,
  now: number
): MatterGroup[] {
  if (mode === 'none') {
    return matters.length > 0 ? [{ key: 'all', kind: 'all', matters }] : []
  }
  if (mode === 'status') {
    return MATTER_STATUS_GROUPS.map(
      (statusGroup): MatterGroup => ({
        key: `status:${statusGroup}`,
        kind: 'status',
        statusGroup,
        matters: matters.filter((matter) =>
          MATTER_STATUS_GROUP_MEMBERS[statusGroup].includes(matter.status)
        )
      })
    ).filter((group) => group.matters.length > 0)
  }
  if (mode === 'due') {
    return MATTER_DUE_BUCKETS.map(
      (bucket): MatterGroup => ({
        key: `due:${bucket}`,
        kind: 'due',
        bucket,
        matters: matters.filter((matter) => matterDueBucket(matter, now) === bucket)
      })
    ).filter((group) => group.matters.length > 0)
  }
  if (mode === 'priority') {
    return MATTER_PRIORITIES.map(
      (priority): MatterGroup => ({
        key: `priority:${priority}`,
        kind: 'priority',
        priority,
        matters: matters.filter((matter) => matter.priority === priority)
      })
    ).filter((group) => group.matters.length > 0)
  }
  // tag —— 组的顺序 = 标签名在（已排好序的）列表里首次出现的顺序，「无标签」殿后。
  const names: string[] = []
  for (const matter of matters) {
    for (const name of matter.tags) if (!names.includes(name)) names.push(name)
  }
  const groups: MatterGroup[] = names.map((tagName) => ({
    key: `tag:${tagName}`,
    kind: 'tag',
    tagName,
    matters: matters.filter((matter) => matter.tags.includes(tagName))
  }))
  const untagged = matters.filter((matter) => matter.tags.length === 0)
  if (untagged.length > 0) groups.push({ key: 'untagged', kind: 'untagged', matters: untagged })
  return groups
}

/**
 * 分组后的视觉顺序（详情页上/下条导航吃这一份 —— 分组会重排视觉序，导航还按扁平序走的话
 * 「下一条」会跳到屏幕上别处）。
 *
 * 🔴 按首次出现**去重**：标签维度下同一事项在多个组里各出现一次，而 `MatterDetail` 用
 * `navigationMatterIds.indexOf(matterId)` 定位当前条 —— 重复 id 会让 indexOf 恒返回第一份，
 * 「第 n / N 条」计数虚高、从第二份往下翻会原地跳回第一份的下一条。
 */
export function orderedMatterIds(groups: readonly MatterGroup[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const group of groups) {
    for (const matter of group.matters) {
      if (seen.has(matter.public_id)) continue
      seen.add(matter.public_id)
      ids.push(matter.public_id)
    }
  }
  return ids
}
