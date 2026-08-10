// Sprint 10 user-acceptance follow-up — shared filter state for the
// EmailList. Sprint 12 extends with multi-select (priority + category) +
// Focused/Other tab, both persisted to localStorage so the user's view
// preferences survive reloads.
//
// 2026-08 筛选/排序菜单重做（Outlook 结构）——「状态」单选 chip
// (all|unread|flagged|failed) 退役，换成五条**互相独立**的二值筛选轴：
//   unread · flagMark('flagged'|'done') · toMe · hasAttach · failed
// 它们与 priority/category 一样按 AND 组合。单选 chip 的老形状表达不了
// 「未读 且 有附件」这种最普通的诉求，而 Outlook 的筛选菜单本来就是多轴的。
// flagMark 是三档里的二选一（已标记 / 已完成互斥），因为一封邮件的旗标本身
// 就是三态之一（无 → 已标记 → 已完成），"既已标记又已完成" 无意义。
//
// 持久化边界（沿用旧口径，别扩大）：
//   持久化 = tab · priorities · categories · 排序键/方向
//   会话级 = 五条二值轴（老 chip 也从不持久化：开着 "同步失败" 重启一次
//            就永远看不到新邮件，是 bug 不是特性）
//
// Composition rule used by EmailList:
//   final = view × tab(focused|other) × 五条二值轴 × prioritySet × categorySet
//   order = sortKey × sortDir（下沉 SQL，见 @shared/lib/emailSort）

import { create } from 'zustand'

import type { AIPriority } from '@shared/api/types'
import {
  DEFAULT_SORT_DIR,
  DEFAULT_SORT_KEY,
  normalizeSortDir,
  normalizeSortKey,
  type EmailSortDir,
  type EmailSortKey
} from '@shared/lib/emailSort'

const KEY_TAB = 'mailagent.emailList.tab'
const KEY_PRI = 'mailagent.emailList.priorities'
// v2: Sprint 12.6 — switched EmailCategory from the synthetic 5-bucket
// (alert/project/...) to the LLM's real 7-element CATEGORY_ENUM. Bumping
// the key avoids resurrecting stale 5-bucket selections (which would
// silently produce an empty filter set and hide all emails).
const KEY_CAT = 'mailagent.emailList.categories.v2'
// v1 后缀沿用 categories.v2 的先例：形状（{key,dir} 对象）一旦要改，换 key 比
// 写一层向后兼容解析便宜，且不会让旧值静默解析成一个合法但错误的排序。
const KEY_SORT = 'mailagent.emailList.sort.v1'

export type EmailView = 'inbox' | 'outbox' | 'drafts' | 'flagged' | 'all'
export type InboxTab = 'focused' | 'other'
/** 旗标筛选的两档（互斥单选，再点一次取消 → null）。 */
export type FlagMark = 'flagged' | 'done'

/** Email category — the verbatim LLM CATEGORY_ENUM string (see
 *  src/llm_agent/schema.py). Stored as the emoji-prefixed Chinese label so
 *  the filter popover and the row payload can be matched by literal `===`.
 *  An additional `null` bucket covers emails without any LLM run yet. */
export type EmailCategory =
  | '💼 产品管理'
  | '🤝 会议通知'
  | '🛠️ 技术讨论'
  | '👥 团队协作'
  | '📊 项目管理'
  | '🔔 系统通知'
  | '🌐 外部沟通'
export const ALL_PRIORITIES: ReadonlyArray<AIPriority> = [
  'critical',
  'urgent',
  'important',
  'normal',
  'low'
]
export const ALL_CATEGORIES: ReadonlyArray<EmailCategory> = [
  '💼 产品管理',
  '🤝 会议通知',
  '🛠️ 技术讨论',
  '👥 团队协作',
  '📊 项目管理',
  '🔔 系统通知',
  '🌐 外部沟通'
]

/** 五条二值筛选轴的可切换项 id —— 菜单行与快捷键共用一套 key。 */
export type BoolFilterKey = 'unread' | 'toMe' | 'hasAttach' | 'failed'

/** 传给 emailListRows.applyAxisFilters 的纯值快照（无 store 依赖，可单测）。 */
export interface FilterAxes {
  unread: boolean
  flagMark: FlagMark | null
  toMe: boolean
  hasAttach: boolean
  failed: boolean
}

