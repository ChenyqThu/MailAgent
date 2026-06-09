// Sprint 10 user-acceptance follow-up — shared filter state for the
// EmailList. Sprint 12 extends with multi-select (priority + category) +
// Focused/Other tab, both persisted to localStorage so the user's view
// preferences survive reloads.
//
// Composition rule used by EmailList:
//   final = view × tab(focused|other) × singleChip(filter) ×
//           prioritySet × categorySet

import { create } from 'zustand'

import type { AIPriority } from '@shared/api/types'

const KEY_TAB = 'mailagent.emailList.tab'
const KEY_PRI = 'mailagent.emailList.priorities'
// v2: Sprint 12.6 — switched EmailCategory from the synthetic 5-bucket
// (alert/project/...) to the LLM's real 7-element CATEGORY_ENUM. Bumping
// the key avoids resurrecting stale 5-bucket selections (which would
// silently produce an empty filter set and hide all emails).
const KEY_CAT = 'mailagent.emailList.categories.v2'

export type EmailFilter = 'all' | 'unread' | 'flagged' | 'failed'
export type EmailView = 'inbox' | 'outbox' | 'flagged' | 'all'
export type InboxTab = 'focused' | 'other'

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

interface EmailFilterStore {
  filter: EmailFilter
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
  setFilter(next: EmailFilter): void
  setView(next: EmailView): void
  /** 选中自定义文件夹 (mailbox = display_name)。其余过滤轴归零, view 占位 inbox
   *  (Sidebar 自行据 customMailbox 控制选中态, 内建 view 高亮全部解除)。`path`
   *  是层级 display_name 段 (末段 = mailbox), 列表头部面包屑用。 */
  setCustomMailbox(mailbox: string, path?: string[]): void
  setTab(next: InboxTab): void
  togglePriority(p: AIPriority): void
  toggleCategory(c: EmailCategory): void
  setPriorities(set: ReadonlySet<AIPriority>): void
  setCategories(set: ReadonlySet<EmailCategory>): void
  allPrioritiesSelected(): boolean
  allCategoriesSelected(): boolean
  /** Reset every filter axis back to "show everything". */
  resetAll(): void
  /** Single-chip toggle helper (Sidebar virtual entries). */
  toggle(next: EmailFilter): void
}

export const useEmailFilter = create<EmailFilterStore>((set, get) => ({
  filter: 'all',
  view: 'inbox',
  customMailbox: null,
  customMailboxPath: [],
  tab: readTab(),
  selectedPriorities: readSet<AIPriority>(KEY_PRI, ALL_PRIORITIES),
  selectedCategories: readSet<EmailCategory>(KEY_CAT, ALL_CATEGORIES),

  setFilter(next) {
    set({ filter: next })
  },
  setView(next) {
    // 切内建 view 必清掉自定义文件夹选中态 (互斥)。
    set({ view: next, filter: 'all', customMailbox: null, customMailboxPath: [] })
  },
  setCustomMailbox(mailbox, path) {
    set({ customMailbox: mailbox, customMailboxPath: path ?? [mailbox], filter: 'all' })
  },
  setTab(next) {
    writeTab(next)
    set({ tab: next })
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
  allPrioritiesSelected() {
    const sel = get().selectedPriorities
    return ALL_PRIORITIES.every((p) => sel.has(p))
  },
  allCategoriesSelected() {
    const sel = get().selectedCategories
    return ALL_CATEGORIES.every((c) => sel.has(c))
  },
  resetAll() {
    writeSet(KEY_PRI, new Set(ALL_PRIORITIES))
    writeSet(KEY_CAT, new Set(ALL_CATEGORIES))
    set({
      filter: 'all',
      selectedPriorities: new Set(ALL_PRIORITIES),
      selectedCategories: new Set(ALL_CATEGORIES)
    })
  },
  toggle(next) {
    set({ filter: get().filter === next ? 'all' : next })
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
    }
  })
}
