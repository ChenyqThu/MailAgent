import {
  Archive,
  BarChart3,
  Briefcase,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Flag,
  Hourglass,
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
import { compareMatterRank, nextAction, openAttentionFor } from '@shared/lib/matterDerive'
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

const DAY = 86_400_000
/** 设计 H3§3：「有到期 / 逾期」= dueAt 存在且整日差 ≤ 7（**含**逾期的负值）。 */
const QUICK_DUE_WINDOW_DAYS = 7

function startOfDay(value: number): number {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 按自然日取整的到期差（与 `matterVocab.matterDueTone` 同口径）。 */
export function matterDueDayDiff(dueAt: number, now: number): number {
  return Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY)
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
      return (
        matter.due_at != null &&
        matterDueDayDiff(matter.due_at, context.now) <= QUICK_DUE_WINDOW_DAYS
      )
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