export const NO_FILTER_AXES: FilterAxes = {
  unread: false,
  flagMark: null,
  toMe: false,
  hasAttach: false,
  failed: false
}

function readSet<T extends string>(key: string, defaults: ReadonlyArray<T>): Set<T> {
  if (typeof window === 'undefined') return new Set(defaults)
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return new Set(defaults)
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set(defaults)
    return new Set(arr.filter((v): v is T => defaults.includes(v as T)))
  } catch {
    return new Set(defaults)
  }
}

function writeSet<T extends string>(key: string, set: ReadonlySet<T>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(set.values())))
  } catch {
    /* ignore */
  }
}

function readTab(): InboxTab {
  if (typeof window === 'undefined') return 'focused'
  try {
    const v = window.localStorage.getItem(KEY_TAB)
    return v === 'other' ? 'other' : 'focused'
  } catch {
    return 'focused'
  }
}
function writeTab(tab: InboxTab): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY_TAB, tab)
  } catch {
    /* ignore */
  }
}

interface SortState {
  sortKey: EmailSortKey
  sortDir: EmailSortDir
}

function readSort(): SortState {
  const fallback: SortState = { sortKey: DEFAULT_SORT_KEY, sortDir: DEFAULT_SORT_DIR }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(KEY_SORT)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return fallback
    const rec = parsed as Record<string, unknown>
    return { sortKey: normalizeSortKey(rec.sortKey), sortDir: normalizeSortDir(rec.sortDir) }
  } catch {
    return fallback
  }
}

function writeSort(next: SortState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY_SORT, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

interface EmailFilterStore extends FilterAxes, SortState {
  view: EmailView
  /** 多文件夹同步 (P3) — 当前激活的自定义文件夹 (mailbox = display_name)。非空时
   *  列表只展示该文件夹邮件 (listEnriched WHERE mailbox=display_name); 切到任一
   *  内建 view (inbox/outbox/flagged/all) 时清空。null = 走内建 view 语义。 */
  customMailbox: string | null
  /** 当前自定义文件夹的层级路径 (display_name 段, 末段 = customMailbox)。列表头部
   *  面包屑展示用 (界面④)。空数组 = 无自定义文件夹激活。 */
  customMailboxPath: string[]
  tab: InboxTab
  selectedPriorities: ReadonlySet<AIPriority>
  selectedCategories: ReadonlySet<EmailCategory>
  setView(next: EmailView): void
  /** 切到该 view 且**只**开 unread 轴 —— 侧边栏未读徽标的点击入口。
   *  🔴 必须是独立 action 而非 `setView(v)` + `toggleBool('unread')`：setView 自带
   *  `...NO_FILTER_AXES` 会把刚开的轴清掉（顺序反过来则中间会多一帧全量列表）。 */
  focusUnread(next: EmailView): void
  /** 选中自定义文件夹 (mailbox = display_name)。其余过滤轴归零, view 占位 inbox
   *  (Sidebar 自行据 customMailbox 控制选中态, 内建 view 高亮全部解除)。`path`
   *  是层级 display_name 段 (末段 = mailbox), 列表头部面包屑用。 */
  setCustomMailbox(mailbox: string, path?: string[]): void
  setTab(next: InboxTab): void
  /** 二值轴翻转（unread / toMe / hasAttach / failed）。 */
  toggleBool(key: BoolFilterKey): void
  /** 旗标档位单选：点已选中的那档 = 取消（回 null）。 */
  toggleFlagMark(mark: FlagMark): void
  togglePriority(p: AIPriority): void
  toggleCategory(c: EmailCategory): void
  setPriorities(set: ReadonlySet<AIPriority>): void
  setCategories(set: ReadonlySet<EmailCategory>): void
  setSort(key: EmailSortKey): void
  setSortDir(dir: EmailSortDir): void
  allPrioritiesSelected(): boolean
  allCategoriesSelected(): boolean
  /** 任一筛选轴收窄了视图 —— 驱动过滤按钮的激活点 + 「清除筛选」行的显隐。
   *  🔴 排序不算「筛选」：换个排序没有隐藏任何邮件，把它算进去会让激活点常亮。 */
  hasActiveFilter(): boolean
  /** Reset every filter axis back to "show everything"（不动排序，见上）。 */
  resetAll(): void
}

/** 只读快照 —— 传给纯函数 applyAxisFilters 用（避免它 import zustand）。 */
export function axesOf(s: FilterAxes): FilterAxes {
  return {
    unread: s.unread,
    flagMark: s.flagMark,
    toMe: s.toMe,
    hasAttach: s.hasAttach,
    failed: s.failed
  }
}

export const useEmailFilter = create<EmailFilterStore>((set, get) => ({
  ...NO_FILTER_AXES,
  ...readSort(),
  view: 'inbox',
  customMailbox: null,
  customMailboxPath: [],
  tab: readTab(),
  selectedPriorities: readSet<AIPriority>(KEY_PRI, ALL_PRIORITIES),
  selectedCategories: readSet<EmailCategory>(KEY_CAT, ALL_CATEGORIES),

  setView(next) {
    // 切内建 view 必清掉自定义文件夹选中态 (互斥) + 二值筛选轴 (沿用老 chip 的
    // 「切视图即归零」语义: 带着「同步失败」切进发件箱只会看到空列表)。
    set({ ...NO_FILTER_AXES, view: next, customMailbox: null, customMailboxPath: [] })
  },
  focusUnread(next) {
    set({ ...NO_FILTER_AXES, unread: true, view: next, customMailbox: null, customMailboxPath: [] })
  },
  setCustomMailbox(mailbox, path) {
    set({ ...NO_FILTER_AXES, customMailbox: mailbox, customMailboxPath: path ?? [mailbox] })
  },
  setTab(next) {
    writeTab(next)
    set({ tab: next })
  },
  toggleBool(key) {
    set({ [key]: !get()[key] } as Pick<EmailFilterStore, BoolFilterKey>)
  },
  toggleFlagMark(mark) {
    set({ flagMark: get().flagMark === mark ? null : mark })
  },
  togglePriority(p) {
    const cur = new Set(get().selectedPriorities)
    if (cur.has(p)) cur.delete(p)
    else cur.add(p)
    writeSet(KEY_PRI, cur)
    set({ selectedPriorities: cur })
  },
  toggleCategory(c) {
    const cur = new Set(get().selectedCategories)
    if (cur.has(c)) cur.delete(c)
    else cur.add(c)
    writeSet(KEY_CAT, cur)
    set({ selectedCategories: cur })
  },
  setPriorities(next) {
    writeSet(KEY_PRI, next)
    set({ selectedPriorities: new Set(next) })
  },
  setCategories(next) {
    writeSet(KEY_CAT, next)
    set({ selectedCategories: new Set(next) })
  },
  setSort(key) {
    const next = { sortKey: key, sortDir: get().sortDir }
    writeSort(next)
    set(next)
  },
  setSortDir(dir) {
    const next = { sortKey: get().sortKey, sortDir: dir }
    writeSort(next)
    set(next)
  },
  allPrioritiesSelected() {
    const sel = get().selectedPriorities
    return ALL_PRIORITIES.every((p) => sel.has(p))
  },
  allCategoriesSelected() {
    const sel = get().selectedCategories
    return ALL_CATEGORIES.every((c) => sel.has(c))
  },
  hasActiveFilter() {
    const s = get()
    return (
      s.unread ||
      s.flagMark !== null ||
      s.toMe ||
      s.hasAttach ||
      s.failed ||
      !s.allPrioritiesSelected() ||
      !s.allCategoriesSelected()
    )
  },
  resetAll() {
    writeSet(KEY_PRI, new Set(ALL_PRIORITIES))
    writeSet(KEY_CAT, new Set(ALL_CATEGORIES))
    set({
      ...NO_FILTER_AXES,
      selectedPriorities: new Set(ALL_PRIORITIES),
      selectedCategories: new Set(ALL_CATEGORIES)
    })
  }
}))

// Cross-window sync for the persisted slices.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY_TAB) {
      useEmailFilter.setState({ tab: e.newValue === 'other' ? 'other' : 'focused' })
    } else if (e.key === KEY_PRI) {
      useEmailFilter.setState({
        selectedPriorities: readSet<AIPriority>(KEY_PRI, ALL_PRIORITIES)
      })
    } else if (e.key === KEY_CAT) {
      useEmailFilter.setState({
        selectedCategories: readSet<EmailCategory>(KEY_CAT, ALL_CATEGORIES)
      })
    } else if (e.key === KEY_SORT) {
      useEmailFilter.setState(readSort())
    }
  })
}
